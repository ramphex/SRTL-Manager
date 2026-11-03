import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp, type AppContext } from "../src/server/app";
import { setSetting } from "../src/server/db/database";
import * as schema from "../src/server/db/schema";
import { JobWorker } from "../src/server/jobs/jobRunner";
import { expireHeldOrphans, listHeldOrphans, listOrphanReview, restoreHeldOrphans } from "../src/server/jobs/orphanPurge";
import { markOnboardingCompleteForExistingInstall } from "../src/server/lib/onboarding";
import { persistSectionSettings } from "../src/server/lib/sectionSettings";
import type { PathsSettings } from "../src/shared/types";
import { createTestDatabase, type TestDatabaseHandle } from "./testDb";
import { readSetupToken } from "./authHelpers";

let app: AppContext;
let database: TestDatabaseHandle;
let root: string;
let paths: PathsSettings;
const oldTime = new Date(Date.now() - 3 * 86_400_000);
const quietLogger = { info: () => undefined, warn: () => undefined, error: () => undefined };

async function storageFile(rootType: "local" | "remote", relativePath: string, options: { content?: string; mtime?: Date; section?: string; itemName?: string } = {}) {
  const base = rootType === "local" ? paths.localDir : paths.remoteDir;
  const filePath = path.join(base, relativePath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, options.content ?? `bytes of ${relativePath}`);
  const mtime = options.mtime ?? oldTime;
  await fs.utimes(filePath, mtime, mtime);
  const stat = await fs.stat(filePath);
  const timestamp = new Date().toISOString();
  const parts = relativePath.split("/");
  const [row] = await app.database.db
    .insert(schema.storageFiles)
    .values({
      rootType,
      rootPath: base,
      section: options.section ?? (rootType === "local" ? parts[0]! : ""),
      itemName: options.itemName ?? (rootType === "local" ? parts[1]! : parts[0]!),
      relativePath,
      filePath,
      storagePolicy: "unassigned",
      sizeBytes: stat.size,
      mtimeMs: Math.trunc(stat.mtimeMs),
      firstSeenAt: timestamp,
      lastSeenAt: timestamp,
      lastChangedAt: timestamp,
      lastSeenJobId: 0,
      updatedAt: timestamp
    })
    .returning();
  return row!;
}

async function mediaLink(section: string, itemName: string, fileName: string, targetPath: string, lastSeenAt = new Date().toISOString()) {
  const relativePath = `${itemName}/${fileName}`;
  const linkPath = path.join(paths.symlinkDir, section, relativePath);
  await fs.mkdir(path.dirname(linkPath), { recursive: true });
  await fs.symlink(targetPath, linkPath);
  const [row] = await app.database.db
    .insert(schema.mediaLinks)
    .values({ section, itemName, relativePath, linkPath, targetPath, kind: targetPath.startsWith(paths.localDir) ? "local" : "remote", targetExists: true, isMedia: true, storagePolicy: "unassigned", lastSeenAt, updatedAt: lastSeenAt })
    .returning();
  return row!;
}

async function runJobs(): Promise<void> {
  const worker = new JobWorker(app.database.db, { workerId: "orphan-test", logger: quietLogger });
  while (await worker.runOnce()) {
    // drain the queue
  }
}

async function purge(rootType: "local" | "remote", ids: number[], mode: "hold" | "delete") {
  const jobId = await app.jobs.startOrphanPurge(rootType, ids, mode);
  await runJobs();
  return app.jobs.getJob(jobId);
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "srtl-orphan-test-"));
  paths = { symlinkDir: path.join(root, "links"), localDir: path.join(root, "local"), remoteDir: path.join(root, "remote") };
  for (const folder of Object.values(paths)) await fs.mkdir(folder, { recursive: true });
  database = await createTestDatabase();
  app = await createApp({ rootDir: root, databaseUrl: database.databaseUrl, autoMigrate: true, paths });
  app.app.log.level = "silent";
  await markOnboardingCompleteForExistingInstall(app.database.db);
  await persistSectionSettings(app.database.db, { sections: ["movies", "shows"], sectionTypes: { movies: "movies", shows: "shows" } });
});

afterEach(async () => {
  await app?.app.close();
  await database?.cleanup();
  await fs.rm(root, { recursive: true, force: true });
});

