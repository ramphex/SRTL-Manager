import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp, type AppContext } from "../src/server/app";
import { first, getJsonSetting, setSetting } from "../src/server/db/database";
import { applyAuditStateMigration, withAuditByteCompareDefaultOff } from "../src/server/db/auditStateMigration";
import * as schema from "../src/server/db/schema";
import { JobWorker } from "../src/server/jobs/jobRunner";
import { nextRollingAuditBatch, rollingAuditCoverage, rollingAuditWindow } from "../src/server/jobs/rollingAudit";
import { rollingAuditStateKey, startScheduledRollingAudit } from "../src/server/jobs/scheduledAudits";
import { markOnboardingCompleteForExistingInstall } from "../src/server/lib/onboarding";
import { listDamagedFiles } from "../src/server/lib/damagedFiles";
import type { AuditCommandRunner } from "../src/server/lib/auditor";
import { defaultAdvancedSettings, normalizeAdvancedSettings } from "../src/shared/advancedSettings";
import { libraryWideDeepAuditRefusal, libraryWideRemoteAuditRefusal } from "../src/shared/auditEstimate";
import { createTestDatabase, type TestDatabaseHandle } from "./testDb";

const silentLogger = { info: () => undefined, warn: () => undefined, error: () => undefined };

let tmpDir: string;
let ctx: AppContext;
let testDatabase: TestDatabaseHandle;
let paths: { symlinkDir: string; localDir: string; remoteDir: string };

async function insertLocalFile(name: string, overrides: Partial<typeof schema.storageFiles.$inferInsert> = {}): Promise<number> {
  const relativePath = `Sample Film ${name}/sample-${name}.mkv`;
  const filePath = path.join(paths.localDir, "movies", relativePath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `content ${name}`);
  const timestamp = "2026-10-01T00:00:00.000Z";
  const row = await first(
    ctx.database.db
      .insert(schema.storageFiles)
      .values({
        rootType: "local",
        rootPath: paths.localDir,
        section: "movies",
        itemName: `Sample Film ${name}`,
        relativePath: `movies/${relativePath}`,
        filePath,
        storagePolicy: "location_1",
        sizeBytes: 1_000_000,
        mtimeMs: 1,
        firstSeenAt: timestamp,
        lastSeenAt: timestamp,
        lastChangedAt: timestamp,
        lastSeenJobId: 1,
        updatedAt: timestamp,
        ...overrides
      })
      .returning({ id: schema.storageFiles.id })
  );
  if (!row) throw new Error("Storage file fixture was not inserted");
  return row.id;
}

async function insertLink(name: string, kind: "local" | "remote"): Promise<number> {
  const timestamp = new Date().toISOString();
  const root = kind === "local" ? paths.localDir : paths.remoteDir;
  const row = await first(
    ctx.database.db
      .insert(schema.mediaLinks)
      .values({
        section: "movies",
        itemName: `Sample Film ${name}`,
        relativePath: `Sample Film ${name}/sample-${name}.mkv`,
        linkPath: path.join(paths.symlinkDir, "movies", `Sample Film ${name}`, `sample-${name}.mkv`),
        targetPath: path.join(root, "movies", `Sample Film ${name}`, `sample-${name}.mkv`),
        kind,
        targetExists: true,
        isMedia: true,
        storagePolicy: kind === "local" ? "location_1" : "location_2",
        resolvedStorageFileId: null,
        sizeBytes: 2_000_000,
        firstSeenAt: timestamp,
        lastSeenAt: timestamp,
        lastChangedAt: timestamp,
        missingSince: null,
        lastSeenJobId: 1,
        updatedAt: timestamp
      })
      .returning({ id: schema.mediaLinks.id })
  );
  if (!row) throw new Error("Link fixture was not inserted");
  return row.id;
}

async function storageFile(id: number) {
  return first(ctx.database.db.select().from(schema.storageFiles).where(eq(schema.storageFiles.id, id)).limit(1));
}

