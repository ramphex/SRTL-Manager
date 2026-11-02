import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import fastify, { type FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp, type AppContext } from "../src/server/app";
import { setSetting } from "../src/server/db/database";
import * as schema from "../src/server/db/schema";
import { JobWorker } from "../src/server/jobs/jobRunner";
import { defaultCopyRunner, type CopyCommandRunner } from "../src/server/lib/copier";
import { markOnboardingCompleteForExistingInstall } from "../src/server/lib/onboarding";
import { persistSectionSettings } from "../src/server/lib/sectionSettings";
import { createSonarrInstance, getSonarrCopyDefaults, getSonarrOverview, getSonarrState, mapSonarrSeries, processSonarrWork, queueCopiedSonarrEpisodes, receiveSonarrWebhook, reconcileSonarrSeries, removeSonarrInstance, renameSonarrInstance, saveSonarrSettings, sonarrMediaExpectation, testSonarrConnection } from "../src/server/lib/sonarr";
import type { SonarrEpisode, SonarrEpisodeFile, SonarrSeries } from "../src/server/lib/sonarrClient";
import { setStoragePolicyTitle } from "../src/server/lib/storagePolicies";
import type { SonarrSettingsInput } from "../src/shared/sonarr";
import { createTestDatabase, type TestDatabaseHandle } from "./testDb";

interface FakeSonarr {
  url: string;
  series: SonarrSeries[];
  files: SonarrEpisodeFile[];
  episodes: SonarrEpisode[];
  tags: Array<{ id: number; label: string }>;
  rootFolders: string[];
  edits: Array<{ seriesIds: number[]; tags?: number[]; applyTags?: string; monitored?: boolean }>;
  monitorEdits: Array<{ episodeIds: number[]; monitored: boolean }>;
  offline: boolean;
  requests: number;
}

let app: AppContext;
let database: TestDatabaseHandle;
let root: string;
const servers: FastifyInstance[] = [];
const apiKey = "testSonarrApiKeyOnly";
const webhookSecret = "test_sonarr_webhook_secret_for_fixture";
const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };

function show(id: number, title: string, rootPath: string, tags: number[] = []): SonarrSeries {
  return { id, tvdbId: id + 500, title, year: 2020, path: `${rootPath}/${title} (2020)`, tags, monitored: true };
}

async function fakeSonarr(series: SonarrSeries[], rootFolders: string[], tags = [{ id: 1, label: "local" }, { id: 2, label: "ignored" }, { id: 3, label: "family" }]): Promise<FakeSonarr> {
  const server = fastify();
  servers.push(server);
  const fake: FakeSonarr = { url: "", series, files: [], episodes: [], tags, rootFolders, edits: [], monitorEdits: [], offline: false, requests: 0 };
  server.addHook("preHandler", async (request, reply) => {
    fake.requests += 1;
    if (fake.offline) return reply.code(503).send({ error: "offline" });
    if (request.headers["x-api-key"] !== apiKey) return reply.code(401).send({ error: "bad key" });
  });
  server.get("/api/v3/system/status", async () => ({ appName: "Sonarr", version: "4.0.15" }));
  server.get("/api/v3/rootfolder", async () => fake.rootFolders.map((folder) => ({ path: folder })));
  server.get("/api/v3/series", async () => fake.series);
  server.get<{ Params: { id: string } }>("/api/v3/series/:id", async (request, reply) => fake.series.find((item) => item.id === Number(request.params.id)) ?? reply.code(404).send({ error: "missing" }));
  server.get("/api/v3/tag", async () => fake.tags);
  server.post<{ Body: { label: string } }>("/api/v3/tag", async (request) => {
    const tag = { id: fake.tags.length + 1, label: request.body.label };
    fake.tags.push(tag);
    return tag;
  });
  server.put<{ Body: FakeSonarr["edits"][number] }>("/api/v3/series/editor", async (request) => {
    fake.edits.push(request.body);
    const { tags: editTags = [], applyTags } = request.body;
    for (const item of fake.series.filter((entry) => request.body.seriesIds.includes(entry.id))) {
      if (applyTags) item.tags = applyTags === "add" ? [...new Set([...item.tags, ...editTags])] : item.tags.filter((id) => !editTags.includes(id));
    }
    return fake.series;
  });
  server.get<{ Querystring: { seriesId: string } }>("/api/v3/episodefile", async (request) => fake.files.filter((file) => file.seriesId === Number(request.query.seriesId)));
  server.get<{ Params: { id: string } }>("/api/v3/episodefile/:id", async (request, reply) => fake.files.find((file) => file.id === Number(request.params.id)) ?? reply.code(404).send({ error: "missing" }));
  server.get<{ Querystring: { seriesId: string } }>("/api/v3/episode", async (request) => fake.episodes.filter((episode) => episode.seriesId === Number(request.query.seriesId)));
  server.put<{ Body: FakeSonarr["monitorEdits"][number] }>("/api/v3/episode/monitor", async (request) => {
    fake.monitorEdits.push(request.body);
    for (const episode of fake.episodes.filter((entry) => request.body.episodeIds.includes(entry.id))) episode.monitored = request.body.monitored;
    return fake.episodes.filter((entry) => request.body.episodeIds.includes(entry.id));
  });
  fake.url = await server.listen({ host: "127.0.0.1", port: 0 });
  return fake;
}

