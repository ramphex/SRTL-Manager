import fs from "node:fs/promises";
import net, { isIP } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import fastify from "fastify";
import { createApp, type AppContext } from "../src/server/app";
import { first, setSetting } from "../src/server/db/database";
import * as schema from "../src/server/db/schema";
import { JobWorker } from "../src/server/jobs/jobRunner";
import { markOnboardingCompleteForExistingInstall } from "../src/server/lib/onboarding";
import { plexEndpoints } from "../src/server/lib/plexClient";
import { scrubIpAddresses, scrubText, scrubValue } from "../src/server/lib/restrictedView";
import { persistSectionSettings } from "../src/server/lib/sectionSettings";
import { routeTableEntries, routeTableEntry } from "../src/server/routeAccess";
import { accountRoles, canManageRole, manageableRoles, rolePermissions, roleHasPermission, type AccountRole, type Permission } from "../src/shared/permissions";
import { jellyfinVideoTranscodeWithBurnIn, plexHardwareTranscodeEpisode } from "./nowPlayingFixtures";
import { createTestDatabase, type TestDatabaseHandle } from "./testDb";
import { readSetupToken } from "./authHelpers";

const ownerPassword = "owner-password-1234";
const roleUsers = { admin: "helper-admin", moderator: "helper-moderator" } as const;
const finalPassword = (username: string) => `${username}-final-password`;
const temporaryPassword = "temporary-password-1";

type Method = "GET" | "POST" | "PUT" | "DELETE";

// Each sign-in gets its own address so the per-address sign-in limit does not interfere.
let addressCounter = 10;
function nextAddress(): string {
  addressCounter += 1;
  return `198.51.100.${addressCounter}`;
}

function concreteUrl(pattern: string): string {
  return pattern.replace(/:[A-Za-z]+/g, "1").replace(/\*$/, "probe");
}

async function databaseFingerprint(app: AppContext): Promise<Record<string, string>> {
  const tables = await app.database.pool.query<{ table_name: string }>("select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' order by table_name");
  const fingerprint: Record<string, string> = {};
  for (const { table_name: table } of tables.rows) {
    if (table === "sessions") continue; // Using a session touches its activity columns.
    const result = await app.database.pool.query<{ digest: string | null }>(`select md5(coalesce(string_agg(t::text, '|' order by t::text), '')) as digest from "${table}" t`);
    fingerprint[table] = result.rows[0]?.digest ?? "";
  }
  return fingerprint;
}

interface Harness {
  root: string;
  database: TestDatabaseHandle;
  app: AppContext;
  cookies: Record<AccountRole, string>;
  ids: Record<AccountRole, number>;
}

function cookieFrom(headers: Record<string, unknown>): string {
  return String(headers["set-cookie"]).split(";")[0]!;
}

async function send(harness: Harness, cookie: string, method: Method, url: string, payload?: unknown) {
  return harness.app.app.inject({ method, url, headers: { cookie }, ...(payload === undefined ? {} : { payload: payload as object }) });
}

async function signIn(app: AppContext, username: string, password: string) {
  return app.app.inject({ method: "POST", url: "/api/auth/login", remoteAddress: nextAddress(), payload: { username, password } });
}

/** Signs in with a temporary password and replaces it, as a new account has to. */
async function firstSignIn(app: AppContext, username: string, temporary = temporaryPassword): Promise<string> {
  const login = await signIn(app, username, temporary);
  expect(login.statusCode).toBe(200);
  const change = await app.app.inject({
    method: "PUT",
    url: "/api/auth/user",
    headers: { cookie: cookieFrom(login.headers) },
    payload: { username, currentPassword: temporary, newPassword: finalPassword(username), confirmNewPassword: finalPassword(username) }
  });
  expect(change.statusCode).toBe(200);
  return cookieFrom(change.headers);
}

async function startHarness(options: { apiDocsEnabled?: boolean } = {}): Promise<Harness> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "srtl-roles-"));
  for (const folder of ["links", "local", "remote"]) await fs.mkdir(path.join(root, folder), { recursive: true });
  const database = await createTestDatabase();
  const app = await createApp({
    rootDir: root,
    dataDir: path.join(root, "data"),
    databaseUrl: database.databaseUrl,
    autoMigrate: true,
    anonymousRequestsPerMinute: 100_000,
    paths: { symlinkDir: path.join(root, "links"), localDir: path.join(root, "local"), remoteDir: path.join(root, "remote") },
    ...(options.apiDocsEnabled ? { apiDocsEnabled: true } : {})
  });
  app.app.log.level = "silent";
  await markOnboardingCompleteForExistingInstall(app.database.db);
  const setup = await app.app.inject({ method: "POST", url: "/api/auth/setup", payload: { setupToken: readSetupToken(app), username: "the-owner", password: ownerPassword, confirmPassword: ownerPassword } });
  expect(setup.statusCode).toBe(200);
  const owner = cookieFrom(setup.headers);
  const ownerMe = await app.app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie: owner } });
  const ids = { owner: ownerMe.json<{ user: { id: number } }>().user.id, admin: 0, moderator: 0 };
  const cookies = { owner, admin: "", moderator: "" };
  for (const role of ["admin", "moderator"] as const) {
    const created = await app.app.inject({ method: "POST", url: "/api/accounts", headers: { cookie: owner }, payload: { username: roleUsers[role], role, temporaryPassword } });
    expect(created.statusCode).toBe(201);
    ids[role] = created.json<{ id: number }>().id;
    cookies[role] = await firstSignIn(app, roleUsers[role]);
  }
  return { root, database, app, cookies, ids };
}

async function stopHarness(harness: Harness | undefined): Promise<void> {
  if (!harness) return;
  await harness.app.app.close();
  await harness.database.cleanup();
  await fs.rm(harness.root, { recursive: true, force: true });
}

async function createAccount(harness: Harness, username: string, role: AccountRole, actor: AccountRole = "owner"): Promise<number> {
  const created = await send(harness, harness.cookies[actor], "POST", "/api/accounts", { username, role, temporaryPassword });
  expect(created.statusCode).toBe(201);
  return created.json<{ id: number }>().id;
}

/** Any IP address in a response, found independently of the scrubbing it is checking. */
function addressesIn(text: string): string[] {
  const dotted = text.match(/\d{1,3}(?:\.\d{1,3}){3}/g) ?? [];
  const colons = text.match(/[0-9a-fA-F:.]*:[0-9a-fA-F:.]*/g) ?? [];
  return [...dotted, ...colons.map((token) => token.replace(/[:.]+$/, ""))].filter((token) => isIP(token) !== 0);
}

const everyRole = ["owner", "admin", "moderator"] as const;
const adminsAndUp = ["owner", "admin"] as const;

/**
 * The approved permissions table, row by row, against real routes. `allowed`
 * means the request got past access control: it may still be turned down for
 * another reason, such as a missing title.
 */
const approvedTable: Array<{ row: string; allowed: readonly AccountRole[]; requests: Array<[Method, string, unknown?]> }> = [
  { row: "See library, jobs and Now Playing", allowed: everyRole, requests: [["GET", "/api/media-links/page"], ["GET", "/api/sections"], ["GET", "/api/inventory/summary"], ["GET", "/api/jobs"], ["GET", "/api/jobs/1/events"], ["GET", "/api/jobs/1/copy-retry"], ["GET", "/api/now-playing/settings"], ["GET", "/api/now-playing/poster/abcdefghijklmnopqrstuvwxyz012345"]] },
  { row: "Run scans, retry jobs", allowed: everyRole, requests: [["POST", "/api/scans", { scanSymlinks: true }], ["POST", "/api/audits", { mode: "fast" }], ["POST", "/api/jobs/999999/terminate"], ["POST", "/api/job-reconciliation/recheck"]] },
  { row: "Copy titles to local", allowed: everyRole, requests: [["POST", "/api/copies", { direction: "to_local", linkIds: [999_999] }], ["POST", "/api/copies/conflicts", { direction: "to_local", linkIds: [999_999] }], ["POST", "/api/jobs/999999/copy-retry", {}]] },
  {
    row: "Purge, delete, orphan cleanup",
    allowed: adminsAndUp,
    requests: [
      ["GET", "/api/orphans?rootType=local"],
      ["GET", "/api/orphans/held"],
      ["POST", "/api/orphans/purge", { rootType: "local", storageFileIds: [999_999], mode: "hold" }],
      ["POST", "/api/orphans/held/restore", { operationIds: [999_999] }],
      ["POST", "/api/damaged-files/delete", { storageFileIds: [999_999], mode: "hold" }],
      ["GET", "/api/re-requests"],
      ["POST", "/api/re-requests/preview", { storageFileIds: [999_999] }],
      ["POST", "/api/re-requests/retry", { ids: [999_999] }],
      ["POST", "/api/jobs/999999/copy-failures/remove-symlinks", { mediaLinkIds: [1] }],
      ["GET", "/api/job-reconciliation/999999/discard-partial-copy"],
      ["POST", "/api/job-reconciliation/999999/discard-partial-copy", { tempPath: "/tmp/x", tempSizeBytes: 0 }],
      // Replacing the file already at the destination removes it.
      ["POST", "/api/copies", { direction: "to_local", linkIds: [999_999], localConflictStrategy: "replace" }]
    ]
  },
  {
    row: "Settings, connections, API keys, paths, backups",
    allowed: adminsAndUp,
    requests: [
      ["GET", "/api/settings/paths"],
      ["PUT", "/api/settings/scan", { scanSymlinks: true }],
      ["PUT", "/api/settings/advanced", {}],
      ["PUT", "/api/settings/sections", {}],
      ["PUT", "/api/settings/storage-locations", {}],
      ["GET", "/api/settings/radarr"],
      ["GET", "/api/settings/sonarr"],
      ["GET", "/api/media-servers"],
      ["GET", "/api/settings/watch-sync"],
      ["GET", "/api/backups"],
      ["PUT", "/api/backups/settings", {}],
      ["POST", "/api/system/path-migration/plan", {}],
      ["PUT", "/api/now-playing/settings", { geoLookup: false }]
    ]
  },
  { row: "Manage moderators", allowed: adminsAndUp, requests: [["GET", "/api/accounts"], ["POST", "/api/accounts", { username: "", role: "moderator", temporaryPassword: "x" }]] }
];

