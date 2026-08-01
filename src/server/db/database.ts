import { eq, type SQL } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool, type PoolConfig, type QueryResult, type QueryResultRow } from "pg";
import * as schema from "./schema";
import type { SectionContentType, SectionSettings } from "../../shared/types";
import { inferSectionContentType, normalizeSectionContentType } from "../../shared/sections";

export type Db = NodePgDatabase<typeof schema>;
export type DbExecutor = Db;
export { inferSectionContentType } from "../../shared/sections";

export interface DatabaseContext {
  pool: Pool;
  db: Db;
  close(): Promise<void>;
}

export interface DatabaseOpenOptions {
  databaseUrl: string;
  migrate?: boolean;
  pool?: Pool;
}

export const currentSchemaVersion = 7;

const ddl = [
  `CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS path_configurations (id SERIAL PRIMARY KEY, status TEXT NOT NULL, symlink_dir TEXT NOT NULL, local_dir TEXT NOT NULL, remote_dir TEXT NOT NULL, symlink_identity TEXT NOT NULL, local_identity TEXT NOT NULL, remote_identity TEXT NOT NULL, created_at TEXT NOT NULL, applied_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS path_migrations (id SERIAL PRIMARY KEY, source_config_id INTEGER, target_config_id INTEGER NOT NULL, status TEXT NOT NULL, job_id INTEGER, error_message TEXT, created_at TEXT NOT NULL, planned_at TEXT, started_at TEXT, finished_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS path_migration_items (id SERIAL PRIMARY KEY, migration_id INTEGER NOT NULL, media_link_id INTEGER NOT NULL, item_name TEXT NOT NULL, current_link_path TEXT NOT NULL, link_path_before TEXT NOT NULL, link_path_after TEXT NOT NULL, target_path_before TEXT NOT NULL, target_path_after TEXT NOT NULL, target_changed BOOLEAN NOT NULL, expected_size_bytes BIGINT, target_identity TEXT, validation_status TEXT NOT NULL, message TEXT NOT NULL, applied_at TEXT, rolled_back_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS admin_users (id SERIAL PRIMARY KEY, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL, expires_at TEXT NOT NULL, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS sections (id SERIAL PRIMARY KEY, name TEXT NOT NULL UNIQUE, display_name TEXT, content_type TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS media_links (id SERIAL PRIMARY KEY, section TEXT NOT NULL, item_name TEXT NOT NULL, relative_path TEXT NOT NULL, link_path TEXT NOT NULL UNIQUE, target_path TEXT NOT NULL, kind TEXT NOT NULL, target_exists BOOLEAN NOT NULL, is_media BOOLEAN NOT NULL, storage_policy TEXT NOT NULL DEFAULT 'unassigned', resolved_storage_file_id INTEGER, size_bytes BIGINT, first_seen_at TEXT, last_seen_at TEXT, last_changed_at TEXT, missing_since TEXT, last_seen_job_id INTEGER, updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS storage_files (id SERIAL PRIMARY KEY, root_type TEXT NOT NULL, root_path TEXT NOT NULL, section TEXT NOT NULL DEFAULT '', item_name TEXT NOT NULL DEFAULT '', relative_path TEXT NOT NULL, file_path TEXT NOT NULL UNIQUE, storage_policy TEXT NOT NULL DEFAULT 'unassigned', size_bytes BIGINT NOT NULL, mtime_ms BIGINT NOT NULL, first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, last_changed_at TEXT NOT NULL, missing_since TEXT, last_seen_job_id INTEGER NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS storage_policies (id SERIAL PRIMARY KEY, title TEXT NOT NULL, normalized_title TEXT NOT NULL UNIQUE, policy TEXT NOT NULL, source TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS copy_sources (id SERIAL PRIMARY KEY, destination_path TEXT NOT NULL UNIQUE, source_path TEXT NOT NULL, link_path TEXT NOT NULL, recorded_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS jobs (id SERIAL PRIMARY KEY, type TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT, locked_by TEXT, locked_at TEXT, heartbeat_at TEXT, cancel_requested_at TEXT, progress TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS job_events (id SERIAL PRIMARY KEY, job_id INTEGER NOT NULL, timestamp TEXT NOT NULL, level TEXT NOT NULL, message TEXT NOT NULL, data TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS scan_runs (id SERIAL PRIMARY KEY, job_id INTEGER NOT NULL, status TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT, error_message TEXT, total_links INTEGER NOT NULL, remote_links INTEGER NOT NULL, local_links INTEGER NOT NULL, broken_links INTEGER NOT NULL, other_links INTEGER NOT NULL, non_media_links INTEGER NOT NULL, actionable_remote_links INTEGER NOT NULL, actionable_local_links INTEGER NOT NULL DEFAULT 0, assigned_remote_links INTEGER NOT NULL, unassigned_remote_links INTEGER NOT NULL DEFAULT 0, unassigned_local_links INTEGER NOT NULL DEFAULT 0, local_files INTEGER NOT NULL DEFAULT 0, remote_files INTEGER NOT NULL DEFAULT 0, actionable_remote_files INTEGER NOT NULL DEFAULT 0, actionable_local_files INTEGER NOT NULL DEFAULT 0, assigned_remote_files INTEGER NOT NULL DEFAULT 0, unassigned_remote_files INTEGER NOT NULL DEFAULT 0, unassigned_local_files INTEGER NOT NULL DEFAULT 0, local_orphan_files INTEGER NOT NULL DEFAULT 0, remote_orphan_files INTEGER NOT NULL DEFAULT 0, missing_links INTEGER NOT NULL DEFAULT 0, missing_local_files INTEGER NOT NULL DEFAULT 0, missing_remote_files INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS audit_runs (id SERIAL PRIMARY KEY, job_id INTEGER NOT NULL, mode TEXT NOT NULL, status TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT, checked INTEGER NOT NULL, passed INTEGER NOT NULL, failed INTEGER NOT NULL, source_unknown INTEGER NOT NULL, source_missing INTEGER NOT NULL, source_compare_errors INTEGER NOT NULL, byte_mismatches INTEGER NOT NULL, target_validation_failures INTEGER NOT NULL DEFAULT 0, error_message TEXT)`,
  `CREATE TABLE IF NOT EXISTS audit_results (id SERIAL PRIMARY KEY, audit_run_id INTEGER NOT NULL, link_path TEXT NOT NULL, target_path TEXT NOT NULL, source_path TEXT, status TEXT NOT NULL, ffmpeg_status TEXT NOT NULL, cmp_status TEXT NOT NULL, message TEXT NOT NULL, created_at TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS media_links_section_idx ON media_links(section)`,
  `CREATE INDEX IF NOT EXISTS media_links_kind_idx ON media_links(kind)`,
  `CREATE INDEX IF NOT EXISTS media_links_storage_policy_idx ON media_links(storage_policy)`,
  `CREATE INDEX IF NOT EXISTS storage_policies_policy_idx ON storage_policies(policy)`,
  `CREATE INDEX IF NOT EXISTS storage_files_root_type_idx ON storage_files(root_type)`,
  `CREATE INDEX IF NOT EXISTS storage_files_missing_idx ON storage_files(missing_since)`,
  `CREATE INDEX IF NOT EXISTS storage_files_root_relative_path_idx ON storage_files(root_type, relative_path)`,
  `CREATE INDEX IF NOT EXISTS job_events_job_idx ON job_events(job_id, id)`,
  `CREATE INDEX IF NOT EXISTS storage_files_storage_policy_idx ON storage_files(storage_policy)`,
  `CREATE INDEX IF NOT EXISTS storage_files_item_name_idx ON storage_files(item_name)`,
  `CREATE INDEX IF NOT EXISTS media_links_resolved_storage_idx ON media_links(resolved_storage_file_id)`,
  `CREATE INDEX IF NOT EXISTS media_links_missing_idx ON media_links(missing_since)`,
  `CREATE INDEX IF NOT EXISTS media_links_section_relative_path_idx ON media_links(section, relative_path)`,
  `CREATE INDEX IF NOT EXISTS jobs_status_idx ON jobs(status, id)`,
  `CREATE INDEX IF NOT EXISTS jobs_heartbeat_idx ON jobs(status, heartbeat_at)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS path_configurations_one_active_idx ON path_configurations ((status)) WHERE status = 'active'`,
  `CREATE INDEX IF NOT EXISTS path_migrations_status_idx ON path_migrations(status, id)`,
  `CREATE INDEX IF NOT EXISTS path_migration_items_migration_idx ON path_migration_items(migration_id, id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS path_migration_items_link_idx ON path_migration_items(migration_id, media_link_id)`
];

