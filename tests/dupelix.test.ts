import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, type AppContext } from "../src/server/app";
import { openDatabase } from "../src/server/db/database";
import { markOnboardingCompleteForExistingInstall } from "../src/server/lib/onboarding";
import { loadMediaServers, type MediaServerRecord } from "../src/server/lib/mediaServers";
import { dupelixEncoderCodec, dupelixEncoderEngine, dupelixPosterPath, parseDupelixSession } from "../src/server/lib/nowPlaying/classify";
import { NowPlayingHub, type NowPlayingEvent, type NowPlayingTiming } from "../src/server/lib/nowPlaying/hub";
import { DupelixLiveAdapter, dupelixArtworkAllowed, dupelixArtworkHttp, dupelixArtworkLink, dupelixStopNeedsScope, dupelixStopRefused, dupelixStopUnavailable, pickDupelixPoster } from "../src/server/lib/nowPlaying/upstream";
import { getWatchSyncState, loadWatchSyncContext } from "../src/server/lib/watchSync";
import { DupelixClient, dupelixKeyExpired, dupelixKeyLanOnly, dupelixKeyRejected, dupelixWrongAddress } from "../src/server/lib/dupelixClient";
import { retryAfterMs, watchSyncHttpTiming } from "../src/server/lib/watchSyncHttp";
import type { MediaServerList } from "../src/shared/mediaServers";
import type { NowPlayingHostEvent, NowPlayingSnapshot } from "../src/shared/nowPlaying";
import { readSetupToken } from "./authHelpers";
import { dupelixArtworkUrl, dupelixDirectStream, dupelixEnded, dupelixGuestSession, dupelixHardwareTranscode, dupelixIds, dupelixFullSession, dupelixRichSession, dupelixSession, dupelixTitle } from "./dupelixFixtures";
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
    // Only active sessions are shown; a state added later is not guessed to be playing.
    expect(parseDupelixSession(dupelixSession({ state: "warming_up" }), now)).toBeNull();
    expect(parseDupelixSession(dupelixSession({ state: "expired" }), now)).toBeNull();
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

  it("reads a full revision 148 session", () => {
    const parsed = parseDupelixSession(dupelixFullSession(), now)!;
    expect(parsed.remoteControl).toBe(true);
    expect(parsed.filePath).toBeNull();
    expect(parsed.stream).toMatchObject({
      user: { id: dupelixIds.account, name: "Alex", signedInAs: "Jordan" },
      state: "buffering", durationMs: 3_000_000, positionMs: 600_000, bufferedMs: 645_000,
      grandparentTitle: "Example Show", episodeLabel: "S01E03", year: 2023,
      player: { product: "Dupelix for Android TV", version: "2.1.0" },
      playMethod: "transcode", videoDecision: "transcode", audioDecision: "copy",
      subtitle: { decision: "burn", codec: "pgs", language: "English" },
      source: { container: "mkv", videoCodec: "hevc", resolution: "4K", dynamicRange: "Dolby Vision", audioCodec: "eac3", audioChannels: 6, bitrateKbps: 38_000 },
      output: { container: "mp4", videoCodec: "h264", resolution: "1080p", dynamicRange: "SDR", audioCodec: "eac3", audioChannels: 6, bitrateKbps: 9000 },
      transcode: { engine: "hardware", hardwareEncode: "h264_nvenc", hardwareDecode: "GPU", speed: 2.4, throttled: false, reasons: ["This TV cannot play HEVC.", "HDR tone mapped to SDR on the GPU"] },
      bandwidth: { kbps: 9100, kind: "nominal" },
      network: { location: "wan", ip: "198.51.100.40", secure: true }
    });
    // Track decisions outrank the route: copied video and audio make a direct stream, and a hardware flag of false means CPU.
    expect(parseDupelixSession(dupelixSession({ route: "transcode", video: { decision: "copy" }, audio: { decision: "copy" } }), now)!.stream.playMethod).toBe("directStream");
    expect(parseDupelixSession(dupelixSession({ route: "transcode", encoder: "h264_vaapi", transcoder: { hardwareEncode: false } }), now)!.stream.transcode!.engine).toBe("cpu");
    // Early previews sent the transcoder facts at the top level; the nested block wins when both are present.
    expect(parseDupelixSession(dupelixSession({ route: "transcode", encoder: "h264_vaapi", hardwareEncode: false }), now)!.stream.transcode!.engine).toBe("cpu");
    expect(parseDupelixSession(dupelixSession({ route: "transcode", encoder: "libx264", encoderSpeed: 1, transcoder: { encoderSpeed: 3 } }), now)!.stream.transcode!.speed).toBe(3);
    // A track decision of "none" means no such track; unknown decisions and tone mapping read as empty.
    expect(parseDupelixSession(dupelixSession({ route: "transcode", subtitle: { decision: "none", codec: null, language: null } }), now)!.stream.subtitle).toBeNull();
    expect(parseDupelixSession(dupelixSession({ route: "transcode", encoder: "libx264", video: { decision: "future" }, transcoder: { toneMapping: "future" } }), now)!.stream).toMatchObject({ videoDecision: "transcode", transcode: { reasons: ["This device plays the file as it is."] } });
    // The same account signed in and watching shows no second name.
    expect(parseDupelixSession(dupelixSession(), now)!.stream.user).toEqual({ id: dupelixIds.account, name: "Alex" });
    expect(parseDupelixSession(dupelixSession({ network: { local: true } }), now)!.stream.network.location).toBe("lan");
    expect(parseDupelixSession(dupelixSession({ path: "/data/media/movies/Example Movie (2024)/Example Movie.mkv" }), now)!.filePath).toBe("/data/media/movies/Example Movie (2024)/Example Movie.mkv");
    // Direct play has nothing prepared ahead by the server.
    expect(parseDupelixSession(dupelixSession({ readyAheadMs: 30_000 }), now)!.stream.bufferedMs).toBeNull();
  });

  it("tells hardware and software encoders apart, and the codec they write", () => {
    for (const encoder of ["h264_nvenc", "h264_qsv", "h264_vaapi", "h264_videotoolbox", "hevc_amf", "qsv@0000:00:02.0"]) expect(dupelixEncoderEngine(encoder)).toBe("hardware");
    for (const encoder of ["libx264", "libx265", "libsvtav1", "software"]) expect(dupelixEncoderEngine(encoder)).toBe("cpu");
    expect(dupelixEncoderEngine(null)).toBe("unknown");
    expect(dupelixEncoderEngine("mystery")).toBe("unknown");
    expect([dupelixEncoderCodec("h264_vaapi"), dupelixEncoderCodec("libx265"), dupelixEncoderCodec("av1_nvenc"), dupelixEncoderCodec("mystery")]).toEqual(["h264", "hevc", "av1", null]);
  });
});

