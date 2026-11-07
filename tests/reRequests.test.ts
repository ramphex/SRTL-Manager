import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp, type AppContext } from "../src/server/app";
import { setSetting } from "../src/server/db/database";
import * as schema from "../src/server/db/schema";
import { JobWorker } from "../src/server/jobs/jobRunner";
import { listHeldOrphans, restoreHeldOrphans } from "../src/server/jobs/orphanPurge";
import { markOnboardingCompleteForExistingInstall } from "../src/server/lib/onboarding";
import { createRadarrInstance, getRadarrState, saveRadarrSettings } from "../src/server/lib/radarr";
import { listReRequests, parseEpisodeNumbers, previewReRequests, processReRequestWork, reRequestAllowance, retryReRequests } from "../src/server/lib/reRequests";
import { createSonarrInstance, saveSonarrSettings } from "../src/server/lib/sonarr";
import { persistSectionSettings } from "../src/server/lib/sectionSettings";
import type { SonarrSeries } from "../src/server/lib/sonarrClient";
import { recordSymlinkScan } from "./scanFixtures";
import { createTestDatabase, type TestDatabaseHandle } from "./testDb";
import { readSetupToken } from "./authHelpers";
import { arrMockApiKey as apiKey, closeArrMocks, fakeRadarr, fakeSonarr, mockMovie as movie, type FakeRadarr, type FakeSonarr } from "./reRequestMocks";

const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };
const oldTime = new Date(Date.now() - 3 * 86_400_000);
const ownerPassword = "owner-password-for-tests";
const temporaryPassword = "temporary-password-for-tests";
const moderatorPassword = "moderator-password-for-tests";

let app: AppContext;
let database: TestDatabaseHandle;
let root: string;
let links: string;
let local: string;

async function radarrInstance(name: string, fake: FakeRadarr, rootFolder: string, section: string): Promise<string> {
  const id = (await createRadarrInstance(app.database.db, name)).settings.id;
  await saveRadarrSettings(app.database.db, id, { revision: 0, baseUrl: fake.url, apiKey, webhookSecret: "", enabled: true, localTag: "local", remoteTag: "remote", monitorOnCopy: false, mappingMode: "manual", mappings: [{ rootPath: rootFolder, section }] });
  return id;
}

async function sonarrInstance(name: string, fake: FakeSonarr, rootFolder: string, section: string): Promise<string> {
  const id = (await createSonarrInstance(app.database.db, name)).settings.id;
  await saveSonarrSettings(app.database.db, id, { revision: 0, baseUrl: fake.url, apiKey, webhookSecret: "", enabled: true, localTag: "local", remoteTag: "remote", monitorOnCopy: false, mappingMode: "manual", mappings: [{ rootPath: rootFolder, section }] });
  return id;
}

// A file on local storage, hollow unless told otherwise. `linked` adds its library symlink, as a scan would have seen it.
async function localFile(section: string, itemName: string, relativePath: string, options: { linked?: boolean; integrity?: string; mtime?: Date } = {}) {
  const storageRelative = `${section}/${itemName}/${relativePath}`;
  const filePath = path.join(local, storageRelative);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `bytes of ${storageRelative}`);
  const mtime = options.mtime ?? oldTime;
  await fs.utimes(filePath, mtime, mtime);
  const stat = await fs.stat(filePath);
  const now = new Date().toISOString();
  const [row] = await app.database.db.insert(schema.storageFiles).values({ rootType: "local", rootPath: local, section, itemName, relativePath: storageRelative, filePath, storagePolicy: "unassigned", sizeBytes: stat.size, mtimeMs: Math.trunc(stat.mtimeMs), allocatedBytes: null, integrity: options.integrity ?? "hollow", firstSeenAt: now, lastSeenAt: now, lastChangedAt: now, lastSeenJobId: 0, updatedAt: now }).returning();
  let linkPath: string | null = null;
  if (options.linked !== false) {
    linkPath = path.join(links, section, itemName, relativePath);
    await fs.mkdir(path.dirname(linkPath), { recursive: true });
    await fs.symlink(filePath, linkPath);
    await app.database.db.insert(schema.mediaLinks).values({ section, itemName, relativePath: `${itemName}/${relativePath}`, linkPath, targetPath: filePath, kind: "local", targetExists: true, isMedia: true, storagePolicy: "unassigned", resolvedStorageFileId: row!.id, lastSeenAt: now, updatedAt: now });
  }
  return { id: row!.id, filePath, linkPath };
}

