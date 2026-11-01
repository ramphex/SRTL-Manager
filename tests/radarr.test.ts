import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import fastify, { type FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp, type AppContext } from "../src/server/app";
import { getJsonSetting, setSetting } from "../src/server/db/database";
import * as schema from "../src/server/db/schema";
import { JobWorker } from "../src/server/jobs/jobRunner";
import { markOnboardingCompleteForExistingInstall, onboardingSettingKey } from "../src/server/lib/onboarding";
import { reconcileEnvironmentPaths } from "../src/server/lib/pathConfiguration";
import { authenticateRadarrWebhook, getRadarrCopyDefaults, getRadarrState, mapRadarrMovie, processRadarrWork, radarrTagPolicy, receiveRadarrWebhook, reconcileRadarrMovies, refreshRadarr, saveRadarrSettings, testRadarrConnection } from "../src/server/lib/radarr";
import { RadarrClient, normalizeRadarrUrl, radarrAddressAllowed, type RadarrMovie } from "../src/server/lib/radarrClient";
import { defaultCopyRunner } from "../src/server/lib/copier";
import { persistSectionSettings } from "../src/server/lib/sectionSettings";
import { setStoragePolicyTitle } from "../src/server/lib/storagePolicies";
import type { RadarrSettingsInput } from "../src/shared/radarr";
import { createTestDatabase, type TestDatabaseHandle } from "./testDb";

let app: AppContext;
let database: TestDatabaseHandle;
let root: string;
let remote: FastifyInstance;
let input: RadarrSettingsInput;
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