describe("Retry-After", () => {
  it("reads seconds and HTTP dates, and ignores anything else", () => {
    const at = Date.parse("2026-11-26T07:00:00.000Z");
    expect(retryAfterMs("30", at)).toBe(30_000);
    expect(retryAfterMs(["2"], at)).toBe(2000);
    expect(retryAfterMs("Thu, 26 Nov 2026 07:00:45 GMT", at)).toBe(45_000);
    expect(retryAfterMs("-1", at)).toBeNull();
    expect(retryAfterMs("soon", at)).toBeNull();
    expect(retryAfterMs(undefined, at)).toBeNull();
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

  it("accepts a signed artwork link on another origin over HTTPS only, and nothing but the artwork path", () => {
    const relative = dupelixArtworkUrl(dupelixIds.artwork);
    // SRTL reaches Dupelix on a local integration route; Dupelix signs links for its public HTTPS address.
    const local = "http://dupelix:8100";
    expect(dupelixArtworkLink(relative, local)).toBe(`${local}${relative}`);
    expect(dupelixArtworkLink(`${local}${relative}`, local)).toBe(`${local}${relative}`);
    expect(dupelixArtworkLink(`https://media.example.com${relative}`, local)).toBe(`https://media.example.com${relative}`);
    expect(dupelixArtworkLink(`https://media.example.com:8443${relative}?v=${"b".repeat(64)}.png`, local)).toBe(`https://media.example.com:8443${relative}?v=${"b".repeat(64)}.png`);
    expect(dupelixArtworkLink(`https://elsewhere.example${relative}`, base)).toBe(`https://elsewhere.example${relative}`);
    for (const link of [
      // Another origin over plain HTTP.
      `http://media.example.com${relative}`,
      `http://dupelix:8200${relative}`,
      // Other paths, on the configured server or elsewhere.
      `https://media.example.com/api/v1/activity/sessions`,
      `https://media.example.com/api/v1/titles/${dupelixIds.movie}`,
      `${local}/api/v1/api-keys/current`,
      `https://media.example.com${relative}/extra`,
      `https://media.example.com${relative}?v=x`,
      `${relative}/../../../activity/sessions`,
      `/api/v1/x/../artwork/${dupelixIds.artwork}/1900000000/kabc.def`,
      // Credentials, fragments, protocol-relative and other schemes.
      `https://user:secret@media.example.com${relative}`,
      `https://media.example.com${relative}#frag`,
      `//media.example.com${relative}`,
      `ftp://media.example.com${relative}`,
      "javascript:alert(1)",
      "not a url"
    ]) expect(dupelixArtworkLink(link, local), link).toBeNull();
  });

  it("picks a poster over a still, the smallest that covers the card, and skips links about to expire", () => {
    const small = dupelixArtworkUrl(dupelixIds.artworkSmall);
    const large = dupelixArtworkUrl(dupelixIds.artwork);
    const still = dupelixArtworkUrl(dupelixIds.still);
    expect(pickDupelixPoster([{ kind: "still", url: still, width: 780 }, { kind: "poster", url: large, width: 780 }, { kind: "poster", url: small, width: 320 }], base)).toBe(`${base}${small}`);
    expect(pickDupelixPoster([{ kind: "still", url: still, width: 780 }, { kind: "logo", url: large, width: 780 }], base)).toBe(`${base}${still}`);
    expect(pickDupelixPoster([{ kind: "poster", url: dupelixArtworkUrl(dupelixIds.artworkSmall, Date.now() + 10 * 60_000), width: 320 }, { kind: "poster", url: large, width: 780 }], base)).toBe(`${base}${large}`);
    expect(pickDupelixPoster([{ kind: "poster", url: "https://elsewhere.example/x.jpg", width: 320 }], base)).toBeNull();
  });

  it("refuses poster keys that are not a title id", async () => {
    const adapter = new DupelixLiveAdapter({ id: "dx1", kind: "dupelix", name: "Dupelix", url: base, token: "msk_example", clientIdentifier: "client-1" });
    await expect(adapter.fetchPoster("/api/v1/activity/sessions")).rejects.toThrow("Unsupported artwork path.");
    await expect(adapter.fetchPoster(dupelixArtworkUrl(dupelixIds.artwork))).rejects.toThrow("Unsupported artwork path.");
    // Until the key's scopes are known, Stop waits.
    expect(adapter.stopAvailability(parseDupelixSession(dupelixFullSession(), now)!)).toEqual({ available: false, reason: "Checking the Dupelix API key's scopes." });
  });
});

// A mocked Dupelix server speaking the parts of /api/v1 SRTL uses. No real server is contacted.
class MockDupelix {
  app: FastifyInstance = fastify();
  base = "";
  apiKey = "msk_exampleKey_0123456789abcdef";
  scopes = new Set(["activity.read", "library.read"]);
  // Older servers have no /api-keys/current.
  keyEndpoint = true;
  keyExpiresAt: string | null = null;
  sessions: unknown[] = [];
  guests: unknown[] = [];
  stops: Array<{ id: string; body: unknown; contentType: string | undefined }> = [];
  ignoreStops = false;
  pageSize = 100;
  version: string | undefined = "0.1.0 b1";
  artworkStatus = 200;
  requests: Array<{ method: string; path: string; authorization: string | undefined; headers: Record<string, string | string[] | undefined>; rawHeaders: string[] }> = [];
  // A local integration route: every request without a key gets 404, /server included.
  localRoute = false;
  // An address that is not a Dupelix integration route at all.
  notDupelix = false;
  // Answers every request with 429 and this Retry-After (seconds) while set.
  rateLimited: string | null = null;

  async start(): Promise<void> {
    this.app.all("/*", async (request, reply) => {
      const url = new URL(request.url, "http://mock");
      this.requests.push({ method: request.method, path: `${url.pathname}${url.search}`, authorization: request.headers.authorization, headers: { ...request.headers }, rawHeaders: [...request.raw.rawHeaders] });
      if (this.notDupelix || (this.localRoute && !request.headers.authorization)) return reply.code(404).send({ code: "not_found" });
      if (this.localRoute && request.headers.authorization !== `Bearer ${this.apiKey}`) return reply.code(401).send({ code: "unauthenticated" });
      if (url.searchParams.has("api_key") || url.searchParams.has("token")) return reply.code(400).send({ code: "credential_in_url" });
      if (this.rateLimited !== null) return reply.code(429).header("Retry-After", this.rateLimited).send({ code: "rate_limited" });
      if (url.pathname === "/api/v1/server") return { apiVersions: ["v1"], contractRevision: 148, ...(this.version && request.headers.authorization ? { version: this.version } : {}) };
      if (url.pathname.startsWith("/api/v1/artwork/")) {
        if (this.artworkStatus !== 200) return reply.code(this.artworkStatus).send({ code: "link_expired" });
        return reply.type("image/jpeg").send(Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
      }
      const granted = (scope: string) => {
        if (request.headers.authorization !== `Bearer ${this.apiKey}`) { void reply.code(401).send({ code: "unauthenticated" }); return false; }
        if (!this.scopes.has(scope)) { void reply.code(403).send({ code: "forbidden" }); return false; }
        return true;
      };
      if (url.pathname === "/api/v1/api-keys/current" && this.keyEndpoint) {
        if (request.headers.authorization !== `Bearer ${this.apiKey}`) return reply.code(401).send({ code: "unauthenticated" });
        return { id: dupelixIds.device, name: "SRTL Manager", prefix: this.apiKey.slice(0, 12), scopes: [...this.scopes, "activity.read"], effectiveScopes: [...this.scopes], expiresAt: this.keyExpiresAt, lanOnly: true };
      }
      if (url.pathname === "/api/v1/activity/sessions") {
        if (!granted("activity.read")) return reply;
        if (url.searchParams.get("includeGuests") === "true" && !this.scopes.has("activity.guests")) return reply.code(403).send({ code: "forbidden" });
        const all = [...this.sessions, ...(url.searchParams.get("includeGuests") === "true" ? this.guests : [])];
        const start = Number(url.searchParams.get("cursor") ?? 0);
        const requested = Number(url.searchParams.get("limit") ?? 50);
        if (!Number.isInteger(requested) || requested < 1 || requested > 100) return reply.code(400).send({ code: "invalid_limit" });
        const limit = Math.min(requested, this.pageSize);
        const page = all.slice(start, start + limit);
        return { sessions: page, ...(start + limit < all.length ? { nextCursor: String(start + limit) } : {}) };
      }
      const stop = /^\/api\/v1\/activity\/sessions\/([0-9a-f-]{36})\/stop$/.exec(url.pathname);
      if (stop && request.method === "POST") {
        if (!granted("activity.stop")) return reply;
        this.stops.push({ id: stop[1]!, body: request.body, contentType: request.headers["content-type"] });
        if (!this.ignoreStops) this.sessions = this.sessions.filter((session) => (session as { id: string }).id !== stop[1]);
        return reply.code(202).send({ status: "stopping" });
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

  it("polls sessions across pages with the key in a header, shows polling as normal, and offers no Stop without activity.stop", async () => {
    mock.pageSize = 2;
    mock.sessions = [dupelixSession(), dupelixHardwareTranscode(), dupelixEnded(), dupelixDirectStream()];
    const view = watchHub();
    const snapshot = await waitFor(() => view.latest()?.streams.length === 3 && view.latest());
    expect(snapshot.servers).toEqual([expect.objectContaining({ id: "dx1", kind: "dupelix", status: "polling", transport: "poll", message: null, plexPass: null })]);
    expect(snapshot.streams.map((stream) => [stream.user.name, stream.playMethod, stream.stop])).toEqual([
      ["Alex", "directPlay", { available: false, reason: dupelixStopNeedsScope }],
      ["Alex", "directStream", { available: false, reason: dupelixStopNeedsScope }],
      ["Sam (Kids)", "transcode", { available: false, reason: dupelixStopNeedsScope }]
    ]);
    // No guests without activity.guests, and the key's scopes are read once, not on every poll.
    expect(mock.requests.some((entry) => entry.path.includes("includeGuests"))).toBe(false);
    expect(snapshot.streams[0]!.posterUrl).toMatch(/^\/api\/now-playing\/poster\/[A-Za-z0-9_-]{32}$/);
    expect(JSON.stringify(snapshot)).not.toContain(mock.apiKey);
    // Several polls run at the fallback interval, with no socket attempts and no error building up.
    await waitFor(() => mock.requests.filter((entry) => entry.path.startsWith("/api/v1/activity/sessions?limit=100")).length >= 6);
    expect(view.latest()!.servers[0]).toMatchObject({ status: "polling", message: null });
    expect(mock.requests.every((entry) => entry.authorization === `Bearer ${mock.apiKey}` && !entry.path.includes(mock.apiKey))).toBe(true);
    expect(mock.requests.some((entry) => entry.path.includes("cursor=2"))).toBe(true);
    expect(mock.requests.filter((entry) => entry.path === "/api/v1/api-keys/current")).toHaveLength(1);
    await expect(hub!.stopStream("dx1", "9ef2cfab-bdeb-4fa0-8b9d-e0cefcbdff10", "Stop")).rejects.toMatchObject({ statusCode: 409, message: dupelixStopNeedsScope });
    view.unsubscribe();
  });

  it("stops a stream that Dupelix says can be stopped, with the message, and checks that it is gone", async () => {
    mock.scopes.add("activity.stop");
    mock.sessions = [dupelixFullSession(), dupelixSession({ canStop: false })];
    const view = watchHub();
    const snapshot = await waitFor(() => view.latest()?.streams.length === 2 && view.latest());
    const stoppable = snapshot.streams.find((stream) => stream.sessionKey === "e4d7b4fa-acda-4ef5-9aec-d5bdeabcee15")!;
    const refused = snapshot.streams.find((stream) => stream.sessionKey === "9ef2cfab-bdeb-4fa0-8b9d-e0cefcbdff10")!;
    expect(stoppable.stop).toEqual({ available: true, reason: null });
    expect(refused.stop).toEqual({ available: false, reason: dupelixStopRefused });
    const message = `\u0007${"x".repeat(198)}\né and more`;
    await expect(hub!.stopStream("dx1", stoppable.sessionKey, message)).resolves.toEqual({ result: "stopped", message: "The stream has stopped." });
    expect(mock.stops).toEqual([{ id: stoppable.sessionKey, body: { message: `${"x".repeat(198)} é` }, contentType: "application/json" }]);
    await expect(hub!.stopStream("dx1", refused.sessionKey, "Stop")).rejects.toMatchObject({ statusCode: 409, message: dupelixStopRefused });

    // A server that accepts the stop but keeps listing the stream is reported honestly.
    await waitFor(() => !view.latest()?.streams.some((stream) => stream.sessionKey === stoppable.sessionKey));
    mock.ignoreStops = true;
    mock.sessions = [dupelixFullSession()];
    await waitFor(() => view.latest()?.streams.some((stream) => stream.sessionKey === stoppable.sessionKey));
    await expect(hub!.stopStream("dx1", stoppable.sessionKey, "")).resolves.toMatchObject({ result: "stillPlaying" });
    expect(mock.stops.at(-1)!.body).toEqual({});
    view.unsubscribe();
  });

  it("lists guest profiles only for a key with activity.guests", async () => {
    mock.sessions = [dupelixSession()];
    mock.guests = [dupelixGuestSession()];
    mock.scopes.add("activity.guests");
    const view = watchHub();
    const snapshot = await waitFor(() => view.latest()?.streams.length === 2 && view.latest());
    expect(snapshot.streams.map((stream) => stream.user.name).sort()).toEqual(["Alex", "Guest"]);
    expect(mock.requests.some((entry) => entry.path.includes("includeGuests=true"))).toBe(true);
    view.unsubscribe();
  });

  it("says when an older Dupelix server cannot stop streams", async () => {
    mock.keyEndpoint = false;
    mock.sessions = [dupelixSession()];
    const view = watchHub();
    const snapshot = await waitFor(() => view.latest()?.streams.length === 1 && view.latest());
    expect(snapshot.streams[0]!.stop).toEqual({ available: false, reason: dupelixStopUnavailable });
    expect(snapshot.servers[0]).toMatchObject({ status: "polling", message: null });
    view.unsubscribe();
  });

  it("fetches posters through the title's signed artwork without the key, caching the image by link and renewing expired links", async () => {
    mock.sessions = [dupelixSession()];
    const view = watchHub();
    const snapshot = await waitFor(() => view.latest()?.streams.length === 1 && view.latest());
    const found = hub!.posterSource(snapshot.streams[0]!.posterUrl!.split("/").at(-1)!)!;
    expect(found.source.path).toBe(`title:${dupelixIds.movie}`);
    const titleReads = () => mock.requests.filter((entry) => entry.path === `/api/v1/titles/${dupelixIds.movie}`).length;
    const artwork = () => mock.requests.filter((entry) => entry.path.startsWith("/api/v1/artwork/"));
    // An expired or revoked link: the title is read once more for fresh links.
    mock.artworkStatus = 403;
    await expect(found.adapter.fetchPoster(found.source.path)).rejects.toThrow();
    expect(titleReads()).toBe(2);
    mock.artworkStatus = 200;
    const image = { contentType: "image/jpeg", body: Buffer.from([0xff, 0xd8, 0xff, 0xd9]) };
    // Simultaneous requests share one fetch, and later ones come from the cache.
    expect(await Promise.all([found.adapter.fetchPoster(found.source.path), found.adapter.fetchPoster(found.source.path)])).toEqual([image, image]);
    expect(await found.adapter.fetchPoster(found.source.path)).toEqual(image);
    expect(titleReads()).toBe(2);
    expect(artwork()).toHaveLength(3);
    // The smallest poster that covers the card, fetched with no credential: the signed link is the credential.
    expect(artwork().every((entry) => entry.path.startsWith(`/api/v1/artwork/${dupelixIds.artworkSmall}/`) && entry.authorization === undefined)).toBe(true);
    view.unsubscribe();
  });

  it("never reads titles without library.read, and uses the artwork the session carries", async () => {
    mock.scopes.delete("library.read");
    mock.sessions = [dupelixSession(), dupelixFullSession()];
    const view = watchHub();
    const snapshot = await waitFor(() => view.latest()?.streams.length === 2 && view.latest());
    const posterFor = (sessionKey: string) => {
      const found = hub!.posterSource(snapshot.streams.find((stream) => stream.sessionKey === sessionKey)!.posterUrl!.split("/").at(-1)!)!;
      return found.adapter.fetchPoster(found.source.path);
    };
    await expect(posterFor("e4d7b4fa-acda-4ef5-9aec-d5bdeabcee15")).resolves.toMatchObject({ contentType: "image/jpeg" });
    await expect(posterFor("9ef2cfab-bdeb-4fa0-8b9d-e0cefcbdff10")).rejects.toThrow("Dupelix has no artwork for this title.");
    expect(mock.requests.some((entry) => entry.path.startsWith("/api/v1/titles"))).toBe(false);
    view.unsubscribe();
  });

  it("fetches artwork signed for Dupelix's public HTTPS address without the key, and refuses other hosts", async () => {
    mock.localRoute = true;
    const publicLink = `https://media.example.com${dupelixArtworkUrl(dupelixIds.artwork)}`;
    mock.sessions = [
      dupelixSession({ title: dupelixTitle({ artwork: [{ kind: "poster", url: publicLink, width: 320, height: 480 }] }) }),
      dupelixFullSession()
    ];
    // The episode's only links point at plain HTTP on another host, or at another path.
    (mock.sessions[1] as { title: { artwork: unknown } }).title.artwork = [
      { kind: "poster", url: `http://media.example.com${dupelixArtworkUrl(dupelixIds.artworkSmall)}`, width: 320, height: 480 },
      { kind: "still", url: "https://media.example.com/api/v1/activity/sessions", width: 780, height: 439 }
    ];
    mock.scopes.delete("library.read");
    const fetched: Array<{ url: string; headers?: Record<string, string>; trusted?: boolean }> = [];
    const spy = vi.spyOn(dupelixArtworkHttp, "request").mockImplementation(async (request) => {
      fetched.push(request);
      return { status: 200, headers: { "content-type": "image/jpeg" }, body: "", buffer: Buffer.from([0xff, 0xd8, 0xff, 0xd9]), serverTime: null };
    });
    try {
      const view = watchHub();
      const snapshot = await waitFor(() => view.latest()?.streams.length === 2 && view.latest());
      const posterFor = (sessionKey: string) => {
        const found = hub!.posterSource(snapshot.streams.find((stream) => stream.sessionKey === sessionKey)!.posterUrl!.split("/").at(-1)!)!;
        return found.adapter.fetchPoster(found.source.path);
      };
      await expect(posterFor("9ef2cfab-bdeb-4fa0-8b9d-e0cefcbdff10")).resolves.toMatchObject({ contentType: "image/jpeg" });
      expect(fetched).toEqual([expect.objectContaining({ url: publicLink })]);
      expect(fetched[0]!.headers).toEqual({ Accept: "image/*" });
      expect(fetched[0]!.trusted).toBeUndefined();
      await expect(posterFor("e4d7b4fa-acda-4ef5-9aec-d5bdeabcee15")).rejects.toThrow("Dupelix has no artwork for this title.");
      expect(fetched).toHaveLength(1);
      // Every API request carried exactly one Authorization header and no forwarding headers.
      expect(mock.requests.length).toBeGreaterThan(0);
      for (const entry of mock.requests) {
        expect(entry.rawHeaders.filter((_, index) => index % 2 === 0 && entry.rawHeaders[index]!.toLowerCase() === "authorization")).toHaveLength(1);
        expect(Object.keys(entry.headers).filter((name) => name.startsWith("x-forwarded") || name === "forwarded")).toEqual([]);
      }
      view.unsubscribe();
    } finally {
      spy.mockRestore();
    }
  });

  it("waits as long as a 429 asks, keeping the last streams meanwhile", async () => {
    mock.sessions = [dupelixSession()];
    const view = watchHub();
    await waitFor(() => view.latest()?.streams.length === 1);
    const beforeLimit = mock.requests.length;
    mock.rateLimited = "1";
    await waitFor(() => mock.requests.length > beforeLimit);
    const limitedAt = mock.requests.length;
    // Polls keep running every few tens of milliseconds here, but nothing reaches Dupelix during the pause.
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(mock.requests.length).toBe(limitedAt);
    expect(view.latest()!.streams).toHaveLength(1);
    expect(view.latest()!.servers[0]).toMatchObject({ status: "polling" });
    mock.rateLimited = null;
    const before = mock.requests.length;
    await waitFor(() => mock.requests.length > before + 1, 3000);
    expect(view.latest()!.streams).toHaveLength(1);
    view.unsubscribe();
  });

  it("uses artwork the session carries under other names, without reading the title", async () => {
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

  it("adds a Dupelix server with a sealed key, tests it through the key's own description, and keeps nothing about the key but the sealed key", async () => {
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

    mock.scopes.add("activity.network");
    const tested = await call("POST", `/api/media-servers/${id}/test`);
    expect(tested.statusCode).toBe(200);
    const testedServer = (tested.json() as MediaServerList).servers[0]!;
    expect(testedServer).toMatchObject({ kind: "dupelix", version: "0.1.0 b1 (API revision 148)", lastError: null });
    // The browser gets what Plex and Jellyfin servers send: no part of the key, and nothing Dupelix said about it.
    expect(Object.keys(testedServer).sort()).toEqual(["accountName", "hasToken", "id", "kind", "lastCheckedAt", "lastError", "machineIdentifier", "name", "prefixMappings", "url", "version"]);
    expect(tested.body).not.toContain(mock.apiKey.slice(0, 8));
    expect(tested.body).not.toContain("SRTL Manager");
    // A LAN-only key is fine on a plain HTTP address.
    expect(Object.keys((await app.database.pool.query(`SELECT * FROM media_servers LIMIT 1`)).rows[0]!)).not.toContain("api_key");
    expect(mock.requests.map((entry) => entry.path)).toEqual(["/api/v1/server", "/api/v1/api-keys/current"]);
    expect(mock.requests.every((entry) => entry.authorization === `Bearer ${mock.apiKey}`)).toBe(true);

    // library.read is optional: a key with only activity.read passes.
    mock.scopes = new Set(["activity.read"]);
    expect((await call("POST", `/api/media-servers/${id}/test`)).statusCode).toBe(200);

    // A required scope missing from the key's effective scopes fails the test, naming it.
    mock.scopes = new Set(["library.read"]);
    const missing = await call("POST", `/api/media-servers/${id}/test`);
    expect(missing.statusCode).toBe(400);
    const missingText = "The Dupelix key is missing the permission See who is watching. Edit the key in Dupelix under Admin > Integrations.";
    expect(missing.json().error).toBe(missingText);
    expect((await call("GET", "/api/media-servers")).json().servers[0].lastError).toBe(missingText);

    // An expired key shows as the server's status the same way.
    mock.scopes = new Set(["activity.read"]);
    mock.keyExpiresAt = "2020-01-01T00:00:00.000Z";
    const expired = await call("POST", `/api/media-servers/${id}/test`);
    expect(expired.statusCode).toBe(400);
    expect(expired.json().error).toBe(dupelixKeyExpired);
    expect((await call("GET", "/api/media-servers")).json().servers[0].lastError).toBe(dupelixKeyExpired);
    mock.keyExpiresAt = new Date(Date.now() + 86_400_000).toISOString();
    expect((await call("POST", `/api/media-servers/${id}/test`)).json().servers[0].lastError).toBeNull();
    mock.scopes = new Set(["library.read"]);

    // An older server without the key endpoint is probed with one page of sessions instead.
    mock.keyEndpoint = false;
    mock.requests = [];
    const probed = await call("POST", `/api/media-servers/${id}/test`);
    expect(probed.statusCode).toBe(400);
    expect(probed.json().error).toContain("activity.read");
    mock.scopes.add("activity.read");
    const old = await call("POST", `/api/media-servers/${id}/test`);
    expect(old.statusCode).toBe(200);
    expect((old.json() as MediaServerList).servers[0]!.lastError).toBeNull();
    expect(mock.requests.slice(-3).map((entry) => entry.path)).toEqual(["/api/v1/server", "/api/v1/api-keys/current", "/api/v1/activity/sessions?limit=1"]);

    // A new address needs the key again, and a new address with a key clears what the old one reported.
    const moved = await call("PUT", `/api/media-servers/${id}`, { name: "Dupelix", url: "http://elsewhere.example:8080", prefixMappings: [] });
    expect(moved.statusCode).toBe(400);
    expect(moved.json().error).toContain("Enter the API key again when changing the Dupelix address");
  });

  it("refuses a LAN-only key on an HTTPS address, and only there", async () => {
    const answer = (lanOnly: boolean | null) => async (path: string) => ({ data: path === "/api-keys/current" ? { effectiveScopes: ["activity.read"], expiresAt: null, lanOnly } : {} });
    const client = (url: string, lanOnly: boolean | null) => {
      const dupelix = new DupelixClient(url, mock.apiKey);
      (dupelix as unknown as { get: ReturnType<typeof answer> }).get = answer(lanOnly);
      return dupelix;
    };
    await expect(client("https://dupelix.example.com", true).checkAccess()).rejects.toThrow(dupelixKeyLanOnly);
    await expect(client("https://dupelix.example.com", false).checkAccess()).resolves.toBeUndefined();
    await expect(client("https://dupelix.example.com", null).checkAccess()).resolves.toBeUndefined();
    await expect(client("http://dupelix.example.com:8100", true).checkAccess()).resolves.toBeUndefined();
  });

  it("sends the key to /server on a local integration route, and tells a wrong address from a rejected key", async () => {
    mock.localRoute = true;
    const created = await call("POST", "/api/media-servers", { kind: "dupelix", name: "Dupelix", url: mock.base, token: mock.apiKey, prefixMappings: [] });
    const id = (created.json() as MediaServerList).servers[0]!.id;
    const tested = await call("POST", `/api/media-servers/${id}/test`);
    expect(tested.statusCode).toBe(200);
    expect((tested.json() as MediaServerList).servers[0]).toMatchObject({ version: "0.1.0 b1 (API revision 148)", lastError: null });
    expect(mock.requests[0]).toMatchObject({ path: "/api/v1/server", authorization: `Bearer ${mock.apiKey}` });
    for (const entry of mock.requests) {
      expect(entry.rawHeaders.filter((_, index) => index % 2 === 0 && entry.rawHeaders[index]!.toLowerCase() === "authorization")).toHaveLength(1);
      expect(Object.keys(entry.headers).filter((name) => name.startsWith("x-forwarded") || name === "forwarded")).toEqual([]);
    }

    // A revoked key: 401 on /server.
    mock.apiKey = "msk_revokedKey_0123456789abcdef";
    const revoked = await call("POST", `/api/media-servers/${id}/test`);
    expect(revoked.statusCode).toBe(400);
    expect(revoked.json().error).toBe(dupelixKeyRejected);

    // Not a Dupelix integration route: 404 even with a key.
    mock.notDupelix = true;
    const wrong = await call("POST", `/api/media-servers/${id}/test`);
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json().error).toBe(dupelixWrongAddress);
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
      // A pre-release build stored a key description here; migration 40 drops it.
      await first.pool.query(`ALTER TABLE media_servers ADD COLUMN api_key TEXT`);
      await first.pool.query(`DELETE FROM schema_migrations WHERE version IN (39, 40)`);
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
      expect((await upgraded.pool.query(`SELECT 1 FROM schema_migrations WHERE version = 40 AND name = 'media_server_api_keys'`)).rowCount).toBe(1);
      expect((await upgraded.pool.query(`SELECT 1 FROM information_schema.columns WHERE table_name = 'media_servers' AND column_name = 'api_key'`)).rowCount).toBe(0);
    } finally {
      await upgraded.close();
      await testDatabase.cleanup();
    }
  });
});