// Adds episode files to a fake series: each file covers one or more episode numbers of season 1. Episode ids are 100 * series id + episode number.
function addEpisodes(fake: FakeSonarr, series: SonarrSeries, files: Array<{ name: string; episodes: number[]; size?: number }>, withoutFile: number[] = []) {
  for (const file of files) {
    const id = series.id * 100 + file.episodes[0]!;
    fake.files.push({ id, seriesId: series.id, relativePath: `Season 01/${file.name}`, size: file.size ?? 16 });
    for (const number of file.episodes) fake.episodes.push({ id: series.id * 100 + number, seriesId: series.id, episodeFileId: id, seasonNumber: 1, episodeNumber: number, monitored: true });
  }
  for (const number of withoutFile) fake.episodes.push({ id: series.id * 100 + number, seriesId: series.id, episodeFileId: 0, seasonNumber: 1, episodeNumber: number, monitored: true });
}

function settingsFor(fake: FakeSonarr, mappings: SonarrSettingsInput["mappings"], extra: Partial<SonarrSettingsInput> = {}): SonarrSettingsInput {
  return { revision: 0, baseUrl: fake.url, apiKey, webhookSecret: "", enabled: true, localTag: "local", remoteTag: "ignored", monitorOnCopy: false, mappingMode: "manual", mappings, ...extra };
}

async function instance(name: string, fake: FakeSonarr, mappings: SonarrSettingsInput["mappings"], extra: Partial<SonarrSettingsInput> = {}): Promise<string> {
  const id = (await createSonarrInstance(app.database.db, name)).settings.id;
  await saveSonarrSettings(app.database.db, id, settingsFor(fake, mappings, extra));
  return id;
}

// A remote episode file with its library symlink, as the scanner expects to find it.
async function episodeLink(section: string, itemName: string, relativePath: string) {
  const remoteFile = path.join(root, "remote", section, itemName, relativePath);
  await fs.mkdir(path.dirname(remoteFile), { recursive: true });
  await fs.writeFile(remoteFile, "test episode byte");
  const link = path.join(root, "links", section, itemName, relativePath);
  await fs.mkdir(path.dirname(link), { recursive: true });
  await fs.symlink(remoteFile, link);
}

async function scan(titles: Array<{ section: string; itemName: string }>) {
  await app.jobs.startExternalTitleScan(titles);
  await new JobWorker(app.database.db, { workerId: "sonarr-scan", logger: quiet }).runOnce();
}

async function dueEvents() { await app.database.db.update(schema.sonarrEvents).set({ nextAttemptAt: "2000-01-01T00:00:00.000Z" }); }

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "srtl-sonarr-test-"));
  for (const folder of ["links/shows", "links/shows4k", "links/anime", "local", "remote"]) await fs.mkdir(path.join(root, folder), { recursive: true });
  database = await createTestDatabase();
  app = await createApp({ rootDir: root, databaseUrl: database.databaseUrl, autoMigrate: true, paths: { symlinkDir: path.join(root, "links"), localDir: path.join(root, "local"), remoteDir: path.join(root, "remote") } });
  app.app.log.level = "silent";
  await markOnboardingCompleteForExistingInstall(app.database.db);
  await persistSectionSettings(app.database.db, { sections: ["shows", "shows4k", "anime", "movies"], sectionTypes: { shows: "shows", shows4k: "shows", anime: "shows", movies: "movies" }, sectionTitles: { shows: "TV Shows", shows4k: "TV 4K", anime: "Anime", movies: "Movies" } });
});

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await app?.app.close();
  await database?.cleanup();
  await fs.rm(root, { recursive: true, force: true });
});

