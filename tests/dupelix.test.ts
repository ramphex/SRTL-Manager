import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp, type AppContext } from "../src/server/app";
import { openDatabase } from "../src/server/db/database";
import { markOnboardingCompleteForExistingInstall } from "../src/server/lib/onboarding";
import { loadMediaServers, type MediaServerRecord } from "../src/server/lib/mediaServers";
import { dupelixEncoderCodec, dupelixEncoderEngine, dupelixPosterPath, parseDupelixSession } from "../src/server/lib/nowPlaying/classify";
import { NowPlayingHub, type NowPlayingEvent, type NowPlayingTiming } from "../src/server/lib/nowPlaying/hub";
import { DupelixLiveAdapter, dupelixArtworkAllowed, dupelixArtworkPath, dupelixStopUnavailable, pickDupelixPoster } from "../src/server/lib/nowPlaying/upstream";
import { getWatchSyncState, loadWatchSyncContext } from "../src/server/lib/watchSync";
import { watchSyncHttpTiming } from "../src/server/lib/watchSyncHttp";
import type { MediaServerList } from "../src/shared/mediaServers";
import type { NowPlayingHostEvent, NowPlayingSnapshot } from "../src/shared/nowPlaying";
import { readSetupToken } from "./authHelpers";
import { dupelixArtworkUrl, dupelixDirectStream, dupelixEnded, dupelixHardwareTranscode, dupelixIds, dupelixRichSession, dupelixSession, dupelixTitle } from "./dupelixFixtures";
import { createTestDatabase } from "./testDb";

const now = new Date("2026-11-25T18:20:05.000Z");

