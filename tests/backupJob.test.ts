import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, type AppContext } from "../src/server/app";
import { setSetting } from "../src/server/db/database";
import * as schema from "../src/server/db/schema";
import { JobWorker } from "../src/server/jobs/jobRunner";
import { refreshBackupStatusIfDue, startScheduledBackup } from "../src/server/jobs/scheduledBackups";
import { backupLastSlotKey, backupScheduleAnchorKey, backupSettingsKey, backupStatusKey, getBackupState, listBackups, type BackupCommand, type BackupCommandRunner, type BackupRuntime } from "../src/server/lib/backups";
import { markOnboardingCompleteForExistingInstall } from "../src/server/lib/onboarding";
import { backupFolderName, previousBackupSlot, type BackupLocationStatus } from "../src/shared/backups";
import { readSetupToken } from "./authHelpers";
import { makeBackupTestDir } from "./backupHelpers";
import { createTestDatabase, type TestDatabaseHandle } from "./testDb";

const quietLogger = { info: () => undefined, warn: () => undefined, error: () => undefined };

let app: AppContext;
let database: TestDatabaseHandle;
let root: string;
let backupDir: string;
let cookie: string;
const commands: BackupCommand[] = [];

/** Stands in for the PostgreSQL client tools; the real ones run in backupRoundTrip.test.ts. */
const fakeClient: BackupCommandRunner = async (command) => {
  commands.push(command);
  if (command.args.includes("--version")) return { exitCode: 0, stdout: `${path.basename(command.file)} (PostgreSQL) 17.6\n`, stderr: "" };
  if (command.args.includes("--list")) return { exitCode: 0, stdout: "12; 1259 1 TABLE public schema_migrations owner\n", stderr: "" };
  fs.writeSync(command.stdoutFd!, "a custom-format dump");
  return { exitCode: 0, stdout: "", stderr: "" };
};

function runtime(overrides: Partial<BackupRuntime> = {}): BackupRuntime {
  return { databaseUrl: database.databaseUrl, defaultLocation: backupDir, pgBinDir: null, paths: app.config.paths, runCommand: fakeClient, freeBytes: async () => 100 * 1024 ** 3, ...overrides };
}

function worker(overrides: Partial<BackupRuntime> = {}): JobWorker {
  return new JobWorker(app.database.db, { workerId: "backup-test", logger: quietLogger, backup: runtime(overrides) });
}

function folder(): string {
  return path.join(backupDir, backupFolderName);
}

async function runBackupJob(overrides: Partial<BackupRuntime> = {}) {
  const jobId = await app.jobs.startBackup("manual");
  await worker(overrides).runOnce();
  return app.jobs.getJob(jobId);
}

beforeEach(async () => {
  root = await makeBackupTestDir();
  backupDir = path.join(root, "backups");
  const paths = { symlinkDir: path.join(root, "links"), localDir: path.join(root, "local"), remoteDir: path.join(root, "remote") };
  for (const directory of Object.values(paths)) await fsp.mkdir(directory, { recursive: true });
  database = await createTestDatabase();
  app = await createApp({ rootDir: root, databaseUrl: database.databaseUrl, autoMigrate: true, paths, backupDir });
  app.app.log.level = "silent";
  await markOnboardingCompleteForExistingInstall(app.database.db);
  const setup = await app.app.inject({
    method: "POST", url: "/api/auth/setup",
    payload: { setupToken: readSetupToken(app), username: "backup-admin", password: "correct horse battery", confirmPassword: "correct horse battery" }
  });
  expect(setup.statusCode).toBe(200);
  cookie = String(setup.headers["set-cookie"]).split(";")[0]!;
  commands.length = 0;
});

afterEach(async () => {
  await app?.app.close();
  await database?.cleanup();
  await fsp.rm(root, { recursive: true, force: true });
});

