import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getSectionSettings } from "../src/server/db/database";
import { createApp, type AppContext } from "../src/server/app";
import * as schema from "../src/server/db/schema";
import { JobWorker } from "../src/server/jobs/jobRunner";
import { applyDefaultPolicyToUnassigned, previewDefaultPolicyForUnassigned } from "../src/server/lib/defaultPolicy";
import { markOnboardingCompleteForExistingInstall } from "../src/server/lib/onboarding";
import { createRadarrInstance, getRadarrState, processRadarrWork, saveRadarrSettings } from "../src/server/lib/radarr";
import type { RadarrMovie } from "../src/server/lib/radarrClient";
import { persistSectionSettings } from "../src/server/lib/sectionSettings";
import { setStoragePolicyTitle } from "../src/server/lib/storagePolicies";
import type { RadarrSettingsInput } from "../src/shared/radarr";
import type { SectionSettings } from "../src/shared/types";
import { createTestDatabase, type TestDatabaseHandle } from "./testDb";

const silentLogger = { info: () => undefined, warn: () => undefined, error: () => undefined };
const apiKey = "testRadarrApiKeyOnly";
const baseSections: SectionSettings = { sections: ["movies", "shows"], sectionTypes: { movies: "movies", shows: "shows" }, sectionTitles: { movies: "Movies", shows: "Shows" } };

let app: AppContext;
let database: TestDatabaseHandle;
let root: string;
let remote: FastifyInstance;
let radarrAddress: string;
let movies: RadarrMovie[];
let tags: Array<{ id: number; label: string }>;
let fileCounter = 0;

function movie(id: number, title: string, assignedTags: number[] = []): RadarrMovie {
  return { id, tmdbId: id + 100, title, year: 2020, path: `/library/${title} (2020)`, tags: assignedTags, monitored: true, movieFile: { relativePath: `${title}.mkv` } };
}

async function addTitle(section: string, folder: string): Promise<void> {
  fileCounter += 1;
  const target = path.join(root, "remote", `${fileCounter}.mkv`);
  const directory = path.join(root, "links", section, folder);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(target, "test media bytes");
  await fs.symlink(target, path.join(directory, `${fileCounter}.mkv`));
}

async function scan(): Promise<void> {
  await app.jobs.startScan({ scanSymlinks: true, scanLocal: false, scanRemote: false });
  await new JobWorker(app.database.db, { workerId: "default-policy-worker", logger: silentLogger }).runOnce();
}

async function configure(defaults: SectionSettings["sectionDefaultPolicies"]): Promise<void> {
  await persistSectionSettings(app.database.db, { ...baseSections, sectionDefaultPolicies: defaults });
}

async function policies(): Promise<Record<string, { policy: string; source: string }>> {
  return Object.fromEntries((await app.database.db.select().from(schema.storagePolicies)).map((row) => [row.title, { policy: row.policy, source: row.source }]));
}

async function connectRadarr(): Promise<string> {
  const instanceId = (await createRadarrInstance(app.database.db, "Radarr")).settings.id;
  const input: RadarrSettingsInput = {
    revision: 0,
    baseUrl: `${radarrAddress}/radarr`,
    apiKey,
    webhookSecret: "test_webhook_secret_for_disposable_fixture",
    enabled: true,
    localTag: "local",
    remoteTag: "ignored",
    monitorOnCopy: false,
    mappingMode: "manual",
    mappings: [{ rootPath: "/library", section: "movies" }]
  };
  await saveRadarrSettings(app.database.db, instanceId, input);
  return instanceId;
}

