import crypto from "node:crypto";
import { and, asc, eq, isNotNull, lt, ne, or, sql } from "drizzle-orm";
import type { Db } from "./db/database";
import { first } from "./db/database";
import * as schema from "./db/schema";

const adminSetupLockKey = 1_558_042_911;

// ---------------------------------------------------------------------------
// Password hashing
// ---------------------------------------------------------------------------

export interface ScryptParameters {
  N: number;
  r: number;
  p: number;
}

/** Current scrypt cost: about 128 MB and a few hundred milliseconds per hash. */
export const currentScryptParameters: ScryptParameters = { N: 2 ** 17, r: 8, p: 1 };
/** Node's scrypt defaults, used by the original `scrypt$salt$digest` format. */
const legacyScryptParameters: ScryptParameters = { N: 16_384, r: 8, p: 1 };
const digestLength = 64;

interface ParsedPasswordHash {
  version: 1 | 2;
  parameters: ScryptParameters;
  salt: string;
  digest: Buffer;
}

function scryptDigest(password: string, salt: string, parameters: ScryptParameters): Promise<Buffer> {
  // scrypt needs 128 * N * r bytes; allow twice that so the current cost always fits.
  const maxmem = 256 * parameters.N * parameters.r;
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, digestLength, { N: parameters.N, r: parameters.r, p: parameters.p, maxmem }, (error, derived) => {
      if (error) reject(error);
      else resolve(derived);
    });
  });
}

function boundedInteger(value: string | undefined, minimum: number, maximum: number): number | null {
  if (!value || !/^\d{1,8}$/.test(value)) return null;
  const parsed = Number(value);
  return parsed >= minimum && parsed <= maximum ? parsed : null;
}

/**
 * Reads `scrypt$salt$digest` (version 1, Node defaults) and
 * `scrypt$v2$N$r$p$salt$digest` (version 2, explicit parameters).
 */
function parsePasswordHash(hash: string): ParsedPasswordHash | null {
  const parts = hash.split("$");
  if (parts[0] !== "scrypt") return null;
  let parsed: Omit<ParsedPasswordHash, "digest"> & { encodedDigest: string | undefined };
  if (parts.length === 3) {
    parsed = { version: 1, parameters: legacyScryptParameters, salt: parts[1] ?? "", encodedDigest: parts[2] };
  } else if (parts.length === 7 && parts[1] === "v2") {
    const N = boundedInteger(parts[2], 2 ** 14, 2 ** 20);
    const r = boundedInteger(parts[3], 1, 32);
    const p = boundedInteger(parts[4], 1, 16);
    if (N === null || r === null || p === null || (N & (N - 1)) !== 0) return null;
    parsed = { version: 2, parameters: { N, r, p }, salt: parts[5] ?? "", encodedDigest: parts[6] };
  } else {
    return null;
  }
  if (!parsed.salt || !parsed.encodedDigest) return null;
  const digest = Buffer.from(parsed.encodedDigest, "base64");
  if (digest.length !== digestLength) return null;
  return { version: parsed.version, parameters: parsed.parameters, salt: parsed.salt, digest };
}

async function hashPasswordImpl(password: string): Promise<string> {
  const salt = crypto.randomBytes(16).toString("base64");
  const { N, r, p } = currentScryptParameters;
  const derived = await scryptDigest(password, salt, currentScryptParameters);
  return `scrypt$v2$${N}$${r}$${p}$${salt}$${derived.toString("base64")}`;
}

async function verifyPasswordImpl(password: string, hash: string): Promise<boolean> {
  const parsed = parsePasswordHash(hash);
  if (!parsed) return false;
  const derived = await scryptDigest(password, parsed.salt, parsed.parameters);
  return crypto.timingSafeEqual(parsed.digest, derived);
}

/**
 * Hashing entry points. Internal callers go through this object so tests can
 * observe that unknown usernames still pay for a full password check.
 */
export const passwordHashing = {
  hash: hashPasswordImpl,
  verify: verifyPasswordImpl
};

