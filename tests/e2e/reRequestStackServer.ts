// The server side of re-request-stack.spec.ts, run under tsx: the real API, worker, database and files, with mock Radarr and Sonarr.
// The spec drives the browser and uses the small control server below to add files and read what the mocks were asked.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import fastify from "fastify";
import "../setup";
import { createApp } from "../../src/server/app";
import * as schema from "../../src/server/db/schema";
import { JobWorker } from "../../src/server/jobs/jobRunner";
import { markOnboardingCompleteForExistingInstall } from "../../src/server/lib/onboarding";
import { createRadarrInstance, saveRadarrSettings } from "../../src/server/lib/radarr";
import { processReRequestWork } from "../../src/server/lib/reRequests";
import { persistSectionSettings } from "../../src/server/lib/sectionSettings";
import { createSonarrInstance, saveSonarrSettings } from "../../src/server/lib/sonarr";
import { readSetupToken } from "../authHelpers";
import { arrMockApiKey as apiKey, closeArrMocks, fakeRadarr, fakeSonarr, mockMovie } from "../reRequestMocks";
import { createTestDatabase } from "../testDb";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const oldTime = new Date(Date.now() - 3 * 86_400_000);
const ownerPassword = "owner-password-for-tests";
const temporaryPassword = "temporary-password-for-tests";
const moderatorPassword = "moderator-password-for-tests";
const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };

const root = await fs.mkdtemp(path.join(os.tmpdir(), "srtl-re-request-stack-"));
for (const folder of ["links", "local", "remote"]) await fs.mkdir(path.join(root, folder), { recursive: true });
const database = await createTestDatabase();
const app = await createApp({ rootDir: root, dataDir: path.join(root, "data"), webRoot: path.join(repoRoot, "dist", "client"), databaseUrl: database.databaseUrl, autoMigrate: true, anonymousRequestsPerMinute: 100_000, paths: { symlinkDir: path.join(root, "links"), localDir: path.join(root, "local"), remoteDir: path.join(root, "remote") } });
app.app.log.level = "silent";
const { db } = app.database;
await markOnboardingCompleteForExistingInstall(db);
await persistSectionSettings(db, { sections: ["movies", "movies4k", "shows"], sectionTypes: { movies: "movies", movies4k: "movies", shows: "shows" } });

const radarr = await fakeRadarr([mockMovie(1, "Alpha", "/m", "Alpha.mkv", false), mockMovie(2, "Bravo", "/m", "Bravo.mkv"), mockMovie(3, "Quiet", "/m", "Quiet.mkv")], "/m");
const radarr4k = await fakeRadarr(Array.from({ length: 8 }, (_, index) => mockMovie(index + 1, `Bulk${index}`, "/m4k", `Bulk${index}.mkv`)), "/m4k");
const sonarr = await fakeSonarr([{ id: 7, tvdbId: 77, title: "Delta", year: 2020, path: "/tv/Delta (2020)", tags: [], monitored: true }], "/tv");
sonarr.files.push({ id: 40, seriesId: 7, relativePath: "Season 01/Delta - S01E01.mkv" });
sonarr.episodes.push({ id: 101, seriesId: 7, episodeFileId: 40, seasonNumber: 1, episodeNumber: 1, monitored: false }, { id: 102, seriesId: 7, episodeFileId: 0, seasonNumber: 1, episodeNumber: 2, monitored: false });
const arrSettings = (url: string, rootPath: string, section: string) => ({ revision: 0, baseUrl: url, apiKey, webhookSecret: "", enabled: true, localTag: "local", remoteTag: "remote", monitorOnCopy: false, mappingMode: "manual" as const, mappings: [{ rootPath, section }] });
await saveRadarrSettings(db, (await createRadarrInstance(db, "Radarr")).settings.id, arrSettings(radarr.url, "/m", "movies"));
await saveRadarrSettings(db, (await createRadarrInstance(db, "Radarr 4K")).settings.id, arrSettings(radarr4k.url, "/m4k", "movies4k"));
await saveSonarrSettings(db, (await createSonarrInstance(db, "Sonarr")).settings.id, arrSettings(sonarr.url, "/tv", "shows"));

