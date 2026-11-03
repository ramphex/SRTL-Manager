import { randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import { and, asc, eq, inArray, or, sql } from "drizzle-orm";
import { z } from "zod";
import {
  mediaServerKindLabels,
  mediaServerLimit,
  type MediaServer,
  type MediaServerInput,
  type MediaServerKind,
  type MediaServerList,
  type MediaServerPinStatus,
  type MediaServerPlexPin,
  type MediaServerPrefixMapping
} from "../../shared/mediaServers";
import { getJsonSetting, nowIso, setSetting, type Db } from "../db/database";
import * as schema from "../db/schema";
import { publicErrorMessage } from "../errors";
import { JellyfinClient } from "./jellyfinClient";
import { openSecret, sealSecret, secretPurposes } from "./secretBox";
import { PlexServerClient, PlexTvClient } from "./plexClient";
import { WatchSyncError, normalizeServerUrl } from "./watchSyncHttp";

// The stored connection, token included. Only this module and the features that talk to the servers see it.
export interface MediaServerRecord {
  id: string;
  kind: MediaServerKind;
  name: string;
  url: string;
  token: string;
  prefixMappings: MediaServerPrefixMapping[];
  machineIdentifier: string | null;
  accountName: string | null;
  accountId: string | null;
  version: string | null;
  lastCheckedAt: string | null;
  lastError: string | null;
}

export class MediaServerNotFound extends WatchSyncError {
  override readonly statusCode = 404;
}

export class MediaServerInUse extends WatchSyncError {
  override readonly statusCode = 409;
}

const settingKey = "mediaServers";
const lockKey = 781_889_471;

const absolutePrefix = z.string().trim().min(1).max(4096).refine((value) => value.startsWith("/") && !/[\\\0]/.test(value) && path.posix.normalize(value) === value.replace(/(.)\/+$/, "$1"), "Use an absolute path prefix without parent-directory segments.")
  .transform((value) => value.replace(/(.)\/+$/, "$1"));
export const mediaServerIdSchema = z.string().regex(/^[a-z0-9]{1,40}$/, "Unknown media server.");
export const mediaServerInputSchema = z.object({
  name: z.string().trim().min(1, "Enter a name for this server.").max(60, "Use at most 60 characters for the server name."),
  url: z.string().trim().min(1, "Enter the server URL.").max(2000),
  token: z.string().trim().max(512).regex(/^[A-Za-z0-9_.\-~]*$/, "Tokens and API keys contain only letters, numbers, and - _ . ~").optional(),
  prefixMappings: z.array(z.object({ serverPrefix: absolutePrefix, srtlPrefix: absolutePrefix })).max(20).default([])
});
export const mediaServerCreateSchema = mediaServerInputSchema.extend({ kind: z.enum(["plex", "jellyfin"]) });

type Row = typeof schema.mediaServers.$inferSelect;

function parseMappings(raw: string): MediaServerPrefixMapping[] {
  try {
    const value = JSON.parse(raw) as unknown;
    return Array.isArray(value) ? value.filter((entry): entry is MediaServerPrefixMapping => Boolean(entry) && typeof entry.serverPrefix === "string" && typeof entry.srtlPrefix === "string") : [];
  } catch {
    return [];
  }
}

// Tokens are stored sealed with the secret key and opened only here.
const sealToken = (token: string) => sealSecret(token, secretPurposes.mediaServerToken);
const openToken = (stored: string) => openSecret(stored, secretPurposes.mediaServerToken);

function toRecord(row: Row): MediaServerRecord {
  return {
    id: row.id, kind: row.kind as MediaServerKind, name: row.name, url: row.url, token: openToken(row.token), prefixMappings: parseMappings(row.prefixMappings),
    machineIdentifier: row.machineIdentifier, accountName: row.accountName, accountId: row.accountId, version: row.version,
    lastCheckedAt: row.lastCheckedAt, lastError: row.lastError
  };
}

// Tokens and API keys stay on the server; the browser only learns whether one is saved.
export function publicMediaServer(server: MediaServerRecord): MediaServer {
  return {
    id: server.id, kind: server.kind, name: server.name, url: server.url, hasToken: Boolean(server.token), prefixMappings: server.prefixMappings,
    machineIdentifier: server.machineIdentifier, accountName: server.accountName, version: server.version,
    lastCheckedAt: server.lastCheckedAt, lastError: server.lastError
  };
}

export async function loadMediaServers(db: Db): Promise<MediaServerRecord[]> {
  return (await db.select().from(schema.mediaServers).orderBy(asc(schema.mediaServers.position), asc(schema.mediaServers.createdAt), asc(schema.mediaServers.id))).map(toRecord);
}

export function findMediaServer(servers: MediaServerRecord[], serverId: string, kind?: MediaServerKind): MediaServerRecord {
  const server = servers.find((entry) => entry.id === serverId && (!kind || entry.kind === kind));
  if (!server) throw new MediaServerNotFound("This media server no longer exists. Reload Settings > Media servers.");
  return server;
}

export async function getMediaServer(db: Db, serverId: string, kind?: MediaServerKind): Promise<MediaServerRecord> {
  const row = (await db.select().from(schema.mediaServers).where(eq(schema.mediaServers.id, serverId)).limit(1))[0];
  return findMediaServer(row ? [toRecord(row)] : [], serverId, kind);
}

export async function listMediaServers(db: Db): Promise<MediaServerList> {
  return { servers: (await loadMediaServers(db)).map(publicMediaServer), limit: mediaServerLimit };
}

// Plex and Jellyfin identify SRTL by this id (Plex PIN sign-in depends on it), so it is created once and kept.
export async function mediaServerClientIdentifier(db: Db): Promise<string> {
  const saved = await getJsonSetting<{ clientIdentifier?: string }>(db, settingKey, {});
  if (saved.clientIdentifier) return saved.clientIdentifier;
  return db.transaction(async (transaction) => {
    await transaction.execute(sql`select pg_advisory_xact_lock(${lockKey})`);
    const current = await getJsonSetting<{ clientIdentifier?: string }>(transaction, settingKey, {});
    if (current.clientIdentifier) return current.clientIdentifier;
    const clientIdentifier = randomUUID();
    await setSetting(transaction, settingKey, { ...current, clientIdentifier });
    return clientIdentifier;
  });
}

function validateInput(kind: MediaServerKind, input: MediaServerInput) {
  const parsed = mediaServerInputSchema.parse(input);
  return { ...parsed, url: normalizeServerUrl(parsed.url, mediaServerKindLabels[kind]) };
}

function isNameConflict(error: unknown): boolean {
  const cause = (error as { cause?: unknown } | null)?.cause ?? error;
  return Boolean(cause) && typeof cause === "object" && (cause as { code?: unknown }).code === "23505";
}

async function withNameCheck<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (isNameConflict(error)) throw new WatchSyncError("Another media server already uses this name.");
    throw error;
  }
}