describe("Sonarr instances and folder ownership", () => {
  it("keeps several instances with overlapping series ids apart, each with its own tags", async () => {
    const hd = await fakeSonarr([show(1, "Alpha", "/tv"), show(2, "Bravo", "/tv")], ["/tv"]);
    const uhd = await fakeSonarr([show(1, "Alpha", "/tv4k")], ["/tv4k"], [{ id: 7, label: "keep" }]);
    const anime = await fakeSonarr([show(1, "Delta", "/anime")], ["/anime"]);
    const hdId = await instance("Sonarr", hd, [{ rootPath: "/tv", section: "shows" }]);
    const uhdId = await instance("Sonarr 4K", uhd, [{ rootPath: "/tv4k", section: "shows4k" }], { localTag: "uhd-local", remoteTag: "uhd-remote" });
    const animeId = await instance("Sonarr Anime", anime, [{ rootPath: "/anime", section: "anime" }]);
    await setStoragePolicyTitle(app.database.db, "Alpha (2020)", "location_1");
    await setStoragePolicyTitle(app.database.db, "Delta (2020)", "location_2");
    await processSonarrWork(app.database.db);

    // The same title in two instances is tagged in both, each with that instance's own tag.
    expect(hd.series.map((item) => item.tags)).toEqual([[1], []]);
    expect(uhd.tags.map((tag) => tag.label)).toEqual(["keep", "uhd-local"]);
    expect(uhd.series[0]!.tags).toEqual([2]);
    expect(anime.series[0]!.tags).toEqual([2]);
    expect(hd.edits).toEqual([{ seriesIds: [1], tags: [1], applyTags: "add" }]);
    expect(uhd.edits).toEqual([{ seriesIds: [1], tags: [2], applyTags: "add" }]);
    expect(anime.edits).toEqual([{ seriesIds: [1], tags: [2], applyTags: "add" }]);
    const overview = await getSonarrOverview(app.database.db);
    expect(overview.instances.map((summary) => [summary.settings.id, summary.series, summary.mapped])).toEqual([[hdId, 2, 2], [uhdId, 1, 1], [animeId, 1, 1]]);
    expect((await getSonarrState(app.database.db, uhdId)).series.map((item) => [item.seriesId, item.title, item.status])).toEqual([[1, "Alpha (2020)", "synced"]]);

    // An offline instance records its own error and leaves the others working.
    anime.offline = true;
    await setStoragePolicyTitle(app.database.db, "Bravo (2020)", "location_2");
    await setStoragePolicyTitle(app.database.db, "Delta (2020)", "location_1");
    await processSonarrWork(app.database.db);
    expect(hd.series[1]!.tags).toEqual([2]);
    expect((await getSonarrState(app.database.db, animeId)).series[0]).toMatchObject({ status: "error", message: "Sonarr returned HTTP 503." });
    expect((await getSonarrState(app.database.db, hdId)).series.every((item) => item.status === "synced")).toBe(true);
  });

  it("lets each SRTL folder belong to only one instance and accepts only Shows sections", async () => {
    const hd = await fakeSonarr([show(1, "Alpha", "/tv")], ["/tv"]);
    const other = await fakeSonarr([show(1, "Alpha", path.join(root, "links", "shows"))], [path.join(root, "links", "shows"), path.join(root, "links", "shows4k")]);
    await instance("Sonarr", hd, [{ rootPath: "/tv", section: "shows" }]);
    const otherId = (await createSonarrInstance(app.database.db, "Sonarr 4K")).settings.id;
    await expect(saveSonarrSettings(app.database.db, otherId, settingsFor(other, [{ rootPath: "/somewhere", section: "shows" }]))).rejects.toThrow("The TV Shows folder is already mapped by Sonarr");
    await expect(saveSonarrSettings(app.database.db, otherId, settingsFor(other, [{ rootPath: "/movies", section: "movies" }]))).rejects.toThrow("Sonarr roots must map to configured Shows sections.");
    const detected = await testSonarrConnection(app.database.db, otherId, settingsFor(other, [], { mappingMode: "auto" }));
    expect(detected.automaticMappings).toEqual([{ rootPath: path.join(root, "links", "shows4k"), section: "shows4k" }]);
    expect(detected.conflictingRootFolders).toEqual([expect.objectContaining({ section: "shows", instanceName: "Sonarr" })]);
    await expect(createSonarrInstance(app.database.db, "sonarr")).rejects.toThrow("already named");
    const saved = await saveSonarrSettings(app.database.db, otherId, settingsFor(other, [], { mappingMode: "auto" }));
    expect(saved.settings.mappings).toEqual([{ rootPath: path.join(root, "links", "shows4k"), section: "shows4k" }]);
    // The series under the folder another instance owns stays unmapped here.
    expect(saved.series[0]?.status).toBe("unmapped");
    expect((await getSonarrCopyDefaults(app.database.db)).sections.map((entry) => [entry.section, entry.instanceName])).toEqual([["shows", "Sonarr"], ["shows4k", "Sonarr 4K"]]);
  });

  it("maps only series folders directly under a mapped root", () => {
    const config = { mappings: [{ rootPath: "/mnt/plex/shows", section: "shows" }] };
    expect(mapSonarrSeries({ path: "/mnt/plex/shows/Alpha (2020)", tvdbId: 1 }, config)).toEqual({ section: "shows", itemName: "Alpha (2020)" });
    expect(mapSonarrSeries({ path: "/mnt/plex/shows/nested/Alpha (2020)", tvdbId: 1 }, config)).toBeNull();
    expect(mapSonarrSeries({ path: "/mnt/plex/shows-extra/Alpha (2020)", tvdbId: 1 }, config)).toBeNull();
    expect(mapSonarrSeries({ path: "/mnt/plex/shows/Alpha {tvdb-9}", tvdbId: 1 }, config)).toBeNull();
    expect(mapSonarrSeries({ path: "/mnt/plex/shows/../shows/Alpha", tvdbId: 1 }, config)).toBeNull();
  });

  it("adds, renames, and removes instances without touching Sonarr", async () => {
    const hd = await fakeSonarr([show(1, "Alpha", "/tv")], ["/tv"]);
    const id = await instance("Sonarr", hd, [{ rootPath: "/tv", section: "shows" }]);
    const requests = hd.requests;
    expect((await renameSonarrInstance(app.database.db, id, "Sonarr HD")).instances[0]?.settings.name).toBe("Sonarr HD");
    expect((await removeSonarrInstance(app.database.db, id)).instances).toEqual([]);
    expect(await app.database.db.select().from(schema.sonarrSeries)).toEqual([]);
    expect(hd.requests).toBe(requests);
    expect(hd.edits).toEqual([]);
  });
});