// Purges refuse to start until a section has been scanned, so one healthy linked title stays in the library.
async function keepInventoryFresh(section: string) {
  await localFile(section, "Keeper (1999)", "Keeper.mkv", { integrity: "ok" });
}

async function runJobs(): Promise<void> {
  const worker = new JobWorker(app.database.db, { workerId: "re-request-test", logger: quiet });
  while (await worker.runOnce()) { /* drain the queue */ }
}

async function rows() {
  return (await listReRequests(app.database.db)).items.sort((left, right) => left.id - right.id);
}

async function jobMessages(jobId: number): Promise<string[]> {
  return (await app.database.db.select().from(schema.jobEvents).where(eq(schema.jobEvents.jobId, jobId))).map((event) => event.message);
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "srtl-re-request-test-"));
  links = path.join(root, "links");
  local = path.join(root, "local");
  for (const folder of ["links", "local", "remote"]) await fs.mkdir(path.join(root, folder), { recursive: true });
  database = await createTestDatabase();
  app = await createApp({ rootDir: root, dataDir: path.join(root, "data"), databaseUrl: database.databaseUrl, autoMigrate: true, anonymousRequestsPerMinute: 100_000, paths: { symlinkDir: links, localDir: local, remoteDir: path.join(root, "remote") } });
  app.app.log.level = "silent";
  await markOnboardingCompleteForExistingInstall(app.database.db);
  await persistSectionSettings(app.database.db, { sections: ["movies", "movies4k", "shows", "other"], sectionTypes: { movies: "movies", movies4k: "movies", shows: "shows", other: "movies" } });
  await recordSymlinkScan(app.database.db);
});

afterEach(async () => {
  await closeArrMocks();
  await app?.app.close();
  await database?.cleanup();
  await fs.rm(root, { recursive: true, force: true });
});

describe("deleting a damaged file", () => {
  it("removes the file and its symlink and leaves Radarr alone unless a re-request was chosen", async () => {
    const fake = await fakeRadarr([movie(1, "Alpha", "/m", "Alpha.mkv")], "/m");
    await radarrInstance("Radarr", fake, "/m", "movies");
    const file = await localFile("movies", "Alpha (2020)", "Alpha.mkv");
    fake.calls.length = 0;
    const jobId = await app.jobs.startDamagedFilePurge([file.id], "delete");
    await runJobs();
    await processReRequestWork(app.database.db);
    expect((await app.jobs.getJob(jobId))?.status).toBe("completed");
    await expect(fs.lstat(file.filePath)).rejects.toThrow();
    await expect(fs.lstat(file.linkPath!)).rejects.toThrow();
    const [link] = await app.database.db.select().from(schema.mediaLinks).where(eq(schema.mediaLinks.linkPath, file.linkPath!));
    expect(link?.missingSince).toBeTruthy();
    expect(await rows()).toEqual([]);
    expect(fake.calls).toEqual([]);
    expect(fake.movies[0]!.movieFile).toBeTruthy();
  });

  it("refuses files that became healthy, and keeps the 24-hour and unfinished-copy protection orphans have", async () => {
    await keepInventoryFresh("movies");
    const healthy = await localFile("movies", "Healthy (2020)", "Healthy.mkv", { integrity: "ok" });
    const fresh = await localFile("movies", "Fresh (2020)", "Fresh.mkv", { mtime: new Date() });
    await expect(app.jobs.startDamagedFilePurge([healthy.id], "hold")).rejects.toThrow(/healthy/);
    await expect(app.jobs.startDamagedFilePurge([fresh.id], "hold")).rejects.toThrow(/last 24 hours/);
    await expect(fs.lstat(healthy.filePath)).resolves.toBeTruthy();
    await expect(fs.lstat(fresh.filePath)).resolves.toBeTruthy();
  });

  it("stops at run time if the file changed after it was queued, and then sends no search", async () => {
    const fake = await fakeRadarr([movie(1, "Alpha", "/m", "Alpha.mkv")], "/m");
    await radarrInstance("Radarr", fake, "/m", "movies");
    const file = await localFile("movies", "Alpha (2020)", "Alpha.mkv");
    const jobId = await app.jobs.startDamagedFilePurge([file.id], "delete", true);
    await fs.appendFile(file.filePath, "more bytes");
    fake.calls.length = 0;
    await runJobs();
    await processReRequestWork(app.database.db);
    expect((await app.jobs.getJob(jobId))?.status).toBe("failed");
    await expect(fs.lstat(file.linkPath!)).resolves.toBeTruthy();
    expect(await rows()).toMatchObject([{ status: "skipped", message: "The file was not deleted, so nothing was requested." }]);
    expect(fake.calls).toEqual([]);
  });

  it("puts the symlink back when a held file is restored, and cancels a request still waiting", async () => {
    const fake = await fakeRadarr([movie(1, "Alpha", "/m", "Alpha.mkv")], "/m");
    await radarrInstance("Radarr", fake, "/m", "movies");
    const file = await localFile("movies", "Alpha (2020)", "Alpha.mkv");
    await app.jobs.startDamagedFilePurge([file.id], "hold", true);
    await runJobs();
    const held = await listHeldOrphans(app.database.db);
    expect(held).toHaveLength(1);
    await expect(fs.lstat(file.filePath)).rejects.toThrow();
    fake.calls.length = 0;
    const restored = await restoreHeldOrphans(app.database.db, { symlinkDir: links, localDir: local, remoteDir: path.join(root, "remote") }, [held[0]!.operationId]);
    expect(restored).toEqual({ restored: 1, errors: [] });
    await expect(fs.stat(file.linkPath!)).resolves.toBeTruthy();
    expect(await fs.readlink(file.linkPath!)).toBe(file.filePath);
    const [link] = await app.database.db.select().from(schema.mediaLinks).where(eq(schema.mediaLinks.linkPath, file.linkPath!));
    expect(link?.missingSince).toBeNull();
    await processReRequestWork(app.database.db);
    expect(await rows()).toMatchObject([{ status: "skipped", message: "The file was restored, so nothing was requested." }]);
    expect(fake.calls).toEqual([]);
  });
});

