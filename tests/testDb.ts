import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { Pool } from "pg";
import { openDatabase, type DatabaseContext } from "../src/server/db/database";

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

let serverPromise: Promise<TestPostgresServer> | null = null;
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

async function createDatabase(adminDatabaseUrl: string, databaseName: string): Promise<void> {
  const pool = new Pool({ connectionString: adminDatabaseUrl });
  try {
    await pool.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
  } finally {
    await pool.end();
  }
}

async function dropDatabase(adminDatabaseUrl: string, databaseName: string): Promise<void> {
  const pool = new Pool({ connectionString: adminDatabaseUrl });
  try {
    await pool.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1", [databaseName]);
    await pool.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)}`);
  } finally {
    await pool.end();
  }
}

export async function createTestDatabase(): Promise<TestDatabaseHandle> {
  const server = await getPostgresServer();
  const databaseName = nextDatabaseName();
  await createDatabase(server.adminDatabaseUrl, databaseName);
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
