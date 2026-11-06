import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { createApp, type AppContext } from "../src/server/app";
import { first, setSetting } from "../src/server/db/database";
import * as schema from "../src/server/db/schema";
import { JobWorker } from "../src/server/jobs/jobRunner";
import type { CopyCommandRunner } from "../src/server/lib/copier";
import { markOnboardingCompleteForExistingInstall } from "../src/server/lib/onboarding";
import { reconcileEnvironmentPaths } from "../src/server/lib/pathConfiguration";
import type { CopyOptions, CopyRetryPlan, CopyRetryStarted, StoragePolicyKind } from "../src/shared/types";
import { readSetupToken } from "./authHelpers";
import { createTestDatabase, type TestDatabaseHandle } from "./testDb";

let root: string;
let ctx: AppContext;
let testDatabase: TestDatabaseHandle;
let owner: string;
let moderator: string;
let addressCounter = 0;

const temporaryPassword = "temporary-password-1234";
const silentLogger = { info: () => undefined, warn: () => undefined, error: () => undefined };

function cookieFrom(headers: Record<string, unknown>): string {
  return String(headers["set-cookie"]).split(";")[0]!;
}

async function createModerator(): Promise<string> {
  const created = await ctx.app.inject({ method: "POST", url: "/api/accounts", headers: { cookie: owner }, payload: { username: "a-moderator", role: "moderator", temporaryPassword } });
  expect(created.statusCode).toBe(201);
  addressCounter += 1;
  const login = await ctx.app.inject({ method: "POST", url: "/api/auth/login", remoteAddress: `10.20.0.${addressCounter}`, payload: { username: "a-moderator", password: temporaryPassword } });
  expect(login.statusCode).toBe(200);
  const newPassword = "moderator-final-password";
  const change = await ctx.app.inject({
    method: "PUT",
    url: "/api/auth/user",
    headers: { cookie: cookieFrom(login.headers) },
    payload: { username: "a-moderator", currentPassword: temporaryPassword, newPassword, confirmNewPassword: newPassword }
  });
  expect(change.statusCode).toBe(200);
  return cookieFrom(change.headers);
}

/** Copies normally, except that a source whose path holds `failing` throws. */
function copyRunner(...failing: string[]): CopyCommandRunner {
  return {
    async copyFile(sourcePath, tempPath) {
      if (failing.some((name) => sourcePath.includes(name))) throw new Error("simulated transfer failure");
      await fs.copyFile(sourcePath, tempPath);
    },
    async runCmp(sourcePath, targetPath) {
      const [source, target] = await Promise.all([fs.readFile(sourcePath), fs.readFile(targetPath)]);
      return { status: source.equals(target) ? "pass" : "fail", output: "" };
    },
    async runFfmpeg() {
      return { status: "pass", output: "" };
    }
  };
}

async function runJob(jobId: number, runner: CopyCommandRunner = copyRunner()) {
  const worker = new JobWorker(ctx.database.db, { workerId: "test-worker", pollIntervalMs: 1, heartbeatIntervalMs: 10, logger: silentLogger, copyRunner: runner });
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const current = await ctx.jobs.getJob(jobId);
    if (current && ["completed", "partially_failed", "failed", "cancelled"].includes(current.status)) return current;
    await worker.runOnce();
  }
  throw new Error(`Job #${jobId} did not finish`);
}

async function insertLink(itemName: string, { kind = "remote", storagePolicy = "location_1" }: { kind?: "remote" | "local"; storagePolicy?: StoragePolicyKind } = {}) {
  const timestamp = new Date().toISOString();
  const relativePath = path.join(itemName, `${itemName.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.mkv`);
  const sourcePath = path.join(root, kind, "movies", relativePath);
  const destinationPath = path.join(root, kind === "remote" ? "local" : "remote", "movies", relativePath);
  const linkPath = path.join(root, "links", "movies", relativePath);
  await fs.mkdir(path.dirname(sourcePath), { recursive: true });
  await fs.mkdir(path.dirname(linkPath), { recursive: true });
  await fs.writeFile(sourcePath, `content of ${itemName}`);
  await fs.symlink(sourcePath, linkPath);
  const row = await first(
    ctx.database.db
      .insert(schema.mediaLinks)
      .values({
        section: "movies",
        itemName,
        relativePath,
        linkPath,
        targetPath: sourcePath,
        kind,
        targetExists: true,
        isMedia: true,
        storagePolicy,
        resolvedStorageFileId: null,
        sizeBytes: Buffer.byteLength(`content of ${itemName}`),
        firstSeenAt: timestamp,
        lastSeenAt: timestamp,
        lastChangedAt: timestamp,
        missingSince: null,
        lastSeenJobId: 1,
        updatedAt: timestamp
      })
      .returning({ id: schema.mediaLinks.id })
  );
  return { id: row!.id, itemName, sourcePath, destinationPath, linkPath };
}

