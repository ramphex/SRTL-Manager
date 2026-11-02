import path from "node:path";
import { and, asc, eq, gt, inArray, isNotNull, isNull, lt, lte, or, sql } from "drizzle-orm";
import type {
  WatchSyncAction,
  WatchSyncBackup,
  WatchSyncCounts,
  WatchSyncDirection,
  WatchSyncJobMode,
  WatchSyncPrefixMapping,
  WatchSyncPreview,
  WatchSyncPreviewSample,
  WatchSyncSideState,
  WatchSyncTransfer
} from "../../shared/watchSync";
import { nowIso, type Db } from "../db/database";
import * as schema from "../db/schema";
import type { JobContext } from "../jobs/jobRunner";
import { JellyfinClient, type JellyfinItem } from "./jellyfinClient";
import { PlexServerClient, type PlexItem } from "./plexClient";
import { WatchSyncError } from "./watchSyncHttp";
import { findServer, loadWatchSyncSettings, readCursor, recordServerStatus, writeCursor, type PairRow, type StoredServer, type StoredSettings, type UserRow } from "./watchSync";

type Side = "plex" | "jellyfin";
export interface WatchSyncFeatures { watched: boolean; position: boolean }
export interface WatchSyncSnapshot { plex: WatchSyncSideState | null; jellyfin: WatchSyncSideState | null }
export interface WatchSyncWrite { target: Side; action: WatchSyncAction; desired: WatchSyncSideState }
export interface WatchSyncDecision { write: WatchSyncWrite | null; snapshot: { plex: WatchSyncSideState; jellyfin: WatchSyncSideState } | null }

// Positions closer than this count as the same place; players report positions every few seconds.
export const positionToleranceMs = 30_000;
const cursorOverlapMs = 2 * 60_000;
const pageSize = 200;
const lookupBatchSize = 50;
const recheckBatchSize = 200;
const sampleLimit = 50;
const activityRetentionMs = 30 * 86400_000;
const reconcileRetryMs = 6 * 3600_000;
const maxConsecutiveWriteFailures = 5;
// Tests set the pause to 0; it spaces out page requests so a full pass never floods a server.
export const watchSyncPacing = { pageDelayMs: 50 };

const otherSide = (side: Side): Side => side === "plex" ? "jellyfin" : "plex";
const transferFrom = (side: Side): WatchSyncTransfer => side === "plex" ? "plex_to_jellyfin" : "jellyfin_to_plex";
const sideLabel = (side: Side) => side === "plex" ? "Plex" : "Jellyfin";

function effectivePosition(state: WatchSyncSideState): number {
  return state.watched ? 0 : state.positionMs;
}

export function sameWatchState(left: WatchSyncSideState, right: WatchSyncSideState, features: WatchSyncFeatures): boolean {
  if (features.watched && left.watched !== right.watched) return false;
  return !features.position || Math.abs(effectivePosition(left) - effectivePosition(right)) <= positionToleranceMs;
}

function isEmpty(state: WatchSyncSideState, features: WatchSyncFeatures): boolean {
  return !(features.watched && state.watched) && !(features.position && effectivePosition(state) > positionToleranceMs);
}

function allows(direction: WatchSyncDirection, from: Side): boolean {
  return direction === "both" || direction === transferFrom(from);
}

function timeOf(state: WatchSyncSideState): number {
  const value = state.at ? Date.parse(state.at) : Number.NaN;
  return Number.isFinite(value) ? value : Number.NEGATIVE_INFINITY;
}

// The most recent activity wins; without timestamps a watched state beats an unwatched one.
function newer(plex: WatchSyncSideState, jellyfin: WatchSyncSideState): Side {
  const plexTime = timeOf(plex);
  const jellyfinTime = timeOf(jellyfin);
  if (plexTime !== jellyfinTime) return plexTime > jellyfinTime ? "plex" : "jellyfin";
  if (plex.watched !== jellyfin.watched) return plex.watched ? "plex" : "jellyfin";
  return "plex";
}

function planWrite(from: WatchSyncSideState, to: WatchSyncSideState, features: WatchSyncFeatures): Omit<WatchSyncWrite, "target"> | null {
  if (features.watched && from.watched && !to.watched) return { action: "watched", desired: { watched: true, positionMs: 0, at: from.at } };
  if (features.watched && !from.watched && to.watched) return { action: "unwatched", desired: { watched: false, positionMs: features.position ? from.positionMs : 0, at: from.at } };
  if (features.position && !from.watched && !to.watched && Math.abs(from.positionMs - to.positionMs) > positionToleranceMs) {
    return { action: "position", desired: { watched: false, positionMs: from.positionMs, at: from.at } };
  }
  return null;
}

// Three-way comparison of one path: each side's current state against what it was when the pair last synced.
// A side changed when it differs from its snapshot; without a snapshot, only a watched item or a resume
// position counts as a change, so a first sync adds history and never removes it.
export function decideWatchSync(direction: WatchSyncDirection, features: WatchSyncFeatures, plex: WatchSyncSideState, jellyfin: WatchSyncSideState, snapshot: WatchSyncSnapshot | null): WatchSyncDecision {
  const changed = (current: WatchSyncSideState, previous: WatchSyncSideState | null | undefined) => previous ? !sameWatchState(current, previous, features) : !isEmpty(current, features);
  const plexChanged = changed(plex, snapshot?.plex);
  const jellyfinChanged = changed(jellyfin, snapshot?.jellyfin);
  if (!plexChanged && !jellyfinChanged) return { write: null, snapshot: snapshot?.plex && snapshot.jellyfin ? null : isEmpty(plex, features) && isEmpty(jellyfin, features) ? null : { plex, jellyfin } };
  let source: Side | null;
  if (plexChanged && jellyfinChanged) {
    if (sameWatchState(plex, jellyfin, features)) source = null;
    else if (direction === "both") source = newer(plex, jellyfin);
    else source = direction === "plex_to_jellyfin" ? "plex" : "jellyfin";
  } else {
    const changedSide: Side = plexChanged ? "plex" : "jellyfin";
    source = allows(direction, changedSide) ? changedSide : null;
  }
  const acknowledged = { write: null, snapshot: { plex, jellyfin } };
  if (!source) return acknowledged;
  const target = otherSide(source);
  const current = { plex, jellyfin };
  const plan = planWrite(current[source], current[target], features);
  if (!plan) return acknowledged;
  const initial = !snapshot?.plex || !snapshot.jellyfin;
  if (initial && plan.action === "unwatched") return acknowledged;
  return { write: { target, ...plan }, snapshot: { ...current, [target]: plan.desired } as { plex: WatchSyncSideState; jellyfin: WatchSyncSideState } };
}