describe("orphan review", () => {
  it("categorizes superseded versions, titles not in the library, copy leftovers, artifacts, and recent files", async () => {
    const current = await storageFile("local", "movies/Upgraded (2020)/Upgraded (2020) [Bluray-2160p].mkv");
    await mediaLink("movies", "Upgraded (2020)", "Upgraded (2020) [Bluray-2160p].mkv", current.filePath);
    const oldVersion = await storageFile("local", "movies/Upgraded (2020)/Upgraded (2020) [SDTV].mkv");
    const episodeLinked = await storageFile("local", "shows/Show (2001)/Season 01/Show (2001) - S01E02 [WEBDL-1080p].mkv");
    await mediaLink("shows", "Show (2001)", "Season 01/Show (2001) - S01E02 [WEBDL-1080p].mkv", episodeLinked.filePath);
    const oldEpisode = await storageFile("local", "shows/Show (2001)/Season 01/Show (2001) - S1E2 [SDTV].mkv");
    const siblingEpisode = await storageFile("local", "shows/Show (2001)/Season 01/Show (2001) - S01E03 [SDTV].mkv");
    const gone = await storageFile("local", "movies/Gone (1999)/Gone (1999).mkv");
    const artifact = await storageFile("local", "movies/Upgraded (2020)/.Upgraded (2020).mkv.srtl-kept-1");
    const fresh = await storageFile("local", "movies/Fresh (2026)/Fresh (2026).mkv", { mtime: new Date() });
    const leftover = await storageFile("remote", "Upgraded.2020.2160p/Upgraded.mkv");
    const timestamp = new Date().toISOString();
    await app.database.db.insert(schema.jobs).values({ id: 900, type: "copy", status: "completed", createdAt: timestamp, progress: "{}" });
    await app.database.db.insert(schema.copyOperations).values({ jobId: 900, mediaLinkId: 1, linkPath: "/x", sourcePath: leftover.filePath, destinationPath: current.filePath, originalTargetPath: leftover.filePath, originalLinkState: "symlink", stage: "committed", resultStatus: "copied", createdAt: timestamp, updatedAt: timestamp });

    const local = await listOrphanReview(app.database.db, "local", 7);
    const category = (id: number) => local.items.find((item) => item.storageFileId === id);
    expect(category(oldVersion.id)?.category).toBe("superseded");
    expect(category(oldEpisode.id)?.category).toBe("superseded");
    expect(category(siblingEpisode.id)?.category).toBe("not_in_library");
    expect(category(gone.id)?.category).toBe("not_in_library");
    expect(category(artifact.id)?.category).toBe("srtl_artifact");
    expect(category(fresh.id)).toMatchObject({ protectedReason: "Modified in the last 24 hours" });
    expect(category(current.id)).toBeUndefined();
    expect(local.staleWarning).toBeNull();
    const remote = await listOrphanReview(app.database.db, "remote", 7);
    expect(remote.items.find((item) => item.storageFileId === leftover.id)?.category).toBe("copy_leftover");
  });
});

describe("orphan review storage freshness", () => {
  async function completedScan(options: Record<string, unknown>, finishedAt: Date) {
    const timestamp = finishedAt.toISOString();
    const [job] = await app.database.db.insert(schema.jobs).values({ type: "scan", status: "completed", createdAt: timestamp, finishedAt: timestamp, progress: "{}", options: "{}" }).returning();
    const totals = { totalLinks: 0, remoteLinks: 0, localLinks: 0, brokenLinks: 0, otherLinks: 0, nonMediaLinks: 0, actionableRemoteLinks: 0, assignedRemoteLinks: 0 };
    await app.database.db.insert(schema.scanRuns).values({ jobId: job!.id, status: "completed", options: JSON.stringify(options), startedAt: timestamp, finishedAt: timestamp, ...totals });
  }

  it("warns when storage scans are missing or older than a day without blocking purges", async () => {
    // Recent sightings from symlink scans do not count as storage scans once scan runs exist.
    await storageFile("local", "movies/Gone (1999)/Gone (1999).mkv");
    await storageFile("remote", "Some.Release/release.mkv");
    await completedScan({ scanSymlinks: false, scanLocal: true, scanRemote: false, localSections: ["movies"] }, new Date(Date.now() - 2 * 86_400_000));

    let local = await listOrphanReview(app.database.db, "local", 7);
    expect(local).toMatchObject({ storageInventoryAt: null, storageStaleWarning: expect.stringContaining("not been fully scanned") });

    await completedScan({ scanSymlinks: false, scanLocal: true, scanRemote: false, localSections: ["shows"] }, new Date(Date.now() - 3_600_000));
    local = await listOrphanReview(app.database.db, "local", 7);
    expect(Date.now() - Date.parse(local.storageInventoryAt!)).toBeGreaterThan(86_400_000);
    expect(local.storageStaleWarning).toContain("more than 24 hours ago");

    await completedScan({ scanSymlinks: false, scanLocal: true, scanRemote: true, localSections: ["movies", "shows"] }, new Date());
    local = await listOrphanReview(app.database.db, "local", 7);
    expect(local.storageStaleWarning).toBeNull();
    const remote = await listOrphanReview(app.database.db, "remote", 7);
    expect(remote).toMatchObject({ storageInventoryAt: expect.any(String), storageStaleWarning: null });
    expect(remote.items).toHaveLength(1);
  });
});

