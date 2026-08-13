import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { count, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp, type AppContext } from "../src/server/app";
import type { JobConcurrencySettings } from "../src/server/config";
import { first, setSetting } from "../src/server/db/database";
import * as schema from "../src/server/db/schema";
import { copyAdmissionSelectionFingerprint, JobWorker } from "../src/server/jobs/jobRunner";
import { schedulerLockKey } from "../src/server/jobs/scheduling";
import type { AuditCommandRunner } from "../src/server/lib/auditor";
import type { CopyCommandRunner } from "../src/server/lib/copier";
import type { MediaLinkRow } from "../src/shared/types";
import { createTestDatabase, type TestDatabaseHandle } from "./testDb";

const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined
};

const twoJobConcurrency: JobConcurrencySettings = {
  workerCount: 2,
  maxRunningJobs: 2,
  maxRunningScans: 2,
  maxRunningAudits: 2,
  maxRunningCopies: 2,
  copyFileConcurrency: 1,
  maxActiveCopyFiles: 2
};

function admissionLink(id: number, overrides: Partial<MediaLinkRow> = {}): MediaLinkRow {
  const timestamp = "2026-08-02T00:00:00.000Z";
  return {
    id,
    section: "shows",
    itemName: `Admission Show ${id}`,
    relativePath: `Admission Show ${id}/Season 01/episode-${id}.mkv`,
    linkPath: `/symlinks/shows/Admission Show ${id}/Season 01/episode-${id}.mkv`,
    targetPath: `/remote/shows/Admission Show ${id}/Season 01/episode-${id}.mkv`,
    kind: "remote",
    targetExists: true,
    isMedia: true,
    storagePolicy: "location_1",
    resolvedStorageFileId: id,
    sizeBytes: id * 1_000,
    firstSeenAt: timestamp,
    lastSeenAt: timestamp,
    lastChangedAt: timestamp,
    missingSince: null,
    updatedAt: timestamp,
    ...overrides
  };
}

describe("copy admission selection fingerprint", () => {
  it("ignores database row order while preserving metadata change detection", () => {
    const first = admissionLink(11);
    const second = admissionLink(12);

    expect(copyAdmissionSelectionFingerprint([first, second])).toBe(copyAdmissionSelectionFingerprint([second, first]));
    expect(copyAdmissionSelectionFingerprint([first, second])).not.toBe(
      copyAdmissionSelectionFingerprint([first, { ...second, targetPath: `${second.targetPath}.changed` }])
    );
  });
});

let tmpDir: string;
let ctx: AppContext;
let testDatabase: TestDatabaseHandle;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(check: () => boolean | Promise<boolean>, message: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(5);
  }
  throw new Error(message);
}

async function withTimeout<T>(promise: Promise<T>, message: string, timeoutMs = 5_000): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
      })
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

const copyRunner: CopyCommandRunner = {
  async copyFile(sourcePath, tempPath, reportProgress) {
    const source = await fs.readFile(sourcePath);
    await reportProgress?.({ bytesCopied: 0, bytesProcessed: 0, totalBytes: source.length, bytesPerSecond: 0, remainingSeconds: null });
    await fs.writeFile(tempPath, source);
    await reportProgress?.({
      bytesCopied: source.length,
      bytesProcessed: source.length,
      totalBytes: source.length,
      bytesPerSecond: source.length,
      remainingSeconds: 0
    });
  },
  async runCmp(sourcePath, targetPath, reportProgress) {
    const [source, target] = await Promise.all([fs.readFile(sourcePath), fs.readFile(targetPath)]);
    await reportProgress?.({ bytesProcessed: source.length, totalBytes: source.length, bytesPerSecond: source.length, remainingSeconds: 0 });
    return { status: source.equals(target) ? "pass" : "fail", output: source.equals(target) ? "" : "test byte mismatch" };
  },
  async runFfmpeg(_mode, _targetPath, reportProgress) {
    await reportProgress?.({ bytesProcessed: 1, totalBytes: 1, bytesPerSecond: 1, remainingSeconds: 0 });
    return { status: "pass", output: "" };
  }
};

async function insertCopySymlink(itemName: string, content: string, relativePath?: string): Promise<number> {
  const timestamp = new Date().toISOString();
  const mediaRelativePath = relativePath ?? path.join(itemName, `${itemName.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.mkv`);
  const sourcePath = path.join(tmpDir, "remote", "movies", mediaRelativePath);
  const linkPath = path.join(tmpDir, "symlinks", "movies", mediaRelativePath);
  await Promise.all([fs.mkdir(path.dirname(sourcePath), { recursive: true }), fs.mkdir(path.dirname(linkPath), { recursive: true })]);
  await fs.writeFile(sourcePath, content);
  await fs.symlink(sourcePath, linkPath);
  const row = await first(
    ctx.database.db
      .insert(schema.mediaLinks)
      .values({
        section: "movies",
        itemName,
        relativePath: mediaRelativePath,
        linkPath,
        targetPath: sourcePath,
        kind: "remote",
        targetExists: true,
        isMedia: true,
        storagePolicy: "location_1",
        resolvedStorageFileId: null,
        sizeBytes: Buffer.byteLength(content),
        firstSeenAt: timestamp,
        lastSeenAt: timestamp,
        lastChangedAt: timestamp,
        missingSince: null,
        lastSeenJobId: 1,
        updatedAt: timestamp
      })
      .returning({ id: schema.mediaLinks.id })
  );
  if (!row) throw new Error("Copy fixture was not inserted");
  return row.id;
}

async function waitForTerminalJobs(jobIds: number[]): Promise<void> {
  await waitUntil(
    async () => {
      const jobs = await Promise.all(jobIds.map((jobId) => ctx.jobs.getJob(jobId)));
      return jobs.every((job) => job && ["completed", "partially_failed", "failed", "cancelled"].includes(job.status));
    },
    `Timed out waiting for jobs ${jobIds.join(", ")}`,
    10_000
  );
}