// Maps a path as one server sees it to SRTL's symlink path using the longest matching prefix.
export function toSrtlPath(serverPath: string, mappings: WatchSyncPrefixMapping[]): string {
  const matches = mappings.filter((mapping) => mapping.serverPrefix === "/" || serverPath === mapping.serverPrefix || serverPath.startsWith(`${mapping.serverPrefix}/`));
  const best = matches.sort((left, right) => right.serverPrefix.length - left.serverPrefix.length)[0];
  if (!best) return serverPath;
  const rest = best.serverPrefix === "/" ? serverPath.slice(1) : serverPath.slice(best.serverPrefix.length).replace(/^\//, "");
  return rest ? path.posix.join(best.srtlPrefix, rest) : best.srtlPrefix;
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let offset = 0; offset < items.length; offset += size) result.push(items.slice(offset, offset + size));
  return result;
}

function pause(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

function assertNotAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new WatchSyncError("Watch sync was cancelled.");
}

// Only SRTL's own media symlinks take part; anything else a server lists is skipped and counted.
async function srtlLinkPaths(db: Db, paths: Iterable<string>): Promise<Set<string>> {
  const known = new Set<string>();
  for (const batch of chunks([...new Set(paths)], 1000)) {
    const rows = await db.select({ linkPath: schema.mediaLinks.linkPath }).from(schema.mediaLinks).where(and(inArray(schema.mediaLinks.linkPath, batch), eq(schema.mediaLinks.isMedia, true)));
    for (const row of rows) known.add(row.linkPath);
  }
  return known;
}

async function rememberItems(db: Db, serverId: string, entries: Map<string, string>): Promise<void> {
  const timestamp = nowIso();
  for (const batch of chunks([...entries], 500)) {
    await db.insert(schema.watchSyncItems).values(batch.map(([linkPath, itemId]) => ({ serverId, linkPath, itemId, seenAt: timestamp })))
      .onConflictDoUpdate({ target: [schema.watchSyncItems.serverId, schema.watchSyncItems.linkPath], set: { itemId: sql`excluded.item_id`, seenAt: sql`excluded.seen_at` } });
  }
}

async function itemIdsForPaths(db: Db, serverId: string, paths: string[]): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  for (const batch of chunks(paths, 1000)) {
    const rows = await db.select().from(schema.watchSyncItems).where(and(eq(schema.watchSyncItems.serverId, serverId), inArray(schema.watchSyncItems.linkPath, batch)));
    for (const row of rows) result.set(row.linkPath, row.itemId);
  }
  return result;
}

async function pathsForItemIds(db: Db, serverId: string, itemIds: string[]): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>();
  for (const batch of chunks([...new Set(itemIds)], 1000)) {
    const rows = await db.select().from(schema.watchSyncItems).where(and(eq(schema.watchSyncItems.serverId, serverId), inArray(schema.watchSyncItems.itemId, batch)));
    for (const row of rows) result.set(row.itemId, [...(result.get(row.itemId) ?? []), row.linkPath]);
  }
  return result;
}

class ServerFailure extends WatchSyncError {
  constructor(readonly serverId: string, message: string, readonly retryableFailure: boolean) { super(message, null, retryableFailure); }
}

interface PairRuntime {
  pair: PairRow;
  label: string;
  plexServer: StoredServer;
  jellyfinServer: StoredServer;
  plexUser: UserRow;
  jellyfinUser: UserRow;
  features: WatchSyncFeatures;
  direction: WatchSyncDirection;
  plex: PlexServerClient;
  plexOwner: PlexServerClient;
  jellyfin: JellyfinClient;
  signal?: AbortSignal;
}

async function onServer<T>(server: StoredServer, action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof ServerFailure) throw error;
    const message = error instanceof Error ? error.message : "Request failed.";
    throw new ServerFailure(server.id, `${server.name}: ${message}`, error instanceof WatchSyncError && error.retryable);
  }
}

async function loadRuntime(db: Db, settings: StoredSettings, pair: PairRow, signal?: AbortSignal): Promise<PairRuntime> {
  const plexServer = findServer(settings, pair.plexServerId, "plex");
  const jellyfinServer = findServer(settings, pair.jellyfinServerId, "jellyfin");
  const user = async (serverId: string, externalId: string) => (await db.select().from(schema.watchSyncUsers).where(and(eq(schema.watchSyncUsers.serverId, serverId), eq(schema.watchSyncUsers.externalId, externalId))).limit(1))[0];
  const plexUser = await user(pair.plexServerId, pair.plexUserId);
  const jellyfinUser = await user(pair.jellyfinServerId, pair.jellyfinUserId);
  if (!plexUser || !jellyfinUser) throw new WatchSyncError("A user in this pair is no longer known. Discover users again.");
  if (!plexServer.token) throw new WatchSyncError(`${plexServer.name} is not signed in to Plex.`);
  if (!jellyfinServer.token) throw new WatchSyncError(`${jellyfinServer.name} has no Jellyfin API key.`);
  if (!plexUser.available || !plexUser.accessToken) throw new WatchSyncError(`${plexUser.name} has no access token for ${plexServer.name}. ${plexUser.note ?? "Discover users again."}`);
  if (!jellyfinUser.available) throw new WatchSyncError(`${jellyfinUser.name} is not available on ${jellyfinServer.name}.`);
  return {
    pair,
    label: `${plexUser.name} ↔ ${jellyfinUser.name}`,
    plexServer,
    jellyfinServer,
    plexUser,
    jellyfinUser,
    features: { watched: pair.syncWatched ?? settings.syncWatched, position: pair.syncPosition ?? settings.syncPosition },
    direction: pair.direction as WatchSyncDirection,
    plex: new PlexServerClient(plexServer.url, plexUser.accessToken, settings.clientIdentifier, signal),
    plexOwner: new PlexServerClient(plexServer.url, plexServer.token, settings.clientIdentifier, signal),
    jellyfin: new JellyfinClient(jellyfinServer.url, jellyfinServer.token, settings.clientIdentifier, signal),
    signal
  };
}