const hardeningDdl = [
  `CREATE TABLE IF NOT EXISTS copy_operations (id SERIAL PRIMARY KEY, job_id INTEGER NOT NULL, media_link_id INTEGER NOT NULL, link_path TEXT NOT NULL, source_path TEXT NOT NULL, destination_path TEXT NOT NULL, original_target_path TEXT NOT NULL, original_link_state TEXT NOT NULL, previous_copy_source TEXT, temp_path TEXT, displaced_path TEXT, temp_identity TEXT, destination_identity TEXT, displaced_identity TEXT, stage TEXT NOT NULL, result_status TEXT, local_conflict_strategy TEXT, size_bytes BIGINT, error_message TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed_at TEXT, UNIQUE(job_id, media_link_id))`,
  `CREATE INDEX IF NOT EXISTS copy_operations_job_stage_idx ON copy_operations(job_id, stage, id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS admin_users_singleton_idx ON admin_users ((true))`,
  `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sessions_user_fk') THEN ALTER TABLE sessions ADD CONSTRAINT sessions_user_fk FOREIGN KEY (user_id) REFERENCES admin_users(id) ON DELETE CASCADE NOT VALID; END IF; END $$`,
  `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'job_events_job_fk') THEN ALTER TABLE job_events ADD CONSTRAINT job_events_job_fk FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE NOT VALID; END IF; END $$`,
  `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'scan_runs_job_fk') THEN ALTER TABLE scan_runs ADD CONSTRAINT scan_runs_job_fk FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE NOT VALID; END IF; END $$`,
  `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'audit_runs_job_fk') THEN ALTER TABLE audit_runs ADD CONSTRAINT audit_runs_job_fk FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE NOT VALID; END IF; END $$`,
  `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'audit_results_run_fk') THEN ALTER TABLE audit_results ADD CONSTRAINT audit_results_run_fk FOREIGN KEY (audit_run_id) REFERENCES audit_runs(id) ON DELETE CASCADE NOT VALID; END IF; END $$`,
  `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'copy_operations_job_fk') THEN ALTER TABLE copy_operations ADD CONSTRAINT copy_operations_job_fk FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE NOT VALID; END IF; END $$`,
  `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'copy_operations_media_link_fk') THEN ALTER TABLE copy_operations ADD CONSTRAINT copy_operations_media_link_fk FOREIGN KEY (media_link_id) REFERENCES media_links(id) ON DELETE RESTRICT NOT VALID; END IF; END $$`,
  `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'path_migration_items_migration_fk') THEN ALTER TABLE path_migration_items ADD CONSTRAINT path_migration_items_migration_fk FOREIGN KEY (migration_id) REFERENCES path_migrations(id) ON DELETE CASCADE NOT VALID; END IF; END $$`,
  `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'jobs_status_check') THEN ALTER TABLE jobs ADD CONSTRAINT jobs_status_check CHECK (status IN ('queued', 'running', 'completed', 'partially_failed', 'failed', 'cancelled')) NOT VALID; END IF; END $$`,
  `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'jobs_type_check') THEN ALTER TABLE jobs ADD CONSTRAINT jobs_type_check CHECK (type IN ('scan', 'audit', 'copy', 'path_migration')) NOT VALID; END IF; END $$`,
  `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'media_links_kind_check') THEN ALTER TABLE media_links ADD CONSTRAINT media_links_kind_check CHECK (kind IN ('remote', 'local', 'broken', 'other', 'non_media')) NOT VALID; END IF; END $$`,
  `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'media_links_policy_check') THEN ALTER TABLE media_links ADD CONSTRAINT media_links_policy_check CHECK (storage_policy IN ('unassigned', 'assign_local', 'assign_remote')) NOT VALID; END IF; END $$`,
  `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'storage_files_policy_check') THEN ALTER TABLE storage_files ADD CONSTRAINT storage_files_policy_check CHECK (storage_policy IN ('unassigned', 'assign_local', 'assign_remote')) NOT VALID; END IF; END $$`,
  `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'storage_files_root_type_check') THEN ALTER TABLE storage_files ADD CONSTRAINT storage_files_root_type_check CHECK (root_type IN ('local', 'remote')) NOT VALID; END IF; END $$`,
  `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'storage_policies_policy_check') THEN ALTER TABLE storage_policies ADD CONSTRAINT storage_policies_policy_check CHECK (policy IN ('assign_local', 'assign_remote')) NOT VALID; END IF; END $$`,
  `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'copy_operations_stage_check') THEN ALTER TABLE copy_operations ADD CONSTRAINT copy_operations_stage_check CHECK (stage IN ('planned', 'transferring', 'verified', 'destination_displaced', 'promoted', 'repointed', 'committed', 'rolled_back', 'failed', 'reconciliation_required')) NOT VALID; END IF; END $$`
];