describe("Dupelix session mapping", () => {
  it("maps a direct play of a movie from today's ActivitySession", () => {
    const parsed = parseDupelixSession(dupelixSession(), now)!;
    expect(parsed).toMatchObject({ sessionKey: "9ef2cfab-bdeb-4fa0-8b9d-e0cefcbdff10", itemKey: dupelixIds.movie, filePath: null, terminateId: null, remoteControl: false, posterPath: `title:${dupelixIds.movie}` });
    expect(parsed.stream).toMatchObject({
      user: { id: dupelixIds.account, name: "Alex" },
      mediaType: "movie", title: "Example Movie", grandparentTitle: null, episodeLabel: null, year: 2024,
      player: { name: "Living room", device: "Apple TV 4K", platform: "tvOS", product: null, version: null },
      state: "playing", positionMs: 1_234_000, durationMs: null, bufferedMs: null, reportedAt: now.toISOString(),
      playMethod: "directPlay", videoDecision: "directPlay", audioDecision: "directPlay", subtitle: null, output: null, transcode: null,
      bandwidth: { kbps: null, kind: "estimate" },
      network: { location: null, ip: null, relayed: false, secure: null, geo: null }
    });
    // Nothing Dupelix does not report is filled in.
    expect(Object.values(parsed.stream.source).every((value) => value === null)).toBe(true);
  });

  it("maps a hardware transcode of an episode: encoder, output height, reasons, and profile", () => {
    const stream = parseDupelixSession(dupelixHardwareTranscode(), now)!.stream;
    expect(stream).toMatchObject({
      user: { name: "Sam (Kids)" }, mediaType: "episode", title: "Pilot", episodeLabel: "S01E03", grandparentTitle: null,
      player: { name: "Chrome on Windows", device: "Chrome on Windows", platform: "web" },
      playMethod: "transcode", videoDecision: "transcode", audioDecision: null,
      output: { videoCodec: "h264", height: 720, width: null, resolution: "720p", dynamicRange: "SDR", audioCodec: null, bitrateKbps: null },
      transcode: { engine: "hardware", hardwareEncode: "h264_nvenc", hardwareDecode: null, speed: null, throttled: null, reasons: ["This browser cannot play HEVC.", "Quality lowered for the network"], reasonsDerived: false }
    });
  });

  it("maps a direct stream as a remux and a stored version as direct play", () => {
    const remux = parseDupelixSession(dupelixDirectStream(), now)!.stream;
    expect(remux).toMatchObject({ playMethod: "directStream", videoDecision: "copy", audioDecision: null, output: { height: 2160, resolution: "4K" }, transcode: { engine: "cpu", reasons: ["The container was changed for this device."] } });
    const stored = parseDupelixSession(dupelixSession({ route: "stored_version", reason: { code: "stored_version_fits", message: "A stored copy fits." } }), now)!.stream;
    expect(stored).toMatchObject({ playMethod: "directPlay", output: null, transcode: null });
    // Converting only the audio counts as a transcode, as on Plex and Jellyfin, on the CPU.
    const audio = parseDupelixSession(dupelixSession({ route: "direct_stream", reason: { code: "audio_converted", message: "The audio was converted." } }), now)!.stream;
    expect(audio).toMatchObject({ playMethod: "transcode", videoDecision: "copy", audioDecision: "transcode", transcode: { engine: "cpu" } });
    const burn = parseDupelixSession(dupelixSession({ route: "transcode", encoder: null, reason: { code: "subtitle_burn_in_required", message: "Subtitles are burned in." } }), now)!.stream;
    expect(burn).toMatchObject({ subtitle: { decision: "burn" }, transcode: { engine: "unknown" } });
  });

  it("drops ended sessions and entries without a title, and treats an unknown route by what it proves", () => {
    expect(parseDupelixSession(dupelixEnded(), now)).toBeNull();
    expect(parseDupelixSession(dupelixSession({ state: "revoked" }), now)).toBeNull();
    expect(parseDupelixSession(dupelixSession({ title: null }), now)).toBeNull();
    expect(parseDupelixSession({ title: dupelixTitle() }, now)).toBeNull();
    expect(parseDupelixSession(dupelixSession({ route: "future_route", encoder: "hevc_qsv" }), now)!.stream).toMatchObject({ playMethod: "transcode", videoDecision: null, transcode: { engine: "hardware" } });
    expect(parseDupelixSession(dupelixSession({ route: "future_route" }), now)!.stream).toMatchObject({ playMethod: "directStream", transcode: { engine: "cpu" } });
    // An unknown non-final state is still shown as playing.
    expect(parseDupelixSession(dupelixSession({ state: "warming_up" }), now)!.stream.state).toBe("playing");
  });

  it("reads the richer session fields when Dupelix sends them", () => {
    const parsed = parseDupelixSession(dupelixRichSession(), now)!;
    expect(parsed.filePath).toBe("/data/media/tv/Example Show/Season 02/Example Show - S02E05.mkv");
    expect(parsed.stream).toMatchObject({
      state: "paused", durationMs: 2_700_000, grandparentTitle: "Example Show", episodeLabel: "S02E05",
      player: { product: "Dupelix for tvOS", version: "1.4.0" },
      playMethod: "transcode", videoDecision: "transcode", audioDecision: "transcode",
      source: { container: "mkv", videoCodec: "hevc", width: 3840, height: 2160, resolution: "4K", dynamicRange: "HDR10", audioCodec: "truehd", audioChannels: 8, bitrateKbps: 42_000 },
      output: { container: "ts", videoCodec: "h264", width: 1920, height: 1080, resolution: "1080p", dynamicRange: "SDR", audioCodec: "aac", audioChannels: 2, bitrateKbps: 8000 },
      transcode: { engine: "cpu", hardwareEncode: null },
      bandwidth: { kbps: 8500, kind: "nominal" },
      network: { location: "wan", ip: "203.0.113.25" }
    });
    // A title's runtime stands in for the duration, a paused flag or richer state is honoured, and a private address is LAN.
    expect(parseDupelixSession(dupelixSession({ title: dupelixTitle({ runtimeMs: 5_400_000 }) }), now)!.stream.durationMs).toBe(5_400_000);
    expect(parseDupelixSession(dupelixSession({ playbackState: "buffering" }), now)!.stream.state).toBe("buffering");
    expect(parseDupelixSession(dupelixSession({ remoteAddress: "192.168.1.40" }), now)!.stream.network).toMatchObject({ location: "lan", ip: "192.168.1.40" });
    expect(parseDupelixSession(dupelixSession({ local: false }), now)!.stream.network).toMatchObject({ location: "wan", ip: null });
    // Bitrates without a unit in their name are not guessed.
    expect(parseDupelixSession(dupelixSession({ source: { videoCodec: "h264", bitrate: 5000 } }), now)!.stream.source).toMatchObject({ videoCodec: "h264", bitrateKbps: null });
  });

  it("tells hardware and software encoders apart, and the codec they write", () => {
    for (const encoder of ["h264_nvenc", "h264_qsv", "h264_vaapi", "h264_videotoolbox", "hevc_amf", "qsv@0000:00:02.0"]) expect(dupelixEncoderEngine(encoder)).toBe("hardware");
    for (const encoder of ["libx264", "libx265", "libsvtav1", "software"]) expect(dupelixEncoderEngine(encoder)).toBe("cpu");
    expect(dupelixEncoderEngine(null)).toBe("unknown");
    expect(dupelixEncoderEngine("mystery")).toBe("unknown");
    expect([dupelixEncoderCodec("h264_vaapi"), dupelixEncoderCodec("libx265"), dupelixEncoderCodec("av1_nvenc"), dupelixEncoderCodec("mystery")]).toEqual(["h264", "hevc", "av1", null]);
  });
});

