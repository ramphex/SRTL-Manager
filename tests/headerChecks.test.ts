import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp, type AppContext } from "../src/server/app";
import { setSetting } from "../src/server/db/database";
import * as schema from "../src/server/db/schema";
import { JobWorker } from "../src/server/jobs/jobRunner";
import { purgeableDamagedFiles } from "../src/server/jobs/orphanPurge";
import type { CopyCommandRunner } from "../src/server/lib/copier";
import { listDamagedFiles } from "../src/server/lib/damagedFiles";
import { headerReadBytes } from "../src/server/lib/fileHeaders";
import { copyHeaderGate, fileHeaderChecksEnabled, headerCheckDefaults, headerCheckLimits, runHeaderBackfillPass } from "../src/server/lib/headerChecks";
import { markOnboardingCompleteForExistingInstall } from "../src/server/lib/onboarding";
import { listMediaLinksPage, listStorageFiles } from "../src/server/lib/scanner";
import { assignTitle } from "./policyHelpers";
import { createTestDatabase, type TestDatabaseHandle } from "./testDb";

const silentLogger = { info: () => undefined, warn: () => undefined, error: () => undefined };
const twoMb = 2 * 1024 * 1024;
const originalLimits = { ...headerCheckLimits };

let root: string;
let ctx: AppContext;
let testDatabase: TestDatabaseHandle;

type Kind = "good" | "zeros" | "garbage" | "stub" | "empty";

function content(kind: Kind): { head: Buffer; size: number } {
  if (kind === "good") return { head: Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), randomBytes(headerReadBytes - 4)]), size: twoMb };
  if (kind === "zeros") return { head: Buffer.alloc(0), size: twoMb };
  if (kind === "garbage") {
    const bytes = randomBytes(headerReadBytes);
    for (let index = 0; index < bytes.length; index += 1) if (bytes[index] === 0 || bytes[index] === 0x47) bytes[index] = 0x33;
    return { head: bytes, size: twoMb + 1 };
  }
  if (kind === "stub") {
    const stub = Buffer.alloc(258, 0x41);
    stub.writeUInt32BE(0x20, 0);
    stub.write("ftyp", 4, "latin1");
    return { head: stub, size: 258 };
  }
  return { head: Buffer.alloc(0), size: 0 };
}

/** A made-up title on remote storage, with a library symlink to it. */
async function addRemoteTitle(title: string, kind: Kind, options: { daysOld?: number } = {}): Promise<string> {
  const extension = kind === "stub" ? "mp4" : "mkv";
  const relativePath = path.join("movies", title, `${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.${extension}`);
  const filePath = path.join(root, "remote", relativePath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const { head, size } = content(kind);
  await fs.writeFile(filePath, head);
  if (size > head.length) await fs.truncate(filePath, size);
  if (options.daysOld) {
    const when = new Date(Date.now() - options.daysOld * 86_400_000);
    await fs.utimes(filePath, when, when);
  }
  const linkPath = path.join(root, "links", relativePath);
  await fs.mkdir(path.dirname(linkPath), { recursive: true });
  await fs.symlink(filePath, linkPath);
  return filePath;
}

function copyRunner(): CopyCommandRunner {
  return {
    async copyFile(sourcePath, tempPath) {
      await fs.copyFile(sourcePath, tempPath);
    },
    async runCmp() {
      return { status: "pass", output: "" };
    },
    async runFfmpeg() {
      return { status: "pass", output: "" };
    }
  };
}

async function runJob(jobId: number) {
  const worker = new JobWorker(ctx.database.db, { workerId: "header-test-worker", pollIntervalMs: 1, heartbeatIntervalMs: 10, logger: silentLogger, copyRunner: copyRunner() });
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const current = await ctx.jobs.getJob(jobId);
    if (current && ["completed", "partially_failed", "failed", "cancelled"].includes(current.status)) return current;
    await worker.runOnce();
  }
  throw new Error(`Job #${jobId} did not finish`);
}

async function scan(): Promise<number> {
  const jobId = await ctx.jobs.startScan({ scanSymlinks: true, scanLocal: true, scanRemote: true });
  await expect(runJob(jobId)).resolves.toMatchObject({ status: "completed" });
  return jobId;
}

async function headerRows() {
  const rows = await ctx.database.db.select().from(schema.storageFiles);
  return Object.fromEntries(rows.map((row) => [row.itemName, { status: row.headerStatus, reason: row.headerReason, queued: row.headerQueuedAt !== null, checkedAt: row.headerCheckedAt }]));
}

async function setHeaderChecks(enabled: boolean, extra: Record<string, unknown> = {}): Promise<void> {
  await setSetting(ctx.database.db, "advancedSettings", { scan: { checkFileHeaders: enabled }, ...extra });
}

