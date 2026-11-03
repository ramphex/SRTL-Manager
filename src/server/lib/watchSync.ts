import { and, asc, count, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { z } from "zod";
import {
  type WatchSyncActivity,
  type WatchSyncBackup,
  type WatchSyncDirection,
  type WatchSyncPair,
  type WatchSyncPairInput,
  type WatchSyncPairUpdate,
  type WatchSyncPreview,
  type WatchSyncServerKind,
  type WatchSyncSettings,
  type WatchSyncSettingsInput,
  type WatchSyncState,
  type WatchSyncSuggestion,
  type WatchSyncUser,
  type WatchSyncUserKind
} from "../../shared/watchSync";
import { getJsonSetting, nowIso, setSetting, type Db } from "../db/database";
import * as schema from "../db/schema";
import { publicErrorMessage } from "../errors";
import { JellyfinClient } from "./jellyfinClient";
import { findMediaServer, getMediaServer, loadMediaServers, mediaServerClientIdentifier, mediaServerIdSchema, publicMediaServer, recordMediaServerStatus, type MediaServerDetails, type MediaServerRecord } from "./mediaServers";
import { PlexServerClient, PlexTvClient } from "./plexClient";
import { WatchSyncError } from "./watchSyncHttp";

const settingKey = "watchSync";
const settingsLock = 781_889_470;

// The shared connection from Settings > Media servers, token included.
export type StoredServer = MediaServerRecord;

export type StoredSettings = WatchSyncSettingsInput;

// Everything a sync pass needs: watch sync's own settings, the shared servers, and SRTL's client identifier.
export interface WatchSyncContext extends StoredSettings {
  servers: StoredServer[];
  clientIdentifier: string;
}

export type PairRow = typeof schema.watchSyncPairs.$inferSelect;
export type UserRow = typeof schema.watchSyncUsers.$inferSelect;

class WatchSyncNotFound extends WatchSyncError {
  override readonly statusCode = 404;
}

export const watchSyncServerIdSchema = mediaServerIdSchema;
export const watchSyncSettingsSchema = z.object({
  revision: z.number().int().nonnegative(),
  paused: z.boolean(),
  intervalMinutes: z.number().int().min(1, "Sync at most once a minute.").max(1440),
  reconcileIntervalDays: z.number().int().min(1).max(90),
  syncWatched: z.boolean(),
  syncPosition: z.boolean()
});
const direction = z.enum(["plex_to_jellyfin", "jellyfin_to_plex", "both"]);
export const watchSyncPairInputSchema = z.object({
  plexServerId: watchSyncServerIdSchema,
  plexUserId: z.string().min(1).max(200),
  jellyfinServerId: watchSyncServerIdSchema,
  jellyfinUserId: z.string().min(1).max(200),
  enabled: z.boolean().optional(),
  direction: direction.optional(),
  syncWatched: z.boolean().nullable().optional(),
  syncPosition: z.boolean().nullable().optional()
});
export const watchSyncPairUpdateSchema = z.object({
  enabled: z.boolean().optional(),
  paused: z.boolean().optional(),
  direction: direction.optional(),
  syncWatched: z.boolean().nullable().optional(),
  syncPosition: z.boolean().nullable().optional()
});
const sideStateSchema = z.object({ watched: z.boolean(), positionMs: z.number().int().min(0).max(1e10), at: z.string().max(64).nullable() });
export const watchSyncBackupSchema = z.object({
  format: z.literal("srtl-watch-sync"),
  version: z.literal(1),
  exportedAt: z.string(),
  plexUserName: z.string(),
  jellyfinUserName: z.string(),
  items: z.array(z.object({ linkPath: z.string().min(1).max(4096), plex: sideStateSchema.nullable(), jellyfin: sideStateSchema.nullable() })).max(500_000)
});

const defaults: StoredSettings = { revision: 0, paused: false, intervalMinutes: 5, reconcileIntervalDays: 7, syncWatched: true, syncPosition: true };

export async function loadWatchSyncSettings(db: Db): Promise<StoredSettings> {
  const saved = await getJsonSetting<Partial<StoredSettings>>(db, settingKey, {});
  return {
    revision: saved.revision ?? defaults.revision, paused: saved.paused ?? defaults.paused, intervalMinutes: saved.intervalMinutes ?? defaults.intervalMinutes,
    reconcileIntervalDays: saved.reconcileIntervalDays ?? defaults.reconcileIntervalDays, syncWatched: saved.syncWatched ?? defaults.syncWatched, syncPosition: saved.syncPosition ?? defaults.syncPosition
  };
}

export async function loadWatchSyncContext(db: Db): Promise<WatchSyncContext> {
  return { ...await loadWatchSyncSettings(db), servers: await loadMediaServers(db), clientIdentifier: await mediaServerClientIdentifier(db) };
}

async function locked<T>(db: Db, action: (transaction: Db, settings: StoredSettings) => Promise<T>): Promise<T> {
  return db.transaction(async (transaction) => {
    await transaction.execute(sql`select pg_advisory_xact_lock(${settingsLock})`);
    return action(transaction, await loadWatchSyncSettings(transaction));
  });
}

export function findServer(context: Pick<WatchSyncContext, "servers">, serverId: string, kind?: WatchSyncServerKind): StoredServer {
  return findMediaServer(context.servers, serverId, kind);
}

// Cursors and status records the worker writes without touching the user's settings revision.
export async function readCursor(db: Db, scope: string): Promise<string | null> {
  const row = (await db.select().from(schema.watchSyncCursors).where(eq(schema.watchSyncCursors.scope, scope)).limit(1))[0];
  return row?.value ?? null;
}

export async function writeCursor(db: Db, scope: string, value: string | null): Promise<void> {
  if (value === null) {
    await db.delete(schema.watchSyncCursors).where(eq(schema.watchSyncCursors.scope, scope));
    return;
  }
  await db.insert(schema.watchSyncCursors).values({ scope, value, updatedAt: nowIso() }).onConflictDoUpdate({ target: schema.watchSyncCursors.scope, set: { value, updatedAt: nowIso() } });
}

export async function recordServerStatus(db: Db, serverId: string, error: string | null): Promise<void> {
  await recordMediaServerStatus(db, serverId, error);
}

export async function publicSettings(db: Db): Promise<WatchSyncSettings> {
  const settings = await loadWatchSyncSettings(db);
  return {
    revision: settings.revision, paused: settings.paused, intervalMinutes: settings.intervalMinutes, reconcileIntervalDays: settings.reconcileIntervalDays,
    syncWatched: settings.syncWatched, syncPosition: settings.syncPosition,
    lastReconcileAt: await readCursor(db, "reconcile:last")
  };
}

export async function saveWatchSyncSettings(db: Db, input: WatchSyncSettingsInput): Promise<WatchSyncState> {
  const draft = watchSyncSettingsSchema.parse(input);
  await locked(db, async (transaction, settings) => {
    if (draft.revision !== settings.revision) throw new WatchSyncError("Watch sync settings changed. Reload before saving.");
    await setSetting(transaction, settingKey, { ...settings, ...draft, revision: settings.revision + 1 });
  });
  return getWatchSyncState(db);
}

export async function setWatchSyncPaused(db: Db, paused: boolean): Promise<WatchSyncState> {
  await locked(db, (transaction, settings) => setSetting(transaction, settingKey, { ...settings, paused, revision: settings.revision + 1 }));
  return getWatchSyncState(db);
}

function plexUserKind(user: { home: boolean; restricted: boolean }): WatchSyncUserKind {
  if (user.home && user.restricted) return "managed";
  return user.home ? "home" : "friend";
}

async function saveUsers(db: Db, serverId: string, users: Array<Omit<UserRow, "serverId" | "updatedAt">>): Promise<void> {
  const timestamp = nowIso();
  await db.transaction(async (transaction) => {
    for (const user of users) {
      const values = { ...user, serverId, updatedAt: timestamp };
      await transaction.insert(schema.watchSyncUsers).values(values).onConflictDoUpdate({
        target: [schema.watchSyncUsers.serverId, schema.watchSyncUsers.externalId],
        set: { name: values.name, username: values.username, kind: values.kind, accountId: values.accountId, accessToken: values.accessToken, available: values.available, note: values.note, updatedAt: timestamp }
      });
    }
    // Users who lost access stay listed, because pairs may refer to them, but stop syncing.
    const seen = users.map((user) => user.externalId);
    await transaction.update(schema.watchSyncUsers).set({ available: false, accessToken: null, note: "No longer has access to this server.", updatedAt: timestamp })
      .where(and(eq(schema.watchSyncUsers.serverId, serverId), seen.length ? sql`${schema.watchSyncUsers.externalId} NOT IN (SELECT jsonb_array_elements_text(${JSON.stringify(seen)}::jsonb))` : sql`true`));
  });
}

async function discoverPlex(db: Db, server: StoredServer, identifier: string): Promise<MediaServerDetails> {
  if (!server.token) throw new WatchSyncError("Sign in with Plex or paste a Plex token first.");
  const pms = new PlexServerClient(server.url, server.token, identifier);
  const { machineIdentifier, version } = await pms.identity();
  const plexTv = new PlexTvClient(identifier);
  const account = await plexTv.account(server.token);
  const [friends, shared] = await Promise.all([
    plexTv.users(server.token),
    plexTv.sharedServers(server.token, machineIdentifier).catch((error: unknown) => {
      if (error instanceof WatchSyncError && (error.httpStatus === 401 || error.httpStatus === 403)) throw new WatchSyncError("Only the Plex account that owns this server can sync other users. Sign in as the server owner.");
      throw error;
    })
  ]);
  const tokens = new Map(shared.map((entry) => [entry.userId, entry.accessToken]));
  const users: Array<Omit<UserRow, "serverId" | "updatedAt">> = [
    // The owner's local account on a Plex server is always id 1.
    { externalId: account.id, name: account.title, username: account.username, kind: "owner", accountId: "1", accessToken: server.token, available: true, note: null }
  ];
  for (const user of friends) {
    if (user.id === account.id) continue;
    const token = tokens.get(user.id) ?? null;
    const hasServer = user.machineIdentifiers.length === 0 || user.machineIdentifiers.includes(machineIdentifier) || tokens.has(user.id);
    if (!hasServer) continue;
    users.push({
      externalId: user.id,
      name: user.title,
      username: user.username,
      kind: plexUserKind(user),
      // Shared users keep their plex.tv id as their local account id once they have used the server.
      accountId: user.id,
      accessToken: token,
      available: Boolean(token),
      note: token ? null : "No server access token. Share at least one library on this server with this user in Plex, then discover users again."
    });
  }
  await saveUsers(db, server.id, users);
  return { machineIdentifier, version, accountName: account.title, accountId: account.id };
}

async function discoverJellyfin(db: Db, server: StoredServer, identifier: string): Promise<MediaServerDetails> {
  if (!server.token) throw new WatchSyncError("Enter a Jellyfin API key first.");
  const client = new JellyfinClient(server.url, server.token, identifier);
  const info = await client.systemInfo();
  const users = await client.users();
  await saveUsers(db, server.id, users.map((user) => ({
    externalId: user.id, name: user.name, username: null, kind: "user" as const, accountId: null, accessToken: null,
    available: !user.disabled, note: user.disabled ? "Disabled in Jellyfin." : null
  })));
  return { version: info.version };
}

// Refreshes the server's user list (and, for Plex, every user's access token), recording the connection status too.
export async function discoverWatchSyncUsers(db: Db, serverId: string): Promise<WatchSyncState> {
  const server = await getMediaServer(db, serverId);
  const identifier = await mediaServerClientIdentifier(db);
  try {
    const details = server.kind === "plex" ? await discoverPlex(db, server, identifier) : await discoverJellyfin(db, server, identifier);
    await recordMediaServerStatus(db, server.id, null, details, server.token);
  } catch (error) {
    await recordServerStatus(db, server.id, publicErrorMessage(error, "Connection failed."));
    throw error;
  }
  return getWatchSyncState(db);
}

// Lowercase letters and digits only, so alex_03 and alex03 compare equal; the letters-only form also matches Alex.
export function watchSyncNameKeys(name: string | null | undefined): { exact: string; letters: string } {
  const folded = (name ?? "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();
  return { exact: folded.replace(/[^a-z0-9]/g, ""), letters: folded.replace(/[^a-z]/g, "") };
}

export function suggestPairs(plexUsers: Array<Pick<UserRow, "serverId" | "externalId" | "name" | "username">>, jellyfinUsers: Array<Pick<UserRow, "serverId" | "externalId" | "name">>, existing: Array<Pick<PairRow, "plexServerId" | "plexUserId" | "jellyfinServerId" | "jellyfinUserId">>): WatchSyncSuggestion[] {
  const paired = new Set(existing.map((pair) => `${pair.plexServerId}\0${pair.plexUserId}\0${pair.jellyfinServerId}`));
  const suggestions: WatchSyncSuggestion[] = [];
  const jellyfinServers = [...new Set(jellyfinUsers.map((user) => user.serverId))];
  for (const plexUser of plexUsers) {
    const names = [plexUser.name, plexUser.username].map(watchSyncNameKeys).filter((keys) => keys.exact);
    for (const jellyfinServerId of jellyfinServers) {
      if (paired.has(`${plexUser.serverId}\0${plexUser.externalId}\0${jellyfinServerId}`)) continue;
      let best: { user: (typeof jellyfinUsers)[number]; match: WatchSyncSuggestion["match"] } | null = null;
      let ambiguous = false;
      for (const jellyfinUser of jellyfinUsers.filter((user) => user.serverId === jellyfinServerId)) {
        const keys = watchSyncNameKeys(jellyfinUser.name);
        if (!keys.exact) continue;
        const exact = names.some((name) => name.exact === keys.exact);
        const similar = !exact && keys.letters.length >= 3 && names.some((name) => name.letters.length >= 3 && name.letters === keys.letters);
        if (!exact && !similar) continue;
        const match = exact ? "exact" : "similar";
        if (!best || (match === "exact" && best.match === "similar")) { best = { user: jellyfinUser, match }; ambiguous = false; }
        else if (best.match === match) ambiguous = true;
      }
      if (!best || ambiguous) continue;
      suggestions.push({ plexServerId: plexUser.serverId, plexUserId: plexUser.externalId, plexUserName: plexUser.name, jellyfinServerId, jellyfinUserId: best.user.externalId, jellyfinUserName: best.user.name, match: best.match });
    }
  }
  return suggestions;
}

function parsePreview(value: string | null): WatchSyncPreview | null {
  if (!value) return null;
  try { return JSON.parse(value) as WatchSyncPreview; } catch { return null; }
}

export async function getWatchSyncState(db: Db): Promise<WatchSyncState> {
  const settings = await publicSettings(db);
  const servers = await loadMediaServers(db);
  const serverIds = new Set(servers.map((server) => server.id));
  const users = (await db.select().from(schema.watchSyncUsers).orderBy(asc(schema.watchSyncUsers.name))).filter((user) => serverIds.has(user.serverId));
  const pairs = await db.select().from(schema.watchSyncPairs).orderBy(asc(schema.watchSyncPairs.id));
  const tracked = new Map((await db.select({ pairId: schema.watchSyncState.pairId, total: count() }).from(schema.watchSyncState).groupBy(schema.watchSyncState.pairId)).map((row) => [row.pairId, Number(row.total)]));
  const indexed = await db.select({ serverId: schema.watchSyncItems.serverId, total: count() }).from(schema.watchSyncItems).groupBy(schema.watchSyncItems.serverId);
  const jobs = await db.select({ id: schema.jobs.id, status: schema.jobs.status, options: schema.jobs.options }).from(schema.jobs)
    .where(and(eq(schema.jobs.type, "watch_sync"), inArray(schema.jobs.status, ["queued", "running"]))).orderBy(asc(schema.jobs.id));
  const userName = (serverId: string, externalId: string) => users.find((user) => user.serverId === serverId && user.externalId === externalId)?.name ?? externalId;
  const kinds = new Map(servers.map((server) => [server.id, server.kind]));
  const publicUsers: WatchSyncUser[] = users.map((user) => ({
    serverId: user.serverId, externalId: user.externalId, name: user.name, username: user.username, kind: user.kind as WatchSyncUserKind,
    ready: user.available && (kinds.get(user.serverId) !== "plex" || Boolean(user.accessToken)), note: user.note
  }));
  const publicPairs: WatchSyncPair[] = pairs.map((pair) => ({
    id: pair.id, plexServerId: pair.plexServerId, plexUserId: pair.plexUserId, plexUserName: userName(pair.plexServerId, pair.plexUserId),
    jellyfinServerId: pair.jellyfinServerId, jellyfinUserId: pair.jellyfinUserId, jellyfinUserName: userName(pair.jellyfinServerId, pair.jellyfinUserId),
    enabled: pair.enabled, paused: pair.paused, direction: pair.direction as WatchSyncDirection, syncWatched: pair.syncWatched, syncPosition: pair.syncPosition,
    approvedAt: pair.approvedAt, preview: parsePreview(pair.preview), lastSyncAt: pair.lastSyncAt, lastFullSyncAt: pair.lastFullSyncAt, lastError: pair.lastError,
    trackedItems: tracked.get(pair.id) ?? 0
  }));
  return {
    settings,
    servers: servers.map(publicMediaServer),
    users: publicUsers,
    pairs: publicPairs,
    suggestions: suggestPairs(users.filter((user) => kinds.get(user.serverId) === "plex"), users.filter((user) => kinds.get(user.serverId) === "jellyfin" && user.available), pairs),
    activeJobs: jobs.map((job) => {
      let mode: WatchSyncState["activeJobs"][number]["mode"] = "reconcile";
      try { mode = (JSON.parse(job.options) as { mode?: typeof mode }).mode ?? "reconcile"; } catch { /* default */ }
      return { id: job.id, status: job.status, mode };
    }),
    indexedItems: Object.fromEntries(indexed.map((row) => [row.serverId, Number(row.total)]))
  };
}

async function assertUser(db: Db, servers: StoredServer[], serverId: string, userId: string, kind: WatchSyncServerKind): Promise<void> {
  findMediaServer(servers, serverId, kind);
  const user = (await db.select().from(schema.watchSyncUsers).where(and(eq(schema.watchSyncUsers.serverId, serverId), eq(schema.watchSyncUsers.externalId, userId))).limit(1))[0];
  if (!user) throw new WatchSyncError(`Unknown ${kind === "plex" ? "Plex" : "Jellyfin"} user. Discover users again.`);
}

export async function createWatchSyncPair(db: Db, input: WatchSyncPairInput): Promise<WatchSyncState> {
  const draft = watchSyncPairInputSchema.parse(input);
  const servers = await loadMediaServers(db);
  await assertUser(db, servers, draft.plexServerId, draft.plexUserId, "plex");
  await assertUser(db, servers, draft.jellyfinServerId, draft.jellyfinUserId, "jellyfin");
  const timestamp = nowIso();
  const inserted = await db.insert(schema.watchSyncPairs).values({
    plexServerId: draft.plexServerId, plexUserId: draft.plexUserId, jellyfinServerId: draft.jellyfinServerId, jellyfinUserId: draft.jellyfinUserId,
    enabled: draft.enabled ?? true, direction: draft.direction ?? "both", syncWatched: draft.syncWatched ?? null, syncPosition: draft.syncPosition ?? null,
    createdAt: timestamp, updatedAt: timestamp
  }).onConflictDoNothing().returning({ id: schema.watchSyncPairs.id });
  if (!inserted.length) throw new WatchSyncError("These two users are already paired.");
  return getWatchSyncState(db);
}

async function pairRow(db: Db, pairId: number): Promise<PairRow> {
  const pair = (await db.select().from(schema.watchSyncPairs).where(eq(schema.watchSyncPairs.id, pairId)).limit(1))[0];
  if (!pair) throw new WatchSyncNotFound("This user pair no longer exists. Reload the watch sync settings.");
  return pair;
}

export async function updateWatchSyncPair(db: Db, pairId: number, input: WatchSyncPairUpdate): Promise<WatchSyncState> {
  const update = watchSyncPairUpdateSchema.parse(input);
  const pair = await pairRow(db, pairId);
  // Resuming clears the retry delay so the pair syncs on the next pass.
  const resumed = (update.paused === false && pair.paused) || (update.enabled === true && !pair.enabled);
  await db.update(schema.watchSyncPairs).set({ ...update, ...(resumed ? { nextAttemptAt: null, errorCount: 0 } : {}), updatedAt: nowIso() }).where(eq(schema.watchSyncPairs.id, pairId));
  return getWatchSyncState(db);
}

export async function removeWatchSyncPair(db: Db, pairId: number): Promise<WatchSyncState> {
  await pairRow(db, pairId);
  await db.delete(schema.watchSyncPairs).where(eq(schema.watchSyncPairs.id, pairId));
  return getWatchSyncState(db);
}

// The preview gate: a pair writes nothing until its dry run has been reviewed and approved.
export async function approveWatchSyncPair(db: Db, pairId: number): Promise<PairRow> {
  const pair = await pairRow(db, pairId);
  if (!pair.preview) throw new WatchSyncError("Run a preview for this pair before approving it.");
  await db.update(schema.watchSyncPairs).set({ approvedAt: nowIso(), lastError: null, errorCount: 0, nextAttemptAt: null, updatedAt: nowIso() }).where(eq(schema.watchSyncPairs.id, pairId));
  return pairRow(db, pairId);
}

export async function listWatchSyncActivity(db: Db, pairId: number | null, limit = 200): Promise<WatchSyncActivity[]> {
  const rows = await db.select().from(schema.watchSyncActivity)
    .where(pairId === null ? isNotNull(schema.watchSyncActivity.at) : eq(schema.watchSyncActivity.pairId, pairId))
    .orderBy(desc(schema.watchSyncActivity.id)).limit(Math.min(1000, Math.max(1, limit)));
  return rows.map((row) => ({ id: row.id, pairId: row.pairId, at: row.at, level: row.level as WatchSyncActivity["level"], direction: row.direction as WatchSyncActivity["direction"], action: row.action as WatchSyncActivity["action"], linkPath: row.linkPath, message: row.message, jobId: row.jobId }));
}

export async function exportWatchSyncBackup(db: Db, pairId: number): Promise<WatchSyncBackup> {
  const state = await getWatchSyncState(db);
  const pair = state.pairs.find((entry) => entry.id === pairId);
  if (!pair) throw new WatchSyncNotFound("This user pair no longer exists. Reload the watch sync settings.");
  const rows = await db.select().from(schema.watchSyncState).where(eq(schema.watchSyncState.pairId, pairId)).orderBy(asc(schema.watchSyncState.linkPath));
  const side = (watched: boolean | null, positionMs: number | null, at: string | null) => watched === null ? null : { watched, positionMs: positionMs ?? 0, at };
  return {
    format: "srtl-watch-sync", version: 1, exportedAt: nowIso(), plexUserName: pair.plexUserName, jellyfinUserName: pair.jellyfinUserName,
    items: rows.map((row) => ({ linkPath: row.linkPath, plex: side(row.plexWatched, row.plexPositionMs, row.plexAt), jellyfin: side(row.jellyfinWatched, row.jellyfinPositionMs, row.jellyfinAt) }))
  };
}

export async function watchSyncPairExists(db: Db, pairId: number): Promise<void> {
  await pairRow(db, pairId);
}