describe("roles and the permissions table", () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await startHarness({ apiDocsEnabled: true });
  }, 120_000);

  afterAll(async () => {
    await stopHarness(harness);
  });

  it("gives every route an entry in the access table, and no entry outlives its route", () => {
    const missing: string[] = [];
    for (const route of harness.app.routes) {
      if (route.method === "OPTIONS") continue;
      if (!routeTableEntry({ method: route.method as "GET", url: route.url })) missing.push(`${route.method} ${route.url}`);
    }
    expect(missing).toEqual([]);
    const registered = new Set(harness.app.routes.map((route) => `${route.method} ${route.url}`));
    const stale = routeTableEntries.flatMap((entry) => entry.methods.map((method) => `${method} ${entry.url}`)).filter((route) => !registered.has(route));
    // The app shell's route exists only when a client build is present.
    expect(stale.filter((route) => route !== "GET /*")).toEqual([]);
  });

  it("refuses a route with no table entry for every role", async () => {
    const lateRoot = await startLateRoute();
    for (const cookie of [lateRoot.cookie]) {
      const response = await lateRoot.app.app.inject({ method: "GET", url: "/api/test/unlisted", headers: { cookie } });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ code: "forbidden" });
      expect(response.body).not.toContain("should not run");
    }
    await lateRoot.stop();
  }, 60_000);

  it.each(approvedTable.flatMap((row) => everyRole.map((role) => ({ row: row.row, role, allowed: row.allowed.includes(role), requests: row.requests }))))("$row: $role", async ({ role, allowed, requests }) => {
    for (const [method, url, payload] of requests) {
      const response = await send(harness, harness.cookies[role], method, url, payload);
      if (allowed) expect(response.statusCode, `${role} ${method} ${url}: ${response.body}`).not.toBe(403);
      else {
        expect(response.statusCode, `${role} ${method} ${url}: ${response.body}`).toBe(403);
        expect(response.json()).toMatchObject({ code: "forbidden" });
      }
    }
  });

  it("lets moderators copy only to local", async () => {
    const remote = await send(harness, harness.cookies.moderator, "POST", "/api/copies", { direction: "to_remote", linkIds: [999_999] });
    expect(remote.statusCode).toBe(403);
    const preview = await send(harness, harness.cookies.moderator, "POST", "/api/copies/conflicts", { direction: "to_remote", linkIds: [999_999] });
    expect(preview.statusCode).toBe(403);
    for (const role of adminsAndUp) {
      expect((await send(harness, harness.cookies[role], "POST", "/api/copies", { direction: "to_remote", linkIds: [999_999] })).statusCode).not.toBe(403);
    }
  });

  it("defines the invitation permission for all three roles without any route using it yet", () => {
    for (const role of everyRole) expect(roleHasPermission(role, "invites.manage")).toBe(true);
    expect(routeTableEntries.filter((entry) => entry.permission === "invites.manage")).toEqual([]);
  });

  it("matches the approved table in the shared definition", () => {
    const table: Array<[Permission, boolean, boolean, boolean]> = [
      ["library.view", true, true, true],
      ["jobs.run", true, true, true],
      ["copies.to_local", true, true, true],
      ["invites.manage", true, true, true],
      ["library.delete", true, true, false],
      ["settings.manage", true, true, false],
      ["moderators.manage", true, true, false],
      ["admins.manage", true, false, false],
      ["ownership.transfer", true, false, false]
    ];
    for (const [permission, owner, admin, moderator] of table) {
      expect([permission, rolePermissions.owner.has(permission), rolePermissions.admin.has(permission), rolePermissions.moderator.has(permission)]).toEqual([permission, owner, admin, moderator]);
    }
    expect(manageableRoles("owner")).toEqual(["admin", "moderator"]);
    expect(manageableRoles("admin")).toEqual(["moderator"]);
    expect(manageableRoles("moderator")).toEqual([]);
    for (const role of accountRoles) expect(canManageRole(role, "owner")).toBe(false);
  });

  it("refuses every route a role lacks, across the whole table, and writes nothing", async () => {
    const before = await databaseFingerprint(harness.app);
    const failures: string[] = [];
    for (const role of everyRole) {
      for (const route of harness.app.routes) {
        if (route.method === "OPTIONS") continue;
        const entry = routeTableEntry({ method: route.method as "GET", url: route.url });
        if (!entry?.permission || roleHasPermission(role, entry.permission)) continue;
        const response = await send(harness, harness.cookies[role], route.method as Method, concreteUrl(route.url), route.method === "GET" || route.method === "HEAD" ? undefined : {});
        if (response.statusCode !== 403) failures.push(`${role} ${route.method} ${route.url}: ${response.statusCode}`);
      }
    }
    expect(failures).toEqual([]);
    expect(await databaseFingerprint(harness.app)).toEqual(before);
  }, 60_000);

  it("keeps webhooks on their own authentication with no role", async () => {
    for (const url of ["/api/integrations/radarr/webhook", "/api/integrations/radarr/some-instance/webhook", "/api/integrations/sonarr/some-instance/webhook"]) {
      const entry = routeTableEntry({ method: "POST", url: url.includes("some-instance") ? url.replace("some-instance", ":instanceId") : url });
      expect(entry).toMatchObject({ auth: "webhook" });
      expect(entry?.permission).toBeUndefined();
      // A session of any role is no substitute for the webhook secret.
      expect((await send(harness, harness.cookies.owner, "POST", url, {})).statusCode).toBe(401);
    }
  });

  async function startLateRoute() {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "srtl-roles-late-"));
    for (const folder of ["links", "local", "remote"]) await fs.mkdir(path.join(root, folder), { recursive: true });
    const database = await createTestDatabase();
    const app = await createApp({ rootDir: root, dataDir: path.join(root, "data"), databaseUrl: database.databaseUrl, autoMigrate: true, paths: { symlinkDir: path.join(root, "links"), localDir: path.join(root, "local"), remoteDir: path.join(root, "remote") } });
    app.app.log.level = "silent";
    app.app.get("/api/test/unlisted", async () => ({ result: "should not run" }));
    await markOnboardingCompleteForExistingInstall(app.database.db);
    const setup = await app.app.inject({ method: "POST", url: "/api/auth/setup", payload: { setupToken: readSetupToken(app), username: "late-owner", password: ownerPassword, confirmPassword: ownerPassword } });
    return {
      app,
      cookie: cookieFrom(setup.headers),
      stop: async () => {
        await app.app.close();
        await database.cleanup();
        await fs.rm(root, { recursive: true, force: true });
      }
    };
  }
});

