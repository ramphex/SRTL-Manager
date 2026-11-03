import { desc, lt, sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import type { Db } from "./db/database";
import * as schema from "./db/schema";
import { describeUserAgent, type SecurityEventRecord, type SecurityEventType } from "../shared/auth";

/** The newest events kept regardless of age, so a flood of failures cannot grow the table without bound. */
export const securityEventRowCap = 50_000;

export interface SecurityEventInput {
  event: SecurityEventType;
  request?: FastifyRequest;
  userId?: number | null;
  username?: string | null;
  sessionId?: number | null;
  details?: Record<string, unknown>;
}

function bounded(value: string | null | undefined, maxLength: number): string | null {
  if (!value) return null;
  return value.length > maxLength ? value.slice(0, maxLength) : value;
}

/**
 * Appends one security event. Never throws: a failed write is logged and the
 * request carries on, so auditing cannot lock anyone out.
 */
export async function recordSecurityEvent(db: Db, input: SecurityEventInput): Promise<void> {
  const { request } = input;
  try {
    const userAgent = request?.headers["user-agent"];
    await db.insert(schema.securityEvents).values({
      createdAt: new Date().toISOString(),
      event: input.event,
      userId: input.userId ?? null,
      username: bounded(input.username, 100),
      sessionId: input.sessionId ?? null,
      ip: bounded(request?.ip, 64),
      socketIp: bounded(request?.socket?.remoteAddress, 64),
      userAgent: bounded(typeof userAgent === "string" ? userAgent : null, 512),
      details: JSON.stringify(input.details ?? {})
    });
  } catch (error) {
    request?.log.error({ err: error, event: input.event }, "Could not record security event");
  }
}

export async function listSecurityEvents(db: Db, options: { limit: number; beforeId?: number }): Promise<{ events: SecurityEventRecord[]; hasMore: boolean }> {
  const rows = await db
    .select()
    .from(schema.securityEvents)
    .where(options.beforeId === undefined ? undefined : lt(schema.securityEvents.id, options.beforeId))
    .orderBy(desc(schema.securityEvents.id))
    .limit(options.limit + 1);
  const events = rows.slice(0, options.limit).map((row): SecurityEventRecord => {
    let details: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(row.details) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) details = parsed as Record<string, unknown>;
    } catch {
      details = {};
    }
    return {
      id: row.id,
      createdAt: row.createdAt,
      event: row.event,
      username: row.username,
      ip: row.ip,
      device: row.userAgent ? describeUserAgent(row.userAgent) : null,
      details
    };
  });
  return { events, hasMore: rows.length > options.limit };
}

/**
 * Removes events older than the retention period (0 keeps them by age) and
 * anything beyond the newest `securityEventRowCap` rows.
 */
export async function pruneSecurityEvents(db: Db, retentionDays: number, now = Date.now(), rowCap = securityEventRowCap): Promise<number> {
  let removed = 0;
  if (retentionDays > 0) {
    const cutoff = new Date(now - retentionDays * 24 * 60 * 60 * 1_000).toISOString();
    removed += (await db.delete(schema.securityEvents).where(lt(schema.securityEvents.createdAt, cutoff)).returning({ id: schema.securityEvents.id })).length;
  }
  const overflow = await db
    .delete(schema.securityEvents)
    .where(sql`${schema.securityEvents.id} <= (select id from ${schema.securityEvents} order by id desc offset ${rowCap} limit 1)`)
    .returning({ id: schema.securityEvents.id });
  return removed + overflow.length;
}
