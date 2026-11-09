import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, type AppContext } from "../src/server/app";
import { setSetting } from "../src/server/db/database";
import * as schema from "../src/server/db/schema";
import { JobWorker } from "../src/server/jobs/jobRunner";
import { deleteFolderFileByFile, episodeKey, episodeKeys, expireHeldOrphans, listHeldOrphans, listOrphanReview, restoreHeldOrphans, type FolderDeleteFs } from "../src/server/jobs/orphanPurge";
import { configureExtraSymlinkFolders, extraSymlinkFolderProblems, parseExtraSymlinkFolders } from "../src/server/lib/extraSymlinkFolders";
import { markOnboardingCompleteForExistingInstall } from "../src/server/lib/onboarding";
import { persistSectionSettings } from "../src/server/lib/sectionSettings";
import type { JobRecord, OrphanPurgeItemPage, OrphanPurgeJobProgress, OrphanReview, PathsSettings } from "../src/shared/types";
import { createTestDatabase, type TestDatabaseHandle } from "./testDb";
import { readSetupToken } from "./authHelpers";
import { recordSymlinkScan } from "./scanFixtures";

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

// A library link to a folder or to a file SRTL does not treat as video, as a scan records it.
async function plainLink(section: string, itemName: string, name: string, targetPath: string) {
  const relativePath = `${itemName}/${name}`;
  const linkPath = path.join(paths.symlinkDir, section, relativePath);
  await fs.mkdir(path.dirname(linkPath), { recursive: true });
  await fs.symlink(targetPath, linkPath);
  const timestamp = new Date().toISOString();
  const [row] = await app.database.db
    .insert(schema.mediaLinks)
    .values({ section, itemName, relativePath, linkPath, targetPath, kind: "non_media", targetExists: true, isMedia: false, storagePolicy: "unassigned", lastSeenAt: timestamp, updatedAt: timestamp })
    .returning();
  return row!;
}

const completedSymlinkScan = (options: Parameters<typeof recordSymlinkScan>[1] = {}) => recordSymlinkScan(app.database.db, options);

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
  await completedSymlinkScan();
});

