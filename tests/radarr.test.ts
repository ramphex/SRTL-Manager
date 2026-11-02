import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import fastify, { type FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp, type AppContext } from "../src/server/app";
import { getJsonSetting, setSetting } from "../src/server/db/database";
import * as schema from "../src/server/db/schema";
import { JobWorker } from "../src/server/jobs/jobRunner";
import { markOnboardingCompleteForExistingInstall, onboardingSettingKey } from "../src/server/lib/onboarding";
import { reconcileEnvironmentPaths } from "../src/server/lib/pathConfiguration";
import { authenticateRadarrWebhook, createRadarrInstance, getRadarrCopyDefaults, getRadarrOverview, getRadarrState, mapRadarrMovie, processRadarrWork, queueCopiedTitleMonitorUpdates, radarrMediaExpectation, radarrSettingsSchema, radarrTagPolicy, radarrWebhookSecretSchema, receiveRadarrWebhook, reconcileRadarrMovies, refreshRadarr, removeRadarrInstance, saveRadarrSettings, startRadarrWork, testRadarrConnection } from "../src/server/lib/radarr";
import { RadarrClient, normalizeRadarrUrl, radarrAddressAllowed, type RadarrMovie } from "../src/server/lib/radarrClient";
import { defaultCopyRunner, type CopyCommandRunner } from "../src/server/lib/copier";
import { persistSectionSettings } from "../src/server/lib/sectionSettings";
import { setStoragePolicyTitle } from "../src/server/lib/storagePolicies";
import { generateRadarrWebhookSecret, type RadarrOverview, type RadarrSettingsInput } from "../src/shared/radarr";
import { createTestDatabase, type TestDatabaseHandle } from "./testDb";

let app: AppContext;
let database: TestDatabaseHandle;
let root: string;
let remote: FastifyInstance;
let input: RadarrSettingsInput;
let instanceId: string;
let movies: RadarrMovie[];
let tags: Array<{ id: number; label: string }>;
let edits: Array<{ movieIds: number[]; tags?: number[]; applyTags?: string; monitored?: boolean }>;
let offline: boolean;
let redirect: boolean;
let rootFolders: string[];
const apiKey = "testRadarrApiKeyOnly";
const webhookSecret = "test_webhook_secret_for_disposable_fixture";

function movie(id: number, title = "My First Wedding", assignedTags: number[] = []): RadarrMovie {
  return { id, tmdbId: id + 100, title, year: 2020, path: `/library/${title} (2020)`, tags: assignedTags, monitored: true, movieFile: { relativePath: `${title}.mkv` } };
}

async function connected() { await saveRadarrSettings(app.database.db, instanceId, input); }
async function dueEvents() { await app.database.db.update(schema.radarrEvents).set({ receivedAt: "2000-01-01T00:00:00.000Z", nextAttemptAt: "2000-01-01T00:00:00.000Z" }); }
async function symlinkFor(item: RadarrMovie) {
  const target = path.join(root, "remote", `${item.id}.mkv`);
  const folder = path.join(root, "links", "movies", path.posix.basename(item.path));
  await fs.mkdir(folder, { recursive: true });
  await fs.writeFile(target, "test movie bytes");
  const link = path.join(folder, item.movieFile!.relativePath);
  await fs.symlink(target, link);
  return { target, link };
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "srtl-radarr-test-"));
  for (const folder of ["links/movies", "local", "remote"]) await fs.mkdir(path.join(root, folder), { recursive: true });
  database = await createTestDatabase();
  app = await createApp({ rootDir: root, databaseUrl: database.databaseUrl, autoMigrate: true, paths: { symlinkDir: path.join(root, "links"), localDir: path.join(root, "local"), remoteDir: path.join(root, "remote") } });
  app.app.log.level = "silent";
  await markOnboardingCompleteForExistingInstall(app.database.db);
  await persistSectionSettings(app.database.db, { sections: ["movies"], sectionTypes: { movies: "movies" }, sectionTitles: { movies: "Movies" } });
  movies = [movie(1)];
  tags = [{ id: 1, label: "local" }, { id: 2, label: "ignored" }, { id: 3, label: "family" }];
  edits = [];
  offline = false;
  redirect = false;
  rootFolders = ["/library"];
  remote = fastify();
  remote.addHook("preHandler", async (request, reply) => {
    if (offline) return reply.code(503).send({ error: "offline" });
    if (redirect) return reply.code(302).header("Location", "http://169.254.169.254/").send();
    if (request.headers["x-api-key"] !== apiKey) return reply.code(401).send({ error: "bad key" });
  });
  remote.get("/radarr/api/v3/system/status", async () => ({ appName: "Radarr", version: "6.0.0" }));
  remote.get("/radarr/api/v3/rootfolder", async () => rootFolders.map((folder) => ({ path: folder })));
  remote.get("/radarr/api/v3/movie", async () => movies);
  remote.get<{ Params: { id: string } }>("/radarr/api/v3/movie/:id", async (request, reply) => movies.find((item) => item.id === Number(request.params.id)) ?? reply.code(404).send({ error: "missing" }));
  remote.get("/radarr/api/v3/tag", async () => tags);
  remote.post<{ Body: { label: string } }>("/radarr/api/v3/tag", async (request) => {
    const tag = { id: tags.length + 1, label: request.body.label };
    tags.push(tag);
    return tag;
  });
  remote.put<{ Body: { movieIds: number[]; tags?: number[]; applyTags?: string; monitored?: boolean } }>("/radarr/api/v3/movie/editor", async (request) => {
    edits.push(request.body);
    const { tags: editTags = [], applyTags, monitored } = request.body;
    for (const item of movies.filter((entry) => request.body.movieIds.includes(entry.id))) {
      if (applyTags) item.tags = applyTags === "add" ? [...new Set([...item.tags, ...editTags])] : item.tags.filter((id) => !editTags.includes(id));
      if (monitored !== undefined) item.monitored = monitored;
    }
    return movies;
  });
  const address = await remote.listen({ host: "127.0.0.1", port: 0 });
  instanceId = (await createRadarrInstance(app.database.db, "Radarr")).settings.id;
  input = { revision: 0, baseUrl: `${address}/radarr`, apiKey, webhookSecret, enabled: true, localTag: "local", remoteTag: "ignored", monitorOnCopy: false, mappingMode: "manual", mappings: [{ rootPath: "/library", section: "movies" }] };
});

afterEach(async () => {
  await remote?.close();
  await app?.app.close();
  await database?.cleanup();
  await fs.rm(root, { recursive: true, force: true });
});