async function headerEvents(jobId: number): Promise<string[]> {
  const events = await ctx.database.db.select().from(schema.jobEvents).where(eq(schema.jobEvents.jobId, jobId));
  return events.map((event) => event.message).filter((message) => message.startsWith("Checked file headers"));
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "srtl-header-checks-"));
  for (const folder of ["links/movies", "local/movies", "remote/movies"]) await fs.mkdir(path.join(root, folder), { recursive: true });
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
  await setSetting(ctx.database.db, "sections", { sections: ["movies"], sectionTitles: {}, sectionTypes: { movies: "movies" } });
  await setHeaderChecks(true);
}, 120_000);

afterEach(async () => {
  Object.assign(headerCheckLimits, originalLimits);
  await ctx.app.close();
  await testDatabase.cleanup();
  await fs.rm(root, { recursive: true, force: true });
});

describe("the end-of-scan header check", () => {
  it("leaves the library the first scan finds to the background pass and checks only files that are new after it", async () => {
    await addRemoteTitle("Existing Good Film", "good");
    await addRemoteTitle("Existing Broken Film", "garbage");
    const first = await scan();
    expect(await headerRows()).toEqual({
      "Existing Good Film": { status: null, reason: null, queued: false, checkedAt: null },
      "Existing Broken Film": { status: null, reason: null, queued: false, checkedAt: null }
    });
    expect(await headerEvents(first)).toEqual([]);

    await addRemoteTitle("New Good Film", "good");
    await addRemoteTitle("New Zero Film", "zeros");
    await addRemoteTitle("New Garbage Film", "garbage");
    await addRemoteTitle("New Stub Film", "stub");
    await addRemoteTitle("New Empty Film", "empty");
    const second = await scan();
    const rows = await headerRows();
    expect(rows["Existing Good Film"]).toMatchObject({ status: null, queued: false });
    expect(rows["Existing Broken Film"]).toMatchObject({ status: null, queued: false });
    expect(rows["New Good Film"]).toMatchObject({ status: "pass", reason: "matroska", queued: false });
    expect(rows["New Zero Film"]).toMatchObject({ status: "fail", reason: "zeros", queued: false });
    expect(rows["New Garbage Film"]).toMatchObject({ status: "fail", reason: "not_video", queued: false });
    expect(rows["New Stub Film"]).toMatchObject({ status: "fail", reason: "too_small", queued: false });
    expect(rows["New Empty Film"]).toMatchObject({ status: "fail", reason: "empty", queued: false });
    expect(await headerEvents(second)).toEqual(["Checked file headers: 1 passed, 4 failed"]);

    // Failures are listed on Damaged files with the new reason, wherever the file is.
    const damaged = await listDamagedFiles(ctx.database.db);
    expect(damaged.map((row) => [row.itemName, row.rootType, row.integrity, row.header?.reason]).sort()).toEqual([
      ["New Empty Film", "remote", "header_failed", "empty"],
      ["New Garbage Film", "remote", "header_failed", "not_video"],
      ["New Stub Film", "remote", "header_failed", "too_small"],
      ["New Zero Film", "remote", "header_failed", "zeros"]
    ]);

    // Listings carry the result, for the checkmark.
    const good = (await listStorageFiles(ctx.database.db, "remote")).find((file) => file.itemName === "New Good Film")!;
    expect(good.header).toEqual({ status: "pass", reason: "matroska", checkedAt: expect.any(String) });
    const page = await listMediaLinksPage(ctx.database.db, { limit: 50, offset: 0, section: "movies" });
    expect(page.rows.find((row) => row.itemName === "New Good Film")?.header).toMatchObject({ status: "pass" });
    expect(page.rows.find((row) => row.itemName === "Existing Good Film")?.header).toBeNull();
  });

  it("checks at most the per-scan cap and carries the rest over to the next scan", async () => {
    await addRemoteTitle("Seed Film", "good");
    await scan();
    headerCheckLimits.perScanFiles = 2;
    await addRemoteTitle("Capped Film A", "good");
    await addRemoteTitle("Capped Film B", "good");
    await addRemoteTitle("Capped Film C", "good");
    const second = await scan();
    let rows = await headerRows();
    const checked = ["Capped Film A", "Capped Film B", "Capped Film C"].filter((title) => rows[title]?.status === "pass");
    const queued = ["Capped Film A", "Capped Film B", "Capped Film C"].filter((title) => rows[title]?.queued);
    expect(checked).toHaveLength(2);
    expect(queued).toHaveLength(1);
    expect(await headerEvents(second)).toEqual(["Checked file headers: 2 passed, 0 failed, 1 left for the next scan"]);

    const third = await scan();
    rows = await headerRows();
    expect(["Capped Film A", "Capped Film B", "Capped Film C"].map((title) => rows[title])).toEqual([
      expect.objectContaining({ status: "pass", queued: false }),
      expect.objectContaining({ status: "pass", queued: false }),
      expect.objectContaining({ status: "pass", queued: false })
    ]);
    expect(await headerEvents(third)).toEqual(["Checked file headers: 1 passed, 0 failed"]);
    // Nothing is due any more, so a fourth scan reads nothing.
    expect(await headerEvents(await scan())).toEqual([]);
  });

  it("re-checks a file whose size or modification time changed, and leaves unchanged results alone", async () => {
    await addRemoteTitle("Seed Film", "good");
    await scan();
    const changing = await addRemoteTitle("Changing Film", "good");
    await addRemoteTitle("Steady Film", "good");
    await scan();
    const before = await headerRows();
    expect(before["Changing Film"]).toMatchObject({ status: "pass" });

    const garbage = content("garbage");
    await fs.writeFile(changing, garbage.head);
    await fs.truncate(changing, garbage.size);
    const later = await scan();
    const after = await headerRows();
    expect(after["Changing Film"]).toMatchObject({ status: "fail", reason: "not_video", queued: false });
    expect(after["Steady Film"]).toEqual(before["Steady Film"]);
    expect(await headerEvents(later)).toEqual(["Checked file headers: 0 passed, 1 failed"]);
  });

  it("does nothing while the setting is off, and keeps existing results visible", async () => {
    await addRemoteTitle("Seed Film", "good");
    await scan();
    await addRemoteTitle("Checked Broken Film", "zeros");
    await scan();
    expect((await headerRows())["Checked Broken Film"]).toMatchObject({ status: "fail", reason: "zeros" });

    await setHeaderChecks(false);
    expect(await fileHeaderChecksEnabled(ctx.database.db)).toBe(false);
    await addRemoteTitle("Unchecked Broken Film", "garbage");
    const off = await scan();
    const rows = await headerRows();
    expect(rows["Unchecked Broken Film"]).toEqual({ status: null, reason: null, queued: false, checkedAt: null });
    expect(rows["Checked Broken Film"]).toMatchObject({ status: "fail", reason: "zeros" });
    expect(await headerEvents(off)).toEqual([]);
    expect(await runHeaderBackfillPass(ctx.database.db)).toEqual({ ran: false, checked: 0, failed: 0 });
    expect((await listDamagedFiles(ctx.database.db)).map((row) => row.itemName)).toEqual(["Checked Broken Film"]);
  });

  it("is on by default for a database that never saved the setting", async () => {
    await setSetting(ctx.database.db, "advancedSettings", {});
    const previous = headerCheckDefaults.enabledWhenUnset;
    headerCheckDefaults.enabledWhenUnset = true;
    try {
      expect(await fileHeaderChecksEnabled(ctx.database.db)).toBe(true);
    } finally {
      headerCheckDefaults.enabledWhenUnset = previous;
    }
  });
});

