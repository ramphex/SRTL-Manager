import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, type AppContext } from "../src/server/app";
import { currentScryptParameters, hashPassword, hashToken, passwordHashing, passwordNeedsRehash } from "../src/server/auth";
import type { AppConfig } from "../src/server/config";
import * as schema from "../src/server/db/schema";
import { markOnboardingCompleteForExistingInstall } from "../src/server/lib/onboarding";
import { FailureThrottle, LoginThrottle, usernameThrottlePolicy } from "../src/server/loginThrottle";
import { pruneSecurityEvents } from "../src/server/securityEvents";
import { legacyCookieGraceMs, sessionCookieSettings } from "../src/server/sessionAccess";
import { isLocalNetworkAddress, setupTokenFileName } from "../src/server/setupToken";
import { describeUserAgent } from "../src/shared/auth";
import { readSetupToken } from "./authHelpers";
import { createTestDatabase, type TestDatabaseHandle } from "./testDb";

const password = "correct-horse-battery";
const remoteClient = "203.0.113.10";
const firefox = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14.5; rv:131.0) Gecko/20100101 Firefox/131.0";

let tmpDir: string;
let testDatabase: TestDatabaseHandle;
let ctx: AppContext | undefined;

async function startApp(overrides: Partial<AppConfig> = {}): Promise<AppContext> {
  if (ctx) await ctx.app.close();
  ctx = await createApp({
    rootDir: tmpDir,
    dataDir: path.join(tmpDir, "data"),
    databaseUrl: testDatabase.databaseUrl,
    anonymousRequestsPerMinute: 100_000,
    ...overrides
  });
  return ctx;
}

function cookieValue(setCookie: string | string[] | undefined, name: string): string | undefined {
  const headers = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  for (const header of headers) {
    const [pair] = header.split(";");
    const index = pair?.indexOf("=") ?? -1;
    if (pair && index > 0 && pair.slice(0, index) === name) return pair.slice(index + 1);
  }
  return undefined;
}

function setCookies(setCookie: string | string[] | undefined): string[] {
  return Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
}

async function setupAdmin(app: AppContext, username = "alex_03"): Promise<string> {
  const response = await app.app.inject({
    method: "POST",
    url: "/api/auth/setup",
    payload: { setupToken: readSetupToken(app), username, password, confirmPassword: password }
  });
  expect(response.statusCode).toBe(200);
  await markOnboardingCompleteForExistingInstall(app.database.db);
  const name = sessionCookieSettings(app.config.sessionCookieName, app.config.sessionCookieSecure).name;
  return `${name}=${cookieValue(response.headers["set-cookie"], name)}`;
}

async function login(app: AppContext, options: { username?: string; password?: string; remoteAddress?: string; userAgent?: string } = {}) {
  return app.app.inject({
    method: "POST",
    url: "/api/auth/login",
    remoteAddress: options.remoteAddress ?? "127.0.0.1",
    headers: options.userAgent ? { "user-agent": options.userAgent } : {},
    payload: { username: options.username ?? "alex_03", password: options.password ?? password }
  });
}

async function loginCookie(app: AppContext, options: Parameters<typeof login>[1] = {}): Promise<string> {
  const response = await login(app, options);
  expect(response.statusCode).toBe(200);
  const name = sessionCookieSettings(app.config.sessionCookieName, app.config.sessionCookieSecure).name;
  return `${name}=${cookieValue(response.headers["set-cookie"], name)}`;
}

async function events(app: AppContext): Promise<string[]> {
  const rows = await app.database.db.select({ event: schema.securityEvents.event }).from(schema.securityEvents).orderBy(schema.securityEvents.id);
  return rows.map((row) => row.event);
}

function legacyHash(secret: string): string {
  const salt = crypto.randomBytes(16).toString("base64");
  return `scrypt$${salt}$${crypto.scryptSync(secret, salt, 64).toString("base64")}`;
}