describe("re-requesting a movie", () => {
  it("clears the file record, then monitors, then searches, in the instance that owns the folder", async () => {
    const hd = await fakeRadarr([movie(1, "Alpha", "/m", "Alpha.mkv")], "/m");
    const uhd = await fakeRadarr([movie(1, "Alpha", "/m4k", "Alpha 4K.mkv", false)], "/m4k");
    const hdId = await radarrInstance("Radarr", hd, "/m", "movies");
    const uhdId = await radarrInstance("Radarr 4K", uhd, "/m4k", "movies4k");
    await keepInventoryFresh("movies");
    const file = await localFile("movies4k", "Alpha (2020)", "Alpha 4K.mkv");
    await expect(previewReRequests(app.database.db, [file.id])).resolves.toEqual({ total: 1, eligibleCount: 1, instances: [{ service: "radarr", instanceName: "Radarr 4K", count: 1 }], ineligible: [] });
    hd.calls.length = 0;
    uhd.calls.length = 0;
    const jobId = await app.jobs.startDamagedFilePurge([file.id], "hold", true);
    // Nothing is sent until the delete job has finished.
    expect(uhd.calls).toEqual([]);
    await runJobs();
    expect(uhd.calls).toEqual([]);
    await processReRequestWork(app.database.db);

    expect(hd.calls).toEqual([]);
    expect(uhd.calls.map((call) => call.split(" ").slice(0, 2).join(" "))).toEqual(["GET movie/1", "DELETE moviefile/51", "PUT movie/editor", "POST command"]);
    expect(uhd.movies[0]).toMatchObject({ monitored: true, movieFile: null, tags: [1] });
    expect(uhd.searches).toEqual([[1]]);
    expect(await rows()).toMatchObject([{ status: "requested", service: "radarr", instanceName: "Radarr 4K", title: "Alpha (2020)", previousMonitored: false, attempts: 1 }]);
    expect(await jobMessages(jobId)).toContain("Search sent to Radarr 4K: Alpha (2020)");
    const state = await getRadarrState(app.database.db, uhdId);
    expect(state.movies[0]).toMatchObject({ monitored: true });
    expect(state.monitorUpdates).toMatchObject([{ title: "Alpha (2020)", monitored: true, copyJobId: null, error: null }]);
    expect((await getRadarrState(app.database.db, hdId)).monitorUpdates).toEqual([]);
  });

  it("drops an unmonitor still waiting from an earlier copy, so it cannot undo the request", async () => {
    const fake = await fakeRadarr([movie(1, "Alpha", "/m", "Alpha.mkv")], "/m");
    const instanceId = await radarrInstance("Radarr", fake, "/m", "movies");
    const now = new Date().toISOString();
    await app.database.db.insert(schema.radarrMonitorUpdates).values({ instanceId, movieId: 1, title: "Alpha (2020)", monitored: false, createdAt: now, nextAttemptAt: now });
    const file = await localFile("movies", "Alpha (2020)", "Alpha.mkv");
    await app.jobs.startDamagedFilePurge([file.id], "delete", true);
    await runJobs();
    await processReRequestWork(app.database.db);
    const state = await getRadarrState(app.database.db, instanceId);
    expect(state.monitorUpdates).toMatchObject([{ monitored: false, error: "Skipped: the file was deleted and re-requested." }]);
    expect(fake.movies[0]!.monitored).toBe(true);
  });

  it("never removes the record of a file it did not delete", async () => {
    const fake = await fakeRadarr([movie(1, "Alpha", "/m", "Alpha [Bluray].mkv"), movie(2, "Bravo", "/m", "Bravo.mkv")], "/m");
    await radarrInstance("Radarr", fake, "/m", "movies");
    // A linked extra in the folder, while Radarr's own file is something else.
    const extra = await localFile("movies", "Alpha (2020)", "Alpha trailer.mkv");
    // A new copy with the same name arrived after this one was deleted.
    const bravo = await localFile("movies", "Bravo (2020)", "Bravo.mkv");
    await app.jobs.startDamagedFilePurge([extra.id, bravo.id], "delete", true);
    await runJobs();
    const now = new Date().toISOString();
    await app.database.db.insert(schema.mediaLinks).values({ section: "movies", itemName: "Bravo (2020)", relativePath: "Bravo (2020)/Bravo.mkv", linkPath: path.join(links, "movies/Bravo (2020)/new-Bravo.mkv"), targetPath: "/elsewhere/Bravo.mkv", kind: "remote", targetExists: true, isMedia: true, storagePolicy: "unassigned", lastSeenAt: now, updatedAt: now });
    await setSetting(app.database.db, "advancedSettings", { cleanup: { reRequestsPerMinute: 60 } });
    await processReRequestWork(app.database.db);
    expect(fake.deletedFiles).toEqual([]);
    expect(fake.searches).toEqual([]);
    expect((await rows()).map((row) => row.status)).toEqual(["skipped", "skipped"]);
    expect(await rows()).toMatchObject([{ message: "Radarr already has a different file for this movie, so no search was sent." }, { message: "A new copy is already linked, so no search was sent." }]);
  });
});