/** A fake clock and audit runner: every file read moves the clock forward by `stepMs`. */
function clockedRunner(startMs: number, stepMs: number, failing: (targetPath: string) => boolean = () => false) {
  const clock = { now: startMs, audited: [] as string[] };
  const runner: AuditCommandRunner = {
    async runFfmpeg(_mode, targetPath) {
      clock.now += stepMs;
      clock.audited.push(path.basename(targetPath));
      return failing(targetPath) ? { status: "fail", output: "Invalid data found when processing input" } : { status: "pass", output: "" };
    },
    async runCmp() {
      throw new Error("The nightly audit never byte-compares");
    }
  };
  return { clock, runner };
}

async function runJob(jobId: number, worker: JobWorker) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const job = await ctx.jobs.getJob(jobId);
    if (job && ["completed", "partially_failed", "failed", "cancelled"].includes(job.status)) return job;
    await worker.runOnce();
  }
  return ctx.jobs.getJob(jobId);
}

describe("audit defaults", () => {
  it("turns byte compare off and the nightly audit off by default", () => {
    expect(defaultAdvancedSettings.audit).toEqual({ defaultMode: "fast", byteCompareWhenSourceKnown: false, rolling: { enabled: false, startHour: 1, windowHours: 4 } });
    expect(normalizeAdvancedSettings({}).audit.byteCompareWhenSourceKnown).toBe(false);
    expect(normalizeAdvancedSettings({ audit: { defaultMode: "deep" } }).audit).toMatchObject({ byteCompareWhenSourceKnown: false, rolling: { enabled: false } });
    expect(normalizeAdvancedSettings({ audit: { byteCompareWhenSourceKnown: true } }).audit.byteCompareWhenSourceKnown).toBe(true);
    expect(normalizeAdvancedSettings({ audit: { rolling: { enabled: true, startHour: 23, windowHours: 99 } } }).audit.rolling).toEqual({ enabled: true, startHour: 23, windowHours: 4 });
  });

  it("treats a stored true as the old default and keeps a stored false", () => {
    expect(withAuditByteCompareDefaultOff({ audit: { defaultMode: "deep", byteCompareWhenSourceKnown: true }, copy: { profile: "fast" } })).toEqual({
      value: { audit: { defaultMode: "deep", byteCompareWhenSourceKnown: false }, copy: { profile: "fast" } },
      changed: true
    });
    expect(withAuditByteCompareDefaultOff({ audit: { byteCompareWhenSourceKnown: false } }).changed).toBe(false);
    expect(withAuditByteCompareDefaultOff({ scan: {} }).changed).toBe(false);
    expect(withAuditByteCompareDefaultOff(null).changed).toBe(false);
  });
});

describe("rolling audit window", () => {
  it("finds the open window, including one that runs past midnight", () => {
    const at = (hours: number, minutes = 0) => new Date(2026, 10, 11, hours, minutes);
    expect(rollingAuditWindow({ startHour: 1, windowHours: 4 }, at(2, 30))).toMatchObject({ open: true, start: at(1), end: at(5) });
    expect(rollingAuditWindow({ startHour: 1, windowHours: 4 }, at(5))).toMatchObject({ open: false, start: new Date(2026, 10, 12, 1) });
    expect(rollingAuditWindow({ startHour: 23, windowHours: 4 }, at(1))).toMatchObject({ open: true, start: new Date(2026, 10, 10, 23), end: at(3) });
    expect(rollingAuditWindow({ startHour: 23, windowHours: 4 }, at(12))).toMatchObject({ open: false, start: at(23) });
  });
});