describe("Sonarr policy tags", () => {
  it("adds or removes only the two policy tags through the series editor", async () => {
    const hd = await fakeSonarr([show(1, "Alpha", "/tv", [3, 2])], ["/tv"]);
    await instance("Sonarr", hd, [{ rootPath: "/tv", section: "shows" }]);
    await setStoragePolicyTitle(app.database.db, "Alpha (2020)", "location_2");
    await processSonarrWork(app.database.db);
    // Already tagged for its policy: nothing is sent.
    expect(hd.edits).toEqual([]);
    await setStoragePolicyTitle(app.database.db, "Alpha (2020)", "location_1");
    await processSonarrWork(app.database.db);
    expect(hd.edits).toEqual([{ seriesIds: [1], tags: [2], applyTags: "remove" }, { seriesIds: [1], tags: [1], applyTags: "add" }]);
    expect(hd.series[0]!.tags).toEqual([3, 1]);
    await setStoragePolicyTitle(app.database.db, "Alpha (2020)", "unassigned");
    await processSonarrWork(app.database.db);
    expect(hd.edits.at(-1)).toEqual({ seriesIds: [1], tags: [1], applyTags: "remove" });
    // The unrelated family tag is never touched, and the series' monitoring is never sent.
    expect(hd.series[0]!.tags).toEqual([3]);
    expect(hd.edits.every((edit) => !("monitored" in edit))).toBe(true);
    expect(hd.monitorEdits).toEqual([]);
  });

  it("keeps opposite tags in review until Use SRTL policies or Import tags resolves them", async () => {
    const hd = await fakeSonarr([show(1, "Alpha", "/tv", [2]), show(2, "Bravo", "/tv", [1]), show(3, "Charlie", "/tv", [1, 2])], ["/tv"]);
    const id = await instance("Sonarr", hd, [{ rootPath: "/tv", section: "shows" }]);
    await setStoragePolicyTitle(app.database.db, "Alpha (2020)", "location_1");
    await processSonarrWork(app.database.db);
    expect((await getSonarrState(app.database.db, id)).series.map((item) => [item.title, item.status, item.tagPolicy])).toEqual([
      ["Alpha (2020)", "review", "location_2"],
      ["Bravo (2020)", "review", "location_1"],
      ["Charlie (2020)", "review", "conflict"]
    ]);
    expect(hd.edits).toEqual([]);

    await expect(reconcileSonarrSeries(app.database.db, id, [3], "import_tags")).rejects.toThrow("Only unassigned or matching titles");
    await expect(reconcileSonarrSeries(app.database.db, id, [1], "import_tags")).rejects.toThrow("Only unassigned or matching titles");
    await reconcileSonarrSeries(app.database.db, id, [2], "import_tags");
    expect((await app.database.db.select().from(schema.storagePolicies).where(eq(schema.storagePolicies.title, "Bravo (2020)")))[0]).toMatchObject({ policy: "location_1", source: "sonarr" });
    await reconcileSonarrSeries(app.database.db, id, [1, 3], "use_srtl");
    await processSonarrWork(app.database.db);
    expect(hd.series.map((item) => item.tags)).toEqual([[1], [1], []]);
    expect((await getSonarrState(app.database.db, id)).series.map((item) => item.status)).toEqual(["synced", "synced", "synced"]);
  });
});

