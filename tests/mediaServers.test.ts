import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp, type AppContext } from "../src/server/app";
import { getJsonSetting, nowIso, openDatabase } from "../src/server/db/database";
import * as schema from "../src/server/db/schema";
import { markOnboardingCompleteForExistingInstall } from "../src/server/lib/onboarding";
import { loadMediaServers, mediaServerClientIdentifier } from "../src/server/lib/mediaServers";
import { plexEndpoints } from "../src/server/lib/plexClient";
import { getWatchSyncState, loadWatchSyncContext } from "../src/server/lib/watchSync";
import { watchSyncHttpTiming } from "../src/server/lib/watchSyncHttp";
import type { MediaServerList } from "../src/shared/mediaServers";
import { MockMediaServers } from "./watchSyncMocks";
import { createTestDatabase, type TestDatabaseHandle } from "./testDb";

describe("media server migration", () => {
  it("moves watch sync servers into media_servers with their ids, tokens, and status, keeping pairs and history", async () => {
    const testDatabase = await createTestDatabase();
    const first = await openDatabase(testDatabase.databaseUrl);
    const timestamp = nowIso();
    try {
      // Rewind to schema 23, where servers lived inside the watchSync setting.
      await first.pool.query(`DROP TABLE media_servers`);
      await first.pool.query(`DELETE FROM schema_migrations WHERE version = 24`);
      const legacy = {
        revision: 4, paused: false, intervalMinutes: 10, reconcileIntervalDays: 3, syncWatched: true, syncPosition: false, clientIdentifier: "client-uuid-1",
        servers: [
          { id: "a1b2c3d4e5f6", kind: "plex", name: "Home Plex", url: "http://plex:32400", token: "plex-owner-secret", prefixMappings: [{ serverPrefix: "/data/media", srtlPrefix: "/mnt/plex" }], machineIdentifier: "machine-1", accountName: "ElJefe_03", accountId: "100" },
          { id: "0f9e8d7c6b5a", kind: "jellyfin", name: "Jellyfin", url: "http://jellyfin:8096", token: "jellyfin-api-secret", prefixMappings: [], machineIdentifier: null, accountName: null, accountId: null }
        ]
      };
      await first.pool.query(`INSERT INTO app_settings (key, value, updated_at) VALUES ('watchSync', $1, $2)`, [JSON.stringify(legacy), timestamp]);
      await first.pool.query(`INSERT INTO watch_sync_cursors (scope, value, updated_at) VALUES ('server-status:0f9e8d7c6b5a', $1, $2), ('plex-pin:a1b2c3d4e5f6', '{"id":7}', $2), ('reconcile:last', $2, $2)`,
        [JSON.stringify({ lastCheckedAt: "2026-11-01T10:00:00.000Z", lastError: "Jellyfin returned HTTP 503." }), timestamp]);
      await first.pool.query(`INSERT INTO watch_sync_users (server_id, external_id, name, kind, account_id, access_token, updated_at) VALUES
        ('a1b2c3d4e5f6', '100', 'ElJefe_03', 'owner', '1', 'plex-owner-secret', $1), ('0f9e8d7c6b5a', 'jf-jefe', 'Eljefe', 'user', NULL, NULL, $1)`, [timestamp]);
      const pair = (await first.pool.query<{ id: number }>(`INSERT INTO watch_sync_pairs (plex_server_id, plex_user_id, jellyfin_server_id, jellyfin_user_id, approved_at, last_full_sync_at, plex_cursor, created_at, updated_at)
        VALUES ('a1b2c3d4e5f6', '100', '0f9e8d7c6b5a', 'jf-jefe', $1, $1, '12345', $1, $1) RETURNING id`, [timestamp])).rows[0]!;
      await first.pool.query(`INSERT INTO watch_sync_state (pair_id, link_path, plex_watched, jellyfin_watched, synced_at) VALUES ($1, '/mnt/plex/movies/A/A.mkv', true, true, $2)`, [pair.id, timestamp]);
      await first.pool.query(`INSERT INTO watch_sync_activity (pair_id, at, level, message) VALUES ($1, $2, 'info', 'Marked "A" watched')`, [pair.id, timestamp]);
      await first.pool.query(`INSERT INTO watch_sync_items (server_id, link_path, item_id, seen_at) VALUES ('a1b2c3d4e5f6', '/mnt/plex/movies/A/A.mkv', '11', $1)`, [timestamp]);
    } finally {
      await first.close();
    }

    const database = await openDatabase(testDatabase.databaseUrl);
    try {
      const servers = await loadMediaServers(database.db);
      expect(servers).toEqual([
        { id: "a1b2c3d4e5f6", kind: "plex", name: "Home Plex", url: "http://plex:32400", token: "plex-owner-secret", prefixMappings: [{ serverPrefix: "/data/media", srtlPrefix: "/mnt/plex" }], machineIdentifier: "machine-1", accountName: "ElJefe_03", accountId: "100", version: null, lastCheckedAt: null, lastError: null },
        { id: "0f9e8d7c6b5a", kind: "jellyfin", name: "Jellyfin", url: "http://jellyfin:8096", token: "jellyfin-api-secret", prefixMappings: [], machineIdentifier: null, accountName: null, accountId: null, version: null, lastCheckedAt: "2026-11-01T10:00:00.000Z", lastError: "Jellyfin returned HTTP 503." }
      ]);
      // Plex knows SRTL by this id, so it is kept rather than created again.
      expect(await mediaServerClientIdentifier(database.db)).toBe("client-uuid-1");
      const watchSync = await getJsonSetting<Record<string, unknown>>(database.db, "watchSync", {});
      expect(watchSync).toEqual({ revision: 4, paused: false, intervalMinutes: 10, reconcileIntervalDays: 3, syncWatched: true, syncPosition: false });
      const scopes = (await database.db.select().from(schema.watchSyncCursors)).map((row) => row.scope);
      expect(scopes).toEqual(["reconcile:last"]);

      const context = await loadWatchSyncContext(database.db);
      expect(context).toMatchObject({ intervalMinutes: 10, clientIdentifier: "client-uuid-1" });
      expect(context.servers.map((server) => server.id)).toEqual(["a1b2c3d4e5f6", "0f9e8d7c6b5a"]);
      const state = await getWatchSyncState(database.db);
      expect(state.pairs).toMatchObject([{ plexServerId: "a1b2c3d4e5f6", plexUserName: "ElJefe_03", jellyfinServerId: "0f9e8d7c6b5a", jellyfinUserName: "Eljefe", trackedItems: 1 }]);
      expect(state.indexedItems).toEqual({ a1b2c3d4e5f6: 1 });
      expect(state.servers.find((server) => server.id === "0f9e8d7c6b5a")).toMatchObject({ hasToken: true, lastError: "Jellyfin returned HTTP 503." });
      expect(JSON.stringify(state)).not.toContain("secret");
      expect((await database.db.select().from(schema.watchSyncPairs))[0]).toMatchObject({ plexCursor: "12345" });
      expect(await database.db.select().from(schema.watchSyncActivity)).toHaveLength(1);
    } finally {
      await database.close();
      await testDatabase.cleanup();
    }
  });

  it("creates an empty media_servers table on a new install", async () => {
    const testDatabase = await createTestDatabase();
    const database = await openDatabase(testDatabase.databaseUrl);
    try {
      expect(await loadMediaServers(database.db)).toEqual([]);
      expect(await getJsonSetting(database.db, "watchSync", null)).toBeNull();
    } finally {
      await database.close();
      await testDatabase.cleanup();
    }
  });
});