describe("managing accounts", () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await startHarness();
  }, 120_000);

  afterEach(async () => {
    await stopHarness(harness);
  });

  it("only allows creating roles below your own", async () => {
    const attempts: Array<[AccountRole, AccountRole, boolean]> = [
      ["owner", "admin", true],
      ["owner", "moderator", true],
      ["owner", "owner", false],
      ["admin", "moderator", true],
      ["admin", "admin", false],
      ["admin", "owner", false],
      ["moderator", "moderator", false],
      ["moderator", "admin", false],
      ["moderator", "owner", false]
    ];
    let counter = 0;
    for (const [actor, role, allowed] of attempts) {
      counter += 1;
      const response = await send(harness, harness.cookies[actor], "POST", "/api/accounts", { username: `new-${counter}`, role, temporaryPassword });
      expect(response.statusCode, `${actor} creating ${role}`).toBe(allowed ? 201 : 403);
    }
  });

  it("applies the password rules and refuses a duplicate username in any letter case", async () => {
    const short = await send(harness, harness.cookies.owner, "POST", "/api/accounts", { username: "short-password", role: "moderator", temporaryPassword: "too-short" });
    expect(short.statusCode).toBe(400);
    const taken = await send(harness, harness.cookies.owner, "POST", "/api/accounts", { username: roleUsers.moderator.toUpperCase(), role: "moderator", temporaryPassword });
    expect(taken.statusCode).toBe(409);
  });

  it("makes a temporary password useless for anything but replacing it", async () => {
    await createAccount(harness, "brand-new", "moderator");
    const login = await signIn(harness.app, "brand-new", temporaryPassword);
    const cookie = cookieFrom(login.headers);
    const me = await send(harness, cookie, "GET", "/api/auth/me");
    expect(me.json()).toMatchObject({ user: { role: "moderator", mustChangePassword: true } });
    for (const [method, url] of [["GET", "/api/jobs"], ["GET", "/api/auth/sessions"], ["GET", "/api/settings/user-preferences"], ["POST", "/api/scans"]] as const) {
      const refused = await send(harness, cookie, method, url, method === "POST" ? {} : undefined);
      expect(refused.statusCode).toBe(403);
      expect(refused.json()).toMatchObject({ code: "password_change_required" });
    }
    const unchanged = await send(harness, cookie, "PUT", "/api/auth/user", { username: "brand-new", currentPassword: temporaryPassword });
    expect(unchanged.statusCode).toBe(400);
    const same = await send(harness, cookie, "PUT", "/api/auth/user", { username: "brand-new", currentPassword: temporaryPassword, newPassword: temporaryPassword, confirmNewPassword: temporaryPassword });
    expect(same.statusCode).toBe(400);
    const tooShort = await send(harness, cookie, "PUT", "/api/auth/user", { username: "brand-new", currentPassword: temporaryPassword, newPassword: "short", confirmNewPassword: "short" });
    expect(tooShort.statusCode).toBe(400);
    // Past the per-address limit on this route, which the attempts above have used up.
    const changed = await harness.app.app.inject({ method: "PUT", url: "/api/auth/user", remoteAddress: nextAddress(), headers: { cookie }, payload: { username: "brand-new", currentPassword: temporaryPassword, newPassword: "a-new-long-password", confirmNewPassword: "a-new-long-password" } });
    expect(changed.statusCode).toBe(200);
    const fresh = cookieFrom(changed.headers);
    expect((await send(harness, fresh, "GET", "/api/jobs")).statusCode).toBe(200);
    expect((await send(harness, fresh, "GET", "/api/auth/me")).json()).toMatchObject({ user: { mustChangePassword: false } });
    expect((await send(harness, cookie, "GET", "/api/auth/me")).json()).toMatchObject({ authenticated: false });
    expect((await signIn(harness.app, "brand-new", temporaryPassword)).statusCode).toBe(401);
  });

  it("stops anyone raising their own role or touching their own access", async () => {
    for (const role of ["admin", "moderator"] as const) {
      const self = harness.ids[role];
      const cookie = harness.cookies[role];
      for (const target of ["owner", "admin", "moderator"] as const) {
        expect((await send(harness, cookie, "PUT", `/api/accounts/${self}/role`, { role: target })).statusCode, `${role} to ${target}`).toBe(403);
      }
      expect((await send(harness, cookie, "POST", `/api/accounts/${self}/disable`)).statusCode).toBe(403);
      expect((await send(harness, cookie, "DELETE", `/api/accounts/${self}`)).statusCode).toBe(403);
      expect((await send(harness, cookie, "POST", `/api/accounts/${self}/reset-password`, { temporaryPassword })).statusCode).toBe(403);
    }
    const owner = harness.ids.owner;
    expect((await send(harness, harness.cookies.owner, "PUT", `/api/accounts/${owner}/role`, { role: "admin" })).statusCode).toBe(403);
    expect((await send(harness, harness.cookies.owner, "POST", `/api/accounts/${owner}/disable`)).statusCode).toBe(403);
    expect((await send(harness, harness.cookies.owner, "DELETE", `/api/accounts/${owner}`)).statusCode).toBe(403);
  });

  it("stops anyone managing a role at or above their own, except the owner managing admins", async () => {
    const peerAdmin = await createAccount(harness, "peer-admin", "admin");
    const peerModerator = await createAccount(harness, "peer-moderator", "moderator");
    const checks: Array<[AccountRole, number, boolean]> = [
      ["admin", harness.ids.owner, false],
      ["admin", peerAdmin, false],
      ["admin", peerModerator, true],
      ["moderator", harness.ids.owner, false],
      ["moderator", peerAdmin, false],
      ["moderator", peerModerator, false],
      ["owner", peerAdmin, true],
      ["owner", peerModerator, true]
    ];
    for (const [actor, target, allowed] of checks) {
      const cookie = harness.cookies[actor];
      const expected = allowed ? 200 : 403;
      expect((await send(harness, cookie, "POST", `/api/accounts/${target}/reset-password`, { temporaryPassword })).statusCode, `${actor} reset ${target}`).toBe(expected);
      expect((await send(harness, cookie, "POST", `/api/accounts/${target}/disable`)).statusCode, `${actor} disable ${target}`).toBe(expected);
      expect((await send(harness, cookie, "POST", `/api/accounts/${target}/enable`)).statusCode, `${actor} enable ${target}`).toBe(expected);
    }
    // An admin cannot promote a moderator to their own level, and nobody can grant ownership by editing a role.
    expect((await send(harness, harness.cookies.admin, "PUT", `/api/accounts/${peerModerator}/role`, { role: "admin" })).statusCode).toBe(403);
    expect((await send(harness, harness.cookies.owner, "PUT", `/api/accounts/${peerModerator}/role`, { role: "owner" })).statusCode).toBe(403);
    expect((await send(harness, harness.cookies.owner, "PUT", `/api/accounts/${peerModerator}/role`, { role: "admin" })).statusCode).toBe(200);
    expect((await send(harness, harness.cookies.owner, "PUT", `/api/accounts/${peerModerator}/role`, { role: "moderator" })).statusCode).toBe(200);
    // Deleting comes last because it cannot be repeated.
    expect((await send(harness, harness.cookies.moderator, "DELETE", `/api/accounts/${peerModerator}`)).statusCode).toBe(403);
    expect((await send(harness, harness.cookies.admin, "DELETE", `/api/accounts/${peerAdmin}`)).statusCode).toBe(403);
    expect((await send(harness, harness.cookies.admin, "DELETE", `/api/accounts/${peerModerator}`)).statusCode).toBe(200);
    expect((await send(harness, harness.cookies.owner, "DELETE", `/api/accounts/${peerAdmin}`)).statusCode).toBe(200);
  });

  it("re-reads the actor's role, so someone just demoted cannot finish a change", async () => {
    const victim = await createAccount(harness, "victim", "moderator");
    expect((await send(harness, harness.cookies.owner, "PUT", `/api/accounts/${harness.ids.admin}/role`, { role: "moderator" })).statusCode).toBe(200);
    expect((await send(harness, harness.cookies.admin, "POST", `/api/accounts/${victim}/disable`)).statusCode).toBe(403);
  });

  it("does not reveal which usernames exist or which are disabled at sign-in", async () => {
    await createAccount(harness, "soon-disabled", "moderator");
    const target = await first(harness.app.database.db.select().from(schema.adminUsers).where(eq(schema.adminUsers.username, "soon-disabled")).limit(1));
    await send(harness, harness.cookies.owner, "POST", `/api/accounts/${target!.id}/disable`);
    const disabled = await signIn(harness.app, "soon-disabled", temporaryPassword);
    const wrong = await signIn(harness.app, roleUsers.moderator, "not-the-password-1");
    const unknown = await signIn(harness.app, "nobody-by-this-name", "not-the-password-1");
    expect(disabled.statusCode).toBe(401);
    expect(disabled.body).toBe(wrong.body);
    expect(wrong.body).toBe(unknown.body);
    expect(wrong.statusCode).toBe(unknown.statusCode);
  });

  it("applies sign-in lockouts to every account, without locking it out from other addresses", async () => {
    const addresses = Array.from({ length: 11 }, () => nextAddress());
    for (const address of addresses) {
      const failed = await harness.app.app.inject({ method: "POST", url: "/api/auth/login", remoteAddress: address, payload: { username: roleUsers.moderator, password: "not-the-password-1" } });
      expect(failed.statusCode).toBe(401);
    }
    const locked = await harness.app.app.inject({ method: "POST", url: "/api/auth/login", remoteAddress: addresses.at(-1)!, payload: { username: roleUsers.moderator, password: finalPassword(roleUsers.moderator) } });
    expect(locked.statusCode).toBe(429);
    expect(locked.json()).toMatchObject({ code: "sign_in_locked" });
    expect((await signIn(harness.app, roleUsers.moderator, finalPassword(roleUsers.moderator))).statusCode).toBe(200);
  });

  it("writes every account change to the security activity and action audit, naming who did it", async () => {
    const id = await createAccount(harness, "audited", "moderator");
    await send(harness, harness.cookies.owner, "PUT", `/api/accounts/${id}/role`, { role: "admin" });
    await send(harness, harness.cookies.owner, "POST", `/api/accounts/${id}/disable`);
    await send(harness, harness.cookies.owner, "POST", `/api/accounts/${id}/enable`);
    await send(harness, harness.cookies.owner, "POST", `/api/accounts/${id}/reset-password`, { temporaryPassword: "another-temporary-1" });
    await send(harness, harness.cookies.owner, "DELETE", `/api/accounts/${id}`);
    await send(harness, harness.cookies.owner, "POST", "/api/accounts/transfer-ownership", { targetId: harness.ids.admin, currentPassword: "wrong-password-1234" });
    await send(harness, harness.cookies.owner, "POST", "/api/accounts/transfer-ownership", { targetId: harness.ids.admin, currentPassword: ownerPassword });

    const events = (await send(harness, harness.cookies.owner, "GET", "/api/auth/security-events?limit=200")).json<{ events: Array<{ event: string; username: string; details: Record<string, unknown> }> }>().events;
    const byOwner = events.filter((event) => event.username === "the-owner" && event.details.target === "audited").map((event) => event.event);
    expect(byOwner).toEqual(expect.arrayContaining(["account_created", "account_role_changed", "account_disabled", "account_enabled", "account_password_reset", "account_deleted"]));
    expect(events.find((event) => event.event === "account_role_changed" && event.details.target === "audited")?.details).toMatchObject({ from: "moderator", to: "admin" });
    expect(events.find((event) => event.event === "ownership_transferred")).toMatchObject({ username: "the-owner", details: { target: roleUsers.admin } });
    expect(events.find((event) => event.event === "reauthentication_failed")?.details).toMatchObject({ action: "transfer_ownership" });
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain(temporaryPassword);
    expect(serialized).not.toContain("another-temporary-1");

    const audit = (await send(harness, harness.cookies.admin, "GET", "/api/system/action-audit")).json<Array<{ action: string; actor: { username: string } }>>();
    expect(audit.filter((entry) => entry.action.startsWith("account.")).length).toBeGreaterThanOrEqual(7);
    expect(audit.find((entry) => entry.action === "account.ownership_transfer")?.actor.username).toBe("the-owner");

    const list = (await send(harness, harness.cookies.admin, "GET", "/api/accounts")).json<{ accounts: Array<{ username: string; createdBy: string | null; role: string }>; activity: Array<{ event: string }> }>();
    expect(list.accounts.find((account) => account.username === roleUsers.moderator)?.createdBy).toBe("the-owner");
    expect(list.activity.map((event) => event.event)).toContain("ownership_transferred");
    expect(JSON.stringify(list)).not.toMatch(/passwordHash|password_hash|scrypt/);
  });

  it("keeps display preferences per account", async () => {
    const preferences = { timeFormat: "24h", autoOpenTaskStatus: true, recentJobsCompletedWindowMinutes: 60 };
    expect((await send(harness, harness.cookies.moderator, "PUT", "/api/settings/user-preferences", preferences)).json()).toMatchObject(preferences);
    expect((await send(harness, harness.cookies.moderator, "GET", "/api/settings/user-preferences")).json()).toMatchObject(preferences);
    expect((await send(harness, harness.cookies.owner, "GET", "/api/settings/user-preferences")).json()).toMatchObject({ timeFormat: "12h" });
  });
});