async function connected() { await saveRadarrSettings(app.database.db, input); }
async function dueEvents() { await app.database.db.update(schema.radarrEvents).set({ nextAttemptAt: "2000-01-01T00:00:00.000Z" }); }
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
    expect((await getRadarrState(app.database.db)).settings).toMatchObject({ mappingMode: "auto", mappings: [] });
    await connected();
    const saved = await getJsonSetting<Record<string, unknown>>(app.database.db, "radarr", {});
    delete saved.mappingMode;
    await setSetting(app.database.db, "radarr", saved);
    expect((await getRadarrState(app.database.db)).settings).toMatchObject({ mappingMode: "manual", mappings: input.mappings });
  });

  it("detects only exact full paths to movie sections without guessing from names or prefixes", async () => {
    await persistSectionSettings(app.database.db, { sections: ["movies4k", "shows", "movies"], sectionTypes: { movies: "movies", movies4k: "movies", shows: "shows" }, sectionTitles: { movies: "Family Films", movies4k: "Family Films 4K" } });
    rootFolders = [path.join(root, "links", "movies"), path.join(root, "links", "movies4k"), "/elsewhere/movies", path.join(root, "links", "shows"), path.join(root, "links", "movies-extra"), path.join(root, "links", "movies", "nested"), `${root}/links/../links/movies`];
    const expected = [{ rootPath: rootFolders[1], section: "movies4k" }, { rootPath: rootFolders[0], section: "movies" }];
    const detected = await testRadarrConnection(app.database.db, { ...input, mappingMode: "auto" });
    expect(detected.automaticMappings).toEqual(expected);
    expect(detected.unmatchedRootFolders).toEqual(rootFolders.slice(2));
    expect((await getRadarrState(app.database.db)).settings.mappings).toEqual([]);
    expect(edits).toEqual([]);
    const saved = await saveRadarrSettings(app.database.db, { ...input, mappingMode: "auto" });
    expect(saved.settings.mappings).toEqual(expected);
    expect(saved.movies[0]?.status).toBe("unmapped");
  });

  it("recomputes automatic mappings on save and rejects enabling without a match", async () => {
    const automatic: RadarrSettingsInput = { ...input, mappingMode: "auto" };
    await expect(saveRadarrSettings(app.database.db, automatic)).rejects.toThrow("No exact folder matches");
    const paused = await saveRadarrSettings(app.database.db, { ...automatic, enabled: false });
    expect(paused.settings.mappings).toEqual([]);
    rootFolders = [path.join(root, "links", "movies")];
    const detected = await testRadarrConnection(app.database.db, { ...paused.settings });
    expect(detected.automaticMappings).toHaveLength(1);
    rootFolders = ["/different/movies"];
    const resaved = await saveRadarrSettings(app.database.db, { ...paused.settings, mappings: detected.automaticMappings });
    expect(resaved.settings.mappings).toEqual([]);
    const manual = await saveRadarrSettings(app.database.db, { ...input, revision: resaved.settings.revision, mappings: [{ rootPath: "/different/movies", section: "movies" }] });
    expect(manual.settings).toMatchObject({ mappingMode: "manual", enabled: true, mappings: [{ rootPath: "/different/movies", section: "movies" }] });
  });

  it("uses automatic mappings for policy sync and webhook scans, and can pause offline", async () => {
    rootFolders = [path.join(root, "links", "movies")];
    movies[0]!.path = path.join(rootFolders[0]!, "My First Wedding (2020)");
    const saved = await saveRadarrSettings(app.database.db, { ...input, mappingMode: "auto", mappings: [] });
    await symlinkFor(movies[0]!);
    await reconcileRadarrMovies(app.database.db, [1], "use_srtl");
    await setStoragePolicyTitle(app.database.db, "My First Wedding (2020)", "location_1");
    await receiveRadarrWebhook(app.database.db, { eventType: "Download", movie: { id: 1, title: "My First Wedding" } });
    await dueEvents();
    await processRadarrWork(app.database.db);
    expect((await app.jobs.listJobs())[0]?.progress).toMatchObject({ options: { titleScopes: [{ section: "movies", itemName: "My First Wedding (2020)" }] } });
    expect(movies[0]!.tags).toContain(1);
    offline = true;
    expect((await saveRadarrSettings(app.database.db, { ...saved.settings, enabled: false })).settings).toMatchObject({ enabled: false, mappingMode: "auto", mappings: saved.settings.mappings });
  });

  it("stops automatic synchronization when the configured symlink root changes", async () => {
    rootFolders = [path.join(root, "links", "movies")];
    movies[0]!.path = path.join(rootFolders[0]!, "My First Wedding (2020)");
    await saveRadarrSettings(app.database.db, { ...input, mappingMode: "auto" });
    await reconcileRadarrMovies(app.database.db, [1], "use_srtl");
    await setStoragePolicyTitle(app.database.db, "My First Wedding (2020)", "location_1");
    await setSetting(app.database.db, "paths", { ...app.config.paths, symlinkDir: path.join(root, "changed-links") });
    await processRadarrWork(app.database.db);
    expect(edits).toHaveLength(0);
    expect((await getRadarrState(app.database.db)).settings.lastError).toContain("Automatic folder matches changed");
  });

  it("keeps reviewed titles managed when automatic matches only change display order", async () => {
    const sections = { sections: ["movies", "movies4k"], sectionTypes: { movies: "movies" as const, movies4k: "movies" as const } };
    await persistSectionSettings(app.database.db, sections);
    rootFolders = [path.join(root, "links", "movies"), path.join(root, "links", "movies4k")];
    movies[0]!.path = path.join(rootFolders[0]!, "My First Wedding (2020)");
    const saved = await saveRadarrSettings(app.database.db, { ...input, mappingMode: "auto" });
    expect(saved.settings.mappings.map((mapping) => mapping.section)).toEqual(["movies", "movies4k"]);
    await reconcileRadarrMovies(app.database.db, [1], "use_srtl");
    await persistSectionSettings(app.database.db, { ...sections, sections: ["movies4k", "movies"] });
    const reordered = await saveRadarrSettings(app.database.db, saved.settings);
    expect(reordered.settings.mappings.map((mapping) => mapping.section)).toEqual(["movies4k", "movies"]);
    expect(reordered.movies[0]?.managed).toBe(true);
    await setStoragePolicyTitle(app.database.db, "My First Wedding (2020)", "location_1");
    await processRadarrWork(app.database.db);
    expect(movies[0]!.tags).toContain(1);
  });

  it("starts without policy tags and allows a read-only connection before choosing them", async () => {
    const initial = await getRadarrState(app.database.db);
    expect(initial.settings).toMatchObject({ enabled: false, localTag: "", remoteTag: "" });
    const draft = { ...input, enabled: false, localTag: "", remoteTag: "", mappings: [], webhookSecret: "" };
    expect(await testRadarrConnection(app.database.db, draft)).toMatchObject({ version: "6.0.0" });
    const saved = await saveRadarrSettings(app.database.db, draft);
    expect(saved.settings).toMatchObject({ enabled: false, localTag: "", remoteTag: "", hasApiKey: true, hasWebhookSecret: false });
    expect(radarrTagPolicy(["local", "remote", "ignored", ""], saved.settings)).toBe("unassigned");
    await processRadarrWork(app.database.db);
    expect(tags).toHaveLength(3);
    expect(edits).toHaveLength(0);
    expect(await app.jobs.listJobs()).toHaveLength(0);
  });

  it("requires explicit distinct tags before enabling or reconciling and preserves saved choices", async () => {
    for (const localTag of ["", "local"]) {
      await expect(saveRadarrSettings(app.database.db, { ...input, localTag, remoteTag: "" })).rejects.toThrow("Choose both policy tags");
    }
    await expect(saveRadarrSettings(app.database.db, { ...input, localTag: "remote", remoteTag: "remote" })).rejects.toThrow("must be different");
    await expect(saveRadarrSettings(app.database.db, { ...input, enabled: false, localTag: "BAD TAG" })).rejects.toThrow("lowercase tag");
    const saved = await saveRadarrSettings(app.database.db, { ...input, enabled: false, localTag: "", remoteTag: "" });
    for (const action of ["use_srtl", "import_tags"] as const) {
      await expect(reconcileRadarrMovies(app.database.db, [1], action)).rejects.toThrow("Choose and save both policy tags");
    }
    const configured = await saveRadarrSettings(app.database.db, { ...input, revision: saved.settings.revision, localTag: "home", remoteTag: "archive" });
    const paused = await saveRadarrSettings(app.database.db, { ...configured.settings, enabled: false });
    expect(paused.settings).toMatchObject({ localTag: "home", remoteTag: "archive", enabled: false });
    expect(edits).toHaveLength(0);
  });

  it("saves a read-only preview, protects secrets, and leaves tags untouched until reconciliation", async () => {
    movies[0]!.tags = [1, 3];
    await connected();
    const state = await getRadarrState(app.database.db);
    expect(state.movies[0]).toMatchObject({ status: "review", policy: "unassigned", tagPolicy: "location_1", managed: false });
    expect(JSON.stringify(state)).not.toContain(apiKey);
    expect(JSON.stringify(state)).not.toContain(webhookSecret);
    expect(await authenticateRadarrWebhook(app.database.db, webhookSecret)).toBe(true);
    expect(await authenticateRadarrWebhook(app.database.db, "wrong-secret-with-enough-characters")).toBe(false);
    await processRadarrWork(app.database.db);
    expect(edits).toHaveLength(0);
  });

  it("mirrors all policy transitions without changing unrelated tags or moving files", async () => {
    movies[0]!.tags = [3];
    await connected();
    await reconcileRadarrMovies(app.database.db, [1], "use_srtl");
    for (const [policy, expectedTags] of [["location_1", [1, 3]], ["location_2", [2, 3]], ["unassigned", [3]]] as const) {
      await setStoragePolicyTitle(app.database.db, "My First Wedding (2020)", policy);
      await processRadarrWork(app.database.db);
      expect([...movies[0]!.tags].sort()).toEqual([...expectedTags]);
      expect((await getRadarrState(app.database.db)).movies[0]).toMatchObject({ policy, status: "synced" });
    }
    expect(edits.every((edit) => Object.keys(edit).sort().join() === "applyTags,movieIds,tags")).toBe(true);
    expect(await app.jobs.listJobs()).toHaveLength(0);
  });

  it("imports existing tags explicitly and refuses both-tag or contradictory policies", async () => {
    movies = [movie(1, "My First Wedding", [1]), movie(2, "My Second Wedding", [1, 2]), movie(3, "My Third Wedding", [2])];
    await connected();
    await reconcileRadarrMovies(app.database.db, [1], "import_tags");
    expect((await getRadarrState(app.database.db)).movies.find((item) => item.movieId === 1)?.policy).toBe("location_1");
    await expect(reconcileRadarrMovies(app.database.db, [2], "import_tags")).rejects.toThrow("one policy tag");
    await setStoragePolicyTitle(app.database.db, "My Third Wedding (2020)", "location_1");
    await expect(reconcileRadarrMovies(app.database.db, [3], "import_tags")).rejects.toThrow("conflicting assignments");
    expect(edits).toHaveLength(0);
  });

  it("retries tag failures independently and retains the requested policy", async () => {
    await connected();
    await reconcileRadarrMovies(app.database.db, [1], "use_srtl");
    await setStoragePolicyTitle(app.database.db, "My First Wedding (2020)", "location_1");
    offline = true;
    await processRadarrWork(app.database.db);
    expect((await getRadarrState(app.database.db)).movies[0]).toMatchObject({ status: "error", policy: "location_1", message: "Radarr returned HTTP 503." });
    offline = false;
    const config = app.config;
    await app.app.close();
    app = await createApp(config);
    app.app.log.level = "silent";
    await app.database.db.update(schema.radarrMovies).set({ nextAttemptAt: null });
    await processRadarrWork(app.database.db);
    expect((await getRadarrState(app.database.db)).movies[0]?.status).toBe("synced");
  });

  it("can pause while Radarr is offline without exposing or replacing credentials", async () => {
    await connected();
    offline = true;
    const current = (await getRadarrState(app.database.db)).settings;
    const result = await saveRadarrSettings(app.database.db, { ...current, enabled: false });
    expect(result.settings.enabled).toBe(false);
    expect(result.settings.hasApiKey).toBe(true);
    await expect(saveRadarrSettings(app.database.db, { ...result.settings, baseUrl: "http://127.0.0.1:1" })).rejects.toThrow("Enter the API key");
  });

  it("rejects stale settings, invalid mappings, and changed movie identities", async () => {
    await connected();
    await expect(saveRadarrSettings(app.database.db, input)).rejects.toThrow("settings changed");
    await expect(saveRadarrSettings(app.database.db, { ...input, revision: 1, mappings: [{ rootPath: "/library", section: "missing" }] })).rejects.toThrow("Movies sections");
    movies[0]!.tmdbId = 999;
    await expect(reconcileRadarrMovies(app.database.db, [1], "use_srtl")).rejects.toThrow("mapping changed");
  });

  it("handles duplicate notifications once and discovers a new title with a normal scan job", async () => {
    await connected();
    movies.push(movie(2, "My Second Wedding"));
    const item = movies[1]!;
    await symlinkFor(item);
    const body = { eventType: "Download", movie: { id: 2, title: item.title }, movieFile: { id: 2 }, isUpgrade: false };
    expect(await receiveRadarrWebhook(app.database.db, body)).toMatchObject({ duplicate: false });
    expect(await receiveRadarrWebhook(app.database.db, body)).toMatchObject({ duplicate: true });
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
    expect((await getRadarrState(app.database.db)).events[0]?.jobStatus).toBe("completed");
  });

  it("queues refresh after an active job without letting scans overlap", async () => {
    await connected();
    await symlinkFor(movies[0]!);
    const activeId = await app.jobs.createJob("copy");
    await app.database.db.update(schema.jobs).set({ status: "running", lockedBy: "other-worker", heartbeatAt: new Date().toISOString() }).where(eq(schema.jobs.id, activeId));
    await receiveRadarrWebhook(app.database.db, { eventType: "Download", movie: { id: 1, title: "My First Wedding" } });
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
    await receiveRadarrWebhook(app.database.db, { eventType: "Download", movie: { id: 1, title: "Wrong untrusted title" } });
    await dueEvents();
    await processRadarrWork(app.database.db);
    expect(await app.jobs.listJobs()).toHaveLength(0);
    expect((await getRadarrState(app.database.db)).events[0]?.error).toContain("not available");
    await symlinkFor(movies[0]!);
    await dueEvents();
    await processRadarrWork(app.database.db);
    expect(await app.jobs.listJobs()).toHaveLength(1);
  });

  it("uses stored identity for deletion and ignores untrusted paths in webhook bodies", async () => {
    await connected();
    await receiveRadarrWebhook(app.database.db, { eventType: "MovieDelete", movie: { id: 1, title: "../wrong", folderPath: "/etc" } });
    await dueEvents();
    await processRadarrWork(app.database.db);
    expect((await app.jobs.listJobs())[0]?.progress).toMatchObject({ options: { titleScopes: [{ section: "movies", itemName: "My First Wedding (2020)" }] } });
  });

  it("requires a webhook secret even with an admin cookie and protects settings with session authentication", async () => {
    await connected();
    const setup = await app.app.inject({ method: "POST", url: "/api/auth/setup", payload: { username: "fixture", password: "fixture-password-123", confirmPassword: "fixture-password-123" } });
    const cookie = String(setup.headers["set-cookie"]);
    expect((await app.app.inject({ method: "GET", url: "/api/settings/radarr" })).statusCode).toBe(401);
    expect((await app.app.inject({ method: "POST", url: "/api/integrations/radarr/webhook", headers: { cookie }, payload: { eventType: "Test" } })).statusCode).toBe(401);
    expect((await app.app.inject({ method: "POST", url: "/api/integrations/radarr/webhook", headers: { "x-srtl-webhook-secret": webhookSecret }, payload: { eventType: "Test" } })).statusCode).toBe(202);
    expect((await app.app.inject({ method: "PUT", url: "/api/settings/radarr", headers: { "x-srtl-webhook-secret": webhookSecret }, payload: input })).statusCode).toBe(401);
    expect((await app.app.inject({ method: "POST", url: "/api/settings/radarr/test", headers: { cookie, origin: "https://untrusted.invalid" }, payload: input })).statusCode).toBe(403);
  });

  it("supports the authenticated configuration and policy workflow through the HTTP API", async () => {
    const setup = await app.app.inject({ method: "POST", url: "/api/auth/setup", payload: { username: "fixture", password: "fixture-password-123", confirmPassword: "fixture-password-123" } });
    expect(setup.statusCode).toBe(200);
    const cookie = String(setup.headers["set-cookie"]);
    expect((await app.app.inject({ method: "POST", url: "/api/settings/radarr/test", headers: { cookie }, payload: input })).json()).toEqual({ version: "6.0.0", rootFolders: ["/library"], automaticMappings: [], unmatchedRootFolders: ["/library"] });
    const saved = await app.app.inject({ method: "PUT", url: "/api/settings/radarr", headers: { cookie }, payload: input });
    expect(saved.statusCode).toBe(200);
    expect(saved.body).not.toContain(apiKey);
    expect(saved.body).not.toContain(webhookSecret);
    const reviewed = await app.app.inject({ method: "POST", url: "/api/settings/radarr/reconcile", headers: { cookie }, payload: { movieIds: [1], action: "use_srtl" } });
    expect(reviewed.statusCode).toBe(200);
    await symlinkFor(movies[0]!);
    expect((await app.app.inject({ method: "POST", url: "/api/integrations/radarr/webhook", headers: { "x-srtl-webhook-secret": webhookSecret }, payload: { eventType: "Download", movie: { id: 1, title: "My First Wedding" } } })).statusCode).toBe(202);
    await dueEvents();
    await processRadarrWork(app.database.db);
    await new JobWorker(app.database.db, { workerId: "radarr-http-test" }).runOnce();
    expect((await app.app.inject({ method: "POST", url: "/api/storage-policies", headers: { cookie }, payload: { title: "My First Wedding (2020)", policy: "location_1" } })).statusCode).toBe(200);
    await processRadarrWork(app.database.db);
    const status = await app.app.inject({ method: "GET", url: "/api/settings/radarr", headers: { cookie } });
    expect(status.json().movies[0]).toMatchObject({ policy: "location_1", status: "synced" });
    expect((await app.app.inject({ method: "GET", url: "/api/settings/radarr/copy-defaults" })).statusCode).toBe(401);
    expect((await app.app.inject({ method: "GET", url: "/api/settings/radarr/copy-defaults", headers: { cookie } })).json()).toEqual({ available: true, monitorOnCopy: false, sections: ["movies"] });
    const copy = await app.app.inject({ method: "POST", url: "/api/copies", headers: { cookie }, payload: { direction: "to_local", section: "movies", radarrMonitoring: true } });
    expect(copy.statusCode).toBe(200);
    expect((await app.jobs.getJob(copy.json().jobId))?.progress).toMatchObject({ options: { direction: "to_local", radarrMonitoring: true } });
  });

  it("does not process work during onboarding", async () => {
    await connected();
    await reconcileRadarrMovies(app.database.db, [1], "use_srtl");
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
    for (const address of ["127.0.0.1", "10.0.0.107", "192.168.1.2", "::1", "fd00::1"]) expect(radarrAddressAllowed(address)).toBe(true);
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
    await receiveRadarrWebhook(app.database.db, { eventType: "Download", movie: { id: 2, title: "Unmapped" } });
    await dueEvents();
    await processRadarrWork(app.database.db);
    expect((await getRadarrState(app.database.db)).events[0]).toMatchObject({ processedAt: expect.any(String), error: "Ignored: movie is outside the configured folder mappings.", jobId: null });
    expect(await app.jobs.listJobs()).toHaveLength(0);
  });

  it("refuses a title folder redirected outside the configured symlink root", async () => {
    await connected();
    const outside = path.join(root, "outside");
    await fs.mkdir(outside);
    await fs.symlink(outside, path.join(root, "links", "movies", "My First Wedding (2020)"));
    await fs.symlink(path.join(root, "remote", "missing.mkv"), path.join(outside, "My First Wedding.mkv"));
    await receiveRadarrWebhook(app.database.db, { eventType: "Download", movie: { id: 1, title: "My First Wedding" } });
    await dueEvents();
    await processRadarrWork(app.database.db);
    expect((await getRadarrState(app.database.db)).events[0]?.error).toContain("outside the symlink root");
    expect(await app.jobs.listJobs()).toHaveLength(0);
  });

  it("pauses tag synchronization and authenticated webhooks during path maintenance", async () => {
    await connected();
    await reconcileRadarrMovies(app.database.db, [1], "use_srtl");
    await setStoragePolicyTitle(app.database.db, "My First Wedding (2020)", "location_1");
    const replacement = path.join(root, "new-links");
    await fs.mkdir(replacement);
    await reconcileEnvironmentPaths(app.database.db, { ...app.config.paths, symlinkDir: replacement });
    await processRadarrWork(app.database.db);
    expect(edits).toHaveLength(0);
    expect((await app.app.inject({ method: "POST", url: "/api/integrations/radarr/webhook", headers: { "x-srtl-webhook-secret": webhookSecret }, payload: { eventType: "Test" } })).statusCode).toBe(423);
  });

  it("refuses importing policies over a queued title scan, including titles absent from inventory", async () => {
    movies[0]!.tags = [1];
    await connected();
    await app.jobs.startExternalTitleScan([{ section: "movies", itemName: "My First Wedding (2020)" }]);
    await expect(reconcileRadarrMovies(app.database.db, [1], "import_tags")).rejects.toThrow("Storage policy cannot be changed");
    expect((await getRadarrState(app.database.db)).movies[0]?.policy).toBe("unassigned");
  });

  it("retains review when path mappings change and refresh never writes remote tags", async () => {
    await connected();
    await reconcileRadarrMovies(app.database.db, [1], "use_srtl");
    await refreshRadarr(app.database.db);
    expect((await getRadarrState(app.database.db)).movies[0]?.managed).toBe(true);
    await saveRadarrSettings(app.database.db, { ...input, revision: 1, mappings: [] , enabled: false });
    expect((await getRadarrState(app.database.db)).movies[0]).toMatchObject({ managed: false, status: "unmapped" });
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
    const statuses = Object.fromEntries((await getRadarrState(app.database.db)).movies.map((item) => [item.movieId, item.status]));
    expect(statuses).toEqual({ 1: "synced", 2: "review", 3: "synced" });
    await setStoragePolicyTitle(app.database.db, "Bravo (2020)", "location_1");
    await processRadarrWork(app.database.db);
    expect([...movies[1]!.tags].sort()).toEqual([1, 3]);
    expect((await getRadarrState(app.database.db)).movies.find((item) => item.movieId === 2)).toMatchObject({ managed: true, status: "synced" });
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
    expect((await getRadarrState(app.database.db)).movies.every((item) => item.status === "synced")).toBe(true);
  });

  it("enables tag synchronization without a webhook secret while rejecting webhooks", async () => {
    const saved = await saveRadarrSettings(app.database.db, { ...input, webhookSecret: "" });
    expect(saved.settings).toMatchObject({ enabled: true, hasWebhookSecret: false });
    await setStoragePolicyTitle(app.database.db, "My First Wedding (2020)", "location_1");
    await processRadarrWork(app.database.db);
    expect(movies[0]!.tags).toEqual([1]);
    expect((await app.app.inject({ method: "POST", url: "/api/integrations/radarr/webhook", headers: { "x-srtl-webhook-secret": webhookSecret }, payload: { eventType: "Test" } })).statusCode).toBe(401);
  });

  it("updates Radarr monitoring only for requested copies whose files all reached the destination", async () => {
    await saveRadarrSettings(app.database.db, { ...input, monitorOnCopy: true });
    await setSetting(app.database.db, "advancedSettings", { copy: { profile: "fast" } });
    expect(await getRadarrCopyDefaults(app.database.db)).toEqual({ available: true, monitorOnCopy: true, sections: ["movies"] });
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
    expect((await getRadarrState(app.database.db)).monitorUpdates[0]).toMatchObject({ copyJobId: failed, monitored: false, error: expect.stringContaining("Skipped") });

    const requested = await app.jobs.startCopy({ direction: "to_local", linkIds: [link!.id], radarrMonitoring: true });
    await worker.runOnce();
    expect((await app.jobs.getJob(requested))?.status).toBe("completed");
    await processRadarrWork(app.database.db);
    expect(movies[0]!.monitored).toBe(false);
    expect(monitorEdits()).toEqual([{ movieIds: [1], monitored: false }]);
    expect((await getRadarrState(app.database.db)).movies[0]?.monitored).toBe(false);
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

  it("orders preview titles alphabetically regardless of Radarr response order", async () => {
    movies = [movie(3, "Zebra Crossing"), movie(1, "Anniversary"), movie(2, "My First Wedding")];
    await connected();
    expect((await getRadarrState(app.database.db)).movies.map((item) => item.movieId)).toEqual([1, 2, 3]);
  });
});
