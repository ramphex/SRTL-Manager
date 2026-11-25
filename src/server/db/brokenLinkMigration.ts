import type { PoolClient } from "pg";

async function columnsOf(client: PoolClient, table: string): Promise<Set<string>> {
  const found = await client.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1`,
    [table]
  );
  return new Set(found.rows.map((row) => row.column_name));
}

/**
 * Migration 38: when each link was first seen broken, for the broken link review, and broken-link removals in the
 * failed-copy cleanup journal. Tables a very old schema does not have yet are left alone; the bootstrap creates them.
 */
export async function applyBrokenLinkMigration(client: PoolClient): Promise<void> {
  const links = await columnsOf(client, "media_links");
  if (links.size > 0) {
    await client.query(`ALTER TABLE media_links ADD COLUMN IF NOT EXISTS broken_since TEXT`);
    // Links already broken take their last change, which is when a scan last changed them, so usually when they broke.
    if (["kind", "last_changed_at", "updated_at"].every((column) => links.has(column))) {
      await client.query(`UPDATE media_links SET broken_since = COALESCE(last_changed_at, updated_at) WHERE kind = 'broken' AND broken_since IS NULL`);
    }
    if (["section", "item_name", "kind", "missing_since"].every((column) => links.has(column))) {
      await client.query(`CREATE INDEX IF NOT EXISTS media_links_broken_idx ON media_links (section, item_name) WHERE kind = 'broken' AND missing_since IS NULL`);
    }
  }
  const cleanup = await columnsOf(client, "symlink_cleanup_operations");
  if (cleanup.size > 0) {
    // `reason` tells broken-link removals apart, since a failed-copy row loses its source job when job history is pruned.
    // A link that changed before its removal is recorded as skipped.
    await client.query(`ALTER TABLE symlink_cleanup_operations ADD COLUMN IF NOT EXISTS reason TEXT NOT NULL DEFAULT 'failed_copy'`);
    await client.query(`ALTER TABLE symlink_cleanup_operations DROP CONSTRAINT IF EXISTS symlink_cleanup_operations_stage_check`);
    await client.query(`ALTER TABLE symlink_cleanup_operations ADD CONSTRAINT symlink_cleanup_operations_stage_check CHECK (stage IN ('planned', 'removed', 'already_missing', 'skipped', 'failed'))`);
    await client.query(`ALTER TABLE symlink_cleanup_operations DROP CONSTRAINT IF EXISTS symlink_cleanup_operations_reason_check`);
    await client.query(`ALTER TABLE symlink_cleanup_operations ADD CONSTRAINT symlink_cleanup_operations_reason_check CHECK (reason IN ('failed_copy', 'broken_link'))`);
    if (cleanup.has("completed_at")) await client.query(`CREATE INDEX IF NOT EXISTS symlink_cleanup_operations_reason_idx ON symlink_cleanup_operations (reason, completed_at)`);
  }
}
