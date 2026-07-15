import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/server/config";

let tmpDir: string;

describe("config", () => {
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "srtl-config-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("loads runtime paths from the root .env when process env does not override them", async () => {
    const dataDir = path.join(tmpDir, "app-data");
    await fs.writeFile(path.join(tmpDir, ".env"), [`SRTL_DATA_DIR="${dataDir}"`, "SRTL_DATABASE_URL=postgres://test:test@db:5432/test", "SRTL_PORT=3009", "SRTL_WEB_PORT=5178", "SRTL_HOST=0.0.0.0", "SYMLINK_DIR=/mnt/links", "SRTL_LOCATION_1_PATH=/mnt/local", "SRTL_LOCATION_2_PATH=/mnt/remote"].join("\n"));

    const config = loadConfig({ rootDir: tmpDir });

    expect(config.dataDir).toBe(dataDir);
    expect(config.databaseUrl).toBe("postgres://test:test@db:5432/test");
    expect(config.host).toBe("0.0.0.0");
    expect(config.port).toBe(3009);
    expect(config.sessionCookieName).toBe("srtl_session_5178");
    expect(config.paths).toEqual({ symlinkDir: "/mnt/links", localDir: "/mnt/local", remoteDir: "/mnt/remote" });
  });

  it("keeps worker concurrency hard-capped while the worker count setting is a placeholder", async () => {
    await fs.writeFile(
      path.join(tmpDir, ".env"),
      ["SRTL_WORKER_COUNT=4", "SRTL_MAX_RUNNING_JOBS=8", "SRTL_MAX_RUNNING_SCANS=2", "SRTL_MAX_RUNNING_AUDITS=3", "SRTL_MAX_RUNNING_COPIES=5"].join("\n")
    );

    const config = loadConfig({ rootDir: tmpDir });

    expect(config.jobConcurrency).toEqual({
      workerCount: 1,
      maxRunningJobs: 1,
      maxRunningScans: 1,
      maxRunningAudits: 1,
      maxRunningCopies: 1
    });
  });

  it("constructs the database URL from a single password setting", async () => {
    await fs.writeFile(
      path.join(tmpDir, ".env"),
      ["SRTL_POSTGRES_HOST=postgres", "SRTL_POSTGRES_PORT=5432", "SRTL_POSTGRES_DB=srtl_manager", "SRTL_POSTGRES_USER=srtl", "SRTL_POSTGRES_PASSWORD=p@ss/word"].join("\n")
    );

    const databaseUrl = new URL(loadConfig({ rootDir: tmpDir }).databaseUrl);

    expect(databaseUrl.hostname).toBe("postgres");
    expect(databaseUrl.port).toBe("5432");
    expect(databaseUrl.pathname).toBe("/srtl_manager");
    expect(databaseUrl.username).toBe("srtl");
    expect(decodeURIComponent(databaseUrl.password)).toBe("p@ss/word");
  });

  it("rejects invalid ports, database URLs, and cross-origin configuration", async () => {
    await fs.writeFile(path.join(tmpDir, ".env"), "SRTL_PORT=70000\n");
    expect(() => loadConfig({ rootDir: tmpDir })).toThrow("Invalid port setting");

    await fs.writeFile(path.join(tmpDir, ".env"), "SRTL_WEB_PORT=70000\n");
    expect(() => loadConfig({ rootDir: tmpDir })).toThrow("Invalid port setting");

    await fs.writeFile(path.join(tmpDir, ".env"), "SRTL_DATABASE_URL=https://db.invalid/example\n");
    expect(() => loadConfig({ rootDir: tmpDir })).toThrow("must use postgres://");

    await fs.writeFile(path.join(tmpDir, ".env"), "SRTL_POSTGRES_PORT=70000\n");
    expect(() => loadConfig({ rootDir: tmpDir })).toThrow("Invalid port setting");

    await fs.writeFile(path.join(tmpDir, ".env"), "SRTL_ALLOWED_ORIGINS=https://example.invalid/path\n");
    expect(() => loadConfig({ rootDir: tmpDir })).toThrow("Invalid allowed origin");
  });
});