/** A finished job in which every link named `failing` failed. */
async function failedJob(options: Omit<CopyOptions, "linkIds"> & { linkIds: number[] }, ...failing: string[]): Promise<number> {
  const jobId = await ctx.jobs.startCopy(options);
  const job = await runJob(jobId, copyRunner(...failing));
  expect(["failed", "partially_failed"]).toContain(job.status);
  return jobId;
}

async function plan(jobId: number, cookie = owner): Promise<CopyRetryPlan> {
  const response = await ctx.app.inject({ method: "GET", url: `/api/jobs/${jobId}/copy-retry`, headers: { cookie } });
  expect(response.statusCode).toBe(200);
  return response.json<CopyRetryPlan>();
}

function press(jobId: number, cookie = owner, payload: Record<string, unknown> = {}) {
  return ctx.app.inject({ method: "POST", url: `/api/jobs/${jobId}/copy-retry`, headers: { cookie }, payload });
}

async function selectionOf(jobId: number): Promise<number[]> {
  const rows = await ctx.database.db.select().from(schema.jobSelectionItems).where(eq(schema.jobSelectionItems.jobId, jobId));
  return rows.sort((a, b) => a.selectionOrder - b.selectionOrder).map((row) => row.mediaLinkId);
}

async function storedOptions(jobId: number): Promise<Record<string, unknown>> {
  const row = await first(ctx.database.db.select({ options: schema.jobs.options }).from(schema.jobs).where(eq(schema.jobs.id, jobId)).limit(1));
  return JSON.parse(row!.options) as Record<string, unknown>;
}

async function jobCount(): Promise<number> {
  return (await ctx.database.db.select({ id: schema.jobs.id }).from(schema.jobs)).length;
}

async function insertOperation(jobId: number, link: Awaited<ReturnType<typeof insertLink>>, stage: string, resultStatus: string | null) {
  const timestamp = new Date().toISOString();
  await ctx.database.db.insert(schema.copyOperations).values({
    jobId,
    mediaLinkId: link.id,
    linkPath: link.linkPath,
    sourcePath: link.sourcePath,
    destinationPath: link.destinationPath,
    originalTargetPath: link.sourcePath,
    originalLinkState: "{}",
    stage,
    resultStatus,
    createdAt: timestamp,
    updatedAt: timestamp,
    completedAt: stage === "committed" ? timestamp : null
  });
}

async function finishedJobWithOperation(link: Awaited<ReturnType<typeof insertLink>>, stage: string, resultStatus: string | null, status: "failed" | "completed" = "failed"): Promise<number> {
  const jobId = await ctx.jobs.startCopy({ direction: "to_local", linkIds: [link.id] });
  const timestamp = new Date().toISOString();
  await ctx.database.db.update(schema.jobs).set({ status, startedAt: timestamp, finishedAt: timestamp }).where(eq(schema.jobs.id, jobId));
  await insertOperation(jobId, link, stage, resultStatus);
  return jobId;
}

