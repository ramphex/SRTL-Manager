import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { createApp, type AppContext } from "../src/server/app";
import { first, setSetting } from "../src/server/db/database";
import * as schema from "../src/server/db/schema";
import { JobWorker } from "../src/server/jobs/jobRunner";
import { isBrokenLinkJump } from "../src/server/lib/brokenLinks";
import { markOnboardingCompleteForExistingInstall } from "../src/server/lib/onboarding";
import { createRadarrInstance, saveRadarrSettings } from "../src/server/lib/radarr";
import { createSonarrInstance, saveSonarrSettings } from "../src/server/lib/sonarr";
import { listReRequests, processReRequestWork } from "../src/server/lib/reRequests";
import type { ArrDiskCheckState, BrokenLinkCleanupRecord, BrokenLinkRescanResult, BrokenLinkReview, JobRecord } from "../src/shared/types";
import { readSetupToken } from "./authHelpers";
import { arrMockApiKey, closeArrMocks, fakeRadarr, fakeSonarr, mockMovie, type FakeSonarr } from "./reRequestMocks";
import { createTestDatabase, type TestDatabaseHandle } from "./testDb";

let tmpDir: string;
let ctx: AppContext;
let testDatabase: TestDatabaseHandle;

const silentLogger = { info: () => undefined, warn: () => undefined, error: () => undefined };

async function createAdminSession(): Promise<string> {
  const setup = await ctx.app.inject({
    method: "POST",
    url: "/api/auth/setup",
    payload: { setupToken: readSetupToken(ctx), username: "admin", password: "password-1234", confirmPassword: "password-1234" }
  });
  expect(setup.statusCode).toBe(200);
  await markOnboardingCompleteForExistingInstall(ctx.database.db);
  return String(setup.headers["set-cookie"]);
}

interface BrokenFixture {
  id: number;
  linkPath: string;
  targetPath: string;
}

/** A library symlink in the inventory as broken, with a real symlink on disk whose target does not exist. */
async function insertBrokenLink(itemName: string, fileName: string, options: { section?: string; root?: "remote" | "local"; brokenSince?: string | null; onDisk?: boolean } = {}): Promise<BrokenFixture> {
  const section = options.section ?? "movies";
  const relativePath = path.join(itemName, fileName);
  const linkPath = path.join(tmpDir, "plex", section, relativePath);
  const targetPath = path.join(tmpDir, options.root ?? "remote", section, relativePath);
  if (options.onDisk !== false) {
    await fs.mkdir(path.dirname(linkPath), { recursive: true });
    await fs.symlink(targetPath, linkPath);
  }
  const timestamp = new Date().toISOString();
  const row = await first(
    ctx.database.db
      .insert(schema.mediaLinks)
      .values({
        section,
        itemName,
        relativePath,
        linkPath,
        targetPath,
        kind: "broken",
        targetExists: false,
        isMedia: true,
        storagePolicy: "unassigned",
        sizeBytes: null,
        firstSeenAt: timestamp,
        lastSeenAt: timestamp,
        lastChangedAt: timestamp,
        brokenSince: options.brokenSince === undefined ? "2026-11-20T10:00:00.000Z" : options.brokenSince,
        missingSince: null,
        lastSeenJobId: 1,
        updatedAt: timestamp
      })
      .returning({ id: schema.mediaLinks.id })
  );
  return { id: row!.id, linkPath, targetPath };
}

async function insertFullScan(brokenLinks: number, startedAt: string): Promise<void> {
  const job = await first(ctx.database.db.insert(schema.jobs).values({ type: "scan", status: "completed", createdAt: startedAt, startedAt, finishedAt: startedAt, progress: "{}" }).returning({ id: schema.jobs.id }));
  await ctx.database.db.execute(sql`
    insert into scan_runs (job_id, status, options, started_at, finished_at, total_links, remote_links, local_links, broken_links, other_links, non_media_links, actionable_remote_links, assigned_remote_links)
    values (${job!.id}, 'completed', ${JSON.stringify({ scanSymlinks: true, scanLocal: false, scanRemote: false })}, ${startedAt}, ${startedAt}, 0, 0, 0, ${brokenLinks}, 0, 0, 0, 0)
  `);
}