beforeEach(async () => {
  fileCounter = 0;
  root = await fs.mkdtemp(path.join(os.tmpdir(), "srtl-default-policy-"));
  for (const folder of ["links/movies", "links/shows", "local", "remote"]) await fs.mkdir(path.join(root, folder), { recursive: true });
  database = await createTestDatabase();
  app = await createApp({ rootDir: root, databaseUrl: database.databaseUrl, autoMigrate: true, paths: { symlinkDir: path.join(root, "links"), localDir: path.join(root, "local"), remoteDir: path.join(root, "remote") } });
  app.app.log.level = "silent";
  await markOnboardingCompleteForExistingInstall(app.database.db);
  movies = [];
  tags = [{ id: 1, label: "local" }, { id: 2, label: "ignored" }];
  remote = fastify();
  remote.addHook("preHandler", async (request, reply) => {
    if (request.headers["x-api-key"] !== apiKey) return reply.code(401).send({ error: "bad key" });
  });
  remote.get("/radarr/api/v3/system/status", async () => ({ appName: "Radarr", version: "6.0.0" }));
  remote.get("/radarr/api/v3/rootfolder", async () => [{ path: "/library" }]);
  remote.get("/radarr/api/v3/movie", async () => movies);
  remote.get<{ Params: { id: string } }>("/radarr/api/v3/movie/:id", async (request, reply) => movies.find((item) => item.id === Number(request.params.id)) ?? reply.code(404).send({ error: "missing" }));
  remote.get("/radarr/api/v3/tag", async () => tags);
  remote.put<{ Body: { movieIds: number[]; tags?: number[]; applyTags?: string } }>("/radarr/api/v3/movie/editor", async (request) => {
    const { tags: editTags = [], applyTags } = request.body;
    for (const item of movies.filter((entry) => request.body.movieIds.includes(entry.id))) {
      if (applyTags) item.tags = applyTags === "add" ? [...new Set([...item.tags, ...editTags])] : item.tags.filter((id) => !editTags.includes(id));
    }
    return movies;
  });
  radarrAddress = await remote.listen({ host: "127.0.0.1", port: 0 });
});

afterEach(async () => {
  await remote?.close();
  await app?.app.close();
  await database?.cleanup();
  await fs.rm(root, { recursive: true, force: true });
});

