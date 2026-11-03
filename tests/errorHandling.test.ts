import fs from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp, type AppContext } from "../src/server/app";
import { AdmissionError, AppError, ConflictError, genericServerMessage, publicErrorMessage, toClientError } from "../src/server/errors";
import { markOnboardingCompleteForExistingInstall } from "../src/server/lib/onboarding";
import { readSetupToken } from "./authHelpers";
import { createTestDatabase, type TestDatabaseHandle } from "./testDb";

// Text that must never reach a browser: stack frames, SQL, host paths, and upstream response bodies.
const upstreamSecret = "UPSTREAM_BODY_MARKER";
const forbidden = [/\bat\s+\S+\s+\(/, /node_modules/, /\.ts:\d+/, /\.js:\d+/, /\/srv\//, /\/Users\//, /relation ".*" does not exist/i, /\bselect\b.*\bfrom\b/i, /\bSQLSTATE\b/i, new RegExp(upstreamSecret)];

function expectNoLeak(text: string): void {
  for (const pattern of forbidden) expect(text, `response must not match ${pattern}`).not.toMatch(pattern);
}

describe("error responses", () => {
  let root = "";
  let database: TestDatabaseHandle;
  let app: AppContext;
  let cookie = "";
  let logs = "";
  let upstream: http.Server;
  let upstreamBase = "";

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "srtl-errors-"));
    for (const folder of ["links", "local", "remote"]) await fs.mkdir(path.join(root, folder), { recursive: true });
    logs = "";
    const logStream = new Writable({
      write(chunk, _encoding, callback) {
        logs += String(chunk);
        callback();
      }
    });
    database = await createTestDatabase();
    app = await createApp(
      { rootDir: root, databaseUrl: database.databaseUrl, autoMigrate: true, anonymousRequestsPerMinute: 100_000, paths: { symlinkDir: path.join(root, "links"), localDir: path.join(root, "local"), remoteDir: path.join(root, "remote") } },
      { logStream }
    );
    // Routes that fail in the ways real ones can. They go through the same access guard and error handler.
    app.app.get("/api/test/database-error", async () => {
      await app.database.pool.query("select * from table_that_does_not_exist");
      return {};
    });
    app.app.get("/api/test/plain-error", async () => {
      throw new Error("ENOENT: no such file or directory, open '/srv/media/secret.db'");
    });
    app.app.get("/api/test/foreign-status-error", async () => {
      throw Object.assign(new Error("Leaked: /srv/media/secret.db"), { statusCode: 409 });
    });
    app.app.get("/api/test/typed-error", async () => {
      throw new AdmissionError("Pick at least one title.", { detail: "internal detail at /srv/media/library" });
    });
    // A media server that answers every request with a failure and a body full of internals.
    upstream = http.createServer((_request, response) => {
      response.writeHead(500, { "Content-Type": "text/plain" });
      response.end(`${upstreamSecret} SQLITE_ERROR at /srv/radarr/radarr.db:12 select * from Movies`);
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    upstreamBase = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;

    await markOnboardingCompleteForExistingInstall(app.database.db);
    const setup = await app.app.inject({ method: "POST", url: "/api/auth/setup", payload: { setupToken: readSetupToken(app), username: "fixture", password: "fixture-password-123", confirmPassword: "fixture-password-123" } });
    cookie = String(setup.headers["set-cookie"]).split(";")[0]!;
  });

  afterEach(async () => {
    await app.app.close();
    await new Promise((resolve) => upstream.close(resolve));
    await database.cleanup();
    await fs.rm(root, { recursive: true, force: true });
  });

  const get = (url: string) => app.app.inject({ method: "GET", url, headers: { cookie } });

  it("maps thrown values to a safe message, a code and a status", () => {
    expect(toClientError(new ConflictError("Wait for the job."))).toMatchObject({ statusCode: 409, message: "Wait for the job.", code: "conflict", expected: true });
    expect(toClientError(new AppError("Gone.", 404))).toMatchObject({ statusCode: 404, code: "not_found" });
    expect(toClientError(new Error("select * from secrets"))).toEqual({ statusCode: 500, message: genericServerMessage, code: "internal_error", expected: false });
    expect(toClientError(Object.assign(new Error("Leaked /srv/x"), { statusCode: 409 }))).toMatchObject({ statusCode: 409, message: "Conflict" });
    expect(toClientError(Object.assign(new Error("Body is not valid JSON"), { statusCode: 400, code: "FST_ERR_CTP_INVALID_JSON_BODY" }))).toMatchObject({ statusCode: 400, message: "Body is not valid JSON" });
    expect(toClientError("a string")).toMatchObject({ statusCode: 500, message: genericServerMessage });
    expect(publicErrorMessage(new AdmissionError("Fix the address."), "Failed.")).toBe("Fix the address.");
    expect(publicErrorMessage(new Error("password authentication failed for user srtl"), "Connection failed.")).toBe("Connection failed.");
  });

  it("answers a database error with a generic message and a request ID, and logs the detail", async () => {
    const response = await get("/api/test/database-error");
    expect(response.statusCode).toBe(500);
    const body = response.json<Record<string, unknown>>();
    expect(Object.keys(body).sort()).toEqual(["code", "error", "requestId"]);
    expect(body).toMatchObject({ error: genericServerMessage, code: "internal_error" });
    expect(String(body.requestId)).toMatch(/^[0-9a-f]{10}$/);
    expect(response.headers["x-request-id"]).toBe(body.requestId);
    expectNoLeak(response.body);
    // The same ID finds the full error in the server log.
    const entry = logs.split("\n").filter(Boolean).map((line) => JSON.parse(line) as { reqId?: string; err?: { message?: string; stack?: string }; msg?: string }).find((line) => line.reqId === body.requestId && line.err);
    expect(entry?.err?.message).toContain("table_that_does_not_exist");
    expect(entry?.err?.stack).toContain("error");
  });

  it("does not echo the message of an unexpected error, even one that carries a client status", async () => {
    for (const [url, status, message] of [["/api/test/plain-error", 500, genericServerMessage], ["/api/test/foreign-status-error", 409, "Conflict"]] as const) {
      const response = await get(url);
      expect(response.statusCode, url).toBe(status);
      expect(response.json()).toMatchObject({ error: message, requestId: expect.any(String) });
      expectNoLeak(response.body);
    }
  });

  it("keeps the message of a typed error and logs its extra detail only on the server", async () => {
    const response = await get("/api/test/typed-error");
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: "Pick at least one title.", code: "bad_request", requestId: response.headers["x-request-id"] });
    expectNoLeak(response.body);
    expect(logs).toContain("internal detail at /srv/media/library");
  });

  it("no longer turns database failures in start routes into 400s with the raw message", async () => {
    await app.database.pool.query("drop table jobs cascade");
    const requests = [
      { url: "/api/scans", payload: { scanSymlinks: true } },
      { url: "/api/audits", payload: { mode: "fast", targets: ["remote"] } },
      { url: "/api/orphans/purge", payload: { rootType: "remote", storageFileIds: [1], mode: "hold" } }
    ];
    for (const request of requests) {
      const response = await app.app.inject({ method: "POST", url: request.url, headers: { cookie }, payload: request.payload });
      expect(response.statusCode, request.url).toBeGreaterThanOrEqual(400);
      expectNoLeak(response.body);
      if (response.statusCode >= 500) expect(response.json()).toMatchObject({ error: genericServerMessage });
    }
    const scan = await app.app.inject({ method: "POST", url: "/api/scans", headers: { cookie }, payload: { scanSymlinks: true } });
    expect(scan.statusCode).toBe(500);
    expect(scan.json()).toMatchObject({ error: genericServerMessage });
    expect(logs).toMatch(/relation \\?"jobs\\?" does not exist/);
  });

  it("keeps the connection hints for a failing Radarr and media server without their response bodies", async () => {
    const created = await app.app.inject({ method: "POST", url: "/api/settings/radarr/instances", headers: { cookie }, payload: { name: "Radarr" } });
    expect(created.statusCode).toBe(200);
    const radarrId = created.json<{ settings: { id: string } }>().settings.id;
    const radarr = await app.app.inject({
      method: "POST",
      url: `/api/settings/radarr/instances/${radarrId}/test`,
      headers: { cookie },
      payload: { revision: 0, baseUrl: upstreamBase, apiKey: "testRadarrApiKeyOnly", webhookSecret: "test_webhook_secret_for_disposable_fixture", enabled: true, localTag: "local", remoteTag: "ignored", monitorOnCopy: false, mappingMode: "auto", mappings: [] }
    });
    expect(radarr.statusCode).toBe(400);
    expect(radarr.json()).toMatchObject({ error: "Radarr returned HTTP 500.", requestId: expect.any(String) });
    expectNoLeak(radarr.body);

    const server = await app.app.inject({ method: "POST", url: "/api/media-servers", headers: { cookie }, payload: { kind: "jellyfin", name: "Jellyfin", url: upstreamBase, token: "testJellyfinKey", prefixMappings: [] } });
    expect(server.statusCode).toBe(200);
    const serverId = server.json<{ servers: Array<{ id: string }> }>().servers[0]!.id;
    const tested = await app.app.inject({ method: "POST", url: `/api/media-servers/${serverId}/test`, headers: { cookie } });
    expect(tested.statusCode).toBe(400);
    expect(tested.json()).toMatchObject({ error: "Jellyfin returned HTTP 500." });
    expectNoLeak(tested.body);
    // The status saved on the server record shows the same safe hint.
    const listed = await get("/api/media-servers");
    expect(listed.json<{ servers: Array<{ lastError: string | null }> }>().servers[0]?.lastError).toBe("Jellyfin returned HTTP 500.");
    expectNoLeak(listed.body);
  });

  it("answers invalid JSON, oversize bodies and unknown routes without internals", async () => {
    const invalid = await app.app.inject({ method: "POST", url: "/api/now-playing/settings", headers: { cookie, "content-type": "application/json" }, payload: "{not json" });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({ error: expect.any(String), requestId: expect.any(String) });
    expectNoLeak(invalid.body);

    const large = await app.app.inject({ method: "POST", url: "/api/now-playing/settings", headers: { cookie, "content-type": "application/json" }, payload: JSON.stringify({ pad: "x".repeat(300 * 1024) }) });
    expect(large.statusCode).toBe(413);
    expectNoLeak(large.body);

    const missing = await get("/api/no-such-route");
    expect(missing.statusCode).toBe(404);
    expectNoLeak(missing.body);
  });
});