async function runQueuedJob(jobId: number): Promise<JobRecord> {
  const worker = new JobWorker(ctx.database.db, { workerId: "test-worker", pollIntervalMs: 1, heartbeatIntervalMs: 10, logger: silentLogger });
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const current = await ctx.jobs.getJob(jobId);
    if (current && ["completed", "partially_failed", "failed", "cancelled"].includes(current.status)) return current;
    await worker.runOnce();
  }
  throw new Error(`Job #${jobId} did not finish`);
}

async function review(cookie: string): Promise<BrokenLinkReview> {
  const response = await ctx.app.inject({ method: "GET", url: "/api/broken-links", headers: { cookie } });
  expect(response.statusCode).toBe(200);
  return response.json<BrokenLinkReview>();
}

describe("broken link jump rule", () => {
  it("needs both three times the previous count and at least 50 more", () => {
    expect(isBrokenLinkJump(60, 0)).toBe(true);
    expect(isBrokenLinkJump(49, 0)).toBe(false);
    expect(isBrokenLinkJump(150, 40)).toBe(true);
    expect(isBrokenLinkJump(110, 40)).toBe(false);
    expect(isBrokenLinkJump(3_000, 2_000)).toBe(false);
    expect(isBrokenLinkJump(12, 3)).toBe(false);
  });
});