describe("job scheduler", () => {
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "srtl-job-scheduler-"));
    const paths = {
      symlinkDir: path.join(tmpDir, "symlinks"),
      localDir: path.join(tmpDir, "local"),
      remoteDir: path.join(tmpDir, "remote")
    };
    await Promise.all(Object.values(paths).map((directory) => fs.mkdir(directory, { recursive: true })));
    testDatabase = await createTestDatabase();
    ctx = await createApp({
      rootDir: tmpDir,
      dataDir: path.join(tmpDir, "data"),
      databaseUrl: testDatabase.databaseUrl,
      apiDocsEnabled: false,
      autoMigrate: true,
      paths,
      jobConcurrency: {
        workerCount: 1,
        maxRunningJobs: 1,
        maxRunningScans: 1,
        maxRunningAudits: 1,
        maxRunningCopies: 1,
        copyFileConcurrency: 1,
        maxActiveCopyFiles: 1
      }
    });
    const timestamp = new Date().toISOString();
    await setSetting(ctx.database.db, "sections", {
      sections: ["movies"],
      sectionTitles: {},
      sectionTypes: { movies: "movies" }
    });
    await ctx.database.db
      .insert(schema.sections)
      .values({ name: "movies", displayName: null, contentType: "movies", createdAt: timestamp, updatedAt: timestamp })
      .onConflictDoNothing();
  });

  afterEach(async () => {
    if (typeof ctx !== "undefined") await ctx.app.close();
    if (typeof testDatabase !== "undefined") await testDatabase.cleanup();
    if (typeof tmpDir !== "undefined") await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("dispatches four disjoint copy jobs concurrently from one worker loop and stops cleanly", async () => {
    const linkIds = await Promise.all([
      insertCopySymlink("Dispatcher Copy One", "dispatcher one"),
      insertCopySymlink("Dispatcher Copy Two", "dispatcher two"),
      insertCopySymlink("Dispatcher Copy Three", "dispatcher three"),
      insertCopySymlink("Dispatcher Copy Four", "dispatcher four")
    ]);
    const jobIds = await Promise.all(linkIds.map((linkId) => ctx.jobs.startCopy({ direction: "to_local", linkIds: [linkId] })));
    let activeTransfers = 0;
    let maximumActiveTransfers = 0;
    let startedTransfers = 0;
    let releaseTransfers: () => void = () => undefined;
    let markAllStarted: () => void = () => undefined;
    const transfersReleased = new Promise<void>((resolve) => {
      releaseTransfers = resolve;
    });
    const allStarted = new Promise<void>((resolve) => {
      markAllStarted = resolve;
    });
    const blockingCopyRunner: CopyCommandRunner = {
      ...copyRunner,
      async copyFile(sourcePath, tempPath, reportProgress, signal) {
        activeTransfers += 1;
        maximumActiveTransfers = Math.max(maximumActiveTransfers, activeTransfers);
        startedTransfers += 1;
        if (startedTransfers === 4) markAllStarted();
        try {
          await transfersReleased;
          if (signal?.aborted) throw (signal.reason instanceof Error ? signal.reason : new Error("Copy interrupted"));
          await copyRunner.copyFile(sourcePath, tempPath, reportProgress, signal);
        } finally {
          activeTransfers -= 1;
        }
      }
    };
    const worker = new JobWorker(ctx.database.db, {
      workerId: "single-dispatcher",
      dispatchConcurrency: 4,
      pollIntervalMs: 2,
      heartbeatIntervalMs: 20,
      logger: silentLogger,
      copyRunner: blockingCopyRunner,
      concurrency: {
        workerCount: 4,
        maxRunningJobs: 4,
        maxRunningScans: 4,
        maxRunningAudits: 4,
        maxRunningCopies: 4,
        copyFileConcurrency: 1,
        maxActiveCopyFiles: 4
      }
    });
    const workerRun = worker.start();

    try {
      await withTimeout(allStarted, "The dispatcher did not start four disjoint copies concurrently");
      await expect(Promise.all(jobIds.map((jobId) => ctx.jobs.getJob(jobId)))).resolves.toEqual(
        jobIds.map(() => expect.objectContaining({ status: "running", lockedBy: "single-dispatcher" }))
      );
      expect(maximumActiveTransfers).toBe(4);
      releaseTransfers();
      await waitForTerminalJobs(jobIds);
      await expect(Promise.all(jobIds.map((jobId) => ctx.jobs.getJob(jobId)))).resolves.toEqual(
        jobIds.map(() => expect.objectContaining({ status: "completed" }))
      );
      worker.stop();
      await withTimeout(workerRun, "The dispatcher did not stop cleanly");
    } finally {
      releaseTransfers();
      worker.stop();
      await Promise.allSettled([workerRun]);
    }
  });

  it("admits and claims four per-folder symlink scans concurrently", async () => {
    const sectionNames = ["movies", "shows", "movies4k", "shows4k"];
    const timestamp = new Date().toISOString();
    await setSetting(ctx.database.db, "sections", {
      sections: sectionNames,
      sectionTitles: {},
      sectionTypes: { movies: "movies", shows: "shows", movies4k: "movies", shows4k: "shows" }
    });
    await ctx.database.db
      .insert(schema.sections)
      .values(
        sectionNames.map((name) => ({
          name,
          displayName: null,
          contentType: name.includes("shows") ? ("shows" as const) : ("movies" as const),
          createdAt: timestamp,
          updatedAt: timestamp
        }))
      )
      .onConflictDoNothing();

    const jobIds = await ctx.jobs.startScanJobs(
      {
        scanSymlinks: true,
        scanLocal: false,
        scanRemote: false,
        symlinkSections: sectionNames,
        localSections: []
      },
      "per_folder"
    );
    expect(jobIds).toHaveLength(4);

    const worker = new JobWorker(ctx.database.db, {
      workerId: "parallel-folder-scan-worker",
      logger: silentLogger,
      concurrency: {
        workerCount: 4,
        maxRunningJobs: 4,
        maxRunningScans: 4,
        maxRunningAudits: 4,
        maxRunningCopies: 4,
        copyFileConcurrency: 1,
        maxActiveCopyFiles: 4
      }
    }) as unknown as { claimNextJob(): Promise<{ job: { id: number } } | null> };

    const claimed = [];
    for (let index = 0; index < jobIds.length; index += 1) claimed.push(await worker.claimNextJob());
    expect(claimed.map((entry) => entry?.job.id)).toEqual(jobIds);
    await expect(Promise.all(jobIds.map((jobId) => ctx.jobs.getJob(jobId)))).resolves.toEqual(
      jobIds.map(() => expect.objectContaining({ status: "running", exclusive: false, lockedBy: "parallel-folder-scan-worker" }))
    );
  });

  it("admits remote, symlink, and local scan scopes concurrently", async () => {
    const jobIds = await ctx.jobs.startScanJobs(
      {
        scanSymlinks: true,
        scanLocal: true,
        scanRemote: true,
        symlinkSections: ["movies"],
        localSections: ["movies"]
      },
      "per_folder"
    );
    expect(jobIds).toHaveLength(3);

    const worker = new JobWorker(ctx.database.db, {
      workerId: "parallel-mixed-scan-worker",
      logger: silentLogger,
      concurrency: {
        workerCount: 3,
        maxRunningJobs: 3,
        maxRunningScans: 3,
        maxRunningAudits: 3,
        maxRunningCopies: 3,
        copyFileConcurrency: 1,
        maxActiveCopyFiles: 3
      }
    }) as unknown as { claimNextJob(): Promise<{ job: { id: number } } | null> };

    const claimed = await Promise.all([worker.claimNextJob(), worker.claimNextJob(), worker.claimNextJob()]);
    expect(claimed.map((entry) => entry?.job.id).sort((left, right) => Number(left) - Number(right))).toEqual(jobIds);
    await expect(Promise.all(jobIds.map((jobId) => ctx.jobs.getJob(jobId)))).resolves.toEqual(
      jobIds.map(() => expect.objectContaining({ status: "running", exclusive: false, lockedBy: "parallel-mixed-scan-worker" }))
    );
  });

  it("blocks a copy from entering storage scopes held by queued scans", async () => {
    const linkId = await insertCopySymlink("Scan Claim Copy", "scan claim copy");
    const scanJobIds = await ctx.jobs.startScanJobs(
      {
        scanSymlinks: false,
        scanLocal: true,
        scanRemote: true,
        symlinkSections: [],
        localSections: ["movies"]
      },
      "per_folder"
    );
    expect(scanJobIds).toHaveLength(2);

    await expect(ctx.jobs.startCopy({ direction: "to_local", linkIds: [linkId] })).rejects.toThrow("already queued");
  });

  it("rejects copy destinations that are distinct lexically but share a physical directory", async () => {
    const firstLinkId = await insertCopySymlink("Physical Alias One", "first alias", path.join("Physical Alias One", "shared.mkv"));
    const secondLinkId = await insertCopySymlink("Physical Alias Two", "second alias", path.join("Physical Alias Two", "shared.mkv"));
    const physicalDirectory = path.join(tmpDir, "local", "movies", "Physical Alias One");
    const aliasDirectory = path.join(tmpDir, "local", "movies", "Physical Alias Two");
    await fs.mkdir(physicalDirectory, { recursive: true });
    await fs.symlink(physicalDirectory, aliasDirectory, "dir");

    await expect(ctx.jobs.startCopy({ direction: "to_local", linkIds: [firstLinkId] })).resolves.toEqual(expect.any(Number));
    await expect(ctx.jobs.startCopy({ direction: "to_local", linkIds: [secondLinkId] })).rejects.toThrow("already queued");
  });

  it("rejects physical destination aliases selected within one copy job", async () => {
    const firstLinkId = await insertCopySymlink("Same Job Alias One", "first alias", path.join("Same Job Alias One", "shared.mkv"));
    const secondLinkId = await insertCopySymlink("Same Job Alias Two", "second alias", path.join("Same Job Alias Two", "shared.mkv"));
    const physicalDirectory = path.join(tmpDir, "local", "movies", "Same Job Alias One");
    const aliasDirectory = path.join(tmpDir, "local", "movies", "Same Job Alias Two");
    await fs.mkdir(physicalDirectory, { recursive: true });
    await fs.symlink(physicalDirectory, aliasDirectory, "dir");

    await expect(ctx.jobs.startCopy({ direction: "to_local", linkIds: [firstLinkId, secondLinkId] })).rejects.toThrow(
      "resolve to the same copy destination"
    );
    expect(await ctx.database.db.select({ id: schema.jobs.id }).from(schema.jobs).where(eq(schema.jobs.type, "copy"))).toEqual([]);
  });

  it("fails closed when a claimed destination ancestor is retargeted after admission", async () => {
    const linkId = await insertCopySymlink("Retargeted Alias", "retargeted alias source");
    const fileName = "retargeted-alias.mkv";
    const aliasDirectory = path.join(tmpDir, "local", "movies", "Retargeted Alias");
    const admittedPhysicalDirectory = path.join(tmpDir, "local", "admitted-physical-directory");
    const unclaimedPhysicalDirectory = path.join(tmpDir, "local", "unclaimed-physical-directory");
    await Promise.all([
      fs.mkdir(path.dirname(aliasDirectory), { recursive: true }),
      fs.mkdir(admittedPhysicalDirectory, { recursive: true }),
      fs.mkdir(unclaimedPhysicalDirectory, { recursive: true })
    ]);
    await fs.symlink(admittedPhysicalDirectory, aliasDirectory, "dir");
    const jobId = await ctx.jobs.startCopy({ direction: "to_local", linkIds: [linkId] });

    await fs.unlink(aliasDirectory);
    await fs.symlink(unclaimedPhysicalDirectory, aliasDirectory, "dir");
    let transferAttempts = 0;
    const observingCopyRunner: CopyCommandRunner = {
      ...copyRunner,
      async copyFile(sourcePath, tempPath, reportProgress, signal) {
        transferAttempts += 1;
        await copyRunner.copyFile(sourcePath, tempPath, reportProgress, signal);
      }
    };
    const worker = new JobWorker(ctx.database.db, {
      workerId: "retargeted-alias-worker",
      logger: silentLogger,
      copyRunner: observingCopyRunner
    });

    await expect(worker.runOnce()).resolves.toBe(true);
    expect(await ctx.jobs.getJob(jobId)).toMatchObject({
      status: "completed",
      progress: expect.objectContaining({ copied: 0, conflicts: 1, failed: 0, stage: "completed" })
    });
    expect(transferAttempts).toBe(0);
    await expect(fs.stat(path.join(admittedPhysicalDirectory, fileName))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(path.join(unclaimedPhysicalDirectory, fileName))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.readlink(path.join(tmpDir, "symlinks", "movies", "Retargeted Alias", fileName))).resolves.toBe(
      path.join(tmpDir, "remote", "movies", "Retargeted Alias", fileName)
    );
  });

  it("does not accept another selected link's canonical destination binding", async () => {
    const firstLinkId = await insertCopySymlink("Binding Alias One", "first binding", path.join("Binding Alias One", "shared.mkv"));
    const secondLinkId = await insertCopySymlink("Binding Alias Two", "second binding", path.join("Binding Alias Two", "shared.mkv"));
    const firstAliasDirectory = path.join(tmpDir, "local", "movies", "Binding Alias One");
    const firstPhysicalDirectory = path.join(tmpDir, "local", "binding-alias-one-physical");
    const secondPhysicalDirectory = path.join(tmpDir, "local", "movies", "Binding Alias Two");
    await Promise.all([
      fs.mkdir(path.dirname(firstAliasDirectory), { recursive: true }),
      fs.mkdir(firstPhysicalDirectory, { recursive: true }),
      fs.mkdir(secondPhysicalDirectory, { recursive: true })
    ]);
    await fs.symlink(firstPhysicalDirectory, firstAliasDirectory, "dir");
    const jobId = await ctx.jobs.startCopy({ direction: "to_local", linkIds: [firstLinkId, secondLinkId] });

    await fs.unlink(firstAliasDirectory);
    await fs.symlink(secondPhysicalDirectory, firstAliasDirectory, "dir");
    const worker = new JobWorker(ctx.database.db, {
      workerId: "binding-alias-worker",
      logger: silentLogger,
      copyRunner
    });

    await expect(worker.runOnce()).resolves.toBe(true);
    expect(await ctx.jobs.getJob(jobId)).toMatchObject({
      status: "completed",
      progress: expect.objectContaining({ copied: 1, conflicts: 1, failed: 0, stage: "completed" })
    });
    await expect(fs.stat(path.join(firstPhysicalDirectory, "shared.mkv"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.readFile(path.join(secondPhysicalDirectory, "shared.mkv"), "utf8")).resolves.toBe("second binding");
  });

  it("rechecks canonical destination bindings inside the copy mutation lease", async () => {
    const linkId = await insertCopySymlink("Mutation Retarget", "mutation retarget source");
    const fileName = "mutation-retarget.mkv";
    const aliasDirectory = path.join(tmpDir, "local", "movies", "Mutation Retarget");
    const admittedPhysicalDirectory = path.join(tmpDir, "local", "mutation-admitted-physical");
    const unclaimedPhysicalDirectory = path.join(tmpDir, "local", "mutation-unclaimed-physical");
    await Promise.all([
      fs.mkdir(path.dirname(aliasDirectory), { recursive: true }),
      fs.mkdir(admittedPhysicalDirectory, { recursive: true }),
      fs.mkdir(unclaimedPhysicalDirectory, { recursive: true })
    ]);
    await fs.symlink(admittedPhysicalDirectory, aliasDirectory, "dir");
    const jobId = await ctx.jobs.startCopy({ direction: "to_local", linkIds: [linkId] });
    let releaseTransfer: () => void = () => undefined;
    let markTransferStarted: () => void = () => undefined;
    const transferGate = new Promise<void>((resolve) => {
      releaseTransfer = resolve;
    });
    const transferStarted = new Promise<void>((resolve) => {
      markTransferStarted = resolve;
    });
    const blockingCopyRunner: CopyCommandRunner = {
      ...copyRunner,
      async copyFile(sourcePath, tempPath, reportProgress, signal) {
        markTransferStarted();
        await transferGate;
        await copyRunner.copyFile(sourcePath, tempPath, reportProgress, signal);
      }
    };
    const worker = new JobWorker(ctx.database.db, {
      workerId: "mutation-retarget-worker",
      logger: silentLogger,
      copyRunner: blockingCopyRunner
    });
    const run = worker.runOnce();

    await withTimeout(transferStarted, "The mutation-retarget copy did not start");
    try {
      await fs.unlink(aliasDirectory);
      await fs.symlink(unclaimedPhysicalDirectory, aliasDirectory, "dir");
    } finally {
      releaseTransfer();
    }
    await expect(run).resolves.toBe(true);

    expect(await ctx.jobs.getJob(jobId)).toMatchObject({
      status: "failed",
      progress: expect.objectContaining({ copied: 0, repointed: 0, conflicts: 0, failed: 1, stage: "failed" })
    });
    await expect(ctx.database.db.select().from(schema.copyOperations).where(eq(schema.copyOperations.jobId, jobId))).resolves.toEqual([
      expect.objectContaining({
        stage: "failed",
        resultStatus: null,
        errorMessage: "Media paths changed after copy admission; queue the copy again"
      })
    ]);
    await expect(fs.readdir(admittedPhysicalDirectory)).resolves.toEqual([]);
    await expect(fs.readdir(unclaimedPhysicalDirectory)).resolves.toEqual([]);
    await expect(fs.readlink(path.join(tmpDir, "symlinks", "movies", "Mutation Retarget", fileName))).resolves.toBe(
      path.join(tmpDir, "remote", "movies", "Mutation Retarget", fileName)
    );
  });

  it("does not reclaim or path-requeue an active same-worker handler while another slot remains available", async () => {
    const firstLinkId = await insertCopySymlink("Active Lease One", "first active lease");
    const secondLinkId = await insertCopySymlink("Active Lease Two", "second active lease");
    let releaseTransfers: () => void = () => undefined;
    const transferGate = new Promise<void>((resolve) => {
      releaseTransfers = resolve;
    });
    const startedSources: string[] = [];
    const blockingCopyRunner: CopyCommandRunner = {
      ...copyRunner,
      async copyFile(sourcePath, tempPath) {
        startedSources.push(sourcePath);
        await transferGate;
        await fs.copyFile(sourcePath, tempPath);
      }
    };
    const firstJobId = await ctx.jobs.startCopy({ direction: "to_local", linkIds: [firstLinkId] });
    const worker = new JobWorker(ctx.database.db, {
      workerId: "active-same-worker",
      pollIntervalMs: 2,
      heartbeatIntervalMs: 60_000,
      reclaimOwnInterruptedAfterMs: 20,
      dispatchConcurrency: 2,
      logger: silentLogger,
      copyRunner: blockingCopyRunner,
      concurrency: twoJobConcurrency
    });
    const workerRun = worker.start();

    try {
      await waitUntil(() => startedSources.length === 1, "The first copy handler did not start");
      const staleTimestamp = new Date(Date.now() - 60_000).toISOString();
      await ctx.database.db.update(schema.jobs).set({ heartbeatAt: staleTimestamp }).where(eq(schema.jobs.id, firstJobId));
      const probe = worker as unknown as { requeueInterruptedJobsForPathMigration(): Promise<void> };
      await probe.requeueInterruptedJobsForPathMigration();
      await delay(40);

      expect(await ctx.jobs.getJob(firstJobId)).toMatchObject({ status: "running", lockedBy: "active-same-worker", leaseVersion: 1 });
      expect(startedSources).toHaveLength(1);

      const secondJobId = await ctx.jobs.startCopy({ direction: "to_local", linkIds: [secondLinkId] });
      await waitUntil(() => startedSources.length === 2, "The second available dispatcher slot was not used");
      expect(new Set(startedSources).size).toBe(2);
      releaseTransfers();
      await waitForTerminalJobs([firstJobId, secondJobId]);
      await expect(Promise.all([ctx.jobs.getJob(firstJobId), ctx.jobs.getJob(secondJobId)])).resolves.toEqual([
        expect.objectContaining({ status: "completed", leaseVersion: 1 }),
        expect.objectContaining({ status: "completed", leaseVersion: 1 })
      ]);
    } finally {
      releaseTransfers();
      worker.stop();
      await Promise.allSettled([workerRun]);
    }
  });

  it("requeues a job claimed after stop was requested while the scheduler lock was held", async () => {
    const linkId = await insertCopySymlink("Stop During Claim", "stop during claim");
    const jobId = await ctx.jobs.startAudit({ mode: "fast", linkIds: [linkId], byteCompare: false });
    let auditCalls = 0;
    const auditRunner: AuditCommandRunner = {
      async runFfmpeg() {
        auditCalls += 1;
        return { status: "pass", output: "" };
      },
      async runCmp() {
        auditCalls += 1;
        return { status: "pass", output: "" };
      }
    };
    const lockClient = await ctx.database.pool.connect();
    let lockHeld = false;
    const worker = new JobWorker(ctx.database.db, {
      workerId: "stopping-dispatcher",
      pollIntervalMs: 2,
      heartbeatIntervalMs: 20,
      logger: silentLogger,
      auditRunner
    });
    let workerRun: Promise<void> | null = null;

    try {
      await lockClient.query("SELECT pg_advisory_lock($1)", [schedulerLockKey]);
      lockHeld = true;
      workerRun = worker.start();
      await waitUntil(async () => {
        const result = await ctx.database.pool.query<{ count: number }>(`
          SELECT count(*)::integer AS count
          FROM pg_locks
          WHERE locktype = 'advisory'
            AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
            AND classid = 0
            AND objid = $1
            AND NOT granted
        `, [schedulerLockKey]);
        return (result.rows[0]?.count ?? 0) > 0;
      }, "The worker did not wait for the scheduler lock");

      worker.stop();
      await lockClient.query("SELECT pg_advisory_unlock($1)", [schedulerLockKey]);
      lockHeld = false;
      await withTimeout(workerRun, "The stopped dispatcher did not settle after its blocked claim resumed");
    } finally {
      worker.stop();
      if (lockHeld) await lockClient.query("SELECT pg_advisory_unlock($1)", [schedulerLockKey]);
      lockClient.release();
      if (workerRun) await Promise.allSettled([workerRun]);
    }

    expect(auditCalls).toBe(0);
    expect(await ctx.jobs.getJob(jobId)).toMatchObject({ status: "queued", lockedBy: null, heartbeatAt: null, leaseVersion: 1 });
    expect(await ctx.database.db.select().from(schema.auditRuns).where(eq(schema.auditRuns.jobId, jobId))).toHaveLength(0);
    expect((await ctx.jobs.listEvents(jobId)).map((event) => event.message)).not.toContain("Worker started job");
  });

  it("rejects copy admission when the selected media changes while waiting for the scheduler lock", async () => {
    const linkId = await insertCopySymlink("Changed Admission Copy", "initial admission snapshot");
    const lockClient = await ctx.database.pool.connect();
    let lockHeld = false;
    let admission: Promise<number> | null = null;

    try {
      await lockClient.query("SELECT pg_advisory_lock($1)", [schedulerLockKey]);
      lockHeld = true;
      admission = ctx.jobs.startCopy({ direction: "to_local", linkIds: [linkId] });
      void admission.catch(() => undefined);

      await waitUntil(async () => {
        const result = await ctx.database.pool.query<{ count: number }>(`
          SELECT count(*)::integer AS count
          FROM pg_locks
          WHERE locktype = 'advisory'
            AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
            AND classid = 0
            AND objid = $1
            AND NOT granted
        `, [schedulerLockKey]);
        return (result.rows[0]?.count ?? 0) > 0;
      }, "Copy admission did not wait for the scheduler lock after taking its initial snapshot");

      await ctx.database.db
        .update(schema.mediaLinks)
        .set({ storagePolicy: "location_2", updatedAt: new Date().toISOString() })
        .where(eq(schema.mediaLinks.id, linkId));

      await lockClient.query("SELECT pg_advisory_unlock($1)", [schedulerLockKey]);
      lockHeld = false;
      await expect(withTimeout(admission, "Copy admission did not settle after the scheduler lock was released")).rejects.toThrow(
        "Copy selection changed while the job was being prepared. Review the current inventory and queue it again."
      );
    } finally {
      if (lockHeld) await lockClient.query("SELECT pg_advisory_unlock($1)", [schedulerLockKey]);
      lockClient.release();
      if (admission) await Promise.allSettled([admission]);
    }

    expect(await ctx.database.db.select({ id: schema.jobs.id }).from(schema.jobs).where(eq(schema.jobs.type, "copy"))).toEqual([]);
    expect(await ctx.database.db.select({ jobId: schema.jobResourceClaims.jobId }).from(schema.jobResourceClaims)).toEqual([]);
  });

  it("leaves root-scoped scans and exclusive audits queued when their per-type limits are zero", async () => {
    const scanJobId = await ctx.jobs.startScan({
      scanSymlinks: false,
      scanLocal: false,
      scanRemote: true,
      symlinkSections: [],
      localSections: []
    });
    const auditJobId = await ctx.jobs.startAudit("fast");
    const worker = new JobWorker(ctx.database.db, {
      workerId: "paused-types-worker",
      logger: silentLogger,
      concurrency: {
        workerCount: 2,
        maxRunningJobs: 2,
        maxRunningScans: 0,
        maxRunningAudits: 0,
        maxRunningCopies: 2,
        copyFileConcurrency: 1,
        maxActiveCopyFiles: 2
      }
    });

    expect(await worker.runOnce()).toBe(false);
    await expect(Promise.all([ctx.jobs.getJob(scanJobId), ctx.jobs.getJob(auditJobId)])).resolves.toEqual([
      expect.objectContaining({ status: "queued", exclusive: false, startedAt: null, leaseVersion: 0 }),
      expect.objectContaining({ status: "queued", exclusive: true, startedAt: null, leaseVersion: 0 })
    ]);
  });

  it("fences a reclaimable paused job before admitting exclusive work", async () => {
    const oldTimestamp = new Date(Date.now() - 60_000).toISOString();
    await ctx.database.db.insert(schema.workerHeartbeats).values({
      workerId: "paused-stale-owner",
      startedAt: oldTimestamp,
      heartbeatAt: oldTimestamp,
      status: "stopped",
      capacity: 1
    });
    const staleJob = await first(
      ctx.database.db
        .insert(schema.jobs)
        .values({
          type: "copy",
          status: "running",
          createdAt: oldTimestamp,
          startedAt: oldTimestamp,
          finishedAt: null,
          lockedBy: "paused-stale-owner",
          lockedAt: oldTimestamp,
          heartbeatAt: oldTimestamp,
          leaseVersion: 4,
          exclusive: false,
          cancelRequestedAt: null,
          progress: "{}"
        })
        .returning({ id: schema.jobs.id })
    );
    if (!staleJob) throw new Error("Paused stale job was not inserted");
    const auditJobId = await ctx.jobs.startAudit("fast");
    const worker = new JobWorker(ctx.database.db, {
      workerId: "paused-stale-reclaimer",
      reclaimOwnInterruptedAfterMs: 1_000,
      logger: silentLogger,
      concurrency: {
        ...twoJobConcurrency,
        maxRunningCopies: 0
      }
    }) as unknown as { claimNextJob(): Promise<unknown | null> };

    await expect(worker.claimNextJob()).resolves.toMatchObject({ job: { id: auditJobId, status: "running", lockedBy: "paused-stale-reclaimer" } });
    expect(await ctx.jobs.getJob(staleJob.id)).toMatchObject({ status: "queued", lockedBy: null, leaseVersion: 5 });
    expect(await ctx.jobs.getJob(auditJobId)).toMatchObject({ status: "running", lockedBy: "paused-stale-reclaimer", leaseVersion: 1 });
  });

  it("keeps a fenced stale overlap queued behind an unfenced locked row", async () => {
    const oldTimestamp = new Date(Date.now() - 60_000).toISOString();
    await ctx.database.db.insert(schema.workerHeartbeats).values(
      ["locked-stale-owner", "overlapping-stale-owner"].map((workerId) => ({
        workerId,
        startedAt: oldTimestamp,
        heartbeatAt: oldTimestamp,
        status: "stopped",
        capacity: 1
      }))
    );
    const staleJobs = await ctx.database.db
      .insert(schema.jobs)
      .values(
        ["locked-stale-owner", "overlapping-stale-owner"].map((lockedBy) => ({
          type: "copy",
          status: "running",
          createdAt: oldTimestamp,
          startedAt: oldTimestamp,
          finishedAt: null,
          lockedBy,
          lockedAt: oldTimestamp,
          heartbeatAt: oldTimestamp,
          leaseVersion: 6,
          exclusive: false,
          cancelRequestedAt: null,
          progress: "{}"
        }))
      )
      .returning({ id: schema.jobs.id });
    expect(staleJobs).toHaveLength(2);
    await ctx.database.db.insert(schema.jobResourceClaims).values(
      staleJobs.map((job) => ({
        jobId: job.id,
        resourceType: "media",
        resourceKey: "shared-stale-media",
        access: "exclusive",
        createdAt: oldTimestamp
      }))
    );
    const lockClient = await ctx.database.pool.connect();
    const worker = new JobWorker(ctx.database.db, {
      workerId: "skip-locked-reclaimer",
      reclaimOwnInterruptedAfterMs: 1_000,
      logger: silentLogger,
      concurrency: twoJobConcurrency
    }) as unknown as { claimNextJob(): Promise<unknown | null> };

    try {
      await lockClient.query("BEGIN");
      await lockClient.query("SELECT id FROM jobs WHERE id = $1 FOR UPDATE", [staleJobs[0]!.id]);
      await expect(worker.claimNextJob()).resolves.toBeNull();
    } finally {
      await lockClient.query("ROLLBACK");
      lockClient.release();
    }

    await expect(Promise.all(staleJobs.map((job) => ctx.jobs.getJob(job.id)))).resolves.toEqual([
      expect.objectContaining({ status: "running", lockedBy: "locked-stale-owner", leaseVersion: 6 }),
      expect.objectContaining({ status: "queued", lockedBy: null, leaseVersion: 7 })
    ]);
  });

  it("does not reclaim a fresh job lease solely because its process heartbeat is stale", async () => {
    const oldTimestamp = new Date(Date.now() - 60_000).toISOString();
    const freshTimestamp = new Date().toISOString();
    await ctx.database.db.insert(schema.workerHeartbeats).values({
      workerId: "stale-process-live-job",
      startedAt: oldTimestamp,
      heartbeatAt: oldTimestamp,
      status: "running",
      capacity: 1
    });
    const liveJob = await first(
      ctx.database.db
        .insert(schema.jobs)
        .values({
          type: "copy",
          status: "running",
          createdAt: oldTimestamp,
          startedAt: oldTimestamp,
          finishedAt: null,
          lockedBy: "stale-process-live-job",
          lockedAt: oldTimestamp,
          heartbeatAt: freshTimestamp,
          leaseVersion: 2,
          exclusive: false,
          cancelRequestedAt: null,
          progress: "{}"
        })
        .returning({ id: schema.jobs.id })
    );
    if (!liveJob) throw new Error("Fresh live job was not inserted");
    const auditJobId = await ctx.jobs.startAudit("fast");
    const worker = new JobWorker(ctx.database.db, {
      workerId: "stale-process-contender",
      reclaimOwnInterruptedAfterMs: 1_000,
      logger: silentLogger,
      concurrency: twoJobConcurrency
    }) as unknown as { claimNextJob(): Promise<unknown | null> };

    await expect(worker.claimNextJob()).resolves.toBeNull();
    expect(await ctx.jobs.getJob(liveJob.id)).toMatchObject({ status: "running", lockedBy: "stale-process-live-job", leaseVersion: 2 });
    expect(await ctx.jobs.getJob(auditJobId)).toMatchObject({ status: "queued", startedAt: null, lockedBy: null });
  });

  it("does not path-requeue a stale job lease while its owning process heartbeat is fresh", async () => {
    const oldTimestamp = new Date(Date.now() - 60_000).toISOString();
    const freshTimestamp = new Date().toISOString();
    await ctx.database.db.insert(schema.workerHeartbeats).values({
      workerId: "live-path-owner",
      startedAt: oldTimestamp,
      heartbeatAt: freshTimestamp,
      status: "running",
      capacity: 1
    });
    const liveJob = await first(
      ctx.database.db
        .insert(schema.jobs)
        .values({
          type: "audit",
          status: "running",
          createdAt: oldTimestamp,
          startedAt: oldTimestamp,
          finishedAt: null,
          lockedBy: "live-path-owner",
          lockedAt: oldTimestamp,
          heartbeatAt: oldTimestamp,
          leaseVersion: 5,
          exclusive: false,
          cancelRequestedAt: null,
          progress: "{}"
        })
        .returning({ id: schema.jobs.id })
    );
    if (!liveJob) throw new Error("Live path-owner job was not inserted");
    const worker = new JobWorker(ctx.database.db, {
      workerId: "path-requeue-contender",
      reclaimOwnInterruptedAfterMs: 1_000,
      logger: silentLogger,
      concurrency: twoJobConcurrency
    }) as unknown as { requeueInterruptedJobsForPathMigration(): Promise<void> };

    await worker.requeueInterruptedJobsForPathMigration();
    expect(await ctx.jobs.getJob(liveJob.id)).toMatchObject({ status: "running", lockedBy: "live-path-owner", leaseVersion: 5 });
  });

  it("applies global and per-type caps while quickly reclaiming jobs from known stopped or stale owners", async () => {
    const oldTimestamp = new Date(Date.now() - 60_000).toISOString();
    const currentTimestamp = new Date().toISOString();
    await ctx.database.db.insert(schema.workerHeartbeats).values([
      { workerId: "stopped-owner-one", startedAt: oldTimestamp, heartbeatAt: currentTimestamp, status: "stopped", capacity: 1 },
      { workerId: "stale-owner", startedAt: oldTimestamp, heartbeatAt: oldTimestamp, status: "running", capacity: 1 },
      { workerId: "stopped-owner-two", startedAt: oldTimestamp, heartbeatAt: currentTimestamp, status: "stopped", capacity: 1 }
    ]);
    const jobs = await ctx.database.db
      .insert(schema.jobs)
      .values(["stopped-owner-one", "stale-owner", "stopped-owner-two"].map((lockedBy) => ({
        type: "copy",
        status: "running",
        createdAt: oldTimestamp,
        startedAt: oldTimestamp,
        finishedAt: null,
        lockedBy,
        lockedAt: oldTimestamp,
        heartbeatAt: oldTimestamp,
        leaseVersion: 3,
        exclusive: false,
        cancelRequestedAt: null,
        progress: "{}"
      })))
      .returning({ id: schema.jobs.id });
    expect(jobs).toHaveLength(3);

    type ClaimProbe = {
      claimNextJob(): Promise<{ job: { id: number; leaseVersion: number; lockedBy: string | null } } | null>;
    };
    const globalWorker = new JobWorker(ctx.database.db, {
      workerId: "global-reclaimer",
      reclaimStaleAfterMs: 60 * 60_000,
      reclaimOwnInterruptedAfterMs: 1_000,
      logger: silentLogger,
      concurrency: {
        ...twoJobConcurrency,
        maxRunningJobs: 1,
        maxRunningCopies: 2
      }
    }) as unknown as ClaimProbe;

    await expect(globalWorker.claimNextJob()).resolves.toMatchObject({ job: { id: jobs[0]!.id, leaseVersion: 5, lockedBy: "global-reclaimer" } });
    await expect(globalWorker.claimNextJob()).resolves.toBeNull();
    expect(await ctx.jobs.getJob(jobs[1]!.id)).toMatchObject({ status: "queued", lockedBy: null, leaseVersion: 4 });
    expect(await ctx.jobs.getJob(jobs[2]!.id)).toMatchObject({ status: "queued", lockedBy: null, leaseVersion: 4 });

    await ctx.database.db
      .update(schema.jobs)
      .set({ status: "completed", finishedAt: currentTimestamp, lockedBy: null, lockedAt: null, heartbeatAt: null })
      .where(eq(schema.jobs.id, jobs[0]!.id));
    await expect(globalWorker.claimNextJob()).resolves.toMatchObject({ job: { id: jobs[1]!.id, leaseVersion: 5, lockedBy: "global-reclaimer" } });

    const typeWorker = new JobWorker(ctx.database.db, {
      workerId: "type-reclaimer",
      reclaimStaleAfterMs: 60 * 60_000,
      reclaimOwnInterruptedAfterMs: 1_000,
      logger: silentLogger,
      concurrency: {
        ...twoJobConcurrency,
        maxRunningJobs: 2,
        maxRunningCopies: 1
      }
    }) as unknown as ClaimProbe;
    await expect(typeWorker.claimNextJob()).resolves.toBeNull();
    expect(await ctx.jobs.getJob(jobs[2]!.id)).toMatchObject({ status: "queued", lockedBy: null, leaseVersion: 4 });

    await ctx.database.db
      .update(schema.jobs)
      .set({ status: "completed", finishedAt: currentTimestamp, lockedBy: null, lockedAt: null, heartbeatAt: null })
      .where(eq(schema.jobs.id, jobs[1]!.id));
    await expect(typeWorker.claimNextJob()).resolves.toMatchObject({ job: { id: jobs[2]!.id, leaseVersion: 5, lockedBy: "type-reclaimer" } });
    await ctx.database.db
      .update(schema.jobs)
      .set({ status: "completed", finishedAt: currentTimestamp, lockedBy: null, lockedAt: null, heartbeatAt: null })
      .where(eq(schema.jobs.id, jobs[2]!.id));
    const unknownOwnerJob = await first(
      ctx.database.db
        .insert(schema.jobs)
        .values({
          type: "copy",
          status: "running",
          createdAt: oldTimestamp,
          startedAt: oldTimestamp,
          finishedAt: null,
          lockedBy: "unknown-owner",
          lockedAt: oldTimestamp,
          heartbeatAt: oldTimestamp,
          leaseVersion: 3,
          exclusive: false,
          cancelRequestedAt: null,
          progress: "{}"
        })
        .returning({ id: schema.jobs.id })
    );
    if (!unknownOwnerJob) throw new Error("Unknown-owner job was not inserted");
    await expect(globalWorker.claimNextJob()).resolves.toBeNull();
    expect(await ctx.jobs.getJob(unknownOwnerJob.id)).toMatchObject({ status: "running", lockedBy: "unknown-owner", leaseVersion: 3 });
  });

  it("queues claims for more than 3300 scoped audit links without exceeding PostgreSQL bind limits", async () => {
    const linkCount = 3_301;
    const timestamp = new Date().toISOString();
    const linkIds: number[] = [];
    for (let offset = 0; offset < linkCount; offset += 250) {
      const values = Array.from({ length: Math.min(250, linkCount - offset) }, (_unused, index) => {
        const id = offset + index;
        const itemName = `Large Audit ${id}`;
        const relativePath = path.join(itemName, `large-audit-${id}.mkv`);
        return {
          section: "movies",
          itemName,
          relativePath,
          linkPath: path.join(tmpDir, "symlinks", "movies", relativePath),
          targetPath: path.join(tmpDir, "remote", "movies", relativePath),
          kind: "remote",
          targetExists: true,
          isMedia: true,
          storagePolicy: "unassigned",
          resolvedStorageFileId: null,
          sizeBytes: 1,
          firstSeenAt: timestamp,
          lastSeenAt: timestamp,
          lastChangedAt: timestamp,
          missingSince: null,
          lastSeenJobId: 1,
          updatedAt: timestamp
        };
      });
      const inserted = await ctx.database.db.insert(schema.mediaLinks).values(values).returning({ id: schema.mediaLinks.id });
      linkIds.push(...inserted.map((row) => row.id));
    }

    expect(linkIds).toHaveLength(linkCount);
    const jobId = await ctx.jobs.startAudit({ mode: "fast", linkIds, byteCompare: false });
    expect(await ctx.jobs.getJob(jobId)).toMatchObject({ status: "queued", exclusive: false });
    const claimCount = await first(
      ctx.database.db
        .select({ value: count() })
        .from(schema.jobResourceClaims)
        .where(eq(schema.jobResourceClaims.jobId, jobId))
    );
    expect(Number(claimCount?.value ?? 0)).toBeGreaterThanOrEqual(linkCount * 4 + 1);
    expect(Number(claimCount?.value ?? 0)).toBeLessThanOrEqual(linkCount * 6 + 2);
  }, 60_000);
});
