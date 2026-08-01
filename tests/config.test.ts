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

  it("loads an arbitrary worker count and its bounded concurrency safeguards", async () => {
    await fs.writeFile(
      path.join(tmpDir, ".env"),
      [
        "SRTL_WORKER_COUNT=128",
        "SRTL_MAX_RUNNING_JOBS=64",
        "SRTL_MAX_RUNNING_SCANS=2",
        "SRTL_MAX_RUNNING_AUDITS=3",
        "SRTL_MAX_RUNNING_COPIES=60",
        "SRTL_COPY_FILE_CONCURRENCY=8",
        "SRTL_MAX_ACTIVE_COPY_FILES=32"
      ].join("\n")
    );

    const config = loadConfig({ rootDir: tmpDir });

    expect(config.jobConcurrency).toEqual({
      workerCount: 128,
      maxRunningJobs: 64,
      maxRunningScans: 2,
      maxRunningAudits: 3,
      maxRunningCopies: 60,
      copyFileConcurrency: 8,
      maxActiveCopyFiles: 32
    });
  });

  it("uses the serial worker default from the checked-in example environment", async () => {
    const example = await fs.readFile(new URL("../.env.example", import.meta.url), "utf8");
    const workerCountSetting = example
      .split(/\r?\n/)
      .find((line) => line.startsWith("SRTL_WORKER_COUNT="));

    expect(workerCountSetting).toBe("SRTL_WORKER_COUNT=1");
    await fs.writeFile(path.join(tmpDir, ".env"), `${workerCountSetting}\n`);

    expect(loadConfig({ rootDir: tmpDir }).jobConcurrency).toEqual({
      workerCount: 1,
      maxRunningJobs: 1,
      maxRunningScans: 1,
      maxRunningAudits: 1,
      maxRunningCopies: 1,
      copyFileConcurrency: 1,
      maxActiveCopyFiles: 1
    });
  });

  it("derives safe limits from the worker count while keeping each copy job serial by default", async () => {
    await fs.writeFile(path.join(tmpDir, ".env"), "SRTL_WORKER_COUNT=4\n");

    expect(loadConfig({ rootDir: tmpDir }).jobConcurrency).toEqual({
      workerCount: 4,
      maxRunningJobs: 4,
      maxRunningScans: 4,
      maxRunningAudits: 4,
      maxRunningCopies: 4,
      copyFileConcurrency: 1,
      maxActiveCopyFiles: 4
    });
  });

  it("allows a job type to be paused with a zero per-type limit", async () => {
    await fs.writeFile(path.join(tmpDir, ".env"), ["SRTL_WORKER_COUNT=3", "SRTL_MAX_RUNNING_SCANS=0"].join("\n"));

    expect(loadConfig({ rootDir: tmpDir }).jobConcurrency.maxRunningScans).toBe(0);
  });

  it("rejects malformed and contradictory worker concurrency settings", async () => {
    const invalidSettings = [
      ["SRTL_WORKER_COUNT=0", "SRTL_WORKER_COUNT must be a positive safe integer"],
      ["SRTL_WORKER_COUNT=2.5", "SRTL_WORKER_COUNT must be a positive safe integer"],
      ["SRTL_WORKER_COUNT=9007199254740992", "SRTL_WORKER_COUNT must be a positive safe integer"],
      [["SRTL_WORKER_COUNT=2", "SRTL_MAX_RUNNING_JOBS=3"].join("\n"), "SRTL_MAX_RUNNING_JOBS must not exceed SRTL_WORKER_COUNT"],
      [["SRTL_WORKER_COUNT=4", "SRTL_MAX_RUNNING_JOBS=2", "SRTL_MAX_RUNNING_COPIES=3"].join("\n"), "SRTL_MAX_RUNNING_COPIES must not exceed SRTL_MAX_RUNNING_JOBS"],
      [["SRTL_COPY_FILE_CONCURRENCY=3", "SRTL_MAX_ACTIVE_COPY_FILES=2"].join("\n"), "SRTL_COPY_FILE_CONCURRENCY must not exceed SRTL_MAX_ACTIVE_COPY_FILES"]
    ] as const;

    for (const [contents, message] of invalidSettings) {
      await fs.writeFile(path.join(tmpDir, ".env"), contents);
      expect(() => loadConfig({ rootDir: tmpDir })).toThrow(message);
    }
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

  it("rejects the published database password placeholder in production", async () => {
    const previousNodeEnv = process.env.NODE_ENV;
    const previousPassword = process.env.SRTL_POSTGRES_PASSWORD;
    try {
      process.env.NODE_ENV = "production";
      delete process.env.SRTL_POSTGRES_PASSWORD;
      await fs.writeFile(path.join(tmpDir, ".env"), "SRTL_POSTGRES_PASSWORD=replace-with-your-password\n");

      expect(() => loadConfig({ rootDir: tmpDir })).toThrow("still uses the .env.example placeholder");
    } finally {
      if (previousNodeEnv == null) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
      if (previousPassword == null) delete process.env.SRTL_POSTGRES_PASSWORD;
      else process.env.SRTL_POSTGRES_PASSWORD = previousPassword;
    }
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
