import { and, eq, lt, sql } from "drizzle-orm";
import type { Db } from "../db/database";
import * as schema from "../db/schema";

export const workerHeartbeatRetentionMs = 24 * 60 * 60 * 1_000;

export interface WorkerHeartbeat {
  workerId: string;
  startedAt: string;
  heartbeatAt: string;
  status: "running" | "stopped";
  capacity: number;
}

export async function recordWorkerHeartbeat(db: Db, heartbeat: WorkerHeartbeat): Promise<void> {
  await db
    .insert(schema.workerHeartbeats)
    .values(heartbeat)
    .onConflictDoUpdate({
      target: schema.workerHeartbeats.workerId,
      set: {
        heartbeatAt: heartbeat.heartbeatAt,
        status: heartbeat.status,
        capacity: heartbeat.capacity
      }
    });
}

export async function pruneWorkerHeartbeatHistory(db: Db, nowMs = Date.now()): Promise<void> {
  const cutoff = new Date(nowMs - workerHeartbeatRetentionMs).toISOString();
  await db.execute(sql`
    delete from worker_heartbeats
    where status = 'stopped'
      and not exists (
        select 1
        from jobs
        where jobs.status = 'running'
          and jobs.locked_by = worker_heartbeats.worker_id
      )
  `);
  await db
    .delete(schema.workerHeartbeats)
    .where(and(eq(schema.workerHeartbeats.status, "running"), lt(schema.workerHeartbeats.heartbeatAt, cutoff)));
}
