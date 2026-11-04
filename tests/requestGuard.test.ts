import fs from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp, type AppContext } from "../src/server/app";
import type { AppConfig } from "../src/server/config";
import { markOnboardingCompleteForExistingInstall } from "../src/server/lib/onboarding";
import { reconcileEnvironmentPaths } from "../src/server/lib/pathConfiguration";
import { isReservedPath, normalizedRequestPath } from "../src/server/routeAccess";
import { createTestDatabase, type TestDatabaseHandle } from "./testDb";
import { readSetupToken } from "./authHelpers";

const shellMarker = '<div id="root"></div>';
const remoteClient = "203.0.113.10";

// The complete set of routes that answer without an admin session. Anything
// added here must be deliberate.
const expectedPublicRoutes = [
  "GET /*",
  "HEAD /*",
  "GET /api/health/live",
  "HEAD /api/health/live",
  "GET /api/auth/me",
  "HEAD /api/auth/me",
  "POST /api/auth/setup",
  "POST /api/auth/login",
  "POST /api/auth/logout"
].sort();

const expectedInternalRoutes = ["GET /api/health", "HEAD /api/health", "GET /api/health/ready", "HEAD /api/health/ready"].sort();

const expectedWebhookRoutes = [
  "POST /api/integrations/radarr/webhook",
  "POST /api/integrations/radarr/:instanceId/webhook",
  "POST /api/integrations/sonarr/:instanceId/webhook"
].sort();

let tmpDir: string;
let webRoot: string;
let testDatabase: TestDatabaseHandle;
let ctx: AppContext | undefined;

async function startApp(overrides: Partial<AppConfig> = {}): Promise<AppContext> {
  if (ctx) await ctx.app.close();
  ctx = await createApp({
    rootDir: tmpDir,
    dataDir: path.join(tmpDir, "data"),
    databaseUrl: testDatabase.databaseUrl,
    webRoot,
    anonymousRequestsPerMinute: 100_000,
    ...overrides
  });
  return ctx;
}

async function createAdminSession(app: AppContext, completeOnboarding = true): Promise<string> {
  const setup = await app.app.inject({
    method: "POST",
    url: "/api/auth/setup",
    payload: { setupToken: readSetupToken(app), username: "admin", password: "password-1234", confirmPassword: "password-1234" }
  });
  expect(setup.statusCode).toBe(200);
  if (completeOnboarding) await markOnboardingCompleteForExistingInstall(app.database.db);
  return String(setup.headers["set-cookie"]).split(";")[0] ?? "";
}

/** A fingerprint of every table, so a sweep can prove it wrote nothing. */
async function databaseFingerprint(app: AppContext): Promise<Record<string, string>> {
  const tables = await app.database.pool.query<{ table_name: string }>(
    "select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' order by table_name"
  );
  const fingerprint: Record<string, string> = {};
  for (const { table_name: table } of tables.rows) {
    const quoted = `"${table.replaceAll('"', '""')}"`;
    const result = await app.database.pool.query<{ digest: string | null }>(`select md5(coalesce(string_agg(t::text, '|' order by t::text), '')) as digest from ${quoted} t`);
    fingerprint[table] = result.rows[0]?.digest ?? "";
  }
  return fingerprint;
}

function concreteUrl(pattern: string): string {
  return pattern.replace(/:[A-Za-z]+/g, "1").replace(/\*$/, "probe");
}

function rawRequest(port: number, method: string, rawPath: string, body?: string): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      { host: "127.0.0.1", port, method, path: rawPath, headers: body === undefined ? {} : { "content-type": "application/json", "content-length": Buffer.byteLength(body) } },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => resolve({ statusCode: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
      }
    );
    request.on("error", reject);
    if (body !== undefined) request.write(body);
    request.end();
  });
}