afterEach(async () => {
  configureExtraSymlinkFolders([]);
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

describe("symlink inventory freshness", () => {
  const anHourAgo = () => new Date(Date.now() - 3_600_000);
  const threeDaysAgo = () => new Date(Date.now() - 3 * 86_400_000);

  async function setUpOrphan() {
    await app.database.db.delete(schema.scanRuns);
    const linked = await storageFile("local", "movies/Stale (2001)/Stale (2001).mkv");
    await mediaLink("movies", "Stale (2001)", "Stale (2001).mkv", linked.filePath, threeDaysAgo().toISOString());
    return storageFile("local", "movies/Gone (1999)/Gone (1999).mkv");
  }

  it("does not let a rescan of one title make the rest of its section look scanned", async () => {
    const orphan = await setUpOrphan();
    await completedSymlinkScan({ sections: ["movies"], startedAt: threeDaysAgo() });
    const rescanned = await storageFile("local", "movies/Rescanned (2002)/Rescanned (2002).mkv");
    await mediaLink("movies", "Rescanned (2002)", "Rescanned (2002).mkv", rescanned.filePath);
    await completedSymlinkScan({ sections: ["movies"], startedAt: anHourAgo(), titleScopes: [{ section: "movies", itemName: "Rescanned (2002)" }] });
    await expect(app.jobs.startOrphanPurge("local", [orphan.id], "delete")).rejects.toThrow(/last complete symlink scan of movies started more than 24 hours ago.*Run a full symlink scan/);
    expect((await listOrphanReview(app.database.db, "local", 7)).staleWarning).toContain("A rescan of a single title does not count");
  });

  it("does not count scans that failed, were cancelled, or skipped symlinks", async () => {
    const orphan = await setUpOrphan();
    await completedSymlinkScan({ status: "failed", sections: ["movies"], startedAt: anHourAgo() });
    await completedSymlinkScan({ status: "cancelled", sections: ["movies"], startedAt: anHourAgo() });
    await completedSymlinkScan({ scanSymlinks: false, sections: ["movies"], startedAt: anHourAgo() });
    await expect(app.jobs.startOrphanPurge("local", [orphan.id], "delete")).rejects.toThrow(/No complete symlink scan has finished for movies/);
  });

  it("needs every section with links scanned, separately or together", async () => {
    const orphan = await setUpOrphan();
    const episode = await storageFile("local", "shows/Show (2001)/Season 01/Show (2001) - S01E01.mkv");
    await mediaLink("shows", "Show (2001)", "Season 01/Show (2001) - S01E01.mkv", episode.filePath);
    await completedSymlinkScan({ sections: ["movies"], startedAt: anHourAgo() });
    await expect(app.jobs.startOrphanPurge("local", [orphan.id], "delete")).rejects.toThrow(/No complete symlink scan has finished for shows/);
    await completedSymlinkScan({ sections: ["shows"], startedAt: threeDaysAgo() });
    await expect(app.jobs.startOrphanPurge("local", [orphan.id], "delete")).rejects.toThrow(/of shows started more than 24 hours ago/);
    await completedSymlinkScan({ sections: ["shows"], startedAt: anHourAgo() });
    await expect(app.jobs.startOrphanPurge("local", [orphan.id], "delete")).resolves.toEqual(expect.any(Number));
    const review = await listOrphanReview(app.database.db, "local", 7);
    expect(review.staleWarning).toBeNull();
    expect(Date.now() - Date.parse(review.symlinkInventoryAt!)).toBeLessThan(2 * 3_600_000);
  });

  it("judges a scan by when it started, since links made during it may not have been seen", async () => {
    const orphan = await setUpOrphan();
    await completedSymlinkScan({ sections: ["movies"], startedAt: new Date(Date.now() - 25 * 3_600_000), finishedAt: new Date() });
    await expect(app.jobs.startOrphanPurge("local", [orphan.id], "delete")).rejects.toThrow("more than 24 hours ago");
  });

  it("does not let a section with no links hold purges up, unless its folder holds something unscanned", async () => {
    const orphan = await setUpOrphan();
    await completedSymlinkScan({ sections: ["movies"], startedAt: anHourAgo() });
    // The shows section has no links and no folder.
    expect((await listOrphanReview(app.database.db, "local", 7)).staleWarning).toBeNull();
    await fs.mkdir(path.join(paths.symlinkDir, "shows"), { recursive: true });
    expect((await listOrphanReview(app.database.db, "local", 7)).staleWarning).toBeNull();
    // A new section can be full of links nobody has scanned yet, and those files would look like orphans.
    await fs.mkdir(path.join(paths.symlinkDir, "shows/Unscanned (2003)"));
    await fs.symlink(orphan.filePath, path.join(paths.symlinkDir, "shows/Unscanned (2003)/link.mkv"));
    await expect(app.jobs.startOrphanPurge("local", [orphan.id], "delete")).rejects.toThrow(/No complete symlink scan has finished for shows/);
    await completedSymlinkScan({ sections: ["shows"], startedAt: anHourAgo() });
    await expect(app.jobs.startOrphanPurge("local", [orphan.id], "delete")).resolves.toEqual(expect.any(Number));
  });

  it("ignores links left in a section that is no longer configured", async () => {
    const orphan = await setUpOrphan();
    await completedSymlinkScan({ sections: ["movies"], startedAt: anHourAgo() });
    await mediaLink("archive", "Old (1980)", "Old (1980).mkv", path.join(paths.localDir, "archive/Old (1980)/Old (1980).mkv"), threeDaysAgo().toISOString());
    await expect(app.jobs.startOrphanPurge("local", [orphan.id], "delete")).resolves.toEqual(expect.any(Number));
  });
});

describe("episode keys", () => {
  it("reads single and multi-episode names", () => {
    expect(episodeKeys("Show - S01E02 [WEBDL-1080p].mkv")).toEqual(["s1e2"]);
    expect(episodeKeys("Show - S01E01E02.mkv")).toEqual(["s1e1", "s1e2"]);
    expect(episodeKeys("Show - s01e01-e03.mkv")).toEqual(["s1e1", "s1e2", "s1e3"]);
    expect(episodeKeys("Show - S01E01-02.mkv")).toEqual(["s1e1", "s1e2"]);
    expect(episodeKeys("Show - S01E01-1080p.mkv")).toEqual(["s1e1"]);
    expect(episodeKeys("Show - S1941E38.mkv")).toEqual(["s1941e38"]);
    expect(episodeKeys("Show - S01E01-E99.mkv")).toEqual(["s1e1"]);
    expect(episodeKeys("Movie (2001) [Bluray-1080p].mkv")).toEqual([]);
    expect(episodeKey("Show - S01E01E02.mkv")).toBe("s1e1");
    expect(episodeKey("Movie (2001).mkv")).toBeNull();
  });
});

describe("orphan review labels", () => {
  async function libraryTitle(section: string, itemName: string, fileName = `${itemName}.mkv`) {
    const file = await storageFile("local", `${section}/${itemName}/${fileName}`, { content: "x".repeat(1000) });
    await mediaLink(section, itemName, fileName, file.filePath);
    await app.database.db.update(schema.mediaLinks).set({ sizeBytes: 1000 }).where(eq(schema.mediaLinks.targetPath, file.filePath));
    return file;
  }
  const findItem = (items: Awaited<ReturnType<typeof listOrphanReview>>["items"], id: number) => items.find((item) => item.storageFileId === id);

  it("splits remote unlinked files by whether the release name looks like a library title, keeping the category", async () => {
    await libraryTitle("movies", "Alpha Bravo (2020)");
    const match = await storageFile("remote", "Alpha.Bravo.2020.1080p.WEB-DL.x264-GRP/Alpha.Bravo.2020.1080p.mkv");
    const otherYear = await storageFile("remote", "Alpha.Bravo.1990.1080p.BluRay.x264-GRP/file.mkv");
    const noMatch = await storageFile("remote", "Charlie.Delta.2015.720p.WEB-DL-GRP/file.mkv");
    const lone = await storageFile("remote", "Alpha.Bravo.2020.2160p.mkv");
    const review = await listOrphanReview(app.database.db, "remote", 7);
    expect(findItem(review.items, match.id)).toMatchObject({ category: "unlinked", label: "title_in_library", matchedTitle: "Alpha Bravo (2020)", releaseName: "Alpha.Bravo.2020.1080p.WEB-DL.x264-GRP" });
    expect(findItem(review.items, otherYear.id)).toMatchObject({ category: "unlinked", label: "no_title_match", matchedTitle: null });
    expect(findItem(review.items, noMatch.id)).toMatchObject({ category: "unlinked", label: "no_title_match" });
    expect(findItem(review.items, lone.id)).toMatchObject({ label: "title_in_library", releaseName: "Alpha.Bravo.2020.2160p" });
    expect(review.summary).toEqual([expect.objectContaining({ category: "unlinked", count: 4 })]);
    expect(review.labelSummary).toEqual([expect.objectContaining({ label: "title_in_library", count: 2 }), expect.objectContaining({ label: "no_title_match", count: 2 })]);
  });

  it("tells a release whose title is in the library apart when its episode is not linked, without changing what can be purged", async () => {
    await libraryTitle("shows", "Lima (2016)", "Season 01/Lima (2016) - S01E01.mkv");
    const linkedEpisode = await storageFile("remote", "Lima.2016.S01.1080p/Lima.2016.S01E01.mkv");
    const unlinkedEpisode = await storageFile("remote", "Lima.2016.S01.1080p/Lima.2016.S01E02.mkv");
    const partly = await storageFile("remote", "Lima.2016.S01.1080p/Lima.2016.S01E01E02.mkv");
    const noEpisode = await storageFile("remote", "Lima.2016.S01.1080p/Lima.2016.Extras.mkv");
    const review = await listOrphanReview(app.database.db, "remote", 7);
    expect(findItem(review.items, linkedEpisode.id)).toMatchObject({ category: "unlinked", label: "title_in_library", matchedTitle: "Lima (2016)", protectedReason: null });
    expect(findItem(review.items, unlinkedEpisode.id)).toMatchObject({ category: "unlinked", label: "episode_not_linked", matchedTitle: "Lima (2016)", protectedReason: null });
    expect(findItem(review.items, partly.id)).toMatchObject({ label: "episode_not_linked" });
    expect(findItem(review.items, noEpisode.id)).toMatchObject({ label: "title_in_library" });
    expect(review.labelSummary.find((entry) => entry.label === "episode_not_linked")).toMatchObject({ count: 2, purgeableCount: 2 });
    await expect(app.jobs.startOrphanPurge("remote", [unlinkedEpisode.id], "delete")).resolves.toEqual(expect.any(Number));
  });

  it("checks every library title with the same name for an episode", async () => {
    await libraryTitle("shows", "Mike (1999)", "Season 01/Mike (1999) - S01E01.mkv");
    await libraryTitle("shows", "Mike (2015)", "Season 01/Mike (2015) - S01E02.mkv");
    const inFirst = await storageFile("remote", "Mike.S01.1080p/Mike.S01E01.mkv");
    const inSecond = await storageFile("remote", "Mike.S01.1080p/Mike.S01E02.mkv");
    const inNeither = await storageFile("remote", "Mike.S01.1080p/Mike.S01E03.mkv");
    // The year says which one it is, so the other title's episodes do not count.
    const dated = await storageFile("remote", "Mike.2015.S01.1080p/Mike.2015.S01E01.mkv");
    const review = await listOrphanReview(app.database.db, "remote", 7);
    expect(findItem(review.items, inFirst.id)).toMatchObject({ label: "title_in_library", matchedTitle: "Mike (1999)" });
    expect(findItem(review.items, inSecond.id)).toMatchObject({ label: "title_in_library" });
    expect(findItem(review.items, inNeither.id)).toMatchObject({ label: "episode_not_linked" });
    expect(findItem(review.items, dated.id)).toMatchObject({ label: "episode_not_linked", matchedTitle: "Mike (2015)" });
  });

  it("checks titles in different sections separately", async () => {
    await persistSectionSettings(app.database.db, { sections: ["movies", "shows", "shows4k"], sectionTypes: { movies: "movies", shows: "shows", shows4k: "shows" } });
    await recordSymlinkScan(app.database.db);
    await libraryTitle("shows4k", "November (2017)", "Season 01/November (2017) - S01E04.mkv");
    await libraryTitle("shows", "November (2017)", "Season 01/November (2017) - S01E05.mkv");
    const inOne = await storageFile("remote", "November.2017.S01/November.2017.S01E04.mkv");
    expect(findItem((await listOrphanReview(app.database.db, "remote", 7)).items, inOne.id)).toMatchObject({ label: "title_in_library" });
  });

  it("does not expect episodes from a title in a movies section", async () => {
    await libraryTitle("movies", "Oscar Papa (2018)");
    const file = await storageFile("remote", "Oscar.Papa.2018.1080p/Oscar.Papa.S01E01.mkv");
    expect(findItem((await listOrphanReview(app.database.db, "remote", 7)).items, file.id)).toMatchObject({ label: "title_in_library" });
  });

  it("shows whether nothing in a release is linked or only part of it", async () => {
    const linked = await storageFile("remote", "Pack.S01.1080p/Pack.S01E01.mkv");
    await mediaLink("shows", "Pack (2010)", "Season 01/Pack.S01E01.mkv", linked.filePath);
    const packed = await storageFile("remote", "Pack.S01.1080p/Pack.S01E02.mkv");
    const packedTwo = await storageFile("remote", "Pack.S01.1080p/Pack.S01E03.mkv");
    const whole = await storageFile("remote", "Other.S02.1080p/Other.S02E01.mkv");
    const wholeTwo = await storageFile("remote", "Other.S02.1080p/Other.S02E02.mkv");
    const review = await listOrphanReview(app.database.db, "remote", 7);
    for (const file of [packed, packedTwo]) expect(findItem(review.items, file.id)).toMatchObject({ releaseStatus: "partly_linked", releaseFileCount: 3, releaseLinkedCount: 1 });
    for (const file of [whole, wholeTwo]) expect(findItem(review.items, file.id)).toMatchObject({ releaseStatus: "none_linked", releaseFileCount: 2, releaseLinkedCount: 0 });
  });

  it("does not treat files loose in a virtual folder as one release", async () => {
    const linked = await storageFile("remote", "__all__/Echo.2001.mkv");
    await mediaLink("movies", "Echo (2001)", "Echo (2001).mkv", linked.filePath);
    const loose = await storageFile("remote", "__all__/Foxtrot.2002.mkv");
    const review = await listOrphanReview(app.database.db, "remote", 7);
    expect(findItem(review.items, loose.id)).toMatchObject({ releaseStatus: "none_linked", releaseName: "Foxtrot.2002", releaseFileCount: 1 });
  });

  it("compares a superseded file's size with the linked file, and flags only larger ones", async () => {
    await libraryTitle("movies", "Golf (2011)");
    const larger = await storageFile("local", "movies/Golf (2011)/Golf (2011) Larger.mkv", { content: "x".repeat(4000) });
    const smaller = await storageFile("local", "movies/Golf (2011)/Golf (2011) Smaller.mkv", { content: "x".repeat(10) });
    const same = await storageFile("local", "movies/Golf (2011)/Golf (2011) Same.mkv", { content: "x".repeat(1000) });
    const elsewhere = await storageFile("local", "movies/Hotel (2012)/Hotel (2012).mkv");
    const review = await listOrphanReview(app.database.db, "local", 7);
    expect(findItem(review.items, larger.id)).toMatchObject({ category: "superseded", linkedSizeBytes: 1000, sizeComparison: "larger" });
    expect(findItem(review.items, smaller.id)).toMatchObject({ linkedSizeBytes: 1000, sizeComparison: "smaller" });
    expect(findItem(review.items, same.id)).toMatchObject({ linkedSizeBytes: 1000, sizeComparison: "same" });
    expect(findItem(review.items, elsewhere.id)).toMatchObject({ category: "not_in_library", linkedSizeBytes: null, sizeComparison: null });
  });

  it("uses the stored file's size when the link has none recorded", async () => {
    const file = await libraryTitle("movies", "India (2013)");
    await app.database.db.update(schema.mediaLinks).set({ sizeBytes: null, resolvedStorageFileId: file.id }).where(eq(schema.mediaLinks.targetPath, file.filePath));
    const larger = await storageFile("local", "movies/India (2013)/India (2013) Larger.mkv", { content: "x".repeat(2000) });
    expect(findItem((await listOrphanReview(app.database.db, "local", 7)).items, larger.id)).toMatchObject({ linkedSizeBytes: 1000, sizeComparison: "larger" });
  });

  it("only calls a multi-episode file superseded when every episode it holds is linked", async () => {
    await libraryTitle("shows", "Juliet (2014)", "Season 01/Juliet (2014) - S01E01.mkv");
    const partly = await storageFile("local", "shows/Juliet (2014)/Season 01/Juliet (2014) - S01E01E02.mkv");
    const review = await listOrphanReview(app.database.db, "local", 7);
    // Deleting it would lose the only copy of episode 2.
    expect(findItem(review.items, partly.id)).toMatchObject({ category: "not_in_library", label: "not_in_library", episodeCoverage: { linked: 1, total: 2 }, linkedSizeBytes: null });

    await libraryTitle("shows", "Juliet (2014)", "Season 01/Juliet (2014) - S01E02.mkv");
    const covered = await listOrphanReview(app.database.db, "local", 7);
    expect(findItem(covered.items, partly.id)).toMatchObject({ category: "superseded", episodeCoverage: { linked: 2, total: 2 }, linkedSizeBytes: 2000 });
  });

  it("sees episodes held by a multi-episode link", async () => {
    await libraryTitle("shows", "Kilo (2015)", "Season 01/Kilo (2015) - S01E01E02.mkv");
    const single = await storageFile("local", "shows/Kilo (2015)/Season 01/Kilo (2015) - S01E02.mkv");
    const other = await storageFile("local", "shows/Kilo (2015)/Season 01/Kilo (2015) - S01E03.mkv");
    const review = await listOrphanReview(app.database.db, "local", 7);
    expect(findItem(review.items, single.id)).toMatchObject({ category: "superseded", episodeCoverage: null, linkedSizeBytes: 1000 });
    expect(findItem(review.items, other.id)).toMatchObject({ category: "not_in_library" });
  });
});

describe("extra symlink folders", () => {
  let other: string;

  beforeEach(async () => {
    other = path.join(root, "other-tool");
    await fs.mkdir(other);
    const anchor = await storageFile("local", "movies/Anchor (2000)/Anchor (2000).mkv");
    await mediaLink("movies", "Anchor (2000)", "Anchor (2000).mkv", anchor.filePath);
  });

  async function pointer(name: string, target: string) {
    const link = path.join(other, name);
    await fs.mkdir(path.dirname(link), { recursive: true });
    await fs.symlink(target, link);
    return link;
  }

  it("changes nothing when none are configured", async () => {
    const orphan = await storageFile("remote", "Some.Release.2019/file.mkv");
    await pointer("ignored.mkv", orphan.filePath);
    const review = await listOrphanReview(app.database.db, "remote", 7);
    expect(review.extraSymlinks).toEqual({ folders: [], linkCount: 0, unmatchedCount: 0, problems: [] });
    expect(review.items[0]).toMatchObject({ protectedReason: null, extraLinkPath: null });
    expect(await purge("remote", [orphan.id], "delete")).toMatchObject({ status: "completed" });
    await expect(fs.stat(orphan.filePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("leaves targeted files out of the review, counting them, and refuses to queue them", async () => {
    const target = await storageFile("remote", "Target.Release.2019/file.mkv");
    const free = await storageFile("remote", "Free.Release.2018/file.mkv");
    const link = await pointer("nested/deeper/still/further/file.mkv", target.filePath);
    configureExtraSymlinkFolders([other]);
    const review = await listOrphanReview(app.database.db, "remote", 7);
    expect(review.items.map((item) => item.storageFileId)).toEqual([free.id]);
    expect(review.items[0]).toMatchObject({ protectedReason: null, extraLinkPath: null });
    expect(review.skippedInUse).toEqual({ total: 1, files: 1, folders: 0, byReason: { library_link: 0, extra_link: 1 } });
    expect(review.extraSymlinks).toEqual({ folders: [other], linkCount: 1, unmatchedCount: 0, problems: [] });
    await expect(app.jobs.startOrphanPurge("remote", [target.id], "delete")).rejects.toThrow(`Still linked from ${link}`);
    await expect(fs.stat(target.filePath)).resolves.toBeTruthy();
  });

  it("protects everything under a link to a release folder, and resolves relative links and links to links", async () => {
    const inFolder = await storageFile("remote", "Whole.Release.2017/file.mkv");
    const relative = await storageFile("remote", "Relative.Release.2016/file.mkv");
    const viaLibrary = await storageFile("remote", "Library.Release.2015/file.mkv");
    await pointer("whole", path.dirname(inFolder.filePath));
    await pointer("relative.mkv", path.relative(other, relative.filePath));
    const libraryLink = await mediaLink("movies", "Library (2015)", "Library (2015).mkv", viaLibrary.filePath);
    await pointer("chained.mkv", libraryLink.linkPath);
    await app.database.db.update(schema.mediaLinks).set({ missingSince: new Date().toISOString() }).where(eq(schema.mediaLinks.id, libraryLink.id));
    configureExtraSymlinkFolders([other]);
    const review = await listOrphanReview(app.database.db, "remote", 7);
    expect(review.items).toEqual([]);
    expect(review.skippedInUse).toEqual({ total: 3, files: 3, folders: 0, byReason: { library_link: 0, extra_link: 3 } });
    for (const file of [inFolder, relative, viaLibrary]) await expect(app.jobs.startOrphanPurge("remote", [file.id], "delete")).rejects.toThrow("Still linked from");
  });

  it("rechecks right before each delete and leaves the file when a link has appeared", async () => {
    const target = await storageFile("remote", "Late.Release.2019/file.mkv");
    const free = await storageFile("remote", "Free.Release.2018/file.mkv");
    await pointer("placeholder.mkv", free.filePath.replace("Free", "Missing"));
    configureExtraSymlinkFolders([other]);
    const jobId = await app.jobs.startOrphanPurge("remote", [target.id, free.id], "delete");
    await pointer("late.mkv", target.filePath);
    await runJobs();
    expect(await app.jobs.getJob(jobId)).toMatchObject({ progress: expect.objectContaining({ deleted: 1, failed: 1 }) });
    await expect(fs.stat(target.filePath)).resolves.toBeTruthy();
    await expect(fs.stat(free.filePath)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await app.jobs.listEvents(jobId)).map((event) => JSON.stringify(event.data)).join()).toContain("it is still in use");
  });

  it("refuses when a configured folder cannot be read, is missing, or looks unmounted, rather than treating it as empty", async () => {
    const orphan = await storageFile("remote", "Some.Release.2019/file.mkv");
    const missing = path.join(root, "not-there");
    configureExtraSymlinkFolders([missing]);
    const review = await listOrphanReview(app.database.db, "remote", 7);
    expect(review.extraSymlinks.problems.join()).toContain(`${missing} could not be read (ENOENT)`);
    await expect(app.jobs.startOrphanPurge("remote", [orphan.id], "delete")).rejects.toThrow("Purging is refused");

    configureExtraSymlinkFolders([other]);
    expect((await listOrphanReview(app.database.db, "remote", 7)).extraSymlinks.problems.join()).toContain("is empty");
    await expect(app.jobs.startOrphanPurge("remote", [orphan.id], "delete")).rejects.toThrow("Purging is refused");

    await pointer("placeholder.mkv", "/nowhere/file.mkv");
    const jobId = await app.jobs.startOrphanPurge("remote", [orphan.id], "delete");
    // The folder goes away after the job was queued.
    await fs.rm(other, { recursive: true });
    await runJobs();
    expect(await app.jobs.getJob(jobId)).toMatchObject({ status: "failed" });
    await expect(fs.stat(orphan.filePath)).resolves.toBeTruthy();
    expect((await app.jobs.listEvents(jobId)).map((event) => JSON.stringify(event.data)).join()).toContain("could not be read");
  });

  it("counts links it cannot match to storage, without blocking on them", async () => {
    const orphan = await storageFile("remote", "Some.Release.2019/file.mkv");
    await pointer("other-mount.mkv", "/mnt/elsewhere/Some.Release.2019/file.mkv");
    configureExtraSymlinkFolders([other]);
    const review = await listOrphanReview(app.database.db, "remote", 7);
    expect(review.extraSymlinks).toMatchObject({ linkCount: 1, unmatchedCount: 1, problems: [] });
    expect(review.items.find((item) => item.storageFileId === orphan.id)?.protectedReason).toBeNull();
  });

  it("protects leftover folders a link points into, at review and at purge", async () => {
    const dirPath = path.join(paths.remoteDir, "Subs.Only");
    await fs.mkdir(dirPath);
    await fs.writeFile(path.join(dirPath, "a.srt"), "subtitle");
    await fs.utimes(path.join(dirPath, "a.srt"), oldTime, oldTime);
    await fs.utimes(dirPath, oldTime, oldTime);
    const [folder] = await app.database.db.insert(schema.storageLeftoverFolders).values({ rootType: "remote", dirPath, relativePath: "Subs.Only", fileCount: 1, totalBytes: 8, newestMtimeMs: oldTime.getTime(), lastSeenJobId: 0, updatedAt: new Date().toISOString() }).returning();
    await pointer("placeholder.mkv", "/nowhere/file.mkv");
    configureExtraSymlinkFolders([other]);
    const jobId = await app.jobs.startOrphanPurge("remote", [], "delete", [folder!.id]);
    const link = await pointer("subtitle.srt", path.join(dirPath, "a.srt"));
    const review = await listOrphanReview(app.database.db, "remote", 7);
    expect(review.leftoverFolders).toEqual([]);
    expect(review.skippedInUse).toEqual({ total: 1, files: 0, folders: 1, byReason: { library_link: 0, extra_link: 1 } });
    await expect(app.jobs.startOrphanPurge("remote", [], "delete", [folder!.id])).rejects.toThrow("extra symlink folder");
    await runJobs();
    expect(await app.jobs.getJob(jobId)).toMatchObject({ status: "failed" });
    await expect(fs.stat(dirPath)).resolves.toBeTruthy();
    expect((await app.jobs.listEvents(jobId)).map((event) => JSON.stringify(event.data)).join()).toContain(link);
  });

  it("keeps a subtitle a link points at when the last video in its folder is purged", async () => {
    const orphan = await storageFile("remote", "Subtitled.Release.2019/file.mkv");
    const subtitle = path.join(path.dirname(orphan.filePath), "file.en.srt");
    await fs.writeFile(subtitle, "subtitle");
    await pointer("subtitle.srt", subtitle);
    configureExtraSymlinkFolders([other]);
    expect(await purge("remote", [orphan.id], "delete")).toMatchObject({ status: "completed" });
    await expect(fs.stat(orphan.filePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.readFile(subtitle, "utf8")).resolves.toBe("subtitle");
  });

  it("never writes to the folder", async () => {
    const orphan = await storageFile("remote", "Some.Release.2019/file.mkv");
    await pointer("placeholder.mkv", "/nowhere/file.mkv");
    await fs.chmod(other, 0o555);
    configureExtraSymlinkFolders([other]);
    expect(await purge("remote", [orphan.id], "delete")).toMatchObject({ status: "completed" });
    await fs.chmod(other, 0o755);
    expect(await fs.readdir(other)).toEqual(["placeholder.mkv"]);
  });

  it("parses the setting and refuses folders that overlap what SRTL manages", () => {
    expect(parseExtraSymlinkFolders(undefined)).toEqual([]);
    expect(parseExtraSymlinkFolders(" /one/ , ,/two,/one")).toEqual(["/one", "/two"]);
    const managed = { symlinkDir: "/links", localDir: "/local", remoteDir: "/remote" };
    const problems = (folder: string) => extraSymlinkFolderProblems([folder], managed, ["movies"]);
    expect(problems("/other/links")).toEqual([]);
    // Beside the library folders, a folder under the symlink root is left alone by scans.
    expect(problems("/links/from-other-tool")).toEqual([]);
    expect(problems("relative/links")[0]).toContain("absolute");
    expect(problems("/links")[0]).toContain("same as, or contain");
    expect(problems("/")[0]).toContain("same as, or contain");
    expect(problems("/remote/inside")[0]).toContain("inside a storage root");
    expect(problems("/links/movies/inside")[0]).toContain("inside a library folder");
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
    await app.database.db.delete(schema.scanRuns);
    await completedSymlinkScan({ startedAt: new Date(Date.now() - 2 * 86_400_000) });
    const orphan = await storageFile("local", "movies/Gone (1999)/Gone (1999).mkv");
    await expect(app.jobs.startOrphanPurge("local", [orphan.id], "delete")).rejects.toThrow("more than 24 hours ago");
  });

  it("purges remote orphans and exposes the review over HTTP", async () => {
    const remote = await storageFile("remote", "Some.Release.2019/Some.Release.mkv");
    const setup = await app.app.inject({ method: "POST", url: "/api/auth/setup", payload: { setupToken: readSetupToken(app), username: "fixture", password: "fixture-password-123", confirmPassword: "fixture-password-123" } });
    const cookie = String(setup.headers["set-cookie"]);
    const review = await app.app.inject({ method: "GET", url: "/api/orphans?rootType=remote", headers: { cookie } });
    expect(review.json().items).toEqual([expect.objectContaining({ storageFileId: remote.id, category: "unlinked", label: "no_title_match" })]);
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
        targets: { jobId: purgeJobId, rootType: "remote", mode: "delete", reRequest: false, storageFileIds: [remote.id], folderIds: [] }
      })
    ]);
    expect((await app.jobs.listEvents(purgeJobId)).map((event) => event.message)).toContain("Deleted 1 orphan file(s) and 0 folder(s) on remote storage (requested by fixture from 127.0.0.1)");
    await runJobs();
    await expect(fs.stat(remote.filePath)).rejects.toMatchObject({ code: "ENOENT" });
    const [row] = await app.database.db.select().from(schema.storageFiles).where(eq(schema.storageFiles.id, remote.id));
    expect(row!.missingSince).not.toBeNull();
  });
});

describe("purge job items over HTTP", () => {
  beforeEach(async () => {
    const anchor = await storageFile("local", "movies/Anchor (2000)/Anchor (2000).mkv");
    await mediaLink("movies", "Anchor (2000)", "Anchor (2000).mkv", anchor.filePath);
  });

  it("pages through a purge's failed and held items with their reasons", async () => {
    const held = await storageFile("local", "movies/Alpha Bravo (2001)/Alpha.Bravo.2001.mkv");
    const alsoHeld = await storageFile("local", "movies/Charlie Delta (2002)/Charlie.Delta.2002.mkv");
    const relinked = await storageFile("local", "movies/Echo Foxtrot (2003)/Echo.Foxtrot.2003.mkv");
    const jobId = await app.jobs.startOrphanPurge("local", [held.id, alsoHeld.id, relinked.id], "hold");
    await mediaLink("movies", "Echo Foxtrot (2003)", "Echo.Foxtrot.2003.mkv", relinked.filePath);
    await runJobs();
    expect(await app.jobs.getJob(jobId)).toMatchObject({ status: "partially_failed" });
    const scanJobId = (await app.database.db.insert(schema.jobs).values({ type: "scan", status: "completed", createdAt: new Date().toISOString(), progress: "{}" }).returning())[0]!.id;

    const setup = await app.app.inject({ method: "POST", url: "/api/auth/setup", payload: { setupToken: readSetupToken(app), username: "fixture", password: "fixture-password-123", confirmPassword: "fixture-password-123" } });
    const cookie = String(setup.headers["set-cookie"]);
    const get = (url: string) => app.app.inject({ method: "GET", url, headers: { cookie } });

    const failed = (await get(`/api/jobs/${jobId}/purge-items?outcome=failed`)).json<OrphanPurgeItemPage>();
    expect(failed).toMatchObject({ jobId, outcome: "failed", total: 1, offset: 0, hasMore: false });
    expect(failed.items).toEqual([expect.objectContaining({ filePath: relinked.filePath, stage: "failed", targetKind: "file", rootType: "local", heldPath: null, errorMessage: expect.stringContaining("no longer an orphan") })]);

    const firstHeld = (await get(`/api/jobs/${jobId}/purge-items?outcome=held&limit=1`)).json<OrphanPurgeItemPage>();
    expect(firstHeld).toMatchObject({ total: 2, offset: 0, limit: 1, hasMore: true });
    expect(firstHeld.items).toEqual([expect.objectContaining({ filePath: held.filePath, stage: "held", heldPath: expect.any(String), purgeAfter: expect.any(String), errorMessage: null })]);
    const secondHeld = (await get(`/api/jobs/${jobId}/purge-items?outcome=held&offset=1&limit=1`)).json<OrphanPurgeItemPage>();
    expect(secondHeld).toMatchObject({ total: 2, offset: 1, hasMore: false });
    expect(secondHeld.items.map((item) => item.filePath)).toEqual([alsoHeld.filePath]);

    // A restored file stays in the job's held list, marked as restored.
    const [entry] = await listHeldOrphans(app.database.db);
    await restoreHeldOrphans(app.database.db, paths, [entry!.operationId]);
    const afterRestore = (await get(`/api/jobs/${jobId}/purge-items?outcome=held`)).json<OrphanPurgeItemPage>();
    expect(afterRestore.items.map((item) => item.stage).sort()).toEqual(["held", "restored"]);

    expect((await get(`/api/jobs/${scanJobId}/purge-items`)).statusCode).toBe(400);
    expect((await get(`/api/jobs/999999/purge-items`)).statusCode).toBe(404);
    expect((await get(`/api/jobs/${jobId}/purge-items?outcome=deleted`)).statusCode).toBe(400);
    expect((await get(`/api/jobs/${jobId}/purge-items?limit=501`)).statusCode).toBe(400);
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
    // A folder a link uses is never purged, so it is only counted.
    expect(review.leftoverFolders.map((folder) => [folder.relativePath, folder.protectedReason])).toEqual([
      ["movies/Fresh (2026)", "Modified in the last 24 hours"],
      ["movies/Gone (1999)", null]
    ]);
    expect(review.skippedInUse).toEqual({ total: 1, files: 0, folders: 1, byReason: { library_link: 1, extra_link: 0 } });
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

// Behaves like a debrid FUSE mount: rmdir on a torrent folder that still holds files fails with EIO,
// unlinking a file works, and the torrent folder disappears by itself once its last file is gone.
function debridFs(torrentRoot: string, files: string[]) {
  const remaining = new Set(files);
  let rootGone = false;
  const calls: string[] = [];
  const fail = (code: string, target: string) => Object.assign(new Error(`${code}: ${target}`), { code });
  const ops: FolderDeleteFs = {
    unlink: (async (target: string) => {
      calls.push(`unlink ${target}`);
      if (rootGone || !remaining.delete(target)) throw fail("ENOENT", target);
      if (remaining.size === 0) rootGone = true;
    }) as FolderDeleteFs["unlink"],
    rmdir: (async (target: string) => {
      calls.push(`rmdir ${target}`);
      if (rootGone) throw fail("ENOENT", target);
      throw fail("EIO", target);
    }) as FolderDeleteFs["rmdir"]
  };
  return { ops, calls, remaining, isGone: () => rootGone, torrentRoot };
}

describe("folder deletes on a debrid mount", () => {
  const torrent = "/remote/Alpha.Bravo.S01.DVD";
  const files = [`${torrent}/Extras/notes.txt`, `${torrent}/info.nfo`, `${torrent}/cover.jpg`];
  const contents = { files, directories: [`${torrent}/Extras`, torrent] };

  it("unlinks each file, then counts folders the mount already removed as gone", async () => {
    const mount = debridFs(torrent, files);
    await deleteFolderFileByFile(torrent, contents, mount.ops);
    expect(mount.isGone()).toBe(true);
    expect(mount.calls).toEqual([...files.map((file) => `unlink ${file}`), `rmdir ${torrent}/Extras`, `rmdir ${torrent}`]);
  });

  it("says how far it got when a file cannot be deleted, and leaves the folder", async () => {
    const mount = debridFs(torrent, files);
    const refusing: FolderDeleteFs = {
      ...mount.ops,
      unlink: (async (target: string) => {
        if (target === files[1]) throw Object.assign(new Error("EACCES"), { code: "EACCES" });
        return mount.ops.unlink(target);
      }) as FolderDeleteFs["unlink"]
    };
    await expect(deleteFolderFileByFile(torrent, contents, refusing)).rejects.toThrow(`Deleted 1 of 3 files in ${torrent}, then ${files[1]} could not be deleted (EACCES); the folder was left in place`);
    expect(mount.isGone()).toBe(false);
    expect(mount.calls.some((call) => call.startsWith("rmdir"))).toBe(false);
  });

  it("reports a folder that stays after its files are gone", async () => {
    const stubborn: FolderDeleteFs = {
      unlink: (async () => undefined) as FolderDeleteFs["unlink"],
      rmdir: (async (target: string) => {
        throw Object.assign(new Error(`EIO: ${target}`), { code: "EIO" });
      }) as FolderDeleteFs["rmdir"]
    };
    await expect(deleteFolderFileByFile(torrent, contents, stubborn)).rejects.toThrow(`Deleted all 3 files in ${torrent}, but folder ${torrent}/Extras could not be removed (EIO)`);
  });

  it("purges a leftover folder through the job when the mount refuses rmdir on it", async () => {
    const dirPath = path.join(paths.remoteDir, "Charlie.2001.DVDR");
    const entries = ["Charlie.nfo", "Extras/sample.txt"];
    for (const entry of entries) {
      await fs.mkdir(path.dirname(path.join(dirPath, entry)), { recursive: true });
      await fs.writeFile(path.join(dirPath, entry), entry);
      await fs.utimes(path.join(dirPath, entry), oldTime, oldTime);
    }
    await fs.utimes(path.join(dirPath, "Extras"), oldTime, oldTime);
    await fs.utimes(dirPath, oldTime, oldTime);
    const [folder] = await app.database.db.insert(schema.storageLeftoverFolders).values({ rootType: "remote", dirPath, relativePath: "Charlie.2001.DVDR", fileCount: 2, totalBytes: 20, newestMtimeMs: oldTime.getTime(), lastSeenJobId: 0, updatedAt: new Date().toISOString() }).returning();
    const realUnlink = fs.unlink.bind(fs);
    const realRm = fs.rm.bind(fs);
    const realReaddir = fs.readdir.bind(fs);
    // A recursive rm tries rmdir first on these mounts, so it fails like rmdir does.
    const rmSpy = vi.spyOn(fs, "rm").mockRejectedValue(Object.assign(new Error("EIO: i/o error, rmdir"), { code: "EIO" }));
    const rmdirSpy = vi.spyOn(fs, "rmdir").mockImplementation((async (target: string) => {
      await fs.lstat(target);
      throw Object.assign(new Error(`EIO: i/o error, rmdir '${target}'`), { code: "EIO" });
    }) as typeof fs.rmdir);
    // The torrent goes away by itself once its last file is unlinked.
    const unlinkSpy = vi.spyOn(fs, "unlink").mockImplementation((async (target: string) => {
      await realUnlink(target);
      const left = await realReaddir(dirPath, { recursive: true, withFileTypes: true });
      if (!left.some((entry) => entry.isFile())) await realRm(dirPath, { recursive: true });
    }) as typeof fs.unlink);
    try {
      const jobId = await app.jobs.startOrphanPurge("remote", [], "delete", [folder!.id]);
      await runJobs();
      expect(await app.jobs.getJob(jobId)).toMatchObject({ status: "completed", progress: expect.objectContaining({ deleted: 1, failed: 0 }) });
      await expect(fs.stat(dirPath)).rejects.toMatchObject({ code: "ENOENT" });
      expect(unlinkSpy).toHaveBeenCalledTimes(2);
      expect(rmSpy).not.toHaveBeenCalled();
    } finally {
      rmSpy.mockRestore();
      rmdirSpy.mockRestore();
      unlinkSpy.mockRestore();
    }
  });

  it("reports a failed folder purge with its first error in the job progress", async () => {
    const dirPath = path.join(paths.remoteDir, "Echo.Foxtrot.DVD");
    await fs.mkdir(dirPath);
    await fs.writeFile(path.join(dirPath, "info.nfo"), "nfo");
    await fs.utimes(path.join(dirPath, "info.nfo"), oldTime, oldTime);
    await fs.utimes(dirPath, oldTime, oldTime);
    const [folder] = await app.database.db.insert(schema.storageLeftoverFolders).values({ rootType: "remote", dirPath, relativePath: "Echo.Foxtrot.DVD", fileCount: 1, totalBytes: 3, newestMtimeMs: oldTime.getTime(), lastSeenJobId: 0, updatedAt: new Date().toISOString() }).returning();
    const unlinkSpy = vi.spyOn(fs, "unlink").mockRejectedValue(Object.assign(new Error("EIO: i/o error"), { code: "EIO" }));
    try {
      const jobId = await app.jobs.startOrphanPurge("remote", [], "delete", [folder!.id]);
      await runJobs();
      expect(await app.jobs.getJob(jobId)).toMatchObject({
        status: "failed",
        progress: expect.objectContaining({ failed: 1, firstError: { filePath: dirPath, message: expect.stringContaining("Nothing in this folder was deleted") } })
      });
    } finally {
      unlinkSpy.mockRestore();
    }
    await expect(fs.stat(path.join(dirPath, "info.nfo"))).resolves.toBeTruthy();
  });
});

describe("purge results over HTTP", () => {
  it("returns a failed purge's status and first error, and the in-use count with the review", async () => {
    const dirPath = path.join(paths.remoteDir, "Oscar.Papa.DVD");
    await fs.mkdir(dirPath);
    await fs.writeFile(path.join(dirPath, "info.nfo"), "nfo");
    await fs.utimes(path.join(dirPath, "info.nfo"), oldTime, oldTime);
    await fs.utimes(dirPath, oldTime, oldTime);
    const [folder] = await app.database.db.insert(schema.storageLeftoverFolders).values({ rootType: "remote", dirPath, relativePath: "Oscar.Papa.DVD", fileCount: 1, totalBytes: 3, newestMtimeMs: oldTime.getTime(), lastSeenJobId: 0, updatedAt: new Date().toISOString() }).returning();
    const linked = await storageFile("remote", "Quebec.Romeo.2008/Quebec.Romeo.2008.mkv");
    await fs.mkdir(path.join(path.dirname(linked.filePath), "Extras"));
    await fs.utimes(path.join(path.dirname(linked.filePath), "Extras"), oldTime, oldTime);
    await app.database.db.insert(schema.storageLeftoverFolders).values({ rootType: "remote", dirPath: path.join(path.dirname(linked.filePath), "Extras"), relativePath: "Quebec.Romeo.2008/Extras", fileCount: 0, totalBytes: 0, newestMtimeMs: oldTime.getTime(), lastSeenJobId: 0, updatedAt: new Date().toISOString() });
    await plainLink("movies", "Quebec Romeo (2008)", "Quebec.Romeo.2008", path.dirname(linked.filePath));
    const setup = await app.app.inject({ method: "POST", url: "/api/auth/setup", payload: { setupToken: readSetupToken(app), username: "fixture", password: "fixture-password-123", confirmPassword: "fixture-password-123" } });
    const cookie = String(setup.headers["set-cookie"]);

    const review = (await app.app.inject({ method: "GET", url: "/api/orphans?rootType=remote", headers: { cookie } })).json<OrphanReview>();
    expect(review.items).toEqual([]);
    expect(review.leftoverFolders.map((entry) => entry.folderId)).toEqual([folder!.id]);
    expect(review.skippedInUse).toEqual({ total: 1, files: 0, folders: 1, byReason: { library_link: 1, extra_link: 0 } });

    const unlinkSpy = vi.spyOn(fs, "unlink").mockRejectedValue(Object.assign(new Error("EIO: i/o error"), { code: "EIO" }));
    let jobId: number;
    try {
      jobId = (await app.app.inject({ method: "POST", url: "/api/orphans/purge", headers: { cookie }, payload: { rootType: "remote", folderIds: [folder!.id], mode: "delete" } })).json<{ jobId: number }>().jobId;
      await runJobs();
    } finally {
      unlinkSpy.mockRestore();
    }
    const job = (await app.app.inject({ method: "GET", url: `/api/jobs/${jobId}`, headers: { cookie } })).json<JobRecord>();
    expect(job.status).toBe("failed");
    const progress = job.progress as OrphanPurgeJobProgress;
    expect(progress).toMatchObject({ stage: "failed", failed: 1, total: 1, deleted: 0, firstError: { filePath: dirPath, message: expect.stringContaining("(EIO)") } });
  });
});

describe("links to folders and to files that are not video", () => {
  async function leftover(relativePath: string, entries: string[]) {
    const dirPath = path.join(paths.remoteDir, relativePath);
    for (const entry of entries) {
      await fs.mkdir(path.dirname(path.join(dirPath, entry)), { recursive: true });
      await fs.writeFile(path.join(dirPath, entry), entry);
      await fs.utimes(path.join(dirPath, entry), oldTime, oldTime);
    }
    await fs.mkdir(dirPath, { recursive: true });
    await fs.utimes(dirPath, oldTime, oldTime);
    const [row] = await app.database.db.insert(schema.storageLeftoverFolders).values({ rootType: "remote", dirPath, relativePath, fileCount: entries.length, totalBytes: 1, newestMtimeMs: oldTime.getTime(), lastSeenJobId: 0, updatedAt: new Date().toISOString() }).returning();
    return row!;
  }

  it("treats everything under a library link to a folder as in use, in the review and at purge", async () => {
    const inside = await storageFile("remote", "Golf.Hotel.2004/Golf.Hotel.2004.mkv");
    const free = await storageFile("remote", "India.Juliet.2005/India.Juliet.2005.mkv");
    const extras = await leftover("Golf.Hotel.2004/Extras", ["notes.txt"]);
    await plainLink("movies", "Golf Hotel (2004)", "Golf.Hotel.2004", path.dirname(inside.filePath));
    const review = await listOrphanReview(app.database.db, "remote", 7);
    expect(review.items.map((item) => item.storageFileId)).toEqual([free.id]);
    expect(review.leftoverFolders).toEqual([]);
    expect(review.skippedInUse).toEqual({ total: 1, files: 0, folders: 1, byReason: { library_link: 1, extra_link: 0 } });
    await expect(app.jobs.startOrphanPurge("remote", [inside.id], "delete")).rejects.toThrow("no longer an orphan");
    await expect(app.jobs.startOrphanPurge("remote", [], "delete", [extras.id])).rejects.toThrow("A symlink points into this folder");
  });

  it("rechecks for a folder link right before a delete", async () => {
    const orphan = await storageFile("remote", "Kilo.Lima.2006/Kilo.Lima.2006.mkv");
    const folder = await leftover("Kilo.Lima.2006/Subs", ["a.srt"]);
    const jobId = await app.jobs.startOrphanPurge("remote", [orphan.id], "delete", [folder.id]);
    await plainLink("movies", "Kilo Lima (2006)", "Kilo.Lima.2006", path.dirname(orphan.filePath));
    await runJobs();
    expect(await app.jobs.getJob(jobId)).toMatchObject({ status: "failed", progress: expect.objectContaining({ failed: 2 }) });
    await expect(fs.stat(orphan.filePath)).resolves.toBeTruthy();
    await expect(fs.stat(folder.dirPath)).resolves.toBeTruthy();
    const events = (await app.jobs.listEvents(jobId)).map((event) => JSON.stringify(event.data)).join();
    expect(events).toContain("points to a folder holding this file");
    expect(events).toContain("points to this folder or one above it");
  });

  it("counts a link to a file that is not video as use of its folder", async () => {
    const folder = await leftover("Mike.November.2007", ["Mike.November.2007.bin", "info.nfo"]);
    await plainLink("movies", "Mike November (2007)", "Mike.November.2007.bin", path.join(folder.dirPath, "Mike.November.2007.bin"));
    const review = await listOrphanReview(app.database.db, "remote", 7);
    expect(review.leftoverFolders).toEqual([]);
    expect(review.skippedInUse).toEqual({ total: 1, files: 0, folders: 1, byReason: { library_link: 1, extra_link: 0 } });
  });
});
