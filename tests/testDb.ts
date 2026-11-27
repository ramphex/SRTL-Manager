import { execFile, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { Pool, type PoolClient } from "pg";
import { openDatabase, type DatabaseContext } from "../src/server/db/database";
import { secretKeyCheckSetting } from "../src/server/db/secretMigration";

const execFileAsync = promisify(execFile);
const dockerImage = process.env.SRTL_TEST_POSTGRES_IMAGE ?? "postgres:17-alpine";
const testDatabaseUser = "srtl_test";
const testDatabasePassword = "srtl_test";

interface TestPostgresServer {
  adminDatabaseUrl: string;
  containerId: string | null;
}

export interface TestDatabaseHandle {
  databaseUrl: string;
  cleanup(): Promise<void>;
}

export interface TestDatabaseOptions {
  /** A database with no tables at all, for tests of the migrations themselves. Others get a copy of a migrated one. */
  empty?: boolean;
}

let serverPromise: Promise<TestPostgresServer> | null = null;
let templatePromise: Promise<string> | null = null;
let databaseCounter = 0;

function quoteIdentifier(identifier: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(identifier)) {
    throw new Error(`Unsafe Postgres identifier: ${identifier}`);
  }
  return `"${identifier.replaceAll('"', '""')}"`;
}

function databaseUrlFor(adminDatabaseUrl: string, databaseName: string): string {
  const url = new URL(adminDatabaseUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

function nextDatabaseName(): string {
  databaseCounter += 1;
  return `srtl_test_${process.pid}_${Date.now()}_${databaseCounter}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stopContainer(containerId: string): void {
  spawnSync("docker", ["stop", containerId], { stdio: "ignore" });
}

function registerContainerCleanup(containerId: string): void {
  process.once("exit", () => stopContainer(containerId));
  process.once("SIGINT", () => {
    stopContainer(containerId);
    process.exit(130);
  });
  process.once("SIGTERM", () => {
    stopContainer(containerId);
    process.exit(143);
  });
}

async function waitForPostgres(databaseUrl: string): Promise<void> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const pool = new Pool({ connectionString: databaseUrl });
    try {
      await pool.query("select 1");
      await pool.end();
      return;
    } catch {
      await pool.end().catch(() => undefined);
      await delay(250);
    }
  }
  throw new Error("Timed out waiting for test Postgres to accept connections");
}

async function startDockerPostgres(): Promise<TestPostgresServer> {
  const { stdout: runStdout } = await execFileAsync("docker", [
    "run",
    "--rm",
    "-d",
    "-e",
    `POSTGRES_USER=${testDatabaseUser}`,
    "-e",
    `POSTGRES_PASSWORD=${testDatabasePassword}`,
    "-e",
    "POSTGRES_DB=postgres",
    "-p",
    "127.0.0.1::5432",
    dockerImage
  ]);
  const containerId = runStdout.trim();
  registerContainerCleanup(containerId);

  try {
    const { stdout: portStdout } = await execFileAsync("docker", ["port", containerId, "5432/tcp"]);
    const port = portStdout.trim().split(":").pop();
    if (!port) throw new Error(`Unable to determine mapped Postgres port for ${containerId}`);
    const adminDatabaseUrl = `postgres://${testDatabaseUser}:${testDatabasePassword}@127.0.0.1:${port}/postgres`;
    await waitForPostgres(adminDatabaseUrl);
    return { adminDatabaseUrl, containerId };
  } catch (error) {
    stopContainer(containerId);
    throw error;
  }
}

async function getPostgresServer(): Promise<TestPostgresServer> {
  if (process.env.SRTL_TEST_DATABASE_URL) {
    return { adminDatabaseUrl: process.env.SRTL_TEST_DATABASE_URL, containerId: null };
  }
  serverPromise ??= startDockerPostgres();
  return serverPromise;
}

async function createDatabase(adminDatabaseUrl: string, databaseName: string, template?: string): Promise<void> {
  const pool = new Pool({ connectionString: adminDatabaseUrl });
  try {
    await pool.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}${template ? ` TEMPLATE ${quoteIdentifier(template)}` : ""}`);
  } finally {
    await pool.end();
  }
}

// Give connections that are already closing time to finish before forcing anything. Terminating a
// backend that has not yet read its client's goodbye sends that client a FATAL error, which surfaces
// as an uncaught exception in whichever test file happens to be running.
async function waitForBackendsToLeave(pool: Pool | PoolClient, databaseName: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const result = await pool.query<{ count: string }>("SELECT count(*) FROM pg_stat_activity WHERE datname = $1", [databaseName]);
    if (Number(result.rows[0]?.count ?? 0) === 0) return;
    await delay(100);
  }
}

async function dropDatabase(adminDatabaseUrl: string, databaseName: string): Promise<void> {
  const pool = new Pool({ connectionString: adminDatabaseUrl });
  try {
    await waitForBackendsToLeave(pool, databaseName);
    await pool.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1", [databaseName]);
    await pool.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)}`);
  } finally {
    await pool.end();
  }
}