export function hashPassword(password: string): Promise<string> {
  return passwordHashing.hash(password);
}

export function verifyPassword(password: string, hash: string): Promise<boolean> {
  return passwordHashing.verify(password, hash);
}

/** True when a stored hash uses an older format or weaker parameters than the current ones. */
export function passwordNeedsRehash(hash: string): boolean {
  const parsed = parsePasswordHash(hash);
  if (!parsed) return false;
  const { N, r, p } = parsed.parameters;
  return parsed.version !== 2 || N !== currentScryptParameters.N || r !== currentScryptParameters.r || p !== currentScryptParameters.p;
}

let dummyHash: Promise<string> | null = null;

/** A hash of a random password, checked against when a username does not exist. */
export function dummyPasswordHash(): Promise<string> {
  dummyHash ??= hashPasswordImpl(crypto.randomBytes(32).toString("base64url")).catch((error: unknown) => {
    dummyHash = null;
    throw error;
  });
  return dummyHash;
}

// ---------------------------------------------------------------------------
// Admin account
// ---------------------------------------------------------------------------

export type AdminUser = typeof schema.adminUsers.$inferSelect;

export async function hasAdmin(db: Db): Promise<boolean> {
  return (await db.select({ id: schema.adminUsers.id }).from(schema.adminUsers).limit(1)).length > 0;
}

/** Creates the single admin. Returns the new user, or null when one already exists. */
export async function createAdmin(db: Db, username: string, password: string): Promise<AdminUser | null> {
  const passwordHash = await passwordHashing.hash(password);
  return db.transaction(async (transaction) => {
    await transaction.execute(sql`select pg_advisory_xact_lock(${adminSetupLockKey})`);
    if ((await transaction.select({ id: schema.adminUsers.id }).from(schema.adminUsers).limit(1)).length > 0) return null;
    const [user] = await transaction.insert(schema.adminUsers).values({ username, passwordHash, createdAt: new Date().toISOString() }).returning();
    return user ?? null;
  });
}

export async function findAdminByUsername(db: Db, username: string): Promise<AdminUser | undefined> {
  return first(
    db
      .select()
      .from(schema.adminUsers)
      .where(sql`lower(${schema.adminUsers.username}) = lower(${username.trim()})`)
      .limit(1)
  );
}

export interface AuthenticationResult {
  user: AdminUser;
  /** The stored hash used older parameters and was replaced. */
  rehashed: boolean;
}

/**
 * Checks a username and password. Unknown usernames are checked against a
 * dummy hash so they take as long as a wrong password. A correct password
 * stored in an older format is rehashed with the current parameters.
 */
export async function authenticate(db: Db, username: string, password: string): Promise<AuthenticationResult | null> {
  const user = await findAdminByUsername(db, username);
  if (!user) {
    await passwordHashing.verify(password, await dummyPasswordHash());
    return null;
  }
  if (!(await passwordHashing.verify(password, user.passwordHash))) return null;
  const rehashed = await rehashIfNeeded(db, user, password);
  return { user, rehashed };
}