interface Observation {
  linkPath: string;
  title: string;
  plexId?: string;
  plex?: WatchSyncSideState;
  jellyfinId?: string;
  jellyfin?: WatchSyncSideState;
}

interface Collected {
  observations: Map<string, Observation>;
  // Items the servers listed, and those that are not SRTL paths.
  plexItems: number;
  jellyfinItems: number;
  skipped: number;
}

function emptyCollected(): Collected {
  return { observations: new Map(), plexItems: 0, jellyfinItems: 0, skipped: 0 };
}

function observation(collected: Collected, linkPath: string, title: string): Observation {
  let entry = collected.observations.get(linkPath);
  if (!entry) {
    entry = { linkPath, title };
    collected.observations.set(linkPath, entry);
  }
  return entry;
}

// Adds listed items with their paths and states, and records each SRTL path in the server's item index.
async function addPlexItems(db: Db, rt: PairRuntime, collected: Collected, items: PlexItem[], withState: boolean): Promise<void> {
  const mapped = items.map((item) => ({ item, paths: item.files.map((file) => toSrtlPath(file, rt.plexServer.prefixMappings)) }));
  const known = await srtlLinkPaths(db, mapped.flatMap((entry) => entry.paths));
  const index = new Map<string, string>();
  for (const { item, paths } of mapped) {
    collected.plexItems += 1;
    const srtl = paths.filter((entry) => known.has(entry));
    if (!srtl.length) { collected.skipped += 1; continue; }
    for (const linkPath of srtl) {
      index.set(linkPath, item.ratingKey);
      const entry = observation(collected, linkPath, item.title);
      entry.plexId = item.ratingKey;
      if (withState) entry.plex = item.state;
    }
  }
  await rememberItems(db, rt.plexServer.id, index);
}

async function addJellyfinItems(db: Db, rt: PairRuntime, collected: Collected, items: JellyfinItem[], withState: boolean): Promise<void> {
  const mapped = items.map((item) => ({ item, linkPath: item.path ? toSrtlPath(item.path, rt.jellyfinServer.prefixMappings) : null }));
  const known = await srtlLinkPaths(db, mapped.flatMap((entry) => entry.linkPath ? [entry.linkPath] : []));
  const index = new Map<string, string>();
  for (const { item, linkPath } of mapped) {
    collected.jellyfinItems += 1;
    if (!linkPath || !known.has(linkPath)) { collected.skipped += 1; continue; }
    index.set(linkPath, item.id);
    const entry = observation(collected, linkPath, item.title);
    entry.jellyfinId = item.id;
    if (withState) entry.jellyfin = item.state;
  }
  await rememberItems(db, rt.jellyfinServer.id, index);
}

async function addPlexIds(db: Db, rt: PairRuntime, collected: Collected, ratingKeys: string[]): Promise<void> {
  const paths = await pathsForItemIds(db, rt.plexServer.id, ratingKeys);
  for (const [ratingKey, linkPaths] of paths) for (const linkPath of linkPaths) observation(collected, linkPath, path.posix.basename(linkPath)).plexId = ratingKey;
}

async function plexMetadata(rt: PairRuntime, keys: string[]): Promise<PlexItem[]> {
  try {
    return await rt.plex.metadata(keys);
  } catch (error) {
    // One deleted item fails the whole batch, so a failed batch is retried an item at a time.
    if (!(error instanceof WatchSyncError) || error.httpStatus !== 404 || keys.length === 1) {
      if (error instanceof WatchSyncError && error.httpStatus === 404) return [];
      throw error;
    }
    const items: PlexItem[] = [];
    for (const key of keys) items.push(...await plexMetadata(rt, [key]));
    return items;
  }
}

// Fills in whichever side an observation lacks by looking its path up in that server's index and reading the current state.
async function completeObservations(db: Db, rt: PairRuntime, collected: Collected): Promise<void> {
  const all = [...collected.observations.values()];
  const plexIds = await itemIdsForPaths(db, rt.plexServer.id, all.filter((entry) => !entry.plexId).map((entry) => entry.linkPath));
  const jellyfinIds = await itemIdsForPaths(db, rt.jellyfinServer.id, all.filter((entry) => !entry.jellyfinId).map((entry) => entry.linkPath));
  for (const entry of all) {
    entry.plexId ??= plexIds.get(entry.linkPath);
    entry.jellyfinId ??= jellyfinIds.get(entry.linkPath);
  }
  const plexKeys = [...new Set(all.filter((entry) => entry.plexId && !entry.plex && entry.jellyfinId).map((entry) => entry.plexId!))];
  for (const batch of chunks(plexKeys, lookupBatchSize)) {
    assertNotAborted(rt.signal);
    const items = await onServer(rt.plexServer, () => plexMetadata(rt, batch));
    const states = new Map(items.map((item) => [item.ratingKey, item]));
    for (const entry of all) {
      const item = entry.plexId ? states.get(entry.plexId) : undefined;
      if (item && !entry.plex) { entry.plex = item.state; entry.title = item.title; }
    }
  }
  const jellyfinKeys = [...new Set(all.filter((entry) => entry.jellyfinId && !entry.jellyfin && entry.plexId).map((entry) => entry.jellyfinId!))];
  for (const batch of chunks(jellyfinKeys, lookupBatchSize)) {
    assertNotAborted(rt.signal);
    const page = await onServer(rt.jellyfinServer, () => rt.jellyfin.itemsPage(rt.jellyfinUser.externalId, 0, batch.length, { ids: batch }));
    const states = new Map(page.items.map((item) => [item.id, item]));
    for (const entry of all) {
      const item = entry.jellyfinId ? states.get(entry.jellyfinId) : undefined;
      if (item && !entry.jellyfin) { entry.jellyfin = item.state; if (entry.title === path.posix.basename(entry.linkPath)) entry.title = item.title; }
    }
  }
}

async function loadSnapshots(db: Db, pairId: number, paths: string[]): Promise<Map<string, WatchSyncSnapshot>> {
  const result = new Map<string, WatchSyncSnapshot>();
  for (const batch of chunks(paths, 1000)) {
    const rows = await db.select().from(schema.watchSyncState).where(and(eq(schema.watchSyncState.pairId, pairId), inArray(schema.watchSyncState.linkPath, batch)));
    for (const row of rows) {
      result.set(row.linkPath, {
        plex: row.plexWatched === null ? null : { watched: row.plexWatched, positionMs: row.plexPositionMs ?? 0, at: row.plexAt },
        jellyfin: row.jellyfinWatched === null ? null : { watched: row.jellyfinWatched, positionMs: row.jellyfinPositionMs ?? 0, at: row.jellyfinAt }
      });
    }
  }
  return result;
}