describe("authentication and sessions", () => {
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "srtl-auth-"));
    for (const directory of ["plex", "local", "remote"]) await fs.mkdir(path.join(tmpDir, directory), { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, ".env"),
      [`SYMLINK_DIR="${path.join(tmpDir, "plex")}"`, `SRTL_LOCATION_1_PATH="${path.join(tmpDir, "local")}"`, `SRTL_LOCATION_2_PATH="${path.join(tmpDir, "remote")}"`].join("\n")
    );
    testDatabase = await createTestDatabase();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (ctx) await ctx.app.close();
    ctx = undefined;
    await testDatabase.cleanup();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe("first-run setup", () => {
    it("requires the one-time setup token and rejects a wrong one", async () => {
      const app = await startApp();
      const tokenPath = path.join(app.config.dataDir, setupTokenFileName);
      const token = readSetupToken(app);
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect((await fs.stat(tokenPath)).mode & 0o777).toBe(0o600);

      const missing = await app.app.inject({ method: "POST", url: "/api/auth/setup", payload: { username: "alex_03", password, confirmPassword: password } });
      expect(missing.statusCode).toBe(400);
      expect(missing.json()).toMatchObject({ error: "Setup token is required" });

      const wrong = await app.app.inject({
        method: "POST",
        url: "/api/auth/setup",
        payload: { setupToken: `${token.slice(0, -1)}x`, username: "alex_03", password, confirmPassword: password }
      });
      expect(wrong.statusCode).toBe(403);
      expect(wrong.json()).toMatchObject({ error: "Setup is not available. Check the setup token in the server log.", code: "setup_unavailable" });
      expect(wrong.headers["set-cookie"]).toBeUndefined();
      await expect(app.database.db.select().from(schema.adminUsers)).resolves.toHaveLength(0);

      const shortPassword = await app.app.inject({
        method: "POST",
        url: "/api/auth/setup",
        payload: { setupToken: token, username: "alex_03", password: "eleven-char", confirmPassword: "eleven-char" }
      });
      expect(shortPassword.statusCode).toBe(400);
      expect(shortPassword.json()).toMatchObject({ error: "Password must be at least 12 characters" });

      const accepted = await app.app.inject({
        method: "POST",
        url: "/api/auth/setup",
        payload: { setupToken: ` ${token} `, username: "alex_03", password, confirmPassword: password }
      });
      expect(accepted.statusCode).toBe(200);
      await expect(fs.stat(tokenPath)).rejects.toThrow();

      // The token is single use, and a completed setup answers exactly like a wrong token.
      const reused = await app.app.inject({ method: "POST", url: "/api/auth/setup", payload: { setupToken: token, username: "other", password, confirmPassword: password } });
      expect(reused.statusCode).toBe(403);
      // Only the per-request ID differs.
      const withoutRequestId = (body: Record<string, unknown>) => ({ ...body, requestId: undefined });
      expect(withoutRequestId(reused.json())).toEqual(withoutRequestId(wrong.json()));
      expect(await events(app)).toEqual(["setup_rejected", "setup_completed", "setup_rejected"]);
    });

    it("keeps the token across restarts until setup completes and removes it once an admin exists", async () => {
      const first = await startApp();
      const token = readSetupToken(first);
      const second = await startApp();
      expect(readSetupToken(second)).toBe(token);
      await setupAdmin(second);

      await fs.writeFile(path.join(second.config.dataDir, setupTokenFileName), "stale-token-from-a-backup-000000\n");
      const third = await startApp();
      await expect(fs.stat(path.join(third.config.dataDir, setupTokenFileName))).rejects.toThrow();
    });

    it("accepts a fixed token from SRTL_SETUP_TOKEN without writing it to disk", async () => {
      const fixed = "example-setup-token-0123456789";
      const app = await startApp({ setupToken: fixed });
      await expect(fs.stat(path.join(app.config.dataDir, setupTokenFileName))).rejects.toThrow();
      const response = await app.app.inject({ method: "POST", url: "/api/auth/setup", payload: { setupToken: fixed, username: "alex_03", password, confirmPassword: password } });
      expect(response.statusCode).toBe(200);
      await expect(startApp({ setupToken: "too-short" })).rejects.toThrow("SRTL_SETUP_TOKEN");
    });

    it("tells only local clients that setup is pending", async () => {
      const app = await startApp({ trustProxy: ["192.168.1.2"] });
      const me = (remoteAddress: string, headers: Record<string, string> = {}) => app.app.inject({ method: "GET", url: "/api/auth/me", remoteAddress, headers });
      expect((await me("127.0.0.1")).json()).toEqual({ authenticated: false, user: null, setupRequired: true });
      expect((await me("192.168.1.20")).json()).toMatchObject({ setupRequired: true });
      expect((await me(remoteClient)).json()).toEqual({ authenticated: false, user: null, setupRequired: false });
      // Through the trusted proxy, the forwarded internet client decides.
      expect((await me("192.168.1.2", { "x-forwarded-for": remoteClient })).json()).toMatchObject({ setupRequired: false });
      expect((await me("192.168.1.2", { "x-forwarded-for": "192.168.1.30" })).json()).toMatchObject({ setupRequired: true });

      // An internet client can still complete setup with the token.
      const setup = await app.app.inject({
        method: "POST",
        url: "/api/auth/setup",
        remoteAddress: remoteClient,
        payload: { setupToken: readSetupToken(app), username: "alex_03", password, confirmPassword: password }
      });
      expect(setup.statusCode).toBe(200);
      expect((await me("127.0.0.1")).json()).toMatchObject({ setupRequired: false });
    });

    it("classifies local network addresses", () => {
      for (const address of ["127.0.0.1", "::1", "::ffff:192.168.1.5", "10.1.2.3", "172.20.0.4", "192.168.1.20", "fd12::1", "fe80::1", "100.100.1.1"]) {
        expect(isLocalNetworkAddress(address), address).toBe(true);
      }
      for (const address of ["203.0.113.10", "198.51.100.7", "2001:db8::1", "::ffff:203.0.113.10", "", "not-an-ip"]) {
        expect(isLocalNetworkAddress(address), address).toBe(false);
      }
    });
  });

  describe("sign-in protection", () => {
    it("has no default username and keeps errors generic", async () => {
      const app = await startApp();
      await setupAdmin(app);
      const noUsername = await app.app.inject({ method: "POST", url: "/api/auth/login", payload: { password } });
      expect(noUsername.statusCode).toBe(400);

      const wrongPassword = await login(app, { password: "wrong-password", remoteAddress: "192.168.1.21" });
      const unknownUser = await login(app, { username: "nobody", remoteAddress: "192.168.1.22" });
      expect(wrongPassword.statusCode).toBe(401);
      expect(unknownUser.statusCode).toBe(401);
      expect(unknownUser.json()).toEqual(wrongPassword.json());
      expect(wrongPassword.json()).toEqual({ error: "Invalid username or password" });
    });

    it("checks unknown usernames against a dummy hash so timing matches a wrong password", async () => {
      const app = await startApp();
      await setupAdmin(app);
      const verify = vi.spyOn(passwordHashing, "verify");

      await login(app, { username: "nobody", password: "anything-at-all", remoteAddress: "192.168.1.31" });
      expect(verify).toHaveBeenCalledTimes(1);
      const [checkedPassword, checkedHash] = verify.mock.calls[0]!;
      expect(checkedPassword).toBe("anything-at-all");
      expect(checkedHash).toMatch(new RegExp(`^scrypt\\$v2\\$${currentScryptParameters.N}\\$8\\$1\\$`));
      const [admin] = await app.database.db.select().from(schema.adminUsers);
      expect(checkedHash).not.toBe(admin?.passwordHash);

      verify.mockClear();
      await login(app, { password: "wrong-password", remoteAddress: "192.168.1.32" });
      expect(verify).toHaveBeenCalledTimes(1);
      expect(verify.mock.calls[0]?.[1]).toBe(admin?.passwordHash);
    });

    it("locks a username after repeated failures from any address, whether or not it exists", async () => {
      const app = await startApp();
      await setupAdmin(app);
      for (const username of ["alex_03", "nobody"]) {
        const statuses: number[] = [];
        for (let attempt = 1; attempt <= 5; attempt += 1) {
          statuses.push((await login(app, { username, password: `wrong-password-${attempt}`, remoteAddress: `203.0.113.${attempt}` })).statusCode);
        }
        expect(statuses).toEqual([401, 401, 401, 401, 401]);
        const locked = await login(app, { username, remoteAddress: "203.0.113.99" });
        expect(locked.statusCode, username).toBe(429);
        expect(locked.json()).toMatchObject({ error: "Too many sign-in attempts. Try again later.", code: "sign_in_locked" });
        expect(Number(locked.headers["retry-after"])).toBeGreaterThan(0);
      }
      const recorded = await events(app);
      expect(recorded.filter((event) => event === "login_failed")).toHaveLength(10);
      expect(recorded.filter((event) => event === "login_locked")).toHaveLength(2);
      expect(recorded).not.toContain("login_succeeded");
    });

    it("backs off exponentially per key up to a cap and forgets old failures", () => {
      let now = 1_000_000;
      const throttle = new FailureThrottle(usernameThrottlePolicy, 3, () => now);
      for (let attempt = 1; attempt < usernameThrottlePolicy.freeAttempts; attempt += 1) expect(throttle.failure("alex_03").lockedNow).toBe(false);
      expect(throttle.retryAfterMs("alex_03")).toBe(0);
      const first = throttle.failure("alex_03");
      expect(first).toEqual({ lockedNow: true, retryAfterMs: usernameThrottlePolicy.baseLockMs });
      now += usernameThrottlePolicy.baseLockMs;
      expect(throttle.retryAfterMs("alex_03")).toBe(0);
      expect(throttle.failure("alex_03").retryAfterMs).toBe(usernameThrottlePolicy.baseLockMs * 2);
      for (let attempt = 0; attempt < 30; attempt += 1) throttle.failure("alex_03");
      expect(throttle.retryAfterMs("alex_03")).toBe(usernameThrottlePolicy.maxLockMs);

      now += usernameThrottlePolicy.maxLockMs + usernameThrottlePolicy.resetAfterMs;
      expect(throttle.retryAfterMs("alex_03")).toBe(0);
      expect(throttle.failure("alex_03").lockedNow).toBe(false);

      // Bounded memory: the oldest keys are dropped first.
      for (const key of ["a", "b", "c"]) throttle.failure(key);
      throttle.failure("alex_03");
      expect(throttle.retryAfterMs("a")).toBe(0);

      const login = new LoginThrottle(() => now);
      for (let attempt = 0; attempt < 20; attempt += 1) login.failure(`user-${attempt}`, remoteClient);
      expect(login.check("someone-new", remoteClient).allowed).toBe(false);
      expect(login.check("someone-new", "203.0.113.11").allowed).toBe(true);
      login.success("someone-new", remoteClient);
      expect(login.check("someone-new", remoteClient).allowed).toBe(true);
    });

    it("rate limits account changes", async () => {
      const app = await startApp();
      const cookie = await setupAdmin(app);
      const statuses: number[] = [];
      for (let attempt = 0; attempt < 6; attempt += 1) {
        statuses.push((await app.app.inject({ method: "PUT", url: "/api/auth/user", headers: { cookie }, payload: { username: "alex_03", currentPassword: "wrong-password" } })).statusCode);
      }
      expect(statuses).toEqual([401, 401, 401, 401, 401, 429]);
      expect((await events(app)).filter((event) => event === "reauthentication_failed")).toHaveLength(5);
    });

    it("keeps short existing passwords working but requires 12 characters for new ones", async () => {
      const app = await startApp();
      const cookie = await setupAdmin(app);
      await app.database.db.update(schema.adminUsers).set({ passwordHash: await hashPassword("short-pw") });
      expect((await login(app, { password: "short-pw" })).statusCode).toBe(200);

      const tooShort = await app.app.inject({
        method: "PUT",
        url: "/api/auth/user",
        headers: { cookie },
        payload: { username: "alex_03", currentPassword: "short-pw", newPassword: "eleven-char", confirmNewPassword: "eleven-char" }
      });
      expect(tooShort.statusCode).toBe(400);
      expect(tooShort.json()).toMatchObject({ error: "Password must be at least 12 characters" });
    });

    it("rehashes a password stored with older parameters on sign-in", async () => {
      const app = await startApp();
      await setupAdmin(app);
      const oldHash = legacyHash(password);
      expect(passwordNeedsRehash(oldHash)).toBe(true);
      await app.database.db.update(schema.adminUsers).set({ passwordHash: oldHash });

      expect((await login(app, { password: "wrong-password" })).statusCode).toBe(401);
      expect((await app.database.db.select().from(schema.adminUsers))[0]?.passwordHash).toBe(oldHash);

      expect((await login(app)).statusCode).toBe(200);
      const [admin] = await app.database.db.select().from(schema.adminUsers);
      expect(admin?.passwordHash).toMatch(/^scrypt\$v2\$131072\$8\$1\$[^$]+\$[^$]+$/);
      expect(passwordNeedsRehash(admin!.passwordHash)).toBe(false);
      expect((await login(app)).statusCode).toBe(200);

      const [succeeded] = await app.database.db.select().from(schema.securityEvents).where(eq(schema.securityEvents.event, "login_succeeded")).limit(1);
      expect(JSON.parse(succeeded!.details)).toEqual({ passwordRehashed: true });
    });
  });

  describe("session cookies", () => {
    it("uses the __Host- prefix with Secure cookies and moves an old-name cookie over once", async () => {
      const app = await startApp({ publicOrigin: "https://srtl.example.com" });
      expect(app.config.sessionCookieSecure).toBe(true);
      const setup = await app.app.inject({
        method: "POST",
        url: "/api/auth/setup",
        payload: { setupToken: readSetupToken(app), username: "alex_03", password, confirmPassword: password }
      });
      const issued = setCookies(setup.headers["set-cookie"]).find((header) => header.startsWith("__Host-srtl_session="));
      expect(issued).toBeDefined();
      expect(issued).toContain("Secure");
      expect(issued).toContain("Path=/");
      expect(issued).not.toContain("Domain");
      await markOnboardingCompleteForExistingInstall(app.database.db);

      // A session issued before the upgrade under the old name.
      const token = cookieValue(setup.headers["set-cookie"], "__Host-srtl_session")!;
      const legacy = await app.app.inject({ method: "GET", url: "/api/settings/paths", headers: { cookie: `srtl_session=${token}` } });
      expect(legacy.statusCode).toBe(200);
      expect(cookieValue(legacy.headers["set-cookie"], "__Host-srtl_session")).toBe(token);
      expect(setCookies(legacy.headers["set-cookie"]).find((header) => header.startsWith("srtl_session="))).toMatch(/Max-Age=0|Expires=Thu, 01 Jan 1970/);

      // A parallel request from the same page load still gets through.
      expect((await app.app.inject({ method: "GET", url: "/api/settings/paths", headers: { cookie: `srtl_session=${token}` } })).statusCode).toBe(200);

      // After the grace period, the old name alone no longer works; the new one does.
      await app.database.db.update(schema.sessions).set({ cookieReissuedAt: new Date(Date.now() - legacyCookieGraceMs - 1_000).toISOString() });
      expect((await app.app.inject({ method: "GET", url: "/api/settings/paths", headers: { cookie: `srtl_session=${token}` } })).statusCode).toBe(401);
      expect((await app.app.inject({ method: "GET", url: "/api/settings/paths", headers: { cookie: `__Host-srtl_session=${token}` } })).statusCode).toBe(200);
      const both = await app.app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie: `__Host-srtl_session=${token}; srtl_session=${token}` } });
      expect(both.json()).toMatchObject({ authenticated: true });
      expect(setCookies(both.headers["set-cookie"]).some((header) => header.startsWith("srtl_session=;"))).toBe(true);
    });

    it("keeps the plain cookie name without Secure", async () => {
      expect(sessionCookieSettings("srtl_session_5178", false)).toEqual({ name: "srtl_session_5178", legacyNames: [], secure: false, plainHttpOrigins: [] });
      expect(sessionCookieSettings("srtl_session_5178", true)).toEqual({ name: "__Host-srtl_session_5178", legacyNames: ["srtl_session_5178"], secure: true, plainHttpOrigins: [] });
      const app = await startApp();
      const cookie = await setupAdmin(app);
      expect(cookie.startsWith("srtl_session=")).toBe(true);
    });

    describe("with an https public origin and a listed LAN address", () => {
      const lanHost = "192.168.1.20:5179";
      const lan = { host: lanHost, origin: `http://${lanHost}` };
      const publicSite = { host: "srtl.example.com", origin: "https://srtl.example.com" };
      const signIn = (app: AppContext, headers: Record<string, string>) =>
        app.app.inject({ method: "POST", url: "/api/auth/login", headers, payload: { username: "alex_03", password } });

      async function startWithLanAddress(overrides: Partial<AppConfig> = {}): Promise<AppContext> {
        const app = await startApp({ publicOrigin: publicSite.origin, allowedOrigins: [lan.origin], ...overrides });
        await setupAdmin(app);
        return app;
      }

      it("issues a cookie browsers keep over plain HTTP, and keeps it across requests", async () => {
        const app = await startWithLanAddress();
        const response = await signIn(app, lan);
        expect(response.statusCode).toBe(200);
        const [issued, ...others] = setCookies(response.headers["set-cookie"]);
        expect(others).toEqual([]);
        expect(issued).toMatch(/^srtl_session=/);
        expect(issued).not.toContain("Secure");
        expect(issued).toContain("HttpOnly");
        expect(issued).toContain("SameSite=Strict");

        const token = cookieValue(response.headers["set-cookie"], "srtl_session")!;
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const next = await app.app.inject({ method: "GET", url: "/api/settings/paths", headers: { host: lanHost, cookie: `srtl_session=${token}` } });
          expect(next.statusCode).toBe(200);
          expect(next.headers["set-cookie"]).toBeUndefined();
        }
        await app.database.db.update(schema.sessions).set({ cookieReissuedAt: new Date(Date.now() - legacyCookieGraceMs - 1_000).toISOString() });
        expect((await app.app.inject({ method: "GET", url: "/api/settings/paths", headers: { host: lanHost, cookie: `srtl_session=${token}` } })).statusCode).toBe(200);
      });

      it("keeps Secure __Host- cookies for every other request", async () => {
        const app = await startWithLanAddress();
        const fromSite = await signIn(app, publicSite);
        expect(fromSite.statusCode).toBe(200);
        const issued = setCookies(fromSite.headers["set-cookie"])[0];
        expect(issued).toMatch(/^__Host-srtl_session=/);
        expect(issued).toContain("Secure");

        // A proxy that rewrites Host to the LAN address must not downgrade the site's cookie.
        const rewrittenHost = await signIn(app, { host: lanHost, origin: publicSite.origin });
        expect(setCookies(rewrittenHost.headers["set-cookie"])[0]).toMatch(/^__Host-srtl_session=.*Secure/);
        const forwarded = await signIn(app, { ...lan, "x-forwarded-proto": "https" });
        expect(setCookies(forwarded.headers["set-cookie"])[0]).toMatch(/^__Host-srtl_session=.*Secure/);

        // An address that is not listed gets the Secure cookie too, and cannot keep using the plain name.
        const token = cookieValue(fromSite.headers["set-cookie"], "__Host-srtl_session")!;
        const elsewhere = await app.app.inject({ method: "GET", url: "/api/settings/paths", headers: { host: "192.168.1.99:5179", cookie: `srtl_session=${token}` } });
        expect(cookieValue(elsewhere.headers["set-cookie"], "__Host-srtl_session")).toBe(token);
      });

      it("trusts forwarded HTTPS from a listed proxy on the LAN address", async () => {
        const app = await startWithLanAddress({ trustProxy: ["127.0.0.1"] });
        const response = await signIn(app, { host: lanHost, "x-forwarded-proto": "https" });
        expect(setCookies(response.headers["set-cookie"])[0]).toMatch(/^__Host-srtl_session=.*Secure/);
      });

      it("signs out of the LAN address", async () => {
        const app = await startWithLanAddress();
        const response = await signIn(app, lan);
        const token = cookieValue(response.headers["set-cookie"], "srtl_session")!;
        const logout = await app.app.inject({ method: "POST", url: "/api/auth/logout", headers: { ...lan, cookie: `srtl_session=${token}` } });
        expect(logout.statusCode).toBe(200);
        expect(setCookies(logout.headers["set-cookie"]).find((header) => header.startsWith("srtl_session="))).toMatch(/Max-Age=0|Expires=Thu, 01 Jan 1970/);
        expect((await app.app.inject({ method: "GET", url: "/api/settings/paths", headers: { host: lanHost, cookie: `srtl_session=${token}` } })).statusCode).toBe(401);
      });
    });
  });

  describe("session lifetime", () => {
    it("ends idle sessions and sessions past their absolute lifetime", async () => {
      const app = await startApp({ sessionIdleTimeoutHours: 2, sessionMaxAgeDays: 3 });
      const cookie = await setupAdmin(app);
      const [session] = await app.database.db.select().from(schema.sessions);
      expect(Date.parse(session!.idleExpiresAt!) - Date.parse(session!.lastSeenAt!)).toBe(2 * 60 * 60 * 1_000);
      expect(Date.parse(session!.expiresAt) - Date.parse(session!.createdAt)).toBe(3 * 24 * 60 * 60 * 1_000);

      await app.database.db.update(schema.sessions).set({ idleExpiresAt: new Date(Date.now() - 1_000).toISOString() });
      expect((await app.app.inject({ method: "GET", url: "/api/settings/paths", headers: { cookie } })).statusCode).toBe(401);
      await expect(app.database.db.select().from(schema.sessions)).resolves.toHaveLength(0);

      const second = await loginCookie(app);
      await app.database.db.update(schema.sessions).set({ expiresAt: new Date(Date.now() - 1_000).toISOString() });
      expect((await app.app.inject({ method: "GET", url: "/api/settings/paths", headers: { cookie: second } })).statusCode).toBe(401);
      await expect(app.database.db.select().from(schema.sessions)).resolves.toHaveLength(0);
    });

    it("slides the idle deadline with throttled last-seen updates", async () => {
      const app = await startApp({ sessionIdleTimeoutHours: 1 });
      const cookie = await setupAdmin(app);
      const before = (await app.database.db.select().from(schema.sessions))[0]!;
      await app.app.inject({ method: "GET", url: "/api/settings/paths", headers: { cookie } });
      // Within a minute of the last write nothing is written.
      expect((await app.database.db.select().from(schema.sessions))[0]).toEqual(before);

      const stale = new Date(Date.now() - 5 * 60_000).toISOString();
      await app.database.db.update(schema.sessions).set({ lastSeenAt: stale, idleExpiresAt: new Date(Date.now() + 60_000).toISOString(), ip: null });
      await app.app.inject({ method: "GET", url: "/api/settings/paths", remoteAddress: "192.168.1.40", headers: { cookie } });
      const after = (await app.database.db.select().from(schema.sessions))[0]!;
      expect(Date.parse(after.lastSeenAt!)).toBeGreaterThan(Date.parse(stale));
      expect(Date.parse(after.idleExpiresAt!) - Date.parse(after.lastSeenAt!)).toBe(60 * 60 * 1_000);
      expect(after.ip).toBe("192.168.1.40");
    });

    it("keeps sessions from before the upgrade until they are first used", async () => {
      const app = await startApp();
      const cookie = await setupAdmin(app);
      await app.database.db.update(schema.sessions).set({ lastSeenAt: null, idleExpiresAt: null, ip: null, userAgent: null });
      expect((await app.app.inject({ method: "GET", url: "/api/settings/paths", headers: { cookie } })).statusCode).toBe(200);
      const [session] = await app.database.db.select().from(schema.sessions);
      expect(session?.lastSeenAt).not.toBeNull();
      expect(session?.idleExpiresAt).not.toBeNull();
    });
  });

  describe("session management", () => {
    it("lists sessions with device and address and revokes one or all others", async () => {
      const app = await startApp();
      const current = await setupAdmin(app);
      const laptop = await loginCookie(app, { remoteAddress: "192.168.1.50", userAgent: firefox });
      const phone = await loginCookie(app, { remoteAddress: "192.168.1.51" });

      const list = await app.app.inject({ method: "GET", url: "/api/auth/sessions", headers: { cookie: current } });
      expect(list.statusCode).toBe(200);
      const body = list.json() as { sessions: Array<{ id: number; current: boolean; ip: string | null; device: string; lastSeenAt: string | null; expiresAt: string }>; idleTimeoutHours: number; maxAgeDays: number };
      expect(body).toMatchObject({ idleTimeoutHours: 12, maxAgeDays: 14 });
      expect(body.sessions).toHaveLength(3);
      expect(body.sessions.filter((session) => session.current)).toHaveLength(1);
      const laptopSession = body.sessions.find((session) => session.ip === "192.168.1.50");
      expect(laptopSession).toMatchObject({ current: false, device: "Firefox on macOS", lastSeenAt: expect.any(String), expiresAt: expect.any(String) });
      expect(JSON.stringify(body)).not.toContain(hashToken(laptop.split("=")[1]!));

      const revoke = await app.app.inject({ method: "DELETE", url: `/api/auth/sessions/${laptopSession!.id}`, headers: { cookie: current } });
      expect(revoke.json()).toEqual({ ok: true, current: false });
      expect((await app.app.inject({ method: "GET", url: "/api/settings/paths", headers: { cookie: laptop } })).statusCode).toBe(401);
      expect((await app.app.inject({ method: "GET", url: "/api/settings/paths", headers: { cookie: phone } })).statusCode).toBe(200);
      expect((await app.app.inject({ method: "DELETE", url: `/api/auth/sessions/${laptopSession!.id}`, headers: { cookie: current } })).statusCode).toBe(404);

      await loginCookie(app, { remoteAddress: "192.168.1.52" });
      const others = await app.app.inject({ method: "POST", url: "/api/auth/sessions/revoke-others", headers: { cookie: current } });
      expect(others.json()).toEqual({ ok: true, revoked: 2 });
      expect((await app.app.inject({ method: "GET", url: "/api/settings/paths", headers: { cookie: phone } })).statusCode).toBe(401);
      expect((await app.app.inject({ method: "GET", url: "/api/settings/paths", headers: { cookie: current } })).statusCode).toBe(200);

      const [own] = (await app.app.inject({ method: "GET", url: "/api/auth/sessions", headers: { cookie: current } })).json().sessions as Array<{ id: number }>;
      const self = await app.app.inject({ method: "DELETE", url: `/api/auth/sessions/${own!.id}`, headers: { cookie: current } });
      expect(self.json()).toEqual({ ok: true, current: true });
      expect(setCookies(self.headers["set-cookie"]).some((header) => header.startsWith("srtl_session=;"))).toBe(true);
      expect((await app.app.inject({ method: "GET", url: "/api/settings/paths", headers: { cookie: current } })).statusCode).toBe(401);
    });

    it("requires a session for session and event management, even before onboarding finishes", async () => {
      const app = await startApp();
      for (const [method, url] of [["GET", "/api/auth/sessions"], ["DELETE", "/api/auth/sessions/1"], ["POST", "/api/auth/sessions/revoke-others"], ["GET", "/api/auth/security-events"]] as const) {
        expect((await app.app.inject({ method, url, remoteAddress: remoteClient })).statusCode, `${method} ${url}`).toBe(401);
      }
      const setup = await app.app.inject({ method: "POST", url: "/api/auth/setup", payload: { setupToken: readSetupToken(app), username: "alex_03", password, confirmPassword: password } });
      const cookie = `srtl_session=${cookieValue(setup.headers["set-cookie"], "srtl_session")}`;
      expect((await app.app.inject({ method: "POST", url: "/api/auth/sessions/revoke-others", headers: { cookie } })).statusCode).toBe(200);
    });

    it("rotates the session on account changes and signs out other devices on a password change", async () => {
      const app = await startApp();
      const cookie = await setupAdmin(app);
      const other = await loginCookie(app);

      const rename = await app.app.inject({ method: "PUT", url: "/api/auth/user", headers: { cookie }, payload: { username: "alex_04", currentPassword: password } });
      expect(rename.statusCode).toBe(200);
      const renamed = `srtl_session=${cookieValue(rename.headers["set-cookie"], "srtl_session")}`;
      expect(renamed).not.toBe(cookie);
      expect((await app.app.inject({ method: "GET", url: "/api/settings/paths", headers: { cookie } })).statusCode).toBe(401);
      expect((await app.app.inject({ method: "GET", url: "/api/settings/paths", headers: { cookie: other } })).statusCode).toBe(200);

      const newPassword = "another-long-password";
      const change = await app.app.inject({ method: "PUT", url: "/api/auth/user", headers: { cookie: renamed }, payload: { username: "alex_04", currentPassword: password, newPassword, confirmNewPassword: newPassword } });
      expect(change.statusCode).toBe(200);
      const changed = `srtl_session=${cookieValue(change.headers["set-cookie"], "srtl_session")}`;
      expect((await app.app.inject({ method: "GET", url: "/api/settings/paths", headers: { cookie: other } })).statusCode).toBe(401);
      expect((await app.app.inject({ method: "GET", url: "/api/settings/paths", headers: { cookie: changed } })).statusCode).toBe(200);
    });
  });

  describe("security events", () => {
    it("records sign-in, account and session events and lists them newest first", async () => {
      const app = await startApp();
      const cookie = await setupAdmin(app);
      await login(app, { password: "wrong-password", remoteAddress: "192.168.1.60", userAgent: firefox });
      const second = await loginCookie(app, { remoteAddress: "192.168.1.61" });
      await app.app.inject({ method: "POST", url: "/api/auth/sessions/revoke-others", headers: { cookie } });
      const sessionId = (await app.database.db.select().from(schema.sessions))[0]!.id;
      const third = await loginCookie(app);
      const thirdId = (await app.database.db.select().from(schema.sessions)).find((row) => row.id !== sessionId)!.id;
      await app.app.inject({ method: "DELETE", url: `/api/auth/sessions/${thirdId}`, headers: { cookie } });
      const newPassword = "another-long-password";
      const change = await app.app.inject({ method: "PUT", url: "/api/auth/user", headers: { cookie }, payload: { username: "alex_04", currentPassword: password, newPassword, confirmNewPassword: newPassword } });
      const changed = `srtl_session=${cookieValue(change.headers["set-cookie"], "srtl_session")}`;
      await app.app.inject({ method: "POST", url: "/api/auth/logout", headers: { cookie: changed } });
      expect(second && third).toBeTruthy();

      expect(await events(app)).toEqual([
        "setup_completed",
        "login_failed",
        "login_succeeded",
        "sessions_revoked",
        "login_succeeded",
        "session_revoked",
        "username_changed",
        "password_changed",
        "logout"
      ]);
      const [failed] = await app.database.db.select().from(schema.securityEvents).where(eq(schema.securityEvents.event, "login_failed"));
      expect(failed).toMatchObject({ username: "alex_03", ip: "192.168.1.60", socketIp: "192.168.1.60", userAgent: firefox, userId: null });

      const viewer = await loginCookie(app, { username: "alex_04", password: newPassword });
      const page = await app.app.inject({ method: "GET", url: "/api/auth/security-events?limit=3", headers: { cookie: viewer } });
      expect(page.statusCode).toBe(200);
      const body = page.json() as { events: Array<{ id: number; event: string; device: string | null; details: Record<string, unknown> }>; hasMore: boolean; retentionDays: number };
      expect(body.events.map((event) => event.event)).toEqual(["login_succeeded", "logout", "password_changed"]);
      expect(body).toMatchObject({ hasMore: true, retentionDays: 90 });
      const older = await app.app.inject({ method: "GET", url: `/api/auth/security-events?limit=50&before=${body.events.at(-1)!.id}`, headers: { cookie: viewer } });
      const olderBody = older.json() as typeof body;
      expect(olderBody.hasMore).toBe(false);
      expect(olderBody.events.find((event) => event.event === "login_failed")?.device).toBe("Firefox on macOS");
      expect(olderBody.events.find((event) => event.event === "username_changed")?.details).toEqual({ previousUsername: "alex_03" });
    });

    it("prunes events past retention and beyond the row cap", async () => {
      const app = await startApp();
      const now = Date.now();
      const day = 24 * 60 * 60 * 1_000;
      await app.database.db.insert(schema.securityEvents).values([
        { createdAt: new Date(now - 100 * day).toISOString(), event: "login_failed" },
        { createdAt: new Date(now - 10 * day).toISOString(), event: "login_failed" },
        { createdAt: new Date(now - 2 * day).toISOString(), event: "login_succeeded" },
        { createdAt: new Date(now - day).toISOString(), event: "logout" }
      ]);
      expect(await pruneSecurityEvents(app.database.db, 0, now)).toBe(0);
      expect(await pruneSecurityEvents(app.database.db, 90, now)).toBe(1);
      expect(await pruneSecurityEvents(app.database.db, 90, now, 2)).toBe(1);
      expect(await events(app)).toEqual(["login_succeeded", "logout"]);
    });

    it("labels common browsers and systems", () => {
      expect(describeUserAgent(firefox)).toBe("Firefox on macOS");
      expect(describeUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1")).toBe("Safari on iOS");
      expect(describeUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0")).toBe("Edge on Windows");
      expect(describeUserAgent(null)).toBe("Unknown device");
    });
  });
});