/** Replaces an outdated hash after the password has been verified. */
export async function rehashIfNeeded(db: Db, user: AdminUser, password: string): Promise<boolean> {
  if (!passwordNeedsRehash(user.passwordHash)) return false;
  const passwordHash = await passwordHashing.hash(password);
  await db
    .update(schema.adminUsers)
    .set({ passwordHash })
    .where(and(eq(schema.adminUsers.id, user.id), eq(schema.adminUsers.passwordHash, user.passwordHash)));
  return true;
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export interface SessionPolicy {
  /** A session ends after this long without a request. */
  idleTimeoutMs: number;
  /** A session ends this long after sign-in, however active it is. */
  maxAgeMs: number;
}

export interface SessionClient {
  ip: string | null;
  userAgent: string | null;
}

export interface ActiveSession {
  id: number;
  tokenHash: string;
  userId: number;
  username: string;
  createdAt: string;
  expiresAt: string;
  idleExpiresAt: string | null;
  lastSeenAt: string | null;
  cookieReissuedAt: string | null;
}

/** How often `last_seen_at` and the idle deadline are written for an active session. */
export const sessionTouchIntervalMs = 60_000;

export class SessionInactiveError extends Error {
  constructor() {
    super("Session is no longer active");
    this.name = "SessionInactiveError";
  }
}

export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function boundedText(value: string | null | undefined, maxLength: number): string | null {
  if (!value) return null;
  return value.length > maxLength ? value.slice(0, maxLength) : value;
}

export function sessionIsActive(session: Pick<ActiveSession, "expiresAt" | "idleExpiresAt">, now = Date.now()): boolean {
  const expiresAt = Date.parse(session.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= now) return false;
  if (session.idleExpiresAt === null) return true;
  const idleExpiresAt = Date.parse(session.idleExpiresAt);
  return Number.isFinite(idleExpiresAt) && idleExpiresAt > now;
}

/** The moment the session ends if nothing else happens. */
export function sessionDeadline(session: Pick<ActiveSession, "expiresAt" | "idleExpiresAt">): string {
  if (!session.idleExpiresAt) return session.expiresAt;
  return Date.parse(session.idleExpiresAt) < Date.parse(session.expiresAt) ? session.idleExpiresAt : session.expiresAt;
}

export async function deleteInactiveSessions(db: Db, now = Date.now()): Promise<void> {
  const nowIso = new Date(now).toISOString();
  await db
    .delete(schema.sessions)
    .where(or(lt(schema.sessions.expiresAt, nowIso), and(isNotNull(schema.sessions.idleExpiresAt), lt(schema.sessions.idleExpiresAt, nowIso))));
}

export async function createSession(db: Db, userId: number, policy: SessionPolicy, client: SessionClient, now = Date.now()): Promise<{ token: string; session: ActiveSession }> {
  await deleteInactiveSessions(db, now);
  const token = crypto.randomBytes(32).toString("base64url");
  const tokenHash = hashToken(token);
  const nowIso = new Date(now).toISOString();
  const [row] = await db
    .insert(schema.sessions)
    .values({
      tokenHash,
      userId,
      createdAt: nowIso,
      expiresAt: new Date(now + policy.maxAgeMs).toISOString(),
      lastSeenAt: nowIso,
      idleExpiresAt: new Date(now + policy.idleTimeoutMs).toISOString(),
      ip: boundedText(client.ip, 64),
      userAgent: boundedText(client.userAgent, 512)
    })
    .returning();
  const user = await first(db.select({ username: schema.adminUsers.username }).from(schema.adminUsers).where(eq(schema.adminUsers.id, userId)).limit(1));
  if (!row || !user) throw new Error("Session could not be created");
  return { token, session: toActiveSession(row, user.username) };
}

function toActiveSession(row: typeof schema.sessions.$inferSelect, username: string): ActiveSession {
  return {
    id: row.id,
    tokenHash: row.tokenHash,
    userId: row.userId,
    username,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    idleExpiresAt: row.idleExpiresAt,
    lastSeenAt: row.lastSeenAt,
    cookieReissuedAt: row.cookieReissuedAt
  };
}

/** Looks up a session by token hash. An expired or idle session is deleted and reported as missing. */
export async function findActiveSession(db: Db, tokenHash: string, now = Date.now()): Promise<ActiveSession | null> {
  const row = await first(
    db
      .select({ session: schema.sessions, username: schema.adminUsers.username })
      .from(schema.sessions)
      .innerJoin(schema.adminUsers, eq(schema.adminUsers.id, schema.sessions.userId))
      .where(eq(schema.sessions.tokenHash, tokenHash))
      .limit(1)
  );
  if (!row) return null;
  const session = toActiveSession(row.session, row.username);
  if (!sessionIsActive(session, now)) {
    await db.delete(schema.sessions).where(eq(schema.sessions.tokenHash, tokenHash));
    return null;
  }
  return session;
}

/**
 * Throws `SessionInactiveError` unless the session still exists and has
 * neither expired nor gone idle. For long-lived requests such as event
 * streams that need to re-check a session after it was first accepted.
 */
export async function assertSessionActive(db: Db, tokenHash: string, now = Date.now()): Promise<ActiveSession> {
  const session = await findActiveSession(db, tokenHash, now);
  if (!session) throw new SessionInactiveError();
  return session;
}

/** Records activity at most once a minute: last seen time, address, and a new idle deadline. */
export async function touchSession(db: Db, session: ActiveSession, policy: SessionPolicy, client: SessionClient, now = Date.now()): Promise<void> {
  const lastSeen = session.lastSeenAt ? Date.parse(session.lastSeenAt) : Number.NaN;
  if (Number.isFinite(lastSeen) && now - lastSeen < sessionTouchIntervalMs) return;
  const lastSeenAt = new Date(now).toISOString();
  const idleExpiresAt = new Date(now + policy.idleTimeoutMs).toISOString();
  const ip = boundedText(client.ip, 64);
  await db
    .update(schema.sessions)
    .set({ lastSeenAt, idleExpiresAt, ...(ip ? { ip } : {}), userAgent: sql`coalesce(${schema.sessions.userAgent}, ${boundedText(client.userAgent, 512)})` })
    .where(eq(schema.sessions.tokenHash, session.tokenHash));
  session.lastSeenAt = lastSeenAt;
  session.idleExpiresAt = idleExpiresAt;
}

export async function markSessionCookieReissued(db: Db, session: ActiveSession, now = Date.now()): Promise<void> {
  const reissuedAt = new Date(now).toISOString();
  await db.update(schema.sessions).set({ cookieReissuedAt: reissuedAt }).where(eq(schema.sessions.tokenHash, session.tokenHash));
  session.cookieReissuedAt = reissuedAt;
}

export async function deleteSession(db: Db, tokenHash: string): Promise<void> {
  await db.delete(schema.sessions).where(eq(schema.sessions.tokenHash, tokenHash));
}

export interface StoredSession {
  id: number;
  tokenHash: string;
  createdAt: string;
  lastSeenAt: string | null;
  expiresAt: string;
  idleExpiresAt: string | null;
  ip: string | null;
  userAgent: string | null;
}

export async function listUserSessions(db: Db, userId: number, now = Date.now()): Promise<StoredSession[]> {
  await deleteInactiveSessions(db, now);
  return db
    .select({
      id: schema.sessions.id,
      tokenHash: schema.sessions.tokenHash,
      createdAt: schema.sessions.createdAt,
      lastSeenAt: schema.sessions.lastSeenAt,
      expiresAt: schema.sessions.expiresAt,
      idleExpiresAt: schema.sessions.idleExpiresAt,
      ip: schema.sessions.ip,
      userAgent: schema.sessions.userAgent
    })
    .from(schema.sessions)
    .where(eq(schema.sessions.userId, userId))
    .orderBy(asc(schema.sessions.createdAt), asc(schema.sessions.id));
}

/** Ends one of the user's sessions. Returns the revoked session's token hash, or null if none matched. */
export async function revokeUserSession(db: Db, userId: number, sessionId: number): Promise<string | null> {
  const [row] = await db
    .delete(schema.sessions)
    .where(and(eq(schema.sessions.userId, userId), eq(schema.sessions.id, sessionId)))
    .returning({ tokenHash: schema.sessions.tokenHash });
  return row?.tokenHash ?? null;
}

/** Ends every session of the user except the one given. Returns how many ended. */
export async function revokeOtherUserSessions(db: Db, userId: number, keepTokenHash: string): Promise<number> {
  const rows = await db
    .delete(schema.sessions)
    .where(and(eq(schema.sessions.userId, userId), ne(schema.sessions.tokenHash, keepTokenHash)))
    .returning({ id: schema.sessions.id });
  return rows.length;
}

export async function revokeAllUserSessions(db: Db, userId: number): Promise<number> {
  const rows = await db.delete(schema.sessions).where(eq(schema.sessions.userId, userId)).returning({ id: schema.sessions.id });
  return rows.length;
}