/**
 * Names the migrated template after the server code, so a long-lived test server never hands out a
 * copy made by older migrations. Hashing all of src/server and src/shared costs a few milliseconds.
 */
function templateName(): string {
  const hash = crypto.createHash("sha256");
  const visit = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(entryPath);
      else if (entry.name.endsWith(".ts")) hash.update(entryPath).update("\0").update(fs.readFileSync(entryPath));
    }
  };
  for (const root of ["src/server", "src/shared"]) visit(path.resolve(root));
  return `srtl_test_template_${hash.digest("hex").slice(0, 16)}`;
}

const templateLockKey = 7_401_962_113;

/**
 * Runs every migration once into a template database, which each test database then copies. Copying
 * takes about 20 ms; migrating from nothing takes about 250 ms, and the suite makes about a thousand.
 * Vitest runs files in several processes, so an advisory lock lets one of them build it while the others
 * wait. The template is built under another name and renamed when finished, so a run that dies halfway
 * leaves nothing that looks usable. The key check is removed again: a fresh database has none, and
 * tests of the secret key expect that.
 */
async function migratedTemplate(adminDatabaseUrl: string): Promise<string> {
  const name = templateName();
  const pool = new Pool({ connectionString: adminDatabaseUrl, max: 1 });
  // Every query here goes through this one client, which holds the lock.
  const client = await pool.connect();
  try {
    await client.query("select pg_advisory_lock($1)", [templateLockKey]);
    const existing = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [name]);
    if (existing.rowCount) return name;
    const buildName = `${name}_build`;
    await dropDatabase(adminDatabaseUrl, buildName);
    await client.query(`CREATE DATABASE ${quoteIdentifier(buildName)}`);
    const build = await openDatabase(databaseUrlFor(adminDatabaseUrl, buildName));
    try {
      await build.pool.query("DELETE FROM app_settings WHERE key = $1", [secretKeyCheckSetting]);
    } finally {
      await build.close();
    }
    await waitForBackendsToLeave(client, buildName);
    await client.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1", [buildName]);
    await client.query(`ALTER DATABASE ${quoteIdentifier(buildName)} RENAME TO ${quoteIdentifier(name)}`);
    // Nothing may be connected to a database while it is copied, so nothing is allowed to connect.
    await client.query(`ALTER DATABASE ${quoteIdentifier(name)} ALLOW_CONNECTIONS false`);
    return name;
  } finally {
    await client.query("select pg_advisory_unlock($1)", [templateLockKey]).catch(() => undefined);
    client.release();
    await pool.end();
  }
}

export async function createTestDatabase(options: TestDatabaseOptions = {}): Promise<TestDatabaseHandle> {
  const server = await getPostgresServer();
  const databaseName = nextDatabaseName();
  if (options.empty) {
    await createDatabase(server.adminDatabaseUrl, databaseName);
  } else {
    templatePromise ??= migratedTemplate(server.adminDatabaseUrl).catch((error: unknown) => {
      templatePromise = null;
      throw error;
    });
    await createDatabase(server.adminDatabaseUrl, databaseName, await templatePromise);
  }
  let cleaned = false;

  return {
    databaseUrl: databaseUrlFor(server.adminDatabaseUrl, databaseName),
    async cleanup() {
      if (cleaned) return;
      cleaned = true;
      await dropDatabase(server.adminDatabaseUrl, databaseName);
    }
  };
}

export async function openTestDatabase(): Promise<DatabaseContext> {
  const testDatabase = await createTestDatabase();
  const database = await openDatabase(testDatabase.databaseUrl);
  let closed = false;

  return {
    pool: database.pool,
    db: database.db,
    async close() {
      if (closed) return;
      closed = true;
      await database.close();
      await testDatabase.cleanup();
    }
  };
}
