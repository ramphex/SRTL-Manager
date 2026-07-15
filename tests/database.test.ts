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
      expect(columns.rows.map((column) => column.column_name)).toEqual(expect.arrayContaining(["locked_by", "locked_at", "heartbeat_at", "cancel_requested_at"]));

      const indexes = await database.pool.query<{ indexname: string }>(`
        select indexname
        from pg_indexes
        where tablename = 'jobs'
      `);
      expect(indexes.rows.map((index) => index.indexname)).toEqual(expect.arrayContaining(["jobs_status_idx", "jobs_heartbeat_idx"]));

      const migrations = await database.pool.query<{ version: number }>("select version from schema_migrations order by version");
      expect(migrations.rows).toEqual([{ version: 1 }, { version: 2 }, { version: 3 }, { version: 4 }]);

      const workerColumns = await database.pool.query<{ column_name: string }>(`
        select column_name
        from information_schema.columns
        where table_name = 'worker_heartbeats'
      `);
      expect(workerColumns.rows.map((column) => column.column_name)).toEqual(
        expect.arrayContaining(["worker_id", "started_at", "heartbeat_at", "status"])
      );
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
        { version: 4 }
      ]);
    } finally {
      await database.close();
      await testDatabase.cleanup();
    }
  });
});
