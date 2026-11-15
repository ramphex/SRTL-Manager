import type { PoolClient } from "pg";

async function hasColumns(client: PoolClient, table: string, columns: string[]): Promise<boolean> {
  const found = await client.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1`,
    [table]
  );
  const names = new Set(found.rows.map((row) => row.column_name));
  return columns.every((column) => names.has(column));
}

/**
 * Migration 36: the file header check result of each storage file. Every existing row starts with no result and no
 * queue mark, so nothing already in the library is checked at the end of a scan; the background pass covers them.
 */
export async function applyFileHeaderMigration(client: PoolClient): Promise<void> {
  const exists = await client.query<{ name: string | null }>(`SELECT to_regclass('public.storage_files') AS name`);
  if (!exists.rows[0]?.name) return;
  await client.query(`ALTER TABLE storage_files ADD COLUMN IF NOT EXISTS header_status TEXT`);
  await client.query(`ALTER TABLE storage_files ADD COLUMN IF NOT EXISTS header_reason TEXT`);
  await client.query(`ALTER TABLE storage_files ADD COLUMN IF NOT EXISTS header_checked_at TEXT`);
  await client.query(`ALTER TABLE storage_files ADD COLUMN IF NOT EXISTS header_checked_size_bytes BIGINT`);
  await client.query(`ALTER TABLE storage_files ADD COLUMN IF NOT EXISTS header_checked_mtime_ms BIGINT`);
  await client.query(`ALTER TABLE storage_files ADD COLUMN IF NOT EXISTS header_queued_at TEXT`);
  // The minimal legacy tables used by old migration tests lack these columns; the indexes are only for real tables.
  if (!(await hasColumns(client, "storage_files", ["root_type", "missing_since"]))) return;
  // The background pass reads files with no result yet (or one to retry), a few per root at a time, in id order.
  await client.query(
    `CREATE INDEX IF NOT EXISTS storage_files_header_pending_idx ON storage_files (root_type, id) WHERE missing_since IS NULL AND header_queued_at IS NULL AND (header_status IS NULL OR header_status = 'retry')`
  );
  await client.query(`CREATE INDEX IF NOT EXISTS storage_files_header_queued_idx ON storage_files (header_queued_at, id) WHERE header_queued_at IS NOT NULL`);
  await client.query(`CREATE INDEX IF NOT EXISTS storage_files_header_failed_idx ON storage_files (id) WHERE header_status = 'fail'`);
}