describe("Sonarr copy monitoring", () => {
  const itemName = "Alpha (2020)";
  const files = [{ name: "Alpha - S01E01.mkv", episodes: [1] }, { name: "Alpha - S01E02.mkv", episodes: [2] }, { name: "Alpha - S01E03-E04.mkv", episodes: [3, 4] }];

  // One series with three files (one covering two episodes) and an episode without a file, scanned and kept local by policy.
  async function season(options: { fail?: string; hold?: string; monitorOnCopy?: boolean } = {}) {
    const hd = await fakeSonarr([show(1, "Alpha", "/tv")], ["/tv"]);
    addEpisodes(hd, hd.series[0]!, files, [5]);
    const id = await instance("Sonarr", hd, [{ rootPath: "/tv", section: "shows" }], { monitorOnCopy: options.monitorOnCopy ?? true });
    await setSetting(app.database.db, "advancedSettings", { copy: { profile: "fast" } });
    for (const file of files) await episodeLink("shows", itemName, `Season 01/${file.name}`);
    await scan([{ section: "shows", itemName }]);
    await setStoragePolicyTitle(app.database.db, itemName, "location_1");
    let release = () => undefined as void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    let reached = () => undefined as void;
    const held = new Promise<void>((resolve) => { reached = resolve; });
    const copyRunner: CopyCommandRunner = {
      async copyFile(sourcePath, tempPath, reportProgress, signal) {
        if (options.hold && sourcePath.includes(options.hold)) {
          reached();
          await released;
        }
        return defaultCopyRunner.copyFile(sourcePath, tempPath, reportProgress, signal);
      },
      runCmp: defaultCopyRunner.runCmp,
      runFfmpeg: defaultCopyRunner.runFfmpeg,
      // Placeholder bytes stand in for media, so the preflight passes everything except the file chosen to fail.
      async inspectSource(sourcePath) {
        const failing = Boolean(options.fail && sourcePath.includes(options.fail));
        return { status: failing ? "fail" : "pass", problems: failing ? ["unreadable video stream"] : [], warnings: [], durationSeconds: null };
      }
    };
    const worker = new JobWorker(app.database.db, { workerId: "sonarr-copy", copyRunner, logger: quiet, copiedTitles: (copy, titles) => copy.sonarrMonitoring ? queueCopiedSonarrEpisodes(app.database.db, copy, titles) : Promise.resolve() });
    const links = (await app.database.db.select().from(schema.mediaLinks)).sort((left, right) => left.relativePath.localeCompare(right.relativePath));
    expect(links.map((link) => [link.relativePath, link.kind])).toEqual(files.map((file) => [`${itemName}/Season 01/${file.name}`, "remote"]));
    return { hd, id, worker, links, held, release };
  }

  const updates = async (jobId: number) => (await app.database.db.select().from(schema.sonarrMonitorUpdates).where(eq(schema.sonarrMonitorUpdates.copyJobId, jobId)).orderBy(schema.sonarrMonitorUpdates.id))
    .map((update) => ({ episodeId: update.episodeId, monitored: update.monitored, error: update.error }));

  it("unmonitors exactly the copied episodes once, never a failed one, and keeps the series monitored", async () => {
    const { hd, id, worker, links } = await season({ fail: "S01E02" });
    const jobId = await app.jobs.startCopy({ direction: "to_local", linkIds: links.map((link) => link.id), sonarrMonitoring: true });
    await worker.runOnce();
    expect((await app.jobs.getJob(jobId))?.status).toBe("partially_failed");
    // The two verified files were recorded while the copy ran; the failed one was not.
    expect((await app.database.db.select().from(schema.sonarrCopiedFiles)).map((row) => [row.relativePath, row.skipReason]).sort()).toEqual([["Season 01/Alpha - S01E01.mkv", null], ["Season 01/Alpha - S01E03-E04.mkv", null]]);

    await processSonarrWork(app.database.db);
    expect(hd.monitorEdits).toEqual([{ episodeIds: [101, 103, 104], monitored: false }]);
    expect(hd.episodes.map((episode) => [episode.episodeNumber, episode.monitored])).toEqual([[1, false], [2, true], [3, false], [4, false], [5, true]]);
    expect(hd.series[0]!.monitored).toBe(true);
    expect(hd.edits).toEqual([{ seriesIds: [1], tags: [1], applyTags: "add" }]);
    expect(await updates(jobId)).toEqual([
      { episodeId: 101, monitored: false, error: null },
      { episodeId: 103, monitored: false, error: null },
      { episodeId: 104, monitored: false, error: null },
      { episodeId: 102, monitored: false, error: "Skipped: this episode file did not finish copying." }
    ]);
    expect((await app.jobs.listEvents(jobId)).map((event) => event.message)).toContain("Unmonitored 3 episodes in Sonarr: Alpha (2020)");

    // Repeated passes and repeated per-title reports neither queue nor send anything twice.
    await queueCopiedSonarrEpisodes(app.database.db, { jobId, direction: "to_local" }, [{ section: "shows", itemName }]);
    await processSonarrWork(app.database.db);
    await processSonarrWork(app.database.db);
    expect(hd.monitorEdits).toHaveLength(1);
    expect(await updates(jobId)).toHaveLength(4);
    expect((await getSonarrState(app.database.db, id)).monitorUpdates.map((update) => update.title)).toContain("Alpha (2020) S01E03");

    // Copying the local files back to remote monitors those episodes again.
    const timestamp = new Date().toISOString();
    const local = (await app.database.db.select().from(schema.mediaLinks)).filter((link) => link.kind === "local");
    await app.database.db.update(schema.mediaLinks).set({ kind: "remote" });
    const [job] = await app.database.db.insert(schema.jobs).values({ type: "copy", status: "completed", createdAt: timestamp, finishedAt: timestamp, options: JSON.stringify({ direction: "to_remote", sonarrMonitoring: true }), progress: "{}" }).returning();
    await app.database.db.insert(schema.jobSelectionItems).values(local.map((link, index) => ({ jobId: job!.id, mediaLinkId: link.id, selectionOrder: index, section: "shows", itemName, relativePath: link.relativePath, linkPath: link.linkPath, createdAt: timestamp })));
    await processSonarrWork(app.database.db);
    expect(hd.monitorEdits.at(-1)).toEqual({ episodeIds: [101, 103, 104], monitored: true });
    expect(hd.episodes.every((episode) => episode.monitored)).toBe(true);
  });

  it("puts episode monitoring back when a terminated copy is rolled back", async () => {
    const { hd, worker, links, held, release } = await season({ hold: "S01E03" });
    const jobId = await app.jobs.startCopy({ direction: "to_local", linkIds: links.map((link) => link.id), sonarrMonitoring: true });
    const run = worker.runOnce();
    await held;
    await processSonarrWork(app.database.db);
    expect(hd.monitorEdits).toEqual([{ episodeIds: [101, 102], monitored: false }]);
    expect(await app.jobs.cancel(jobId)).toBe(true);
    release();
    await run;
    expect((await app.jobs.getJob(jobId))?.status).toBe("cancelled");
    expect((await app.database.db.select().from(schema.mediaLinks)).map((link) => link.kind)).toEqual(["remote", "remote", "remote"]);
    await processSonarrWork(app.database.db);
    await processSonarrWork(app.database.db);
    expect(hd.monitorEdits).toEqual([{ episodeIds: [101, 102], monitored: false }, { episodeIds: [101, 102], monitored: true }]);
    expect(hd.episodes.every((episode) => episode.monitored)).toBe(true);
    expect((await updates(jobId)).filter((update) => update.monitored)).toEqual([{ episodeId: 101, monitored: true, error: null }, { episodeId: 102, monitored: true, error: null }]);
  });

  it("leaves monitoring alone for copies that did not ask for it", async () => {
    const { hd, worker, links } = await season();
    const jobId = await app.jobs.startCopy({ direction: "to_local", linkIds: links.map((link) => link.id), radarrMonitoring: true });
    await worker.runOnce();
    expect((await app.jobs.getJob(jobId))?.status).toBe("completed");
    await processSonarrWork(app.database.db);
    expect(await app.database.db.select().from(schema.sonarrCopiedFiles)).toEqual([]);
    expect(hd.monitorEdits).toEqual([]);
  });

  it("handles a copy of hundreds of episodes in batches", async () => {
    const hd = await fakeSonarr([show(1, "Alpha", "/tv")], ["/tv"]);
    const count = 600;
    addEpisodes(hd, hd.series[0]!, Array.from({ length: count }, (_unused, index) => ({ name: `Alpha - S01E${index + 1}.mkv`, episodes: [index + 1] })));
    await instance("Sonarr", hd, [{ rootPath: "/tv", section: "shows" }]);
    const timestamp = new Date().toISOString();
    const links = await app.database.db.insert(schema.mediaLinks).values(Array.from({ length: count }, (_unused, index) => ({ section: "shows", itemName, relativePath: `${itemName}/Season 01/Alpha - S01E${index + 1}.mkv`, linkPath: path.join(root, "links", "shows", itemName, `Season 01/Alpha - S01E${index + 1}.mkv`), targetPath: `/local/${index}.mkv`, kind: "local", targetExists: true, isMedia: true, updatedAt: timestamp }))).returning();
    const [job] = await app.database.db.insert(schema.jobs).values({ type: "copy", status: "completed", createdAt: timestamp, finishedAt: timestamp, options: JSON.stringify({ direction: "to_local", sonarrMonitoring: true }), progress: "{}" }).returning();
    await app.database.db.insert(schema.jobSelectionItems).values(links.map((link, index) => ({ jobId: job!.id, mediaLinkId: link.id, selectionOrder: index, section: "shows", itemName, relativePath: link.relativePath, linkPath: link.linkPath, createdAt: timestamp })));
    await processSonarrWork(app.database.db);
    await processSonarrWork(app.database.db);
    expect(hd.monitorEdits.map((edit) => edit.episodeIds.length)).toEqual([200, 200, 100, 100]);
    expect(hd.episodes.filter((episode) => !episode.monitored)).toHaveLength(count);
    expect(await updates(job!.id)).toHaveLength(count);
    expect((await app.jobs.listEvents(job!.id)).map((event) => event.message)).toEqual(["Unmonitored 500 episodes in Sonarr: Alpha (2020)", "Unmonitored 100 episodes in Sonarr: Alpha (2020)"]);
  });

  it("retries episode lookups while Sonarr is offline without losing the copied files", async () => {
    const { hd, worker, links } = await season();
    const jobId = await app.jobs.startCopy({ direction: "to_local", linkIds: [links[0]!.id], sonarrMonitoring: true });
    await worker.runOnce();
    hd.offline = true;
    await processSonarrWork(app.database.db);
    expect((await app.database.db.select().from(schema.sonarrCopiedFiles))[0]).toMatchObject({ resolvedAt: null, error: "Sonarr returned HTTP 503.", attempts: 1 });
    hd.offline = false;
    await app.database.db.update(schema.sonarrCopiedFiles).set({ nextAttemptAt: "2000-01-01T00:00:00.000Z" });
    await processSonarrWork(app.database.db);
    expect(hd.monitorEdits).toEqual([{ episodeIds: [101], monitored: false }]);
    expect(await updates(jobId)).toEqual([{ episodeId: 101, monitored: false, error: null }]);
  });
});