async function saveSnapshots(db: Db, pairId: number, entries: Array<{ linkPath: string; plex: WatchSyncSideState | null; jellyfin: WatchSyncSideState | null }>): Promise<void> {
  const timestamp = nowIso();
  for (const batch of chunks(entries, 500)) {
    if (!batch.length) continue;
    await db.insert(schema.watchSyncState).values(batch.map((entry) => ({
      pairId, linkPath: entry.linkPath, syncedAt: timestamp,
      plexWatched: entry.plex?.watched ?? null, plexPositionMs: entry.plex ? entry.plex.positionMs : null, plexAt: entry.plex?.at ?? null,
      jellyfinWatched: entry.jellyfin?.watched ?? null, jellyfinPositionMs: entry.jellyfin ? entry.jellyfin.positionMs : null, jellyfinAt: entry.jellyfin?.at ?? null
    }))).onConflictDoUpdate({
      target: [schema.watchSyncState.pairId, schema.watchSyncState.linkPath],
      set: {
        // A side left out keeps its snapshot (a restore writes only one side).
        plexWatched: sql`COALESCE(excluded.plex_watched, watch_sync_state.plex_watched)`,
        plexPositionMs: sql`CASE WHEN excluded.plex_watched IS NULL THEN watch_sync_state.plex_position_ms ELSE excluded.plex_position_ms END`,
        plexAt: sql`CASE WHEN excluded.plex_watched IS NULL THEN watch_sync_state.plex_at ELSE excluded.plex_at END`,
        jellyfinWatched: sql`COALESCE(excluded.jellyfin_watched, watch_sync_state.jellyfin_watched)`,
        jellyfinPositionMs: sql`CASE WHEN excluded.jellyfin_watched IS NULL THEN watch_sync_state.jellyfin_position_ms ELSE excluded.jellyfin_position_ms END`,
        jellyfinAt: sql`CASE WHEN excluded.jellyfin_watched IS NULL THEN watch_sync_state.jellyfin_at ELSE excluded.jellyfin_at END`,
        syncedAt: sql`excluded.synced_at`
      }
    });
  }
}