export async function addMediaServer(db: Db, kind: MediaServerKind, input: MediaServerInput): Promise<MediaServerRecord> {
  const draft = validateInput(kind, input);
  const id = randomBytes(6).toString("hex");
  await withNameCheck(() => db.transaction(async (transaction) => {
    await transaction.execute(sql`select pg_advisory_xact_lock(${lockKey})`);
    const existing = await transaction.select({ name: schema.mediaServers.name, position: schema.mediaServers.position }).from(schema.mediaServers);
    if (existing.length >= mediaServerLimit) throw new WatchSyncError(`SRTL supports up to ${mediaServerLimit} media servers.`);
    if (existing.some((server) => server.name.toLowerCase() === draft.name.toLowerCase())) throw new WatchSyncError("Another media server already uses this name.");
    const timestamp = nowIso();
    await transaction.insert(schema.mediaServers).values({
      id, kind, name: draft.name, url: draft.url, token: sealToken(draft.token ?? ""), prefixMappings: JSON.stringify(draft.prefixMappings),
      position: Math.max(-1, ...existing.map((server) => server.position)) + 1, createdAt: timestamp, updatedAt: timestamp
    });
  }));
  return getMediaServer(db, id);
}

// A saved token or API key is only ever sent to the address it was entered for. A new Jellyfin address needs the
// API key again. A new Plex address signs the server out: the owner token, the per-user tokens found with it, and
// any pending sign-in are cleared, unless a token is pasted with the change, and Sign in with Plex connects it again.
export async function updateMediaServer(db: Db, serverId: string, input: MediaServerInput): Promise<MediaServerRecord> {
  const current = await getMediaServer(db, serverId);
  const draft = validateInput(current.kind, input);
  const urlChanged = draft.url !== current.url;
  if (urlChanged && !draft.token && current.kind === "jellyfin") throw new WatchSyncError("Enter the API key again when changing the Jellyfin address.");
  const signOut = urlChanged && !draft.token;
  const tokenChanged = signOut ? Boolean(current.token) : Boolean(draft.token) && draft.token !== current.token;
  await withNameCheck(() => db.transaction(async (transaction) => {
    const stored = (await transaction.select({ token: schema.mediaServers.token }).from(schema.mediaServers).where(eq(schema.mediaServers.id, serverId)).limit(1))[0];
    if (!stored) throw new MediaServerNotFound("This media server no longer exists. Reload Settings > Media servers.");
    // An unchanged token keeps its stored form, so status updates made with it still match.
    const token = signOut ? "" : draft.token && draft.token !== current.token ? sealToken(draft.token) : stored.token;
    await transaction.update(schema.mediaServers).set({
      name: draft.name, url: draft.url, token, prefixMappings: JSON.stringify(draft.prefixMappings),
      ...(tokenChanged || urlChanged ? { machineIdentifier: null, accountName: null, accountId: null, pendingPin: null } : {}),
      ...(tokenChanged || urlChanged ? { lastCheckedAt: null, lastError: null, version: null } : {}),
      updatedAt: nowIso()
    }).where(eq(schema.mediaServers.id, serverId));
    if (urlChanged && current.kind === "plex") {
      // Shared users' tokens were issued for this server and would otherwise follow it to the new address.
      await transaction.update(schema.watchSyncUsers).set({ accessToken: null, available: false, note: "The server address changed. Sign in with Plex again, then discover users again.", updatedAt: nowIso() })
        .where(eq(schema.watchSyncUsers.serverId, serverId));
    }
  }));
  return getMediaServer(db, serverId);
}