async function localFile(section: string, itemName: string, relativePath: string, options: { linked?: boolean; integrity?: string } = {}) {
  const storageRelative = `${section}/${itemName}/${relativePath}`;
  const filePath = path.join(root, "local", storageRelative);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `bytes of ${storageRelative}`);
  await fs.utimes(filePath, oldTime, oldTime);
  const stat = await fs.stat(filePath);
  const now = new Date().toISOString();
  const [row] = await db.insert(schema.storageFiles).values({ rootType: "local", rootPath: path.join(root, "local"), section, itemName, relativePath: storageRelative, filePath, storagePolicy: "unassigned", sizeBytes: stat.size, mtimeMs: Math.trunc(stat.mtimeMs), allocatedBytes: null, integrity: options.integrity ?? "hollow", firstSeenAt: now, lastSeenAt: now, lastChangedAt: now, lastSeenJobId: 0, updatedAt: now }).returning();
  const linkPath = path.join(root, "links", section, itemName, relativePath);
  if (options.linked !== false) {
    await fs.mkdir(path.dirname(linkPath), { recursive: true });
    await fs.symlink(filePath, linkPath);
    await db.insert(schema.mediaLinks).values({ section, itemName, relativePath: `${itemName}/${relativePath}`, linkPath, targetPath: filePath, kind: "local", targetExists: true, isMedia: true, storagePolicy: "unassigned", resolvedStorageFileId: row!.id, lastSeenAt: now, updatedAt: now });
  }
  return { id: row!.id, filePath, linkPath };
}

for (const section of ["movies", "movies4k", "shows"]) await localFile(section, "Keeper (1999)", "Keeper.mkv", { integrity: "ok" });

const setup = await app.app.inject({ method: "POST", url: "/api/auth/setup", payload: { setupToken: readSetupToken(app), username: "the-owner", password: ownerPassword, confirmPassword: ownerPassword } });
const owner = String(setup.headers["set-cookie"]).split(";")[0]!;
await app.app.inject({ method: "POST", url: "/api/accounts", headers: { cookie: owner }, payload: { username: "a-moderator", role: "moderator", temporaryPassword } });
const login = await app.app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "a-moderator", password: temporaryPassword } });
const changed = await app.app.inject({ method: "PUT", url: "/api/auth/user", headers: { cookie: String(login.headers["set-cookie"]).split(";")[0]! }, payload: { username: "a-moderator", currentPassword: temporaryPassword, newPassword: moderatorPassword, confirmNewPassword: moderatorPassword } });
if (setup.statusCode !== 200 || changed.statusCode !== 200) throw new Error("Could not create the test accounts");

const baseUrl = await app.app.listen({ host: "127.0.0.1", port: 0 });

let stopped = false;
let working: Promise<void> = Promise.resolve();
const worker = new JobWorker(db, { workerId: "re-request-stack", logger: quiet });
// The real worker passes every five seconds; this one is quicker, but each pass keeps the real allowance.
const workerTimer = setInterval(() => {
  working = working.then(async () => {
    if (stopped) return;
    while (await worker.runOnce()) { /* drain */ }
    await processReRequestWork(db);
  }).catch(() => undefined);
}, 500);

const mocks = { radarr, radarr4k, sonarr };
const control = fastify();
control.post<{ Body: { section: string; itemName: string; relativePath: string; linked?: boolean } }>("/file", async (request) => localFile(request.body.section, request.body.itemName, request.body.relativePath, { linked: request.body.linked !== false }));
control.get<{ Querystring: { path: string } }>("/exists", async (request) => ({ exists: await fs.lstat(request.query.path).then(() => true, () => false) }));
control.get("/state", async () => mocks);
control.post<{ Body: { failSearch?: boolean; clearCalls?: boolean } }>("/radarr", async (request) => {
  if (request.body.failSearch !== undefined) radarr.failSearch = request.body.failSearch;
  if (request.body.clearCalls) radarr.calls.length = 0;
  return {};
});
const controlUrl = await control.listen({ host: "127.0.0.1", port: 0 });

async function shutDown() {
  stopped = true;
  clearInterval(workerTimer);
  await working;
  await control.close();
  await closeArrMocks();
  await app.app.close();
  await database.cleanup();
  await fs.rm(root, { recursive: true, force: true });
  process.exit(0);
}
process.once("SIGTERM", () => void shutDown());

process.stdout.write(`STACK_READY ${JSON.stringify({ baseUrl, controlUrl })}\n`);
