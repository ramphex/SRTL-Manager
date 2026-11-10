import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { nowIso, openDatabase, setSetting, type DatabaseContext } from "../src/server/db/database";
import { JobRunner, JobWorker } from "../src/server/jobs/jobRunner";
import { listBackups, pgConnectionEnvironment, type BackupRuntime } from "../src/server/lib/backups";
import { activeSecretBox, secretPurposes } from "../src/server/lib/secretBox";
import { backupFolderName } from "../src/shared/backups";
import { backupTestRoot, makeBackupTestDir, realPostgresClient } from "./backupHelpers";
import { createTestDatabase, type TestDatabaseHandle } from "./testDb";

const quietLogger = { info: () => undefined, warn: () => undefined, error: () => undefined };

/** The tables and row counts that must come back identical. */
async function snapshot(pool: Pool): Promise<Record<string, number>> {
  const tables = await pool.query<{ tablename: string }>(`SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`);
  const counts: Record<string, number> = {};
  for (const { tablename } of tables.rows) {
    const result = await pool.query<{ count: string }>(`SELECT count(*)::text AS count FROM "${tablename}"`);
    counts[tablename] = Number(result.rows[0]!.count);
  }
  return counts;
}

/** The same pg_restore command docs/backups.md gives: the dump arrives on standard input. */
async function restore(dumpPath: string, binDir: string | null, databaseUrl: string): Promise<void> {
  const env = pgConnectionEnvironment(databaseUrl);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(binDir ? path.join(binDir, "pg_restore") : "pg_restore", ["--no-owner", "--exit-on-error", "--dbname", String(env.PGDATABASE)], { env, stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    createReadStream(dumpPath).pipe(child.stdin);
    child.once("error", reject);
    child.once("close", (code) => (code === 0 ? resolve() : reject(new Error(`pg_restore exited with ${code}: ${stderr}`))));
  });
}

describe("a real backup, restored", () => {
  let source: TestDatabaseHandle;
  let target: TestDatabaseHandle;
  let database: DatabaseContext;
  let binDir: string | null;
  let root: string;

  beforeAll(async () => {
    source = await createTestDatabase();
    target = await createTestDatabase();
    database = await openDatabase(source.databaseUrl);
    binDir = await realPostgresClient();
    root = await makeBackupTestDir();
  }, 120_000);

  afterAll(async () => {
    await database?.close();
    await source?.cleanup();
    await target?.cleanup();
    await fs.rm(root, { recursive: true, force: true });
    if (binDir?.startsWith(backupTestRoot)) await fs.rm(binDir, { recursive: true, force: true });
  });

  it("dumps through the job system, verifies, and restores into a throwaway database with the data intact", async () => {
    const sealed = activeSecretBox().seal("saved-plex-token", secretPurposes.sonarrApiKey);
    await setSetting(database.db, "backupRoundTripCheck", { value: "survives", sealed });
    await database.pool.query(`INSERT INTO admin_users (username, password_hash, created_at, role) VALUES ('restored-admin', 'hash', $1, 'owner')`, [nowIso()]);

    const runtime: BackupRuntime = { databaseUrl: source.databaseUrl, defaultLocation: root, pgBinDir: binDir, paths: { symlinkDir: "", localDir: "", remoteDir: "" } };
    const jobId = await new JobRunner(database.db).startBackup("manual");
    await new JobWorker(database.db, { workerId: "round-trip", logger: quietLogger, backup: runtime }).runOnce();
    const job = await new JobRunner(database.db).getJob(jobId);
    const events = await new JobRunner(database.db).listEvents(jobId);
    expect(job?.status, JSON.stringify(events)).toBe("completed");

    const directory = path.join(root, backupFolderName);
    expect((await fs.stat(directory)).mode & 0o777).toBe(0o700);
    const sets = await listBackups(directory);
    expect(sets).toHaveLength(1);
    expect(sets[0]).toMatchObject({ owned: true, entry: { verified: true, migration: 32 } });
    expect(sets[0]!.entry.sizeBytes).toBeGreaterThan(1_000);
    const dumpPath = path.join(directory, `${sets[0]!.entry.name}.dump`);
    expect((await fs.stat(dumpPath)).mode & 0o777).toBe(0o600);

    const expected = await snapshot(database.pool);
    await restore(dumpPath, binDir, target.databaseUrl);

    // The restored database opens as a current schema without migrating, as the app does in production.
    const restored = await openDatabase({ databaseUrl: target.databaseUrl, migrate: false });
    try {
      const counts = await snapshot(restored.pool);
      // The backup's own job finished after the dump was taken, so only its rows may differ.
      for (const moving of ["jobs", "job_events", "job_resource_claims", "app_settings"]) {
        delete expected[moving];
        delete counts[moving];
      }
      expect(counts).toEqual(expected);
      expect(Object.keys(counts).length).toBeGreaterThan(20);
      const setting = await restored.pool.query<{ value: string }>(`SELECT value FROM app_settings WHERE key = 'backupRoundTripCheck'`);
      const check = JSON.parse(setting.rows[0]!.value) as { value: string; sealed: string };
      expect(check.value).toBe("survives");
      // Saved credentials read back with the same secret key.
      expect(activeSecretBox().open(check.sealed, secretPurposes.sonarrApiKey)).toBe("saved-plex-token");
      const admins = await restored.pool.query<{ username: string }>(`SELECT username FROM admin_users WHERE username = 'restored-admin'`);
      expect(admins.rows).toEqual([{ username: "restored-admin" }]);
    } finally {
      await restored.close();
    }
  }, 180_000);
});