describe("audit changes", () => {
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "srtl-audit-changes-"));
    paths = { symlinkDir: path.join(tmpDir, "symlinks"), localDir: path.join(tmpDir, "local"), remoteDir: path.join(tmpDir, "remote") };
    await Promise.all(Object.values(paths).map((directory) => fs.mkdir(directory, { recursive: true })));
    testDatabase = await createTestDatabase();
    ctx = await createApp({
      rootDir: tmpDir,
      dataDir: path.join(tmpDir, "data"),
      databaseUrl: testDatabase.databaseUrl,
      apiDocsEnabled: false,
      autoMigrate: true,
      paths,
      jobConcurrency: { workerCount: 1, maxRunningJobs: 1, maxRunningScans: 1, maxRunningAudits: 1, maxRunningCopies: 1, copyFileConcurrency: 1, maxActiveCopyFiles: 1 }
    });
    const timestamp = new Date().toISOString();
    await setSetting(ctx.database.db, "sections", { sections: ["movies"], sectionTitles: {}, sectionTypes: { movies: "movies" } });
    await ctx.database.db.insert(schema.sections).values({ name: "movies", displayName: null, contentType: "movies", createdAt: timestamp, updatedAt: timestamp }).onConflictDoNothing();
  });

  afterEach(async () => {
    if (typeof ctx !== "undefined") await ctx.app.close();
    if (typeof testDatabase !== "undefined") await testDatabase.cleanup();
    if (typeof tmpDir !== "undefined") await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("migration 34 turns a stored byte compare default off for an existing install", async () => {
    await setSetting(ctx.database.db, "advancedSettings", { audit: { defaultMode: "deep", byteCompareWhenSourceKnown: true }, cleanup: { holdDays: 9 } });
    const pool = new Pool({ connectionString: testDatabase.databaseUrl });
    const client = await pool.connect();
    try {
      await applyAuditStateMigration(client);
      // Running it again changes nothing.
      await applyAuditStateMigration(client);
    } finally {
      client.release();
      await pool.end();
    }
    expect(await getJsonSetting(ctx.database.db, "advancedSettings", {})).toEqual({ audit: { defaultMode: "deep", byteCompareWhenSourceKnown: false }, cleanup: { holdDays: 9 } });
  });

  it("stores the byte compare choice per run and defaults it to off", async () => {
    const linkId = await insertLink("Choice", "local");
    const defaultJob = await ctx.jobs.startAudit({ mode: "fast", linkIds: [linkId] });
    const optedIn = await ctx.jobs.startAudit({ mode: "fast", linkIds: [linkId], byteCompare: true });
    expect((await ctx.jobs.getJob(defaultJob))?.progress).toMatchObject({ options: { byteCompare: false } });
    expect((await ctx.jobs.getJob(optedIn))?.progress).toMatchObject({ options: { byteCompare: true } });
  });

  it("refuses unscoped remote and deep audits and keeps scoped ones", async () => {
    const remoteLink = await insertLink("Remote", "remote");
    await insertLink("Local", "local");
    await expect(ctx.jobs.startAudit({ mode: "deep" })).rejects.toThrow(libraryWideDeepAuditRefusal);
    await expect(ctx.jobs.startAudit({ mode: "fast", targets: ["remote"] })).rejects.toThrow(libraryWideRemoteAuditRefusal);
    await expect(ctx.jobs.startAudit({ mode: "fast", targets: ["local", "remote"], sections: ["movies"] })).rejects.toThrow(libraryWideRemoteAuditRefusal);
    // Folder pickers are not a scope: a deep audit of every local folder is still library-wide.
    await expect(ctx.jobs.startAudit({ mode: "deep", targets: ["local"], sections: ["movies"] })).rejects.toThrow(libraryWideDeepAuditRefusal);

    // A library-wide fast audit with no targets covers local files only.
    const localJob = await ctx.jobs.startAudit("fast");
    expect((await ctx.jobs.getJob(localJob))?.progress).toMatchObject({ options: { targets: ["local"] } });
    await ctx.jobs.terminate(localJob);

    const titleDeep = await ctx.jobs.startAudit({ mode: "deep", section: "movies", itemName: "Sample Film Remote" });
    expect(await ctx.jobs.getJob(titleDeep)).toMatchObject({ status: "queued", exclusive: false });
    await ctx.jobs.terminate(titleDeep);
    const selectedRemote = await ctx.jobs.startAudit({ mode: "fast", linkIds: [remoteLink], targets: ["remote"] });
    expect(await ctx.jobs.getJob(selectedRemote)).toMatchObject({ status: "queued" });
    await ctx.jobs.terminate(selectedRemote);
    const folderDeep = await ctx.jobs.startAudit({ mode: "deep", section: "movies" });
    await ctx.jobs.terminate(folderDeep);
    const fileDeep = await ctx.jobs.startAudit({ mode: "deep", storageFileIds: [await insertLocalFile("Damaged")] });
    expect(await ctx.jobs.getJob(fileDeep)).toMatchObject({ status: "queued", exclusive: false });
  });

  it("refuses unscoped remote and deep audits through the API and explains it in the estimate", async () => {
    const { readSetupToken } = await import("./authHelpers");
    const created = await ctx.app.inject({
      method: "POST",
      url: "/api/auth/setup",
      payload: { setupToken: readSetupToken(ctx), username: "admin", password: "password-1234", confirmPassword: "password-1234" }
    });
    expect(created.statusCode).toBe(200);
    await markOnboardingCompleteForExistingInstall(ctx.database.db);
    const cookie = String(created.headers["set-cookie"]);
    await insertLink("Api Remote", "remote");
    await insertLink("Api Local", "local");

    const deep = await ctx.app.inject({ method: "POST", url: "/api/audits", headers: { cookie }, payload: { mode: "deep" } });
    expect(deep.statusCode).toBe(400);
    expect(deep.json().error).toContain("Library-wide deep audits are turned off");
    const remote = await ctx.app.inject({ method: "POST", url: "/api/audits", headers: { cookie }, payload: { mode: "fast", targets: ["remote"] } });
    expect(remote.statusCode).toBe(400);
    expect(remote.json().error).toContain("reads every remote byte through the remote mount");

    const estimate = await ctx.app.inject({ method: "POST", url: "/api/audits/estimate", headers: { cookie }, payload: { mode: "fast", targets: ["local", "remote"], sections: ["movies"] } });
    expect(estimate.statusCode).toBe(200);
    expect(estimate.json()).toMatchObject({
      scoped: false,
      local: { files: 1, bytes: 2_000_000 },
      remote: { files: 1, bytes: 2_000_000 },
      byteCompare: false,
      refusal: libraryWideRemoteAuditRefusal
    });
    const scoped = await ctx.app.inject({ method: "POST", url: "/api/audits/estimate", headers: { cookie }, payload: { mode: "deep", itemName: "Sample Film Api Remote" } });
    expect(scoped.json()).toMatchObject({ scoped: true, remote: { files: 1 }, refusal: null });
    expect(scoped.json().estimatedSeconds).toBeGreaterThan(0);
  });

  it("picks never-audited local files first, then the oldest checked, and skips files checked this window", async () => {
    const windowStart = "2026-11-11T01:00:00.000Z";
    const recent = await insertLocalFile("Recent", { auditCheckedAt: "2026-11-11T01:30:00.000Z", auditStatus: "pass" });
    const oldest = await insertLocalFile("Oldest", { auditCheckedAt: "2026-09-01T00:00:00.000Z", auditStatus: "pass" });
    const older = await insertLocalFile("Older", { auditCheckedAt: "2026-10-01T00:00:00.000Z", auditStatus: "pass" });
    const never = await insertLocalFile("Never");
    await insertLocalFile("Gone", { missingSince: "2026-10-02T00:00:00.000Z" });
    await insertLocalFile("Remote", { rootType: "remote", filePath: path.join(paths.remoteDir, "movies", "remote.mkv") });

    const batch = await nextRollingAuditBatch(ctx.database.db, windowStart, []);
    expect(batch.map((file) => file.id)).toEqual([never, oldest, older]);
    expect(batch.map((file) => file.id)).not.toContain(recent);
    expect((await nextRollingAuditBatch(ctx.database.db, windowStart, [never])).map((file) => file.id)).toEqual([oldest, older]);
  });

  it("stops at the end of the window, keeps what it checked, and continues from there the next night", async () => {
    const ids = [];
    for (const name of ["A", "B", "C", "D", "E"]) ids.push(await insertLocalFile(name));
    const hour = 3_600_000;
    const night1 = Date.parse("2026-11-11T01:00:00.000Z");
    const first = clockedRunner(night1, hour, (target) => target.includes("sample-B"));
    const worker1 = new JobWorker(ctx.database.db, { workerId: "nightly-1", logger: silentLogger, auditRunner: first.runner, now: () => first.clock.now });
    // A 2.5 hour window at one hour per file reads three files.
    const job1 = await ctx.jobs.startRollingAudit({ windowStart: new Date(night1).toISOString(), windowEnd: new Date(night1 + 2.5 * hour).toISOString() });
    expect(await ctx.jobs.getJob(job1)).toMatchObject({ exclusive: false });
    expect(await runJob(job1, worker1)).toMatchObject({ status: "completed", progress: { stopReason: "window_end", checked: 3, failed: 1 } });
    expect(first.clock.audited).toEqual(["sample-A.mkv", "sample-B.mkv", "sample-C.mkv"]);
    const run1 = await first_(job1);
    expect(run1).toMatchObject({ rolling: true, stopReason: "window_end", checked: 3, failed: 1, checkedBytes: 3_000_000 });
    expect(await storageFile(ids[0]!)).toMatchObject({ auditStatus: "pass", auditMode: "fast" });
    expect(await storageFile(ids[3]!)).toMatchObject({ auditCheckedAt: null });
    // Only the failure is kept as an audit result row; passes live on the file.
    const results = await ctx.database.db.select().from(schema.auditResults).where(eq(schema.auditResults.auditRunId, run1!.id));
    expect(results.map((result) => path.basename(result.targetPath))).toEqual(["sample-B.mkv"]);

    // The failure shows up where damaged files are listed.
    const damaged = await listDamagedFiles(ctx.database.db);
    expect(damaged).toEqual([expect.objectContaining({ storageFileId: ids[1], integrity: "audit_failed", audit: expect.objectContaining({ status: "fail", mode: "fast" }) })]);

    const night2 = night1 + 24 * hour;
    const second = clockedRunner(night2, hour);
    const worker2 = new JobWorker(ctx.database.db, { workerId: "nightly-2", logger: silentLogger, auditRunner: second.runner, now: () => second.clock.now });
    const job2 = await ctx.jobs.startRollingAudit({ windowStart: new Date(night2).toISOString(), windowEnd: new Date(night2 + 4 * hour).toISOString() });
    expect(await runJob(job2, worker2)).toMatchObject({ status: "completed", progress: { stopReason: "window_end" } });
    // Never-audited D and E come first, then the oldest checked from the night before.
    expect(second.clock.audited).toEqual(["sample-D.mkv", "sample-E.mkv", "sample-A.mkv", "sample-B.mkv"]);
    // B passed this time, so it leaves the Damaged files page.
    expect(await listDamagedFiles(ctx.database.db)).toEqual([]);

    const coverage = await rollingAuditCoverage(ctx.database.db, { enabled: true, startHour: 1, windowHours: 4 }, 30, new Date(night2 + 5 * hour));
    expect(coverage).toMatchObject({ localFiles: 5, checkedFiles: 5, neverCheckedFiles: 0, failedFiles: 0, lastRun: { jobId: job2, stopReason: "window_end" } });
  });

  it("abandons a file still being read when the window ends and checks it first next night", async () => {
    const id = await insertLocalFile("Slow");
    const start = Date.now();
    let release: (() => void) | null = null;
    const runner: AuditCommandRunner = {
      runFfmpeg: (_mode, _target, signal) =>
        new Promise((resolve, reject) => {
          release = () => resolve({ status: "pass", output: "" });
          signal?.addEventListener("abort", () => reject(new Error("Job terminated")), { once: true });
        }),
      async runCmp() {
        throw new Error("unused");
      }
    };
    const worker = new JobWorker(ctx.database.db, { workerId: "nightly-slow", logger: silentLogger, auditRunner: runner });
    const jobId = await ctx.jobs.startRollingAudit({ windowStart: new Date(start - 60_000).toISOString(), windowEnd: new Date(start + 300).toISOString() });
    expect(await runJob(jobId, worker)).toMatchObject({ status: "completed", progress: { stopReason: "window_end", checked: 0 } });
    expect(release).not.toBeNull();
    expect(await storageFile(id)).toMatchObject({ auditCheckedAt: null });
  });

  it("gives way to an audit someone starts and records why", async () => {
    await insertLocalFile("One");
    await insertLocalFile("Two");
    const linkId = await insertLink("Manual", "local");
    const night = Date.parse("2026-11-11T01:00:00.000Z");
    const clocked = clockedRunner(night, 60_000);
    let manualJob = 0;
    const runner: AuditCommandRunner = {
      ...clocked.runner,
      async runFfmpeg(mode, target, signal) {
        const result = await clocked.runner.runFfmpeg(mode, target, signal);
        if (!manualJob) manualJob = await ctx.jobs.startAudit({ mode: "deep", linkIds: [linkId] });
        return result;
      }
    };
    const worker = new JobWorker(ctx.database.db, { workerId: "nightly-yield", logger: silentLogger, auditRunner: runner, now: () => clocked.clock.now });
    const jobId = await ctx.jobs.startRollingAudit({ windowStart: new Date(night).toISOString(), windowEnd: new Date(night + 4 * 3_600_000).toISOString() });
    expect(await runJob(jobId, worker)).toMatchObject({ status: "completed", progress: { stopReason: "yielded", checked: 1 } });
    expect(await ctx.jobs.getJob(manualJob)).toMatchObject({ status: "queued" });
  });

  it("is off by default and queues once per window when turned on", async () => {
    await markOnboardingCompleteForExistingInstall(ctx.database.db);
    await setSetting(ctx.database.db, "paths", paths);
    await insertLocalFile("Scheduled");
    const inWindow = new Date(2026, 10, 11, 2, 0);
    expect(await startScheduledRollingAudit(ctx.database.db, ctx.jobs, inWindow)).toBeNull();
    expect(await ctx.database.db.select().from(schema.jobs)).toEqual([]);

    await setSetting(ctx.database.db, "advancedSettings", { audit: { rolling: { enabled: true, startHour: 1, windowHours: 4 } } });
    expect(await startScheduledRollingAudit(ctx.database.db, ctx.jobs, new Date(2026, 10, 11, 12, 0))).toBeNull();
    const jobId = await startScheduledRollingAudit(ctx.database.db, ctx.jobs, inWindow);
    expect(jobId).toEqual(expect.any(Number));
    expect(await ctx.jobs.getJob(jobId!)).toMatchObject({
      type: "audit",
      exclusive: false,
      progress: { options: { mode: "fast", targets: ["local"], byteCompare: false, rolling: { windowStart: new Date(2026, 10, 11, 1).toISOString(), windowEnd: new Date(2026, 10, 11, 5).toISOString() } } }
    });
    expect(await getJsonSetting(ctx.database.db, rollingAuditStateKey, null)).toEqual({ windowStart: new Date(2026, 10, 11, 1).toISOString(), jobId });
    // Queued or running: not queued again.
    expect(await startScheduledRollingAudit(ctx.database.db, ctx.jobs, new Date(2026, 10, 11, 2, 30))).toBeNull();
    // Finished at the window end: not queued again until the next window.
    await ctx.database.db.update(schema.jobs).set({ status: "completed" }).where(eq(schema.jobs.id, jobId!));
    expect(await startScheduledRollingAudit(ctx.database.db, ctx.jobs, new Date(2026, 10, 11, 3, 0))).toBeNull();
  });

  it("keeps a file's audit result across scans and clears it when the contents change", async () => {
    const { persistScanResult, scanLibrary } = await import("../src/server/lib/scanner");
    const filePath = path.join(paths.localDir, "movies", "Sample Film Scan", "sample-scan.mkv");
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, "scan content");
    const scan = () => scanLibrary(paths, { sections: ["movies"] }, new Map(), { scanSymlinks: false, scanLocal: true, scanRemote: false });
    await persistScanResult(ctx.database.db, await scan(), 1);
    const row = await first(ctx.database.db.select().from(schema.storageFiles).where(eq(schema.storageFiles.filePath, filePath)).limit(1));
    if (!row) throw new Error("Scan did not record the file");
    await ctx.database.db.update(schema.storageFiles).set({ auditCheckedAt: "2026-11-01T00:00:00.000Z", auditStatus: "fail", auditMode: "fast", auditMessage: "broken" }).where(eq(schema.storageFiles.id, row.id));

    await persistScanResult(ctx.database.db, await scan(), 2);
    expect(await storageFile(row.id)).toMatchObject({ auditStatus: "fail", auditMessage: "broken" });

    await fs.writeFile(filePath, "replaced with longer content");
    await persistScanResult(ctx.database.db, await scan(), 3);
    expect(await storageFile(row.id)).toMatchObject({ auditCheckedAt: null, auditStatus: null, auditMode: null, auditMessage: null });
  });
});

async function first_(jobId: number) {
  return first(ctx.database.db.select().from(schema.auditRuns).where(eq(schema.auditRuns.jobId, jobId)).limit(1));
}