describe("re-requesting episodes", () => {
  function show(rootFolder: string, monitored = true): SonarrSeries {
    return { id: 7, tvdbId: 77, title: "Delta", year: 2020, path: `${rootFolder}/Delta (2020)`, tags: [], monitored };
  }

  function episodes(fake: FakeSonarr) {
    fake.files.push({ id: 40, seriesId: 7, relativePath: "Season 01/Delta - S01E03-E04.mkv" }, { id: 41, seriesId: 7, relativePath: "Season 01/Delta - S01E05.mkv" });
    fake.episodes.push(
      { id: 103, seriesId: 7, episodeFileId: 40, seasonNumber: 1, episodeNumber: 3, monitored: false },
      { id: 104, seriesId: 7, episodeFileId: 40, seasonNumber: 1, episodeNumber: 4, monitored: true },
      { id: 105, seriesId: 7, episodeFileId: 41, seasonNumber: 1, episodeNumber: 5, monitored: false },
      { id: 106, seriesId: 7, episodeFileId: 0, seasonNumber: 1, episodeNumber: 6, monitored: false }
    );
  }

  it("searches exactly the episodes in the file and changes nothing else", async () => {
    const fake = await fakeSonarr([show("/tv")], "/tv");
    await sonarrInstance("Sonarr", fake, "/tv", "shows");
    episodes(fake);
    const file = await localFile("shows", "Delta (2020)", "Season 01/Delta - S01E03-E04.mkv");
    await app.jobs.startDamagedFilePurge([file.id], "delete", true);
    await runJobs();
    await processReRequestWork(app.database.db);
    expect(fake.deletedFiles).toEqual([40]);
    expect(fake.monitorEdits).toEqual([{ episodeIds: [103, 104], monitored: true }]);
    expect(fake.searches).toEqual([[103, 104]]);
    expect(fake.seriesEdits).toEqual([]);
    expect(fake.episodes.find((episode) => episode.id === 105)).toMatchObject({ monitored: false, episodeFileId: 41 });
    expect(fake.episodes.find((episode) => episode.id === 106)).toMatchObject({ monitored: false });
    expect(await rows()).toMatchObject([{ status: "requested", title: "Delta (2020)", episodes: "S01E03, S01E04", previousMonitored: false, message: null }]);
  });

  it("finds the episodes from the file name when Sonarr no longer has the record, and leaves episodes that have another file", async () => {
    const fake = await fakeSonarr([show("/tv")], "/tv");
    await sonarrInstance("Sonarr", fake, "/tv", "shows");
    episodes(fake);
    await keepInventoryFresh("shows");
    const orphan = await localFile("shows", "Delta (2020)", "Season 01/Delta - S01E06 [SDTV].mkv", { linked: false });
    const taken = await localFile("shows", "Delta (2020)", "Season 01/Delta - S01E05 [SDTV].mkv", { linked: false });
    await app.jobs.startOrphanPurge("local", [orphan.id, taken.id], "delete", [], true);
    await runJobs();
    await setSetting(app.database.db, "advancedSettings", { cleanup: { reRequestsPerMinute: 60 } });
    await processReRequestWork(app.database.db);
    expect(fake.deletedFiles).toEqual([]);
    expect(fake.searches).toEqual([[106]]);
    expect(await rows()).toMatchObject([
      { displayName: "Delta - S01E06 [SDTV].mkv", status: "requested", episodes: "S01E06" },
      { displayName: "Delta - S01E05 [SDTV].mkv", status: "skipped", message: "Sonarr already has a different file for this episode, so no search was sent." }
    ]);
  });

  it("says so when the series itself is unmonitored, without changing it", async () => {
    const fake = await fakeSonarr([show("/tv", false)], "/tv");
    await sonarrInstance("Sonarr", fake, "/tv", "shows");
    episodes(fake);
    const file = await localFile("shows", "Delta (2020)", "Season 01/Delta - S01E05.mkv");
    await app.jobs.startDamagedFilePurge([file.id], "delete", true);
    await runJobs();
    await processReRequestWork(app.database.db);
    expect(fake.seriesEdits).toEqual([]);
    expect(fake.searches).toEqual([[105]]);
    expect(await rows()).toMatchObject([{ status: "requested", message: "The series is not monitored in Sonarr, so only this search will look for it." }]);
  });
});