describe("what changes reach open sessions", () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await startHarness();
  }, 120_000);

  afterEach(async () => {
    await stopHarness(harness);
  });

  it("applies a role change to the next request on an open session", async () => {
    expect((await send(harness, harness.cookies.admin, "GET", "/api/settings/paths")).statusCode).toBe(200);
    await send(harness, harness.cookies.owner, "PUT", `/api/accounts/${harness.ids.admin}/role`, { role: "moderator" });
    expect((await send(harness, harness.cookies.admin, "GET", "/api/settings/paths")).statusCode).toBe(403);
    expect((await send(harness, harness.cookies.admin, "GET", "/api/auth/me")).json()).toMatchObject({ user: { role: "moderator" } });
    await send(harness, harness.cookies.owner, "PUT", `/api/accounts/${harness.ids.moderator}/role`, { role: "admin" });
    expect((await send(harness, harness.cookies.moderator, "GET", "/api/settings/paths")).statusCode).toBe(200);
  });

  it.each([
    ["disabling", "POST", "disable", undefined],
    ["deleting", "DELETE", "", undefined],
    ["resetting the password of", "POST", "reset-password", { temporaryPassword: "another-temporary-1" }]
  ] as const)("ends every session on %s an account", async (_label, method, action, payload) => {
    const second = cookieFrom((await signIn(harness.app, roleUsers.moderator, finalPassword(roleUsers.moderator))).headers);
    expect((await send(harness, second, "GET", "/api/jobs")).statusCode).toBe(200);
    const response = await send(harness, harness.cookies.owner, method, `/api/accounts/${harness.ids.moderator}${action ? `/${action}` : ""}`, payload);
    expect(response.statusCode).toBe(200);
    for (const cookie of [harness.cookies.moderator, second]) {
      expect((await send(harness, cookie, "GET", "/api/jobs")).statusCode).toBe(401);
      expect((await send(harness, cookie, "GET", "/api/auth/me")).json()).toMatchObject({ authenticated: false });
    }
    expect((await harness.app.database.pool.query("select 1 from sessions where user_id = $1", [harness.ids.moderator])).rowCount).toBe(0);
  });

  it("refuses a disabled account's old cookie and new sign-ins, then lets it back in when enabled", async () => {
    await send(harness, harness.cookies.owner, "POST", `/api/accounts/${harness.ids.moderator}/disable`);
    expect((await signIn(harness.app, roleUsers.moderator, finalPassword(roleUsers.moderator))).statusCode).toBe(401);
    await send(harness, harness.cookies.owner, "POST", `/api/accounts/${harness.ids.moderator}/enable`);
    const login = await signIn(harness.app, roleUsers.moderator, finalPassword(roleUsers.moderator));
    expect(login.statusCode).toBe(200);
    expect((await send(harness, cookieFrom(login.headers), "GET", "/api/jobs")).statusCode).toBe(200);
  });

  it("makes a reset password one that must be changed", async () => {
    await send(harness, harness.cookies.owner, "POST", `/api/accounts/${harness.ids.moderator}/reset-password`, { temporaryPassword: "another-temporary-1" });
    expect((await signIn(harness.app, roleUsers.moderator, finalPassword(roleUsers.moderator))).statusCode).toBe(401);
    const login = await signIn(harness.app, roleUsers.moderator, "another-temporary-1");
    expect((await send(harness, cookieFrom(login.headers), "GET", "/api/jobs")).json()).toMatchObject({ code: "password_change_required" });
  });

  it("decides again when a slow request's body arrives", async () => {
    await harness.app.app.listen({ port: 0, host: "127.0.0.1" });
    const address = harness.app.app.server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const body = JSON.stringify({ geoLookup: false });
    const heldRequest = async (cookie: string) => {
      const socket = net.connect(port, "127.0.0.1");
      let received = "";
      socket.on("data", (chunk) => { received += String(chunk); });
      const closed = new Promise<void>((resolve) => socket.on("close", () => resolve()));
      socket.write(`PUT /api/now-playing/settings HTTP/1.1\r\nHost: 127.0.0.1\r\nCookie: ${cookie}\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n`);
      await new Promise((resolve) => setTimeout(resolve, 300));
      return async () => {
        socket.write(body);
        await closed;
        return Number(received.split(" ")[1]);
      };
    };
    const demoted = await heldRequest(harness.cookies.admin);
    await send(harness, harness.cookies.owner, "PUT", `/api/accounts/${harness.ids.admin}/role`, { role: "moderator" });
    expect(await demoted()).toBe(403);
    const secondAdmin = await createAccount(harness, "second-admin", "admin");
    const cookie = await firstSignIn(harness.app, "second-admin");
    const disabled = await heldRequest(cookie);
    await send(harness, harness.cookies.owner, "POST", `/api/accounts/${secondAdmin}/disable`);
    expect(await disabled()).toBe(401);
    expect((await send(harness, harness.cookies.owner, "GET", "/api/now-playing/settings")).json()).toMatchObject({ geoLookup: true });
  });

  it("rotates the session on a username change and keeps the new one working", async () => {
    const renamed = await send(harness, harness.cookies.moderator, "PUT", "/api/auth/user", { username: "renamed-moderator", currentPassword: finalPassword(roleUsers.moderator) });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json()).toMatchObject({ user: { username: "renamed-moderator", role: "moderator", mustChangePassword: false } });
    expect((await send(harness, harness.cookies.moderator, "GET", "/api/auth/me")).json()).toMatchObject({ authenticated: false });
    expect((await send(harness, cookieFrom(renamed.headers), "GET", "/api/auth/me")).json()).toMatchObject({ user: { username: "renamed-moderator" } });
  });

  it("closes an open Now Playing stream the moment the account changes", async () => {
    await harness.app.app.listen({ port: 0, host: "127.0.0.1" });
    const address = harness.app.app.server.address();
    const base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
    const openStream = async (cookie: string) => {
      const response = await fetch(`${base}/api/now-playing/events`, { headers: { cookie } });
      expect(response.status).toBe(200);
      const reader = response.body!.getReader();
      await reader.read();
      return async () => {
        const started = Date.now();
        for (;;) {
          const { done } = await reader.read();
          if (done) return Date.now() - started;
        }
      };
    };
    const untilClosed = await openStream(harness.cookies.moderator);
    await send(harness, harness.cookies.owner, "POST", `/api/accounts/${harness.ids.moderator}/disable`);
    expect(await untilClosed()).toBeLessThan(5_000);
    expect((await fetch(`${base}/api/now-playing/events`, { headers: { cookie: harness.cookies.moderator } })).status).toBe(401);
    const adminClosed = await openStream(harness.cookies.admin);
    await send(harness, harness.cookies.owner, "PUT", `/api/accounts/${harness.ids.admin}/role`, { role: "moderator" });
    expect(await adminClosed()).toBeLessThan(5_000);
  });
});