describe("backup job", () => {
  it("produces a verified dump, checksum and manifest with private permissions", async () => {
    const job = await runBackupJob();
    expect(job?.status).toBe("completed");
    const files = fs.readdirSync(folder());
    expect(files).toHaveLength(3);
    expect(fs.statSync(folder()).mode & 0o777).toBe(0o700);
    for (const file of files) expect(fs.statSync(path.join(folder(), file)).mode & 0o777).toBe(0o600);
    const [backup] = await listBackups(folder());
    expect(backup?.entry).toMatchObject({ verified: true, migration: 28 });
    const manifest = JSON.parse(fs.readFileSync(path.join(folder(), files.find((file) => file.endsWith(".manifest.json"))!), "utf8")) as Record<string, unknown>;
    expect(manifest).toMatchObject({ format: "srtl-manager-database-backup", appVersion: expect.any(String), migration: 28, databaseSizeBytes: expect.any(Number), trigger: "manual" });
  });

  it("keeps the database password out of arguments, job history and manifests", async () => {
    const password = new URL(database.databaseUrl).password;
    const failing: BackupCommandRunner = async (command) => {
      if (command.args.includes("--version")) return fakeClient(command);
      commands.push(command);
      return { exitCode: 1, stdout: "", stderr: `pg_dump: error: connection failed with password ${password}` };
    };
    const job = await runBackupJob({ runCommand: failing });
    expect(job?.status).toBe("failed");
    const dump = commands.find((command) => command.stdoutFd !== undefined || command.args.includes("--format=custom"));
    expect(dump?.env.PGPASSWORD).toBe(password);
    expect(dump?.args.join(" ")).not.toContain(password);
    expect(dump?.args.join(" ")).not.toContain("postgres://");
    const events = await app.jobs.listEvents(job!.id);
    const history = JSON.stringify(events);
    expect(history).toContain("[redacted]");
    expect(history).not.toContain(password);
  });

  it("gives other programs no secret: --version and pg_restore get no database environment", async () => {
    await runBackupJob();
    const other = commands.filter((command) => !command.args.includes("--format=custom"));
    expect(other.length).toBeGreaterThan(0);
    for (const command of other) expect(command.env.PGPASSWORD).toBeUndefined();
    const dump = commands.find((command) => command.args.includes("--format=custom"));
    expect(dump?.env.SRTL_SECRET_KEY).toBeUndefined();
  });

  it("removes a backup that fails verification and leaves earlier ones and pruning alone", async () => {
    await setSetting(app.database.db, backupSettingsKey, { enabled: true, time: "03:30", keep: 2, location: null });
    for (let run = 0; run < 2; run += 1) {
      expect((await runBackupJob())?.status).toBe("completed");
      await new Promise((resolve) => setTimeout(resolve, 1_100));
    }
    const before = fs.readdirSync(folder()).sort();
    const job = await runBackupJob({
      runCommand: async (command) => (command.args.includes("--list") ? { exitCode: 1, stdout: "", stderr: "pg_restore: error: did not find magic string in file header" } : fakeClient(command))
    });
    expect(job?.status).toBe("failed");
    expect(JSON.stringify(await app.jobs.listEvents(job!.id))).toContain("did not find magic string");
    expect(fs.readdirSync(folder()).sort()).toEqual(before);
    const state = await getBackupState(app.database.db, runtime());
    expect(state.alert?.kind).toBe("failed");
    expect(state.status?.backups.filter((backup) => backup.verified)).toHaveLength(2);
  });

  it("prunes only after a new backup verifies, down to the setting", async () => {
    await setSetting(app.database.db, backupSettingsKey, { enabled: true, time: "03:30", keep: 1, location: null });
    for (let run = 0; run < 3; run += 1) {
      expect((await runBackupJob())?.status).toBe("completed");
      await new Promise((resolve) => setTimeout(resolve, 1_100));
    }
    // A setting of one still leaves two.
    expect((await listBackups(folder())).filter((set) => set.entry.verified)).toHaveLength(2);
    expect(fs.readdirSync(folder())).toHaveLength(6);
  });

  it("fails clearly before dumping when free space is too low", async () => {
    const job = await runBackupJob({ freeBytes: async () => 1024 });
    expect(job?.status).toBe("failed");
    expect(JSON.stringify(await app.jobs.listEvents(job!.id))).toMatch(/Not enough free space at the backup location: 1 MB free/);
    expect(commands.some((command) => command.args.includes("--format=custom"))).toBe(false);
    expect(fs.readdirSync(folder())).toEqual([]);
  });

  it("fails plainly when the client tools are missing or too old", async () => {
    const missing = await runBackupJob({ runCommand: async () => { throw Object.assign(new Error("spawn pg_dump ENOENT"), { code: "ENOENT" }); } });
    expect(JSON.stringify(await app.jobs.listEvents(missing!.id))).toContain("pg_dump was not found");
    const old = await runBackupJob({
      runCommand: async (command) => (command.args.includes("--version") ? { exitCode: 0, stdout: "pg_dump (PostgreSQL) 15.8\n", stderr: "" } : fakeClient(command))
    });
    expect(JSON.stringify(await app.jobs.listEvents(old!.id))).toMatch(/pg_dump is version 15, but this PostgreSQL \d+ database needs version \d+ or newer/);
  });

  it("clears a temporary file an interrupted run left, and nothing else", async () => {
    await fsp.mkdir(folder(), { recursive: true, mode: 0o700 });
    const leftover = "srtl-manager-backup-20260101T000000Z-j1.dump.tmp";
    await fsp.writeFile(path.join(folder(), leftover), "partial");
    await fsp.writeFile(path.join(folder(), "somebody.tmp"), "theirs");
    expect((await runBackupJob())?.status).toBe("completed");
    expect(fs.existsSync(path.join(folder(), leftover))).toBe(false);
    expect(fs.existsSync(path.join(folder(), "somebody.tmp"))).toBe(true);
  });

  it("appears in job history and refuses a second run while one is active", async () => {
    const jobId = await app.jobs.startBackup("manual");
    const second = await app.app.inject({ method: "POST", url: "/api/backups/run", headers: { cookie } });
    expect(second.statusCode).toBe(409);
    expect(second.json<{ error: string }>().error).toContain(`job #${jobId}`);
    expect((await app.jobs.listJobs({ limit: 5 })).map((job) => job.type)).toContain("backup");
  });

  it("runs beside normal jobs instead of waiting for, or taking, their only slot", async () => {
    let release = () => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    type WithHandler = { runHandler: (job: { type: string }, ctx: unknown) => Promise<void> };
    const prototype = JobWorker.prototype as unknown as WithHandler;
    const original = prototype.runHandler;
    const handler = vi.spyOn(prototype, "runHandler").mockImplementation(async function (this: WithHandler, job, ctx) {
      if (job.type === "backup") return original.call(this, job, ctx);
      await held;
    });
    const concurrency = { workerCount: 1, maxRunningJobs: 1, maxRunningScans: 1, maxRunningAudits: 1, maxRunningCopies: 1, copyFileConcurrency: 1, maxActiveCopyFiles: 1 };
    const looping = new JobWorker(app.database.db, { workerId: "slots", logger: quietLogger, backup: runtime(), concurrency, dispatchConcurrency: 1, pollIntervalMs: 5 });
    const waitFor = async (check: () => Promise<boolean>, message: string) => {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        if (await check()) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(message);
    };
    const running = looping.start();
    try {
      const first = await app.jobs.startWatchSync({ mode: "reconcile", pairIds: [] });
      await waitFor(async () => (await app.jobs.getJob(first))?.status === "running", "The first job never started");
      const second = await app.jobs.startWatchSync({ mode: "reconcile", pairIds: [] });
      const backup = await app.jobs.startBackup("manual");
      await waitFor(async () => (await app.jobs.getJob(backup))?.status === "completed", "The backup waited for a job slot");
      expect((await app.jobs.getJob(first))?.status).toBe("running");
      expect((await app.jobs.getJob(second))?.status).toBe("queued");
      release();
      await waitFor(async () => (await app.jobs.getJob(second))?.status === "completed", "Normal jobs did not continue after the backup");
    } finally {
      release();
      looping.stop();
      await running;
      handler.mockRestore();
    }
  });

  it("is a job type the database accepts", async () => {
    const jobId = await app.jobs.startBackup("manual");
    expect((await app.database.db.select().from(schema.jobs).where(eq(schema.jobs.type, "backup"))).map((row) => row.id)).toEqual([jobId]);
  });
});