describe("Dupelix artwork allow list", () => {
  const base = "https://dupelix.example.com";

  it("accepts only signed Dupelix artwork paths", () => {
    expect(dupelixArtworkAllowed(dupelixArtworkUrl(dupelixIds.artwork))).toBe(true);
    expect(dupelixArtworkAllowed(`${dupelixArtworkUrl(dupelixIds.artwork)}?v=${"a".repeat(64)}.jpg`)).toBe(true);
    for (const path of [
      "/api/v1/titles/0b6f3c1e-8a52-4c1d-9e0a-5d3b7f2a6c01",
      "/api/v1/artwork/not-a-uuid/1700000000/kabc.def",
      `${dupelixArtworkUrl(dupelixIds.artwork)}/../../activity/sessions`,
      `${dupelixArtworkUrl(dupelixIds.artwork)}?v=x`,
      `/api/v1/artwork/${dupelixIds.artwork}/1700000000/k%2e%2e`,
      `//elsewhere.example/api/v1/artwork/${dupelixIds.artwork}/1700000000/kabc.def`
    ]) expect(dupelixArtworkAllowed(path)).toBe(false);
    expect(dupelixPosterPath("not-a-uuid")).toBeNull();
  });

  it("follows a full URL only on the configured server", () => {
    const relative = dupelixArtworkUrl(dupelixIds.artwork);
    expect(dupelixArtworkPath(`${base}${relative}`, base)).toBe(relative);
    expect(dupelixArtworkPath(`https://elsewhere.example${relative}`, base)).toBeNull();
    expect(dupelixArtworkPath("javascript:alert(1)", base)).toBeNull();
  });

  it("picks a poster over a still, the smallest that covers the card, and skips links about to expire", () => {
    const small = dupelixArtworkUrl(dupelixIds.artworkSmall);
    const large = dupelixArtworkUrl(dupelixIds.artwork);
    const still = dupelixArtworkUrl(dupelixIds.still);
    expect(pickDupelixPoster([{ kind: "still", url: still, width: 780 }, { kind: "poster", url: large, width: 780 }, { kind: "poster", url: small, width: 320 }], base)).toBe(small);
    expect(pickDupelixPoster([{ kind: "still", url: still, width: 780 }, { kind: "logo", url: large, width: 780 }], base)).toBe(still);
    expect(pickDupelixPoster([{ kind: "poster", url: dupelixArtworkUrl(dupelixIds.artworkSmall, Date.now() + 10 * 60_000), width: 320 }, { kind: "poster", url: large, width: 780 }], base)).toBe(large);
    expect(pickDupelixPoster([{ kind: "poster", url: "https://elsewhere.example/x.jpg", width: 320 }], base)).toBeNull();
  });

  it("refuses poster keys that are not a title id", async () => {
    const adapter = new DupelixLiveAdapter({ id: "dx1", kind: "dupelix", name: "Dupelix", url: base, token: "msk_example", clientIdentifier: "client-1" });
    await expect(adapter.fetchPoster("/api/v1/activity/sessions")).rejects.toThrow("Unsupported artwork path.");
    await expect(adapter.fetchPoster(dupelixArtworkUrl(dupelixIds.artwork))).rejects.toThrow("Unsupported artwork path.");
    await expect(adapter.stopStream()).rejects.toThrow(dupelixStopUnavailable);
  });
});