describe("request guard", () => {
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "srtl-guard-"));
    for (const directory of ["plex", "local", "remote"]) await fs.mkdir(path.join(tmpDir, directory), { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, ".env"),
      [`SYMLINK_DIR="${path.join(tmpDir, "plex")}"`, `SRTL_LOCATION_1_PATH="${path.join(tmpDir, "local")}"`, `SRTL_LOCATION_2_PATH="${path.join(tmpDir, "remote")}"`].join("\n")
    );
    webRoot = path.join(tmpDir, "web");
    await fs.mkdir(path.join(webRoot, "assets"), { recursive: true });
    await fs.writeFile(path.join(webRoot, "index.html"), `<!doctype html><html><body>${shellMarker}</body></html>`);
    await fs.writeFile(path.join(webRoot, "assets", "index-a1b2c3.js"), "console.log('ok');");
    testDatabase = await createTestDatabase();
  });

  afterEach(async () => {
    if (ctx) await ctx.app.close();
    ctx = undefined;
    await testDatabase.cleanup();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("requires an admin session on every registered route unless the access policy marks it public", async () => {
    const app = await startApp({ apiDocsEnabled: true });
    // Record the route each probe matched. onRequest sees it before a static
    // file miss hands the request to the not-found handler; onResponse covers
    // requests the guard has already answered.
    const matched = new Map<string, { route: string | undefined; auth: string | undefined }>();
    const record = async (request: { method: string; url: string; routeOptions: { url?: string; config?: { auth?: string } } }) => {
      const key = `${request.method} ${request.url}`;
      if (!matched.has(key)) matched.set(key, { route: request.routeOptions.url, auth: request.routeOptions.config?.auth });
    };
    app.app.addHook("onRequest", record);
    app.app.addHook("onResponse", record);
    await createAdminSession(app);
    const before = await databaseFingerprint(app);

    const routes = app.routes;
    expect(routes.length).toBeGreaterThan(100);
    const publicRoutes: string[] = [];
    const internalRoutes: string[] = [];
    const webhookRoutes: string[] = [];
    const failures: string[] = [];

    for (const route of routes) {
      if (route.method === "OPTIONS") continue;
      const key = `${route.method} ${route.url}`;
      const url = concreteUrl(route.url);
      const hasBody = route.method === "POST" || route.method === "PUT" || route.method === "PATCH" || route.method === "DELETE";
      const response = await app.app.inject({
        method: route.method as "GET",
        url,
        remoteAddress: remoteClient,
        ...(hasBody ? { payload: {} } : {})
      });
      const seen = matched.get(`${route.method} ${url}`);
      if (seen?.route !== route.url) failures.push(`${key}: probe ${url} matched ${String(seen?.route)}`);
      const auth = seen?.auth;
      if (auth === "public") {
        publicRoutes.push(key);
        continue;
      }
      if (auth === "internal") internalRoutes.push(key);
      else if (auth === "webhook") webhookRoutes.push(key);
      else if (auth !== "session") failures.push(`${key}: unexpected access ${String(auth)}`);
      if (response.statusCode !== 401) failures.push(`${key}: expected 401 without a session, got ${response.statusCode}`);
    }

    expect(failures).toEqual([]);
    expect(publicRoutes.sort()).toEqual(expectedPublicRoutes);
    expect(internalRoutes.sort()).toEqual(expectedInternalRoutes);
    expect(webhookRoutes.sort()).toEqual(expectedWebhookRoutes);
    expect(await databaseFingerprint(app)).toEqual(before);
  });

  it("rejects encoded, case-folded and non-canonical spellings of protected routes", async () => {
    const app = await startApp({ apiDocsEnabled: true });
    await createAdminSession(app);
    const before = await databaseFingerprint(app);

    const protectedRequests: Array<{ method: "GET" | "POST"; path: string; body?: unknown }> = [
      { method: "GET", path: "/api/settings/paths" },
      { method: "GET", path: "/api/media-servers" },
      { method: "POST", path: "/api/media-servers", body: { type: "plex", name: "Example", url: "http://192.168.1.20:32400" } },
      { method: "GET", path: "/api/jobs" },
      { method: "GET", path: "/api/system/version" },
      { method: "POST", path: "/api/scans", body: { scanSymlinks: true } },
      { method: "POST", path: "/api/settings/watch-sync/pairs/1/restore", body: { snapshot: [] } },
      { method: "POST", path: "/api/integrations/radarr/webhook", body: { eventType: "Test" } },
      { method: "GET", path: "/documentation/json" }
    ];
    const variants = (pathname: string): string[] => {
      const rest = pathname.replace(/^\/(api|documentation)/, "");
      const prefix = pathname.startsWith("/api") ? "api" : "documentation";
      const encodedFirst = `%${prefix.charCodeAt(0).toString(16)}${prefix.slice(1)}`;
      const encodedSecond = `${prefix[0]}%${prefix.charCodeAt(1).toString(16)}${prefix.slice(2)}`;
      const encodedAll = [...prefix].map((character) => `%${character.charCodeAt(0).toString(16)}`).join("");
      const lastSlash = rest.lastIndexOf("/");
      return [
        pathname,
        `/${encodedFirst}${rest}`,
        `/${encodedFirst.replace("%", "%25")}${rest}`,
        `/${encodedSecond}${rest}`,
        `/${encodedAll}${rest}`,
        `/${encodedFirst.toUpperCase()}${rest}`,
        `/${prefix.toUpperCase()}${rest}`,
        `/${prefix[0]?.toUpperCase()}${prefix.slice(1)}${rest}`,
        `/${prefix}${rest.toUpperCase()}`,
        `//${prefix}${rest}`,
        `/${prefix}/${rest.replace(/^\//, "/")}`,
        `/x/../${prefix}${rest}`,
        `/${prefix}/./${rest.replace(/^\//, "")}`,
        `/${prefix}/auth/../${rest.replace(/^\//, "")}`,
        `/${prefix}/auth/%2e%2e/${rest.replace(/^\//, "")}`,
        `/${prefix}/health/..%2f${rest.replace(/^\//, "")}`,
        `/${prefix};x=1${rest}`,
        `/${prefix}${rest};x=1`,
        `/${prefix}${rest}/`,
        `/${prefix}${rest}%2f`,
        `/${prefix}${rest}%00`,
        `/${prefix}${rest.slice(0, lastSlash + 1)}%${(rest.charCodeAt(lastSlash + 1) || 0x61).toString(16)}${rest.slice(lastSlash + 2)}`,
        `/${prefix}%2f${rest.replace(/^\//, "")}`,
        `/${prefix}\\${rest.replace(/^\//, "")}`,
        `/${prefix}${rest}?next=/api/auth/login`,
        `/${prefix}${rest}?/../../api/auth/login`,
        `/${prefix}${rest}#/api/auth/login`
      ];
    };

    const failures: string[] = [];
    const check = (label: string, statusCode: number, body: string) => {
      if (statusCode !== 401 && statusCode !== 404) failures.push(`${label}: status ${statusCode}`);
      if (body.includes(shellMarker)) failures.push(`${label}: returned the app shell`);
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        parsed = undefined;
      }
      if (body.length > 0 && (!parsed || typeof parsed !== "object" || Object.keys(parsed).join(",") !== "error")) failures.push(`${label}: unexpected body ${body.slice(0, 80)}`);
    };

    for (const request of protectedRequests) {
      for (const variant of variants(request.path)) {
        const response = await app.app.inject({
          method: request.method,
          url: variant,
          ...(request.body === undefined ? {} : { payload: request.body as object })
        });
        check(`inject ${request.method} ${variant}`, response.statusCode, response.body);
      }
    }

    // Raw HTTP keeps every byte of the request target, with no client-side normalisation.
    await app.app.listen({ host: "127.0.0.1", port: 0 });
    const { port } = app.app.server.address() as AddressInfo;
    for (const request of protectedRequests) {
      for (const variant of variants(request.path)) {
        const rawPath = variant.split("#")[0] ?? variant;
        const response = await rawRequest(port, request.method, rawPath, request.body === undefined ? undefined : JSON.stringify(request.body));
        check(`http ${request.method} ${rawPath}`, response.statusCode, response.body);
      }
    }

    expect(failures).toEqual([]);
    expect(await databaseFingerprint(app)).toEqual(before);
  });

  it("decides authentication before reading the request body", async () => {
    const app = await startApp();
    const invalidJson = await app.app.inject({
      method: "POST",
      url: "/api/settings/watch-sync/pairs/1/restore",
      headers: { "content-type": "application/json" },
      payload: "{not json"
    });
    expect(invalidJson.statusCode).toBe(401);
    expect(invalidJson.json()).toEqual({ error: "Authentication required" });

    const oversized = await app.app.inject({
      method: "POST",
      url: "/api/settings/watch-sync/pairs/1/restore",
      headers: { "content-type": "application/json" },
      payload: `"${"x".repeat(2 * 1024 * 1024)}"`
    });
    expect(oversized.statusCode).toBe(401);

    const webhook = await app.app.inject({
      method: "POST",
      url: "/api/integrations/radarr/webhook",
      headers: { "content-type": "application/json" },
      payload: "{not json"
    });
    expect(webhook.statusCode).toBe(401);

    const cookie = await createAdminSession(app);
    const largeRestore = await app.app.inject({
      method: "POST",
      url: "/api/settings/watch-sync/pairs/1/restore",
      headers: { cookie, "content-type": "application/json" },
      payload: `{"padding":"${"x".repeat(2 * 1024 * 1024)}"`
    });
    expect(largeRestore.statusCode).toBe(400);

    const oversizedSetting = await app.app.inject({
      method: "PUT",
      url: "/api/settings/user-preferences",
      headers: { cookie, "content-type": "application/json" },
      payload: JSON.stringify({ padding: "x".repeat(512 * 1024) })
    });
    expect(oversizedSetting.statusCode).toBe(413);

    const oversizedLogin = await app.app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ username: "admin", password: "x".repeat(32 * 1024) })
    });
    expect(oversizedLogin.statusCode).toBe(413);
  });

  it("keys the library locks off the matched route", async () => {
    const app = await startApp();
    const cookie = await createAdminSession(app, false);
    for (const url of ["/api/scans", "/%61pi/scans"]) {
      const response = await app.app.inject({ method: "POST", url, headers: { cookie }, payload: { scanSymlinks: true, scanLocal: false, scanRemote: false } });
      expect(response.statusCode).toBe(423);
      expect(response.json()).toEqual({ error: "Complete initial setup before modifying the library." });
    }
    const preferences = await app.app.inject({ method: "PUT", url: "/api/auth/user", headers: { cookie }, payload: { username: "admin", currentPassword: "wrong-password" } });
    expect(preferences.statusCode).toBe(401);
    expect(preferences.json()).toEqual({ error: "Current password is incorrect" });
  });

  it("keys the path migration lock off the matched route", async () => {
    const app = await startApp();
    const cookie = await createAdminSession(app);
    const moved = path.join(tmpDir, "plex-moved");
    await fs.mkdir(moved);
    await reconcileEnvironmentPaths(app.database.db, { ...app.config.paths, symlinkDir: moved });
    for (const url of ["/api/scans", "/%61pi/scans", "/%61%70%69/scans", "/ap%69/scans"]) {
      const response = await app.app.inject({ method: "POST", url, headers: { cookie }, payload: { scanSymlinks: true, scanLocal: false, scanRemote: false } });
      expect(response.statusCode, url).toBe(423);
      expect(response.json(), url).toMatchObject({ error: expect.stringContaining("Complete the required path migration") });
    }
    expect(await app.jobs.listJobs()).toHaveLength(0);
  });

  it("answers unknown paths with a plain 404 and serves the app shell only to page loads", async () => {
    const app = await startApp();
    const page = await app.app.inject({ method: "GET", url: "/library" });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain(shellMarker);

    const asset = await app.app.inject({ method: "GET", url: "/assets/index-a1b2c3.js" });
    expect(asset.statusCode).toBe(200);

    for (const [method, url] of [
      ["GET", "/api/does-not-exist"],
      ["GET", "/API/settings/paths"],
      ["GET", "/%2561pi/settings/paths"],
      ["GET", "/documentation"],
      ["GET", "/assets/missing.js"],
      ["POST", "/library"],
      ["DELETE", "/api/does-not-exist"]
    ] as const) {
      const response = await app.app.inject({ method, url });
      expect(response.statusCode, `${method} ${url}`).toBe(404);
      expect(response.json(), `${method} ${url}`).toEqual({ error: "Not found" });
    }

    await fs.rm(webRoot, { recursive: true, force: true });
    const apiOnly = await startApp();
    const unknown = await apiOnly.app.inject({ method: "PATCH", url: "/anything" });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toEqual({ error: "Not found" });
  });

  it("keeps API documentation off by default and behind a session when enabled", async () => {
    const app = await startApp({ apiDocsEnabled: undefined });
    const cookie = await createAdminSession(app);
    expect((await app.app.inject({ method: "GET", url: "/documentation/json", headers: { cookie } })).statusCode).toBe(404);

    const withDocs = await startApp({ apiDocsEnabled: true });
    expect((await withDocs.app.inject({ method: "GET", url: "/documentation/json" })).statusCode).toBe(401);
    expect((await withDocs.app.inject({ method: "GET", url: "/documentatio%6E/json" })).statusCode).toBe(401);
    expect((await withDocs.app.inject({ method: "GET", url: "/documentation/json", headers: { cookie } })).statusCode).toBe(200);
  });

  it("limits health detail to direct local requests or a session", async () => {
    const app = await startApp();
    const live = await app.app.inject({ method: "GET", url: "/api/health/live", remoteAddress: remoteClient });
    expect(live.statusCode).toBe(200);
    expect(live.json()).toEqual({ ok: true, service: "running" });

    for (const url of ["/api/health", "/api/health/ready"]) {
      expect((await app.app.inject({ method: "GET", url, remoteAddress: remoteClient })).statusCode).toBe(401);
      expect((await app.app.inject({ method: "GET", url, headers: { "x-forwarded-for": remoteClient } })).statusCode).toBe(401);
    }
    expect((await app.app.inject({ method: "GET", url: "/api/health" })).statusCode).toBe(200);

    const cookie = await createAdminSession(app);
    expect((await app.app.inject({ method: "GET", url: "/api/health", remoteAddress: remoteClient, headers: { cookie } })).statusCode).toBe(200);
  });

  it("rate limits requests without a session", async () => {
    const app = await startApp({ anonymousRequestsPerMinute: 5 });
    const cookie = await createAdminSession(app);
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 6; attempt += 1) {
      statuses.push((await app.app.inject({ method: "GET", url: "/api/settings/paths", remoteAddress: remoteClient })).statusCode);
    }
    expect(statuses).toEqual([401, 401, 401, 401, 401, 429]);
    const limited = await app.app.inject({ method: "GET", url: "/api/auth/me", remoteAddress: remoteClient });
    expect(limited.statusCode).toBe(429);
    expect(limited.headers["retry-after"]).toBeDefined();

    for (let attempt = 0; attempt < 10; attempt += 1) {
      expect((await app.app.inject({ method: "GET", url: "/api/settings/paths", remoteAddress: remoteClient, headers: { cookie } })).statusCode).toBe(200);
    }
  });

  it("derives the client address only through the configured proxies", async () => {
    const observed: Array<{ ip: string; protocol: string }> = [];
    const trusted = await startApp({ trustProxy: ["192.168.1.2"], anonymousRequestsPerMinute: 3 });
    trusted.app.addHook("onResponse", async (request) => {
      observed.push({ ip: request.ip, protocol: request.protocol });
    });

    // From the trusted proxy, each forwarded client is counted separately.
    for (let client = 1; client <= 5; client += 1) {
      const response = await trusted.app.inject({
        method: "GET",
        url: "/api/auth/me",
        remoteAddress: "192.168.1.2",
        headers: { "x-forwarded-for": `198.51.100.99, 203.0.113.${client}`, "x-forwarded-proto": "https" }
      });
      expect(response.statusCode).toBe(200);
    }
    expect(observed.map((entry) => entry.ip)).toEqual(["203.0.113.1", "203.0.113.2", "203.0.113.3", "203.0.113.4", "203.0.113.5"]);
    expect(observed.every((entry) => entry.protocol === "https")).toBe(true);

    // From any other peer, forwarding headers are ignored.
    observed.length = 0;
    const statuses: number[] = [];
    for (let client = 1; client <= 4; client += 1) {
      const response = await trusted.app.inject({
        method: "GET",
        url: "/api/auth/me",
        remoteAddress: "192.168.1.50",
        headers: { "x-forwarded-for": `203.0.113.${client}`, "x-forwarded-proto": "https" }
      });
      statuses.push(response.statusCode);
    }
    expect(statuses).toEqual([200, 200, 200, 429]);
    expect(observed.every((entry) => entry.ip === "192.168.1.50" && entry.protocol === "http")).toBe(true);

    observed.length = 0;
    const untrusting = await startApp({ trustProxy: false });
    untrusting.app.addHook("onResponse", async (request) => {
      observed.push({ ip: request.ip, protocol: request.protocol });
    });
    await untrusting.app.inject({ method: "GET", url: "/api/auth/me", remoteAddress: "192.168.1.2", headers: { "x-forwarded-for": "203.0.113.7" } });
    expect(observed).toEqual([{ ip: "192.168.1.2", protocol: "http" }]);
  });

  it("accepts mutations from the configured public origin", async () => {
    const app = await startApp({ publicOrigin: "https://srtl.example.com" });
    const cookie = await createAdminSession(app);
    const payload = { timeFormat: "24h", autoOpenTaskStatus: false, recentJobsCompletedWindowMinutes: 60 };
    const fromPublicOrigin = await app.app.inject({ method: "PUT", url: "/api/settings/user-preferences", headers: { cookie, origin: "https://srtl.example.com" }, payload });
    expect(fromPublicOrigin.statusCode).toBe(200);
    const fromElsewhere = await app.app.inject({ method: "PUT", url: "/api/settings/user-preferences", headers: { cookie, origin: "https://other.example.com" }, payload });
    expect(fromElsewhere.statusCode).toBe(403);
  });

  it("sends restrictive framing, feature and transport headers", async () => {
    const app = await startApp();
    const response = await app.app.inject({ method: "GET", url: "/api/health/live" });
    expect(response.headers["permissions-policy"]).toContain("camera=()");
    expect(response.headers["x-frame-options"]).toBe("DENY");
    expect(response.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(response.headers["strict-transport-security"]).toBe("max-age=31536000");
    const denied = await app.app.inject({ method: "GET", url: "/api/jobs" });
    expect(denied.statusCode).toBe(401);
    expect(denied.headers["permissions-policy"]).toContain("camera=()");
  });
});

describe("request path normalisation", () => {
  it("folds the spellings a lenient proxy might accept", () => {
    expect(normalizedRequestPath("/%2561pi/x")).toBe("/api/x");
    expect(normalizedRequestPath("/A%50I//x/./y/../z;p=1?q")).toBe("/api/x/z");
    expect(normalizedRequestPath("/x\\..\\api")).toBe("/api");
    expect(normalizedRequestPath("/%E0%A4%A")).toBeNull();
    expect(isReservedPath("/Documentation")).toBe(true);
    expect(isReservedPath("/assets/../api/jobs")).toBe(true);
    expect(isReservedPath("/library/movies")).toBe(false);
    expect(isReservedPath("/api-docs-guide")).toBe(false);
  });
});