describe("backup schedule worker", () => {
  const anchor = new Date(2026, 10, 1, 12);

  it("starts the schedule at the next start time rather than right away", async () => {
    expect(await startScheduledBackup(app.database.db, app.jobs, new Date(2026, 10, 1, 12))).toBeNull();
    expect(await app.jobs.listJobs({ limit: 5 })).toEqual([]);
  });

  it("queues each start once", async () => {
    await setSetting(app.database.db, backupScheduleAnchorKey, anchor.toISOString());
    const at = new Date(2026, 10, 2, 3, 30, 10);
    const jobId = await startScheduledBackup(app.database.db, app.jobs, at);
    expect(jobId).toEqual(expect.any(Number));
    expect((await app.jobs.getJob(jobId!))?.options).toMatchObject({ trigger: "scheduled" });
    expect(await startScheduledBackup(app.database.db, app.jobs, at)).toBeNull();
    await worker().runOnce();
    expect(await startScheduledBackup(app.database.db, app.jobs, new Date(2026, 10, 2, 9))).toBeNull();
    expect(await startScheduledBackup(app.database.db, app.jobs, new Date(2026, 10, 3, 3, 30))).toEqual(expect.any(Number));
  });

  it("treats a manual run already active as covering the start", async () => {
    await setSetting(app.database.db, backupScheduleAnchorKey, anchor.toISOString());
    await app.jobs.startBackup("manual");
    const at = new Date(2026, 10, 2, 3, 31);
    expect(await startScheduledBackup(app.database.db, app.jobs, at)).toBeNull();
    const stored = await app.database.db.select().from(schema.appSettings).where(eq(schema.appSettings.key, backupLastSlotKey));
    expect(JSON.parse(stored[0]!.value)).toBe(previousBackupSlot("03:30", at).toISOString());
  });

  it("does nothing when off", async () => {
    await setSetting(app.database.db, backupScheduleAnchorKey, anchor.toISOString());
    await setSetting(app.database.db, backupSettingsKey, { enabled: false, time: "03:30", keep: 7, location: null });
    expect(await startScheduledBackup(app.database.db, app.jobs, new Date(2026, 10, 2, 3, 31))).toBeNull();
  });

  it("publishes what it finds, says plainly when a location cannot be written, and rechecks a saved change at once", async () => {
    await refreshBackupStatusIfDue(app.database.db, runtime());
    let state = await getBackupState(app.database.db, runtime());
    expect(state.status).toMatchObject({ ready: true, problem: null, location: backupDir });
    expect(state.status?.freeBytes).toBeGreaterThan(0);

    const locked = path.join(root, "locked");
    await fsp.mkdir(locked);
    await fsp.chmod(locked, 0o500);
    await setSetting(app.database.db, backupSettingsKey, { enabled: true, time: "03:30", keep: 7, location: locked });
    expect((await getBackupState(app.database.db, runtime())).status).toBeNull();
    await refreshBackupStatusIfDue(app.database.db, runtime());
    state = await getBackupState(app.database.db, runtime());
    expect(state.status?.ready).toBe(false);
    expect(state.status?.problem).toMatch(/does not have permission to write/);
    expect(state.alert).toMatchObject({ kind: "unavailable" });
    await fsp.chmod(locked, 0o700);
  });

  it("reports missing client tools in the status, before any backup is attempted", async () => {
    await refreshBackupStatusIfDue(app.database.db, runtime({ runCommand: async () => { throw Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }); } }));
    const status = (await getBackupState(app.database.db, runtime())).status;
    expect(status).toMatchObject({ ready: false });
    expect(status?.problem).toMatch(/pg_dump was not found.*SRTL_PG_BIN_DIR/);
  });

  it("does not look at a healthy location on every check", async () => {
    const now = new Date();
    await refreshBackupStatusIfDue(app.database.db, runtime(), now);
    const runner = vi.fn(fakeClient);
    await refreshBackupStatusIfDue(app.database.db, runtime({ runCommand: runner }), new Date(now.getTime() + 60_000));
    expect(runner).not.toHaveBeenCalled();
    await refreshBackupStatusIfDue(app.database.db, runtime({ runCommand: runner }), new Date(now.getTime() + 16 * 60_000));
    expect(runner).toHaveBeenCalled();
  });

  it("raises an overdue alert when a scheduled backup never ran, visible to the health check as a kind only", async () => {
    await setSetting(app.database.db, backupScheduleAnchorKey, new Date(Date.now() - 5 * 24 * 60 * 60_000).toISOString());
    await setSetting(app.database.db, backupStatusKey, { location: backupDir, directory: folder(), checkedAt: new Date().toISOString(), ready: true, problem: null, permissionsWarning: null, freeBytes: 1, backups: [] } satisfies BackupLocationStatus);
    const previousSlot = new Date(Date.now() - 3 * 60 * 60_000);
    const time = `${String(previousSlot.getHours()).padStart(2, "0")}:${String(previousSlot.getMinutes()).padStart(2, "0")}`;
    await setSetting(app.database.db, backupSettingsKey, { enabled: true, time, keep: 7, location: null });
    expect((await getBackupState(app.database.db, runtime())).alert?.kind).toBe("overdue");

    const health = await app.app.inject({ method: "GET", url: "/api/health", headers: { cookie } });
    expect(health.json<{ backups: string }>().backups).toBe("overdue");
    expect(health.body).not.toContain(backupDir);
  });
});