// A mocked Dupelix server speaking the parts of /api/v1 SRTL uses. No real server is contacted.
class MockDupelix {
  app: FastifyInstance = fastify();
  base = "";
  apiKey = "msk_exampleKey_0123456789abcdef";
  scopes = new Set(["activity.read", "library.read"]);
  sessions: unknown[] = [];
  pageSize = 200;
  version: string | undefined = "0.1.0 b1";
  artworkStatus = 200;
  requests: Array<{ method: string; path: string; authorization: string | undefined }> = [];

  async start(): Promise<void> {
    this.app.all("/*", async (request, reply) => {
      const url = new URL(request.url, "http://mock");
      this.requests.push({ method: request.method, path: `${url.pathname}${url.search}`, authorization: request.headers.authorization });
      if (url.searchParams.has("api_key") || url.searchParams.has("token")) return reply.code(400).send({ code: "credential_in_url" });
      if (url.pathname === "/api/v1/server") return { apiVersions: ["v1"], contractRevision: 145, ...(this.version && request.headers.authorization ? { version: this.version } : {}) };
      if (url.pathname.startsWith("/api/v1/artwork/")) {
        if (this.artworkStatus !== 200) return reply.code(this.artworkStatus).send({ code: "link_expired" });
        return reply.type("image/jpeg").send(Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
      }
      const granted = (scope: string) => {
        if (request.headers.authorization !== `Bearer ${this.apiKey}`) { void reply.code(401).send({ code: "unauthenticated" }); return false; }
        if (!this.scopes.has(scope)) { void reply.code(403).send({ code: "forbidden" }); return false; }
        return true;
      };
      if (url.pathname === "/api/v1/activity/sessions") {
        if (!granted("activity.read")) return reply;
        const start = Number(url.searchParams.get("cursor") ?? 0);
        const limit = Math.min(Number(url.searchParams.get("limit") ?? 50), this.pageSize);
        const page = this.sessions.slice(start, start + limit);
        return { sessions: page, ...(start + limit < this.sessions.length ? { nextCursor: String(start + limit) } : {}) };
      }
      if (url.pathname === "/api/v1/titles") return granted("library.read") ? { titles: [], nextCursor: null } : reply;
      const title = /^\/api\/v1\/titles\/([0-9a-f-]{36})$/.exec(url.pathname);
      if (title) {
        if (!granted("library.read")) return reply;
        return { ...dupelixTitle({ id: title[1] }), versions: [], externalIds: {}, artwork: [
          { kind: "backdrop", url: dupelixArtworkUrl(dupelixIds.still), width: 1280, height: 720 },
          { kind: "poster", url: dupelixArtworkUrl(dupelixIds.artworkSmall), width: 320, height: 480 },
          { kind: "poster", url: dupelixArtworkUrl(dupelixIds.artwork), width: 780, height: 1170 }
        ] };
      }
      return reply.code(404).send({ code: "not_found" });
    });
    await this.app.listen({ host: "127.0.0.1", port: 0 });
    const address = this.app.server.address();
    if (!address || typeof address === "string") throw new Error("mock server did not bind");
    this.base = `http://127.0.0.1:${address.port}`;
  }

  stop(): Promise<void> {
    return this.app.close();
  }
}

const fastTiming: Partial<NowPlayingTiming> = { graceMs: 80, safetyPollMs: 2000, fallbackPollMs: 40, refreshDebounceMs: 5, socketRetryMs: 50, maxBackoffMs: 200, serverReloadMs: 60_000, extrasMs: 40, stopVerifyMs: 5, broadcastDelayMs: 5 };
const idleHost = () => ({ start: () => undefined, stop: () => undefined, snapshot: (): NowPlayingHostEvent => ({ info: { networkScope: "unavailable", interfaces: [], gpuAvailable: false, sampleIntervalMs: 3000 }, samples: [] }) });

async function waitFor<T>(read: () => T | undefined | null | false, timeoutMs = 3000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("Now Playing with a mocked Dupelix server", () => {
  let mock: MockDupelix;
  let hub: NowPlayingHub | null = null;
  let servers: MediaServerRecord[];

  beforeEach(async () => {
    mock = new MockDupelix();
    await mock.start();
    servers = [{ id: "dx1", kind: "dupelix", name: "Dupelix", url: mock.base, token: mock.apiKey, prefixMappings: [], machineIdentifier: null, accountName: null, accountId: null, version: null, lastCheckedAt: null, lastError: null }];
  });

  afterEach(async () => {
    hub?.close();
    hub = null;
    await mock.stop();
  });

  const watchHub = () => {
    hub = new NowPlayingHub({
      loadServers: async () => servers,
      clientIdentifier: async () => "client-1",
      loadSettings: async () => ({ geoLookup: false }),
      resolveSource: async () => ({ status: "unknown", locationName: null, policy: null }),
      hostMonitor: idleHost,
      timing: fastTiming
    });
    let latest: NowPlayingSnapshot | null = null;
    const unsubscribe = hub.subscribe((event: NowPlayingEvent) => { if (event.type === "sessions") latest = event.snapshot; });
    return { unsubscribe, latest: () => latest as NowPlayingSnapshot | null };
  };

  it("polls sessions across pages with the key in a header, shows polling as normal, and never offers Stop", async () => {
    mock.pageSize = 2;
    mock.sessions = [dupelixSession(), dupelixHardwareTranscode(), dupelixEnded(), dupelixDirectStream()];
    const view = watchHub();
    const snapshot = await waitFor(() => view.latest()?.streams.length === 3 && view.latest());
    expect(snapshot.servers).toEqual([expect.objectContaining({ id: "dx1", kind: "dupelix", status: "polling", transport: "poll", message: null, plexPass: null })]);
    expect(snapshot.streams.map((stream) => [stream.user.name, stream.playMethod, stream.stop])).toEqual([
      ["Alex", "directPlay", { available: false, reason: dupelixStopUnavailable }],
      ["Alex", "directStream", { available: false, reason: dupelixStopUnavailable }],
      ["Sam (Kids)", "transcode", { available: false, reason: dupelixStopUnavailable }]
    ]);
    expect(snapshot.streams[0]!.posterUrl).toMatch(/^\/api\/now-playing\/poster\/[A-Za-z0-9_-]{32}$/);
    expect(JSON.stringify(snapshot)).not.toContain(mock.apiKey);
    // Several polls run at the fallback interval, with no socket attempts and no error building up.
    await waitFor(() => mock.requests.filter((entry) => entry.path.startsWith("/api/v1/activity/sessions?limit=200")).length >= 6);
    expect(view.latest()!.servers[0]).toMatchObject({ status: "polling", message: null });
    expect(mock.requests.every((entry) => entry.authorization === `Bearer ${mock.apiKey}` && !entry.path.includes(mock.apiKey))).toBe(true);
    expect(mock.requests.some((entry) => entry.path.includes("cursor=2"))).toBe(true);
    await expect(hub!.stopStream("dx1", "9ef2cfab-bdeb-4fa0-8b9d-e0cefcbdff10", "Stop")).rejects.toMatchObject({ statusCode: 409, message: dupelixStopUnavailable });
    view.unsubscribe();
  });

  it("fetches posters through the title's signed artwork without the key, caching the lookup and renewing expired links", async () => {
    mock.sessions = [dupelixSession()];
    const view = watchHub();
    const snapshot = await waitFor(() => view.latest()?.streams.length === 1 && view.latest());
    const found = hub!.posterSource(snapshot.streams[0]!.posterUrl!.split("/").at(-1)!)!;
    expect(found.source.path).toBe(`title:${dupelixIds.movie}`);
    expect(await found.adapter.fetchPoster(found.source.path)).toEqual({ contentType: "image/jpeg", body: Buffer.from([0xff, 0xd8, 0xff, 0xd9]) });
    await found.adapter.fetchPoster(found.source.path);
    const titleReads = () => mock.requests.filter((entry) => entry.path === `/api/v1/titles/${dupelixIds.movie}`).length;
    expect(titleReads()).toBe(1);
    const artwork = mock.requests.filter((entry) => entry.path.startsWith("/api/v1/artwork/"));
    expect(artwork).toHaveLength(2);
    // The smallest poster that covers the card, fetched with no credential: the signed link is the credential.
    expect(artwork.every((entry) => entry.path.startsWith(`/api/v1/artwork/${dupelixIds.artworkSmall}/`) && entry.authorization === undefined)).toBe(true);
    mock.artworkStatus = 403;
    await expect(found.adapter.fetchPoster(found.source.path)).rejects.toThrow();
    expect(titleReads()).toBe(2);
    view.unsubscribe();
  });

  it("uses artwork the session carries, without reading the title", async () => {
    mock.sessions = [dupelixRichSession()];
    const view = watchHub();
    const snapshot = await waitFor(() => view.latest()?.streams.length === 1 && view.latest());
    expect(snapshot.streams[0]).toMatchObject({ state: "paused", grandparentTitle: "Example Show", network: { location: "wan", ip: "203.0.113.25" } });
    const found = hub!.posterSource(snapshot.streams[0]!.posterUrl!.split("/").at(-1)!)!;
    await found.adapter.fetchPoster(found.source.path);
    expect(mock.requests.some((entry) => entry.path.startsWith("/api/v1/titles/"))).toBe(false);
    expect(mock.requests.some((entry) => entry.path.startsWith(`/api/v1/artwork/${dupelixIds.artworkSmall}/`))).toBe(true);
    view.unsubscribe();
  });

  it("asks for a key with the right scopes when Dupelix refuses it", async () => {
    mock.scopes.delete("activity.read");
    const view = watchHub();
    const snapshot = await waitFor(() => view.latest()?.servers[0]?.status === "unauthorized" && view.latest());
    expect(snapshot.servers[0]!.message).toContain("activity.read");
    expect(snapshot.streams).toEqual([]);
    view.unsubscribe();
  });
});

describe("Dupelix media servers", () => {
  let app: AppContext;
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let root: string;
  let mock: MockDupelix;
  let cookie: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "srtl-dupelix-test-"));
    for (const folder of ["links", "local", "remote"]) await fs.mkdir(path.join(root, folder), { recursive: true });
    database = await createTestDatabase();
    app = await createApp({ rootDir: root, databaseUrl: database.databaseUrl, autoMigrate: true, paths: { symlinkDir: path.join(root, "links"), localDir: path.join(root, "local"), remoteDir: path.join(root, "remote") } });
    app.app.log.level = "silent";
    await markOnboardingCompleteForExistingInstall(app.database.db);
    mock = new MockDupelix();
    await mock.start();
    watchSyncHttpTiming.backoffMs = 1;
    const setup = await app.app.inject({ method: "POST", url: "/api/auth/setup", payload: { setupToken: readSetupToken(app), username: "fixture", password: "fixture-password-123", confirmPassword: "fixture-password-123" } });
    cookie = String(setup.headers["set-cookie"]);
  });

  afterEach(async () => {
    await mock.stop();
    await app.app.close();
    await database.cleanup();
    await fs.rm(root, { recursive: true, force: true });
  });

  const call = (method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: unknown) =>
    app.app.inject({ method, url, headers: { cookie }, ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }) });

  it("adds a Dupelix server with a sealed key, tests it with the key, and records the version", async () => {
    const rejected = await call("POST", "/api/media-servers", { kind: "dupelix", name: "Dupelix", url: mock.base, token: "not-a-dupelix-key", prefixMappings: [] });
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json().error).toContain("msk_");

    const created = await call("POST", "/api/media-servers", { kind: "dupelix", name: "Dupelix", url: mock.base, token: mock.apiKey, prefixMappings: [] });
    expect(created.statusCode).toBe(200);
    expect(created.body).not.toContain(mock.apiKey);
    const id = (created.json() as MediaServerList).servers[0]!.id;
    const row = (await app.database.pool.query<{ token: string; kind: string }>(`SELECT token, kind FROM media_servers WHERE id = $1`, [id])).rows[0]!;
    expect(row).toMatchObject({ kind: "dupelix" });
    expect(row.token).toMatch(/^enc:v1:/);
    expect((await loadMediaServers(app.database.db))[0]!.token).toBe(mock.apiKey);

    const tested = await call("POST", `/api/media-servers/${id}/test`);
    expect(tested.statusCode).toBe(200);
    expect((tested.json() as MediaServerList).servers[0]).toMatchObject({ kind: "dupelix", version: "0.1.0 b1 (API revision 145)", lastError: null });
    expect(mock.requests.map((entry) => entry.path)).toEqual(["/api/v1/server", "/api/v1/activity/sessions?limit=1", "/api/v1/titles?limit=1"]);
    expect(mock.requests.every((entry) => entry.authorization === `Bearer ${mock.apiKey}`)).toBe(true);

    // A missing scope fails the test, naming the scopes the key needs.
    mock.scopes.delete("library.read");
    const missing = await call("POST", `/api/media-servers/${id}/test`);
    expect(missing.statusCode).toBe(400);
    expect(missing.json().error).toContain("library.read");
    expect((await call("GET", "/api/media-servers")).json().servers[0].lastError).toContain("library.read");

    // A new address needs the key again, and a new address with a key clears what the old one reported.
    const moved = await call("PUT", `/api/media-servers/${id}`, { name: "Dupelix", url: "http://elsewhere.example:8080", prefixMappings: [] });
    expect(moved.statusCode).toBe(400);
    expect(moved.json().error).toContain("Enter the API key again when changing the Dupelix address");
  });

  it("keeps Dupelix out of watch sync", async () => {
    const created = await call("POST", "/api/media-servers", { kind: "dupelix", name: "Dupelix", url: mock.base, token: mock.apiKey, prefixMappings: [] });
    const id = (created.json() as MediaServerList).servers[0]!.id;
    expect((await getWatchSyncState(app.database.db)).servers).toEqual([]);
    expect((await loadWatchSyncContext(app.database.db)).servers).toEqual([]);
    const discover = await call("POST", `/api/settings/watch-sync/servers/${id}/discover`);
    expect(discover.statusCode).toBe(400);
    expect(discover.json().error).toBe("Watch sync does not support Dupelix servers yet.");
    expect(mock.requests).toEqual([]);
  });
});

