import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../src/server/db/database";
import { createTestDatabase } from "./testDb";

describe("database bootstrap", () => {
  it("fails closed when production startup skips an uninitialized schema", async () => {
    const testDatabase = await createTestDatabase();
    try {
      await expect(openDatabase({ databaseUrl: testDatabase.databaseUrl, migrate: false })).rejects.toThrow("Database schema is not initialized");
    } finally {
      await testDatabase.cleanup();
    }
  });

  it("creates the current schema and applies versioned migrations idempotently", async () => {
    const testDatabase = await createTestDatabase();
    const database = await openDatabase(testDatabase.databaseUrl);
    const secondDatabase = await openDatabase(testDatabase.databaseUrl);
    try {
      const columns = await database.pool.query<{ column_name: string }>(`
        select column_name
        from information_schema.columns
        where table_name = 'jobs'
      `);
      expect(columns.rows.map((column) => column.column_name)).toEqual(
        expect.arrayContaining(["locked_by", "locked_at", "heartbeat_at", "lease_version", "exclusive", "cancel_requested_at"])
      );

      const indexes = await database.pool.query<{ indexname: string }>(`
        select indexname
        from pg_indexes
        where tablename = 'jobs'
      `);
      expect(indexes.rows.map((index) => index.indexname)).toEqual(expect.arrayContaining(["jobs_status_idx", "jobs_heartbeat_idx"]));

      const migrations = await database.pool.query<{ version: number }>("select version from schema_migrations order by version");
      expect(migrations.rows).toEqual([{ version: 1 }, { version: 2 }, { version: 3 }, { version: 4 }, { version: 5 }, { version: 6 }, { version: 7 }, { version: 8 }]);

      const workerColumns = await database.pool.query<{ column_name: string }>(`
        select column_name
        from information_schema.columns
        where table_name = 'worker_heartbeats'
      `);
      expect(workerColumns.rows.map((column) => column.column_name)).toEqual(
        expect.arrayContaining(["worker_id", "started_at", "heartbeat_at", "status", "capacity"])
      );
      const workerIndexes = await database.pool.query<{ indexname: string }>(`
        SELECT indexname FROM pg_indexes WHERE tablename = 'worker_heartbeats'
      `);
      expect(workerIndexes.rows.map((index) => index.indexname)).toContain("worker_heartbeats_status_heartbeat_idx");
      const copyOperationColumns = await database.pool.query<{ column_name: string; is_nullable: string }>(`
        SELECT column_name, is_nullable FROM information_schema.columns WHERE table_name = 'copy_operations'
      `);
      for (const columnName of ["temp_identity", "destination_identity", "displaced_identity"]) {
        expect(copyOperationColumns.rows).toContainEqual({ column_name: columnName, is_nullable: "YES" });
      }
      const pathMigrationColumns = await database.pool.query<{ column_name: string; is_nullable: string }>(`
        SELECT column_name, is_nullable FROM information_schema.columns WHERE table_name = 'path_migration_items'
      `);
      expect(pathMigrationColumns.rows).toContainEqual({ column_name: "target_identity", is_nullable: "YES" });
      const insertedHeartbeat = await database.pool.query<{ capacity: string }>(`
        INSERT INTO worker_heartbeats (worker_id, started_at, heartbeat_at, status)
        VALUES ('default-capacity-worker', '2026-07-29T00:00:00.000Z', '2026-07-29T00:00:00.000Z', 'running')
        RETURNING capacity
      `);
      expect(insertedHeartbeat.rows).toEqual([{ capacity: "1" }]);

      const insertedJob = await database.pool.query<{ id: number; lease_version: number; exclusive: boolean }>(`
        INSERT INTO jobs (type, status, created_at, progress)
        VALUES ('copy', 'queued', '2026-07-29T00:00:00.000Z', '{}')
        RETURNING id, lease_version, exclusive
      `);
      expect(insertedJob.rows[0]).toMatchObject({ lease_version: 0, exclusive: true });

      const jobId = insertedJob.rows[0]!.id;
      const insertedClaim = await database.pool.query<{ access: string }>(`
        INSERT INTO job_resource_claims (job_id, resource_type, resource_key, created_at)
        VALUES ($1, 'path', '/media/title', '2026-07-29T00:00:00.000Z')
        RETURNING access
      `, [jobId]);
      expect(insertedClaim.rows).toEqual([{ access: "exclusive" }]);
      await expect(
        database.pool.query(
          `INSERT INTO job_resource_claims (job_id, resource_type, resource_key, access, created_at) VALUES ($1, 'path', '/media/other', 'invalid', '2026-07-29T00:00:00.000Z')`,
          [jobId]
        )
      ).rejects.toThrow();

      const claimIndexes = await database.pool.query<{ indexname: string }>(`
        SELECT indexname FROM pg_indexes WHERE tablename = 'job_resource_claims'
      `);
      expect(claimIndexes.rows.map((index) => index.indexname)).toEqual(
        expect.arrayContaining(["job_resource_claims_job_resource_idx", "job_resource_claims_lookup_idx"])
      );

      await database.pool.query(`DELETE FROM jobs WHERE id = $1`, [jobId]);
      expect((await database.pool.query<{ count: string }>(`SELECT count(*) FROM job_resource_claims WHERE job_id = $1`, [jobId])).rows).toEqual([
        { count: "0" }
      ]);
    } finally {
      await secondDatabase.close();
      await database.close();
      await testDatabase.cleanup();
    }
  });

  it("migrates legacy assignment policies and copy snapshots to location identities", async () => {
    const testDatabase = await createTestDatabase();
    const legacyPool = new Pool({ connectionString: testDatabase.databaseUrl });
    try {
      await legacyPool.query(`CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)`);
      await legacyPool.query(`INSERT INTO schema_migrations (version, name, applied_at) VALUES (1, 'initial', now()::text), (2, 'hardening', now()::text), (3, 'cleanup', now()::text)`);
      await legacyPool.query(`CREATE TABLE media_links (id SERIAL PRIMARY KEY, storage_policy TEXT NOT NULL, is_assigned_remote BOOLEAN NOT NULL)`);
      await legacyPool.query(`ALTER TABLE media_links ADD CONSTRAINT media_links_policy_check CHECK (storage_policy IN ('unassigned', 'assign_local', 'assign_remote'))`);
      await legacyPool.query(`CREATE TABLE storage_files (id SERIAL PRIMARY KEY, storage_policy TEXT NOT NULL)`);
      await legacyPool.query(`ALTER TABLE storage_files ADD CONSTRAINT storage_files_policy_check CHECK (storage_policy IN ('unassigned', 'assign_local', 'assign_remote'))`);
      await legacyPool.query(`CREATE TABLE storage_policies (id SERIAL PRIMARY KEY, policy TEXT NOT NULL)`);
      await legacyPool.query(`ALTER TABLE storage_policies ADD CONSTRAINT storage_policies_policy_check CHECK (policy IN ('assign_local', 'assign_remote'))`);
      await legacyPool.query(`CREATE TABLE copy_operations (id SERIAL PRIMARY KEY, original_link_state TEXT NOT NULL)`);
      await legacyPool.query(`CREATE TABLE jobs (id SERIAL PRIMARY KEY)`);
      await legacyPool.query(`CREATE TABLE worker_heartbeats (worker_id TEXT PRIMARY KEY, started_at TEXT NOT NULL, heartbeat_at TEXT NOT NULL, status TEXT NOT NULL)`);
      await legacyPool.query(`CREATE TABLE path_migration_items (id SERIAL PRIMARY KEY)`);
      await legacyPool.query(`INSERT INTO media_links (storage_policy, is_assigned_remote) VALUES ('assign_local', false), ('assign_remote', true), ('unassigned', false)`);
      await legacyPool.query(`INSERT INTO storage_files (storage_policy) VALUES ('assign_local'), ('assign_remote'), ('unassigned')`);
      await legacyPool.query(`INSERT INTO storage_policies (policy) VALUES ('assign_local'), ('assign_remote')`);
      await legacyPool.query(`INSERT INTO copy_operations (original_link_state) VALUES ($1)`, [
        JSON.stringify({ id: 7, storagePolicy: "assign_remote", isAssignedRemote: true })
      ]);
    } finally {
      await legacyPool.end();
    }

    const database = await openDatabase(testDatabase.databaseUrl);
    try {
      expect((await database.pool.query<{ storage_policy: string }>(`SELECT storage_policy FROM media_links ORDER BY id`)).rows).toEqual([
        { storage_policy: "location_1" },
        { storage_policy: "location_2" },
        { storage_policy: "unassigned" }
      ]);
      expect((await database.pool.query<{ storage_policy: string }>(`SELECT storage_policy FROM storage_files ORDER BY id`)).rows).toEqual([
        { storage_policy: "location_1" },
        { storage_policy: "location_2" },
        { storage_policy: "unassigned" }
      ]);
      expect((await database.pool.query<{ policy: string }>(`SELECT policy FROM storage_policies ORDER BY id`)).rows).toEqual([
        { policy: "location_1" },
        { policy: "location_2" }
      ]);

      const snapshot = JSON.parse((await database.pool.query<{ original_link_state: string }>(`SELECT original_link_state FROM copy_operations`)).rows[0]!.original_link_state) as Record<string, unknown>;
      expect(snapshot).toMatchObject({ id: 7, storagePolicy: "location_2" });
      expect(snapshot).not.toHaveProperty("isAssignedRemote");

      const columns = await database.pool.query<{ column_name: string }>(`
        SELECT column_name FROM information_schema.columns WHERE table_name = 'media_links'
      `);
      expect(columns.rows.map((column) => column.column_name)).not.toContain("is_assigned_remote");
      expect((await database.pool.query<{ version: number }>(`SELECT version FROM schema_migrations ORDER BY version`)).rows).toEqual([
        { version: 1 },
        { version: 2 },
        { version: 3 },
        { version: 4 },
        { version: 5 },
        { version: 6 },
        { version: 7 },
        { version: 8 }
      ]);
    } finally {
      await database.close();
      await testDatabase.cleanup();
    }
  });

  it("clears storage policies that are not backed by one current symlink policy", async () => {
    const testDatabase = await createTestDatabase();
    const legacyPool = new Pool({ connectionString: testDatabase.databaseUrl });
    try {
      await legacyPool.query(`CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)`);
      await legacyPool.query(`
        INSERT INTO schema_migrations (version, name, applied_at)
        VALUES
          (1, 'initial_postgres_schema', now()::text),
          (2, 'beta_security_and_recovery', now()::text),
          (3, 'beta_runtime_health_and_cleanup', now()::text),
          (4, 'location_identity_storage_policies', now()::text),
          (5, 'multi_worker_job_claims', now()::text),
          (6, 'copy_operation_file_identities', now()::text),
          (7, 'path_migration_target_identities', now()::text)
      `);
      await legacyPool.query(`CREATE TABLE storage_files (id SERIAL PRIMARY KEY, storage_policy TEXT NOT NULL, updated_at TEXT NOT NULL)`);
      await legacyPool.query(`
        CREATE TABLE media_links (
          id SERIAL PRIMARY KEY,
          resolved_storage_file_id INTEGER,
          storage_policy TEXT NOT NULL,
          missing_since TEXT
        )
      `);
      await legacyPool.query(`
        INSERT INTO storage_files (storage_policy, updated_at)
        VALUES ('location_1', now()::text), ('location_1', now()::text), ('location_1', now()::text), ('location_2', now()::text)
      `);
      await legacyPool.query(`
        INSERT INTO media_links (resolved_storage_file_id, storage_policy, missing_since)
        VALUES
          (1, 'location_1', NULL),
          (3, 'location_1', NULL),
          (3, 'location_2', NULL),
          (4, 'location_2', now()::text)
      `);
    } finally {
      await legacyPool.end();
    }

    const database = await openDatabase(testDatabase.databaseUrl);
    try {
      expect((await database.pool.query<{ id: number; storage_policy: string }>(`SELECT id, storage_policy FROM storage_files ORDER BY id`)).rows).toEqual([
        { id: 1, storage_policy: "location_1" },
        { id: 2, storage_policy: "unassigned" },
        { id: 3, storage_policy: "unassigned" },
        { id: 4, storage_policy: "unassigned" }
      ]);
      expect((await database.pool.query<{ version: number; name: string }>(`SELECT version, name FROM schema_migrations WHERE version = 8`)).rows).toEqual([
        { version: 8, name: "linked_storage_file_policies" }
      ]);
    } finally {
      await database.close();
      await testDatabase.cleanup();
    }
  });

  it("upgrades active version-four jobs as conservative exclusive leases", async () => {
    const testDatabase = await createTestDatabase();
    const legacyPool = new Pool({ connectionString: testDatabase.databaseUrl });
    try {
      await legacyPool.query(`CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)`);
      await legacyPool.query(`
        INSERT INTO schema_migrations (version, name, applied_at)
        VALUES
          (1, 'initial', now()::text),
          (2, 'hardening', now()::text),
          (3, 'cleanup', now()::text),
          (4, 'location_identity', now()::text)
      `);
      await legacyPool.query(`
        CREATE TABLE jobs (
          id SERIAL PRIMARY KEY,
          type TEXT NOT NULL,
          status TEXT NOT NULL,
          created_at TEXT NOT NULL,
          started_at TEXT,
          finished_at TEXT,
          locked_by TEXT,
          locked_at TEXT,
          heartbeat_at TEXT,
          cancel_requested_at TEXT,
          progress TEXT NOT NULL
        )
      `);
      await legacyPool.query(`CREATE TABLE worker_heartbeats (worker_id TEXT PRIMARY KEY, started_at TEXT NOT NULL, heartbeat_at TEXT NOT NULL, status TEXT NOT NULL)`);
      await legacyPool.query(`CREATE TABLE copy_operations (id SERIAL PRIMARY KEY)`);
      await legacyPool.query(`CREATE TABLE path_migration_items (id SERIAL PRIMARY KEY)`);
      await legacyPool.query(`
        INSERT INTO worker_heartbeats (worker_id, started_at, heartbeat_at, status)
        VALUES ('legacy-worker-process', now()::text, now()::text, 'running')
      `);
      await legacyPool.query(`
        INSERT INTO jobs (type, status, created_at, started_at, locked_by, locked_at, heartbeat_at, progress)
        VALUES
          ('copy', 'queued', now()::text, NULL, NULL, NULL, NULL, '{}'),
          ('scan', 'running', now()::text, now()::text, 'legacy-worker', now()::text, now()::text, '{}')
      `);
    } finally {
      await legacyPool.end();
    }

    const database = await openDatabase(testDatabase.databaseUrl);
    try {
      const rows = await database.pool.query<{ status: string; lease_version: number; exclusive: boolean }>(`
        SELECT status, lease_version, exclusive FROM jobs ORDER BY id
      `);
      expect(rows.rows).toEqual([
        { status: "queued", lease_version: 0, exclusive: true },
        { status: "running", lease_version: 0, exclusive: true }
      ]);
      expect(
        (await database.pool.query<{ worker_id: string; capacity: string }>(`SELECT worker_id, capacity FROM worker_heartbeats`)).rows
      ).toEqual([{ worker_id: "legacy-worker-process", capacity: "1" }]);
      const identityColumns = await database.pool.query<{ column_name: string; is_nullable: string }>(`
        SELECT column_name, is_nullable
        FROM information_schema.columns
        WHERE table_name = 'copy_operations' AND column_name IN ('temp_identity', 'destination_identity', 'displaced_identity')
        ORDER BY column_name
      `);
      expect(identityColumns.rows).toEqual([
        { column_name: "destination_identity", is_nullable: "YES" },
        { column_name: "displaced_identity", is_nullable: "YES" },
        { column_name: "temp_identity", is_nullable: "YES" }
      ]);
    } finally {
      await database.close();
      await testDatabase.cleanup();
    }
  });

  it("repairs version-five schemas missing copy and path-migration file identities", async () => {
    const testDatabase = await createTestDatabase();
    const legacyPool = new Pool({ connectionString: testDatabase.databaseUrl });
    try {
      await legacyPool.query(`CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)`);
      await legacyPool.query(`
        INSERT INTO schema_migrations (version, name, applied_at)
        VALUES
          (1, 'initial_postgres_schema', now()::text),
          (2, 'beta_security_and_recovery', now()::text),
          (3, 'beta_runtime_health_and_cleanup', now()::text),
          (4, 'location_identity_storage_policies', now()::text),
          (5, 'multi_worker_job_claims', now()::text)
      `);
      await legacyPool.query(`CREATE TABLE copy_operations (id SERIAL PRIMARY KEY)`);
      await legacyPool.query(`CREATE TABLE path_migration_items (id SERIAL PRIMARY KEY)`);
      await legacyPool.query(`INSERT INTO path_migration_items DEFAULT VALUES`);
    } finally {
      await legacyPool.end();
    }

    const database = await openDatabase(testDatabase.databaseUrl);
    try {
      const identityColumns = await database.pool.query<{ column_name: string; is_nullable: string }>(`
        SELECT column_name, is_nullable
        FROM information_schema.columns
        WHERE table_name = 'copy_operations' AND column_name IN ('temp_identity', 'destination_identity', 'displaced_identity')
        ORDER BY column_name
      `);
      expect(identityColumns.rows).toEqual([
        { column_name: "destination_identity", is_nullable: "YES" },
        { column_name: "displaced_identity", is_nullable: "YES" },
        { column_name: "temp_identity", is_nullable: "YES" }
      ]);
      expect((await database.pool.query<{ target_identity: string | null }>(`SELECT target_identity FROM path_migration_items`)).rows).toEqual([
        { target_identity: null }
      ]);
      expect(
        (await database.pool.query<{ version: number; name: string }>(`SELECT version, name FROM schema_migrations WHERE version >= 5 ORDER BY version`)).rows
      ).toEqual([
        { version: 5, name: "multi_worker_job_claims" },
        { version: 6, name: "copy_operation_file_identities" },
        { version: 7, name: "path_migration_target_identities" },
        { version: 8, name: "linked_storage_file_policies" }
      ]);
    } finally {
      await database.close();
      await testDatabase.cleanup();
    }
  });
});