describe("Sonarr webhooks", () => {
  const itemName = "Alpha (2020)";

  async function connected() {
    const hd = await fakeSonarr([show(1, "Alpha", "/tv")], ["/tv"]);
    addEpisodes(hd, hd.series[0]!, [{ name: "Alpha - S01E01.mkv", episodes: [1] }, { name: "Alpha - S01E02.mkv", episodes: [2] }]);
    const id = await instance("Sonarr", hd, [{ rootPath: "/tv", section: "shows" }], { webhookSecret });
    return { hd, id };
  }

  const post = (id: string, payload: unknown, secret: string | null = webhookSecret) => app.app.inject({ method: "POST", url: `/api/integrations/sonarr/${id}/webhook`, headers: secret ? { "x-srtl-webhook-secret": secret } : {}, payload: payload as Record<string, unknown> });

  it("requires the instance's secret and accepts only the six handled event types", async () => {
    const { id } = await connected();
    const otherId = (await createSonarrInstance(app.database.db, "Sonarr 4K")).settings.id;
    const series = { id: 1, title: "Alpha" };
    expect((await post(id, { eventType: "Test" }, null)).statusCode).toBe(401);
    expect((await post(id, { eventType: "Test" }, "wrong_secret_value_for_this_fixture")).statusCode).toBe(401);
    expect((await post(otherId, { eventType: "Test" })).statusCode).toBe(401);
    expect((await post("unknown", { eventType: "Test" })).statusCode).toBe(401);
    expect((await post(id, { eventType: "Test", series })).statusCode).toBe(202);
    for (const eventType of ["Download", "Rename", "SeriesAdd", "SeriesDelete", "EpisodeFileDelete"]) {
      expect((await post(id, { eventType, series, episodeFile: { id: 101, relativePath: "Season 01/Alpha - S01E01.mkv" } })).statusCode).toBe(202);
    }
    for (const eventType of ["Grab", "Health", "ApplicationUpdate", "MovieAdded"]) {
      expect((await post(id, { eventType, series })).statusCode).toBe(400);
    }
    expect((await getSonarrState(app.database.db, id)).events.map((event) => event.eventType).sort()).toEqual(["Download", "EpisodeFileDelete", "Rename", "SeriesAdd", "SeriesDelete"]);
    // Settings stay behind session authentication even with a valid webhook secret.
    expect((await app.app.inject({ method: "GET", url: "/api/settings/sonarr", headers: { "x-srtl-webhook-secret": webhookSecret } })).statusCode).toBe(401);
  });

  it("rescans just the series folder once the imported symlink exists, sharing one scan across a season", async () => {
    const { id } = await connected();
    await receiveSonarrWebhook(app.database.db, id, { eventType: "Download", series: { id: 1, title: "Wrong untrusted title" }, episodeFile: { id: 101, relativePath: "../../etc/passwd" } });
    await dueEvents();
    await processSonarrWork(app.database.db);
    expect(await app.jobs.listJobs()).toHaveLength(0);
    expect((await getSonarrState(app.database.db, id)).events[0]?.error).toContain("not available");

    await episodeLink("shows", itemName, "Season 01/Alpha - S01E01.mkv");
    await episodeLink("shows", itemName, "Season 01/Alpha - S01E02.mkv");
    await dueEvents();
    await processSonarrWork(app.database.db);
    const jobs = await app.jobs.listJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.progress).toMatchObject({ options: { titleScopes: [{ section: "shows", itemName }], scanLocal: false, scanRemote: false } });

    // The next episode of the same import joins the scan that is still queued.
    expect(await receiveSonarrWebhook(app.database.db, id, { eventType: "Download", series: { id: 1, title: "Alpha" }, episodeFile: { id: 102 } })).toEqual({ accepted: true, duplicate: false });
    expect(await receiveSonarrWebhook(app.database.db, id, { eventType: "Download", series: { id: 1, title: "Alpha" }, episodeFile: { id: 102 } })).toEqual({ accepted: true, duplicate: true });
    await dueEvents();
    await processSonarrWork(app.database.db);
    expect(await app.jobs.listJobs()).toHaveLength(1);
    expect((await getSonarrState(app.database.db, id)).events.map((event) => event.jobId)).toEqual([jobs[0]!.id, jobs[0]!.id]);

    await new JobWorker(app.database.db, { workerId: "sonarr-webhook-scan", logger: quiet }).runOnce();
    expect((await app.database.db.select().from(schema.mediaLinks)).map((link) => link.relativePath).sort()).toEqual([`${itemName}/Season 01/Alpha - S01E01.mkv`, `${itemName}/Season 01/Alpha - S01E02.mkv`]);
    expect((await getSonarrState(app.database.db, id)).events[0]?.jobStatus).toBe("completed");
  });

  it("uses stored identity for series deletion and ignores series outside the mappings", async () => {
    const { hd, id } = await connected();
    await receiveSonarrWebhook(app.database.db, id, { eventType: "SeriesDelete", series: { id: 1, title: "../wrong", path: "/etc" }, deletedFiles: true });
    await dueEvents();
    await processSonarrWork(app.database.db);
    expect((await app.jobs.listJobs())[0]?.progress).toMatchObject({ options: { titleScopes: [{ section: "shows", itemName }] } });
    expect((await getSonarrState(app.database.db, id)).series).toEqual([]);

    hd.series.push(show(2, "Bravo", "/elsewhere"));
    await receiveSonarrWebhook(app.database.db, id, { eventType: "SeriesAdd", series: { id: 2, title: "Bravo" } });
    await dueEvents();
    await processSonarrWork(app.database.db);
    expect(await app.jobs.listJobs()).toHaveLength(1);
    expect((await getSonarrState(app.database.db, id)).events[0]).toMatchObject({ eventType: "SeriesAdd", error: "Ignored: series is outside the configured folder mappings." });
  });
});