describe("Dupelix migration", () => {
  it("widens the kind check without touching existing Plex and Jellyfin rows", async () => {
    const testDatabase = await createTestDatabase();
    const first = await openDatabase(testDatabase.databaseUrl);
    try {
      // Rewind to schema 38, where the table only allowed Plex and Jellyfin.
      await first.pool.query(`ALTER TABLE media_servers DROP CONSTRAINT media_servers_kind_check`);
      await first.pool.query(`ALTER TABLE media_servers ADD CONSTRAINT media_servers_kind_check CHECK (kind IN ('plex', 'jellyfin'))`);
      await first.pool.query(`DELETE FROM schema_migrations WHERE version = 39`);
      await first.pool.query(`INSERT INTO media_servers (id, kind, name, url, token, created_at, updated_at) VALUES ('aaaaaaaaaaaa', 'plex', 'Home Plex', 'http://plex:32400', '', now()::text, now()::text), ('bbbbbbbbbbbb', 'jellyfin', 'Jellyfin', 'http://jellyfin:8096', '', now()::text, now()::text)`);
      await expect(first.pool.query(`INSERT INTO media_servers (id, kind, name, url, created_at, updated_at) VALUES ('cccccccccccc', 'dupelix', 'Dupelix', 'http://dupelix:8080', now()::text, now()::text)`)).rejects.toThrow(/media_servers_kind_check/);
    } finally {
      await first.close();
    }
    const upgraded = await openDatabase(testDatabase.databaseUrl);
    try {
      await upgraded.pool.query(`INSERT INTO media_servers (id, kind, name, url, created_at, updated_at) VALUES ('cccccccccccc', 'dupelix', 'Dupelix', 'http://dupelix:8080', now()::text, now()::text)`);
      expect((await upgraded.pool.query<{ id: string; kind: string }>(`SELECT id, kind FROM media_servers ORDER BY id`)).rows).toEqual([
        { id: "aaaaaaaaaaaa", kind: "plex" }, { id: "bbbbbbbbbbbb", kind: "jellyfin" }, { id: "cccccccccccc", kind: "dupelix" }
      ]);
      await expect(upgraded.pool.query(`INSERT INTO media_servers (id, kind, name, url, created_at, updated_at) VALUES ('dddddddddddd', 'emby', 'Other', 'http://other:8096', now()::text, now()::text)`)).rejects.toThrow(/media_servers_kind_check/);
      const checks = await upgraded.pool.query<{ name: string }>(`SELECT conname AS name FROM pg_constraint WHERE conrelid = 'media_servers'::regclass AND contype = 'c'`);
      expect(checks.rows).toEqual([{ name: "media_servers_kind_check" }]);
      expect((await upgraded.pool.query(`SELECT 1 FROM schema_migrations WHERE version = 39 AND name = 'dupelix_media_servers'`)).rowCount).toBe(1);
    } finally {
      await upgraded.close();
      await testDatabase.cleanup();
    }
  });
});