describe("the background header check", () => {
  it("checks files nobody checked yet, a few per pass, resumes where it stopped, and skips checked files", async () => {
    for (const title of ["Backfill Film A", "Backfill Film B", "Backfill Film C"]) await addRemoteTitle(title, "good");
    await addRemoteTitle("Backfill Broken Film", "zeros");
    await scan();
    // 24 a minute over five-second passes is two files per pass.
    headerCheckLimits.backfillRemotePerMinute = 24;
    expect(await runHeaderBackfillPass(ctx.database.db)).toEqual({ ran: true, checked: 2, failed: 0 });
    expect(await runHeaderBackfillPass(ctx.database.db)).toEqual({ ran: true, checked: 2, failed: 1 });
    expect(await runHeaderBackfillPass(ctx.database.db)).toEqual({ ran: true, checked: 0, failed: 0 });
    const rows = await headerRows();
    expect(Object.values(rows).map((row) => row.status).sort()).toEqual(["fail", "pass", "pass", "pass"]);
  });

  it("waits while a scan runs and retries unreadable files only after the retry delay", async () => {
    const vanishing = await addRemoteTitle("Vanishing Film", "good");
    await scan();
    await fs.rm(vanishing);
    const [running] = await ctx.database.db.insert(schema.jobs).values({ type: "scan", status: "running", createdAt: new Date().toISOString(), progress: "{}", options: "{}" }).returning();
    expect(await runHeaderBackfillPass(ctx.database.db)).toEqual({ ran: false, checked: 0, failed: 0 });
    await ctx.database.db.update(schema.jobs).set({ status: "completed" }).where(eq(schema.jobs.id, running!.id));

    expect(await runHeaderBackfillPass(ctx.database.db)).toEqual({ ran: true, checked: 1, failed: 0 });
    expect((await headerRows())["Vanishing Film"]).toMatchObject({ status: "retry", reason: "ENOENT" });
    expect(await runHeaderBackfillPass(ctx.database.db)).toEqual({ ran: true, checked: 0, failed: 0 });
    const later = Date.now() + headerCheckLimits.retryAfterMs + 60_000;
    expect(await runHeaderBackfillPass(ctx.database.db, { now: () => later })).toEqual({ ran: true, checked: 1, failed: 0 });
  });
});