describe("backup routes", () => {
  const validSettings = { enabled: true, time: "02:15", keep: 5, location: null };

  it.each([
    ["GET", "/api/backups"],
    ["PUT", "/api/backups/settings"],
    ["POST", "/api/backups/run"]
  ] as const)("%s %s requires a signed-in admin", async (method, url) => {
    const response = await app.app.inject({ method, url, ...(method === "PUT" ? { payload: validSettings } : {}) });
    expect(response.statusCode).toBe(401);
    expect(response.body).not.toContain(backupDir);
  });

  it("refuses a request whose session has been revoked", async () => {
    await app.app.inject({ method: "POST", url: "/api/auth/logout", headers: { cookie } });
    expect((await app.app.inject({ method: "GET", url: "/api/backups", headers: { cookie } })).statusCode).toBe(401);
    expect((await app.app.inject({ method: "POST", url: "/api/backups/run", headers: { cookie } })).statusCode).toBe(401);
  });

  it("offers no route that serves a backup file", async () => {
    const backup = await runBackupJob();
    expect(backup?.status).toBe("completed");
    const [set] = await listBackups(folder());
    for (const url of [`/api/backups/${set!.entry.name}`, `/api/backups/${set!.entry.name}/download`, `/api/backups/download`]) {
      expect((await app.app.inject({ method: "GET", url, headers: { cookie } })).statusCode).toBe(404);
    }
  });

  it("shows defaults on a new install", async () => {
    const response = await app.app.inject({ method: "GET", url: "/api/backups", headers: { cookie } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ settings: { enabled: true, time: "03:30", keep: 7, location: null }, location: backupDir, defaultLocation: backupDir, lastRun: null, activeJobId: null, timeZone: expect.any(String), nextRunAt: expect.any(String) });
  });

  it("saves settings and audits the change", async () => {
    const saved = await app.app.inject({ method: "PUT", url: "/api/backups/settings", headers: { cookie }, payload: validSettings });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({ settings: validSettings });
    const trail = (await app.app.inject({ method: "GET", url: "/api/system/action-audit", headers: { cookie } })).json<Array<{ action: string; actor: { username: string }; targets: Record<string, unknown> }>>();
    expect(trail[0]).toMatchObject({ action: "backup.settings_change", actor: { username: "backup-admin" }, targets: { time: { from: "03:30", to: "02:15" }, keep: { from: 7, to: 5 } } });
  });

  it("drops a trailing slash from a saved location", async () => {
    const location = path.join(root, "elsewhere");
    const saved = await app.app.inject({ method: "PUT", url: "/api/backups/settings", headers: { cookie }, payload: { ...validSettings, location: `${location}/` } });
    expect(saved.json()).toMatchObject({ settings: { location }, location });
  });

  it("does not audit a save that changed nothing", async () => {
    await app.app.inject({ method: "PUT", url: "/api/backups/settings", headers: { cookie }, payload: { enabled: true, time: "03:30", keep: 7, location: null } });
    const trail = (await app.app.inject({ method: "GET", url: "/api/system/action-audit", headers: { cookie } })).json<Array<{ action: string }>>();
    expect(trail.filter((entry) => entry.action === "backup.settings_change")).toEqual([]);
  });

  it("audits a manual run", async () => {
    const started = await app.app.inject({ method: "POST", url: "/api/backups/run", headers: { cookie } });
    expect(started.statusCode).toBe(200);
    const { jobId } = started.json<{ jobId: number }>();
    const trail = (await app.app.inject({ method: "GET", url: "/api/system/action-audit", headers: { cookie } })).json<Array<{ action: string; actor: { username: string }; targets: Record<string, unknown> }>>();
    expect(trail[0]).toMatchObject({ action: "backup.run", actor: { username: "backup-admin" }, targets: { jobId } });
    expect(JSON.stringify(await app.jobs.listEvents(jobId))).toContain("backup-admin");
  });

  it.each([
    [{ ...validSettings, time: "25:00" }, /HH:MM/],
    [{ ...validSettings, keep: 1 }, /at least 2/],
    [{ ...validSettings, keep: 1000 }, /at most/],
    [{ ...validSettings, location: "relative/path" }, /absolute/],
    [{ ...validSettings, location: "/srv/backups/../etc" }, /\.\./],
    [{ ...validSettings, location: "/etc/backups" }, /system folder/],
    [{ ...validSettings, location: "/tmp/backups" }, /system folder/]
  ])("rejects unusable settings %#", async (payload, message) => {
    const response = await app.app.inject({ method: "PUT", url: "/api/backups/settings", headers: { cookie }, payload });
    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: string }>().error).toMatch(message);
    expect((await app.app.inject({ method: "GET", url: "/api/backups", headers: { cookie } })).json<{ settings: { time: string } }>().settings.time).toBe("03:30");
  });

  it("rejects a location inside a media root", async () => {
    const response = await app.app.inject({ method: "PUT", url: "/api/backups/settings", headers: { cookie }, payload: { ...validSettings, location: path.join(app.config.paths.localDir, "backups") } });
    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: string }>().error).toMatch(/media or symlink root/);
  });

  it("does not start a run while the location is refused", async () => {
    await setSetting(app.database.db, backupSettingsKey, { enabled: true, time: "03:30", keep: 7, location: "/etc/backups" });
    const response = await app.app.inject({ method: "POST", url: "/api/backups/run", headers: { cookie } });
    expect(response.statusCode).toBe(400);
    expect(await app.jobs.listJobs({ limit: 5 })).toEqual([]);
    expect((await getBackupState(app.database.db, runtime())).alert?.kind).toBe("unavailable");
  });

  it("refuses a run that a worker reached after the location became unusable", async () => {
    const jobId = await app.jobs.startBackup("manual");
    await setSetting(app.database.db, backupSettingsKey, { enabled: true, time: "03:30", keep: 7, location: "/etc/backups" });
    await worker().runOnce();
    expect((await app.jobs.getJob(jobId))?.status).toBe("failed");
    expect(fs.existsSync("/etc/backups")).toBe(false);
  });
});