describe("items that cannot be re-requested", () => {
  it("says why before the delete and records the same afterwards, without calling anything", async () => {
    const fake = await fakeRadarr([movie(1, "Alpha", "/m", "Alpha.mkv")], "/m");
    await radarrInstance("Radarr", fake, "/m", "movies");
    await keepInventoryFresh("movies");
    await keepInventoryFresh("other");
    const notInArr = await localFile("movies", "Nobody (2020)", "Nobody.mkv", { linked: false });
    const noInstance = await localFile("other", "Other (2020)", "Other.mkv", { linked: false });
    const artifact = await localFile("movies", "Alpha (2020)", ".Alpha.mkv.srtl-kept-1", { linked: false });
    const linked = await localFile("movies", "Alpha (2020)", "Alpha.mkv", { integrity: "ok" });
    const spare = await localFile("movies", "Alpha (2020)", "Alpha [SDTV].mkv", { linked: false });
    const ids = [notInArr.id, noInstance.id, artifact.id, spare.id];
    expect(linked).toBeTruthy();
    const preview = await previewReRequests(app.database.db, ids);
    expect(preview).toMatchObject({ total: 4, eligibleCount: 0, instances: [] });
    expect(preview.ineligible).toEqual(expect.arrayContaining([
      { reason: "This title is not in Radarr.", count: 1, examples: ["Nobody.mkv"] },
      { reason: "No Radarr or Sonarr instance manages this folder.", count: 1, examples: ["Other.mkv"] },
      { reason: "This is a leftover file SRTL created, not a copy of a title.", count: 1, examples: [".Alpha.mkv.srtl-kept-1"] },
      { reason: "Another linked file of this title stays, so Radarr has nothing to search for.", count: 1, examples: ["Alpha [SDTV].mkv"] }
    ]));
    fake.calls.length = 0;
    const jobId = await app.jobs.startOrphanPurge("local", ids, "delete", [], true);
    await runJobs();
    await processReRequestWork(app.database.db);
    expect(fake.calls).toEqual([]);
    const after = await rows();
    expect(after.map((row) => row.status)).toEqual(["unmatched", "unmatched", "unmatched", "unmatched"]);
    expect(after.map((row) => row.message)).toEqual(expect.arrayContaining(preview.ineligible.map((group) => group.reason)));
    expect((await jobMessages(jobId)).filter((message) => message.startsWith("Not re-requested"))).toHaveLength(4);
  });

  it("asks Sonarr about names without an episode number, before the delete", async () => {
    const fake = await fakeSonarr([{ id: 7, tvdbId: 77, title: "Delta", year: 2020, path: "/tv/Delta (2020)", tags: [], monitored: true }], "/tv");
    await sonarrInstance("Sonarr", fake, "/tv", "shows");
    fake.files.push({ id: 40, seriesId: 7, relativePath: "Delta - 2024-05-01.mkv" });
    fake.episodes.push({ id: 103, seriesId: 7, episodeFileId: 40, seasonNumber: 2024, episodeNumber: 12, monitored: true });
    const daily = await localFile("shows", "Delta (2020)", "Delta - 2024-05-01.mkv");
    const unknown = await localFile("shows", "Delta (2020)", "Delta - bonus.mkv");
    await expect(previewReRequests(app.database.db, [daily.id, unknown.id])).resolves.toEqual({
      total: 2,
      eligibleCount: 1,
      instances: [{ service: "sonarr", instanceName: "Sonarr", count: 1 }],
      ineligible: [{ reason: "Sonarr has no episode for this file.", count: 1, examples: ["Delta - bonus.mkv"] }]
    });
    await app.jobs.startDamagedFilePurge([daily.id, unknown.id], "delete", true);
    await runJobs();
    await setSetting(app.database.db, "advancedSettings", { cleanup: { reRequestsPerMinute: 60 } });
    await processReRequestWork(app.database.db);
    expect(fake.searches).toEqual([[103]]);
    expect(await rows()).toMatchObject([{ status: "requested", episodes: "S2024E12" }, { status: "unmatched", message: "Sonarr has no episode for this file." }]);
  });
});

