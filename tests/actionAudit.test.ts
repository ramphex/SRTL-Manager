import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, type AppContext } from "../src/server/app";
import { actionAuditLimit, boundedTargets, listActionAudit, type ActionAuditEntry } from "../src/server/lib/actionAudit";
import { NowPlayingHub } from "../src/server/lib/nowPlaying/hub";
import { markOnboardingCompleteForExistingInstall } from "../src/server/lib/onboarding";
import { createTestDatabase, type TestDatabaseHandle } from "./testDb";

// Copy, purge and discard-partial-copy are checked beside their own flows in app.test.ts and orphanPurge.test.ts.
describe("action audit trail", () => {
  let root = "";
  let database: TestDatabaseHandle;
  let app: AppContext;
  let cookie = "";

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "srtl-audit-"));
    for (const folder of ["links", "local", "remote"]) await fs.mkdir(path.join(root, folder), { recursive: true });
    database = await createTestDatabase();
    app = await createApp({ rootDir: root, databaseUrl: database.databaseUrl, autoMigrate: true, anonymousRequestsPerMinute: 100_000, paths: { symlinkDir: path.join(root, "links"), localDir: path.join(root, "local"), remoteDir: path.join(root, "remote") } });
    app.app.log.level = "silent";
    await markOnboardingCompleteForExistingInstall(app.database.db);
    const setup = await app.app.inject({ method: "POST", url: "/api/auth/setup", payload: { username: "fixture", password: "fixture-password-123", confirmPassword: "fixture-password-123" } });
    cookie = String(setup.headers["set-cookie"]).split(";")[0]!;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.app.close();
    await database.cleanup();
    await fs.rm(root, { recursive: true, force: true });
  });

  const call = (method: "GET" | "POST" | "DELETE", url: string, payload?: Record<string, unknown>) => app.app.inject({ method, url, headers: { cookie }, payload });
  const trail = async () => (await call("GET", "/api/system/action-audit")).json<ActionAuditEntry[]>();

  it("is only readable by a signed-in admin", async () => {
    expect((await app.app.inject({ method: "GET", url: "/api/system/action-audit" })).statusCode).toBe(401);
    expect(await trail()).toEqual([]);
  });

  it("records a media server removal with who, when and the server", async () => {
    const created = await call("POST", "/api/media-servers", { kind: "jellyfin", name: "Living room", url: "http://192.168.1.20:8096", token: "testJellyfinKey", prefixMappings: [] });
    expect(created.statusCode).toBe(200);
    const serverId = created.json<{ servers: Array<{ id: string }> }>().servers[0]!.id;
    expect(await trail()).toEqual([]);

    const removed = await call("DELETE", `/api/media-servers/${serverId}`);
    expect(removed.statusCode).toBe(200);
    expect(await trail()).toEqual([
      {
        id: expect.any(String),
        at: expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
        action: "media_server.remove",
        summary: 'Removed media server "Living room"',
        actor: { userId: expect.any(Number), username: "fixture" },
        ip: expect.any(String),
        requestId: removed.headers["x-request-id"],
        targets: { serverId, name: "Living room", kind: "jellyfin" }
      }
    ]);
    // A removal that fails records nothing.
    expect((await call("DELETE", `/api/media-servers/${serverId}`)).statusCode).toBe(404);
    expect(await trail()).toHaveLength(1);
  });

  it("records Radarr and Sonarr instance removals", async () => {
    for (const service of ["radarr", "sonarr"] as const) {
      const created = await call("POST", `/api/settings/${service}/instances`, { name: `Main ${service}` });
      expect(created.statusCode).toBe(200);
      const instanceId = created.json<{ settings: { id: string } }>().settings.id;
      const removed = await call("DELETE", `/api/settings/${service}/instances/${instanceId}`);
      expect(removed.statusCode).toBe(200);
      expect((await trail())[0]).toMatchObject({
        action: `${service}_instance.remove`,
        actor: { username: "fixture" },
        requestId: removed.headers["x-request-id"],
        targets: { instanceId, name: `Main ${service}` }
      });
    }
    expect(await trail()).toHaveLength(2);
  });

  it("records a Now Playing stop with the server and session but not the viewer or the message", async () => {
    const stop = vi.spyOn(NowPlayingHub.prototype, "stopStream").mockResolvedValue({ result: "stopped", message: "The stream has stopped." });
    const response = await call("POST", "/api/now-playing/stop", { serverId: "abc123", sessionKey: "session-7", message: "Please pause for a moment." });
    expect(response.statusCode).toBe(200);
    expect(stop).toHaveBeenCalledOnce();
    const [entry] = await trail();
    expect(entry).toMatchObject({
      action: "now_playing.stop_stream",
      actor: { userId: expect.any(Number), username: "fixture" },
      requestId: response.headers["x-request-id"],
      targets: { serverId: "abc123", sessionKey: "session-7", result: "stopped" }
    });
    expect(JSON.stringify(entry)).not.toContain("Please pause");
  });

  it("does not record a stop that was rejected", async () => {
    expect((await call("POST", "/api/now-playing/stop", { serverId: "abc123", sessionKey: "1", message: "x" })).statusCode).toBe(404);
    expect(await trail()).toEqual([]);
  });

  it("keeps long ID lists short and the trail bounded, newest first", async () => {
    const targets = boundedTargets({ storageFileIds: Array.from({ length: 5000 }, (_, index) => index + 1), note: "x".repeat(1000), mode: "hold" });
    expect(targets.storageFileIds).toHaveLength(100);
    expect(targets.storageFileIdsTotal).toBe(5000);
    expect(String(targets.note).length).toBeLessThan(400);
    expect(targets.mode).toBe("hold");

    const created = await call("POST", "/api/media-servers", { kind: "jellyfin", name: "Spare", url: "http://192.168.1.21:8096", token: "testJellyfinKey", prefixMappings: [] });
    const serverId = created.json<{ servers: Array<{ id: string }> }>().servers[0]!.id;
    await call("DELETE", `/api/media-servers/${serverId}`);
    const radarr = await call("POST", "/api/settings/radarr/instances", { name: "Later" });
    await call("DELETE", `/api/settings/radarr/instances/${radarr.json<{ settings: { id: string } }>().settings.id}`);
    expect((await trail()).map((entry) => entry.action)).toEqual(["radarr_instance.remove", "media_server.remove"]);
    expect(await listActionAudit(app.database.db, 1)).toHaveLength(1);
    expect(actionAuditLimit).toBeGreaterThanOrEqual(100);
  });
});
