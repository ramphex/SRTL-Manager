import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp, type AppContext } from "../src/server/app";
import { nowIso } from "../src/server/db/database";
import * as schema from "../src/server/db/schema";
import { SourceResolver } from "../src/server/lib/nowPlaying/sourceResolver";
import { markOnboardingCompleteForExistingInstall } from "../src/server/lib/onboarding";
import type { NowPlayingSnapshot } from "../src/shared/nowPlaying";
import { defaultNowPlayingStreamLimits, type NowPlayingStreamLimits } from "../src/server/config";
import { createTestDatabase, type TestDatabaseHandle } from "./testDb";
import { readSetupToken } from "./authHelpers";

describe("Now Playing routes", () => {
  let root = "";
  let database: TestDatabaseHandle;
  let app: AppContext;
  let cookie = "";

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "srtl-now-playing-"));
    for (const folder of ["links", "local", "remote"]) await fs.mkdir(path.join(root, folder), { recursive: true });
    database = await createTestDatabase();
    app = await createApp({ rootDir: root, databaseUrl: database.databaseUrl, autoMigrate: true, paths: { symlinkDir: path.join(root, "links"), localDir: path.join(root, "local"), remoteDir: path.join(root, "remote") } });
    app.app.log.level = "silent";
    await markOnboardingCompleteForExistingInstall(app.database.db);
    const setup = await app.app.inject({ method: "POST", url: "/api/auth/setup", payload: { setupToken: readSetupToken(app), username: "fixture", password: "fixture-password-123", confirmPassword: "fixture-password-123" } });
    cookie = String(setup.headers["set-cookie"]).split(";")[0]!;
  });

  afterEach(async () => {
    await app.app.close();
    await database.cleanup();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("requires a signed-in admin for every route", async () => {
    for (const [method, url] of [["GET", "/api/now-playing/events"], ["GET", "/api/now-playing/settings"], ["PUT", "/api/now-playing/settings"], ["POST", "/api/now-playing/stop"], ["GET", `/api/now-playing/poster/${"a".repeat(32)}`]] as const) {
      expect((await app.app.inject({ method, url, payload: method === "GET" ? undefined : {} })).statusCode, `${method} ${url}`).toBe(401);
    }
  });

  it("keeps the geo lookup toggle in app settings", async () => {
    const call = (method: "GET" | "PUT", payload?: Record<string, unknown>) => app.app.inject({ method, url: "/api/now-playing/settings", headers: { cookie }, ...(payload ? { payload } : {}) });
    expect((await call("GET")).json()).toEqual({ geoLookup: true });
    expect((await call("PUT", { geoLookup: false })).json()).toEqual({ geoLookup: false });
    expect((await call("GET")).json()).toEqual({ geoLookup: false });
    expect((await call("PUT", { geoLookup: "no" })).statusCode).toBe(400);
  });

  it("streams the current state over server-sent events and rejects unknown stops and artwork", async () => {
    await app.app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.app.server.address();
    if (!address || typeof address === "string") throw new Error("app did not bind");
    const controller = new AbortController();
    const response = await fetch(`http://127.0.0.1:${address.port}/api/now-playing/events`, { headers: { cookie }, signal: controller.signal });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const reader = response.body!.getReader();
    let text = "";
    while (!(text.includes("event: host") && text.includes("event: sessions"))) {
      const { value, done } = await reader.read();
      if (done) break;
      text += new TextDecoder().decode(value);
    }
    controller.abort();
    expect(text).toContain("retry: 5000");
    const sessions = /event: sessions\ndata: (.*)\n/.exec(text);
    const snapshot = JSON.parse(sessions![1]!) as NowPlayingSnapshot;
    expect(snapshot).toMatchObject({ servers: [], streams: [], summary: { totalKbps: 0 } });

    const stop = await app.app.inject({ method: "POST", url: "/api/now-playing/stop", headers: { cookie }, payload: { serverId: "abc123", sessionKey: "1", message: "x" } });
    expect(stop.statusCode).toBe(404);
    expect((await app.app.inject({ method: "GET", url: `/api/now-playing/poster/${"a".repeat(32)}`, headers: { cookie } })).statusCode).toBe(404);
  });

  describe("stream sessions", () => {
    const controllers: AbortController[] = [];
    let base = "";

    async function restart(limits: Partial<NowPlayingStreamLimits>) {
      await app.app.close();
      app = await createApp({ rootDir: root, databaseUrl: database.databaseUrl, autoMigrate: true, nowPlayingStreams: { ...defaultNowPlayingStreamLimits, ...limits }, paths: { symlinkDir: path.join(root, "links"), localDir: path.join(root, "local"), remoteDir: path.join(root, "remote") } });
      app.app.log.level = "silent";
      await app.app.listen({ host: "127.0.0.1", port: 0 });
      const address = app.app.server.address();
      if (!address || typeof address === "string") throw new Error("app did not bind");
      base = `http://127.0.0.1:${address.port}`;
    }

    async function open(sessionCookie: string) {
      const controller = new AbortController();
      controllers.push(controller);
      const response = await fetch(`${base}/api/now-playing/events`, { headers: { cookie: sessionCookie }, signal: controller.signal });
      if (response.status !== 200) {
        await response.body?.cancel();
        return { status: response.status, controller, reader: null };
      }
      const reader = response.body!.getReader();
      let text = "";
      while (!text.includes("event: sessions")) {
        const { value, done } = await reader.read();
        if (done) break;
        text += new TextDecoder().decode(value);
      }
      return { status: response.status, controller, reader };
    }

    async function endsWithin(reader: ReadableStreamDefaultReader<Uint8Array>, ms: number): Promise<boolean> {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) {
        const result = await Promise.race([reader.read(), new Promise<null>((resolve) => setTimeout(() => resolve(null), deadline - Date.now()))]);
        if (result === null) return false;
        if (result.done) return true;
      }
      return false;
    }

    async function signIn(): Promise<string> {
      const response = await app.app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "fixture", password: "fixture-password-123" } });
      expect(response.statusCode).toBe(200);
      return String(response.headers["set-cookie"]).split(";")[0]!;
    }

    afterEach(() => {
      for (const controller of controllers.splice(0)) controller.abort();
    });

    it("closes an open stream once its session signs out", async () => {
      await restart({ revalidateMs: 100 });
      const other = await signIn();
      const signedOut = await open(cookie);
      const stillSignedIn = await open(other);
      expect(signedOut.status).toBe(200);
      expect((await app.app.inject({ method: "POST", url: "/api/auth/logout", headers: { cookie } })).statusCode).toBeLessThan(300);
      expect(await endsWithin(signedOut.reader!, 3000)).toBe(true);
      // Other sessions keep their streams, and the signed-out browser cannot reconnect.
      expect(await endsWithin(stillSignedIn.reader!, 400)).toBe(false);
      expect((await open(cookie)).status).toBe(401);
    });

    it("closes an open stream once its session expires", async () => {
      await restart({ revalidateMs: 100 });
      const stream = await open(cookie);
      await app.database.db.update(schema.sessions).set({ expiresAt: "2000-01-01T00:00:00.000Z" });
      expect(await endsWithin(stream.reader!, 3000)).toBe(true);
    });

    it("caps open streams per session and overall", async () => {
      await restart({ perSession: 2, total: 3, revalidateMs: 60_000 });
      const first = await open(cookie);
      expect(first.status).toBe(200);
      expect((await open(cookie)).status).toBe(200);
      expect((await open(cookie)).status).toBe(429);
      const other = await signIn();
      expect((await open(other)).status).toBe(200);
      expect((await open(other)).status).toBe(429);
      // Closing a stream frees its place.
      first.controller.abort();
      let reopened = 0;
      for (let attempt = 0; attempt < 50 && reopened !== 200; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        reopened = (await open(other)).status;
      }
      expect(reopened).toBe(200);
    });
  });

  it("resolves a played file to SRTL's local or remote storage through the server's path mappings", async () => {
    const db = app.database.db;
    const timestamp = nowIso();
    const [localFile] = await db.insert(schema.storageFiles).values({
      rootType: "local", rootPath: "/srv/local", section: "movies", itemName: "Example Movie (2021)", relativePath: "movies/Example Movie (2021)/Example Movie (2021).mkv",
      filePath: "/srv/local/movies/Example Movie (2021)/Example Movie (2021).mkv", sizeBytes: 1, mtimeMs: 1, firstSeenAt: timestamp, lastSeenAt: timestamp, lastChangedAt: timestamp, lastSeenJobId: 1, updatedAt: timestamp
    }).returning();
    const link = (name: string, kind: string, policy = "unassigned", resolved: number | null = null) => ({
      section: "movies", itemName: name, relativePath: `movies/${name}/${name}.mkv`, linkPath: `/mnt/links/movies/${name}/${name}.mkv`, targetPath: `/somewhere/${name}.mkv`,
      kind, targetExists: kind !== "broken", isMedia: true, storagePolicy: policy, resolvedStorageFileId: resolved, updatedAt: timestamp
    });
    await db.insert(schema.mediaLinks).values([link("Example Movie (2021)", "local", "location_1", localFile!.id), link("Streamed Film (2020)", "remote", "location_2"), link("Gone Film (2001)", "broken")]);
    await db.insert(schema.storageFiles).values({
      rootType: "remote", rootPath: "/srv/remote", relativePath: "x/direct.mkv", filePath: "/srv/remote/x/direct.mkv", sizeBytes: 1, mtimeMs: 1, firstSeenAt: timestamp, lastSeenAt: timestamp, lastChangedAt: timestamp, lastSeenJobId: 1, updatedAt: timestamp
    });
    const resolver = new SourceResolver(db);
    const mappings = [{ serverPrefix: "/data/media", srtlPrefix: "/mnt/links" }];
    expect(await resolver.resolve("plex1", mappings, "/data/media/movies/Example Movie (2021)/Example Movie (2021).mkv")).toEqual({ status: "local", locationName: "Local", policy: "location_1" });
    expect(await resolver.resolve("plex1", mappings, "/data/media/movies/Streamed Film (2020)/Streamed Film (2020).mkv")).toEqual({ status: "remote", locationName: "Remote", policy: "location_2" });
    expect(await resolver.resolve("plex1", mappings, "/data/media/movies/Gone Film (2001)/Gone Film (2001).mkv")).toMatchObject({ status: "broken" });
    expect(await resolver.resolve("plex1", [], "/srv/remote/x/direct.mkv")).toMatchObject({ status: "remote" });
    expect(await resolver.resolve("plex1", mappings, "/data/media/movies/Unknown/Unknown.mkv")).toEqual({ status: "unlinked", locationName: null, policy: null });
    expect(await resolver.resolve("plex1", mappings, null)).toMatchObject({ status: "unknown" });
    // Answers are cached per file: a changed row is not read again on the next update.
    await db.delete(schema.mediaLinks);
    expect(await resolver.resolve("plex1", mappings, "/data/media/movies/Example Movie (2021)/Example Movie (2021).mkv")).toMatchObject({ status: "local" });
  });
});
