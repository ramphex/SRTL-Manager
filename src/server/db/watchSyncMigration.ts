import type { PoolClient } from "pg";

// Migration 22: Plex and Jellyfin watch sync. Kept apart from database.ts so the
// migration list there stays a one-line change.
export async function applyWatchSyncMigration(client: PoolClient): Promise<void> {
  await client.query(`CREATE TABLE IF NOT EXISTS watch_sync_users (
    server_id TEXT NOT NULL, external_id TEXT NOT NULL, name TEXT NOT NULL, username TEXT, kind TEXT NOT NULL,
    account_id TEXT, access_token TEXT, available BOOLEAN NOT NULL DEFAULT true, note TEXT, updated_at TEXT NOT NULL,
    PRIMARY KEY (server_id, external_id)
  )`);
  await client.query(`CREATE TABLE IF NOT EXISTS watch_sync_pairs (
    id SERIAL PRIMARY KEY, plex_server_id TEXT NOT NULL, plex_user_id TEXT NOT NULL,
    jellyfin_server_id TEXT NOT NULL, jellyfin_user_id TEXT NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT true, paused BOOLEAN NOT NULL DEFAULT false,
    direction TEXT NOT NULL DEFAULT 'both' CHECK (direction IN ('plex_to_jellyfin', 'jellyfin_to_plex', 'both')),
    sync_watched BOOLEAN, sync_position BOOLEAN, approved_at TEXT, preview TEXT,
    plex_cursor TEXT, jellyfin_cursor TEXT, recheck_cursor TEXT,
    last_sync_at TEXT, last_full_sync_at TEXT, last_error TEXT, error_count INTEGER NOT NULL DEFAULT 0, next_attempt_at TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  )`);
  await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS watch_sync_pairs_users_idx ON watch_sync_pairs(plex_server_id, plex_user_id, jellyfin_server_id, jellyfin_user_id)`);
  // SRTL symlink path to the item id one server uses for it.
  await client.query(`CREATE TABLE IF NOT EXISTS watch_sync_items (
    server_id TEXT NOT NULL, link_path TEXT NOT NULL, item_id TEXT NOT NULL, seen_at TEXT NOT NULL,
    PRIMARY KEY (server_id, link_path)
  )`);
  await client.query(`CREATE INDEX IF NOT EXISTS watch_sync_items_item_idx ON watch_sync_items(server_id, item_id)`);
  // The state each side had when a pair last synced a path: the base of the three-way comparison.
  await client.query(`CREATE TABLE IF NOT EXISTS watch_sync_state (
    pair_id INTEGER NOT NULL REFERENCES watch_sync_pairs(id) ON DELETE CASCADE, link_path TEXT NOT NULL,
    plex_watched BOOLEAN, plex_position_ms BIGINT, plex_at TEXT,
    jellyfin_watched BOOLEAN, jellyfin_position_ms BIGINT, jellyfin_at TEXT,
    synced_at TEXT NOT NULL,
    PRIMARY KEY (pair_id, link_path)
  )`);
  await client.query(`CREATE TABLE IF NOT EXISTS watch_sync_activity (
    id SERIAL PRIMARY KEY, pair_id INTEGER REFERENCES watch_sync_pairs(id) ON DELETE CASCADE, at TEXT NOT NULL, level TEXT NOT NULL,
    direction TEXT, action TEXT, link_path TEXT, message TEXT NOT NULL, job_id INTEGER
  )`);
  await client.query(`CREATE INDEX IF NOT EXISTS watch_sync_activity_pair_idx ON watch_sync_activity(pair_id, id)`);
  await client.query(`CREATE INDEX IF NOT EXISTS watch_sync_activity_at_idx ON watch_sync_activity(at)`);
  await client.query(`CREATE TABLE IF NOT EXISTS watch_sync_cursors (scope TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)`);
  // Adds watch_sync to whatever job types the constraint already allows, so it composes with other migrations that extend it.
  await client.query(`DO $$
  DECLARE definition text; types text[];
  BEGIN
    IF to_regclass('public.jobs') IS NULL THEN RETURN; END IF;
    SELECT pg_get_constraintdef(oid) INTO definition FROM pg_constraint WHERE conname = 'jobs_type_check' AND conrelid = 'jobs'::regclass;
    IF definition IS NULL OR position('''watch_sync''' in definition) > 0 THEN RETURN; END IF;
    SELECT array_agg(match[1]) INTO types FROM regexp_matches(definition, '''([a-z_]+)''', 'g') AS match;
    types := array_append(types, 'watch_sync');
    ALTER TABLE jobs DROP CONSTRAINT jobs_type_check;
    EXECUTE format('ALTER TABLE jobs ADD CONSTRAINT jobs_type_check CHECK (type IN (%s))', (SELECT string_agg(quote_literal(value), ', ') FROM unnest(types) AS value));
  END $$`);
}