describe("when a re-request fails", () => {
  it("keeps the delete, shows the failure, and sends it again on retry without repeating what already happened", async () => {
    const fake = await fakeRadarr([movie(1, "Alpha", "/m", "Alpha.mkv")], "/m");
    await radarrInstance("Radarr", fake, "/m", "movies");
    const file = await localFile("movies", "Alpha (2020)", "Alpha.mkv");
    fake.failSearch = true;
    const jobId = await app.jobs.startDamagedFilePurge([file.id], "delete", true);
    await runJobs();
    await processReRequestWork(app.database.db);
    await expect(fs.lstat(file.filePath)).rejects.toThrow();
    expect((await app.jobs.getJob(jobId))?.status).toBe("completed");
    expect(await rows()).toMatchObject([{ status: "failed", message: "Radarr returned HTTP 500.", attempts: 1 }]);
    expect(await jobMessages(jobId)).toContain("Re-request failed: Alpha (2020). Radarr returned HTTP 500.");
    expect(fake.deletedFiles).toEqual([51]);

    fake.failSearch = false;
    await expect(retryReRequests(app.database.db, "all_failed")).resolves.toBe(1);
    await processReRequestWork(app.database.db);
    expect(await rows()).toMatchObject([{ status: "requested", message: null, attempts: 2 }]);
    expect(fake.searches).toEqual([[1]]);
    expect(fake.deletedFiles).toEqual([51]);
    // Finished requests are not sent twice.
    await expect(retryReRequests(app.database.db, "all_failed")).resolves.toBe(0);
  });

  it("fails clearly while the arr is offline or the instance is paused", async () => {
    const fake = await fakeRadarr([movie(1, "Alpha", "/m", "Alpha.mkv"), movie(2, "Bravo", "/m", "Bravo.mkv")], "/m");
    const instanceId = await radarrInstance("Radarr", fake, "/m", "movies");
    const alpha = await localFile("movies", "Alpha (2020)", "Alpha.mkv");
    const bravo = await localFile("movies", "Bravo (2020)", "Bravo.mkv");
    await app.jobs.startDamagedFilePurge([alpha.id], "delete", true);
    await runJobs();
    fake.offline = true;
    await processReRequestWork(app.database.db);
    expect(await rows()).toMatchObject([{ status: "failed", message: "Radarr returned HTTP 503." }]);
    fake.offline = false;

    const state = await getRadarrState(app.database.db, instanceId);
    await saveRadarrSettings(app.database.db, instanceId, { revision: state.settings.revision, baseUrl: fake.url, apiKey, webhookSecret: "", enabled: false, localTag: "local", remoteTag: "remote", monitorOnCopy: false, mappingMode: "manual", mappings: [{ rootPath: "/m", section: "movies" }] });
    await app.jobs.startDamagedFilePurge([bravo.id], "delete", true);
    await runJobs();
    await processReRequestWork(app.database.db);
    expect(await rows()).toMatchObject([{ status: "failed" }, { status: "failed", message: "Radarr is paused. Resume it to re-request this." }]);
    expect(fake.searches).toEqual([]);
  });
});