describe("media servers API", () => {
  let app: AppContext;
  let database: TestDatabaseHandle;
  let root: string;
  let mock: MockMediaServers;
  let cookie: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "srtl-media-servers-test-"));
    for (const folder of ["links", "local", "remote"]) await fs.mkdir(path.join(root, folder), { recursive: true });
    database = await createTestDatabase();
    app = await createApp({ rootDir: root, databaseUrl: database.databaseUrl, autoMigrate: true, paths: { symlinkDir: path.join(root, "links"), localDir: path.join(root, "local"), remoteDir: path.join(root, "remote") } });
    app.app.log.level = "silent";
    await markOnboardingCompleteForExistingInstall(app.database.db);
    mock = new MockMediaServers();
    await mock.start();
    mock.addJellyfin("jf1", { users: [{ id: "jf-jefe", name: "Eljefe" }] });
    plexEndpoints.plexTv = `${mock.base}/plextv`;
    plexEndpoints.plexApp = "https://app.plex.invalid";
    watchSyncHttpTiming.backoffMs = 1;
    const setup = await app.app.inject({ method: "POST", url: "/api/auth/setup", payload: { username: "fixture", password: "fixture-password-123", confirmPassword: "fixture-password-123" } });
    cookie = String(setup.headers["set-cookie"]);
  });

  afterEach(async () => {
    await mock.stop();
    await app.app.close();
    await database.cleanup();
    await fs.rm(root, { recursive: true, force: true });
  });

  const call = (method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: unknown) =>
    app.app.inject({ method, url, headers: { cookie }, ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }) });

  it("requires a signed-in admin", async () => {
    expect((await app.app.inject({ method: "GET", url: "/api/media-servers" })).statusCode).toBe(401);
  });

  it("never returns tokens or API keys, and keeps a saved key when the field is left empty", async () => {
    const apiKey = mock.jellyfin.get("jf1")!.apiKey;
    const created = await call("POST", "/api/media-servers", { kind: "jellyfin", name: "Jellyfin", url: `${mock.base}/jf1`, token: apiKey, prefixMappings: [] });
    expect(created.statusCode).toBe(200);
    expect(created.body).not.toContain(apiKey);
    const list = created.json() as MediaServerList;
    expect(list.servers).toEqual([expect.objectContaining({ kind: "jellyfin", name: "Jellyfin", hasToken: true })]);
    expect(list.servers[0]).not.toHaveProperty("token");
    const id = list.servers[0]!.id;

    const tested = await call("POST", `/api/media-servers/${id}/test`);
    expect(tested.statusCode).toBe(200);
    expect((tested.json() as MediaServerList).servers[0]).toMatchObject({ version: "10.10.0", lastError: null });
    expect(tested.body).not.toContain(apiKey);

    const renamed = await call("PUT", `/api/media-servers/${id}`, { name: "Living room", url: `${mock.base}/jf1`, token: "", prefixMappings: [{ serverPrefix: "/media", srtlPrefix: "/mnt/plex" }] });
    expect(renamed.statusCode).toBe(200);
    expect((await app.database.db.select().from(schema.mediaServers).where(eq(schema.mediaServers.id, id)))[0]).toMatchObject({ name: "Living room", token: apiKey });
    // A saved key is never sent to a new address unless it is entered again.
    const moved = await call("PUT", `/api/media-servers/${id}`, { name: "Living room", url: "http://elsewhere:8096", prefixMappings: [] });
    expect(moved.statusCode).toBe(400);
    expect(moved.json().error).toContain("Enter the API key again");

    for (const response of [await call("GET", "/api/media-servers"), await call("GET", "/api/settings/watch-sync")]) {
      expect(response.statusCode).toBe(200);
      expect(response.body).not.toContain(apiKey);
    }
    const duplicate = await call("POST", "/api/media-servers", { kind: "plex", name: "living ROOM", url: `${mock.base}/pms`, prefixMappings: [] });
    expect(duplicate.statusCode).toBe(400);
    expect(duplicate.json().error).toContain("already uses this name");
  });

  it("signs in with Plex, records the server identity, and refreshes watch sync users", async () => {
    const created = await call("POST", "/api/media-servers", { kind: "plex", name: "Home Plex", url: `${mock.base}/pms`, prefixMappings: [] });
    const id = (created.json() as MediaServerList).servers[0]!.id;
    expect((await call("POST", `/api/media-servers/${id}/test`)).json().error).toContain("Sign in with Plex");
    const pin = (await call("POST", `/api/media-servers/${id}/plex-pin`)).json() as { pinId: number };
    expect((await call("POST", `/api/media-servers/${id}/plex-pin/${pin.pinId}`)).json()).toEqual({ status: "waiting" });
    const authorized = await call("POST", `/api/media-servers/${id}/plex-pin/${pin.pinId}`);
    expect(authorized.json()).toMatchObject({ status: "authorized", servers: { servers: [{ id, hasToken: true, machineIdentifier: "machine-1", accountName: "ElJefe_03", version: "1.43.0", lastError: null }] } });
    expect(authorized.body).not.toContain(mock.ownerToken);
    const state = await getWatchSyncState(app.database.db);
    expect(state.users.filter((user) => user.serverId === id).map((user) => user.name)).toContain("ElJefe_03");
  });

  it("blocks removing a server while watch sync pairs use it, naming the pairs", async () => {
    const plexId = ((await call("POST", "/api/media-servers", { kind: "plex", name: "Home Plex", url: `${mock.base}/pms`, prefixMappings: [] })).json() as MediaServerList).servers[0]!.id;
    const jellyfinId = ((await call("POST", "/api/media-servers", { kind: "jellyfin", name: "Jellyfin", url: `${mock.base}/jf1`, token: mock.jellyfin.get("jf1")!.apiKey, prefixMappings: [] })).json() as MediaServerList).servers
      .find((server) => server.kind === "jellyfin")!.id;
    const timestamp = nowIso();
    await app.database.db.insert(schema.watchSyncUsers).values([
      { serverId: plexId, externalId: "100", name: "ElJefe_03", kind: "owner", accessToken: "x", updatedAt: timestamp },
      { serverId: jellyfinId, externalId: "jf-jefe", name: "Eljefe", kind: "user", updatedAt: timestamp }
    ]);
    const [pair] = await app.database.db.insert(schema.watchSyncPairs).values({ plexServerId: plexId, plexUserId: "100", jellyfinServerId: jellyfinId, jellyfinUserId: "jf-jefe", createdAt: timestamp, updatedAt: timestamp }).returning();

    const blocked = await call("DELETE", `/api/media-servers/${jellyfinId}`);
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error).toBe("Jellyfin is used by 1 watch sync pair: ElJefe_03 ↔ Eljefe. Remove that pair in Settings > Integrations > Watch sync first.");
    expect((await call("GET", "/api/media-servers")).json().servers).toHaveLength(2);

    await app.database.db.delete(schema.watchSyncPairs).where(eq(schema.watchSyncPairs.id, pair!.id));
    const removed = await call("DELETE", `/api/media-servers/${jellyfinId}`);
    expect(removed.statusCode).toBe(200);
    expect((removed.json() as MediaServerList).servers.map((server) => server.id)).toEqual([plexId]);
    expect(await app.database.db.select().from(schema.watchSyncUsers).where(eq(schema.watchSyncUsers.serverId, jellyfinId))).toEqual([]);
    expect((await call("DELETE", `/api/media-servers/${jellyfinId}`)).statusCode).toBe(404);
  });

  it("no longer serves the old watch sync server endpoints", async () => {
    expect((await call("POST", "/api/settings/watch-sync/servers", { kind: "jellyfin", name: "x", url: "http://x:8096", prefixMappings: [] })).statusCode).toBe(404);
  });
});
