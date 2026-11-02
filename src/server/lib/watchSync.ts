import { randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import { and, asc, count, desc, eq, inArray, isNotNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import {
  watchSyncServerLimit,
  type WatchSyncActivity,
  type WatchSyncBackup,
  type WatchSyncDirection,
  type WatchSyncPair,
  type WatchSyncPairInput,
  type WatchSyncPairUpdate,
  type WatchSyncPinStatus,
  type WatchSyncPlexPin,
  type WatchSyncPreview,
  type WatchSyncPrefixMapping,
  type WatchSyncServer,
  type WatchSyncServerInput,
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
import { JellyfinClient } from "./jellyfinClient";
import { PlexServerClient, PlexTvClient } from "./plexClient";
import { WatchSyncError, normalizeServerUrl } from "./watchSyncHttp";

const settingKey = "watchSync";
const settingsLock = 781_889_470;

export interface StoredServer {
  id: string;
  kind: WatchSyncServerKind;
  name: string;
  url: string;
  token: string;
  prefixMappings: WatchSyncPrefixMapping[];
  machineIdentifier: string | null;
  accountName: string | null;
  accountId: string | null;
}

export interface StoredSettings extends WatchSyncSettingsInput {
  clientIdentifier: string;
  servers: StoredServer[];
}

export type PairRow = typeof schema.watchSyncPairs.$inferSelect;
export type UserRow = typeof schema.watchSyncUsers.$inferSelect;

class WatchSyncNotFound extends WatchSyncError {
  override readonly statusCode = 404;
}

const absolutePrefix = z.string().trim().min(1).max(4096).refine((value) => value.startsWith("/") && !/[\\\0]/.test(value) && path.posix.normalize(value) === value.replace(/(.)\/+$/, "$1"), "Use an absolute path prefix without parent-directory segments.")
  .transform((value) => value.replace(/(.)\/+$/, "$1"));
export const watchSyncServerIdSchema = z.string().regex(/^[a-z0-9]{1,40}$/, "Unknown media server.");
export const watchSyncServerInputSchema = z.object({
  name: z.string().trim().min(1, "Enter a name for this server.").max(60, "Use at most 60 characters for the server name."),
  url: z.string().trim().min(1, "Enter the server URL.").max(2000),
  token: z.string().trim().max(512).regex(/^[A-Za-z0-9_.\-~]*$/, "Tokens and API keys contain only letters, numbers, and - _ . ~").optional(),
  prefixMappings: z.array(z.object({ serverPrefix: absolutePrefix, srtlPrefix: absolutePrefix })).max(20).default([])
});
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

const defaults: Omit<StoredSettings, "clientIdentifier"> = { revision: 0, paused: false, intervalMinutes: 5, reconcileIntervalDays: 7, syncWatched: true, syncPosition: true, servers: [] };

export async function loadWatchSyncSettings(db: Db): Promise<StoredSettings> {
  const saved = await getJsonSetting<Partial<StoredSettings>>(db, settingKey, {});
  return { ...defaults, ...saved, clientIdentifier: saved.clientIdentifier ?? "", servers: saved.servers ?? [] };
}

async function locked<T>(db: Db, action: (transaction: Db, settings: StoredSettings) => Promise<T>): Promise<T> {
  return db.transaction(async (transaction) => {
    await transaction.execute(sql`select pg_advisory_xact_lock(${settingsLock})`);
    const settings = await loadWatchSyncSettings(transaction);
    // Plex identifies SRTL by this id for PIN sign-in, so it is created once and kept.
    if (!settings.clientIdentifier) {
      settings.clientIdentifier = randomUUID();
      await setSetting(transaction, settingKey, settings);
    }
    return action(transaction, settings);
  });
}

async function clientIdentifier(db: Db): Promise<string> {
  const settings = await loadWatchSyncSettings(db);
  return settings.clientIdentifier || locked(db, async (_transaction, current) => current.clientIdentifier);
}

export function findServer(settings: StoredSettings, serverId: string, kind?: WatchSyncServerKind): StoredServer {
  const server = settings.servers.find((entry) => entry.id === serverId && (!kind || entry.kind === kind));
  if (!server) throw new WatchSyncNotFound("This media server no longer exists. Reload the watch sync settings.");
  return server;
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

interface ServerStatus { lastCheckedAt: string | null; lastError: string | null }
export async function recordServerStatus(db: Db, serverId: string, error: string | null): Promise<void> {
  await writeCursor(db, `server-status:${serverId}`, JSON.stringify({ lastCheckedAt: nowIso(), lastError: error } satisfies ServerStatus));
}

async function serverStatuses(db: Db): Promise<Map<string, ServerStatus>> {
  const rows = await db.select().from(schema.watchSyncCursors).where(sql`${schema.watchSyncCursors.scope} LIKE 'server-status:%'`);
  return new Map(rows.map((row) => {
    try { return [row.scope.slice("server-status:".length), JSON.parse(row.value) as ServerStatus]; }
    catch { return [row.scope.slice("server-status:".length), { lastCheckedAt: null, lastError: null }]; }
  }));
}

function publicServer(server: StoredServer, status: ServerStatus | undefined): WatchSyncServer {
  return {
    id: server.id, kind: server.kind, name: server.name, url: server.url, hasToken: Boolean(server.token), prefixMappings: server.prefixMappings,
    machineIdentifier: server.machineIdentifier, accountName: server.accountName,
    lastCheckedAt: status?.lastCheckedAt ?? null, lastError: status?.lastError ?? null
  };
}

export async function publicSettings(db: Db): Promise<WatchSyncSettings> {
  const settings = await loadWatchSyncSettings(db);
  const statuses = await serverStatuses(db);
  return {
    revision: settings.revision, paused: settings.paused, intervalMinutes: settings.intervalMinutes, reconcileIntervalDays: settings.reconcileIntervalDays,
    syncWatched: settings.syncWatched, syncPosition: settings.syncPosition,
    servers: settings.servers.map((server) => publicServer(server, statuses.get(server.id))),
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

function validateServerInput(kind: WatchSyncServerKind, input: WatchSyncServerInput) {
  const parsed = watchSyncServerInputSchema.parse(input);
  const service = kind === "plex" ? "Plex" : "Jellyfin";
  return { ...parsed, url: normalizeServerUrl(parsed.url, service) };
}

export async function addWatchSyncServer(db: Db, kind: WatchSyncServerKind, input: WatchSyncServerInput): Promise<WatchSyncState> {
  const draft = validateServerInput(kind, input);
  await locked(db, async (transaction, settings) => {
    if (settings.servers.length >= watchSyncServerLimit) throw new WatchSyncError(`Watch sync supports up to ${watchSyncServerLimit} media servers.`);
    if (settings.servers.some((server) => server.name.toLowerCase() === draft.name.toLowerCase())) throw new WatchSyncError("Another media server already uses this name.");
    const server: StoredServer = { id: randomBytes(6).toString("hex"), kind, name: draft.name, url: draft.url, token: draft.token ?? "", prefixMappings: draft.prefixMappings, machineIdentifier: null, accountName: null, accountId: null };
    await setSetting(transaction, settingKey, { ...settings, servers: [...settings.servers, server] });
  });
  return getWatchSyncState(db);
}

export async function updateWatchSyncServer(db: Db, serverId: string, input: WatchSyncServerInput): Promise<WatchSyncState> {
  await locked(db, async (transaction, settings) => {
    const current = findServer(settings, serverId);
    const draft = validateServerInput(current.kind, input);
    if (settings.servers.some((server) => server.id !== serverId && server.name.toLowerCase() === draft.name.toLowerCase())) throw new WatchSyncError("Another media server already uses this name.");
    if (draft.url !== current.url && !draft.token && current.kind === "jellyfin") throw new WatchSyncError("Enter the API key again when changing the Jellyfin address.");
    const tokenChanged = Boolean(draft.token) && draft.token !== current.token;
    const next: StoredServer = { ...current, name: draft.name, url: draft.url, token: draft.token || current.token, prefixMappings: draft.prefixMappings, ...(tokenChanged ? { machineIdentifier: null, accountName: null, accountId: null } : {}) };
    await setSetting(transaction, settingKey, { ...settings, servers: settings.servers.map((server) => server.id === serverId ? next : server) });
  });
  return getWatchSyncState(db);
}

// Forgets SRTL's records for the server: its users, pairs, item index, and saved snapshots. Nothing on the server changes.
export async function removeWatchSyncServer(db: Db, serverId: string): Promise<WatchSyncState> {
  await locked(db, async (transaction, settings) => {
    findServer(settings, serverId);
    await transaction.delete(schema.watchSyncPairs).where(or(eq(schema.watchSyncPairs.plexServerId, serverId), eq(schema.watchSyncPairs.jellyfinServerId, serverId)));
    await transaction.delete(schema.watchSyncUsers).where(eq(schema.watchSyncUsers.serverId, serverId));
    await transaction.delete(schema.watchSyncItems).where(eq(schema.watchSyncItems.serverId, serverId));
    await transaction.delete(schema.watchSyncCursors).where(sql`${schema.watchSyncCursors.scope} LIKE ${`%:${serverId}`} OR ${schema.watchSyncCursors.scope} LIKE ${`%:${serverId}:%`}`);
    await setSetting(transaction, settingKey, { ...settings, servers: settings.servers.filter((server) => server.id !== serverId) });
  });
  return getWatchSyncState(db);
}

// Plex sign-in: SRTL asks plex.tv for a PIN, the admin approves it at plex.tv, and SRTL polls until the PIN carries a token.
export async function startPlexSignIn(db: Db, serverId: string): Promise<WatchSyncPlexPin> {
  findServer(await loadWatchSyncSettings(db), serverId, "plex");
  const plexTv = new PlexTvClient(await clientIdentifier(db));
  const pin = await plexTv.createPin();
  await writeCursor(db, `plex-pin:${serverId}`, JSON.stringify({ id: pin.id, code: pin.code, expiresAt: pin.expiresAt }));
  return { pinId: pin.id, code: pin.code, authUrl: plexTv.authUrl(pin.code), expiresAt: pin.expiresAt };
}

export async function checkPlexSignIn(db: Db, serverId: string, pinId: number): Promise<WatchSyncPinStatus> {
  findServer(await loadWatchSyncSettings(db), serverId, "plex");
  const raw = await readCursor(db, `plex-pin:${serverId}`);
  const pending = raw ? JSON.parse(raw) as { id: number; expiresAt: string } : null;
  if (!pending || pending.id !== pinId) throw new WatchSyncError("This Plex sign-in is no longer pending. Start it again.");
  const pin = await new PlexTvClient(await clientIdentifier(db)).checkPin(pinId);
  if (!pin.authToken) {
    const expiresAt = Date.parse(pin.expiresAt || pending.expiresAt);
    if (Number.isFinite(expiresAt) && expiresAt <= Date.now()) {
      await writeCursor(db, `plex-pin:${serverId}`, null);
      return { status: "expired" };
    }
    return { status: "waiting" };
  }
  const token = pin.authToken;
  await writeCursor(db, `plex-pin:${serverId}`, null);
  await locked(db, async (transaction, settings) => {
    const current = findServer(settings, serverId, "plex");
    await setSetting(transaction, settingKey, { ...settings, servers: settings.servers.map((server) => server.id === serverId ? { ...current, token, machineIdentifier: null, accountName: null, accountId: null } : server) });
  });
  await discoverWatchSyncUsers(db, serverId).catch(() => undefined);
  return { status: "authorized", state: await getWatchSyncState(db) };
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

async function discoverPlex(db: Db, server: StoredServer, identifier: string): Promise<void> {
  if (!server.token) throw new WatchSyncError("Sign in with Plex or paste a Plex token first.");
  const pms = new PlexServerClient(server.url, server.token, identifier);
  const { machineIdentifier } = await pms.identity();
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
  await locked(db, async (transaction, settings) => {
    const current = settings.servers.find((entry) => entry.id === server.id);
    if (!current || current.token !== server.token) return;
    await setSetting(transaction, settingKey, { ...settings, servers: settings.servers.map((entry) => entry.id === server.id ? { ...current, machineIdentifier, accountName: account.title, accountId: account.id } : entry) });
  });
}

async function discoverJellyfin(db: Db, server: StoredServer, identifier: string): Promise<void> {
  if (!server.token) throw new WatchSyncError("Enter a Jellyfin API key first.");
  const client = new JellyfinClient(server.url, server.token, identifier);
  await client.systemInfo();
  const users = await client.users();
  await saveUsers(db, server.id, users.map((user) => ({
    externalId: user.id, name: user.name, username: null, kind: "user" as const, accountId: null, accessToken: null,
    available: !user.disabled, note: user.disabled ? "Disabled in Jellyfin." : null
  })));
}

// Tests the connection and refreshes the server's user list (and, for Plex, every user's access token).
export async function discoverWatchSyncUsers(db: Db, serverId: string): Promise<WatchSyncState> {
  const settings = await loadWatchSyncSettings(db);
  const server = findServer(settings, serverId);
  const identifier = await clientIdentifier(db);
  try {
    if (server.kind === "plex") await discoverPlex(db, server, identifier);
    else await discoverJellyfin(db, server, identifier);
    await recordServerStatus(db, server.id, null);
  } catch (error) {
    await recordServerStatus(db, server.id, error instanceof Error ? error.message : "Connection failed.");
    throw error;
  }
  return getWatchSyncState(db);
}

// Lowercase letters and digits only, so ElJefe_03 and eljefe03 compare equal; the letters-only form also matches Eljefe.
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
  const serverIds = new Set(settings.servers.map((server) => server.id));
  const users = (await db.select().from(schema.watchSyncUsers).orderBy(asc(schema.watchSyncUsers.name))).filter((user) => serverIds.has(user.serverId));
  const pairs = await db.select().from(schema.watchSyncPairs).orderBy(asc(schema.watchSyncPairs.id));
  const tracked = new Map((await db.select({ pairId: schema.watchSyncState.pairId, total: count() }).from(schema.watchSyncState).groupBy(schema.watchSyncState.pairId)).map((row) => [row.pairId, Number(row.total)]));
  const indexed = await db.select({ serverId: schema.watchSyncItems.serverId, total: count() }).from(schema.watchSyncItems).groupBy(schema.watchSyncItems.serverId);
  const jobs = await db.select({ id: schema.jobs.id, status: schema.jobs.status, options: schema.jobs.options }).from(schema.jobs)
    .where(and(eq(schema.jobs.type, "watch_sync"), inArray(schema.jobs.status, ["queued", "running"]))).orderBy(asc(schema.jobs.id));
  const userName = (serverId: string, externalId: string) => users.find((user) => user.serverId === serverId && user.externalId === externalId)?.name ?? externalId;
  const kinds = new Map(settings.servers.map((server) => [server.id, server.kind]));
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

async function assertUser(db: Db, settings: StoredSettings, serverId: string, userId: string, kind: WatchSyncServerKind): Promise<void> {
  findServer(settings, serverId, kind);
  const user = (await db.select().from(schema.watchSyncUsers).where(and(eq(schema.watchSyncUsers.serverId, serverId), eq(schema.watchSyncUsers.externalId, userId))).limit(1))[0];
  if (!user) throw new WatchSyncError(`Unknown ${kind === "plex" ? "Plex" : "Jellyfin"} user. Discover users again.`);
}

export async function createWatchSyncPair(db: Db, input: WatchSyncPairInput): Promise<WatchSyncState> {
  const draft = watchSyncPairInputSchema.parse(input);
  const settings = await loadWatchSyncSettings(db);
  await assertUser(db, settings, draft.plexServerId, draft.plexUserId, "plex");
  await assertUser(db, settings, draft.jellyfinServerId, draft.jellyfinUserId, "jellyfin");
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