describe("ownership", () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await startHarness();
  }, 120_000);

  afterEach(async () => {
    await stopHarness(harness);
  });

  async function owners(): Promise<string[]> {
    return (await harness.app.database.pool.query<{ username: string }>("select username from admin_users where role = 'owner'")).rows.map((row) => row.username);
  }

  it("transfers with the password and leaves the old owner an admin", async () => {
    const wrong = await send(harness, harness.cookies.owner, "POST", "/api/accounts/transfer-ownership", { targetId: harness.ids.admin, currentPassword: "not-the-password-1" });
    expect(wrong.statusCode).toBe(401);
    expect(await owners()).toEqual(["the-owner"]);
    const done = await send(harness, harness.cookies.owner, "POST", "/api/accounts/transfer-ownership", { targetId: harness.ids.moderator, currentPassword: ownerPassword });
    expect(done.statusCode).toBe(200);
    expect(await owners()).toEqual([roleUsers.moderator]);
    expect((await send(harness, harness.cookies.owner, "GET", "/api/auth/me")).json()).toMatchObject({ authenticated: true, user: { role: "admin" } });
    expect((await send(harness, harness.cookies.moderator, "GET", "/api/auth/me")).json()).toMatchObject({ user: { role: "owner" } });
    expect((await send(harness, harness.cookies.owner, "POST", "/api/accounts/transfer-ownership", { targetId: harness.ids.admin, currentPassword: ownerPassword })).statusCode).toBe(403);
    expect((await send(harness, harness.cookies.moderator, "PUT", `/api/accounts/${harness.ids.owner}/role`, { role: "moderator" })).statusCode).toBe(200);
  });

  it("only the owner can transfer, and only to an enabled account with its own password", async () => {
    expect((await send(harness, harness.cookies.admin, "POST", "/api/accounts/transfer-ownership", { targetId: harness.ids.admin, currentPassword: finalPassword(roleUsers.admin) })).statusCode).toBe(403);
    expect((await send(harness, harness.cookies.moderator, "POST", "/api/accounts/transfer-ownership", { targetId: harness.ids.moderator, currentPassword: finalPassword(roleUsers.moderator) })).statusCode).toBe(403);
    expect((await send(harness, harness.cookies.owner, "POST", "/api/accounts/transfer-ownership", { targetId: harness.ids.owner, currentPassword: ownerPassword })).statusCode).toBe(400);
    const temporary = await createAccount(harness, "still-temporary", "admin");
    expect((await send(harness, harness.cookies.owner, "POST", "/api/accounts/transfer-ownership", { targetId: temporary, currentPassword: ownerPassword })).statusCode).toBe(409);
    await send(harness, harness.cookies.owner, "POST", `/api/accounts/${harness.ids.admin}/disable`);
    expect((await send(harness, harness.cookies.owner, "POST", "/api/accounts/transfer-ownership", { targetId: harness.ids.admin, currentPassword: ownerPassword })).statusCode).toBe(409);
    expect((await send(harness, harness.cookies.owner, "POST", "/api/accounts/transfer-ownership", { targetId: 999_999, currentPassword: ownerPassword })).statusCode).toBe(404);
    expect(await owners()).toEqual(["the-owner"]);
  });

  it("lets exactly one of several concurrent transfers win", async () => {
    const targets = [harness.ids.admin, harness.ids.moderator];
    for (let round = 0; round < 3; round += 1) {
      const name = `racer-${round}`;
      const id = await createAccount(harness, name, "admin");
      await firstSignIn(harness.app, name);
      targets.push(id);
    }
    const results = await Promise.all(targets.map((targetId) => send(harness, harness.cookies.owner, "POST", "/api/accounts/transfer-ownership", { targetId, currentPassword: ownerPassword })));
    const codes = results.map((result) => result.statusCode);
    expect(codes.filter((code) => code === 200)).toHaveLength(1);
    expect(codes.filter((code) => code !== 200).every((code) => code === 403)).toBe(true);
    expect(await owners()).toHaveLength(1);
    const roles = (await harness.app.database.pool.query<{ role: string; count: string }>("select role, count(*) from admin_users group by role")).rows;
    expect(roles.find((row) => row.role === "owner")?.count).toBe("1");
  });

  it("survives a transfer racing a role change or a delete of the same accounts", async () => {
    const results = await Promise.all([
      send(harness, harness.cookies.owner, "POST", "/api/accounts/transfer-ownership", { targetId: harness.ids.admin, currentPassword: ownerPassword }),
      send(harness, harness.cookies.owner, "DELETE", `/api/accounts/${harness.ids.admin}`),
      send(harness, harness.cookies.owner, "PUT", `/api/accounts/${harness.ids.admin}/role`, { role: "moderator" })
    ]);
    expect(results.every((result) => result.statusCode < 500), JSON.stringify(results.map((result) => [result.statusCode, result.body]))).toBe(true);
    expect(await owners()).toHaveLength(1);
  });

  it("holds exactly one owner in the database, whatever the code does", async () => {
    const pool = harness.app.database.pool;
    await expect(pool.query("update admin_users set role = 'owner' where username = $1", [roleUsers.admin])).rejects.toThrow(/single_owner/);
    await expect(pool.query("update admin_users set role = 'admin' where role = 'owner'")).rejects.toThrow(/exactly one owner/);
    await expect(pool.query("delete from admin_users where role = 'owner'")).rejects.toThrow(/exactly one owner/);
    await expect(pool.query("update admin_users set disabled_at = 'now' where role = 'owner'")).rejects.toThrow(/owner_enabled/);
    await expect(pool.query("insert into admin_users (username, password_hash, created_at, role) values ('second', 'x', 'now', 'owner')")).rejects.toThrow(/single_owner/);
    await expect(pool.query("update admin_users set role = 'superuser' where username = $1", [roleUsers.admin])).rejects.toThrow(/role_check/);
    await expect(pool.query("insert into admin_users (username, password_hash, created_at, role) values ($1, 'x', 'now', 'moderator')", [roleUsers.moderator.toUpperCase()])).rejects.toThrow(/username_lower/);
    expect(await owners()).toEqual(["the-owner"]);
  });

  it("refuses setup once an owner exists, with the same answer as a wrong token", async () => {
    const valid = await harness.app.app.inject({ method: "POST", url: "/api/auth/setup", payload: { setupToken: "x".repeat(32), username: "late", password: "password-12345", confirmPassword: "password-12345" } });
    expect(valid.statusCode).toBe(403);
    expect(valid.json()).toMatchObject({ code: "setup_unavailable" });
    expect((await send(harness, "", "GET", "/api/auth/me")).json()).toMatchObject({ setupRequired: false });
  });
});

describe("moving an existing install to roles", () => {
  it("turns the administrator into the owner, keeping their password and sessions", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "srtl-roles-migrate-"));
    for (const folder of ["links", "local", "remote"]) await fs.mkdir(path.join(root, folder), { recursive: true });
    const database = await createTestDatabase();
    const config = { rootDir: root, dataDir: path.join(root, "data"), databaseUrl: database.databaseUrl, autoMigrate: true, paths: { symlinkDir: path.join(root, "links"), localDir: path.join(root, "local"), remoteDir: path.join(root, "remote") } };
    let app = await createApp(config);
    app.app.log.level = "silent";
    await markOnboardingCompleteForExistingInstall(app.database.db);
    const setup = await app.app.inject({ method: "POST", url: "/api/auth/setup", payload: { setupToken: readSetupToken(app), username: "long-time-admin", password: "password-1234", confirmPassword: "password-1234" } });
    const cookie = cookieFrom(setup.headers);
    // Back to the schema of the release before roles.
    const pool = app.database.pool;
    await pool.query("drop trigger admin_users_one_owner on admin_users");
    await pool.query("drop function admin_users_require_one_owner()");
    await pool.query("drop index admin_users_single_owner_idx");
    await pool.query("drop index admin_users_username_lower_idx");
    await pool.query("alter table admin_users drop column role, drop column must_change_password, drop column created_by, drop column disabled_at, drop column disabled_by, drop column last_sign_in_at");
    await pool.query("delete from schema_migrations where version = 28");
    await pool.query("create unique index admin_users_singleton_idx on admin_users ((true))");
    const before = await pool.query<{ password_hash: string }>("select password_hash from admin_users where username = 'long-time-admin'");
    await app.app.close();

    app = await createApp(config);
    app.app.log.level = "silent";
    try {
      const rows = await app.database.pool.query<{ username: string; role: string; password_hash: string; must_change_password: boolean }>("select username, role, password_hash, must_change_password from admin_users order by id");
      expect(rows.rows.map((row) => [row.username, row.role, row.must_change_password])).toEqual([["long-time-admin", "owner", false]]);
      expect((await app.database.pool.query("select 1 from pg_indexes where indexname = 'admin_users_singleton_idx'")).rowCount).toBe(0);
      expect(rows.rows[0]?.password_hash).toBe(before.rows[0]?.password_hash);
      expect((await app.database.pool.query<{ name: string }>("select name from schema_migrations where version = 28")).rows[0]?.name).toBe("accounts_and_roles");
      // The session from before the migration still works, and it is now the owner's.
      const me = await app.app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie } });
      expect(me.json()).toMatchObject({ authenticated: true, user: { username: "long-time-admin", role: "owner", mustChangePassword: false } });
      expect((await app.app.inject({ method: "GET", url: "/api/settings/paths", headers: { cookie } })).statusCode).toBe(200);
      const login = await app.app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "long-time-admin", password: "password-1234" } });
      expect(login.statusCode).toBe(200);
    } finally {
      await app.app.close();
      await database.cleanup();
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 60_000);

  it("leaves an empty install waiting for setup, and makes the setup account the owner", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "srtl-roles-fresh-"));
    for (const folder of ["links", "local", "remote"]) await fs.mkdir(path.join(root, folder), { recursive: true });
    const database = await createTestDatabase();
    const app = await createApp({ rootDir: root, dataDir: path.join(root, "data"), databaseUrl: database.databaseUrl, autoMigrate: true, paths: { symlinkDir: path.join(root, "links"), localDir: path.join(root, "local"), remoteDir: path.join(root, "remote") } });
    app.app.log.level = "silent";
    try {
      expect((await app.app.inject({ method: "GET", url: "/api/auth/me" })).json()).toMatchObject({ setupRequired: true });
      const setup = await app.app.inject({ method: "POST", url: "/api/auth/setup", payload: { setupToken: readSetupToken(app), username: "first", password: "password-1234", confirmPassword: "password-1234" } });
      expect(setup.statusCode).toBe(200);
      expect((await app.app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie: cookieFrom(setup.headers) } })).json()).toMatchObject({ user: { username: "first", role: "owner", mustChangePassword: false } });
    } finally {
      await app.app.close();
      await database.cleanup();
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 60_000);
});