describe("orphan purge", () => {
  beforeEach(async () => {
    const anchor = await storageFile("local", "movies/Anchor (2000)/Anchor (2000).mkv");
    await mediaLink("movies", "Anchor (2000)", "Anchor (2000).mkv", anchor.filePath);
  });

  it("holds files with their sidecars, removes the empty folder, and restores them", async () => {
    const orphan = await storageFile("local", "movies/Gone (1999)/Gone (1999).mkv");
    const subtitle = path.join(paths.localDir, "movies/Gone (1999)/Gone (1999).en.srt");
    await fs.writeFile(subtitle, "1\n00:00:01,000 --> 00:00:02,000\nhi\n");
    expect(await purge("local", [orphan.id], "hold")).toMatchObject({ status: "completed" });
    await expect(fs.stat(orphan.filePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(path.join(paths.localDir, "movies/Gone (1999)"))).rejects.toMatchObject({ code: "ENOENT" });
    const [held] = await listHeldOrphans(app.database.db);
    expect(held).toMatchObject({ filePath: orphan.filePath, rootType: "local" });
    expect(held!.heldPath.startsWith(path.join(paths.localDir, ".srtl-purged"))).toBe(true);
    expect((await listOrphanReview(app.database.db, "local", 7)).items.map((item) => item.storageFileId)).not.toContain(orphan.id);

    expect(await restoreHeldOrphans(app.database.db, paths, [held!.operationId])).toEqual({ restored: 1, errors: [] });
    await expect(fs.readFile(orphan.filePath, "utf8")).resolves.toContain("bytes of");
    await expect(fs.stat(subtitle)).resolves.toBeTruthy();
    expect(await listHeldOrphans(app.database.db)).toEqual([]);
    await expect(fs.stat(path.join(paths.localDir, ".srtl-purged"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("deletes immediately and permanently deletes held files after their holding period", async () => {
    const deleted = await storageFile("local", "movies/Deleted (1990)/Deleted (1990).mkv");
    const held = await storageFile("local", "movies/Held (1991)/Held (1991).mkv");
    expect(await purge("local", [deleted.id], "delete")).toMatchObject({ status: "completed" });
    await expect(fs.stat(deleted.filePath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await purge("local", [held.id], "hold")).toMatchObject({ status: "completed" });
    const [entry] = await listHeldOrphans(app.database.db);
    expect(await expireHeldOrphans(app.database.db, paths, Date.now())).toBe(0);
    expect(await expireHeldOrphans(app.database.db, paths, Date.parse(entry!.purgeAfter) + 1000)).toBe(1);
    await expect(fs.stat(entry!.heldPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(path.join(paths.localDir, ".srtl-purged"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses files that became linked, changed, or were modified recently, without touching them", async () => {
    const relinked = await storageFile("local", "movies/Relinked (2001)/Relinked (2001).mkv");
    const changed = await storageFile("local", "movies/Changed (2002)/Changed (2002).mkv");
    const jobId = await app.jobs.startOrphanPurge("local", [relinked.id, changed.id], "delete");
    await mediaLink("movies", "Relinked (2001)", "Relinked (2001).mkv", relinked.filePath);
    await fs.appendFile(changed.filePath, " more bytes");
    await fs.utimes(changed.filePath, oldTime, oldTime);
    await runJobs();
    expect(await app.jobs.getJob(jobId)).toMatchObject({ status: "failed" });
    await expect(fs.stat(relinked.filePath)).resolves.toBeTruthy();
    await expect(fs.stat(changed.filePath)).resolves.toBeTruthy();
    const events = (await app.jobs.listEvents(jobId)).map((event) => JSON.stringify(event.data));
    expect(events.join()).toContain("no longer an orphan");
    expect(events.join()).toContain("changed after it was inventoried");

    const fresh = await storageFile("local", "movies/Fresh (2026)/Fresh (2026).mkv", { mtime: new Date() });
    await expect(app.jobs.startOrphanPurge("local", [fresh.id], "delete")).rejects.toThrow("Modified in the last 24 hours");
  });

  it("finds a live symlink in the title folder even when the inventory missed it", async () => {
    const orphan = await storageFile("local", "movies/Unscanned (2003)/Unscanned (2003).mkv");
    const jobId = await app.jobs.startOrphanPurge("local", [orphan.id], "delete");
    await fs.mkdir(path.join(paths.symlinkDir, "movies/Unscanned (2003)"), { recursive: true });
    await fs.symlink(orphan.filePath, path.join(paths.symlinkDir, "movies/Unscanned (2003)/Unscanned (2003).mkv"));
    await runJobs();
    expect(await app.jobs.getJob(jobId)).toMatchObject({ status: "failed" });
    await expect(fs.stat(orphan.filePath)).resolves.toBeTruthy();
  });

  it("refuses to queue a purge when the symlink inventory is stale", async () => {
    await app.database.db.update(schema.mediaLinks).set({ lastSeenAt: new Date(Date.now() - 2 * 86_400_000).toISOString() });
    const orphan = await storageFile("local", "movies/Gone (1999)/Gone (1999).mkv");
    await expect(app.jobs.startOrphanPurge("local", [orphan.id], "delete")).rejects.toThrow("more than 24 hours ago");
  });

  it("purges remote orphans and exposes the review over HTTP", async () => {
    const remote = await storageFile("remote", "Some.Release.2019/Some.Release.mkv");
    const setup = await app.app.inject({ method: "POST", url: "/api/auth/setup", payload: { setupToken: readSetupToken(app), username: "fixture", password: "fixture-password-123", confirmPassword: "fixture-password-123" } });
    const cookie = String(setup.headers["set-cookie"]);
    const review = await app.app.inject({ method: "GET", url: "/api/orphans?rootType=remote", headers: { cookie } });
    expect(review.json().items).toEqual([expect.objectContaining({ storageFileId: remote.id, category: "unlinked" })]);
    const queued = await app.app.inject({ method: "POST", url: "/api/orphans/purge", headers: { cookie }, payload: { rootType: "remote", storageFileIds: [remote.id], mode: "delete" } });
    expect(queued.statusCode).toBe(200);
    // The purge is recorded with who asked, when, and which items, and the job's own log says so too.
    const { jobId: purgeJobId } = queued.json<{ jobId: number }>();
    const trail = await app.app.inject({ method: "GET", url: "/api/system/action-audit", headers: { cookie } });
    expect(trail.statusCode).toBe(200);
    expect(trail.json()).toEqual([
      expect.objectContaining({
        action: "orphan.purge_delete",
        at: expect.any(String),
        actor: { userId: expect.any(Number), username: "fixture" },
        ip: expect.any(String),
        requestId: queued.headers["x-request-id"],
        targets: { jobId: purgeJobId, rootType: "remote", mode: "delete", storageFileIds: [remote.id], folderIds: [] }
      })
    ]);
    expect((await app.jobs.listEvents(purgeJobId)).map((event) => event.message)).toContain("Deleted 1 orphan file(s) and 0 folder(s) on remote storage (requested by fixture from 127.0.0.1)");
    await runJobs();
    await expect(fs.stat(remote.filePath)).rejects.toMatchObject({ code: "ENOENT" });
    const [row] = await app.database.db.select().from(schema.storageFiles).where(eq(schema.storageFiles.id, remote.id));
    expect(row!.missingSince).not.toBeNull();
  });
});

describe("folders with no video", () => {
  beforeEach(async () => {
    const anchor = await storageFile("local", "movies/Anchor (2000)/Anchor (2000).mkv");
    await mediaLink("movies", "Anchor (2000)", "Anchor (2000).mkv", anchor.filePath);
  });

  async function leftoverFolder(rootType: "local" | "remote", relativePath: string, entries: Record<string, string> = {}, mtime = oldTime) {
    const base = rootType === "local" ? paths.localDir : paths.remoteDir;
    const dirPath = path.join(base, relativePath);
    await fs.mkdir(dirPath, { recursive: true });
    for (const [name, content] of Object.entries(entries)) {
      await fs.mkdir(path.dirname(path.join(dirPath, name)), { recursive: true });
      await fs.writeFile(path.join(dirPath, name), content);
      await fs.utimes(path.join(dirPath, name), mtime, mtime);
    }
    for (const directory of [...new Set(Object.keys(entries).map((name) => path.dirname(path.join(dirPath, name))))].sort().reverse()) await fs.utimes(directory, mtime, mtime);
    await fs.utimes(dirPath, mtime, mtime);
    const [row] = await app.database.db
      .insert(schema.storageLeftoverFolders)
      .values({
        rootType,
        dirPath,
        relativePath,
        fileCount: Object.keys(entries).length,
        totalBytes: Object.values(entries).reduce((total, content) => total + content.length, 0),
        newestMtimeMs: mtime.getTime(),
        lastSeenJobId: 0,
        updatedAt: new Date().toISOString()
      })
      .returning();
    return row!;
  }

  it("lists folders with protections and purges them with files in one job", async () => {
    const gone = await leftoverFolder("local", "movies/Gone (1999)", { "gone.srt": "subtitle", "art/poster.jpg": "art" });
    const fresh = await leftoverFolder("local", "movies/Fresh (2026)", { "fresh.srt": "new" }, new Date());
    const linked = await leftoverFolder("local", "movies/Linked (2002)", { "linked.srt": "subtitle" });
    await mediaLink("movies", "Linked (2002)", "linked.srt", path.join(linked.dirPath, "linked.srt"));
    const orphan = await storageFile("local", "movies/Orphan (1998)/Orphan (1998).mkv");

    const review = await listOrphanReview(app.database.db, "local", 7);
    expect(review.leftoverFolders.map((folder) => [folder.relativePath, folder.protectedReason])).toEqual([
      ["movies/Fresh (2026)", "Modified in the last 24 hours"],
      ["movies/Gone (1999)", null],
      ["movies/Linked (2002)", "A symlink points into this folder"]
    ]);
    await expect(app.jobs.startOrphanPurge("local", [], "delete", [fresh.id])).rejects.toThrow("Modified in the last 24 hours");
    await expect(app.jobs.startOrphanPurge("local", [], "delete", [linked.id])).rejects.toThrow("A symlink points into this folder");

    // A folder id may equal a file id in the same job.
    await app.database.db.update(schema.storageLeftoverFolders).set({ id: 500 }).where(eq(schema.storageLeftoverFolders.id, gone.id));
    await app.database.db.update(schema.storageFiles).set({ id: 500 }).where(eq(schema.storageFiles.id, orphan.id));
    const jobId = await app.jobs.startOrphanPurge("local", [500], "hold", [500]);
    await runJobs();
    expect(await app.jobs.getJob(jobId)).toMatchObject({ status: "completed", progress: expect.objectContaining({ held: 2 }) });
    await expect(fs.stat(gone.dirPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await app.database.db.select().from(schema.storageLeftoverFolders).where(eq(schema.storageLeftoverFolders.id, 500))).toEqual([]);

    const held = await listHeldOrphans(app.database.db);
    const heldFolder = held.find((entry) => entry.filePath === gone.dirPath)!;
    await expect(fs.readFile(path.join(heldFolder.heldPath, "art", "poster.jpg"), "utf8")).resolves.toBe("art");
    expect(await restoreHeldOrphans(app.database.db, paths, [heldFolder.operationId])).toEqual({ restored: 1, errors: [] });
    await expect(fs.readFile(path.join(gone.dirPath, "gone.srt"), "utf8")).resolves.toBe("subtitle");
    // The restored folder's file row is untouched; it reappears as a leftover on the next storage scan.
    const [orphanRow] = await app.database.db.select().from(schema.storageFiles).where(eq(schema.storageFiles.id, 500));
    expect(orphanRow!.missingSince).not.toBeNull();
  });

  it("deletes folders immediately and expires held folders after their holding period", async () => {
    const deleted = await leftoverFolder("local", "movies/Deleted (1990)", { "a.nfo": "nfo", "Sub/b.srt": "srt" });
    const empty = await leftoverFolder("remote", "Empty.Release");
    const held = await leftoverFolder("local", "shows/Held Show (1991)/Season 01", { "c.srt": "srt" });
    await expect(app.jobs.startOrphanPurge("local", [], "delete")).rejects.toThrow("Choose at least one orphan file or folder");
    const deleteJob = await app.jobs.startOrphanPurge("local", [], "delete", [deleted.id]);
    const remoteJob = await app.jobs.startOrphanPurge("remote", [], "delete", [empty.id]);
    const holdJob = await app.jobs.startOrphanPurge("local", [], "hold", [held.id]);
    await runJobs();
    for (const jobId of [deleteJob, remoteJob, holdJob]) expect(await app.jobs.getJob(jobId)).toMatchObject({ status: "completed" });
    await expect(fs.stat(deleted.dirPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(empty.dirPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(path.join(paths.localDir, "shows", "Held Show (1991)"))).resolves.toBeTruthy();

    const [entry] = await listHeldOrphans(app.database.db);
    expect(entry).toMatchObject({ filePath: held.dirPath });
    expect(await expireHeldOrphans(app.database.db, paths, Date.parse(entry!.purgeAfter) + 1000)).toBe(1);
    await expect(fs.stat(entry!.heldPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(path.join(paths.localDir, ".srtl-purged"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses folders that gained a video, a symlink, a recent change, or an unfinished copy", async () => {
    const video = await leftoverFolder("local", "movies/Video (2001)", { "a.srt": "srt" });
    const symlinked = await leftoverFolder("local", "movies/Symlinked (2002)", { "a.srt": "srt" });
    const touched = await leftoverFolder("local", "movies/Touched (2003)", { "a.srt": "srt" });
    const copying = await leftoverFolder("local", "movies/Copying (2004)", { "a.srt": "srt" });
    const sectionRoot = await leftoverFolder("local", "shows", { "a.srt": "srt" });
    await expect(app.jobs.startOrphanPurge("local", [], "delete", [9_999])).rejects.toThrow("no longer a folder without video");
    const jobId = await app.jobs.startOrphanPurge("local", [], "delete", [video.id, symlinked.id, touched.id, copying.id, sectionRoot.id]);

    await fs.writeFile(path.join(video.dirPath, "Video (2001).mkv"), "video");
    await fs.utimes(path.join(video.dirPath, "Video (2001).mkv"), oldTime, oldTime);
    await fs.symlink("/nowhere", path.join(symlinked.dirPath, "pointer"));
    // Adding entries also bumps each folder's own mtime, which on its own would stop the purge.
    await fs.utimes(video.dirPath, oldTime, oldTime);
    await fs.utimes(symlinked.dirPath, oldTime, oldTime);
    await fs.writeFile(path.join(touched.dirPath, "a.srt"), "edited");
    const timestamp = new Date().toISOString();
    await app.database.db.insert(schema.jobs).values({ id: 901, type: "copy", status: "failed", createdAt: timestamp, progress: "{}" });
    const destination = path.join(copying.dirPath, "Copying (2004).mkv");
    await app.database.db.insert(schema.copyOperations).values({ jobId: 901, mediaLinkId: 1, linkPath: "/x", sourcePath: "/remote/c.mkv", destinationPath: destination, originalTargetPath: "/remote/c.mkv", originalLinkState: "symlink", stage: "transferring", createdAt: timestamp, updatedAt: timestamp });
    await runJobs();

    expect(await app.jobs.getJob(jobId)).toMatchObject({ status: "failed" });
    for (const folder of [video, symlinked, touched, copying, sectionRoot]) await expect(fs.stat(folder.dirPath)).resolves.toBeTruthy();
    const events = (await app.jobs.listEvents(jobId)).map((event) => JSON.stringify(event.data)).join();
    expect(events).toContain("Folder now contains a video");
    expect(events).toContain("symlink or special file");
    expect(events).toContain("modified in the last 24 hours");
    expect(events).toContain("unfinished copy");
    expect(events).toContain("Only folders inside a storage title area can be purged");
  });

  it("accepts folder ids over HTTP", async () => {
    const folder = await leftoverFolder("remote", "Sample.Only", { "sample.txt": "sample" });
    const setup = await app.app.inject({ method: "POST", url: "/api/auth/setup", payload: { setupToken: readSetupToken(app), username: "fixture", password: "fixture-password-123", confirmPassword: "fixture-password-123" } });
    const cookie = String(setup.headers["set-cookie"]);
    const review = await app.app.inject({ method: "GET", url: "/api/orphans?rootType=remote", headers: { cookie } });
    expect(review.json().leftoverFolders).toEqual([expect.objectContaining({ folderId: folder.id, fileCount: 1, protectedReason: null })]);
    const empty = await app.app.inject({ method: "POST", url: "/api/orphans/purge", headers: { cookie }, payload: { rootType: "remote", mode: "delete" } });
    expect(empty.statusCode).toBe(400);
    const queued = await app.app.inject({ method: "POST", url: "/api/orphans/purge", headers: { cookie }, payload: { rootType: "remote", folderIds: [folder.id], mode: "delete" } });
    expect(queued.statusCode).toBe(200);
    const audit = (await app.app.inject({ method: "GET", url: "/api/system/action-audit", headers: { cookie } })).json<Array<{ action: string; targets: Record<string, unknown> }>>();
    expect(audit).toEqual([expect.objectContaining({ action: "orphan.purge_delete", targets: expect.objectContaining({ folderIds: [folder.id], storageFileIds: [] }) })]);
    await runJobs();
    await expect(fs.stat(folder.dirPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("remote source deletion after copy", () => {
  async function remoteLinkedMovie(name: string) {
    const sourcePath = path.join(paths.remoteDir, `${name}.mkv`);
    await fs.writeFile(sourcePath, `remote bytes for ${name}`);
    const link = await mediaLink("movies", name, `${name}.mkv`, sourcePath);
    await app.database.db.update(schema.mediaLinks).set({ storagePolicy: "location_1", sizeBytes: (await fs.stat(sourcePath)).size }).where(eq(schema.mediaLinks.id, link.id));
    return { sourcePath, link };
  }
  const passingRunner = {
    async copyFile(source: string, target: string) { await fs.copyFile(source, target); },
    async runCmp(source: string, target: string) {
      const [left, right] = await Promise.all([fs.readFile(source), fs.readFile(target)]);
      return { status: left.equals(right) ? "pass" as const : "fail" as const, output: "" };
    },
    async runFfmpeg() { return { status: "pass" as const, output: "" }; }
  };

  it("deletes the verified remote source only when the setting was on at admission", async () => {
    const kept = await remoteLinkedMovie("Kept Movie (2010)");
    const keptJob = await app.jobs.startCopy({ direction: "to_local", linkIds: [kept.link.id] });
    await setSetting(app.database.db, "advancedSettings", { cleanup: { holdDays: 7, deleteRemoteSourceAfterCopy: true } });
    const removed = await remoteLinkedMovie("Removed Movie (2011)");
    const removedJob = await app.jobs.startCopy({ direction: "to_local", linkIds: [removed.link.id] });
    const worker = new JobWorker(app.database.db, { workerId: "copy-test", logger: quietLogger, copyRunner: passingRunner });
    while (await worker.runOnce()) {
      // drain
    }
    expect(await app.jobs.getJob(keptJob)).toMatchObject({ status: "completed" });
    expect(await app.jobs.getJob(removedJob)).toMatchObject({ status: "completed" });
    await expect(fs.stat(kept.sourcePath)).resolves.toBeTruthy();
    await expect(fs.stat(removed.sourcePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.readFile(path.join(paths.localDir, "movies", "Removed Movie (2011)", "Removed Movie (2011).mkv"), "utf8")).resolves.toContain("remote bytes");
    expect((await app.jobs.listEvents(removedJob)).map((event) => event.message)).toContain("Deleted remote source after verified copy");
  });
});
