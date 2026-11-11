import type { PoolClient } from "pg";

async function hasColumns(client: PoolClient, table: string, columns: string[]): Promise<boolean> {
  const found = await client.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1`,
    [table]
  );
  const names = new Set(found.rows.map((row) => row.column_name));
  return columns.every((column) => names.has(column));
}

async function tableExists(client: PoolClient, table: string): Promise<boolean> {
  const found = await client.query<{ name: string | null }>(`SELECT to_regclass($1) AS name`, [`public.${table}`]);
  return Boolean(found.rows[0]?.name);
}

/**
 * Before this release, audits byte-compared against the recorded source unless the setting was turned off, and the
 * settings page saved the whole audit block whenever any advanced setting was saved. A stored true is therefore the
 * old default, not a choice anyone made: the only choice the old default allowed was turning it off, and a stored
 * false is kept. So true becomes false here, and from now on only an explicit true turns it on.
 */
export function withAuditByteCompareDefaultOff(value: unknown): { value: unknown; changed: boolean } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { value, changed: false };
  const record = value as Record<string, unknown>;
  const audit = record.audit;
  if (!audit || typeof audit !== "object" || Array.isArray(audit)) return { value, changed: false };
  if ((audit as Record<string, unknown>).byteCompareWhenSourceKnown !== true) return { value, changed: false };
  return { value: { ...record, audit: { ...(audit as Record<string, unknown>), byteCompareWhenSourceKnown: false } }, changed: true };
}

/**
 * Migration 34: the last audit time and result per storage file, which the nightly rolling audit orders by and the
 * Damaged files page reads, plus two audit run columns for the rolling audit's coverage and speed.
 */
export async function applyAuditStateMigration(client: PoolClient): Promise<void> {
  if (await tableExists(client, "storage_files")) {
    await client.query(`ALTER TABLE storage_files ADD COLUMN IF NOT EXISTS audit_checked_at TEXT`);
    await client.query(`ALTER TABLE storage_files ADD COLUMN IF NOT EXISTS audit_status TEXT`);
    await client.query(`ALTER TABLE storage_files ADD COLUMN IF NOT EXISTS audit_mode TEXT`);
    await client.query(`ALTER TABLE storage_files ADD COLUMN IF NOT EXISTS audit_message TEXT`);
    // Never-audited files first, then the oldest checked; only current local files take part.
    // The minimal legacy tables used by old migration tests lack these columns; the indexes are only for real tables.
    if (await hasColumns(client, "storage_files", ["root_type", "missing_since"])) await client.query(
      `CREATE INDEX IF NOT EXISTS storage_files_audit_order_idx ON storage_files (audit_checked_at ASC NULLS FIRST, id) WHERE root_type = 'local' AND missing_since IS NULL`
    );
    await client.query(`CREATE INDEX IF NOT EXISTS storage_files_audit_failed_idx ON storage_files (id) WHERE audit_status = 'fail'`);
  }
  if (await tableExists(client, "audit_runs")) {
    await client.query(`ALTER TABLE audit_runs ADD COLUMN IF NOT EXISTS rolling BOOLEAN NOT NULL DEFAULT false`);
    await client.query(`ALTER TABLE audit_runs ADD COLUMN IF NOT EXISTS checked_bytes BIGINT NOT NULL DEFAULT 0`);
    await client.query(`ALTER TABLE audit_runs ADD COLUMN IF NOT EXISTS stop_reason TEXT`);
  }
  if (await tableExists(client, "app_settings")) {
    const stored = await client.query<{ value: string }>(`SELECT value FROM app_settings WHERE key = 'advancedSettings' FOR UPDATE`);
    const raw = stored.rows[0]?.value;
    if (raw) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        // An unreadable value already blocks the settings page with its own message; leave it to be repaired.
        return;
      }
      const next = withAuditByteCompareDefaultOff(parsed);
      if (next.changed) {
        await client.query(`UPDATE app_settings SET value = $1, updated_at = $2 WHERE key = 'advancedSettings'`, [JSON.stringify(next.value), new Date().toISOString()]);
      }
    }
  }
}
