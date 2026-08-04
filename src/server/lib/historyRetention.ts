import { sql } from "drizzle-orm";
import { dbAll, type Db } from "../db/database";

const retentionBatchSize = 500;

export async function pruneTerminalJobHistory(db: Db, retentionDays: number, nowMs = Date.now()): Promise<number> {
  if (retentionDays === 0) return 0;
  const cutoff = new Date(nowMs - retentionDays * 24 * 60 * 60 * 1_000).toISOString();
  let removed = 0;

  while (true) {
    const rows = await dbAll<{ id: number }>(db, sql`
      WITH expired_jobs AS (
        SELECT jobs.id
        FROM jobs
        WHERE jobs.status IN ('completed', 'partially_failed', 'failed', 'cancelled')
          AND jobs.type <> 'path_migration'
          AND jobs.finished_at IS NOT NULL
          AND jobs.finished_at < ${cutoff}
          AND NOT EXISTS (
            SELECT 1
            FROM copy_operations AS recovery_operation
            WHERE recovery_operation.job_id = jobs.id
              AND recovery_operation.stage = 'reconciliation_required'
              AND NOT EXISTS (
                SELECT 1
                FROM copy_operations AS superseding_operation
                WHERE superseding_operation.id > recovery_operation.id
                  AND superseding_operation.media_link_id = recovery_operation.media_link_id
                  AND superseding_operation.link_path = recovery_operation.link_path
                  AND superseding_operation.stage = 'committed'
                  AND superseding_operation.result_status IN ('copied', 'repointed')
              )
          )
        ORDER BY jobs.id
        LIMIT ${retentionBatchSize}
      )
      DELETE FROM jobs
      USING expired_jobs
      WHERE jobs.id = expired_jobs.id
      RETURNING jobs.id
    `);
    removed += rows.length;
    if (rows.length < retentionBatchSize) return removed;
  }
}

export async function pruneExpiredSessions(db: Db, now = new Date().toISOString()): Promise<number> {
  const rows = await dbAll<{ tokenHash: string }>(db, sql`
    DELETE FROM sessions
    WHERE expires_at < ${now}
    RETURNING token_hash AS "tokenHash"
  `);
  return rows.length;
}