describe("broken link review", () => {
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "srtl-broken-"));
    for (const dir of ["plex/movies", "plex/shows", "local/movies", "remote/movies"]) await fs.mkdir(path.join(tmpDir, dir), { recursive: true });
    // Something real on remote storage, so it looks mounted.
    await fs.mkdir(path.join(tmpDir, "remote", "movies", "Present Film (2019)"), { recursive: true });
    await fs.writeFile(path.join(tmpDir, "local", "movies", "keep.txt"), "x");
    await fs.writeFile(
      path.join(tmpDir, ".env"),
      [`SYMLINK_DIR="${path.join(tmpDir, "plex")}"`, `SRTL_LOCATION_1_PATH="${path.join(tmpDir, "local")}"`, `SRTL_LOCATION_2_PATH="${path.join(tmpDir, "remote")}"`].join("\n")
    );
    testDatabase = await createTestDatabase();
    ctx = await createApp({ rootDir: tmpDir, dataDir: path.join(tmpDir, "data"), databaseUrl: testDatabase.databaseUrl });
    await setSetting(ctx.database.db, "sections", { sections: ["movies", "shows"], sectionTitles: { movies: "Films" }, sectionTypes: { movies: "movies", shows: "shows" } });
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await closeArrMocks();
    if (typeof ctx !== "undefined") await ctx.app.close();
    if (typeof testDatabase !== "undefined") await testDatabase.cleanup();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("lists links whose target is still gone and leaves out ones that changed or whose target is back", async () => {
    const unauthenticated = await ctx.app.inject({ method: "GET", url: "/api/broken-links" });
    expect(unauthenticated.statusCode).toBe(401);
    const cookie = await createAdminSession();
    const gone = await insertBrokenLink("Quiet Harbor (2011)", "quiet.harbor.mkv", { brokenSince: "2026-11-18T08:00:00.000Z" });
    const legacy = await insertBrokenLink("Quiet Harbor (2011)", "quiet.harbor.part2.mkv", { brokenSince: null });
    const back = await insertBrokenLink("Paper Lanterns (2015)", "paper.lanterns.mkv");
    await fs.mkdir(path.dirname(back.targetPath), { recursive: true });
    await fs.writeFile(back.targetPath, "the file came back");
    const removedOutside = await insertBrokenLink("Copper Fields (2008)", "copper.fields.mkv", { onDisk: false });

    const result = await review(cookie);
    expect(result.rechecked).toBe(true);
    expect(result.safety).toMatchObject({ blocked: false, warnings: [], spike: null });
    expect(result.items.map((item) => item.mediaLinkId)).toEqual([gone.id, legacy.id]);
    expect(result.items[0]).toMatchObject({ section: "movies", sectionTitle: "Films", itemName: "Quiet Harbor (2011)", linkPath: gone.linkPath, targetPath: gone.targetPath, targetRoot: "remote", brokenSince: "2026-11-18T08:00:00.000Z" });
    expect(result.items[1]?.brokenSince).toBeNull();
    expect(result.notListed).toEqual({ targetExists: 1, changed: 1, unchecked: 0 });
    expect(removedOutside.id).toBeGreaterThan(0);
  });

  it("deletes only the symlink, skips links that changed after queueing, and asks Radarr to rescan", async () => {
    const cookie = await createAdminSession();
    const radarr = await fakeRadarr([mockMovie(1, "Quiet Harbor", "/m", "quiet.harbor.mkv"), mockMovie(2, "Paper Lanterns", "/m", "paper.lanterns.mkv"), mockMovie(3, "Copper Fields", "/m", "copper.fields.mkv")], "/m");
    const instanceId = (await createRadarrInstance(ctx.database.db, "Radarr")).settings.id;
    await saveRadarrSettings(ctx.database.db, instanceId, { revision: 0, baseUrl: radarr.url, apiKey: arrMockApiKey, webhookSecret: "", enabled: true, localTag: "local", remoteTag: "remote", monitorOnCopy: false, mappingMode: "manual", mappings: [{ rootPath: "/m", section: "movies" }] });
    const gone = await insertBrokenLink("Quiet Harbor (2020)", "quiet.harbor.mkv");
    const comesBack = await insertBrokenLink("Paper Lanterns (2020)", "paper.lanterns.mkv");
    const repointed = await insertBrokenLink("Copper Fields (2020)", "copper.fields.mkv");

    const response = await ctx.app.inject({ method: "POST", url: "/api/broken-links/delete", headers: { cookie }, payload: { mediaLinkIds: [gone.id, comesBack.id, repointed.id] } });
    expect(response.statusCode).toBe(200);
    const jobId = response.json<{ jobId: number }>().jobId;
    const claims = await ctx.database.db.select().from(schema.jobResourceClaims).where(eq(schema.jobResourceClaims.jobId, jobId));
    expect(claims).toEqual(expect.arrayContaining([
      expect.objectContaining({ resourceType: "media", resourceKey: String(gone.id), access: "exclusive" }),
      expect.objectContaining({ resourceType: "path", resourceKey: path.resolve(gone.linkPath), access: "exclusive" })
    ]));

    // Between queueing and the worker: one target comes back, one link is pointed somewhere else.
    await fs.mkdir(path.dirname(comesBack.targetPath), { recursive: true });
    await fs.writeFile(comesBack.targetPath, "back again");
    const elsewhere = path.join(tmpDir, "remote", "movies", "Present Film (2019)", "other.mkv");
    await fs.unlink(repointed.linkPath);
    await fs.symlink(elsewhere, repointed.linkPath);

    const job = await runQueuedJob(jobId);
    expect(job).toMatchObject({ type: "symlink_cleanup", status: "completed", progress: expect.objectContaining({ removed: 1, skipped: 2, failed: 0, stage: "completed" }) });
    expect((job.progress as { message: string }).message).toContain("Rescan asked for 1 title");
    await expect(fs.lstat(gone.linkPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.readFile(comesBack.targetPath, "utf8")).resolves.toBe("back again");
    await expect(fs.readlink(comesBack.linkPath)).resolves.toBe(comesBack.targetPath);
    await expect(fs.readlink(repointed.linkPath)).resolves.toBe(elsewhere);
    await expect(first(ctx.database.db.select().from(schema.mediaLinks).where(eq(schema.mediaLinks.id, gone.id)).limit(1))).resolves.toMatchObject({ missingSince: expect.any(String) });

    const results = await ctx.app.inject({ method: "GET", url: `/api/broken-links/jobs/${jobId}`, headers: { cookie } });
    const byLink = Object.fromEntries(results.json<BrokenLinkCleanupRecord[]>().map((record) => [record.mediaLinkId, record]));
    expect(byLink[gone.id]).toMatchObject({ stage: "removed", message: null });
    expect(byLink[comesBack.id]).toMatchObject({ stage: "skipped", message: expect.stringContaining("target exists again") });
    expect(byLink[repointed.id]).toMatchObject({ stage: "skipped", message: expect.stringContaining("target changed") });

    await processReRequestWork(ctx.database.db);
    expect(radarr.rescans).toEqual([1]);
    expect(radarr.searches).toEqual([]);

    // The removed list offers the link again, and a rescan from it records the request on the cleanup job.
    const removed = await ctx.app.inject({ method: "GET", url: "/api/broken-links/removed", headers: { cookie } });
    const removedRows = removed.json<BrokenLinkCleanupRecord[]>();
    expect(removedRows).toMatchObject([{ mediaLinkId: gone.id, jobId, stage: "removed" }]);
    const again = await ctx.app.inject({ method: "POST", url: "/api/broken-links/rescan", headers: { cookie }, payload: { operationIds: [removedRows[0]!.operationId], search: true } });
    expect(again.statusCode).toBe(200);
    expect(again.json<BrokenLinkRescanResult>()).toMatchObject({ titles: 1, searched: 1, asked: 0, relinked: 0 });
    await processReRequestWork(ctx.database.db);
    // With a search, Radarr's file record is removed and the movie searched; the rescan is left out.
    expect(radarr.deletedFiles).toEqual([51]);
    expect(radarr.searches).toEqual([[1]]);
    expect((await listReRequests(ctx.database.db)).items.map((item) => item.action).sort()).toEqual(["rescan", "search"]);
  });

  it("blocks listing actions and deletes while remote storage looks empty, and a worker stops if it drops after queueing", async () => {
    const cookie = await createAdminSession();
    const link = await insertBrokenLink("Quiet Harbor (2011)", "quiet.harbor.mkv");
    const queued = await ctx.app.inject({ method: "POST", url: "/api/broken-links/delete", headers: { cookie }, payload: { mediaLinkIds: [link.id] } });
    expect(queued.statusCode).toBe(200);

    // The mount drops: storage shows nothing at all.
    await fs.rm(path.join(tmpDir, "remote"), { recursive: true, force: true });
    await fs.mkdir(path.join(tmpDir, "remote"));
    const result = await review(cookie);
    expect(result.rechecked).toBe(false);
    expect(result.safety.blocked).toBe(true);
    expect(result.safety.warnings[0]).toContain("remote storage");
    expect(result.items.map((item) => item.mediaLinkId)).toEqual([link.id]);

    const refused = await ctx.app.inject({ method: "POST", url: "/api/broken-links/delete", headers: { cookie }, payload: { mediaLinkIds: [link.id] } });
    expect(refused.statusCode).toBe(409);
    expect(refused.json<{ error: string }>().error).toContain("looks down");

    const job = await runQueuedJob(queued.json<{ jobId: number }>().jobId);
    expect(job).toMatchObject({ status: "failed", progress: expect.objectContaining({ removed: 0, failed: 1 }) });
    await expect(fs.readlink(link.linkPath)).resolves.toBe(link.targetPath);
  });

  it("blocks deletes after a jump in broken links until a full scan agrees", async () => {
    const cookie = await createAdminSession();
    const link = await insertBrokenLink("Quiet Harbor (2011)", "quiet.harbor.mkv");
    await insertFullScan(2, "2026-11-20T03:00:00.000Z");
    await insertFullScan(400, "2026-11-21T03:00:00.000Z");
    const blocked = await review(cookie);
    expect(blocked.safety).toMatchObject({ blocked: true, spike: { current: 400, previous: 2 } });
    const refused = await ctx.app.inject({ method: "POST", url: "/api/broken-links/delete", headers: { cookie }, payload: { mediaLinkIds: [link.id] } });
    expect(refused.statusCode).toBe(409);

    // A second full scan finds the same number, so the links are really broken.
    await insertFullScan(398, "2026-11-22T03:00:00.000Z");
    expect((await review(cookie)).safety).toMatchObject({ blocked: false, spike: null });
  });

  it("refuses links that are no longer broken in the inventory", async () => {
    const cookie = await createAdminSession();
    const link = await insertBrokenLink("Quiet Harbor (2011)", "quiet.harbor.mkv");
    await ctx.database.db.update(schema.mediaLinks).set({ kind: "remote", targetExists: true }).where(eq(schema.mediaLinks.id, link.id));
    const refused = await ctx.app.inject({ method: "POST", url: "/api/broken-links/delete", headers: { cookie }, payload: { mediaLinkIds: [link.id] } });
    expect(refused.statusCode).toBe(409);
    expect(refused.json<{ error: string }>().error).toContain("no longer broken");
    await expect(fs.readlink(link.linkPath)).resolves.toBe(link.targetPath);
  });

  describe("Sonarr and Radarr records with nothing on disk", () => {
    async function linkOnDisk(section: string, relativePath: string, inventory: boolean): Promise<void> {
      const linkPath = path.join(tmpDir, "plex", section, relativePath);
      const targetPath = path.join(tmpDir, "remote", section, relativePath);
      await fs.mkdir(path.dirname(linkPath), { recursive: true });
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await fs.writeFile(targetPath, "episode");
      await fs.symlink(targetPath, linkPath);
      if (!inventory) return;
      const timestamp = new Date().toISOString();
      await ctx.database.db.insert(schema.mediaLinks).values({ section, itemName: relativePath.split("/")[0]!, relativePath, linkPath, targetPath, kind: "remote", targetExists: true, isMedia: true, storagePolicy: "unassigned", sizeBytes: 7, firstSeenAt: timestamp, lastSeenAt: timestamp, lastChangedAt: timestamp, missingSince: null, lastSeenJobId: 1, updatedAt: timestamp });
    }

    async function setup(): Promise<{ cookie: string; sonarr: FakeSonarr; radarr: Awaited<ReturnType<typeof fakeRadarr>> }> {
      const cookie = await createAdminSession();
      const sonarr = await fakeSonarr([{ id: 7, tvdbId: 77, title: "Lantern Bay", year: 2019, path: "/tv/Lantern Bay", tags: [], monitored: true }], "/tv");
      sonarr.files.push(
        { id: 40, seriesId: 7, relativePath: "Season 01/Lantern.Bay.S01E01.mkv" },
        { id: 41, seriesId: 7, relativePath: "Season 01/Lantern.Bay.S01E02.mkv" },
        { id: 42, seriesId: 7, relativePath: "Season 01/Lantern.Bay.S01E03.mkv" }
      );
      sonarr.episodes.push(
        { id: 101, seriesId: 7, episodeFileId: 40, seasonNumber: 1, episodeNumber: 1, monitored: true },
        { id: 102, seriesId: 7, episodeFileId: 41, seasonNumber: 1, episodeNumber: 2, monitored: true },
        { id: 103, seriesId: 7, episodeFileId: 42, seasonNumber: 1, episodeNumber: 3, monitored: true }
      );
      const sonarrId = (await createSonarrInstance(ctx.database.db, "Sonarr")).settings.id;
      await saveSonarrSettings(ctx.database.db, sonarrId, { revision: 0, baseUrl: sonarr.url, apiKey: arrMockApiKey, webhookSecret: "", enabled: true, localTag: "local", remoteTag: "remote", monitorOnCopy: false, mappingMode: "manual", mappings: [{ rootPath: "/tv", section: "shows" }] });
      const radarr = await fakeRadarr([mockMovie(1, "Copper Fields", "/m", "copper.fields.mkv")], "/m");
      const radarrId = (await createRadarrInstance(ctx.database.db, "Radarr")).settings.id;
      await saveRadarrSettings(ctx.database.db, radarrId, { revision: 0, baseUrl: radarr.url, apiKey: arrMockApiKey, webhookSecret: "", enabled: true, localTag: "local", remoteTag: "remote", monitorOnCopy: false, mappingMode: "manual", mappings: [{ rootPath: "/m", section: "movies" }] });
      // E01 is in the inventory, E02 only on disk (it arrived after the scan), E03 and the movie have nothing at all.
      await linkOnDisk("shows", "Lantern Bay/Season 01/Lantern.Bay.S01E01.mkv", true);
      await linkOnDisk("shows", "Lantern Bay/Season 01/Lantern.Bay.S01E02.mkv", false);
      sonarr.calls.length = 0;
      radarr.calls.length = 0;
      return { cookie, sonarr, radarr };
    }

    async function state(cookie: string): Promise<ArrDiskCheckState> {
      const response = await ctx.app.inject({ method: "GET", url: "/api/broken-links/arr-missing", headers: { cookie } });
      expect(response.statusCode).toBe(200);
      return response.json<ArrDiskCheckState>();
    }

    it("lists records with nothing in the library, then rescans or searches only the chosen ones", async () => {
      const { cookie, sonarr, radarr } = await setup();
      const queued = await ctx.app.inject({ method: "POST", url: "/api/broken-links/arr-missing/check", headers: { cookie } });
      const jobId = queued.json<{ jobId: number }>().jobId;
      // A second request while one is waiting returns the same job.
      expect((await ctx.app.inject({ method: "POST", url: "/api/broken-links/arr-missing/check", headers: { cookie } })).json<{ jobId: number }>().jobId).toBe(jobId);
      await expect(runQueuedJob(jobId)).resolves.toMatchObject({ type: "arr_disk_check", status: "completed" });
      // Read-only and polite: one file list and one episode list for the series, one movie list, and no commands.
      expect(sonarr.calls).toEqual(["GET episodefile?seriesId=7", "GET episode?seriesId=7"]);
      expect(radarr.calls).toEqual([]);

      const result = await state(cookie);
      expect(result).toMatchObject({ configured: true, hiddenBecauseStorageDown: false, activeJobId: null, lastCheck: { jobId, status: "completed" } });
      expect(result.items.map((item) => [item.service, item.title, item.relativePath, item.episodes, item.arrPath])).toEqual([
        ["radarr", "Copper Fields (2020)", "copper.fields.mkv", null, "/m/Copper Fields (2020)/copper.fields.mkv"],
        ["sonarr", "Lantern Bay (2019)", "Season 01/Lantern.Bay.S01E03.mkv", "S01E03", "/tv/Lantern Bay/Season 01/Lantern.Bay.S01E03.mkv"]
      ]);

      const episode = result.items.find((item) => item.service === "sonarr")!;
      const movie = result.items.find((item) => item.service === "radarr")!;
      const searched = await ctx.app.inject({ method: "POST", url: "/api/broken-links/arr-missing/rescan", headers: { cookie }, payload: { ids: [episode.id], search: true } });
      expect(searched.json<BrokenLinkRescanResult>()).toMatchObject({ titles: 1, searched: 1, asked: 0 });
      const rescanned = await ctx.app.inject({ method: "POST", url: "/api/broken-links/arr-missing/rescan", headers: { cookie }, payload: { ids: [movie.id] } });
      expect(rescanned.json<BrokenLinkRescanResult>()).toMatchObject({ titles: 1, searched: 0, asked: 1 });
      await processReRequestWork(ctx.database.db);
      expect(sonarr.deletedFiles).toEqual([42]);
      expect(sonarr.searches).toEqual([[103]]);
      expect(sonarr.rescans).toEqual([]);
      expect(radarr.rescans).toEqual([1]);
      expect((await state(cookie)).items.every((item) => item.requestedAt)).toBe(true);
    });

    it("keeps an unreachable instance's list, reports it, and checks nothing while storage looks down", async () => {
      const { cookie, sonarr } = await setup();
      await runQueuedJob((await ctx.jobs.startArrDiskCheck("manual")));
      expect((await state(cookie)).items).toHaveLength(2);

      sonarr.offline = true;
      const partial = await runQueuedJob(await ctx.jobs.startArrDiskCheck("manual"));
      expect(partial.status).toBe("partially_failed");
      const afterOutage = await state(cookie);
      expect(afterOutage.items.map((item) => item.service).sort()).toEqual(["radarr", "sonarr"]);
      expect(afterOutage.lastCheck?.instances).toEqual(expect.arrayContaining([expect.objectContaining({ instanceName: "Sonarr", status: "unreachable" }), expect.objectContaining({ instanceName: "Radarr", status: "checked", missing: 1 })]));

      await fs.rm(path.join(tmpDir, "remote"), { recursive: true, force: true });
      await fs.mkdir(path.join(tmpDir, "remote"));
      const failed = await runQueuedJob(await ctx.jobs.startArrDiskCheck("manual"));
      expect(failed).toMatchObject({ status: "failed", progress: expect.objectContaining({ message: expect.stringContaining("were not checked") }) });
      const hidden = await state(cookie);
      expect(hidden).toMatchObject({ hiddenBecauseStorageDown: true, items: [] });
      const refused = await ctx.app.inject({ method: "POST", url: "/api/broken-links/arr-missing/rescan", headers: { cookie }, payload: { ids: [1] } });
      expect(refused.statusCode).toBe(409);
    });

    it("is queued after a full symlink scan but not after a title rescan", async () => {
      await setup();
      const titleScan = await ctx.jobs.startScan({ scanSymlinks: true, scanLocal: false, scanRemote: false, titleScopes: [{ section: "shows", itemName: "Lantern Bay" }] });
      await expect(runQueuedJob(titleScan)).resolves.toMatchObject({ status: "completed" });
      expect(await ctx.database.db.select().from(schema.jobs).where(eq(schema.jobs.type, "arr_disk_check"))).toEqual([]);
      const fullScan = await ctx.jobs.startScan({ scanSymlinks: true, scanLocal: false, scanRemote: false });
      await expect(runQueuedJob(fullScan)).resolves.toMatchObject({ status: "completed" });
      expect(await ctx.database.db.select({ status: schema.jobs.status }).from(schema.jobs).where(eq(schema.jobs.type, "arr_disk_check"))).toEqual([{ status: "queued" }]);
    });
  });
});