describe("copying to local", () => {
  async function linkId(title: string): Promise<number> {
    await assignTitle(ctx.database.db, title, "location_1", ["movies"]);
    const rows = await ctx.database.db.select().from(schema.mediaLinks).where(eq(schema.mediaLinks.itemName, title));
    return rows[0]!.id;
  }

  it("refuses a file whose header check fails, checking an unchecked file first, and copies one that passes", async () => {
    await addRemoteTitle("Copy Broken Film", "garbage");
    await addRemoteTitle("Copy Good Film", "good");
    await scan();
    expect((await headerRows())["Copy Broken Film"]).toMatchObject({ status: null });

    const broken = await ctx.jobs.startCopy({ direction: "to_local", linkIds: [await linkId("Copy Broken Film")] });
    await expect(runJob(broken)).resolves.toMatchObject({ status: "failed" });
    const failures = await ctx.jobs.copyFailures(broken);
    expect(failures.items.map((item) => item.reason)).toEqual([
      "Not copied: the file header check failed: not a valid video file: no known container header. The file is listed on Damaged files."
    ]);
    expect((await headerRows())["Copy Broken Film"]).toMatchObject({ status: "fail", reason: "not_video" });
    await expect(fs.readdir(path.join(root, "local", "movies"))).resolves.toEqual([]);

    const good = await ctx.jobs.startCopy({ direction: "to_local", linkIds: [await linkId("Copy Good Film")] });
    await expect(runJob(good)).resolves.toMatchObject({ status: "completed" });
    expect((await headerRows())["Copy Good Film"]).toMatchObject({ status: "pass" });
    const installed = (await ctx.database.db.select().from(schema.jobEvents).where(eq(schema.jobEvents.jobId, good))).find((event) => event.message === "Verified copy installed");
    expect(JSON.parse(installed!.data)).toMatchObject({ headerCheckedAt: expect.any(String) });
  });

  it("does not block copies while the setting is off", async () => {
    await addRemoteTitle("Off Broken Film", "zeros");
    await scan();
    await setHeaderChecks(false);
    const link = (await ctx.database.db.select().from(schema.mediaLinks).where(eq(schema.mediaLinks.itemName, "Off Broken Film")))[0]!;
    await expect(copyHeaderGate(ctx.database.db, link)).resolves.toEqual({ blocked: null, header: null });
    const jobId = await ctx.jobs.startCopy({ direction: "to_local", linkIds: [await linkId("Off Broken Film")] });
    await expect(runJob(jobId)).resolves.toMatchObject({ status: "completed" });
  });

  it("says a file that could not be checked should be tried again later", async () => {
    const vanishing = await addRemoteTitle("Unreadable Film", "good");
    await scan();
    const link = (await ctx.database.db.select().from(schema.mediaLinks).where(eq(schema.mediaLinks.itemName, "Unreadable Film")))[0]!;
    await fs.rm(vanishing);
    await expect(copyHeaderGate(ctx.database.db, link)).resolves.toMatchObject({ blocked: "Not copied: the file header could not be checked (ENOENT). Try the copy again later." });
  });
});

describe("deleting files with a bad header", () => {
  it("accepts remote files that failed the check in the Damaged files delete", async () => {
    await addRemoteTitle("Seed Film", "good");
    await scan();
    const broken = await addRemoteTitle("Old Broken Film", "zeros", { daysOld: 3 });
    await scan();
    const row = (await listDamagedFiles(ctx.database.db)).find((entry) => entry.itemName === "Old Broken Film")!;
    expect(row).toMatchObject({ rootType: "remote", integrity: "header_failed", protectedReason: null, linked: true });
    await expect(purgeableDamagedFiles(ctx.database.db, [row.storageFileId])).resolves.toMatchObject({ rejected: [], eligible: [expect.objectContaining({ root_type: "remote" })] });

    const jobId = await ctx.jobs.startDamagedFilePurge([row.storageFileId], "hold");
    await expect(runJob(jobId)).resolves.toMatchObject({ status: "completed" });
    await expect(fs.stat(broken)).rejects.toMatchObject({ code: "ENOENT" });
    const [operation] = await ctx.database.db.select().from(schema.orphanPurgeOperations).where(eq(schema.orphanPurgeOperations.jobId, jobId));
    expect(operation).toMatchObject({ rootType: "remote", stage: "held" });
  });
});