describe("retrying a copy job's failed items", () => {
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "srtl-copy-retry-"));
    for (const folder of ["links/movies", "local", "remote"]) await fs.mkdir(path.join(root, folder), { recursive: true });
    testDatabase = await createTestDatabase();
    ctx = await createApp({
      rootDir: root,
      dataDir: path.join(root, "data"),
      databaseUrl: testDatabase.databaseUrl,
      autoMigrate: true,
      anonymousRequestsPerMinute: 100_000,
      paths: { symlinkDir: path.join(root, "links"), localDir: path.join(root, "local"), remoteDir: path.join(root, "remote") }
    });
    ctx.app.log.level = "silent";
    await markOnboardingCompleteForExistingInstall(ctx.database.db);
    const setup = await ctx.app.inject({ method: "POST", url: "/api/auth/setup", payload: { setupToken: readSetupToken(ctx), username: "the-owner", password: "owner-password-1234", confirmPassword: "owner-password-1234" } });
    expect(setup.statusCode).toBe(200);
    owner = cookieFrom(setup.headers);
    await setSetting(ctx.database.db, "sections", { sections: ["movies"], sectionTitles: {}, sectionTypes: { movies: "movies" } });
    moderator = await createModerator();
  }, 120_000);

  afterEach(async () => {
    await ctx.app.close();
    await testDatabase.cleanup();
    await fs.rm(root, { recursive: true, force: true });
  });

  describe("admission", () => {
    it("queues a new job with only the failed items and leaves the old job's history alone", async () => {
      const ok = await insertLink("Sample Copied Film");
      const bad = await insertLink("Sample Failing Film");
      const worse = await insertLink("Another Failing Film");
      const sourceJobId = await failedJob({ direction: "to_local", linkIds: [worse.id, ok.id, bad.id] }, "failing-film");
      const before = await ctx.jobs.getJob(sourceJobId);
      expect(before?.status).toBe("partially_failed");
      const eventsBefore = await ctx.jobs.listEvents(sourceJobId);

      await expect(plan(sourceJobId)).resolves.toMatchObject({ jobId: sourceJobId, direction: "to_local", totalFailed: 2, retryCount: 2, skippedCount: 0, skipped: [], replaceOffered: false, deleteRemoteSourceOffered: false });

      const response = await press(sourceJobId);
      expect(response.statusCode).toBe(200);
      const started = response.json<CopyRetryStarted>();
      expect(started).toMatchObject({ retried: 2, skipped: 0, deleteRemoteSources: false });
      expect(started.jobId).not.toBe(sourceJobId);
      await expect(selectionOf(started.jobId)).resolves.toEqual([worse.id, bad.id]);
      await expect(ctx.jobs.getJob(sourceJobId)).resolves.toMatchObject({ status: "partially_failed", finishedAt: before?.finishedAt, progress: before?.progress });
      await expect(selectionOf(sourceJobId)).resolves.toEqual([worse.id, ok.id, bad.id]);
      await expect(ctx.jobs.listEvents(sourceJobId)).resolves.toHaveLength(eventsBefore.length);

      await expect(runJob(started.jobId)).resolves.toMatchObject({ status: "completed", progress: expect.objectContaining({ copied: 2, failed: 0 }) });
      await expect(fs.readlink(bad.linkPath)).resolves.toBe(bad.destinationPath);
      await expect(fs.readlink(worse.linkPath)).resolves.toBe(worse.destinationPath);
    });

    it("records the retry in the action audit and on the new job", async () => {
      const link = await insertLink("Sample Audited Film");
      const sourceJobId = await failedJob({ direction: "to_local", linkIds: [link.id] }, "audited");
      const { jobId } = (await press(sourceJobId)).json<CopyRetryStarted>();
      const trail = await ctx.app.inject({ method: "GET", url: "/api/system/action-audit", headers: { cookie: owner } });
      expect(trail.json()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            action: "copy.retry",
            actor: { userId: expect.any(Number), username: "the-owner" },
            targets: { jobId, sourceJobId, direction: "to_local", linkIds: [link.id], linkCount: 1, skipped: [] }
          })
        ])
      );
      const messages = (await ctx.jobs.listEvents(jobId)).map((event) => event.message);
      expect(messages.some((message) => message.startsWith(`Retried 1 failed item from copy job #${sourceJobId}`))).toBe(true);
    });

    it("goes through the same locks as any other copy", async () => {
      const link = await insertLink("Sample Locked Film");
      const sourceJobId = await failedJob({ direction: "to_local", linkIds: [link.id] }, "locked");
      const count = await jobCount();
      const moved = path.join(root, "links-moved");
      await fs.mkdir(moved);
      await reconcileEnvironmentPaths(ctx.database.db, { ...ctx.config.paths, symlinkDir: moved });
      const response = await press(sourceJobId);
      expect(response.statusCode).toBe(423);
      await expect(jobCount()).resolves.toBe(count);
    });

    it("is refused when another job holds the item's resources", async () => {
      const link = await insertLink("Sample Claimed Film");
      const sourceJobId = await failedJob({ direction: "to_local", linkIds: [link.id] }, "claimed");
      const auditJobId = await ctx.jobs.startAudit({ mode: "fast", linkIds: [link.id] });
      const count = await jobCount();
      const response = await press(sourceJobId);
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: expect.stringContaining(`Job #${auditJobId}`) });
      await expect(jobCount()).resolves.toBe(count);
    });

    it("answers for unknown jobs, other job types and jobs with nothing failed", async () => {
      await expect(ctx.app.inject({ method: "GET", url: "/api/jobs/999999/copy-retry", headers: { cookie: owner } })).resolves.toMatchObject({ statusCode: 404 });
      expect((await press(999_999)).statusCode).toBe(404);
      const audit = await ctx.jobs.startAudit({ mode: "fast", targets: ["local"], sections: ["movies"] });
      await expect(ctx.app.inject({ method: "GET", url: `/api/jobs/${audit}/copy-retry`, headers: { cookie: owner } })).resolves.toMatchObject({ statusCode: 400 });
      expect((await press(audit)).statusCode).toBe(400);

      const link = await insertLink("Sample Finished Film");
      const completed = await ctx.jobs.startCopy({ direction: "to_local", linkIds: [link.id] });
      await expect(runJob(completed)).resolves.toMatchObject({ status: "completed" });
      await expect(plan(completed)).resolves.toMatchObject({ totalFailed: 0, retryCount: 0 });
      const count = await jobCount();
      const response = await press(completed);
      expect(response.statusCode).toBe(409);
      await expect(jobCount()).resolves.toBe(count);
    });

    it("refuses a selection that shrank instead of queuing what is left", async () => {
      const link = await insertLink("Sample Racing Film");
      const count = await jobCount();
      await expect(ctx.jobs.startCopy({ direction: "to_local", linkIds: [link.id, 999_999] }, { requireAllLinks: true })).rejects.toThrow("selection changed");
      await expect(ctx.jobs.startCopy({ direction: "to_local", linkIds: [999_999] }, { requireAllLinks: true })).rejects.toThrow("selection changed");
      await expect(jobCount()).resolves.toBe(count);
    });
  });

  describe("skip rules", () => {
    it("treats a failed row with a later committed copy as already done", async () => {
      const link = await insertLink("Sample Superseded Film");
      const sourceJobId = await failedJob({ direction: "to_local", linkIds: [link.id] }, "superseded");
      await expect(plan(sourceJobId)).resolves.toMatchObject({ retryCount: 1 });

      const laterJobId = await ctx.jobs.startCopy({ direction: "to_local", linkIds: [link.id] });
      await expect(runJob(laterJobId)).resolves.toMatchObject({ status: "completed" });

      await expect(plan(sourceJobId)).resolves.toMatchObject({
        totalFailed: 1,
        retryCount: 0,
        skippedCount: 1,
        skipped: [{ reason: "already_copied", count: 1 }],
        summary: "Nothing to retry: 1 already copied."
      });
      const count = await jobCount();
      const response = await press(sourceJobId);
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ error: "Nothing to retry: 1 already copied." });
      await expect(jobCount()).resolves.toBe(count);
    });

    it("treats a reconciliation_required row with a later committed copy as already done", async () => {
      const link = await insertLink("Sample Reconciled Film");
      const oldJobId = await finishedJobWithOperation(link, "reconciliation_required", null);
      await expect(plan(oldJobId)).resolves.toMatchObject({ retryCount: 0, skipped: [{ reason: "needs_reconciliation", count: 1 }] });

      await finishedJobWithOperation(link, "committed", "repointed", "completed");
      await expect(plan(oldJobId)).resolves.toMatchObject({ totalFailed: 1, retryCount: 0, skipped: [{ reason: "already_copied", count: 1 }] });
    });

    it("does not count a later conflict, skip or earlier copy as done", async () => {
      const link = await insertLink("Sample Conflicted Film");
      const earlier = await finishedJobWithOperation(link, "committed", "copied", "completed");
      expect(earlier).toBeGreaterThan(0);
      const oldJobId = await finishedJobWithOperation(link, "failed", null);
      await finishedJobWithOperation(link, "committed", "conflict", "completed");
      await expect(plan(oldJobId)).resolves.toMatchObject({ retryCount: 1, skippedCount: 0 });
    });

    it("skips a link that is now local even without a copy row saying so", async () => {
      const link = await insertLink("Sample Rescanned Film");
      const sourceJobId = await failedJob({ direction: "to_local", linkIds: [link.id] }, "rescanned");
      await ctx.database.db.update(schema.mediaLinks).set({ kind: "local" }).where(eq(schema.mediaLinks.id, link.id));
      await expect(plan(sourceJobId)).resolves.toMatchObject({ retryCount: 0, skipped: [{ reason: "already_copied", count: 1 }] });
    });

    it("skips links that are missing, deleted or no longer eligible, and retries the rest", async () => {
      const keep = await insertLink("Sample Kept Film");
      const missing = await insertLink("Sample Missing Film");
      const removed = await insertLink("Sample Removed Film");
      const changed = await insertLink("Sample Changed Film");
      const sourceJobId = await failedJob({ direction: "to_local", linkIds: [keep.id, missing.id, removed.id, changed.id] }, "kept", "missing", "removed", "changed");
      const timestamp = new Date().toISOString();
      await ctx.database.db.update(schema.mediaLinks).set({ missingSince: timestamp }).where(eq(schema.mediaLinks.id, missing.id));
      await ctx.database.db.update(schema.mediaLinks).set({ storagePolicy: "location_2" }).where(eq(schema.mediaLinks.id, changed.id));
      // History can outlive a link once its rows are pruned, leaving only the job's event naming it.
      await ctx.database.db.delete(schema.copyOperations).where(eq(schema.copyOperations.mediaLinkId, removed.id));
      await ctx.database.db.delete(schema.mediaLinks).where(eq(schema.mediaLinks.id, removed.id));

      const current = await plan(sourceJobId);
      expect(current).toMatchObject({ totalFailed: 4, retryCount: 1, skippedCount: 3 });
      expect(current.skipped).toEqual(expect.arrayContaining([{ reason: "link_gone", count: 2 }, { reason: "no_longer_eligible", count: 1 }]));
      expect(current.summary).toContain("Skipping 3");

      const response = await press(sourceJobId);
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ retried: 1, skipped: 3, summary: current.summary });
      await expect(selectionOf(response.json<CopyRetryStarted>().jobId)).resolves.toEqual([keep.id]);
    });

    it("counts an item that had gone before the job ran, which no row or event names", async () => {
      const present = await insertLink("Sample Present Film");
      const vanished = await insertLink("Sample Vanished Film");
      const jobId = await ctx.jobs.startCopy({ direction: "to_local", linkIds: [present.id, vanished.id] });
      await ctx.database.db.update(schema.mediaLinks).set({ missingSince: new Date().toISOString() }).where(eq(schema.mediaLinks.id, vanished.id));
      await expect(runJob(jobId, copyRunner("present"))).resolves.toMatchObject({ status: "failed", progress: expect.objectContaining({ failed: 2 }) });

      const current = await plan(jobId);
      expect(current).toMatchObject({ totalFailed: 2, retryCount: 1, skippedCount: 1, skipped: [{ reason: "link_gone", count: 1 }] });
    });

    it("says when failures cannot be tied to an item", async () => {
      const link = await insertLink("Sample Historic Film");
      const jobId = await finishedJobWithOperation(link, "committed", "copied", "failed");
      await ctx.database.db.update(schema.jobs).set({ progress: JSON.stringify({ total: 3, copied: 1, failed: 2 }) }).where(eq(schema.jobs.id, jobId));
      await expect(plan(jobId)).resolves.toMatchObject({ totalFailed: 2, retryCount: 0, skipped: [{ reason: "unidentified", count: 2 }], notReachedCount: 0 });
    });

    it("mentions items the job never reached, and leaves them out", async () => {
      const link = await insertLink("Sample Stopped Film");
      const jobId = await finishedJobWithOperation(link, "failed", null);
      await ctx.database.db.update(schema.jobs).set({ progress: JSON.stringify({ total: 5, failed: 1 }) }).where(eq(schema.jobs.id, jobId));
      const current = await plan(jobId);
      expect(current).toMatchObject({ totalFailed: 1, retryCount: 1, notReachedCount: 4 });
      expect(current.summary).toContain("4 other items were not attempted");
    });
  });

  describe("duplicate presses", () => {
    it("queues once when two people press at the same moment", async () => {
      const links = await Promise.all([insertLink("Sample Race One"), insertLink("Sample Race Two")]);
      const sourceJobId = await failedJob({ direction: "to_local", linkIds: links.map((link) => link.id) }, "race-one", "race-two");
      const count = await jobCount();

      const responses = await Promise.all([press(sourceJobId), press(sourceJobId), press(sourceJobId)]);
      const started = responses.filter((response) => response.statusCode === 200);
      expect(started).toHaveLength(1);
      const { jobId } = started[0]!.json<CopyRetryStarted>();
      for (const refused of responses.filter((response) => response.statusCode !== 200)) {
        expect(refused.statusCode).toBe(409);
        expect(refused.json()).toMatchObject({ error: `Nothing to retry: 2 already queued in job #${jobId}.` });
      }
      await expect(jobCount()).resolves.toBe(count + 1);
    });

    it("explains a second press while the first retry is still queued, then allows another if it fails again", async () => {
      const link = await insertLink("Sample Twice Film");
      const sourceJobId = await failedJob({ direction: "to_local", linkIds: [link.id] }, "twice");
      const first = (await press(sourceJobId)).json<CopyRetryStarted>();

      await expect(plan(sourceJobId)).resolves.toMatchObject({ retryCount: 0, skipped: [{ reason: "already_queued", count: 1, jobIds: [first.jobId] }] });
      const second = await press(sourceJobId);
      expect(second.statusCode).toBe(409);
      expect(second.json()).toMatchObject({ error: `Nothing to retry: 1 already queued in job #${first.jobId}.` });

      await expect(runJob(first.jobId, copyRunner("twice"))).resolves.toMatchObject({ status: "failed" });
      await expect(plan(sourceJobId)).resolves.toMatchObject({ retryCount: 1 });
      await expect(plan(first.jobId)).resolves.toMatchObject({ retryCount: 1 });
      const third = await press(first.jobId);
      expect(third.statusCode).toBe(200);
      await expect(runJob(third.json<CopyRetryStarted>().jobId)).resolves.toMatchObject({ status: "completed" });
      await expect(plan(sourceJobId)).resolves.toMatchObject({ retryCount: 0, skipped: [{ reason: "already_copied", count: 1 }] });
    });

    it("retries around an item another copy job has queued", async () => {
      const queued = await insertLink("Sample Queued Film");
      const free = await insertLink("Sample Free Film");
      const sourceJobId = await failedJob({ direction: "to_local", linkIds: [queued.id, free.id] }, "queued-film", "free-film");
      const otherJobId = await ctx.jobs.startCopy({ direction: "to_local", linkIds: [queued.id] });
      await expect(plan(sourceJobId)).resolves.toMatchObject({ retryCount: 1, skipped: [{ reason: "already_queued", count: 1, jobIds: [otherJobId] }] });
    });
  });

  describe("options that can remove files", () => {
    async function enableRemoteDelete(on = true) {
      await setSetting(ctx.database.db, "advancedSettings", { cleanup: { deleteRemoteSourceAfterCopy: on, holdDays: 7, reRequestsPerMinute: 6 }, copy: { byteCompare: true } });
    }

    it("keeps the options that remove nothing", async () => {
      const link = await insertLink("Sample Options Film");
      const sourceJobId = await failedJob(
        { direction: "to_local", linkIds: [link.id], localConflictStrategy: "keep_both", allowSourceTitleMismatch: true, radarrMonitoring: true, sonarrMonitoring: true },
        "options-film"
      );
      const { jobId, localConflictStrategy } = (await press(sourceJobId)).json<CopyRetryStarted>();
      expect(localConflictStrategy).toBe("keep_both");
      await expect(storedOptions(jobId)).resolves.toMatchObject({ direction: "to_local", localConflictStrategy: "keep_both", allowSourceTitleMismatch: true, radarrMonitoring: true, sonarrMonitoring: true });
    });

    it("keeps a job with no conflict strategy that way, so a conflict stops the item", async () => {
      const link = await insertLink("Sample Plain Film");
      const sourceJobId = await failedJob({ direction: "to_local", linkIds: [link.id] }, "plain-film");
      const { jobId } = (await press(sourceJobId)).json<CopyRetryStarted>();
      await expect(storedOptions(jobId)).resolves.not.toHaveProperty("localConflictStrategy");
    });

    it("does not replace unless asked, and then only for someone who may delete", async () => {
      const link = await insertLink("Sample Replace Film");
      const sourceJobId = await failedJob({ direction: "to_local", linkIds: [link.id], localConflictStrategy: "replace" }, "replace-film");
      await expect(plan(sourceJobId)).resolves.toMatchObject({ replaceOffered: true });

      const refused = await press(sourceJobId, moderator, { replaceExisting: true });
      expect(refused.statusCode).toBe(403);

      const quiet = await press(sourceJobId);
      expect(quiet.json()).toMatchObject({ localConflictStrategy: "keep_both" });
      await expect(storedOptions(quiet.json<CopyRetryStarted>().jobId)).resolves.toMatchObject({ localConflictStrategy: "keep_both" });
      await ctx.jobs.terminate(quiet.json<CopyRetryStarted>().jobId);
      await runJob(quiet.json<CopyRetryStarted>().jobId);

      const asked = await press(sourceJobId, owner, { replaceExisting: true });
      expect(asked.statusCode).toBe(200);
      expect(asked.json()).toMatchObject({ localConflictStrategy: "replace" });
      await expect(storedOptions(asked.json<CopyRetryStarted>().jobId)).resolves.toMatchObject({ localConflictStrategy: "replace" });
    });

    it("gives a moderator's retry of a replacing job keep-both, which leaves the existing file", async () => {
      const link = await insertLink("Sample Keeping Film");
      const sourceJobId = await failedJob({ direction: "to_local", linkIds: [link.id], localConflictStrategy: "replace" }, "keeping-film");
      await fs.mkdir(path.dirname(link.destinationPath), { recursive: true });
      await fs.writeFile(link.destinationPath, "a file already here");

      const response = await press(sourceJobId, moderator);
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ localConflictStrategy: "keep_both", deleteRemoteSources: false });
      await expect(runJob(response.json<CopyRetryStarted>().jobId)).resolves.toMatchObject({ status: "completed" });

      const folder = await fs.readdir(path.dirname(link.destinationPath));
      const contents = await Promise.all(folder.map((name) => fs.readFile(path.join(path.dirname(link.destinationPath), name), "utf8")));
      expect(contents).toEqual(expect.arrayContaining(["a file already here", "content of Sample Keeping Film"]));
      await expect(fs.readFile(link.sourcePath, "utf8")).resolves.toBe("content of Sample Keeping Film");
    });

    it("keeps remote sources unless asked, and never for a moderator", async () => {
      await enableRemoteDelete();
      const link = await insertLink("Sample Source Film");
      const sourceJobId = await failedJob({ direction: "to_local", linkIds: [link.id] }, "source-film");
      await expect(storedOptions(sourceJobId)).resolves.toMatchObject({ deleteRemoteSource: true });
      await expect(plan(sourceJobId)).resolves.toMatchObject({ deleteRemoteSourceOffered: true });

      expect((await press(sourceJobId, moderator, { deleteRemoteSources: true })).statusCode).toBe(403);

      const moderatorRetry = await press(sourceJobId, moderator);
      expect(moderatorRetry.json()).toMatchObject({ deleteRemoteSources: false });
      await expect(storedOptions(moderatorRetry.json<CopyRetryStarted>().jobId)).resolves.not.toHaveProperty("deleteRemoteSource");
      await ctx.jobs.terminate(moderatorRetry.json<CopyRetryStarted>().jobId);
      await runJob(moderatorRetry.json<CopyRetryStarted>().jobId);

      const asked = await press(sourceJobId, owner, { deleteRemoteSources: true });
      expect(asked.statusCode).toBe(200);
      expect(asked.json()).toMatchObject({ deleteRemoteSources: true });
      await expect(storedOptions(asked.json<CopyRetryStarted>().jobId)).resolves.toMatchObject({ deleteRemoteSource: true });
      await expect(runJob(asked.json<CopyRetryStarted>().jobId)).resolves.toMatchObject({ status: "completed" });
      await expect(fs.stat(link.sourcePath)).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("does not start deleting for a job that never did, or once the setting is off", async () => {
      const link = await insertLink("Sample Kept Source Film");
      const sourceJobId = await failedJob({ direction: "to_local", linkIds: [link.id] }, "kept-source");
      await enableRemoteDelete();
      await expect(plan(sourceJobId)).resolves.toMatchObject({ deleteRemoteSourceOffered: false });
      expect((await press(sourceJobId, owner, { deleteRemoteSources: true })).statusCode).toBe(400);

      const moderatorStarted = await ctx.jobs.startCopy({ direction: "to_local", linkIds: [link.id] }, { keepRemoteSource: true });
      await runJob(moderatorStarted, copyRunner("kept-source"));
      await expect(plan(moderatorStarted)).resolves.toMatchObject({ deleteRemoteSourceOffered: false });

      const deleting = await ctx.jobs.startCopy({ direction: "to_local", linkIds: [link.id] });
      await runJob(deleting, copyRunner("kept-source"));
      await expect(plan(deleting)).resolves.toMatchObject({ deleteRemoteSourceOffered: true });
      await enableRemoteDelete(false);
      await expect(plan(deleting)).resolves.toMatchObject({ deleteRemoteSourceOffered: false });
    });

    it("refuses to replace on a retry of a job that did not", async () => {
      const link = await insertLink("Sample No Replace Film");
      const sourceJobId = await failedJob({ direction: "to_local", linkIds: [link.id], localConflictStrategy: "keep_both" }, "no-replace");
      const response = await press(sourceJobId, owner, { replaceExisting: true });
      expect(response.statusCode).toBe(400);
      await expect(ctx.database.db.select().from(schema.jobs).where(and(eq(schema.jobs.type, "copy"), eq(schema.jobs.status, "queued")))).resolves.toHaveLength(0);
    });
  });

  describe("permissions", () => {
    it("needs a session", async () => {
      await expect(ctx.app.inject({ method: "GET", url: "/api/jobs/1/copy-retry" })).resolves.toMatchObject({ statusCode: 401 });
      await expect(ctx.app.inject({ method: "POST", url: "/api/jobs/1/copy-retry", payload: {} })).resolves.toMatchObject({ statusCode: 401 });
    });

    it("lets a moderator retry a copy to local and shows them no paths", async () => {
      const link = await insertLink("Sample Moderator Film");
      const sourceJobId = await failedJob({ direction: "to_local", linkIds: [link.id] }, "moderator-film");
      const current = await plan(sourceJobId, moderator);
      expect(current).toMatchObject({ retryCount: 1 });
      expect(JSON.stringify(current)).not.toContain(root);
      const response = await press(sourceJobId, moderator);
      expect(response.statusCode).toBe(200);
      const trail = await ctx.app.inject({ method: "GET", url: "/api/system/action-audit", headers: { cookie: owner } });
      expect(trail.json()).toEqual(expect.arrayContaining([expect.objectContaining({ action: "copy.retry", actor: { userId: expect.any(Number), username: "a-moderator" } })]));
    });

    it("refuses a moderator a retry of a copy to remote, as it does starting one", async () => {
      const link = await insertLink("Sample Remote Film", { kind: "local", storagePolicy: "location_2" });
      const sourceJobId = await failedJob({ direction: "to_remote", linkIds: [link.id] }, "remote-film");
      await expect(plan(sourceJobId, moderator)).resolves.toMatchObject({ direction: "to_remote", retryCount: 1 });
      const count = await jobCount();
      const refused = await press(sourceJobId, moderator);
      expect(refused.statusCode).toBe(403);
      await expect(jobCount()).resolves.toBe(count);
      expect((await press(sourceJobId)).statusCode).toBe(200);
    });
  });
});