describe("Radarr policy and webhook integration", () => {
  it("defaults to automatic matching without changing previously saved manual mappings", async () => {
    expect((await getRadarrState(app.database.db, instanceId)).settings).toMatchObject({ mappingMode: "auto", mappings: [] });
    await connected();
    const saved = await getJsonSetting<{ instances: Array<Record<string, unknown>> }>(app.database.db, "radarrInstances", { instances: [] });
    delete saved.instances[0]!.mappingMode;
    await setSetting(app.database.db, "radarrInstances", saved);
    expect((await getRadarrState(app.database.db, instanceId)).settings).toMatchObject({ mappingMode: "manual", mappings: input.mappings });
  });

  it("detects only exact full paths to movie sections without guessing from names or prefixes", async () => {
    await persistSectionSettings(app.database.db, { sections: ["movies4k", "shows", "movies"], sectionTypes: { movies: "movies", movies4k: "movies", shows: "shows" }, sectionTitles: { movies: "Family Films", movies4k: "Family Films 4K" } });
    rootFolders = [path.join(root, "links", "movies"), path.join(root, "links", "movies4k"), "/elsewhere/movies", path.join(root, "links", "shows"), path.join(root, "links", "movies-extra"), path.join(root, "links", "movies", "nested"), `${root}/links/../links/movies`];
    const expected = [{ rootPath: rootFolders[1], section: "movies4k" }, { rootPath: rootFolders[0], section: "movies" }];
    const detected = await testRadarrConnection(app.database.db, instanceId, { ...input, mappingMode: "auto" });
    expect(detected.automaticMappings).toEqual(expected);
    expect(detected.unmatchedRootFolders).toEqual(rootFolders.slice(2));
    expect((await getRadarrState(app.database.db, instanceId)).settings.mappings).toEqual([]);
    expect(edits).toEqual([]);
    const saved = await saveRadarrSettings(app.database.db, instanceId, { ...input, mappingMode: "auto" });
    expect(saved.settings.mappings).toEqual(expected);
    expect(saved.movies[0]?.status).toBe("unmapped");
  });

  it("recomputes automatic mappings on save and rejects enabling without a match", async () => {
    const automatic: RadarrSettingsInput = { ...input, mappingMode: "auto" };
    await expect(saveRadarrSettings(app.database.db, instanceId, automatic)).rejects.toThrow("No exact folder matches");
    const paused = await saveRadarrSettings(app.database.db, instanceId, { ...automatic, enabled: false });
    expect(paused.settings.mappings).toEqual([]);
    rootFolders = [path.join(root, "links", "movies")];
    const detected = await testRadarrConnection(app.database.db, instanceId, { ...paused.settings });
    expect(detected.automaticMappings).toHaveLength(1);
    rootFolders = ["/different/movies"];
    const resaved = await saveRadarrSettings(app.database.db, instanceId, { ...paused.settings, mappings: detected.automaticMappings });
    expect(resaved.settings.mappings).toEqual([]);
    const manual = await saveRadarrSettings(app.database.db, instanceId, { ...input, revision: resaved.settings.revision, mappings: [{ rootPath: "/different/movies", section: "movies" }] });
    expect(manual.settings).toMatchObject({ mappingMode: "manual", enabled: true, mappings: [{ rootPath: "/different/movies", section: "movies" }] });
  });

  it("uses automatic mappings for policy sync and webhook scans, and can pause offline", async () => {
    rootFolders = [path.join(root, "links", "movies")];
    movies[0]!.path = path.join(rootFolders[0]!, "My First Wedding (2020)");
    const saved = await saveRadarrSettings(app.database.db, instanceId, { ...input, mappingMode: "auto", mappings: [] });
    await symlinkFor(movies[0]!);
    await reconcileRadarrMovies(app.database.db, instanceId, [1], "use_srtl");
    await setStoragePolicyTitle(app.database.db, "My First Wedding (2020)", "location_1");
    await receiveRadarrWebhook(app.database.db, instanceId, { eventType: "Download", movie: { id: 1, title: "My First Wedding" } });
    await dueEvents();
    await processRadarrWork(app.database.db);
    expect((await app.jobs.listJobs())[0]?.progress).toMatchObject({ options: { titleScopes: [{ section: "movies", itemName: "My First Wedding (2020)" }] } });
    expect(movies[0]!.tags).toContain(1);
    offline = true;
    expect((await saveRadarrSettings(app.database.db, instanceId, { ...saved.settings, enabled: false })).settings).toMatchObject({ enabled: false, mappingMode: "auto", mappings: saved.settings.mappings });
  });

  it("stops automatic synchronization when the configured symlink root changes", async () => {
    rootFolders = [path.join(root, "links", "movies")];
    movies[0]!.path = path.join(rootFolders[0]!, "My First Wedding (2020)");
    await saveRadarrSettings(app.database.db, instanceId, { ...input, mappingMode: "auto" });
    await reconcileRadarrMovies(app.database.db, instanceId, [1], "use_srtl");
    await setStoragePolicyTitle(app.database.db, "My First Wedding (2020)", "location_1");
    await setSetting(app.database.db, "paths", { ...app.config.paths, symlinkDir: path.join(root, "changed-links") });
    await processRadarrWork(app.database.db);
    expect(edits).toHaveLength(0);
    expect((await getRadarrState(app.database.db, instanceId)).settings.lastError).toContain("Automatic folder matches changed");
  });

  it("keeps reviewed titles managed when automatic matches only change display order", async () => {
    const sections = { sections: ["movies", "movies4k"], sectionTypes: { movies: "movies" as const, movies4k: "movies" as const } };
    await persistSectionSettings(app.database.db, sections);
    rootFolders = [path.join(root, "links", "movies"), path.join(root, "links", "movies4k")];
    movies[0]!.path = path.join(rootFolders[0]!, "My First Wedding (2020)");
    const saved = await saveRadarrSettings(app.database.db, instanceId, { ...input, mappingMode: "auto" });
    expect(saved.settings.mappings.map((mapping) => mapping.section)).toEqual(["movies", "movies4k"]);
    await reconcileRadarrMovies(app.database.db, instanceId, [1], "use_srtl");
    await persistSectionSettings(app.database.db, { ...sections, sections: ["movies4k", "movies"] });
    const reordered = await saveRadarrSettings(app.database.db, instanceId, saved.settings);
    expect(reordered.settings.mappings.map((mapping) => mapping.section)).toEqual(["movies4k", "movies"]);
    expect(reordered.movies[0]?.managed).toBe(true);
    await setStoragePolicyTitle(app.database.db, "My First Wedding (2020)", "location_1");
    await processRadarrWork(app.database.db);
    expect(movies[0]!.tags).toContain(1);
  });

  it("starts without policy tags and allows a read-only connection before choosing them", async () => {
    const initial = await getRadarrState(app.database.db, instanceId);
    expect(initial.settings).toMatchObject({ enabled: false, localTag: "", remoteTag: "" });
    const draft = { ...input, enabled: false, localTag: "", remoteTag: "", mappings: [], webhookSecret: "" };
    expect(await testRadarrConnection(app.database.db, instanceId, draft)).toMatchObject({ version: "6.0.0" });
    const saved = await saveRadarrSettings(app.database.db, instanceId, draft);
    expect(saved.settings).toMatchObject({ enabled: false, localTag: "", remoteTag: "", hasApiKey: true, hasWebhookSecret: false });
    expect(radarrTagPolicy(["local", "remote", "ignored", ""], saved.settings)).toBe("unassigned");
    await processRadarrWork(app.database.db);
    expect(tags).toHaveLength(3);
    expect(edits).toHaveLength(0);
    expect(await app.jobs.listJobs()).toHaveLength(0);
  });

  it("requires explicit distinct tags before enabling or reconciling and preserves saved choices", async () => {
    for (const localTag of ["", "local"]) {
      await expect(saveRadarrSettings(app.database.db, instanceId, { ...input, localTag, remoteTag: "" })).rejects.toThrow("Choose both policy tags");
    }
    await expect(saveRadarrSettings(app.database.db, instanceId, { ...input, localTag: "remote", remoteTag: "remote" })).rejects.toThrow("must be different");
    await expect(saveRadarrSettings(app.database.db, instanceId, { ...input, enabled: false, localTag: "BAD TAG" })).rejects.toThrow("lowercase tag");
    const saved = await saveRadarrSettings(app.database.db, instanceId, { ...input, enabled: false, localTag: "", remoteTag: "" });
    for (const action of ["use_srtl", "import_tags"] as const) {
      await expect(reconcileRadarrMovies(app.database.db, instanceId, [1], action)).rejects.toThrow("Choose and save both policy tags");
    }
    const configured = await saveRadarrSettings(app.database.db, instanceId, { ...input, revision: saved.settings.revision, localTag: "home", remoteTag: "archive" });
    const paused = await saveRadarrSettings(app.database.db, instanceId, { ...configured.settings, enabled: false });
    expect(paused.settings).toMatchObject({ localTag: "home", remoteTag: "archive", enabled: false });
    expect(edits).toHaveLength(0);
  });

  it("saves a read-only preview, protects secrets, and leaves tags untouched until reconciliation", async () => {
    movies[0]!.tags = [1, 3];
    await connected();
    const state = await getRadarrState(app.database.db, instanceId);
    expect(state.movies[0]).toMatchObject({ status: "review", policy: "unassigned", tagPolicy: "location_1", managed: false });
    expect(JSON.stringify(state)).not.toContain(apiKey);
    expect(JSON.stringify(state)).not.toContain(webhookSecret);
    expect(await authenticateRadarrWebhook(app.database.db, instanceId, webhookSecret)).toBe(true);
    expect(await authenticateRadarrWebhook(app.database.db, instanceId, "wrong-secret-with-enough-characters")).toBe(false);
    await processRadarrWork(app.database.db);
    expect(edits).toHaveLength(0);
  });

  it("mirrors all policy transitions without changing unrelated tags or moving files", async () => {
    movies[0]!.tags = [3];
    await connected();
    await reconcileRadarrMovies(app.database.db, instanceId, [1], "use_srtl");
    for (const [policy, expectedTags] of [["location_1", [1, 3]], ["location_2", [2, 3]], ["unassigned", [3]]] as const) {
      await setStoragePolicyTitle(app.database.db, "My First Wedding (2020)", policy);
      await processRadarrWork(app.database.db);
      expect([...movies[0]!.tags].sort()).toEqual([...expectedTags]);
      expect((await getRadarrState(app.database.db, instanceId)).movies[0]).toMatchObject({ policy, status: "synced" });
    }
    expect(edits.every((edit) => Object.keys(edit).sort().join() === "applyTags,movieIds,tags")).toBe(true);
    expect(await app.jobs.listJobs()).toHaveLength(0);
  });

  it("imports existing tags explicitly and refuses both-tag or contradictory policies", async () => {
    movies = [movie(1, "My First Wedding", [1]), movie(2, "My Second Wedding", [1, 2]), movie(3, "My Third Wedding", [2])];
    await connected();
    await reconcileRadarrMovies(app.database.db, instanceId, [1], "import_tags");
    expect((await getRadarrState(app.database.db, instanceId)).movies.find((item) => item.movieId === 1)?.policy).toBe("location_1");
    await expect(reconcileRadarrMovies(app.database.db, instanceId, [2], "import_tags")).rejects.toThrow("one policy tag");
    await setStoragePolicyTitle(app.database.db, "My Third Wedding (2020)", "location_1");
    await expect(reconcileRadarrMovies(app.database.db, instanceId, [3], "import_tags")).rejects.toThrow("conflicting assignments");
    expect(edits).toHaveLength(0);
  });

  it("retries tag failures independently and retains the requested policy", async () => {
    await connected();
    await reconcileRadarrMovies(app.database.db, instanceId, [1], "use_srtl");
    await setStoragePolicyTitle(app.database.db, "My First Wedding (2020)", "location_1");
    offline = true;
    await processRadarrWork(app.database.db);
    expect((await getRadarrState(app.database.db, instanceId)).movies[0]).toMatchObject({ status: "error", policy: "location_1", message: "Radarr returned HTTP 503." });
    offline = false;
    const config = app.config;
    await app.app.close();
    app = await createApp(config);
    app.app.log.level = "silent";
    await app.database.db.update(schema.radarrMovies).set({ nextAttemptAt: null });
    await processRadarrWork(app.database.db);
    expect((await getRadarrState(app.database.db, instanceId)).movies[0]?.status).toBe("synced");
  });

  it("can pause while Radarr is offline without exposing or replacing credentials", async () => {
    await connected();
    offline = true;
    const current = (await getRadarrState(app.database.db, instanceId)).settings;
    const result = await saveRadarrSettings(app.database.db, instanceId, { ...current, enabled: false });
    expect(result.settings.enabled).toBe(false);
    expect(result.settings.hasApiKey).toBe(true);
    await expect(saveRadarrSettings(app.database.db, instanceId, { ...result.settings, baseUrl: "http://127.0.0.1:1" })).rejects.toThrow("Enter the API key");
  });

  it("rejects stale settings, invalid mappings, and changed movie identities", async () => {
    await connected();
    await expect(saveRadarrSettings(app.database.db, instanceId, input)).rejects.toThrow("settings changed");
    await expect(saveRadarrSettings(app.database.db, instanceId, { ...input, revision: 1, mappings: [{ rootPath: "/library", section: "missing" }] })).rejects.toThrow("Movies sections");
    movies[0]!.tmdbId = 999;
    await expect(reconcileRadarrMovies(app.database.db, instanceId, [1], "use_srtl")).rejects.toThrow("mapping changed");
  });

  it("handles duplicate notifications once and discovers a new title with a normal scan job", async () => {
    await connected();
    movies.push(movie(2, "My Second Wedding"));
    const item = movies[1]!;
    await symlinkFor(item);
    const body = { eventType: "Download", movie: { id: 2, title: item.title }, movieFile: { id: 2 }, isUpgrade: false };
    expect(await receiveRadarrWebhook(app.database.db, instanceId, body)).toMatchObject({ duplicate: false });
    expect(await receiveRadarrWebhook(app.database.db, instanceId, body)).toMatchObject({ duplicate: true });
    await dueEvents();
    await processRadarrWork(app.database.db);
    const jobs = await app.jobs.listJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ type: "scan", status: "queued" });
    expect(jobs[0]!.progress).toMatchObject({ options: { titleScopes: [{ section: "movies", itemName: "My Second Wedding (2020)" }], scanLocal: false, scanRemote: false } });
    const worker = new JobWorker(app.database.db, { workerId: "radarr-test-worker", logger: { info: () => undefined, warn: () => undefined, error: () => undefined } });
    await worker.runOnce();
    expect((await app.jobs.getJob(jobs[0]!.id))?.status).toBe("completed");
    const links = await app.database.db.select().from(schema.mediaLinks);
    expect(links).toHaveLength(1);
    expect(links[0]?.itemName).toBe("My Second Wedding (2020)");
    expect((await getRadarrState(app.database.db, instanceId)).events[0]?.jobStatus).toBe("completed");
  });

  it("queues refresh after an active job without letting scans overlap", async () => {
    await connected();
    await symlinkFor(movies[0]!);
    const activeId = await app.jobs.createJob("copy");
    await app.database.db.update(schema.jobs).set({ status: "running", lockedBy: "other-worker", heartbeatAt: new Date().toISOString() }).where(eq(schema.jobs.id, activeId));
    await receiveRadarrWebhook(app.database.db, instanceId, { eventType: "Download", movie: { id: 1, title: "My First Wedding" } });
    await dueEvents();
    await processRadarrWork(app.database.db);
    const jobs = await app.jobs.listJobs();
    expect(jobs).toHaveLength(2);
    const worker = new JobWorker(app.database.db, { workerId: "radarr-test-worker" });
    expect(await worker.runOnce()).toBe(false);
    expect(jobs.find((job) => job.type === "scan")?.status).toBe("queued");
  });

  it("waits for an imported symlink instead of marking an unavailable import scanned", async () => {
    await connected();
    await receiveRadarrWebhook(app.database.db, instanceId, { eventType: "Download", movie: { id: 1, title: "Wrong untrusted title" } });
    await dueEvents();
    await processRadarrWork(app.database.db);
    expect(await app.jobs.listJobs()).toHaveLength(0);
    expect((await getRadarrState(app.database.db, instanceId)).events[0]?.error).toContain("not available");
    await symlinkFor(movies[0]!);
    await dueEvents();
    await processRadarrWork(app.database.db);
    expect(await app.jobs.listJobs()).toHaveLength(1);
  });

  describe("title event batching", () => {
    const past = "2000-01-01T00:00:00.000Z";
    const deliver = (id: number, title: string, eventType: string, extra: Record<string, unknown> = {}) => receiveRadarrWebhook(app.database.db, instanceId, { eventType, movie: { id, title }, ...extra });
    const events = async () => (await app.database.db.select().from(schema.radarrEvents)).sort((a, b) => a.id - b.id);
    // Backdates received events (oldest first) by the given ages and makes them all due for an attempt.
    const ageEvents = async (agesMs: number[]) => {
      const rows = await events();
      for (const [index, row] of rows.entries()) await app.database.db.update(schema.radarrEvents).set({ receivedAt: new Date(Date.now() - (agesMs[index] ?? 0)).toISOString(), nextAttemptAt: past }).where(eq(schema.radarrEvents.id, row.id));
    };

    it("turns a burst of events for one movie into one scan job shared by every event", async () => {
      await connected();
      await symlinkFor(movies[0]!);
      for (const id of [11, 12, 13, 14, 15]) await deliver(1, "My First Wedding", "MovieFileDelete", { movieFile: { id } });
      // Still inside the quiet period: nothing happens yet, even though the 3 second delay has passed.
      await app.database.db.update(schema.radarrEvents).set({ nextAttemptAt: past });
      await processRadarrWork(app.database.db);
      expect(await app.jobs.listJobs()).toHaveLength(0);

      await ageEvents([20_000, 18_000, 16_000, 14_000, 12_000]);
      await processRadarrWork(app.database.db);
      const jobs = await app.jobs.listJobs();
      expect(jobs).toHaveLength(1);
      expect((await events()).map((event) => event.jobId)).toEqual(Array(5).fill(jobs[0]!.id));
      expect((await events()).every((event) => event.processedAt && !event.error)).toBe(true);
      expect((await app.jobs.listEvents(jobs[0]!.id)).map((event) => event.message)).toContain("Title refresh requested by Radarr (5 events)");
    });

    it("queues one job per movie when several movies share a burst", async () => {
      await connected();
      movies.push(movie(2, "My Second Wedding"));
      await symlinkFor(movies[0]!);
      await symlinkFor(movies[1]!);
      for (const [index, [id, title]] of ([[1, "My First Wedding"], [2, "My Second Wedding"], [1, "My First Wedding"], [2, "My Second Wedding"]] as const).entries()) await deliver(id, title, "Rename", { renamedMovieFiles: [{ relativePath: `renamed-${index}.mkv` }] });
      await ageEvents([30_000, 30_000, 30_000, 30_000]);
      await processRadarrWork(app.database.db);
      const jobs = await app.jobs.listJobs();
      expect(jobs).toHaveLength(2);
      const rows = await events();
      expect(rows[0]!.jobId).toBe(rows[2]!.jobId);
      expect(rows[1]!.jobId).toBe(rows[3]!.jobId);
      expect(rows[0]!.jobId).not.toBe(rows[1]!.jobId);
    });

    it("still scans a stream that never goes quiet once the maximum wait has passed", async () => {
      await connected();
      await symlinkFor(movies[0]!);
      for (const id of [21, 22, 23]) await deliver(1, "My First Wedding", "MovieFileDelete", { movieFile: { id } });
      // The newest event is seconds old, so the title is not quiet, and the oldest has waited less than a minute.
      await ageEvents([50_000, 20_000, 2_000]);
      await processRadarrWork(app.database.db);
      expect(await app.jobs.listJobs()).toHaveLength(0);
      await ageEvents([61_000, 20_000, 2_000]);
      await processRadarrWork(app.database.db);
      expect(await app.jobs.listJobs()).toHaveLength(1);
      expect((await events()).every((event) => event.processedAt)).toBe(true);
    });

    it("records an added movie without files in the catalog and queues no scan", async () => {
      await connected();
      movies.push(movie(2, "My Second Wedding"));
      await deliver(2, "My Second Wedding", "MovieAdded");
      await ageEvents([30_000]);
      await processRadarrWork(app.database.db);
      expect(await app.jobs.listJobs()).toHaveLength(0);
      expect((await events())[0]).toMatchObject({ jobId: null, error: expect.stringContaining("No rescan queued") });
      expect((await events())[0]!.processedAt).not.toBeNull();
      expect((await getRadarrState(app.database.db, instanceId)).movies.map((entry) => entry.movieId)).toContain(2);
    });

    it("scans an added movie whose folder already holds media symlinks", async () => {
      await connected();
      movies.push(movie(2, "My Second Wedding"));
      await symlinkFor(movies[1]!);
      await deliver(2, "My Second Wedding", "MovieAdded");
      await ageEvents([30_000]);
      await processRadarrWork(app.database.db);
      expect(await app.jobs.listJobs()).toHaveLength(1);
      expect((await events())[0]).toMatchObject({ error: null });
      expect((await events())[0]!.jobId).not.toBeNull();
    });

    it("holds every event of a movie back until a pending import's symlink exists", async () => {
      await connected();
      await deliver(1, "My First Wedding", "Download");
      await deliver(1, "My First Wedding", "Rename", { renamedMovieFiles: [{ relativePath: "x" }] });
      await ageEvents([30_000, 30_000]);
      await processRadarrWork(app.database.db);
      expect(await app.jobs.listJobs()).toHaveLength(0);
      expect((await events()).map((event) => [event.attempts, event.processedAt])).toEqual([[1, null], [1, null]]);
      expect((await events())[1]!.error).toContain("not available");
      await symlinkFor(movies[0]!);
      await ageEvents([30_000, 30_000]);
      await processRadarrWork(app.database.db);
      const jobs = await app.jobs.listJobs();
      expect(jobs).toHaveLength(1);
      expect((await events()).map((event) => event.jobId)).toEqual([jobs[0]!.id, jobs[0]!.id]);
    });

    it("keeps backing off failed batches and re-accepts a repeated delivery only after it was processed", async () => {
      await connected();
      await deliver(1, "My First Wedding", "Download");
      await ageEvents([30_000]);
      await processRadarrWork(app.database.db);
      const [failed] = await events();
      expect(failed).toMatchObject({ attempts: 1, processedAt: null });
      expect(Date.parse(failed!.nextAttemptAt!)).toBeGreaterThan(Date.now());
      expect(await deliver(1, "My First Wedding", "Download")).toMatchObject({ duplicate: true });
      expect(await events()).toHaveLength(1);
    });
  });

  it("uses stored identity for deletion and ignores untrusted paths in webhook bodies", async () => {
    await connected();
    await receiveRadarrWebhook(app.database.db, instanceId, { eventType: "MovieDelete", movie: { id: 1, title: "../wrong", folderPath: "/etc" } });
    await dueEvents();
    await processRadarrWork(app.database.db);
    expect((await app.jobs.listJobs())[0]?.progress).toMatchObject({ options: { titleScopes: [{ section: "movies", itemName: "My First Wedding (2020)" }] } });
  });

  it("requires a webhook secret even with an admin cookie and protects settings with session authentication", async () => {
    await connected();
    const setup = await app.app.inject({ method: "POST", url: "/api/auth/setup", payload: { username: "fixture", password: "fixture-password-123", confirmPassword: "fixture-password-123" } });
    const cookie = String(setup.headers["set-cookie"]);
    expect((await app.app.inject({ method: "GET", url: "/api/settings/radarr" })).statusCode).toBe(401);
    expect((await app.app.inject({ method: "POST", url: `/api/integrations/radarr/${instanceId}/webhook`, headers: { cookie }, payload: { eventType: "Test" } })).statusCode).toBe(401);
    expect((await app.app.inject({ method: "POST", url: `/api/integrations/radarr/${instanceId}/webhook`, headers: { "x-srtl-webhook-secret": webhookSecret }, payload: { eventType: "Test" } })).statusCode).toBe(202);
    expect((await app.app.inject({ method: "PUT", url: `/api/settings/radarr/instances/${instanceId}`, headers: { "x-srtl-webhook-secret": webhookSecret }, payload: input })).statusCode).toBe(401);
    expect((await app.app.inject({ method: "POST", url: `/api/settings/radarr/instances/${instanceId}/test`, headers: { cookie, origin: "https://untrusted.invalid" }, payload: input })).statusCode).toBe(403);
  });

  it("supports the authenticated configuration and policy workflow through the HTTP API", async () => {
    const setup = await app.app.inject({ method: "POST", url: "/api/auth/setup", payload: { username: "fixture", password: "fixture-password-123", confirmPassword: "fixture-password-123" } });
    expect(setup.statusCode).toBe(200);
    const cookie = String(setup.headers["set-cookie"]);
    expect((await app.app.inject({ method: "POST", url: `/api/settings/radarr/instances/${instanceId}/test`, headers: { cookie }, payload: input })).json()).toEqual({ version: "6.0.0", rootFolders: ["/library"], automaticMappings: [], unmatchedRootFolders: ["/library"], conflictingRootFolders: [] });
    const saved = await app.app.inject({ method: "PUT", url: `/api/settings/radarr/instances/${instanceId}`, headers: { cookie }, payload: input });
    expect(saved.statusCode).toBe(200);
    expect(saved.body).not.toContain(apiKey);
    expect(saved.body).not.toContain(webhookSecret);
    const reviewed = await app.app.inject({ method: "POST", url: `/api/settings/radarr/instances/${instanceId}/reconcile`, headers: { cookie }, payload: { movieIds: [1], action: "use_srtl" } });
    expect(reviewed.statusCode).toBe(200);
    await symlinkFor(movies[0]!);
    expect((await app.app.inject({ method: "POST", url: `/api/integrations/radarr/${instanceId}/webhook`, headers: { "x-srtl-webhook-secret": webhookSecret }, payload: { eventType: "Download", movie: { id: 1, title: "My First Wedding" } } })).statusCode).toBe(202);
    await dueEvents();
    await processRadarrWork(app.database.db);
    await new JobWorker(app.database.db, { workerId: "radarr-http-test" }).runOnce();
    expect((await app.app.inject({ method: "POST", url: "/api/storage-policies", headers: { cookie }, payload: { title: "My First Wedding (2020)", policy: "location_1" } })).statusCode).toBe(200);
    await processRadarrWork(app.database.db);
    const status = await app.app.inject({ method: "GET", url: `/api/settings/radarr/instances/${instanceId}`, headers: { cookie } });
    expect(status.json().movies[0]).toMatchObject({ policy: "location_1", status: "synced" });
    expect((await app.app.inject({ method: "GET", url: "/api/settings/radarr/copy-defaults" })).statusCode).toBe(401);
    expect((await app.app.inject({ method: "GET", url: "/api/settings/radarr/copy-defaults", headers: { cookie } })).json()).toEqual({ sections: [{ section: "movies", instanceId, instanceName: "Radarr", monitorOnCopy: false }] });
    const copy = await app.app.inject({ method: "POST", url: "/api/copies", headers: { cookie }, payload: { direction: "to_local", section: "movies", radarrMonitoring: true } });
    expect(copy.statusCode).toBe(200);
    expect((await app.jobs.getJob(copy.json().jobId))?.progress).toMatchObject({ options: { direction: "to_local", radarrMonitoring: true } });
  });

  it("does not process work during onboarding", async () => {
    await connected();
    await reconcileRadarrMovies(app.database.db, instanceId, [1], "use_srtl");
    await setStoragePolicyTitle(app.database.db, "My First Wedding (2020)", "location_1");
    const onboarding = await getJsonSetting<Record<string, unknown>>(app.database.db, onboardingSettingKey, {});
    await setSetting(app.database.db, onboardingSettingKey, { ...onboarding, status: "configuration_required" });
    await processRadarrWork(app.database.db);
    expect(edits).toHaveLength(0);
    await markOnboardingCompleteForExistingInstall(app.database.db);
    await processRadarrWork(app.database.db);
    expect(edits).toHaveLength(1);
  });

  it("matches only direct mapped folders and rejects metadata contradictions and unsafe destinations", async () => {
    expect(mapRadarrMovie(movie(1), input)).toEqual({ section: "movies", itemName: "My First Wedding (2020)" });
    expect(mapRadarrMovie({ ...movie(1), path: "/library/../etc" }, input)).toBeNull();
    expect(mapRadarrMovie({ ...movie(1), path: "/library/nested/title" }, input)).toBeNull();
    expect(mapRadarrMovie({ ...movie(1), path: "/library/Title {tmdb-999}" }, input)).toBeNull();
    for (const address of ["0.0.0.0", "169.254.169.254", "::ffff:169.254.169.254", "fe80::1", "ff02::1", "::"]) expect(radarrAddressAllowed(address)).toBe(false);
    for (const address of ["127.0.0.1", "10.20.30.40", "192.168.1.2", "::1", "fd00::1"]) expect(radarrAddressAllowed(address)).toBe(true);
    for (const url of ["file:///etc/passwd", "http://user:password@localhost", "http://localhost?key=secret"]) expect(() => normalizeRadarrUrl(url)).toThrow();
    expect(await new RadarrClient(input.baseUrl, apiKey).test()).toEqual({ version: "6.0.0", rootFolders: ["/library"] });
  });

  it("rejects redirects and failed credentials without disclosing remote responses or secrets", async () => {
    await expect(new RadarrClient(input.baseUrl, "wrongKey").test()).rejects.toThrow("Radarr rejected the API key");
    redirect = true;
    await expect(new RadarrClient(input.baseUrl, apiKey).test()).rejects.toThrow("Radarr returned HTTP 302");
    expect(edits).toHaveLength(0);
  });

  it("ignores unmapped notifications without retrying them or starting jobs", async () => {
    await connected();
    movies.push({ ...movie(2), path: "/other/Unmapped" });
    await receiveRadarrWebhook(app.database.db, instanceId, { eventType: "Download", movie: { id: 2, title: "Unmapped" } });
    await dueEvents();
    await processRadarrWork(app.database.db);
    expect((await getRadarrState(app.database.db, instanceId)).events[0]).toMatchObject({ processedAt: expect.any(String), error: "Ignored: movie is outside the configured folder mappings.", jobId: null });
    expect(await app.jobs.listJobs()).toHaveLength(0);
  });

  it("refuses a title folder redirected outside the configured symlink root", async () => {
    await connected();
    const outside = path.join(root, "outside");
    await fs.mkdir(outside);
    await fs.symlink(outside, path.join(root, "links", "movies", "My First Wedding (2020)"));
    await fs.symlink(path.join(root, "remote", "missing.mkv"), path.join(outside, "My First Wedding.mkv"));
    await receiveRadarrWebhook(app.database.db, instanceId, { eventType: "Download", movie: { id: 1, title: "My First Wedding" } });
    await dueEvents();
    await processRadarrWork(app.database.db);
    expect((await getRadarrState(app.database.db, instanceId)).events[0]?.error).toContain("outside the symlink root");
    expect(await app.jobs.listJobs()).toHaveLength(0);
  });

  it("pauses tag synchronization and authenticated webhooks during path maintenance", async () => {
    await connected();
    await reconcileRadarrMovies(app.database.db, instanceId, [1], "use_srtl");
    await setStoragePolicyTitle(app.database.db, "My First Wedding (2020)", "location_1");
    const replacement = path.join(root, "new-links");
    await fs.mkdir(replacement);
    await reconcileEnvironmentPaths(app.database.db, { ...app.config.paths, symlinkDir: replacement });
    await processRadarrWork(app.database.db);
    expect(edits).toHaveLength(0);
    expect((await app.app.inject({ method: "POST", url: `/api/integrations/radarr/${instanceId}/webhook`, headers: { "x-srtl-webhook-secret": webhookSecret }, payload: { eventType: "Test" } })).statusCode).toBe(423);
  });

  it("refuses importing policies over a queued title scan, including titles absent from inventory", async () => {
    movies[0]!.tags = [1];
    await connected();
    await app.jobs.startExternalTitleScan([{ section: "movies", itemName: "My First Wedding (2020)" }]);
    await expect(reconcileRadarrMovies(app.database.db, instanceId, [1], "import_tags")).rejects.toThrow("Storage policy cannot be changed");
    expect((await getRadarrState(app.database.db, instanceId)).movies[0]?.policy).toBe("unassigned");
  });

  it("retains review when path mappings change and refresh never writes remote tags", async () => {
    await connected();
    await reconcileRadarrMovies(app.database.db, instanceId, [1], "use_srtl");
    await refreshRadarr(app.database.db, instanceId);
    expect((await getRadarrState(app.database.db, instanceId)).movies[0]?.managed).toBe(true);
    await saveRadarrSettings(app.database.db, instanceId, { ...input, revision: 1, mappings: [] , enabled: false });
    expect((await getRadarrState(app.database.db, instanceId)).movies[0]).toMatchObject({ managed: false, status: "unmapped" });
    expect(edits).toHaveLength(0);
  });

  it("tags untagged titles on enable, keeps opposite tags in review, and lets explicit policy changes take over", async () => {
    movies = [movie(1, "Alpha", [3]), movie(2, "Bravo", [2, 3]), movie(3, "Charlie")];
    await setStoragePolicyTitle(app.database.db, "Alpha (2020)", "location_1");
    await setStoragePolicyTitle(app.database.db, "Bravo (2020)", "location_1");
    await connected();
    await processRadarrWork(app.database.db);
    expect([...movies[0]!.tags].sort()).toEqual([1, 3]);
    expect(movies[1]!.tags).toEqual([2, 3]);
    expect(movies[2]!.tags).toEqual([]);
    const statuses = Object.fromEntries((await getRadarrState(app.database.db, instanceId)).movies.map((item) => [item.movieId, item.status]));
    expect(statuses).toEqual({ 1: "synced", 2: "review", 3: "synced" });
    await setStoragePolicyTitle(app.database.db, "Bravo (2020)", "location_1");
    await processRadarrWork(app.database.db);
    expect([...movies[1]!.tags].sort()).toEqual([1, 3]);
    expect((await getRadarrState(app.database.db, instanceId)).movies.find((item) => item.movieId === 2)).toMatchObject({ managed: true, status: "synced" });
  });

  it("applies policy tags to many titles with batched Radarr edits", async () => {
    movies = Array.from({ length: 30 }, (_, index) => movie(index + 1, `Wedding ${index + 1}`, index % 2 ? [1, 3] : [3]));
    await connected();
    await processRadarrWork(app.database.db);
    expect(edits).toEqual([]);
    for (const item of movies) await setStoragePolicyTitle(app.database.db, `${item.title} (2020)`, "location_2");
    await processRadarrWork(app.database.db);
    expect(movies.every((item) => item.tags.includes(2) && item.tags.includes(3) && !item.tags.includes(1))).toBe(true);
    expect(edits).toEqual([{ movieIds: movies.filter((_, index) => index % 2).map((item) => item.id), tags: [1], applyTags: "remove" }, { movieIds: movies.map((item) => item.id), tags: [2], applyTags: "add" }]);
    expect((await getRadarrState(app.database.db, instanceId)).movies.every((item) => item.status === "synced")).toBe(true);
  });

  it("enables tag synchronization without a webhook secret while rejecting webhooks", async () => {
    const saved = await saveRadarrSettings(app.database.db, instanceId, { ...input, webhookSecret: "" });
    expect(saved.settings).toMatchObject({ enabled: true, hasWebhookSecret: false });
    await setStoragePolicyTitle(app.database.db, "My First Wedding (2020)", "location_1");
    await processRadarrWork(app.database.db);
    expect(movies[0]!.tags).toEqual([1]);
    expect((await app.app.inject({ method: "POST", url: `/api/integrations/radarr/${instanceId}/webhook`, headers: { "x-srtl-webhook-secret": webhookSecret }, payload: { eventType: "Test" } })).statusCode).toBe(401);
  });

  it("updates Radarr monitoring only for requested copies whose files all reached the destination", async () => {
    await saveRadarrSettings(app.database.db, instanceId, { ...input, monitorOnCopy: true });
    await setSetting(app.database.db, "advancedSettings", { copy: { profile: "fast" } });
    expect(await getRadarrCopyDefaults(app.database.db)).toEqual({ sections: [{ section: "movies", instanceId, instanceName: "Radarr", monitorOnCopy: true }] });
    const itemName = "My First Wedding (2020)";
    const remoteFile = path.join(root, "remote", itemName, "My First Wedding.mkv");
    await fs.mkdir(path.dirname(remoteFile), { recursive: true });
    await fs.writeFile(remoteFile, "test movie bytes");
    await fs.mkdir(path.join(root, "links", "movies", itemName), { recursive: true });
    await fs.symlink(remoteFile, path.join(root, "links", "movies", itemName, "My First Wedding.mkv"));
    // Placeholder bytes stand in for media here, so the content preflight is left out of this copy runner.
    const copyRunner = { copyFile: defaultCopyRunner.copyFile, runCmp: defaultCopyRunner.runCmp, runFfmpeg: defaultCopyRunner.runFfmpeg };
    const worker = new JobWorker(app.database.db, { workerId: "radarr-copy-test", copyRunner, logger: { info: () => undefined, warn: () => undefined, error: () => undefined } });
    await app.jobs.startExternalTitleScan([{ section: "movies", itemName }]);
    await worker.runOnce();
    await setStoragePolicyTitle(app.database.db, itemName, "location_1");
    const [link] = await app.database.db.select().from(schema.mediaLinks);
    expect(link).toMatchObject({ kind: "remote" });
    const monitorEdits = () => edits.filter((edit) => "monitored" in edit);
    async function terminalCopyJob(status: string, options: Record<string, unknown>) {
      const timestamp = new Date().toISOString();
      const [job] = await app.database.db.insert(schema.jobs).values({ type: "copy", status, createdAt: timestamp, finishedAt: timestamp, options: JSON.stringify(options), progress: "{}" }).returning();
      await app.database.db.insert(schema.jobSelectionItems).values({ jobId: job!.id, mediaLinkId: link!.id, selectionOrder: 0, section: "movies", itemName, relativePath: link!.relativePath, linkPath: link!.linkPath, createdAt: timestamp });
      return job!.id;
    }

    const failed = await terminalCopyJob("failed", { direction: "to_local", radarrMonitoring: true });
    await processRadarrWork(app.database.db);
    expect(monitorEdits()).toEqual([]);
    expect((await getRadarrState(app.database.db, instanceId)).monitorUpdates[0]).toMatchObject({ copyJobId: failed, monitored: false, error: expect.stringContaining("Skipped") });

    const requested = await app.jobs.startCopy({ direction: "to_local", linkIds: [link!.id], radarrMonitoring: true });
    await worker.runOnce();
    expect((await app.jobs.getJob(requested))?.status).toBe("completed");
    await processRadarrWork(app.database.db);
    expect(movies[0]!.monitored).toBe(false);
    expect(monitorEdits()).toEqual([{ movieIds: [1], monitored: false }]);
    expect((await getRadarrState(app.database.db, instanceId)).movies[0]?.monitored).toBe(false);
    expect((await app.jobs.listEvents(requested)).map((event) => event.message)).toContain("Unmonitored in Radarr: My First Wedding (2020)");

    await terminalCopyJob("completed", { direction: "to_local" });
    await processRadarrWork(app.database.db);
    expect(monitorEdits()).toHaveLength(1);
    await app.database.db.update(schema.mediaLinks).set({ kind: "remote" });
    await terminalCopyJob("completed", { direction: "to_remote", radarrMonitoring: true });
    await processRadarrWork(app.database.db);
    expect(monitorEdits()).toEqual([{ movieIds: [1], monitored: false }, { movieIds: [1], monitored: true }]);
    expect(movies[0]!.monitored).toBe(true);
  });

  describe("per-title copy monitoring", () => {
    const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };
    const monitorEdits = () => edits.filter((edit) => "monitored" in edit);
    const copyUpdates = async (jobId: number) => (await app.database.db.select().from(schema.radarrMonitorUpdates).where(eq(schema.radarrMonitorUpdates.copyJobId, jobId)).orderBy(schema.radarrMonitorUpdates.id))
      .map((update) => ({ movieId: update.movieId, monitored: update.monitored, error: update.error }));

    // Three scanned remote titles kept local by policy, and a copy runner that can fail one title or hold another mid-copy.
    async function threeTitles(options: { fail?: string; hold?: string } = {}) {
      movies = [movie(1, "Alpha"), movie(2, "Bravo"), movie(3, "Charlie")];
      await saveRadarrSettings(app.database.db, instanceId, { ...input, monitorOnCopy: true });
      await setSetting(app.database.db, "advancedSettings", { copy: { profile: "fast" } });
      const itemNames = movies.map((item) => `${item.title} (2020)`);
      for (const [index, itemName] of itemNames.entries()) {
        const remoteFile = path.join(root, "remote", itemName, `${movies[index]!.title}.mkv`);
        await fs.mkdir(path.dirname(remoteFile), { recursive: true });
        await fs.writeFile(remoteFile, "test movie bytes");
        await fs.mkdir(path.join(root, "links", "movies", itemName), { recursive: true });
        await fs.symlink(remoteFile, path.join(root, "links", "movies", itemName, `${movies[index]!.title}.mkv`));
      }
      let release = () => undefined as void;
      const released = new Promise<void>((resolve) => { release = resolve; });
      let reached = () => undefined as void;
      const held = new Promise<void>((resolve) => { reached = resolve; });
      let queuedWhenHeld: number[] | null = null;
      const copyRunner: CopyCommandRunner = {
        async copyFile(sourcePath, tempPath, reportProgress, signal) {
          if (options.hold && sourcePath.includes(options.hold)) {
            queuedWhenHeld = (await app.database.db.select().from(schema.radarrMonitorUpdates)).map((update) => update.movieId);
            reached();
            await released;
          }
          return defaultCopyRunner.copyFile(sourcePath, tempPath, reportProgress, signal);
        },
        runCmp: defaultCopyRunner.runCmp,
        runFfmpeg: defaultCopyRunner.runFfmpeg,
        // Placeholder bytes stand in for media, so the preflight passes everything except the title chosen to fail.
        async inspectSource(sourcePath) {
          const failing = Boolean(options.fail && sourcePath.includes(options.fail));
          return { status: failing ? "fail" : "pass", problems: failing ? ["unreadable video stream"] : [], warnings: [], durationSeconds: null };
        }
      };
      const worker = new JobWorker(app.database.db, { workerId: "radarr-per-title", copyRunner, logger: quiet, copiedTitles: (copy, titles) => queueCopiedTitleMonitorUpdates(app.database.db, copy, titles) });
      await app.jobs.startExternalTitleScan(itemNames.map((itemName) => ({ section: "movies", itemName })));
      await worker.runOnce();
      for (const itemName of itemNames) await setStoragePolicyTitle(app.database.db, itemName, "location_1");
      const links = (await app.database.db.select().from(schema.mediaLinks)).sort((left, right) => left.itemName.localeCompare(right.itemName));
      expect(links.map((link) => [link.itemName, link.kind])).toEqual(itemNames.map((itemName) => [itemName, "remote"]));
      return { worker, links, held, release, queuedWhenHeld: () => queuedWhenHeld };
    }

    it("queues each title as it is verified, never a failed one, and once per movie after the job ends", async () => {
      const batch = await threeTitles({ fail: "Bravo", hold: "Charlie" });
      const jobId = await app.jobs.startCopy({ direction: "to_local", linkIds: batch.links.map((link) => link.id), radarrMonitoring: true });
      const run = batch.worker.runOnce();
      await batch.held;
      // Alpha was queued before Charlie began copying; the failed Bravo was not.
      expect(batch.queuedWhenHeld()).toEqual([1]);
      // While the job is still running, the Radarr loop unmonitors Alpha and reports it on the copy job.
      expect((await app.jobs.getJob(jobId))?.status).toBe("running");
      await processRadarrWork(app.database.db);
      expect(monitorEdits()).toEqual([{ movieIds: [1], monitored: false }]);
      expect(movies.map((item) => item.monitored)).toEqual([false, true, true]);
      expect((await app.jobs.listEvents(jobId)).map((event) => event.message)).toContain("Unmonitored in Radarr: Alpha (2020)");

      batch.release();
      await run;
      expect((await app.jobs.getJob(jobId))?.status).toBe("partially_failed");
      expect(await copyUpdates(jobId)).toEqual([{ movieId: 1, monitored: false, error: null }, { movieId: 3, monitored: false, error: null }]);
      await processRadarrWork(app.database.db);
      await processRadarrWork(app.database.db);
      await queueCopiedTitleMonitorUpdates(app.database.db, { jobId, direction: "to_local" }, batch.links.map((link) => ({ section: link.section, itemName: link.itemName })));
      await processRadarrWork(app.database.db);
      // The end-of-job pass only records the failed title; nothing is queued or sent twice.
      expect(await copyUpdates(jobId)).toEqual([
        { movieId: 1, monitored: false, error: null },
        { movieId: 3, monitored: false, error: null },
        { movieId: 2, monitored: false, error: "Skipped: not every file of this movie finished copying." }
      ]);
      expect(monitorEdits()).toEqual([{ movieIds: [1], monitored: false }, { movieIds: [3], monitored: false }]);
      expect(movies.map((item) => item.monitored)).toEqual([false, true, false]);
      const messages = (await app.jobs.listEvents(jobId)).map((event) => event.message);
      expect(messages.filter((message) => message.startsWith("Unmonitored in Radarr"))).toEqual(["Unmonitored in Radarr: Alpha (2020)", "Unmonitored in Radarr: Charlie (2020)"]);
    });

    it("keeps completed titles' updates when the job never finishes", async () => {
      const batch = await threeTitles({ hold: "Charlie" });
      const jobId = await app.jobs.startCopy({ direction: "to_local", linkIds: batch.links.map((link) => link.id), radarrMonitoring: true });
      const run = batch.worker.runOnce();
      await batch.held;
      // The job is stuck on Charlie, so the end-of-job pass never runs, yet Alpha and Bravo are unmonitored.
      await processRadarrWork(app.database.db);
      expect((await app.jobs.getJob(jobId))?.status).toBe("running");
      expect(await app.database.db.select().from(schema.radarrCopyJobs)).toEqual([]);
      expect(monitorEdits()).toEqual([{ movieIds: [1, 2], monitored: false }]);
      expect(movies.map((item) => item.monitored)).toEqual([false, false, true]);
      batch.release();
      await run;
    });

    it("puts monitoring back for titles a terminated copy rolled back", async () => {
      const batch = await threeTitles({ hold: "Charlie" });
      const jobId = await app.jobs.startCopy({ direction: "to_local", linkIds: batch.links.map((link) => link.id), radarrMonitoring: true });
      const run = batch.worker.runOnce();
      await batch.held;
      // Alpha's change reaches Radarr; Bravo's is still queued when the job is terminated.
      await app.database.db.update(schema.radarrMonitorUpdates).set({ nextAttemptAt: "2999-01-01T00:00:00.000Z" }).where(eq(schema.radarrMonitorUpdates.movieId, 2));
      await processRadarrWork(app.database.db);
      expect(monitorEdits()).toEqual([{ movieIds: [1], monitored: false }]);
      expect(await app.jobs.cancel(jobId)).toBe(true);
      batch.release();
      await run;
      expect((await app.jobs.getJob(jobId))?.status).toBe("cancelled");
      expect((await app.database.db.select().from(schema.mediaLinks)).map((link) => link.kind)).toEqual(["remote", "remote", "remote"]);
      await processRadarrWork(app.database.db);
      await processRadarrWork(app.database.db);
      expect(await copyUpdates(jobId)).toEqual([
        { movieId: 1, monitored: false, error: null },
        { movieId: 2, monitored: false, error: "Skipped: the copy was terminated and rolled back." },
        { movieId: 1, monitored: true, error: null },
        { movieId: 3, monitored: false, error: "Skipped: not every file of this movie finished copying." }
      ]);
      expect(monitorEdits()).toEqual([{ movieIds: [1], monitored: false }, { movieIds: [1], monitored: true }]);
      expect(movies.map((item) => item.monitored)).toEqual([true, true, true]);
      expect((await app.jobs.listEvents(jobId)).map((event) => event.message)).toContain("Monitored in Radarr: Alpha (2020)");
    });

    it("leaves monitoring alone for copies that did not ask for it", async () => {
      const batch = await threeTitles();
      const jobId = await app.jobs.startCopy({ direction: "to_local", linkIds: batch.links.map((link) => link.id) });
      await batch.worker.runOnce();
      expect((await app.jobs.getJob(jobId))?.status).toBe("completed");
      await processRadarrWork(app.database.db);
      expect(await copyUpdates(jobId)).toEqual([]);
      expect(monitorEdits()).toEqual([]);
    });
  });

  it("orders preview titles alphabetically regardless of Radarr response order", async () => {
    movies = [movie(3, "Zebra Crossing"), movie(1, "Anniversary"), movie(2, "My First Wedding")];
    await connected();
    expect((await getRadarrState(app.database.db, instanceId)).movies.map((item) => item.movieId)).toEqual([1, 2, 3]);
  });
});

