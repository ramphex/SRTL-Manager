import { randomUUID } from "node:crypto";
import type { FastifyRequest } from "fastify";
import { eq, sql } from "drizzle-orm";
import { nowIso, type Db } from "../db/database";
import * as schema from "../db/schema";

/**
 * A record of who did what, and to which items, for actions that change or
 * delete library data or interrupt other people. It lives in the existing
 * `app_settings` table as a bounded list, so it needs no migration and is not
 * pruned with job history. Destructive actions that start a job also leave a
 * line in that job's event log.
 *
 * The recorder is the single seam for the audit trail: when a general security
 * event table exists, only `appendActionAudit` needs to change.
 */

export type ActionAuditAction =
  | "copy.start"
  | "copy.discard_partial"
  | "orphan.purge_hold"
  | "orphan.purge_delete"
  | "media_server.remove"
  | "radarr_instance.remove"
  | "sonarr_instance.remove"
  | "now_playing.stop_stream";

export interface ActionAuditActor {
  userId: number;
  username: string;
}

export interface ActionAuditEntry {
  id: string;
  at: string;
  action: ActionAuditAction;
  summary: string;
  actor: ActionAuditActor | null;
  /** The address the proxy reported, or the socket address when there is no proxy. */
  ip: string;
  requestId: string;
  targets: Record<string, unknown>;
}

export interface ActionAuditInput {
  action: ActionAuditAction;
  summary: string;
  targets: Record<string, unknown>;
  /** Also add a line to this job's event log. */
  jobId?: number;
}

declare module "fastify" {
  interface FastifyRequest {
    /** The signed-in admin for this request, set by the access guard. */
    adminUser: ActionAuditActor | null;
  }
}

const settingKey = "actionAudit";
const lockKey = 781_889_480;
export const actionAuditLimit = 500;
const maxTargetListLength = 100;
const maxTextLength = 300;

function limitTargetValue(value: unknown): unknown {
  if (typeof value === "string") return value.length > maxTextLength ? `${value.slice(0, maxTextLength)}…` : value;
  return value;
}

/** Keeps a record small: long ID lists are cut to their first entries and the full count is kept beside them. */
export function boundedTargets(targets: Record<string, unknown>): Record<string, unknown> {
  const bounded: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(targets)) {
    if (Array.isArray(value) && value.length > maxTargetListLength) {
      bounded[key] = value.slice(0, maxTargetListLength).map(limitTargetValue);
      bounded[`${key}Total`] = value.length;
    } else {
      bounded[key] = Array.isArray(value) ? value.map(limitTargetValue) : limitTargetValue(value);
    }
  }
  return bounded;
}

async function appendActionAudit(db: Db, entry: ActionAuditEntry): Promise<void> {
  await db.transaction(async (transaction) => {
    await transaction.execute(sql`select pg_advisory_xact_lock(${lockKey})`);
    const existing = await readEntries(transaction);
    const next = [...existing, entry].slice(-actionAuditLimit);
    await transaction
      .insert(schema.appSettings)
      .values({ key: settingKey, value: JSON.stringify(next), updatedAt: nowIso() })
      .onConflictDoUpdate({ target: schema.appSettings.key, set: { value: JSON.stringify(next), updatedAt: nowIso() } });
  });
}

async function readEntries(db: Db): Promise<ActionAuditEntry[]> {
  const rows = await db.select().from(schema.appSettings).where(eq(schema.appSettings.key, settingKey)).limit(1);
  const raw = rows[0]?.value;
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as ActionAuditEntry[]) : [];
  } catch {
    return [];
  }
}

/** Newest first. */
export async function listActionAudit(db: Db, limit = 100): Promise<ActionAuditEntry[]> {
  const entries = await readEntries(db);
  return entries.slice(-Math.max(1, limit)).reverse();
}

/**
 * Records an action the signed-in admin just performed. Call it after the
 * action succeeded. A failure to write the record is logged and never turns a
 * finished action into an error response.
 */
export async function recordActionAudit(db: Db, request: FastifyRequest, input: ActionAuditInput): Promise<void> {
  const actor = request.adminUser ?? null;
  const entry: ActionAuditEntry = {
    id: randomUUID(),
    at: nowIso(),
    action: input.action,
    summary: input.summary,
    actor,
    ip: request.ip,
    requestId: String(request.id),
    targets: boundedTargets(input.targets)
  };
  try {
    await appendActionAudit(db, entry);
    if (input.jobId !== undefined) {
      await db.insert(schema.jobEvents).values({
        jobId: input.jobId,
        timestamp: entry.at,
        level: "info",
        message: `${input.summary} (requested by ${actor?.username ?? "unknown user"} from ${entry.ip})`,
        data: JSON.stringify({ audit: entry.id, action: entry.action, requestId: entry.requestId })
      });
    }
  } catch (error) {
    request.log.error({ err: error, auditAction: input.action }, "Action audit record could not be written");
  }
}