// What still depends on a server. Watch sync pairs block removal; Invitations add their checks here. Now Playing
// keeps nothing per server, so it never blocks removal.
export async function mediaServerUsage(db: Db, serverId: string): Promise<string[]> {
  const pairs = await db.select().from(schema.watchSyncPairs)
    .where(or(eq(schema.watchSyncPairs.plexServerId, serverId), eq(schema.watchSyncPairs.jellyfinServerId, serverId)))
    .orderBy(asc(schema.watchSyncPairs.id));
  if (!pairs.length) return [];
  const ids = [...new Set(pairs.flatMap((pair) => [pair.plexServerId, pair.jellyfinServerId]))];
  const users = await db.select({ serverId: schema.watchSyncUsers.serverId, externalId: schema.watchSyncUsers.externalId, name: schema.watchSyncUsers.name })
    .from(schema.watchSyncUsers).where(inArray(schema.watchSyncUsers.serverId, ids));
  const name = (id: string, externalId: string) => users.find((user) => user.serverId === id && user.externalId === externalId)?.name ?? externalId;
  return pairs.map((pair) => `${name(pair.plexServerId, pair.plexUserId)} ↔ ${name(pair.jellyfinServerId, pair.jellyfinUserId)}`);
}

// Forgets the connection and the per-server records features kept for it. Nothing changes on the server itself.
export async function removeMediaServer(db: Db, serverId: string): Promise<void> {
  await db.transaction(async (transaction) => {
    await transaction.execute(sql`select pg_advisory_xact_lock(${lockKey})`);
    const server = await getMediaServer(transaction, serverId);
    const pairs = await mediaServerUsage(transaction, serverId);
    if (pairs.length) {
      throw new MediaServerInUse(`${server.name} is used by ${pairs.length} watch sync pair${pairs.length === 1 ? "" : "s"}: ${pairs.join(", ")}. Remove ${pairs.length === 1 ? "that pair" : "those pairs"} in Settings > Integrations > Watch sync first.`);
    }
    await transaction.delete(schema.watchSyncUsers).where(eq(schema.watchSyncUsers.serverId, serverId));
    await transaction.delete(schema.watchSyncItems).where(eq(schema.watchSyncItems.serverId, serverId));
    await transaction.delete(schema.watchSyncCursors).where(sql`${schema.watchSyncCursors.scope} LIKE ${`%:${serverId}`} OR ${schema.watchSyncCursors.scope} LIKE ${`%:${serverId}:%`}`);
    await transaction.delete(schema.mediaServers).where(eq(schema.mediaServers.id, serverId));
  });
}

export interface MediaServerDetails {
  machineIdentifier?: string | null;
  accountName?: string | null;
  accountId?: string | null;
  version?: string | null;
}