describe("default storage policy for new titles", () => {
  it("stores folder defaults with the section settings and drops them with the folder", async () => {
    await configure({ movies: "location_2", shows: "location_1" });
    expect((await getSectionSettings(app.database.db)).sectionDefaultPolicies).toEqual({ movies: "location_2", shows: "location_1" });
    await persistSectionSettings(app.database.db, { sections: ["movies"], sectionTypes: { movies: "movies" }, sectionDefaultPolicies: { movies: "location_2", shows: "location_1" } });
    expect((await getSectionSettings(app.database.db)).sectionDefaultPolicies).toEqual({ movies: "location_2" });
  });

  it("assigns the folder default to a title first seen after it was set, and records the source", async () => {
    await configure({ movies: "location_1" });
    await addTitle("movies", "Alpha (2020)");
    await scan();

    expect(await policies()).toEqual({ "Alpha (2020)": { policy: "location_1", source: "default" } });
    const links = await app.database.db.select().from(schema.mediaLinks);
    expect(links.map((link) => link.storagePolicy)).toEqual(["location_1"]);
    const events = await app.database.db.select().from(schema.jobEvents);
    expect(events.some((event) => event.message.startsWith("Default storage policy assigned to 1 new title"))).toBe(true);
  });

  it("supports Location 2 and leaves folders without a default unassigned", async () => {
    await configure({ movies: "location_2" });
    await addTitle("movies", "Alpha (2020)");
    await addTitle("shows", "Show One (2019)");
    await scan();

    expect(await policies()).toEqual({ "Alpha (2020)": { policy: "location_2", source: "default" } });
  });

  it("behaves as before when no folder has a default", async () => {
    await configure({});
    await addTitle("movies", "Alpha (2020)");
    await scan();

    expect(await policies()).toEqual({});
    expect((await app.database.db.select().from(schema.jobEvents)).some((event) => event.message.includes("Default storage policy"))).toBe(false);
  });

  it("never applies retroactively to titles that existed before the default was set", async () => {
    await configure({});
    await addTitle("movies", "Old (2010)");
    await scan();
    await configure({ movies: "location_1" });
    await addTitle("movies", "New (2024)");
    await scan();

    expect(await policies()).toEqual({ "New (2024)": { policy: "location_1", source: "default" } });
  });

  it("never overrides an existing policy", async () => {
    await configure({ movies: "location_1" });
    await addTitle("movies", "Alpha (2020)");
    await setStoragePolicyTitle(app.database.db, "Alpha (2020)", "location_2");
    await scan();

    expect(await policies()).toEqual({ "Alpha (2020)": { policy: "location_2", source: "manual" } });
  });

  it("assigns a title once even when it is seen in several folders that agree, and skips folders that disagree", async () => {
    await persistSectionSettings(app.database.db, { sections: ["movies", "shows", "extra"], sectionTypes: { movies: "movies", shows: "movies", extra: "movies" }, sectionDefaultPolicies: { movies: "location_1", shows: "location_1" } });
    await fs.mkdir(path.join(root, "links", "extra"), { recursive: true });
    await addTitle("movies", "Both (2020)");
    await addTitle("shows", "Both (2020)");
    await addTitle("movies", "Mixed (2021)");
    await addTitle("extra", "Mixed (2021)");
    await scan();

    expect(await policies()).toEqual({ "Both (2020)": { policy: "location_1", source: "default" } });
  });

  it("applies to unassigned titles of one folder only when asked, leaving assigned titles and other folders alone", async () => {
    await configure({});
    await addTitle("movies", "Unassigned One (2020)");
    await addTitle("movies", "Unassigned Two (2021)");
    await addTitle("movies", "Assigned (2022)");
    await addTitle("shows", "Other Folder (2023)");
    await scan();
    await setStoragePolicyTitle(app.database.db, "Assigned (2022)", "location_2");
    await configure({ movies: "location_1" });

    expect(await previewDefaultPolicyForUnassigned(app.database.db, "movies")).toEqual({ section: "movies", policy: "location_1", unassignedTitles: 2, radarrReviewTitles: 0 });
    expect(await applyDefaultPolicyToUnassigned(app.database.db, "movies")).toEqual({ section: "movies", policy: "location_1", assigned: 2, skippedForRadarrReview: 0 });

    expect(await policies()).toEqual({
      "Unassigned One (2020)": { policy: "location_1", source: "default" },
      "Unassigned Two (2021)": { policy: "location_1", source: "default" },
      "Assigned (2022)": { policy: "location_2", source: "manual" }
    });
    expect(await applyDefaultPolicyToUnassigned(app.database.db, "movies")).toMatchObject({ assigned: 0 });
    const copyWork = await app.database.db.select().from(schema.jobs);
    expect(copyWork.filter((job) => job.type === "copy")).toEqual([]);
  });

  it("refuses to apply a folder without a saved default", async () => {
    await configure({});
    await expect(applyDefaultPolicyToUnassigned(app.database.db, "movies")).rejects.toThrow("Save a default policy");
  });

  it("flows into Radarr tags like a manual assignment", async () => {
    movies = [movie(1, "Alpha")];
    await configure({ movies: "location_1" });
    await connectRadarr();
    await addTitle("movies", "Alpha (2020)");
    await scan();
    expect((await policies())["Alpha (2020)"]).toEqual({ policy: "location_1", source: "default" });

    await processRadarrWork(app.database.db);
    expect(movies[0]!.tags).toEqual([1]);
  });

  it("leaves a new movie for review when Radarr already carries the opposite tag", async () => {
    movies = [movie(1, "Alpha", [2]), movie(2, "Bravo")];
    await configure({ movies: "location_1" });
    const instanceId = await connectRadarr();
    await addTitle("movies", "Alpha (2020)");
    await addTitle("movies", "Bravo (2020)");
    await scan();

    expect(await policies()).toEqual({ "Bravo (2020)": { policy: "location_1", source: "default" } });
    await processRadarrWork(app.database.db);
    expect(movies[0]!.tags).toEqual([2]);
    expect(movies[1]!.tags).toEqual([1]);
    expect((await getRadarrState(app.database.db, instanceId)).movies.find((item) => item.movieId === 1)).toMatchObject({ policy: "unassigned", status: "review" });
    expect(await previewDefaultPolicyForUnassigned(app.database.db, "movies")).toMatchObject({ unassignedTitles: 0, radarrReviewTitles: 1 });
  });

  it("assigns a movie whose Radarr tag already matches the default", async () => {
    movies = [movie(1, "Alpha", [1])];
    await configure({ movies: "location_1" });
    await connectRadarr();
    await addTitle("movies", "Alpha (2020)");
    await scan();

    expect(await policies()).toEqual({ "Alpha (2020)": { policy: "location_1", source: "default" } });
    await processRadarrWork(app.database.db);
    expect(movies[0]!.tags).toEqual([1]);
  });
});