describe("what a moderator can read", () => {
  let harness: Harness;
  const secretToken = "planted-token-a1b2c3d4";
  const secretKey = "plantedapikey0123456789";
  const serverAddress = "https://media.internal.example:32400";
  const backupFolder = "/srv/planted-backups/database";
  let startedCopy = 0;
  const plantedLocation = {
    city: "Plantedville", region: "Planted Region", country: "Plantedland", countryCode: "PX", code: "keeps-this-one",
    latitude: 52.37123, longitude: 4.89456, lat: 52.37124, lon: 4.89457, lng: 4.89458, coordinates: [52.37125, 4.89459],
    isp: "Planted ISP", asn: "AS64512-planted", postalCode: "PLANTED-1", timeZone: "Planted/Zone", continent: "Plantedia",
    geo: { city: "Plantedgeo City", region: "Plantedgeo Region", country: "Plantedgeo Land", code: "PY" },
    viewerCity: "Plantedcamel City", client_country: "Plantedsnake Land", geoData: { label: "Plantedprefix Label" }
  };
  const plantedLocationValues = ["Plantedville", "Planted Region", "Plantedland", "PX", "52.3712", "4.8945", "Planted ISP", "AS64512", "PLANTED-1", "Planted/Zone", "Plantedia", "Plantedgeo", "Plantedcamel", "Plantedsnake", "Plantedprefix"];
  const locationFieldNames = /"(?:geo|city|region|country|countryCode|latitude|longitude|lat|lon|lng|coordinates|isp|asn|postalCode|timeZone|continent|viewerCity|client_country|geoData)":/;

  beforeAll(async () => {
    harness = await startHarness();
    const { db } = harness.app.database;
    const local = path.join(harness.root, "local");
    const remote = path.join(harness.root, "remote");
    const links = path.join(harness.root, "links");
    await persistSectionSettings(db, { sections: ["movies"] });
    await setSetting(db, "backupSettings", { enabled: true, time: "03:30", keep: 7, location: backupFolder });
    const now = new Date().toISOString();
    const link = await first(db.insert(schema.mediaLinks).values({
      section: "movies", itemName: "Planted Movie (2020)", relativePath: "Planted Movie (2020)/movie.mkv",
      linkPath: path.join(links, "movies/Planted Movie (2020)/movie.mkv"), targetPath: path.join(remote, "Planted Movie (2020)/movie.mkv"),
      kind: "remote", targetExists: true, isMedia: true, storagePolicy: "unassigned", sizeBytes: 10, firstSeenAt: now, lastSeenAt: now, lastChangedAt: now, missingSince: null, lastSeenJobId: 1, updatedAt: now
    }).returning({ id: schema.mediaLinks.id }));
    await db.insert(schema.storageFiles).values({
      rootType: "remote", rootPath: remote, section: "movies", itemName: "Planted Movie (2020)", relativePath: "Planted Movie (2020)/movie.mkv", filePath: path.join(remote, "Planted Movie (2020)/movie.mkv"),
      storagePolicy: "unassigned", sizeBytes: 10, mtimeMs: Date.now(), firstSeenAt: now, lastSeenAt: now, lastChangedAt: now, missingSince: null, lastSeenJobId: 1, updatedAt: now
    });
    const addJob = async (type: string, progress: unknown, options: unknown, message: string, data: unknown) => {
      const job = await first(db.insert(schema.jobs).values({ type, status: "failed", createdAt: now, startedAt: now, finishedAt: now, progress: JSON.stringify(progress), options: JSON.stringify(options) }).returning({ id: schema.jobs.id }));
      await db.insert(schema.jobEvents).values({ jobId: job!.id, timestamp: now, level: "error", message, data: JSON.stringify(data) });
      return job!.id;
    };
    // Library work whose log mentions roots, an address and a credential.
    await addJob(
      "copy",
      { sourcePath: path.join(remote, "Planted Movie (2020)/movie.mkv"), destinationPath: path.join(local, "Planted Movie (2020)/movie.mkv"), apiKey: secretKey },
      { direction: "to_local", linkIds: [link!.id] },
      `Copy failed reading ${path.join(remote, "Planted Movie (2020)/movie.mkv")} after calling ${serverAddress}/library?X-Plex-Token=${secretToken}`,
      { sourcePath: path.join(remote, "x.mkv"), url: `${serverAddress}/x`, token: secretToken, nested: { "X-Api-Key": secretKey, folder: "/mnt/not-a-known-root/deep/file.mkv" } }
    );
    await addJob("scan", {}, {}, `connect ECONNREFUSED 203.0.113.40:7878 while reading ${path.join(links, "movies")}`, {});
    // Addresses in every shape a log line or a data field might hold them.
    await addJob(
      "scan",
      { lastClient: "198.51.100.41", clientIp: "198.51.100.42", currentItem: "reading from 2001:db8::43" },
      {},
      `Refused by 198.51.100.44. Also 2001:db8::45: timed out, [2001:db8::46]:443, fe80::47%eth0, ::ffff:198.51.100.48 and 2001:0db8:0000:0000:0000:0000:0000:0049 (from ::1)`,
      { ip: "2001:db8::4a", remoteAddress: "198.51.100.50", addresses: ["198.51.100.51", "2001:db8::52"], note: "peer=198.51.100.53 peer6=2001:db8::54" }
    );
    // Location fields in every shape a job's data might hold them.
    await addJob("scan", plantedLocation, plantedLocation, "Finished looking up viewers", { ...plantedLocation, viewer: plantedLocation, viewers: [plantedLocation] });
    // What a real copy writes to its log about who started it, and from where.
    const started = await harness.app.app.inject({ method: "POST", url: "/api/copies", remoteAddress: "198.51.100.60", headers: { cookie: harness.cookies.admin }, payload: { direction: "to_local", linkIds: [link!.id] } });
    expect(started.statusCode, started.body).toBe(200);
    startedCopy = started.json<{ jobId: number }>().jobId;
    // This account's own sessions, signed in from addresses of both kinds.
    await harness.app.app.inject({ method: "POST", url: "/api/auth/login", remoteAddress: "198.51.100.61", payload: { username: roleUsers.moderator, password: finalPassword(roleUsers.moderator) } });
    await harness.app.app.inject({ method: "POST", url: "/api/auth/login", remoteAddress: "2001:db8::62", payload: { username: roleUsers.moderator, password: finalPassword(roleUsers.moderator) } });
    // Settings work, whose log is about the settings themselves.
    await addJob("backup", { location: backupFolder }, { location: backupFolder }, `Could not write to ${backupFolder}`, { location: backupFolder });
    await addJob("watch_sync", { server: serverAddress }, {}, `${serverAddress} refused the request`, {});
    await addJob("path_migration", { from: local }, {}, `Moving ${local} to /srv/planted-new-root`, {});
  }, 120_000);

  afterAll(async () => {
    await stopHarness(harness);
  });

  function plantedValues(): string[] {
    return [secretToken, secretKey, serverAddress, "media.internal.example", backupFolder, "planted-backups", "/srv/planted-new-root", "203.0.113.40", "not-a-known-root", path.join(harness.root, "local"), path.join(harness.root, "remote"), path.join(harness.root, "links"), harness.root];
  }

  async function everyReadableUrl(role: AccountRole): Promise<string[]> {
    const urls = new Set<string>();
    for (const route of harness.app.routes) {
      if (route.method !== "GET" || route.url === "/*" || route.url.startsWith("/api/health") || route.url === "/api/now-playing/events") continue;
      const entry = routeTableEntry({ method: "GET", url: route.url });
      if (!entry?.permission || !roleHasPermission(role, entry.permission)) continue;
      urls.add(route.url);
    }
    const jobs = (await send(harness, harness.cookies.owner, "GET", "/api/jobs")).json<Array<{ id: number }>>();
    const expanded: string[] = [];
    for (const url of urls) {
      if (url.includes(":id") && url.startsWith("/api/jobs")) expanded.push(...jobs.map((job) => url.replace(":id", String(job.id))));
      else expanded.push(url.replace(/:[A-Za-z]+/g, "1"));
    }
    return [
      ...expanded,
      "/api/media-links?status=all",
      "/api/media-links/page?status=all",
      "/api/media-links/tree?section=movies&prefix=Planted%20Movie%20(2020)",
      "/api/storage-files?rootType=remote",
      "/api/storage-files/tree?rootType=remote&prefix=Planted%20Movie%20(2020)",
      "/api/storage-policies/default-preview?section=movies"
    ];
  }

  it("never carries a root, address, credential or backup location on any route they can read", async () => {
    const urls = await everyReadableUrl("moderator");
    expect(urls.length).toBeGreaterThan(30);
    const leaks: string[] = [];
    const answered: string[] = [];
    for (const url of urls) {
      const response = await send(harness, harness.cookies.moderator, "GET", url);
      if (response.statusCode < 400) answered.push(url);
      for (const value of plantedValues()) if (response.body.includes(value)) leaks.push(`${url} carries ${value}`);
    }
    expect(leaks).toEqual([]);
    expect(answered).toEqual(expect.arrayContaining(["/api/jobs", "/api/media-links/page?status=all", "/api/damaged-files.csv", "/api/system/path-migration", "/api/onboarding", "/api/settings/storage-locations"]));
  });

  it("never carries an IP address on any route they can read, including IPv6 and free text", async () => {
    const found: string[] = [];
    const answered: string[] = [];
    for (const url of await everyReadableUrl("moderator")) {
      const response = await send(harness, harness.cookies.moderator, "GET", url);
      if (response.statusCode < 400) answered.push(url);
      for (const address of addressesIn(response.body)) found.push(`${url} carries ${address}`);
    }
    expect(found).toEqual([]);
    expect(answered).toEqual(expect.arrayContaining(["/api/jobs", "/api/auth/sessions", "/api/system/version"]));
  });

  it("never carries a viewer location on any route they can read", async () => {
    const found: string[] = [];
    for (const url of await everyReadableUrl("moderator")) {
      const { body } = await send(harness, harness.cookies.moderator, "GET", url);
      for (const value of plantedLocationValues) if (body.includes(value)) found.push(`${url} carries ${value}`);
      if (locationFieldNames.test(body)) found.push(`${url} has a location field: ${locationFieldNames.exec(body)?.[0]}`);
    }
    expect(found).toEqual([]);
    const seen = new Set<string>();
    for (const url of await everyReadableUrl("owner")) {
      const { body } = await send(harness, harness.cookies.owner, "GET", url);
      for (const value of plantedLocationValues) if (body.includes(value)) seen.add(value);
    }
    // The sweep can see what it is looking for: an owner's view of the same routes has all of it.
    expect([...seen].sort()).toEqual([...plantedLocationValues].sort());
  });

  it("the address sweep finds them for an owner, so it can see what it is looking for", async () => {
    const seen = new Set<string>();
    for (const url of await everyReadableUrl("owner")) {
      for (const address of addressesIn((await send(harness, harness.cookies.owner, "GET", url)).body)) seen.add(address);
    }
    expect([...seen]).toEqual(expect.arrayContaining(["198.51.100.41", "198.51.100.44", "2001:db8::45", "2001:db8::46", "::ffff:198.51.100.48", "198.51.100.60"]));
  });

  it("keeps the rest of a job log line, with the address replaced", async () => {
    const events = (await send(harness, harness.cookies.moderator, "GET", `/api/jobs/${startedCopy}/events`)).json<Array<{ message: string }>>();
    expect(events.map((event) => event.message)).toContain(`Started a copy to local storage (requested by ${roleUsers.admin} from <address>)`);
    const ownerEvents = (await send(harness, harness.cookies.owner, "GET", `/api/jobs/${startedCopy}/events`)).json<Array<{ message: string }>>();
    expect(ownerEvents.map((event) => event.message)).toContain(`Started a copy to local storage (requested by ${roleUsers.admin} from 198.51.100.60)`);
  });

  it("removes the address from their own sessions, and only theirs", async () => {
    const own = (await send(harness, harness.cookies.moderator, "GET", "/api/auth/sessions")).json<{ sessions: Array<{ ip: string | null; device: string }> }>();
    expect(own.sessions.length).toBeGreaterThanOrEqual(3);
    expect(own.sessions.every((session) => session.ip === null && session.device.length > 0)).toBe(true);
    const owner = (await send(harness, harness.cookies.owner, "GET", "/api/auth/sessions")).json<{ sessions: Array<{ ip: string | null }> }>();
    expect(owner.sessions.some((session) => session.ip !== null)).toBe(true);
  });

  it("the same sweep finds them for an admin, so the sweep can see what it is looking for", async () => {
    const seen = new Set<string>();
    for (const url of await everyReadableUrl("owner")) {
      const response = await send(harness, harness.cookies.owner, "GET", url);
      for (const value of plantedValues()) if (response.body.includes(value)) seen.add(value);
    }
    expect([...seen]).toEqual(expect.arrayContaining([secretToken, serverAddress, backupFolder, path.join(harness.root, "local"), path.join(harness.root, "remote")]));
  });

  it("keeps the library parts of a path readable", async () => {
    const page = (await send(harness, harness.cookies.moderator, "GET", "/api/media-links/page")).json<{ rows: Array<{ linkPath: string; targetPath: string; relativePath: string }> }>();
    expect(page.rows[0]).toMatchObject({ relativePath: "Planted Movie (2020)/movie.mkv", linkPath: "<symlinks>/movies/Planted Movie (2020)/movie.mkv", targetPath: "<remote>/Planted Movie (2020)/movie.mkv" });
    const locations = (await send(harness, harness.cookies.moderator, "GET", "/api/settings/storage-locations")).json<{ locations: Array<{ displayName: string; path: string }> }>();
    expect(locations.locations.map((location) => location.path)).toEqual(["", ""]);
    expect(locations.locations.map((location) => location.displayName).every(Boolean)).toBe(true);
    const state = (await send(harness, harness.cookies.moderator, "GET", "/api/system/path-migration")).json<Record<string, unknown>>();
    expect(state).toMatchObject({ activePaths: null, changes: [], migration: null });
  });

  it("shows a settings job only by its type and status", async () => {
    const jobs = (await send(harness, harness.cookies.moderator, "GET", "/api/jobs")).json<Array<{ id: number; type: string; status: string; progress: unknown; options: unknown }>>();
    const backup = jobs.find((job) => job.type === "backup")!;
    expect(backup).toMatchObject({ status: "failed", progress: {}, options: {} });
    expect((await send(harness, harness.cookies.moderator, "GET", `/api/jobs/${backup.id}/events`)).json()).toEqual([]);
    expect((await send(harness, harness.cookies.moderator, "GET", `/api/jobs/${backup.id}/events/page`)).json()).toMatchObject({ events: [], total: 0 });
    expect((await send(harness, harness.cookies.owner, "GET", `/api/jobs/${backup.id}/events`)).json()).toHaveLength(1);
  });

  it("removes roots from an error message too", async () => {
    expect(scrubValue({ error: `Could not open ${path.join(harness.root, "local")}/x and ${serverAddress}` }, [{ path: path.join(harness.root, "local"), label: "<local>" }])).toEqual({ error: "Could not open <local>/x and <address>" });
  });

  it("scrubs text without damaging ordinary words or a similar folder name", () => {
    const roots = [{ path: "/mnt/media", label: "<local>" }];
    expect(scrubText("AC/DC Live (2020)", roots)).toBe("AC/DC Live (2020)");
    expect(scrubText("/mnt/media/Movies/a.mkv", roots)).toBe("<local>/Movies/a.mkv");
    expect(scrubText("/mnt/media2/Movies/a.mkv", roots)).toBe("…/a.mkv");
    expect(scrubText("/api/now-playing/poster/abc", roots)).toBe("/api/now-playing/poster/abc");
    expect(scrubText("see http://host:1234/a?token=abc now", roots)).toBe("see <address> now");
    expect(scrubText("reached [::1]:7878 and radarr.lan:7878 and localhost:8989", roots)).toBe("reached <address> and <address> and <address>");
    expect(scrubText("path:/srv/a/b.mkv and `/srv/c/d.mkv` and {/srv/e/f.mkv", roots)).toBe("path:…/b.mkv and `…/d.mkv` and {…/f.mkv");
    expect(scrubText("/api/../srv/x/y.mkv", roots)).toBe("…/y.mkv");
    expect(scrubText("/srv/a/b.mkv?X-Plex-Token=abc", roots)).toBe("…/b.mkv");
    expect(scrubValue({ filePath: "/mnt/other root/a b/c.mkv", plexPass: true, apiKey: "x", password: "y", mustChangePassword: true }, roots)).toEqual({ filePath: "…/c.mkv", plexPass: true, mustChangePassword: true });
    expect(scrubValue({ "/mnt/media/Movies": 1, movies: 2 }, roots)).toEqual({ "<local>/Movies": 1, movies: 2 });
  });

  it.each([
    ["from 198.51.100.7", "from <address>"],
    ["(198.51.100.7)", "(<address>)"],
    ["peer=198.51.100.7, next", "peer=<address>, next"],
    ["ended at 198.51.100.7.", "ended at <address>."],
    ["client_198.51.100.7_log", "client_<address>_log"],
    ["2001:db8::7", "<address>"],
    ["2001:0DB8:0000:0000:0000:0000:0000:0007", "<address>"],
    ["from 2001:db8:1:2:3:4:5:6 ok", "from <address> ok"],
    ["::1", "<address>"],
    ["fe80::7%eth0 failed", "<address> failed"],
    ["refused by fe80::7: timed out", "refused by <address>: timed out"],
    ["addr:fe80::7", "addr:<address>"],
    ["::ffff:198.51.100.7", "<address>"],
    ["[2001:db8::7]", "[<address>]"],
    ["[2001:db8::7]:32400", "<address>"],
    ["198.51.100.7:32400", "<address>"]
  ])("removes the address from %s", (input, expected) => {
    expect(scrubText(input, [])).toBe(expected);
    expect(scrubIpAddresses({ note: [input] })).toEqual({ note: [expect.not.stringMatching(/198\.51|2001:|fe80|::1/i)] });
  });

  it.each([
    "12:30:45",
    "2026-11-04T02:40:22.123Z",
    "Show.S01E02.1080p.DDP5.1.2.0.mkv",
    "Movie.2012.1.2.3.4.mkv",
    "version 0.1.4-beta.4",
    "aa:bb:cc:dd:ee:ff",
    "std::string",
    "Star Trek: The Next Generation",
    "Mission: Impossible 2.5"
  ])("leaves %s alone", (input) => {
    expect(scrubText(input, [])).toBe(input);
  });

  it("removes location fields, and only those", () => {
    const location = { city: "x", City: "x", region: "x", country: "x", country_code: "x", countryCode: "x", subdivisions: ["x"], latitude: 1, longitude: 2, lat: 1, lon: 2, lng: 2, long: 2, coordinates: [1, 2], coords: [1, 2], isp: "x", ISP: "x", asn: "x", postal: "x", postalCode: "x", zip: "x", zipCode: "x", timeZone: "x", time_zone: "x", continent: "x", geo: { city: "x" }, geoip: {}, GeoIP: {}, geolocation: {}, geoData: {}, geo_data: {}, viewerCity: "x", clientRegion: "x", peerCountry: "x", clientIsp: "x", viewerGeo: {}, viewer_city: "x", client_isp: "x" };
    expect(scrubValue(location, [])).toEqual({});
    const kept = { capacity: 4, velocity: 2, opacity: 1, geometry: "16:9", location: "wan", locationName: "Home NAS", language: "eng", codec: "hevc", code: "PX", longitude_note: "kept", cityscape: "kept", isolated: true, geoLookup: true, displayName: "Library" };
    expect(scrubValue(kept, [])).toEqual(kept);
    expect(scrubValue({ network: { location: "wan", geo: { city: "x" }, relayed: false } }, [])).toEqual({ network: { location: "wan", relayed: false } });
  });

  it("empties a field that exists to hold an address, and no other", () => {
    expect(scrubValue({ ip: "not.even.an.address", socketIp: "x", client_ip: "x", clientIP: "x", ips: ["x"], remoteAddress: "x", addresses: ["x"], skip: "yes", clip: "kept", relationship: "kept", ip6: null }, [])).toEqual({
      ip: null, socketIp: null, client_ip: null, clientIP: null, ips: [null], remoteAddress: null, addresses: [null], skip: "yes", clip: "kept", relationship: "kept", ip6: null
    });
  });

  it("removes viewer addresses and locations from the Now Playing stream, keeping everything else", async () => {
    const upstream = fastify();
    // A Plex server with a public viewer, and plex.tv answering where that viewer is, as SRTL's real lookup asks it to.
    const plexSession = plexHardwareTranscodeEpisode();
    upstream.get("/plextv/api/v2/user", async () => ({ id: 1, username: "plex-owner", subscription: { active: true, status: "Active", plan: "lifetime" } }));
    upstream.get("/plextv/api/v2/geoip", async () => ({ code: "PX", country: "Plantedland", city: "Plantedville", subdivisions: "Planted Region" }));
    upstream.get("/pms/status/sessions", async () => ({ MediaContainer: { size: 1, Metadata: [plexSession.session] } }));
    upstream.get("/pms/library/metadata/:keys", async () => ({ MediaContainer: { Metadata: [plexSession.library] } }));
    upstream.get("/jf/Sessions", async () => [
      jellyfinVideoTranscodeWithBurnIn(),
      { ...jellyfinVideoTranscodeWithBurnIn(), Id: "jf-session-v6", RemoteEndPoint: "2001:db8::77" }
    ]);
    const base = await upstream.listen({ host: "127.0.0.1", port: 0 });
    const originalPlexTv = plexEndpoints.plexTv;
    plexEndpoints.plexTv = `${base}/plextv`;
    const added = await send(harness, harness.cookies.owner, "POST", "/api/media-servers", { kind: "jellyfin", name: "Address test", url: `${base}/jf`, token: "abc123" });
    expect(added.statusCode, added.body).toBe(200);
    const addedPlex = await send(harness, harness.cookies.owner, "POST", "/api/media-servers", { kind: "plex", name: "Location test", url: `${base}/pms`, token: "abc123" });
    expect(addedPlex.statusCode, addedPlex.body).toBe(200);
    await harness.app.app.listen({ port: 0, host: "127.0.0.1" });
    const address = harness.app.app.server.address();
    const appBase = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
    const readUntil = async (cookie: string, ready: (text: string) => boolean) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 20_000);
      const response = await fetch(`${appBase}/api/now-playing/events`, { headers: { cookie }, signal: controller.signal });
      expect(response.status).toBe(200);
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let text = "";
      try {
        while (!ready(text) || !/\n\n$/.test(text)) {
          const { value, done } = await reader.read();
          if (done) break;
          text += decoder.decode(value, { stream: true });
        }
      } finally {
        clearTimeout(timer);
        controller.abort();
      }
      return text;
    };
    try {
      // Waits for the owner's stream to show the location, so the lookup has finished before the moderator's stream opens.
      const owner = await readUntil(harness.cookies.owner, (text) => text.includes("jf-session-v6") && text.includes("Plantedville"));
      expect(owner).toContain("203.0.113.77");
      expect(owner).toContain("2001:db8::77");
      expect(owner).toContain("198.51.100.23");
      for (const value of ["Plantedville", "Planted Region", "Plantedland", '"geo":{']) expect(owner).toContain(value);
      const moderator = await readUntil(harness.cookies.moderator, (text) => text.includes("jf-session-v6") && text.includes('"serverKind":"plex"'));
      expect(moderator).toContain("jf-session-v6");
      expect(moderator).toContain('"location":"wan"');
      for (const value of ["Plantedville", "Planted Region", "Plantedland", '"PX"', '"geo"', '"city"', '"region"', '"country"']) expect(moderator).not.toContain(value);
      expect(moderator).toContain('"user":{"id"');
      expect(moderator).toContain('"ip":null');
      expect(addressesIn(moderator)).toEqual([]);
      expect(moderator).not.toContain(base);
    } finally {
      plexEndpoints.plexTv = originalPlexTv;
      for (const server of addedPlex.json<{ servers: Array<{ id: string }> }>().servers) await send(harness, harness.cookies.owner, "DELETE", `/api/media-servers/${server.id}`);
      await upstream.close();
    }
  }, 40_000);

  it("keeps ordinary release notes readable while removing addresses from them", () => {
    expect(scrubIpAddresses({ releaseUrl: "https://github.com/example/releases/tag/v1", releaseNotes: "For example `198.51.100.9` or 2001:db8::9." })).toEqual({
      releaseUrl: "https://github.com/example/releases/tag/v1",
      releaseNotes: "For example `<address>` or <address>."
    });
  });
});