// Records the outcome of any request to the server: a successful check clears the error.
export async function recordMediaServerStatus(db: Db, serverId: string, error: string | null, details: MediaServerDetails = {}, token?: string): Promise<void> {
  let where = eq(schema.mediaServers.id, serverId);
  if (token !== undefined) {
    // Details describe the token they were read with, so they are dropped if the token changed meanwhile.
    const stored = (await db.select({ token: schema.mediaServers.token }).from(schema.mediaServers).where(eq(schema.mediaServers.id, serverId)).limit(1))[0];
    if (!stored || openToken(stored.token) !== token) return;
    where = and(eq(schema.mediaServers.id, serverId), eq(schema.mediaServers.token, stored.token))!;
  }
  await db.update(schema.mediaServers).set({ lastCheckedAt: nowIso(), lastError: error, ...(error ? {} : details) }).where(where);
}

// Reaches the server with its token, reads its version and identity, and records the result.
export async function testMediaServer(db: Db, serverId: string): Promise<MediaServerRecord> {
  const server = await getMediaServer(db, serverId);
  if (!server.token) throw new WatchSyncError(server.kind === "plex" ? "Sign in with Plex or paste a Plex token first." : "Enter a Jellyfin API key first.");
  const identifier = await mediaServerClientIdentifier(db);
  let details: MediaServerDetails;
  try {
    if (server.kind === "plex") {
      const pms = new PlexServerClient(server.url, server.token, identifier);
      const identity = await pms.identity();
      // /identity answers without a token; listing libraries proves the token works on this server.
      await pms.sections();
      const account = await new PlexTvClient(identifier).account(server.token);
      details = { machineIdentifier: identity.machineIdentifier, version: identity.version, accountName: account.title, accountId: account.id };
    } else {
      const info = await new JellyfinClient(server.url, server.token, identifier).systemInfo();
      details = { version: info.version };
    }
  } catch (error) {
    await recordMediaServerStatus(db, server.id, publicErrorMessage(error, "Connection failed."));
    throw error;
  }
  await recordMediaServerStatus(db, server.id, null, details, server.token);
  return getMediaServer(db, serverId);
}

interface PendingPin { id: number; code: string; expiresAt: string }

// Plex sign-in: SRTL asks plex.tv for a PIN, the admin approves it at plex.tv, and SRTL polls until the PIN carries a token.
export async function startPlexSignIn(db: Db, serverId: string): Promise<MediaServerPlexPin> {
  await getMediaServer(db, serverId, "plex");
  const plexTv = new PlexTvClient(await mediaServerClientIdentifier(db));
  const pin = await plexTv.createPin();
  await db.update(schema.mediaServers).set({ pendingPin: JSON.stringify({ id: pin.id, code: pin.code, expiresAt: pin.expiresAt } satisfies PendingPin) }).where(eq(schema.mediaServers.id, serverId));
  return { pinId: pin.id, code: pin.code, authUrl: plexTv.authUrl(pin.code), expiresAt: pin.expiresAt };
}

export async function checkPlexSignIn(db: Db, serverId: string, pinId: number, afterSignIn?: (serverId: string) => Promise<unknown>): Promise<MediaServerPinStatus> {
  await getMediaServer(db, serverId, "plex");
  const row = (await db.select({ pendingPin: schema.mediaServers.pendingPin }).from(schema.mediaServers).where(eq(schema.mediaServers.id, serverId)).limit(1))[0];
  let pending: PendingPin | null;
  try { pending = row?.pendingPin ? JSON.parse(row.pendingPin) as PendingPin : null; } catch { pending = null; }
  if (!pending || pending.id !== pinId) throw new WatchSyncError("This Plex sign-in is no longer pending. Start it again.");
  const pin = await new PlexTvClient(await mediaServerClientIdentifier(db)).checkPin(pinId);
  if (!pin.authToken) {
    const expiresAt = Date.parse(pin.expiresAt || pending.expiresAt);
    if (Number.isFinite(expiresAt) && expiresAt <= Date.now()) {
      await db.update(schema.mediaServers).set({ pendingPin: null }).where(eq(schema.mediaServers.id, serverId));
      return { status: "expired" };
    }
    return { status: "waiting" };
  }
  await db.update(schema.mediaServers).set({
    token: sealToken(pin.authToken), pendingPin: null, machineIdentifier: null, accountName: null, accountId: null, lastError: null, updatedAt: nowIso()
  }).where(eq(schema.mediaServers.id, serverId));
  await testMediaServer(db, serverId).catch(() => undefined);
  if (afterSignIn) await afterSignIn(serverId).catch(() => undefined);
  return { status: "authorized", servers: await listMediaServers(db) };
}