describe("pacing", () => {
  it("spreads a bulk delete over the minute and stays within each instance's allowance", async () => {
    expect(reRequestAllowance(6, 0)).toBe(1);
    expect(reRequestAllowance(6, 5)).toBe(1);
    expect(reRequestAllowance(6, 6)).toBe(0);
    expect(reRequestAllowance(60, 0)).toBe(5);
    expect(reRequestAllowance(60, 58)).toBe(2);
    expect(reRequestAllowance(1, 0)).toBe(1);

    const titles = Array.from({ length: 8 }, (_, index) => `Title${index}`);
    const fake = await fakeRadarr(titles.map((title, index) => movie(index + 1, title, "/m", `${title}.mkv`)), "/m");
    const other = await fakeRadarr([movie(1, "Alpha", "/m4k", "Alpha.mkv")], "/m4k");
    await radarrInstance("Radarr", fake, "/m", "movies");
    await radarrInstance("Radarr 4K", other, "/m4k", "movies4k");
    const ids: number[] = [];
    for (const title of titles) ids.push((await localFile("movies", `${title} (2020)`, `${title}.mkv`)).id);
    ids.push((await localFile("movies4k", "Alpha (2020)", "Alpha.mkv")).id);
    await app.jobs.startDamagedFilePurge(ids, "delete", true);
    await runJobs();

    await processReRequestWork(app.database.db);
    expect(fake.searches).toEqual([[1]]);
    // Another instance has its own allowance.
    expect(other.searches).toEqual([[1]]);
    for (let pass = 0; pass < 7; pass += 1) await processReRequestWork(app.database.db);
    expect(fake.searches.flat()).toEqual([1, 2, 3, 4, 5, 6]);
    expect(fake.searches.every((search) => search.length === 1)).toBe(true);
    expect((await listReRequests(app.database.db)).counts).toMatchObject({ requested: 7, pending: 2 });

    await processReRequestWork(app.database.db, Date.now() + 61_000);
    await processReRequestWork(app.database.db, Date.now() + 61_000);
    expect(fake.searches.flat()).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect((await listReRequests(app.database.db)).counts).toMatchObject({ requested: 9, pending: 0 });
  });

  it("uses the configured rate, in one command per pass", async () => {
    await setSetting(app.database.db, "advancedSettings", { cleanup: { reRequestsPerMinute: 60 } });
    const titles = Array.from({ length: 7 }, (_, index) => `Title${index}`);
    const fake = await fakeRadarr(titles.map((title, index) => movie(index + 1, title, "/m", `${title}.mkv`)), "/m");
    await radarrInstance("Radarr", fake, "/m", "movies");
    const ids: number[] = [];
    for (const title of titles) ids.push((await localFile("movies", `${title} (2020)`, `${title}.mkv`)).id);
    await app.jobs.startDamagedFilePurge(ids, "delete", true);
    await runJobs();
    await processReRequestWork(app.database.db);
    expect(fake.searches).toEqual([[1, 2, 3, 4, 5]]);
  });
});