const bootstrapLockKey = 781_889_432;

function createPool(databaseUrl: string): Pool {
  const config: PoolConfig = { connectionString: databaseUrl };
  return new Pool(config);
}

async function initializeDatabase(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("select pg_advisory_lock($1)", [bootstrapLockKey]);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)`);
    const applied = new Set((await client.query<{ version: number }>(`SELECT version FROM schema_migrations`)).rows.map((row) => row.version));

    if (!applied.has(1)) {
      await client.query("BEGIN");
      try {
        for (const statement of ddl) await client.query(statement);
        await client.query(`INSERT INTO schema_migrations (version, name, applied_at) VALUES (1, 'initial_postgres_schema', $1)`, [nowIso()]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }

    if (!applied.has(2)) {
      await client.query("BEGIN");
      try {
        for (const statement of hardeningDdl) await client.query(statement);
        await client.query(`INSERT INTO schema_migrations (version, name, applied_at) VALUES (2, 'beta_security_and_recovery', $1)`, [nowIso()]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }

    if (!applied.has(3)) {
      await client.query("BEGIN");
      try {
        await client.query(
          `CREATE TABLE IF NOT EXISTS worker_heartbeats (worker_id TEXT PRIMARY KEY, started_at TEXT NOT NULL, heartbeat_at TEXT NOT NULL, status TEXT NOT NULL, capacity BIGINT NOT NULL DEFAULT 1)`
        );
        await client.query(`DROP TABLE IF EXISTS legacy_policy_import_tombstones`);
        await client.query(`DROP TABLE IF EXISTS integration_sync_runs`);
        await client.query(`DROP TABLE IF EXISTS integration_configs`);
        await client.query(`INSERT INTO schema_migrations (version, name, applied_at) VALUES (3, 'beta_runtime_health_and_cleanup', $1)`, [nowIso()]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }

    if (!applied.has(4)) {
      await client.query("BEGIN");
      try {
        await client.query(`ALTER TABLE media_links DROP CONSTRAINT IF EXISTS media_links_policy_check`);
        await client.query(`ALTER TABLE storage_files DROP CONSTRAINT IF EXISTS storage_files_policy_check`);
        await client.query(`ALTER TABLE storage_policies DROP CONSTRAINT IF EXISTS storage_policies_policy_check`);
        await client.query(`UPDATE media_links SET storage_policy = CASE storage_policy WHEN 'assign_local' THEN 'location_1' WHEN 'assign_remote' THEN 'location_2' ELSE storage_policy END`);
        await client.query(`UPDATE storage_files SET storage_policy = CASE storage_policy WHEN 'assign_local' THEN 'location_1' WHEN 'assign_remote' THEN 'location_2' ELSE storage_policy END`);
        await client.query(`UPDATE storage_policies SET policy = CASE policy WHEN 'assign_local' THEN 'location_1' WHEN 'assign_remote' THEN 'location_2' ELSE policy END`);
        await client.query(`
          UPDATE copy_operations
          SET original_link_state = (
            jsonb_set(
              original_link_state::jsonb - 'isAssignedRemote',
              '{storagePolicy}',
              to_jsonb(
                CASE original_link_state::jsonb ->> 'storagePolicy'
                  WHEN 'assign_local' THEN 'location_1'
                  WHEN 'assign_remote' THEN 'location_2'
                  ELSE coalesce(original_link_state::jsonb ->> 'storagePolicy', 'unassigned')
                END
              )
            )
          )::text
        `);
        await client.query(`ALTER TABLE media_links DROP COLUMN IF EXISTS is_assigned_remote`);
        await client.query(`ALTER TABLE media_links ADD CONSTRAINT media_links_policy_check CHECK (storage_policy IN ('unassigned', 'location_1', 'location_2'))`);
        await client.query(`ALTER TABLE storage_files ADD CONSTRAINT storage_files_policy_check CHECK (storage_policy IN ('unassigned', 'location_1', 'location_2'))`);
        await client.query(`ALTER TABLE storage_policies ADD CONSTRAINT storage_policies_policy_check CHECK (policy IN ('location_1', 'location_2'))`);
        await client.query(`INSERT INTO schema_migrations (version, name, applied_at) VALUES (4, 'location_identity_storage_policies', $1)`, [nowIso()]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }

    if (!applied.has(5)) {
      await client.query("BEGIN");
      try {
        await client.query(`ALTER TABLE jobs ADD COLUMN IF NOT EXISTS lease_version INTEGER NOT NULL DEFAULT 0`);
        await client.query(`ALTER TABLE jobs ADD COLUMN IF NOT EXISTS exclusive BOOLEAN NOT NULL DEFAULT TRUE`);
        await client.query(`
          CREATE TABLE IF NOT EXISTS job_resource_claims (
            id SERIAL PRIMARY KEY,
            job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
            resource_type TEXT NOT NULL,
            resource_key TEXT NOT NULL,
            access TEXT NOT NULL DEFAULT 'exclusive',
            created_at TEXT NOT NULL,
            CONSTRAINT job_resource_claims_job_resource_idx UNIQUE (job_id, resource_type, resource_key),
            CONSTRAINT job_resource_claims_access_check CHECK (access IN ('shared', 'exclusive'))
          )
        `);
        await client.query(`CREATE INDEX IF NOT EXISTS job_resource_claims_lookup_idx ON job_resource_claims(resource_type, resource_key, access)`);
        await client.query(`ALTER TABLE worker_heartbeats ADD COLUMN IF NOT EXISTS capacity BIGINT NOT NULL DEFAULT 1`);
        await client.query(`CREATE INDEX IF NOT EXISTS worker_heartbeats_status_heartbeat_idx ON worker_heartbeats(status, heartbeat_at)`);
        await client.query(`INSERT INTO schema_migrations (version, name, applied_at) VALUES (5, 'multi_worker_job_claims', $1)`, [nowIso()]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }

    if (!applied.has(6)) {
      await client.query("BEGIN");
      try {
        await client.query(`ALTER TABLE copy_operations ADD COLUMN IF NOT EXISTS temp_identity TEXT`);
        await client.query(`ALTER TABLE copy_operations ADD COLUMN IF NOT EXISTS destination_identity TEXT`);
        await client.query(`ALTER TABLE copy_operations ADD COLUMN IF NOT EXISTS displaced_identity TEXT`);
        await client.query(`INSERT INTO schema_migrations (version, name, applied_at) VALUES (6, 'copy_operation_file_identities', $1)`, [nowIso()]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }

    if (!applied.has(7)) {
      await client.query("BEGIN");
      try {
        await client.query(`ALTER TABLE path_migration_items ADD COLUMN IF NOT EXISTS target_identity TEXT`);
        await client.query(`INSERT INTO schema_migrations (version, name, applied_at) VALUES (7, 'path_migration_target_identities', $1)`, [nowIso()]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
  } finally {
    await client.query("select pg_advisory_unlock($1)", [bootstrapLockKey]).catch(() => undefined);
    client.release();
  }
}

export async function openDatabase(options: DatabaseOpenOptions | string): Promise<DatabaseContext> {
  const databaseUrl = typeof options === "string" ? options : options.databaseUrl;
  const suppliedPool = typeof options === "string" ? undefined : options.pool;
  const pool = suppliedPool ?? createPool(databaseUrl);
  try {
    const shouldMigrate = typeof options === "string" ? true : options.migrate !== false;
    if (shouldMigrate) {
      await initializeDatabase(pool);
    } else {
      const migration = await pool.query<{ version: number | null }>("select max(version) as version from schema_migrations").catch((error: unknown) => {
        throw new Error("Database schema is not initialized. Run the migration service before starting SRTL Manager.", { cause: error });
      });
      if (Number(migration.rows[0]?.version ?? 0) < currentSchemaVersion) {
        throw new Error(`Database schema is out of date. Expected migration ${currentSchemaVersion}; run the migration service.`);
      }
    }
  } catch (error) {
    if (!suppliedPool) await pool.end().catch(() => undefined);
    throw error;
  }
  const db = drizzle(pool, { schema });
  return {
    pool,
    db,
    close: () => pool.end()
  };
}

export function nowIso(): string {
  return new Date().toISOString();
}

function resultRows<T extends QueryResultRow>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === "object" && "rows" in result && Array.isArray((result as QueryResult<QueryResultRow>).rows)) {
    return (result as QueryResult<T>).rows;
  }
  return [];
}

export async function dbAll<T extends QueryResultRow>(db: Db, query: SQL<unknown>): Promise<T[]> {
  return resultRows<T>(await db.execute(query));
}

export async function dbGet<T extends QueryResultRow>(db: Db, query: SQL<unknown>): Promise<T | undefined> {
  return (await dbAll<T>(db, query))[0];
}

export async function first<T>(rows: Promise<T[]>): Promise<T | undefined> {
  return (await rows)[0];
}

export async function getSetting(db: Db, key: string): Promise<string | null> {
  const row = await first(db.select().from(schema.appSettings).where(eq(schema.appSettings.key, key)).limit(1));
  return row?.value ?? null;
}

export async function setSetting(db: Db, key: string, value: unknown): Promise<void> {
  await db
    .insert(schema.appSettings)
    .values({ key, value: JSON.stringify(value), updatedAt: nowIso() })
    .onConflictDoUpdate({
      target: schema.appSettings.key,
      set: { value: JSON.stringify(value), updatedAt: nowIso() }
    });
}

export async function getJsonSetting<T>(db: Db, key: string, fallback: T): Promise<T> {
  const raw = await getSetting(db, key);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function normalizeSectionName(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (value && typeof value === "object" && "name" in value) {
    const name = (value as { name?: unknown }).name;
    if (typeof name === "string") return name.trim() || null;
  }
  return null;
}

function normalizeSectionTitle(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return value.trim() || null;
}

export function normalizeSectionSettings(value: unknown): SectionSettings {
  const input = value && typeof value === "object" ? (value as { sections?: unknown; sectionTitles?: unknown; sectionTypes?: unknown }) : {};
  const rawSections = Array.isArray(input.sections) ? input.sections : [];
  const rawTitleMap = input.sectionTitles && typeof input.sectionTitles === "object" ? (input.sectionTitles as Record<string, unknown>) : {};
  const rawTypeMap = input.sectionTypes && typeof input.sectionTypes === "object" ? (input.sectionTypes as Record<string, unknown>) : {};
  const sections: string[] = [];
  const sectionTitles: Record<string, string> = {};
  const sectionTypes: Record<string, SectionContentType> = {};
  const seen = new Set<string>();

  for (const rawSection of rawSections) {
    const name = normalizeSectionName(rawSection);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    sections.push(name);

    const inlineTitle = rawSection && typeof rawSection === "object" ? normalizeSectionTitle((rawSection as { title?: unknown; displayName?: unknown }).title ?? (rawSection as { displayName?: unknown }).displayName) : null;
    const mappedTitle = normalizeSectionTitle(rawTitleMap[name]);
    const title = mappedTitle ?? inlineTitle;
    if (title) sectionTitles[name] = title;

    const inlineType =
      rawSection && typeof rawSection === "object"
        ? normalizeSectionContentType((rawSection as { type?: unknown; contentType?: unknown }).type ?? (rawSection as { contentType?: unknown }).contentType)
        : null;
    sectionTypes[name] = normalizeSectionContentType(rawTypeMap[name]) ?? inlineType ?? inferSectionContentType(name);
  }

  return { sections, sectionTitles, sectionTypes };
}

export async function getSectionSettings(db: Db): Promise<SectionSettings> {
  return normalizeSectionSettings(await getJsonSetting<unknown>(db, "sections", { sections: [] }));
}
