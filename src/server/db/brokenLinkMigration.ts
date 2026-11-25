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
  // Sonarr and Radarr file records with nothing in the library, from the latest arr disk check. Replaced per instance on each check.
  await client.query(`CREATE TABLE IF NOT EXISTS arr_disk_mismatches (
    id SERIAL PRIMARY KEY,
    job_id INTEGER NOT NULL,
    service TEXT NOT NULL CHECK (service IN ('radarr', 'sonarr')),
    instance_id TEXT NOT NULL,
    instance_name TEXT NOT NULL,
    arr_item_id INTEGER NOT NULL,
    arr_file_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    section TEXT NOT NULL,
    item_name TEXT NOT NULL,
    relative_path TEXT NOT NULL,
    arr_path TEXT NOT NULL,
    episodes TEXT,
    first_found_at TEXT NOT NULL,
    checked_at TEXT NOT NULL,
    requested_at TEXT
  )`);
  await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS arr_disk_mismatches_file_idx ON arr_disk_mismatches (instance_id, arr_file_id)`);
  // The check runs as its own job type, so arr calls never hold up or fail a scan.
  await client.query(`DO $$
  DECLARE definition text; types text[];
  BEGIN
    IF to_regclass('public.jobs') IS NULL THEN RETURN; END IF;
    SELECT pg_get_constraintdef(oid) INTO definition FROM pg_constraint WHERE conname = 'jobs_type_check' AND conrelid = 'jobs'::regclass;
    IF definition IS NULL OR position('''arr_disk_check''' in definition) > 0 THEN RETURN; END IF;
    SELECT array_agg(match[1]) INTO types FROM regexp_matches(definition, '''([a-z_]+)''', 'g') AS match;
    types := array_append(types, 'arr_disk_check');
    ALTER TABLE jobs DROP CONSTRAINT jobs_type_check;
    EXECUTE format('ALTER TABLE jobs ADD CONSTRAINT jobs_type_check CHECK (type IN (%s))', (SELECT string_agg(quote_literal(value), ', ') FROM unnest(types) AS value));
  END $$`);
}
