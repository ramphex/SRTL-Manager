import crypto from "node:crypto";
import { promisify } from "node:util";
import { eq, lt, sql } from "drizzle-orm";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Db } from "./db/database";
import { first, nowIso } from "./db/database";
import * as schema from "./db/schema";

const scrypt = promisify(crypto.scrypt);
const adminSetupLockKey = 1_558_042_911;

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16).toString("base64");
  const derived = (await scrypt(password, salt, 64)) as Buffer;
  return `scrypt$${salt}$${derived.toString("base64")}`;
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  const [scheme, salt, digest] = hash.split("$");
  if (scheme !== "scrypt" || !salt || !digest) return false;
  const storedDigest = Buffer.from(digest, "base64");
  if (storedDigest.length !== 64) return false;
  const derived = (await scrypt(password, salt, 64)) as Buffer;
  return crypto.timingSafeEqual(storedDigest, derived);
}

export async function hasAdmin(db: Db): Promise<boolean> {
  return (await db.select({ id: schema.adminUsers.id }).from(schema.adminUsers).limit(1)).length > 0;
}

export async function createAdmin(db: Db, username: string, password: string): Promise<boolean> {
  const passwordHash = await hashPassword(password);
  return db.transaction(async (transaction) => {
    await transaction.execute(sql`select pg_advisory_xact_lock(${adminSetupLockKey})`);
    if ((await transaction.select({ id: schema.adminUsers.id }).from(schema.adminUsers).limit(1)).length > 0) return false;
    await transaction.insert(schema.adminUsers).values({ username, passwordHash, createdAt: nowIso() });
    return true;
  });
}

export async function findAdminByUsername(db: Db, username: string): Promise<typeof schema.adminUsers.$inferSelect | undefined> {
  return first(
    db
      .select()
      .from(schema.adminUsers)
      .where(sql`lower(${schema.adminUsers.username}) = lower(${username.trim()})`)
      .limit(1)
  );
}

export async function login(db: Db, username: string, password: string): Promise<string | null> {
  const user = await findAdminByUsername(db, username);
  if (!user) return null;
  if (!(await verifyPassword(password, user.passwordHash))) return null;
  const token = crypto.randomBytes(32).toString("base64url");
  const tokenHash = hashToken(token);
  await db.delete(schema.sessions).where(lt(schema.sessions.expiresAt, nowIso()));
  const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 14).toISOString();
  await db.insert(schema.sessions).values({ tokenHash, userId: user.id, expiresAt, createdAt: nowIso() });
  return token;
}

export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export async function getSessionUser(db: Db, token: string | undefined): Promise<{ id: number; username: string } | null> {
  if (!token) return null;
  const tokenHash = hashToken(token);
  const session = await first(db.select().from(schema.sessions).where(eq(schema.sessions.tokenHash, tokenHash)).limit(1));
  if (!session) return null;
  if (Date.parse(session.expiresAt) < Date.now()) {
    await db.delete(schema.sessions).where(eq(schema.sessions.tokenHash, tokenHash));
    return null;
  }
  const user = await first(db.select().from(schema.adminUsers).where(eq(schema.adminUsers.id, session.userId)).limit(1));
  return user ? { id: user.id, username: user.username } : null;
}

export async function logout(db: Db, token: string | undefined): Promise<void> {
  if (!token) return;
  await db.delete(schema.sessions).where(eq(schema.sessions.tokenHash, hashToken(token)));
}

export function requireAuth(db: Db, cookieName: string) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const user = await getSessionUser(db, request.cookies[cookieName]);
    if (!user) {
      await reply.code(401).send({ error: "Authentication required" });
    }
  };
}
