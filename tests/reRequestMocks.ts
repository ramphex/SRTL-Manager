import fastify, { type FastifyInstance } from "fastify";
import type { RadarrMovie } from "../src/server/lib/radarrClient";
import type { SonarrEpisode, SonarrEpisodeFile, SonarrSeries } from "../src/server/lib/sonarrClient";

export const arrMockApiKey = "testArrApiKeyOnly";

// Each records calls in order. Removing a file record unmonitors, which real Radarr and Sonarr do when set to unmonitor deleted items.
export interface FakeArr {
  url: string;
  calls: string[];
  failSearch: boolean;
  offline: boolean;
}
export interface FakeRadarr extends FakeArr { movies: RadarrMovie[]; searches: number[][]; deletedFiles: number[] }
export interface FakeSonarr extends FakeArr { series: SonarrSeries[]; files: SonarrEpisodeFile[]; episodes: SonarrEpisode[]; searches: number[][]; deletedFiles: number[]; monitorEdits: Array<{ episodeIds: number[]; monitored: boolean }>; seriesEdits: unknown[] }

const servers: FastifyInstance[] = [];

export async function closeArrMocks(): Promise<void> {
  await Promise.all(servers.splice(0).map((server) => server.close()));
}

function guarded(server: FastifyInstance, fake: FakeArr) {
  server.addHook("preHandler", async (request, reply) => {
    if (request.method !== "GET" || !/\/(movie|series|tag|rootfolder|system\/status)$/.test(request.url)) fake.calls.push(`${request.method} ${request.url.replace("/api/v3/", "")}`);
    if (fake.offline) return reply.code(503).send({ error: "offline" });
    if (request.headers["x-api-key"] !== arrMockApiKey) return reply.code(401).send({ error: "bad key" });
  });
  server.get("/api/v3/tag", async () => [{ id: 1, label: "local" }, { id: 2, label: "remote" }]);
}

export function mockMovie(id: number, title: string, rootFolder: string, fileName: string | null, monitored = true): RadarrMovie {
  return { id, tmdbId: id + 1000, title, year: 2020, path: `${rootFolder}/${title} (2020)`, tags: [1], monitored, movieFile: fileName ? { id: id + 50, relativePath: fileName } : null };
}

export async function fakeRadarr(movies: RadarrMovie[], rootFolder: string): Promise<FakeRadarr> {
  const server = fastify();
  servers.push(server);
  const fake: FakeRadarr = { url: "", calls: [], failSearch: false, offline: false, movies, searches: [], deletedFiles: [] };
  guarded(server, fake);
  server.get("/api/v3/system/status", async () => ({ appName: "Radarr", version: "6.0.0" }));
  server.get("/api/v3/rootfolder", async () => [{ path: rootFolder }]);
  server.get("/api/v3/movie", async () => fake.movies);
  server.get<{ Params: { id: string } }>("/api/v3/movie/:id", async (request, reply) => fake.movies.find((item) => item.id === Number(request.params.id)) ?? reply.code(404).send({ error: "missing" }));
  server.put<{ Body: { movieIds: number[]; monitored?: boolean } }>("/api/v3/movie/editor", async (request) => {
    for (const item of fake.movies.filter((entry) => request.body.movieIds.includes(entry.id))) if (request.body.monitored !== undefined) item.monitored = request.body.monitored;
    return fake.movies;
  });
  server.delete<{ Params: { id: string } }>("/api/v3/moviefile/:id", async (request, reply) => {
    const owner = fake.movies.find((item) => item.movieFile?.id === Number(request.params.id));
    if (!owner) return reply.code(404).send({ error: "missing" });
    owner.movieFile = null;
    owner.monitored = false;
    fake.deletedFiles.push(Number(request.params.id));
    return {};
  });
  server.post<{ Body: { name: string; movieIds: number[] } }>("/api/v3/command", async (request, reply) => {
    if (fake.failSearch || request.body.name !== "MoviesSearch") return reply.code(500).send({ error: "nope" });
    fake.searches.push(request.body.movieIds);
    return reply.code(201).send({ id: 900 + fake.searches.length, name: request.body.name, status: "queued" });
  });
  fake.url = await server.listen({ host: "127.0.0.1", port: 0 });
  return fake;
}

export async function fakeSonarr(series: SonarrSeries[], rootFolder: string): Promise<FakeSonarr> {
  const server = fastify();
  servers.push(server);
  const fake: FakeSonarr = { url: "", calls: [], failSearch: false, offline: false, series, files: [], episodes: [], searches: [], deletedFiles: [], monitorEdits: [], seriesEdits: [] };
  guarded(server, fake);
  server.get("/api/v3/system/status", async () => ({ appName: "Sonarr", version: "4.0.15" }));
  server.get("/api/v3/rootfolder", async () => [{ path: rootFolder }]);
  server.get("/api/v3/series", async () => fake.series);
  server.get<{ Params: { id: string } }>("/api/v3/series/:id", async (request, reply) => fake.series.find((item) => item.id === Number(request.params.id)) ?? reply.code(404).send({ error: "missing" }));
  server.put("/api/v3/series/editor", async (request) => { fake.seriesEdits.push(request.body); return fake.series; });
  server.get<{ Querystring: { seriesId: string } }>("/api/v3/episodefile", async (request) => fake.files.filter((file) => file.seriesId === Number(request.query.seriesId)));
  server.get<{ Querystring: { seriesId: string } }>("/api/v3/episode", async (request) => fake.episodes.filter((episode) => episode.seriesId === Number(request.query.seriesId)));
  server.delete<{ Params: { id: string } }>("/api/v3/episodefile/:id", async (request) => {
    const id = Number(request.params.id);
    fake.files = fake.files.filter((file) => file.id !== id);
    for (const episode of fake.episodes.filter((entry) => entry.episodeFileId === id)) { episode.episodeFileId = 0; episode.monitored = false; }
    fake.deletedFiles.push(id);
    return {};
  });
  server.put<{ Body: { episodeIds: number[]; monitored: boolean } }>("/api/v3/episode/monitor", async (request) => {
    fake.monitorEdits.push(request.body);
    for (const episode of fake.episodes.filter((entry) => request.body.episodeIds.includes(entry.id))) episode.monitored = request.body.monitored;
    return [];
  });
  server.post<{ Body: { name: string; episodeIds: number[] } }>("/api/v3/command", async (request, reply) => {
    if (fake.failSearch || request.body.name !== "EpisodeSearch") return reply.code(500).send({ error: "nope" });
    fake.searches.push(request.body.episodeIds);
    return reply.code(201).send({ id: 700 + fake.searches.length, name: request.body.name, status: "queued" });
  });
  fake.url = await server.listen({ host: "127.0.0.1", port: 0 });
  return fake;
}