function formatPosition(ms: number): string {
  const seconds = Math.round(ms / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = String(seconds % 60).padStart(2, "0");
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${rest}` : `${minutes}:${rest}`;
}

function describe(write: WatchSyncWrite, title: string): string {
  const from = sideLabel(otherSide(write.target));
  const to = sideLabel(write.target);
  if (write.action === "watched") return `Marked "${title}" watched on ${to} (from ${from}).`;
  if (write.action === "unwatched") return `Marked "${title}" unwatched on ${to} (from ${from}).`;
  return write.desired.positionMs > positionToleranceMs ? `Set "${title}" to resume at ${formatPosition(write.desired.positionMs)} on ${to} (from ${from}).` : `Cleared the resume position of "${title}" on ${to} (from ${from}).`;
}

async function applyWrite(rt: PairRuntime, write: WatchSyncWrite, itemId: string, current: WatchSyncSideState): Promise<void> {
  const { desired } = write;
  if (write.target === "plex") {
    await onServer(rt.plexServer, async () => {
      if (write.action === "watched") return rt.plex.scrobble(itemId);
      if (write.action === "unwatched" || desired.positionMs <= positionToleranceMs) await rt.plex.unscrobble(itemId);
      if (desired.positionMs > positionToleranceMs) await rt.plex.progress(itemId, desired.positionMs);
    });
    return;
  }
  const userId = rt.jellyfinUser.externalId;
  await onServer(rt.jellyfinServer, async () => {
    if (write.action === "watched") return rt.jellyfin.markPlayed(userId, itemId, desired.at);
    if (write.action === "unwatched" && current.watched) await rt.jellyfin.markUnplayed(userId, itemId);
    if (desired.positionMs > positionToleranceMs || current.positionMs > positionToleranceMs) await rt.jellyfin.setPosition(userId, itemId, desired.positionMs, desired.at);
  });
}

function emptyCounts(): Record<WatchSyncTransfer, WatchSyncCounts> {
  return { plex_to_jellyfin: { watched: 0, unwatched: 0, position: 0 }, jellyfin_to_plex: { watched: 0, unwatched: 0, position: 0 } };
}

interface SyncOutcome {
  matched: number;
  counts: Record<WatchSyncTransfer, WatchSyncCounts>;
  samples: WatchSyncPreviewSample[];
  written: number;
  failed: number;
}

interface Reporter {
  jobId: number | null;
  event?: (level: "info" | "warn" | "error", message: string, data?: unknown) => Promise<void>;
}

async function recordActivity(db: Db, entries: Array<typeof schema.watchSyncActivity.$inferInsert>): Promise<void> {
  for (const batch of chunks(entries, 200)) if (batch.length) await db.insert(schema.watchSyncActivity).values(batch);
}

// Decides every observed path that both servers know and, unless previewing, writes the changes and the new snapshots.
// A full pass already read both libraries, so it skips the per-item lookups of the side an item is missing from.
async function syncObservations(db: Db, rt: PairRuntime, collected: Collected, preview: boolean, reporter: Reporter, complete = true): Promise<SyncOutcome> {
  if (complete) await completeObservations(db, rt, collected);
  const ready = [...collected.observations.values()].filter((entry) => entry.plex && entry.jellyfin && entry.plexId && entry.jellyfinId);
  const snapshots = await loadSnapshots(db, rt.pair.id, ready.map((entry) => entry.linkPath));
  const outcome: SyncOutcome = { matched: ready.length, counts: emptyCounts(), samples: [], written: 0, failed: 0 };
  const done = new Map<string, boolean>();
  const pendingSnapshots: Parameters<typeof saveSnapshots>[2] = [];
  let consecutiveFailures = 0;
  for (const entry of ready) {
    assertNotAborted(rt.signal);
    const decision = decideWatchSync(rt.direction, rt.features, entry.plex!, entry.jellyfin!, snapshots.get(entry.linkPath) ?? null);
    if (decision.write) {
      const transfer = transferFrom(otherSide(decision.write.target));
      outcome.counts[transfer][decision.write.action] += 1;
      if (outcome.samples.length < sampleLimit) outcome.samples.push({ direction: transfer, action: decision.write.action, title: entry.title, linkPath: entry.linkPath, positionMs: decision.write.action === "position" ? decision.write.desired.positionMs : null });
    }
    if (preview) continue;
    if (decision.write) {
      const write = decision.write;
      const itemId = write.target === "plex" ? entry.plexId! : entry.jellyfinId!;
      const key = `${write.target}\0${itemId}`;
      // Two SRTL paths can be versions of one server item; it is written once.
      if (!done.has(key)) {
        try {
          await applyWrite(rt, write, itemId, write.target === "plex" ? entry.plex! : entry.jellyfin!);
          done.set(key, true);
          consecutiveFailures = 0;
          outcome.written += 1;
          const message = describe(write, entry.title);
          await recordActivity(db, [{ pairId: rt.pair.id, at: nowIso(), level: "info", direction: transferFrom(otherSide(write.target)), action: write.action, linkPath: entry.linkPath, message, jobId: reporter.jobId }]);
          if (reporter.event && outcome.written <= 500) await reporter.event("info", `${rt.label}: ${message}`, { pairId: rt.pair.id, linkPath: entry.linkPath });
        } catch (error) {
          done.set(key, false);
          outcome.failed += 1;
          consecutiveFailures += 1;
          const message = `Could not update "${entry.title}" on ${sideLabel(write.target)}: ${error instanceof Error ? error.message : "request failed"}`;
          await recordActivity(db, [{ pairId: rt.pair.id, at: nowIso(), level: "error", direction: transferFrom(otherSide(write.target)), action: write.action, linkPath: entry.linkPath, message, jobId: reporter.jobId }]);
          if (reporter.event) await reporter.event("warn", `${rt.label}: ${message}`, { pairId: rt.pair.id, linkPath: entry.linkPath });
          // A server that keeps failing is down; the rest of the pass waits for the next attempt.
          if (consecutiveFailures >= maxConsecutiveWriteFailures && error instanceof WatchSyncError && error.retryable) {
            await saveSnapshots(db, rt.pair.id, pendingSnapshots);
            throw error;
          }
        }
      }
      // A failed write keeps the old snapshot, so the change is retried next time.
      if (done.get(key) && decision.snapshot) pendingSnapshots.push({ linkPath: entry.linkPath, ...decision.snapshot });
    } else if (decision.snapshot) {
      pendingSnapshots.push({ linkPath: entry.linkPath, ...decision.snapshot });
    }
  }
  if (!preview) await saveSnapshots(db, rt.pair.id, pendingSnapshots);
  return outcome;
}

async function listPlexLibrary(db: Db, rt: PairRuntime, collected: Collected, onPage: () => Promise<void>): Promise<Date | null> {
  let serverTime: Date | null = null;
  const sections = await onServer(rt.plexServer, () => rt.plex.sections());
  for (const section of sections) {
    const type = section.type === "movie" ? 1 : 4;
    for (let start = 0; ; start += pageSize) {
      assertNotAborted(rt.signal);
      const page = await onServer(rt.plexServer, () => rt.plex.listPage(section.key, type, start, pageSize));
      serverTime ??= page.serverTime;
      await addPlexItems(db, rt, collected, page.items, true);
      await onPage();
      if (page.count < pageSize || (page.total !== null && start + pageSize >= page.total)) break;
      await pause(watchSyncPacing.pageDelayMs, rt.signal);
    }
  }
  return serverTime;
}

async function listJellyfinLibrary(db: Db, rt: PairRuntime, collected: Collected, onPage: () => Promise<void>, filter: { minDateLastSavedForUser?: string; minDateLastSaved?: string } = {}, withState = true): Promise<Date | null> {
  let serverTime: Date | null = null;
  for (let start = 0; ; start += pageSize) {
    assertNotAborted(rt.signal);
    const page = await onServer(rt.jellyfinServer, () => rt.jellyfin.itemsPage(rt.jellyfinUser.externalId, start, pageSize, filter));
    serverTime ??= page.serverTime;
    await addJellyfinItems(db, rt, collected, page.items, withState);
    await onPage();
    if (page.count < pageSize || (page.total !== null && start + pageSize >= page.total)) break;
    await pause(watchSyncPacing.pageDelayMs, rt.signal);
  }
  return serverTime;
}

function epochSeconds(date: Date | null): number {
  return Math.floor((date ?? new Date()).getTime() / 1000);
}

// Everything that may have changed for this pair since its cursors, plus a rolling slice of its synced items:
// Plex reports no change when an item is marked unwatched, so each pass re-reads a few hundred of them.
async function collectIncremental(db: Db, rt: PairRuntime): Promise<{ collected: Collected; plexCursor: string; jellyfinCursor: string; recheckCursor: string }> {
  const collected = emptyCollected();
  const noop = async () => undefined;
  const plexSince = Math.max(0, Number(rt.pair.plexCursor ?? 0) - cursorOverlapMs / 1000);
  const jellyfinSince = new Date(Math.max(0, Date.parse(rt.pair.jellyfinCursor ?? "") - cursorOverlapMs || 0)).toISOString();

  let plexTime: Date | null = null;
  const sections = await onServer(rt.plexServer, () => rt.plex.sections());
  for (const section of sections) {
    const type = section.type === "movie" ? 1 : 4;
    for (const [filter, withState] of [[`lastViewedAt>>=${plexSince}`, true], [`addedAt>>=${plexSince}`, false]] as const) {
      for (let start = 0; ; start += pageSize) {
        assertNotAborted(rt.signal);
        const page = await onServer(rt.plexServer, () => rt.plex.listPage(section.key, type, start, pageSize, filter));
        plexTime ??= page.serverTime;
        await addPlexItems(db, rt, collected, page.items, withState);
        if (page.count < pageSize) break;
      }
    }
  }
  await addPlexItems(db, rt, collected, await onServer(rt.plexServer, () => rt.plex.onDeck()), true);
  // Play history needs the owner's token and repeats what lastViewedAt already found, so it is best effort.
  if (rt.plexUser.accountId) {
    const history: string[] = [];
    try {
      for (let start = 0; start < 5000; start += pageSize) {
        const page = await rt.plexOwner.historyPage(plexSince, start, pageSize);
        history.push(...page.entries.filter((entry) => entry.accountId === rt.plexUser.accountId).map((entry) => entry.ratingKey));
        if (page.count < pageSize) break;
      }
    } catch (error) {
      if (rt.signal?.aborted) throw error;
    }
    await addPlexIds(db, rt, collected, history);
  }
  // Only items this pair has synced can be un-watched or lose their position, so the recheck walks its snapshots.
  const recheck = await db.select({ linkPath: schema.watchSyncState.linkPath }).from(schema.watchSyncState)
    .where(and(eq(schema.watchSyncState.pairId, rt.pair.id), gt(schema.watchSyncState.linkPath, rt.pair.recheckCursor ?? "")))
    .orderBy(asc(schema.watchSyncState.linkPath)).limit(recheckBatchSize);
  for (const row of recheck) observation(collected, row.linkPath, path.posix.basename(row.linkPath));
  const recheckCursor = recheck.length < recheckBatchSize ? "" : recheck[recheck.length - 1]!.linkPath;

  const jellyfinTime = await listJellyfinLibrary(db, rt, collected, noop, { minDateLastSavedForUser: jellyfinSince });
  await listJellyfinLibrary(db, rt, collected, noop, { minDateLastSaved: jellyfinSince }, false);
  return { collected, plexCursor: String(epochSeconds(plexTime)), jellyfinCursor: (jellyfinTime ?? new Date()).toISOString(), recheckCursor };
}

function backoffAt(pair: PairRow, intervalMinutes: number): string {
  const delay = Math.min(3600_000, intervalMinutes * 60_000 * 2 ** Math.min(pair.errorCount, 6));
  return new Date(Date.now() + delay).toISOString();
}

async function recordPairFailure(db: Db, pair: PairRow, error: unknown, intervalMinutes: number, jobId: number | null): Promise<string> {
  const message = error instanceof Error ? error.message : "Watch sync failed.";
  await db.update(schema.watchSyncPairs).set({ lastError: message, errorCount: pair.errorCount + 1, nextAttemptAt: backoffAt(pair, intervalMinutes), updatedAt: nowIso() }).where(eq(schema.watchSyncPairs.id, pair.id));
  await recordActivity(db, [{ pairId: pair.id, at: nowIso(), level: "error", message, jobId }]);
  if (error instanceof ServerFailure) await recordServerStatus(db, error.serverId, message);
  return message;
}

// Watch sync passes run one at a time in the worker, whether started by the timer or by a job.
let exclusive: Promise<unknown> = Promise.resolve();
function serialized<T>(action: () => Promise<T>): Promise<T> {
  const run = exclusive.then(action, action);
  exclusive = run.catch(() => undefined);
  return run;
}

async function watchSyncJobActive(db: Db): Promise<boolean> {
  const row = (await db.select({ id: schema.jobs.id }).from(schema.jobs).where(and(eq(schema.jobs.type, "watch_sync"), eq(schema.jobs.status, "running"))).limit(1))[0];
  return Boolean(row);
}

export interface WatchSyncTickResult { synced: number; failed: number; written: number }

// One incremental pass over every pair that is due. Each pair is isolated: a failure is recorded with a growing
// retry delay and the next pair carries on.
export async function runWatchSyncTick(db: Db): Promise<WatchSyncTickResult> {
  return serialized(async () => {
    const result: WatchSyncTickResult = { synced: 0, failed: 0, written: 0 };
    const settings = await loadWatchSyncSettings(db);
    if (settings.paused || !settings.servers.length || await watchSyncJobActive(db)) return result;
    const now = nowIso();
    const dueBefore = new Date(Date.now() - settings.intervalMinutes * 60_000 + 5000).toISOString();
    const pairs = await db.select().from(schema.watchSyncPairs).where(and(
      eq(schema.watchSyncPairs.enabled, true), eq(schema.watchSyncPairs.paused, false), isNotNull(schema.watchSyncPairs.approvedAt), isNotNull(schema.watchSyncPairs.lastFullSyncAt),
      or(isNull(schema.watchSyncPairs.lastSyncAt), lte(schema.watchSyncPairs.lastSyncAt, dueBefore)),
      or(isNull(schema.watchSyncPairs.nextAttemptAt), lte(schema.watchSyncPairs.nextAttemptAt, now))
    )).orderBy(asc(schema.watchSyncPairs.id));
    const healthy = new Set<string>();
    for (const pair of pairs) {
      try {
        const rt = await loadRuntime(db, settings, pair);
        const incremental = await collectIncremental(db, rt);
        const outcome = await syncObservations(db, rt, incremental.collected, false, { jobId: null });
        if (outcome.failed) throw new WatchSyncError(`${outcome.failed} change${outcome.failed === 1 ? "" : "s"} could not be written; they will be retried.`);
        await db.update(schema.watchSyncPairs).set({
          plexCursor: incremental.plexCursor, jellyfinCursor: incremental.jellyfinCursor, recheckCursor: incremental.recheckCursor,
          lastSyncAt: nowIso(), lastError: null, errorCount: 0, nextAttemptAt: null, updatedAt: nowIso()
        }).where(eq(schema.watchSyncPairs.id, pair.id));
        healthy.add(rt.plexServer.id).add(rt.jellyfinServer.id);
        result.synced += 1;
        result.written += outcome.written;
      } catch (error) {
        result.failed += 1;
        await recordPairFailure(db, pair, error, settings.intervalMinutes, null);
      }
    }
    for (const serverId of healthy) await recordServerStatus(db, serverId, null);
    await db.delete(schema.watchSyncActivity).where(lt(schema.watchSyncActivity.at, new Date(Date.now() - activityRetentionMs).toISOString()));
    return result;
  });
}

export interface WatchSyncJobOptions {
  mode: WatchSyncJobMode;
  pairIds: number[];
  scheduled?: boolean;
  // The backup itself waits in watch_sync_cursors under this key, so job records stay small.
  restore?: { side: Side; backupKey: string };
}

type JobControls = Pick<JobContext, "jobId" | "signal" | "event" | "setProgress">;

function previewOf(outcome: SyncOutcome, collected: Collected, jobId: number): WatchSyncPreview {
  return { generatedAt: nowIso(), jobId, counts: outcome.counts, samples: outcome.samples, plexItems: collected.plexItems, jellyfinItems: collected.jellyfinItems, matched: outcome.matched, skipped: collected.skipped };
}

async function fullPass(db: Db, rt: PairRuntime, preview: boolean, controls: JobControls, progress: (detail: string) => Promise<void>): Promise<{ outcome: SyncOutcome; collected: Collected }> {
  const collected = emptyCollected();
  let pages = 0;
  const onPage = async () => { pages += 1; await progress(`${rt.label}: read ${pages} page${pages === 1 ? "" : "s"} (${collected.plexItems} Plex and ${collected.jellyfinItems} Jellyfin items)`); };
  const plexTime = await listPlexLibrary(db, rt, collected, onPage);
  const jellyfinTime = await listJellyfinLibrary(db, rt, collected, onPage);
  const outcome = await syncObservations(db, rt, collected, preview, { jobId: controls.jobId, event: controls.event }, false);
  if (preview) {
    await db.update(schema.watchSyncPairs).set({ preview: JSON.stringify(previewOf(outcome, collected, controls.jobId)), updatedAt: nowIso() }).where(eq(schema.watchSyncPairs.id, rt.pair.id));
  } else if (!outcome.failed) {
    await db.update(schema.watchSyncPairs).set({
      plexCursor: String(epochSeconds(plexTime)), jellyfinCursor: (jellyfinTime ?? new Date()).toISOString(), recheckCursor: "",
      lastSyncAt: nowIso(), lastFullSyncAt: nowIso(), lastError: null, errorCount: 0, nextAttemptAt: null, updatedAt: nowIso()
    }).where(eq(schema.watchSyncPairs.id, rt.pair.id));
  }
  return { outcome, collected };
}

// Writes a backup's states for one side; the other side then follows through the pair's normal sync.
async function restorePass(db: Db, rt: PairRuntime, side: Side, backup: WatchSyncBackup, controls: JobControls): Promise<SyncOutcome> {
  const collected = emptyCollected();
  const wanted = new Map<string, WatchSyncSideState>();
  for (const item of backup.items) {
    const state = item[side];
    if (state) { wanted.set(item.linkPath, state); observation(collected, item.linkPath, path.posix.basename(item.linkPath)); }
  }
  const server = side === "plex" ? rt.plexServer : rt.jellyfinServer;
  const ids = await itemIdsForPaths(db, server.id, [...wanted.keys()]);
  const outcome: SyncOutcome = { matched: 0, counts: emptyCounts(), samples: [], written: 0, failed: 0 };
  const entries = [...collected.observations.values()].filter((entry) => ids.has(entry.linkPath));
  for (const entry of entries) if (side === "plex") entry.plexId = ids.get(entry.linkPath); else entry.jellyfinId = ids.get(entry.linkPath);
  // Reads the current state of every restorable item on the restored side only.
  if (side === "plex") {
    for (const batch of chunks([...new Set(entries.map((entry) => entry.plexId!))], lookupBatchSize)) {
      const states = new Map((await onServer(server, () => plexMetadata(rt, batch))).map((item) => [item.ratingKey, item]));
      for (const entry of entries) { const item = states.get(entry.plexId!); if (item) { entry.plex = item.state; entry.title = item.title; } }
    }
  } else {
    for (const batch of chunks([...new Set(entries.map((entry) => entry.jellyfinId!))], lookupBatchSize)) {
      const page = await onServer(server, () => rt.jellyfin.itemsPage(rt.jellyfinUser.externalId, 0, batch.length, { ids: batch }));
      const states = new Map(page.items.map((item) => [item.id, item]));
      for (const entry of entries) { const item = states.get(entry.jellyfinId!); if (item) { entry.jellyfin = item.state; entry.title = item.title; } }
    }
  }
  const features: WatchSyncFeatures = { watched: true, position: true };
  for (const entry of entries) {
    assertNotAborted(rt.signal);
    const current = entry[side];
    const desired = wanted.get(entry.linkPath)!;
    if (!current) continue;
    outcome.matched += 1;
    const plan = sameWatchState(current, desired, features) ? null : planWrite(desired, current, features);
    if (!plan) continue;
    const write: WatchSyncWrite = { target: side, ...plan };
    try {
      await applyWrite(rt, write, side === "plex" ? entry.plexId! : entry.jellyfinId!, current);
      outcome.written += 1;
      outcome.counts[transferFrom(otherSide(side))][plan.action] += 1;
      const message = `Restored "${entry.title}" on ${sideLabel(side)}: ${plan.action === "watched" ? "watched" : plan.action === "unwatched" ? "unwatched" : `resume at ${formatPosition(desired.positionMs)}`}.`;
      await recordActivity(db, [{ pairId: rt.pair.id, at: nowIso(), level: "info", action: plan.action, linkPath: entry.linkPath, message, jobId: controls.jobId }]);
    } catch (error) {
      outcome.failed += 1;
      await recordActivity(db, [{ pairId: rt.pair.id, at: nowIso(), level: "error", action: plan.action, linkPath: entry.linkPath, message: `Could not restore "${entry.title}": ${error instanceof Error ? error.message : "request failed"}`, jobId: controls.jobId }]);
    }
  }
  // Snapshots are left as they are: the next sync compares the restored side against them like any other change.
  return outcome;
}

export interface WatchSyncJobResult { failedPairs: number; summary: string }

export async function runWatchSyncJob(db: Db, options: WatchSyncJobOptions, controls: JobControls): Promise<WatchSyncJobResult> {
  return serialized(async () => {
    const settings = await loadWatchSyncSettings(db);
    const writes = options.mode !== "preview";
    if (writes && settings.paused) {
      await controls.event("warn", "Watch sync is paused; nothing was written.");
      return { failedPairs: 0, summary: "Watch sync is paused." };
    }
    const pairs = options.pairIds.length ? await db.select().from(schema.watchSyncPairs).where(inArray(schema.watchSyncPairs.id, options.pairIds)).orderBy(asc(schema.watchSyncPairs.id)) : [];
    const eligible = pairs.filter((pair) => !writes || (pair.approvedAt && pair.enabled && !pair.paused));
    const startedAt = nowIso();
    let failedPairs = 0;
    let written = 0;
    const serverResults = new Map<string, boolean>();
    for (const [index, pair] of eligible.entries()) {
      const progress = (detail: string) => controls.setProgress({ stage: options.mode, current: index, total: eligible.length, message: detail });
      await progress(`Starting pair ${index + 1} of ${eligible.length}`);
      let rt: PairRuntime | null = null;
      try {
        rt = await loadRuntime(db, settings, pair, controls.signal);
        if (options.mode === "restore" && options.restore) {
          const raw = await readCursor(db, options.restore.backupKey);
          if (!raw) throw new WatchSyncError("The uploaded backup is no longer available. Upload it again.");
          const outcome = await restorePass(db, rt, options.restore.side, JSON.parse(raw) as WatchSyncBackup, controls);
          written += outcome.written;
          await controls.event(outcome.failed ? "warn" : "info", `${rt.label}: restored ${outcome.written} of ${outcome.matched} item${outcome.matched === 1 ? "" : "s"} on ${sideLabel(options.restore.side)}${outcome.failed ? `; ${outcome.failed} failed` : ""}.`);
          if (outcome.failed) failedPairs += 1;
          continue;
        }
        const { outcome, collected } = await fullPass(db, rt, !writes, controls, progress);
        written += outcome.written;
        const total = (counts: WatchSyncCounts) => counts.watched + counts.unwatched + counts.position;
        const summary = `${rt.label}: ${collected.plexItems} Plex and ${collected.jellyfinItems} Jellyfin items, ${outcome.matched} matched by path, ${collected.skipped} skipped as non-SRTL paths; ${writes ? "wrote" : "would write"} ${total(outcome.counts.plex_to_jellyfin)} Plex → Jellyfin and ${total(outcome.counts.jellyfin_to_plex)} Jellyfin → Plex.`;
        await controls.event(outcome.failed ? "warn" : "info", outcome.failed ? `${summary} ${outcome.failed} write${outcome.failed === 1 ? "" : "s"} failed and will be retried.` : summary, { pairId: pair.id, counts: outcome.counts });
        if (writes) await recordActivity(db, [{ pairId: pair.id, at: nowIso(), level: outcome.failed ? "warn" : "info", message: `Full reconciliation: ${summary}`, jobId: controls.jobId }]);
        if (outcome.failed) {
          failedPairs += 1;
          await recordPairFailure(db, pair, new WatchSyncError(`${outcome.failed} change${outcome.failed === 1 ? "" : "s"} could not be written during the full reconciliation.`), settings.intervalMinutes, controls.jobId);
        }
        serverResults.set(rt.plexServer.id, (serverResults.get(rt.plexServer.id) ?? true) && !outcome.failed);
        serverResults.set(rt.jellyfinServer.id, (serverResults.get(rt.jellyfinServer.id) ?? true) && !outcome.failed);
      } catch (error) {
        if (controls.signal.aborted) throw error;
        failedPairs += 1;
        const message = writes ? await recordPairFailure(db, pair, error, settings.intervalMinutes, controls.jobId) : error instanceof Error ? error.message : "Preview failed.";
        if (error instanceof ServerFailure) serverResults.set(error.serverId, false);
        await controls.event("error", `${rt?.label ?? `Pair #${pair.id}`}: ${message}`, { pairId: pair.id });
      }
    }
    for (const [serverId, ok] of serverResults) {
      if (!ok) continue;
      await recordServerStatus(db, serverId, null);
      // A scheduled pass reads every paired user's whole library, so index entries it did not see are gone.
      if (options.scheduled && options.mode === "reconcile") await db.delete(schema.watchSyncItems).where(and(eq(schema.watchSyncItems.serverId, serverId), lt(schema.watchSyncItems.seenAt, startedAt)));
    }
    if (options.scheduled && options.mode === "reconcile" && failedPairs < eligible.length) await writeCursor(db, "reconcile:last", nowIso());
    if (options.restore) await writeCursor(db, options.restore.backupKey, null);
    await controls.setProgress({ stage: "done", current: eligible.length, total: eligible.length, message: `Finished ${eligible.length} pair${eligible.length === 1 ? "" : "s"}` });
    const verb = options.mode === "preview" ? "Previewed" : options.mode === "restore" ? "Restored" : "Reconciled";
    return { failedPairs, summary: `${verb} ${eligible.length - failedPairs} of ${eligible.length} pair${eligible.length === 1 ? "" : "s"}${writes ? `; ${written} change${written === 1 ? "" : "s"} written` : ""}.` };
  });
}

// Queues the periodic full reconciliation once it is due. A failed run is retried after a few hours, not every pass.
export async function scheduleWatchSyncReconcile(db: Db, enqueue: (options: WatchSyncJobOptions) => Promise<number>): Promise<number | null> {
  const settings = await loadWatchSyncSettings(db);
  if (settings.paused) return null;
  const active = (await db.select({ id: schema.jobs.id }).from(schema.jobs).where(and(eq(schema.jobs.type, "watch_sync"), inArray(schema.jobs.status, ["queued", "running"]))).limit(1))[0];
  if (active) return null;
  const approved = await db.select().from(schema.watchSyncPairs).where(and(eq(schema.watchSyncPairs.enabled, true), eq(schema.watchSyncPairs.paused, false), isNotNull(schema.watchSyncPairs.approvedAt)));
  // An approved pair whose first full sync failed is retried on its backoff schedule.
  const firstSyncs = approved.filter((pair) => !pair.lastFullSyncAt && (!pair.nextAttemptAt || Date.parse(pair.nextAttemptAt) <= Date.now()));
  if (firstSyncs.length) return enqueue({ mode: "reconcile", pairIds: firstSyncs.map((pair) => pair.id) });
  const pairs = approved.filter((pair) => pair.lastFullSyncAt);
  if (!pairs.length) return null;
  const last = Date.parse(await readCursor(db, "reconcile:last") ?? "");
  const attempted = Date.parse(await readCursor(db, "reconcile:attempted") ?? "");
  const now = Date.now();
  if (Number.isFinite(last) && now - last < settings.reconcileIntervalDays * 86400_000) return null;
  if (Number.isFinite(attempted) && now - attempted < reconcileRetryMs) return null;
  // Without a completed run yet, the first scheduled one waits a full interval after the pairs' own first syncs.
  if (!Number.isFinite(last)) {
    await writeCursor(db, "reconcile:last", nowIso());
    return null;
  }
  await writeCursor(db, "reconcile:attempted", nowIso());
  return enqueue({ mode: "reconcile", pairIds: pairs.map((pair) => pair.id), scheduled: true });
}

export async function runWatchSyncWork(db: Db, enqueue: (options: WatchSyncJobOptions) => Promise<number>): Promise<void> {
  await scheduleWatchSyncReconcile(db, enqueue);
  await runWatchSyncTick(db);
}