interface FakeRadarr {
  url: string;
  movies: RadarrMovie[];
  tags: Array<{ id: number; label: string }>;
  edits: Array<{ movieIds: number[]; tags?: number[]; applyTags?: string; monitored?: boolean }>;
  rootFolders: string[];
  offline: boolean;
  delayMs: number;
  requests: number;
}

describe("multiple Radarr instances", () => {
  const servers: FastifyInstance[] = [];
  const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };

  async function fakeRadarr(movieList: RadarrMovie[], rootFolderList: string[], tagList = [{ id: 1, label: "local" }, { id: 2, label: "ignored" }]): Promise<FakeRadarr> {
    const server = fastify();
    servers.push(server);
    const fake: FakeRadarr = { url: "", movies: movieList, tags: tagList, edits: [], rootFolders: rootFolderList, offline: false, delayMs: 0, requests: 0 };
    server.addHook("preHandler", async (request, reply) => {
      fake.requests += 1;
      if (fake.delayMs) await new Promise((resolve) => setTimeout(resolve, fake.delayMs));
      if (fake.offline) return reply.code(503).send({ error: "offline" });
      if (request.headers["x-api-key"] !== apiKey) return reply.code(401).send({ error: "bad key" });
    });
    server.get("/api/v3/system/status", async () => ({ appName: "Radarr", version: "6.0.0" }));
    server.get("/api/v3/rootfolder", async () => fake.rootFolders.map((folder) => ({ path: folder })));
    server.get("/api/v3/movie", async () => fake.movies);
    server.get<{ Params: { id: string } }>("/api/v3/movie/:id", async (request, reply) => fake.movies.find((item) => item.id === Number(request.params.id)) ?? reply.code(404).send({ error: "missing" }));
    server.get("/api/v3/tag", async () => fake.tags);
    server.post<{ Body: { label: string } }>("/api/v3/tag", async (request) => {
      const tag = { id: fake.tags.length + 1, label: request.body.label };
      fake.tags.push(tag);
      return tag;
    });
    server.put<{ Body: FakeRadarr["edits"][number] }>("/api/v3/movie/editor", async (request) => {
      fake.edits.push(request.body);
      const { tags: editTags = [], applyTags, monitored } = request.body;
      for (const item of fake.movies.filter((entry) => request.body.movieIds.includes(entry.id))) {
        if (applyTags) item.tags = applyTags === "add" ? [...new Set([...item.tags, ...editTags])] : item.tags.filter((id) => !editTags.includes(id));
        if (monitored !== undefined) item.monitored = monitored;
      }
      return fake.movies;
    });
    fake.url = await server.listen({ host: "127.0.0.1", port: 0 });
    return fake;
  }

  // Radarr reuses small movie ids, so every instance here has a movie with id 1.
  function titleIn(rootPath: string, id: number, title: string, assignedTags: number[] = []): RadarrMovie {
    return { ...movie(id, title, assignedTags), path: `${rootPath}/${title} (2020)` };
  }

  function settingsFor(fake: FakeRadarr, mappings: RadarrSettingsInput["mappings"], extra: Partial<RadarrSettingsInput> = {}): RadarrSettingsInput {
    return { ...input, baseUrl: fake.url, webhookSecret: "", mappings, ...extra };
  }

  async function scannedLink(section: string, itemName: string, fileName: string) {
    const remoteFile = path.join(root, "remote", section, itemName, fileName);
    await fs.mkdir(path.dirname(remoteFile), { recursive: true });
    await fs.writeFile(remoteFile, "test movie bytes");
    await fs.mkdir(path.join(root, "links", section, itemName), { recursive: true });
    await fs.symlink(remoteFile, path.join(root, "links", section, itemName, fileName));
  }

  beforeEach(async () => {
    await persistSectionSettings(app.database.db, { sections: ["movies", "movies4k", "anime"], sectionTypes: { movies: "movies", movies4k: "movies", anime: "movies" }, sectionTitles: { movies: "Movies", movies4k: "Movies 4K", anime: "Anime" } });
  });

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
  });

  it("keeps three instances with overlapping movie ids apart, each with its own tags", async () => {
    const hd = await fakeRadarr([titleIn("/library", 1, "Alpha"), titleIn("/library", 2, "Bravo")], ["/library"]);
    const uhd = await fakeRadarr([titleIn("/library4k", 1, "Alpha"), titleIn("/library4k", 2, "Charlie")], ["/library4k"], [{ id: 7, label: "keep" }]);
    const anime = await fakeRadarr([titleIn("/anime", 1, "Delta")], ["/anime"]);
    await saveRadarrSettings(app.database.db, instanceId, settingsFor(hd, [{ rootPath: "/library", section: "movies" }]));
    const uhdId = (await createRadarrInstance(app.database.db, "Radarr 4K")).settings.id;
    await saveRadarrSettings(app.database.db, uhdId, settingsFor(uhd, [{ rootPath: "/library4k", section: "movies4k" }], { localTag: "keep", remoteTag: "cloud" }));
    const animeId = (await createRadarrInstance(app.database.db, "Anime")).settings.id;
    await saveRadarrSettings(app.database.db, animeId, settingsFor(anime, [{ rootPath: "/anime", section: "anime" }]));

    await setStoragePolicyTitle(app.database.db, "Alpha (2020)", "location_2");
    await setStoragePolicyTitle(app.database.db, "Charlie (2020)", "location_1");
    await processRadarrWork(app.database.db);
    // The same title in two folders follows one SRTL policy, under each instance's own tag names.
    expect(hd.movies.find((item) => item.id === 1)?.tags).toEqual([2]);
    const cloud = uhd.tags.find((tag) => tag.label === "cloud")!;
    expect(uhd.movies.find((item) => item.id === 1)?.tags).toEqual([cloud.id]);
    expect(hd.tags.map((tag) => tag.label)).not.toContain("cloud");
    expect(uhd.movies.find((item) => item.id === 2)?.tags).toEqual([7]);
    expect(hd.movies.find((item) => item.id === 2)?.tags).toEqual([]);
    expect(anime.movies[0]?.tags).toEqual([]);

    const states = await Promise.all([instanceId, uhdId, animeId].map((id) => getRadarrState(app.database.db, id)));
    expect(states.map((state) => state.movies.map((item) => `${item.movieId}:${item.title}:${item.section}:${item.status}`))).toEqual([
      ["1:Alpha (2020):movies:synced", "2:Bravo (2020):movies:synced"],
      ["1:Alpha (2020):movies4k:synced", "2:Charlie (2020):movies4k:synced"],
      ["1:Delta (2020):anime:synced"]
    ]);
    const overview = await getRadarrOverview(app.database.db);
    expect(overview.instances.map((summary) => [summary.settings.name, summary.movies, summary.settings.mappings.map((mapping) => mapping.section)])).toEqual([["Radarr", 2, ["movies"]], ["Radarr 4K", 2, ["movies4k"]], ["Anime", 1, ["anime"]]]);
    expect(JSON.stringify(overview)).not.toContain(apiKey);

    // Refreshing one instance leaves the others' rows with the same movie ids untouched.
    uhd.movies = [];
    await refreshRadarr(app.database.db, uhdId);
    expect((await getRadarrState(app.database.db, uhdId)).movies).toEqual([]);
    expect((await getRadarrState(app.database.db, instanceId)).movies).toHaveLength(2);
    expect((await getRadarrState(app.database.db, animeId)).movies).toHaveLength(1);
  });

  it("lets each SRTL folder belong to only one instance", async () => {
    const hd = await fakeRadarr([titleIn("/library", 1, "Alpha")], ["/library"]);
    await saveRadarrSettings(app.database.db, instanceId, settingsFor(hd, [{ rootPath: "/library", section: "movies" }]));
    const linksRoot = path.join(root, "links");
    const uhd = await fakeRadarr([titleIn(path.join(linksRoot, "movies4k"), 1, "Alpha")], [path.join(linksRoot, "movies"), path.join(linksRoot, "movies4k"), "/elsewhere"]);
    const uhdId = (await createRadarrInstance(app.database.db, "Radarr 4K")).settings.id;

    await expect(saveRadarrSettings(app.database.db, uhdId, settingsFor(uhd, [{ rootPath: "/elsewhere", section: "movies" }]))).rejects.toThrow("The Movies folder is already mapped by Radarr. Remove it from that instance first");
    const detected = await testRadarrConnection(app.database.db, uhdId, settingsFor(uhd, [], { mappingMode: "auto", enabled: false }));
    expect(detected.automaticMappings).toEqual([{ rootPath: path.join(linksRoot, "movies4k"), section: "movies4k" }]);
    expect(detected.conflictingRootFolders).toEqual([{ rootPath: path.join(linksRoot, "movies"), section: "movies", instanceId, instanceName: "Radarr" }]);
    expect(detected.unmatchedRootFolders).toEqual(["/elsewhere"]);
    const saved = await saveRadarrSettings(app.database.db, uhdId, settingsFor(uhd, [], { mappingMode: "auto" }));
    expect(saved.settings.mappings).toEqual([{ rootPath: path.join(linksRoot, "movies4k"), section: "movies4k" }]);

    // The first instance cannot take the 4K folder either, over HTTP or directly.
    const current = (await getRadarrState(app.database.db, instanceId)).settings;
    await expect(saveRadarrSettings(app.database.db, instanceId, { ...settingsFor(hd, [{ rootPath: "/library", section: "movies" }, { rootPath: "/library4k", section: "movies4k" }]), revision: current.revision })).rejects.toThrow("already mapped by Radarr 4K");
    expect(await getRadarrCopyDefaults(app.database.db)).toEqual({ sections: [
      { section: "movies", instanceId, instanceName: "Radarr", monitorOnCopy: false },
      { section: "movies4k", instanceId: uhdId, instanceName: "Radarr 4K", monitorOnCopy: false }
    ] });

    // Removing an instance frees its folders.
    await removeRadarrInstance(app.database.db, uhdId);
    const remapped = await saveRadarrSettings(app.database.db, instanceId, { ...settingsFor(hd, [{ rootPath: "/library", section: "movies" }, { rootPath: "/library4k", section: "movies4k" }]), revision: current.revision });
    expect(remapped.settings.mappings.map((mapping) => mapping.section)).toEqual(["movies", "movies4k"]);
  });

  it("gives each instance its own webhook secret, duplicate detection, and rate limit", async () => {
    const hd = await fakeRadarr([titleIn("/library", 1, "Alpha")], ["/library"]);
    const uhd = await fakeRadarr([titleIn("/library4k", 1, "Alpha")], ["/library4k"]);
    const uhdSecret = "a_different_secret_for_the_4k_instance";
    await saveRadarrSettings(app.database.db, instanceId, settingsFor(hd, [{ rootPath: "/library", section: "movies" }], { webhookSecret }));
    const uhdId = (await createRadarrInstance(app.database.db, "Radarr 4K")).settings.id;
    await saveRadarrSettings(app.database.db, uhdId, settingsFor(uhd, [{ rootPath: "/library4k", section: "movies4k" }], { webhookSecret: uhdSecret }));
    const post = (instance: string | null, secret: string, payload: Record<string, unknown> = { eventType: "Test" }) => app.app.inject({ method: "POST", url: instance ? `/api/integrations/radarr/${instance}/webhook` : "/api/integrations/radarr/webhook", headers: { "x-srtl-webhook-secret": secret }, payload });

    expect((await post(instanceId, webhookSecret)).statusCode).toBe(202);
    expect((await post(uhdId, uhdSecret)).statusCode).toBe(202);
    expect((await post(uhdId, webhookSecret)).statusCode).toBe(401);
    expect((await post("unknowninstance", webhookSecret)).statusCode).toBe(401);
    expect((await post("Not-An-Id", webhookSecret)).statusCode).toBe(401);
    // Only an instance migrated from the single-connection settings answers the original URL.
    expect((await post(null, webhookSecret)).statusCode).toBe(401);

    const download = { eventType: "Download", movie: { id: 1, title: "Alpha" } };
    expect((await post(instanceId, webhookSecret, download)).json()).toEqual({ accepted: true, duplicate: false });
    expect((await post(uhdId, uhdSecret, download)).json()).toEqual({ accepted: true, duplicate: false });
    expect((await post(uhdId, uhdSecret, download)).json()).toEqual({ accepted: true, duplicate: true });
    expect((await getRadarrState(app.database.db, instanceId)).events).toHaveLength(1);
    expect((await getRadarrState(app.database.db, uhdId)).events).toHaveLength(1);

    // Both Radarr instances share one host here, yet one exhausting its limit leaves the other untouched.
    let limited = 0;
    for (let index = 0; index < 120; index += 1) if ((await post(uhdId, uhdSecret)).statusCode === 429) limited += 1;
    expect(limited).toBeGreaterThan(0);
    expect((await post(instanceId, webhookSecret)).statusCode).toBe(202);
  });

  it("sends copy monitoring and media checks to the instance that owns the copied folder", async () => {
    const hd = await fakeRadarr([titleIn("/library", 1, "Alpha")], ["/library"]);
    const uhd = await fakeRadarr([{ ...titleIn("/library4k", 1, "Alpha"), runtime: 120, movieFile: { relativePath: "Alpha 4K.mkv", size: 5000 } }], ["/library4k"]);
    await saveRadarrSettings(app.database.db, instanceId, settingsFor(hd, [{ rootPath: "/library", section: "movies" }]));
    const uhdId = (await createRadarrInstance(app.database.db, "Radarr 4K")).settings.id;
    await saveRadarrSettings(app.database.db, uhdId, settingsFor(uhd, [{ rootPath: "/library4k", section: "movies4k" }], { monitorOnCopy: true }));
    expect((await getRadarrCopyDefaults(app.database.db)).sections.map((entry) => [entry.section, entry.instanceName, entry.monitorOnCopy])).toEqual([["movies", "Radarr", false], ["movies4k", "Radarr 4K", true]]);

    const itemName = "Alpha (2020)";
    await scannedLink("movies", itemName, "Alpha.mkv");
    await scannedLink("movies4k", itemName, "Alpha 4K.mkv");
    const worker = new JobWorker(app.database.db, { workerId: "radarr-instances-copy", logger: quiet });
    await app.jobs.startExternalTitleScan([{ section: "movies", itemName }, { section: "movies4k", itemName }]);
    await worker.runOnce();
    const links = await app.database.db.select().from(schema.mediaLinks);
    const uhdLink = links.find((link) => link.section === "movies4k")!;
    expect(await radarrMediaExpectation(app.database.db, uhdLink)).toEqual({ source: "Radarr 4K", sizeBytes: 5000, runtimeSeconds: 7200 });
    expect(uhd.requests).toBeGreaterThan(0);

    await app.database.db.update(schema.mediaLinks).set({ kind: "local" }).where(eq(schema.mediaLinks.id, uhdLink.id));
    const timestamp = new Date().toISOString();
    const [job] = await app.database.db.insert(schema.jobs).values({ type: "copy", status: "completed", createdAt: timestamp, finishedAt: timestamp, options: JSON.stringify({ direction: "to_local", radarrMonitoring: true }), progress: "{}" }).returning();
    await app.database.db.insert(schema.jobSelectionItems).values({ jobId: job!.id, mediaLinkId: uhdLink.id, selectionOrder: 0, section: "movies4k", itemName, relativePath: uhdLink.relativePath, linkPath: uhdLink.linkPath, createdAt: timestamp });
    await processRadarrWork(app.database.db);
    expect(uhd.edits.filter((edit) => "monitored" in edit)).toEqual([{ movieIds: [1], monitored: false }]);
    expect(hd.edits.filter((edit) => "monitored" in edit)).toEqual([]);
    expect(hd.movies[0]?.monitored).toBe(true);
    expect((await getRadarrState(app.database.db, uhdId)).monitorUpdates).toMatchObject([{ movieId: 1, monitored: false, copyJobId: job!.id, error: null }]);
    expect((await getRadarrState(app.database.db, instanceId)).monitorUpdates).toEqual([]);
    expect((await app.jobs.listEvents(job!.id)).map((event) => event.message)).toContain("Unmonitored in Radarr 4K: Alpha (2020)");

    // An instance added later does not act on copies that finished before it existed.
    await removeRadarrInstance(app.database.db, uhdId);
    const replacementId = (await createRadarrInstance(app.database.db, "Radarr 4K")).settings.id;
    await saveRadarrSettings(app.database.db, replacementId, settingsFor(uhd, [{ rootPath: "/library4k", section: "movies4k" }]));
    uhd.movies[0]!.monitored = true;
    await processRadarrWork(app.database.db);
    expect(uhd.edits.filter((edit) => "monitored" in edit)).toHaveLength(1);
    expect((await getRadarrState(app.database.db, replacementId)).monitorUpdates).toEqual([]);
  });

  it("queues each copied title for the instance that owns its folder as soon as it is copied", async () => {
    const hd = await fakeRadarr([titleIn("/library", 1, "Alpha"), titleIn("/library", 2, "Bravo")], ["/library"]);
    const uhd = await fakeRadarr([titleIn("/library4k", 1, "Alpha")], ["/library4k"]);
    await saveRadarrSettings(app.database.db, instanceId, settingsFor(hd, [{ rootPath: "/library", section: "movies" }]));
    const uhdId = (await createRadarrInstance(app.database.db, "Radarr 4K")).settings.id;
    await saveRadarrSettings(app.database.db, uhdId, settingsFor(uhd, [{ rootPath: "/library4k", section: "movies4k" }]));
    await setSetting(app.database.db, "advancedSettings", { copy: { profile: "fast" } });
    await scannedLink("movies", "Alpha (2020)", "Alpha.mkv");
    await scannedLink("movies", "Bravo (2020)", "Bravo.mkv");
    await scannedLink("movies4k", "Alpha (2020)", "Alpha 4K.mkv");
    // Placeholder bytes stand in for media here, so the content preflight is left out of this copy runner.
    const copyRunner = { copyFile: defaultCopyRunner.copyFile, runCmp: defaultCopyRunner.runCmp, runFfmpeg: defaultCopyRunner.runFfmpeg };
    const worker = new JobWorker(app.database.db, { workerId: "radarr-instances-per-title", copyRunner, logger: quiet, copiedTitles: (copy, titles) => queueCopiedTitleMonitorUpdates(app.database.db, copy, titles) });
    await app.jobs.startExternalTitleScan([{ section: "movies", itemName: "Alpha (2020)" }, { section: "movies", itemName: "Bravo (2020)" }, { section: "movies4k", itemName: "Alpha (2020)" }]);
    await worker.runOnce();
    for (const itemName of ["Alpha (2020)", "Bravo (2020)"]) await setStoragePolicyTitle(app.database.db, itemName, "location_1");
    // The 1080p Alpha stays remote; only 1080p Bravo and 4K Alpha are copied. Both instances call their movie id 1.
    const links = (await app.database.db.select().from(schema.mediaLinks)).filter((link) => link.section === "movies4k" || link.itemName === "Bravo (2020)");
    const jobId = await app.jobs.startCopy({ direction: "to_local", linkIds: links.map((link) => link.id), radarrMonitoring: true });
    await worker.runOnce();
    expect((await app.jobs.getJob(jobId))?.status).toBe("completed");
    const queued = await app.database.db.select().from(schema.radarrMonitorUpdates);
    expect(queued.map((update) => [update.instanceId, update.movieId, update.monitored]).sort()).toEqual([[instanceId, 2, false], [uhdId, 1, false]].sort());
    await processRadarrWork(app.database.db);
    expect(hd.edits.filter((edit) => "monitored" in edit)).toEqual([{ movieIds: [2], monitored: false }]);
    expect(uhd.edits.filter((edit) => "monitored" in edit)).toEqual([{ movieIds: [1], monitored: false }]);
    expect(hd.movies.map((item) => item.monitored)).toEqual([true, false]);
    expect(await app.database.db.select().from(schema.radarrMonitorUpdates)).toHaveLength(2);
    const messages = (await app.jobs.listEvents(jobId)).map((event) => event.message);
    expect(messages).toEqual(expect.arrayContaining(["Unmonitored in Radarr: Bravo (2020)", "Unmonitored in Radarr 4K: Alpha (2020)"]));
  });

  it("keeps working when another instance is offline or slow, with separate error state", async () => {
    const hd = await fakeRadarr([titleIn("/library", 1, "Alpha")], ["/library"]);
    const uhd = await fakeRadarr([titleIn("/library4k", 1, "Alpha")], ["/library4k"]);
    await saveRadarrSettings(app.database.db, instanceId, settingsFor(hd, [{ rootPath: "/library", section: "movies" }]));
    const uhdId = (await createRadarrInstance(app.database.db, "Radarr 4K")).settings.id;
    await saveRadarrSettings(app.database.db, uhdId, settingsFor(uhd, [{ rootPath: "/library4k", section: "movies4k" }]));

    hd.offline = true;
    await setStoragePolicyTitle(app.database.db, "Alpha (2020)", "location_1");
    await processRadarrWork(app.database.db);
    expect(uhd.movies[0]?.tags).toEqual([1]);
    expect((await getRadarrState(app.database.db, uhdId)).movies[0]).toMatchObject({ status: "synced" });
    expect((await getRadarrState(app.database.db, instanceId)).movies[0]).toMatchObject({ status: "error", message: "Radarr returned HTTP 503." });
    await refreshRadarr(app.database.db, instanceId);
    const overview = await getRadarrOverview(app.database.db);
    expect(overview.instances.map((summary) => [summary.settings.name, summary.settings.lastError, summary.errors])).toEqual([["Radarr", "Radarr returned HTTP 503.", 1], ["Radarr 4K", null, 0]]);

    // A slow instance does not hold back the next one: the 4K pass finishes while the first is still waiting.
    hd.offline = false;
    hd.delayMs = 1500;
    await app.database.db.update(schema.radarrMovies).set({ nextAttemptAt: null });
    await setStoragePolicyTitle(app.database.db, "Alpha (2020)", "location_2");
    const running = new Map<string, Promise<void>>();
    const failures: string[] = [];
    await startRadarrWork(app.database.db, running, (name) => failures.push(name));
    expect([...running.keys()].sort()).toEqual([instanceId, uhdId].sort());
    await running.get(uhdId);
    expect(uhd.movies[0]?.tags).toEqual([2]);
    expect(running.has(instanceId)).toBe(true);
    // An instance already in flight is not started twice.
    const before = running.get(instanceId);
    await startRadarrWork(app.database.db, running, (name) => failures.push(name));
    expect(running.get(instanceId)).toBe(before);
    await Promise.all([...running.values()]);
    expect(failures).toEqual([]);
    await app.database.db.update(schema.radarrMovies).set({ nextAttemptAt: null });
    hd.delayMs = 0;
    await processRadarrWork(app.database.db);
    expect(hd.movies[0]?.tags).toEqual([2]);
  });

  it("adds, renames, and removes instances without touching Radarr", async () => {
    const hd = await fakeRadarr([titleIn("/library", 1, "Alpha", [1])], ["/library"]);
    await saveRadarrSettings(app.database.db, instanceId, settingsFor(hd, [{ rootPath: "/library", section: "movies" }], { webhookSecret }));
    await reconcileRadarrMovies(app.database.db, instanceId, [1], "use_srtl");
    const setup = await app.app.inject({ method: "POST", url: "/api/auth/setup", payload: { username: "fixture", password: "fixture-password-123", confirmPassword: "fixture-password-123" } });
    const cookie = String(setup.headers["set-cookie"]);

    const created = await app.app.inject({ method: "POST", url: "/api/settings/radarr/instances", headers: { cookie }, payload: { name: "  Anime  " } });
    expect(created.statusCode).toBe(200);
    const animeId: string = created.json().settings.id;
    expect(created.json().settings).toMatchObject({ name: "Anime", enabled: false, hasApiKey: false, mappings: [], legacyWebhook: false });
    expect((await app.app.inject({ method: "POST", url: "/api/settings/radarr/instances", headers: { cookie }, payload: { name: "anime" } })).json().error).toContain("already named");
    expect((await app.app.inject({ method: "POST", url: "/api/settings/radarr/instances", headers: { cookie }, payload: { name: " " } })).statusCode).toBe(400);
    expect((await app.app.inject({ method: "POST", url: `/api/settings/radarr/instances/${animeId}/rename`, headers: { cookie }, payload: { name: "radarr" } })).statusCode).toBe(400);
    const renamed = await app.app.inject({ method: "POST", url: `/api/settings/radarr/instances/${animeId}/rename`, headers: { cookie }, payload: { name: "Radarr Anime" } });
    expect((renamed.json() as RadarrOverview).instances.map((summary) => summary.settings.name)).toEqual(["Radarr", "Radarr Anime"]);
    expect((await app.app.inject({ method: "GET", url: "/api/settings/radarr", headers: { cookie } })).json().limit).toBe(25);
    expect((await app.app.inject({ method: "GET", url: "/api/settings/radarr/instances/missing", headers: { cookie } })).statusCode).toBe(404);

    // The cap is a sanity limit, well above any real setup.
    for (let index = 3; index <= 25; index += 1) await createRadarrInstance(app.database.db, `Radarr ${index}`);
    await expect(createRadarrInstance(app.database.db, "One too many")).rejects.toThrow("up to 25");

    const requestsBefore = hd.requests;
    const removed = await app.app.inject({ method: "DELETE", url: `/api/settings/radarr/instances/${instanceId}`, headers: { cookie } });
    expect(removed.statusCode).toBe(200);
    expect((removed.json() as RadarrOverview).instances.map((summary) => summary.settings.id)).not.toContain(instanceId);
    expect(hd.requests).toBe(requestsBefore);
    expect(hd.edits).toEqual([]);
    expect(hd.movies[0]?.tags).toEqual([1]);
    expect(await app.database.db.select().from(schema.radarrMovies)).toEqual([]);
    expect((await app.app.inject({ method: "POST", url: `/api/integrations/radarr/${instanceId}/webhook`, headers: { "x-srtl-webhook-secret": webhookSecret }, payload: { eventType: "Test" } })).statusCode).toBe(401);
    expect((await app.app.inject({ method: "DELETE", url: `/api/settings/radarr/instances/${instanceId}`, headers: { cookie } })).statusCode).toBe(404);
    expect((await getRadarrState(app.database.db, animeId)).settings.name).toBe("Radarr Anime");
  });

  it("migrates the single Radarr connection into the first instance without losing its state", async () => {
    await connected();
    await reconcileRadarrMovies(app.database.db, instanceId, [1], "use_srtl");
    await setStoragePolicyTitle(app.database.db, "My First Wedding (2020)", "location_1");
    await processRadarrWork(app.database.db);
    expect(movies[0]!.tags).toEqual([1]);
    await receiveRadarrWebhook(app.database.db, instanceId, { eventType: "MovieAdded", movie: { id: 1, title: "My First Wedding" } });
    const before = await getRadarrState(app.database.db, instanceId);
    const editCount = edits.length;

    // Rebuild the version-18 layout: one settings object and tables keyed by Radarr movie id alone.
    const stored = await getJsonSetting<{ instances: Array<Record<string, unknown>> }>(app.database.db, "radarrInstances", { instances: [] });
    const { id: _id, name: _name, copyJobFloor: _floor, ...legacy } = stored.instances[0]!;
    const config = app.config;
    await app.app.close();
    const pool = new Pool({ connectionString: database.databaseUrl });
    try {
      await pool.query(`DELETE FROM app_settings WHERE key = 'radarrInstances'`);
      await pool.query(`INSERT INTO app_settings (key, value, updated_at) VALUES ('radarr', $1, now()::text)`, [JSON.stringify(legacy)]);
      for (const table of ["radarr_movies", "radarr_events", "radarr_monitor_updates", "radarr_copy_jobs"]) await pool.query(`ALTER TABLE ${table} DROP COLUMN instance_id`);
      await pool.query(`ALTER TABLE radarr_movies ADD PRIMARY KEY (movie_id)`);
      await pool.query(`ALTER TABLE radarr_events ADD CONSTRAINT radarr_events_fingerprint_key UNIQUE (fingerprint)`);
      await pool.query(`ALTER TABLE radarr_copy_jobs ADD PRIMARY KEY (job_id)`);
      await pool.query(`ALTER TABLE radarr_monitor_updates DROP COLUMN previous_monitored`);
      await pool.query(`DELETE FROM schema_migrations WHERE version IN (19, 20)`);
    } finally {
      await pool.end();
    }
    app = await createApp(config);
    app.app.log.level = "silent";

    const overview = await getRadarrOverview(app.database.db);
    expect(overview.instances).toHaveLength(1);
    const migrated = overview.instances[0]!.settings;
    expect(migrated).toMatchObject({ name: "Radarr", legacyWebhook: true, hasApiKey: true, hasWebhookSecret: true, enabled: true, localTag: "local", remoteTag: "ignored", mappings: input.mappings, revision: before.settings.revision, lastRefreshAt: before.settings.lastRefreshAt });
    expect(migrated.id).toMatch(/^[a-f0-9]{12}$/);
    const after = await getRadarrState(app.database.db, migrated.id);
    expect(after.movies).toEqual(before.movies);
    expect(after.events.map((event) => event.eventType)).toEqual(["MovieAdded"]);
    expect(await getJsonSetting(app.database.db, "radarr", null)).toBeNull();

    // The saved API key still works, nothing in Radarr changes, and both webhook URLs reach the instance.
    await processRadarrWork(app.database.db);
    expect(edits).toHaveLength(editCount);
    expect(movies[0]!.tags).toEqual([1]);
    for (const url of ["/api/integrations/radarr/webhook", `/api/integrations/radarr/${migrated.id}/webhook`]) {
      expect((await app.app.inject({ method: "POST", url, headers: { "x-srtl-webhook-secret": webhookSecret }, payload: { eventType: "Test" } })).statusCode).toBe(202);
    }
    expect((await app.app.inject({ method: "POST", url: "/api/integrations/radarr/webhook", headers: { "x-srtl-webhook-secret": "wrong-secret-with-enough-characters" }, payload: { eventType: "Test" } })).statusCode).toBe(401);
    const migratedSecond = await createRadarrInstance(app.database.db, "Radarr 4K");
    expect(migratedSecond.settings.legacyWebhook).toBe(false);
  });

  it("keeps one copy monitoring update per job, instance, movie, and direction after upgrading", async () => {
    const timestamp = new Date().toISOString();
    const [job] = await app.database.db.insert(schema.jobs).values({ type: "copy", status: "completed", createdAt: timestamp, finishedAt: timestamp, options: JSON.stringify({ direction: "to_local", radarrMonitoring: true }), progress: "{}" }).returning();
    const config = app.config;
    await app.app.close();
    const pool = new Pool({ connectionString: database.databaseUrl });
    try {
      // Before version 20 nothing stopped the same update from being queued twice.
      await pool.query(`DROP INDEX radarr_monitor_updates_copy_movie_idx`);
      await pool.query(`ALTER TABLE radarr_monitor_updates DROP COLUMN previous_monitored`);
      await pool.query(`DELETE FROM schema_migrations WHERE version = 20`);
      for (const [movieId, monitored] of [[1, false], [1, false], [1, true], [2, false]] as const) {
        await pool.query(`INSERT INTO radarr_monitor_updates (instance_id, copy_job_id, movie_id, title, monitored, created_at, next_attempt_at) VALUES ($1, $2, $3, 'Movie', $4, $5, $5)`, [instanceId, job!.id, movieId, monitored, timestamp]);
      }
      await pool.query(`INSERT INTO radarr_monitor_updates (instance_id, copy_job_id, movie_id, title, monitored, created_at, next_attempt_at) VALUES ($1, NULL, 1, 'Movie', false, $2, $2), ($1, NULL, 1, 'Movie', false, $2, $2)`, [instanceId, timestamp]);
    } finally {
      await pool.end();
    }
    app = await createApp(config);
    app.app.log.level = "silent";
    const rows = await app.database.db.select().from(schema.radarrMonitorUpdates).orderBy(schema.radarrMonitorUpdates.id);
    expect(rows.map((row) => [row.copyJobId, row.movieId, row.monitored, row.previousMonitored])).toEqual([[job!.id, 1, false, null], [job!.id, 1, true, null], [job!.id, 2, false, null], [null, 1, false, null], [null, 1, false, null]]);
    await expect(app.database.db.insert(schema.radarrMonitorUpdates).values({ instanceId, copyJobId: job!.id, movieId: 2, title: "Movie", monitored: false, createdAt: timestamp, nextAttemptAt: timestamp })).rejects.toThrow();
  });
});

describe("generated webhook secrets", () => {
  it("are URL-safe, accepted by the secret rules, and differ each time", () => {
    const first = generateRadarrWebhookSecret();
    const second = generateRadarrWebhookSecret();
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(radarrWebhookSecretSchema.safeParse(first).success).toBe(true);
    expect(radarrSettingsSchema.safeParse({ ...input, webhookSecret: first }).success).toBe(true);
    expect(second).not.toBe(first);
  });
});