describe("what a moderator's job can do", () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await startHarness();
    await persistSectionSettings(harness.app.database.db, { sections: ["movies"] });
    await setSetting(harness.app.database.db, "advancedSettings", { cleanup: { holdDays: 7, deleteRemoteSourceAfterCopy: true } });
  }, 120_000);

  afterEach(async () => {
    await stopHarness(harness);
  });

  const quietLogger = { info: () => undefined, warn: () => undefined, error: () => undefined };
  const passingRunner = {
    async copyFile(source: string, target: string) { await fs.copyFile(source, target); },
    async runCmp(source: string, target: string) {
      const [left, right] = await Promise.all([fs.readFile(source), fs.readFile(target)]);
      return { status: left.equals(right) ? "pass" as const : "fail" as const, output: "" };
    },
    async runFfmpeg() { return { status: "pass" as const, output: "" }; }
  };

  async function remoteLink(name: string): Promise<{ sourcePath: string; id: number }> {
    const sourcePath = path.join(harness.root, "remote", `${name}.mkv`);
    const linkPath = path.join(harness.root, "links", "movies", name, `${name}.mkv`);
    await fs.writeFile(sourcePath, `remote bytes for ${name}`);
    await fs.mkdir(path.dirname(linkPath), { recursive: true });
    await fs.symlink(sourcePath, linkPath);
    const now = new Date().toISOString();
    const row = await first(harness.app.database.db.insert(schema.mediaLinks).values({
      section: "movies", itemName: name, relativePath: `${name}/${name}.mkv`, linkPath, targetPath: sourcePath, kind: "remote", targetExists: true, isMedia: true, storagePolicy: "location_1",
      sizeBytes: (await fs.stat(sourcePath)).size, firstSeenAt: now, lastSeenAt: now, lastChangedAt: now, missingSince: null, lastSeenJobId: 1, updatedAt: now
    }).returning({ id: schema.mediaLinks.id }));
    return { sourcePath, id: row!.id };
  }

  it("keeps the remote source when a moderator starts the copy, and deletes it when an admin does", async () => {
    const moderatorTitle = await remoteLink("Moderator Copy (2010)");
    const adminTitle = await remoteLink("Admin Copy (2011)");
    const moderatorCopy = await send(harness, harness.cookies.moderator, "POST", "/api/copies", { direction: "to_local", linkIds: [moderatorTitle.id] });
    expect(moderatorCopy.statusCode, moderatorCopy.body).toBe(200);
    const adminCopy = await send(harness, harness.cookies.admin, "POST", "/api/copies", { direction: "to_local", linkIds: [adminTitle.id] });
    expect(adminCopy.statusCode, adminCopy.body).toBe(200);
    const moderatorJob = moderatorCopy.json<{ jobId: number }>().jobId;
    const adminJob = adminCopy.json<{ jobId: number }>().jobId;
    expect((await harness.app.jobs.getJob(moderatorJob))?.options).not.toHaveProperty("deleteRemoteSource");
    expect((await harness.app.jobs.getJob(adminJob))?.options).toMatchObject({ deleteRemoteSource: true });

    const worker = new JobWorker(harness.app.database.db, { workerId: "roles-test", logger: quietLogger, copyRunner: passingRunner });
    while (await worker.runOnce()) {
      // drain
    }
    expect(await harness.app.jobs.getJob(moderatorJob)).toMatchObject({ status: "completed" });
    expect(await harness.app.jobs.getJob(adminJob)).toMatchObject({ status: "completed" });
    await expect(fs.stat(moderatorTitle.sourcePath)).resolves.toBeTruthy();
    await expect(fs.stat(adminTitle.sourcePath)).rejects.toMatchObject({ code: "ENOENT" });
  }, 60_000);

  it("lets a moderator stop scans, audits and copies to local, but not a copy to remote, cleanup, backup or path move", async () => {
    const { db } = harness.app.database;
    const now = new Date().toISOString();
    const addJob = async (type: string) => (await first(db.insert(schema.jobs).values({ type, status: "queued", createdAt: now, progress: "{}", options: "{}" }).returning({ id: schema.jobs.id })))!.id;
    for (const type of ["orphan_purge", "symlink_cleanup", "backup", "path_migration", "watch_sync"]) {
      const id = await addJob(type);
      expect((await send(harness, harness.cookies.moderator, "POST", `/api/jobs/${id}/terminate`)).statusCode, type).toBe(403);
      expect((await send(harness, harness.cookies.moderator, "POST", `/api/jobs/${id}/cancel`)).statusCode, type).toBe(403);
      expect((await harness.app.jobs.getJob(id))?.status).toBe("queued");
    }
    const remoteCopy = (await first(db.insert(schema.jobs).values({ type: "copy", status: "queued", createdAt: now, progress: "{}", options: JSON.stringify({ direction: "to_remote" }) }).returning({ id: schema.jobs.id })))!.id;
    expect((await send(harness, harness.cookies.moderator, "POST", `/api/jobs/${remoteCopy}/terminate`)).statusCode).toBe(403);
    expect((await harness.app.jobs.getJob(remoteCopy))?.status).toBe("queued");
    const localCopy = (await first(db.insert(schema.jobs).values({ type: "copy", status: "queued", createdAt: now, progress: "{}", options: JSON.stringify({ direction: "to_local" }) }).returning({ id: schema.jobs.id })))!.id;
    for (const id of [await addJob("scan"), await addJob("audit"), localCopy]) {
      expect((await send(harness, harness.cookies.moderator, "POST", `/api/jobs/${id}/terminate`)).statusCode, String(id)).toBe(200);
    }
  });
});