describe("permissions", () => {
  it("lets owners delete and re-request, refuses moderators, and scrubs what moderators can read", async () => {
    const fake = await fakeRadarr([movie(1, "Alpha", "/m", "Alpha.mkv")], "/m");
    await radarrInstance("Radarr", fake, "/m", "movies");
    const file = await localFile("movies", "Alpha (2020)", "Alpha.mkv");
    const setup = await app.app.inject({ method: "POST", url: "/api/auth/setup", payload: { setupToken: readSetupToken(app), username: "the-owner", password: ownerPassword, confirmPassword: ownerPassword } });
    expect(setup.statusCode).toBe(200);
    const owner = String(setup.headers["set-cookie"]).split(";")[0]!;
    expect((await app.app.inject({ method: "POST", url: "/api/accounts", headers: { cookie: owner }, payload: { username: "a-moderator", role: "moderator", temporaryPassword } })).statusCode).toBe(201);
    const login = await app.app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "a-moderator", password: temporaryPassword } });
    const change = await app.app.inject({ method: "PUT", url: "/api/auth/user", headers: { cookie: String(login.headers["set-cookie"]).split(";")[0]! }, payload: { username: "a-moderator", currentPassword: temporaryPassword, newPassword: moderatorPassword, confirmNewPassword: moderatorPassword } });
    expect(change.statusCode).toBe(200);
    const moderator = String(change.headers["set-cookie"]).split(";")[0]!;

    const refused: Array<["GET" | "POST", string, object?]> = [
      ["POST", "/api/damaged-files/delete", { storageFileIds: [file.id], mode: "delete", reRequest: true }],
      ["GET", "/api/re-requests"],
      ["POST", "/api/re-requests/preview", { storageFileIds: [file.id] }],
      ["POST", "/api/re-requests/retry", { ids: "all_failed" }],
      ["POST", "/api/orphans/purge", { rootType: "local", storageFileIds: [file.id], mode: "delete", reRequest: true }]
    ];
    for (const [method, url, payload] of refused) {
      const response = await app.app.inject({ method, url, headers: { cookie: moderator }, ...(payload ? { payload } : {}) });
      expect(response.statusCode, url).toBe(403);
    }
    await expect(fs.lstat(file.filePath)).resolves.toBeTruthy();

    const preview = await app.app.inject({ method: "POST", url: "/api/re-requests/preview", headers: { cookie: owner }, payload: { storageFileIds: [file.id] } });
    expect(preview.json()).toMatchObject({ eligibleCount: 1 });
    const started = await app.app.inject({ method: "POST", url: "/api/damaged-files/delete", headers: { cookie: owner }, payload: { storageFileIds: [file.id], mode: "delete", reRequest: true } });
    expect(started.statusCode).toBe(200);
    const { jobId } = started.json<{ jobId: number }>();
    await runJobs();
    fake.failSearch = true;
    await processReRequestWork(app.database.db);

    // What the job log says stays readable to a moderator, without a root or connection address.
    const events = await app.app.inject({ method: "GET", url: `/api/jobs/${jobId}/events`, headers: { cookie: moderator } });
    expect(events.statusCode).toBe(200);
    expect(events.body).toContain("Re-request failed: Alpha (2020)");
    expect(events.body).not.toContain(root);
    expect(events.body).not.toContain(new URL(fake.url).host);
    expect(events.body).not.toContain(apiKey);

    const list = await app.app.inject({ method: "GET", url: "/api/re-requests", headers: { cookie: owner } });
    expect(list.json()).toMatchObject({ counts: { failed: 1 }, perMinute: 6 });
    const retried = await app.app.inject({ method: "POST", url: "/api/re-requests/retry", headers: { cookie: owner }, payload: { ids: "all_failed" } });
    expect(retried.json()).toEqual({ retried: 1 });
    const audit = await app.app.inject({ method: "GET", url: "/api/system/action-audit", headers: { cookie: owner } });
    const actions = audit.json<Array<{ action: string; targets: { reRequest?: boolean } }>>();
    expect(actions.map((entry) => entry.action)).toEqual(expect.arrayContaining(["damaged.delete", "re_request.retry"]));
    expect(actions.find((entry) => entry.action === "damaged.delete")?.targets.reRequest).toBe(true);
  });
});

describe("reading episode numbers from a file name", () => {
  it.each([
    ["Show - S01E03.mkv", { season: 1, episodes: [3] }],
    ["Season 01/Show - S01E03-E04 [WEB].mkv", { season: 1, episodes: [3, 4] }],
    ["Show.s02e05e06.mkv", { season: 2, episodes: [5, 6] }],
    ["Show S01E01-03.mkv", { season: 1, episodes: [1, 2, 3] }],
    ["Show S01E03 - 1080p.mkv", { season: 1, episodes: [3] }],
    ["Show - 2024-05-01.mkv", null],
    ["Show - 101.mkv", null]
  ])("%s", (name, expected) => {
    expect(parseEpisodeNumbers(name)).toEqual(expected);
  });
});