describe("Sonarr media expectations and copy defaults", () => {
  it("reports Sonarr's episode file size from the instance that owns the folder when the file name matches", async () => {
    const hd = await fakeSonarr([show(1, "Alpha", "/tv")], ["/tv"]);
    const uhd = await fakeSonarr([show(1, "Alpha", "/tv4k")], ["/tv4k"]);
    addEpisodes(hd, hd.series[0]!, [{ name: "Alpha - S01E01.mkv", episodes: [1], size: 1000 }]);
    addEpisodes(uhd, uhd.series[0]!, [{ name: "Alpha - S01E01 2160p.mkv", episodes: [1], size: 9000 }]);
    await instance("Sonarr", hd, [{ rootPath: "/tv", section: "shows" }]);
    await instance("Sonarr 4K", uhd, [{ rootPath: "/tv4k", section: "shows4k" }], { monitorOnCopy: true });
    const link = (relativePath: string, section = "shows4k") => ({ section, itemName: "Alpha (2020)", relativePath: `Alpha (2020)/${relativePath}` });
    expect(await sonarrMediaExpectation(app.database.db, link("Season 01/Alpha - S01E01 2160p.mkv"))).toEqual({ source: "Sonarr 4K", sizeBytes: 9000 });
    expect(await sonarrMediaExpectation(app.database.db, link("Season 01/Alpha - S01E01.mkv", "shows"))).toEqual({ source: "Sonarr", sizeBytes: 1000 });
    // A sample or extra in the series folder has no Sonarr size; neither does a title Sonarr does not map.
    expect(await sonarrMediaExpectation(app.database.db, link("Season 01/sample.mkv"))).toBeUndefined();
    expect(await sonarrMediaExpectation(app.database.db, link("Season 01/Alpha - S01E01.mkv", "anime"))).toBeUndefined();
    expect(await sonarrMediaExpectation(app.database.db, { section: "shows4k", itemName: "Other (2020)", relativePath: "Other (2020)/Season 01/Alpha - S01E01 2160p.mkv" })).toBeUndefined();
    expect((await getSonarrCopyDefaults(app.database.db)).sections.map((entry) => [entry.section, entry.monitorOnCopy])).toEqual([["shows", false], ["shows4k", true]]);
  });

  it("supports the authenticated configuration workflow and copy option through the HTTP API", async () => {
    const hd = await fakeSonarr([show(1, "Alpha", "/tv")], ["/tv"]);
    const setup = await app.app.inject({ method: "POST", url: "/api/auth/setup", payload: { username: "fixture", password: "fixture-password-123", confirmPassword: "fixture-password-123" } });
    const cookie = String(setup.headers["set-cookie"]);
    const created = await app.app.inject({ method: "POST", url: "/api/settings/sonarr/instances", headers: { cookie }, payload: { name: "Sonarr" } });
    expect(created.statusCode).toBe(200);
    const id = created.json().settings.id as string;
    const input = settingsFor(hd, [{ rootPath: "/tv", section: "shows" }], { webhookSecret });
    expect((await app.app.inject({ method: "POST", url: `/api/settings/sonarr/instances/${id}/test`, headers: { cookie }, payload: input })).json()).toEqual({ version: "4.0.15", rootFolders: ["/tv"], automaticMappings: [], unmatchedRootFolders: ["/tv"], conflictingRootFolders: [] });
    const saved = await app.app.inject({ method: "PUT", url: `/api/settings/sonarr/instances/${id}`, headers: { cookie }, payload: input });
    expect(saved.statusCode).toBe(200);
    expect(saved.body).not.toContain(apiKey);
    expect(saved.body).not.toContain(webhookSecret);
    expect(saved.json().settings).toMatchObject({ hasApiKey: true, hasWebhookSecret: true, enabled: true });
    expect((await app.app.inject({ method: "POST", url: `/api/settings/sonarr/instances/${id}/reconcile`, headers: { cookie }, payload: { seriesIds: [1], action: "use_srtl" } })).statusCode).toBe(200);
    expect((await app.app.inject({ method: "GET", url: "/api/settings/sonarr", headers: { cookie } })).json().instances[0]).toMatchObject({ series: 1, mapped: 1 });
    expect((await app.app.inject({ method: "GET", url: "/api/settings/sonarr/copy-defaults", headers: { cookie } })).json()).toEqual({ sections: [{ section: "shows", instanceId: id, instanceName: "Sonarr", monitorOnCopy: false }] });
    const copy = await app.app.inject({ method: "POST", url: "/api/copies", headers: { cookie }, payload: { direction: "to_local", section: "shows", sonarrMonitoring: true } });
    expect(copy.statusCode).toBe(200);
    expect((await app.jobs.getJob(copy.json().jobId))?.progress).toMatchObject({ options: { direction: "to_local", sonarrMonitoring: true } });
    expect((await app.app.inject({ method: "DELETE", url: `/api/settings/sonarr/instances/${id}`, headers: { cookie } })).json()).toEqual({ instances: [], limit: 25 });
  });
});
