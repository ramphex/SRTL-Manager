import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MediaServerRecord } from "../src/server/lib/mediaServers";
import type { ParsedSession } from "../src/server/lib/nowPlaying/classify";
import { GeoLookup, isPrivateAddress } from "../src/server/lib/nowPlaying/geo";
import { NowPlayingHub, type NowPlayingEvent, type NowPlayingTiming } from "../src/server/lib/nowPlaying/hub";
import { plexBandwidthRate, type LiveAdapter, type SocketHandlers } from "../src/server/lib/nowPlaying/upstream";
import { plexEndpoints } from "../src/server/lib/plexClient";
import type { NowPlayingGeo, NowPlayingHostEvent, NowPlayingSnapshot } from "../src/shared/nowPlaying";
import { jellyfinDirectPlay, jellyfinIdleSession, jellyfinRemux, jellyfinVideoTranscodeWithBurnIn, plexDirectPlayMovie, plexHardwareTranscodeEpisode, plexampTrack } from "./nowPlayingFixtures";

// Mocked Plex Media Server, plex.tv, and Jellyfin. No real server is contacted.
class MockLiveServers {
  app: FastifyInstance = fastify();
  base = "";
  plexToken = "plex-owner-token";
  jellyfinKey = "jellyfin-api-key";
  plexPass = true;
  plexSessions: Array<{ session: Record<string, unknown>; library: Record<string, unknown> }> = [];
  jellyfinSessions: unknown[] = [];
  terminateStatus = 200;
  ignoreStops = false;
  jellyfinOffline = false;
  requests: string[] = [];
  geoLookups: string[] = [];
  // Websockets: off by default, so the servers fall back to polling.
  sockets = false;
  socketHeaderAuth = true;
  socketLog: string[] = [];
  socketReceived: string[] = [];
  socketMessages = new Map<string, unknown[]>();
  private openSockets = new Set<Duplex>();

  // A minimal RFC 6455 server: the handshake, unmasked text frames out, and small masked text frames in.
  private upgrade(request: IncomingMessage, socket: Duplex): void {
    const url = new URL(request.url ?? "/", "http://mock");
    const plex = url.pathname === "/pms/:/websockets/notifications";
    const jellyfin = url.pathname === "/jf/socket";
    const viaHeader = plex ? request.headers["x-plex-token"] === this.plexToken : String(request.headers.authorization ?? "").includes(`Token="${this.jellyfinKey}"`);
    const viaQuery = plex ? url.searchParams.get("X-Plex-Token") === this.plexToken : url.searchParams.get("api_key") === this.jellyfinKey;
    const authorized = (viaHeader && this.socketHeaderAuth) || viaQuery;
    if (!this.sockets || !(plex || jellyfin) || !authorized) {
      socket.end(`HTTP/1.1 ${this.sockets && (plex || jellyfin) ? "401 Unauthorized" : "404 Not Found"}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      return;
    }
    this.socketLog.push(`${plex ? "plex" : "jellyfin"}:${viaHeader && this.socketHeaderAuth ? "header" : "query"}`);
    const accept = createHash("sha1").update(`${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    this.openSockets.add(socket);
    socket.on("close", () => this.openSockets.delete(socket));
    socket.on("error", () => undefined);
    socket.on("data", (chunk: Buffer) => {
      if ((chunk[0]! & 0x0f) !== 1 || (chunk[1]! & 0x7f) >= 126) return;
      const length = chunk[1]! & 0x7f;
      const mask = chunk.subarray(2, 6);
      this.socketReceived.push(Buffer.from(chunk.subarray(6, 6 + length).map((byte, index) => byte ^ mask[index % 4]!)).toString("utf8"));
    });
    setTimeout(() => {
      for (const message of this.socketMessages.get(plex ? "plex" : "jellyfin") ?? []) MockLiveServers.sendFrame(socket, JSON.stringify(message));
    }, 150);
  }

  static sendFrame(socket: Duplex, text: string): void {
    const payload = Buffer.from(text);
    let header: Buffer;
    if (payload.length < 126) header = Buffer.from([0x81, payload.length]);
    else if (payload.length < 65_536) {
      header = Buffer.alloc(4);
      header[0] = 0x81;
      header[1] = 126;
      header.writeUInt16BE(payload.length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x81;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(payload.length), 2);
    }
    socket.write(Buffer.concat([header, payload]));
  }

  async stop(): Promise<void> {
    for (const socket of this.openSockets) socket.destroy();
    await this.app.close();
  }

  async start(): Promise<void> {
    this.app.server.on("upgrade", (request: IncomingMessage, socket: Duplex) => this.upgrade(request, socket));
    this.app.all("/*", async (request, reply) => {
      const url = new URL(request.url, "http://mock");
      const route = url.pathname;
      this.requests.push(`${request.method} ${route}${url.search}`);
      if (route.startsWith("/plextv/")) {
        if (request.headers["x-plex-token"] !== this.plexToken) return reply.code(401).send({});
        if (route === "/plextv/api/v2/user") return { id: 1, username: "alex_03", subscription: this.plexPass ? { active: true, status: "Active", plan: "lifetime" } : { active: false, status: "Inactive" } };
        if (route === "/plextv/api/v2/geoip") {
          this.geoLookups.push(url.searchParams.get("ip_address") ?? "");
          return { code: "NL", country: "Netherlands", city: "Example City", subdivisions: "North Holland" };
        }
      }
      if (route.startsWith("/pms/")) {
        if (request.headers["x-plex-token"] !== this.plexToken) return reply.code(401).send({});
        if (route === "/pms/status/sessions") return { MediaContainer: { size: this.plexSessions.length, Metadata: this.plexSessions.map((entry) => entry.session) } };
        if (route.startsWith("/pms/library/metadata/")) {
          const keys = route.slice("/pms/library/metadata/".length).split(",");
          return { MediaContainer: { Metadata: this.plexSessions.map((entry) => entry.library).filter((item) => keys.includes(String(item.ratingKey))) } };
        }
        if (route === "/pms/status/sessions/terminate") {
          if (this.terminateStatus !== 200) return reply.code(this.terminateStatus).send("");
          const id = url.searchParams.get("sessionId");
          if (!this.ignoreStops) this.plexSessions = this.plexSessions.filter((entry) => (entry.session.Session as { id?: string } | undefined)?.id !== id);
          return "";
        }
        if (route === "/pms/statistics/bandwidth") {
          const at = Math.floor(Date.now() / 1000);
          return { MediaContainer: { StatisticsBandwidth: [{ at: at - 2, lan: true, bytes: 3_000_000 }, { at: at - 1, lan: true, bytes: 3_000_000 }, { at: at - 1, lan: false, bytes: 1_000_000 }, { at: at - 3600, lan: false, bytes: 999_999_999 }] } };
        }
        if (route === "/pms/statistics/resources") return { MediaContainer: { StatisticsResources: [{ at: 1, hostCpuUtilization: 12.34, processCpuUtilization: 4.5, hostMemoryUtilization: 40, processMemoryUtilization: 3 }] } };
        if (route === "/pms/photo/:/transcode") return reply.type("image/jpeg").send(Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
      }
      if (route.startsWith("/jf/")) {
        if (this.jellyfinOffline) return reply.code(503).send({});
        if (!String(request.headers.authorization ?? "").includes(`Token="${this.jellyfinKey}"`)) return reply.code(401).send({});
        if (route === "/jf/Sessions" && request.method === "GET") return this.jellyfinSessions;
        const stop = /^\/jf\/Sessions\/([^/]+)\/Playing\/Stop$/.exec(route);
        if (stop && !this.ignoreStops) this.jellyfinSessions = this.jellyfinSessions.filter((session) => (session as { Id?: string }).Id !== stop[1]);
        if (stop || /^\/jf\/Sessions\/[^/]+\/Message$/.test(route)) return reply.code(204).send();
      }
      return reply.code(404).send({ error: "not found" });
    });
    await this.app.listen({ host: "127.0.0.1", port: 0 });
    const address = this.app.server.address();
    if (!address || typeof address === "string") throw new Error("mock server did not bind");
    this.base = `http://127.0.0.1:${address.port}`;
  }
}

const fastTiming: Partial<NowPlayingTiming> = { graceMs: 80, safetyPollMs: 2000, fallbackPollMs: 60, refreshDebounceMs: 5, socketRetryMs: 60_000, maxBackoffMs: 200, serverReloadMs: 60_000, extrasMs: 40, stopVerifyMs: 5, broadcastDelayMs: 5 };

function record(overrides: Partial<MediaServerRecord> & Pick<MediaServerRecord, "id" | "kind" | "url" | "token">): MediaServerRecord {
  return { name: overrides.kind === "plex" ? "Home Plex" : "Jellyfin", prefixMappings: [], machineIdentifier: null, accountName: null, accountId: null, version: null, lastCheckedAt: null, lastError: null, ...overrides };
}

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

function watch(hub: NowPlayingHub) {
  let latest: NowPlayingSnapshot | null = null;
  const unsubscribe = hub.subscribe((event: NowPlayingEvent) => { if (event.type === "sessions") latest = event.snapshot; });
  return { unsubscribe, latest: () => latest as NowPlayingSnapshot | null };
}

describe("Now Playing hub against mocked servers", () => {
  let mock: MockLiveServers;
  let hub: NowPlayingHub | null = null;
  let servers: MediaServerRecord[];
  const originalPlexTv = plexEndpoints.plexTv;

  beforeEach(async () => {
    mock = new MockLiveServers();
    await mock.start();
    plexEndpoints.plexTv = `${mock.base}/plextv`;
    servers = [
      record({ id: "plex1", kind: "plex", url: `${mock.base}/pms`, token: mock.plexToken, prefixMappings: [{ serverPrefix: "/data/media", srtlPrefix: "/mnt/links" }] }),
      record({ id: "jf1", kind: "jellyfin", url: `${mock.base}/jf`, token: mock.jellyfinKey })
    ];
  });

  afterEach(async () => {
    hub?.close();
    hub = null;
    plexEndpoints.plexTv = originalPlexTv;
    await mock.stop();
  });

  const createHub = (options: { geoLookup?: boolean } = {}) => {
    hub = new NowPlayingHub({
      loadServers: async () => servers,
      clientIdentifier: async () => "client-1",
      loadSettings: async () => ({ geoLookup: options.geoLookup ?? false }),
      resolveSource: async (_serverId, _mappings, filePath) => filePath?.includes("/movies/") ? { status: "local", locationName: "Home NAS", policy: "location_1" } : { status: "remote", locationName: "Debrid", policy: null },
      hostMonitor: idleHost,
      timing: fastTiming
    });
    return hub;
  };

  it("lists Plex and Jellyfin sessions together, skipping idle Jellyfin sessions, with SRTL sources and token-free poster URLs", async () => {
    mock.plexSessions = [plexDirectPlayMovie(), plexHardwareTranscodeEpisode()];
    mock.jellyfinSessions = [jellyfinDirectPlay(), jellyfinIdleSession()];
    const view = watch(createHub());
    const snapshot = await waitFor(() => view.latest()?.streams.length === 3 && view.latest()!.servers.every((server) => server.plexPass !== null || server.kind === "jellyfin") && view.latest());
    expect(snapshot.servers.map((server) => [server.id, server.status, server.transport])).toEqual([["plex1", "polling", "poll"], ["jf1", "polling", "poll"]]);
    expect(snapshot.streams.map((stream) => `${stream.serverName}/${stream.user.name}/${stream.playMethod}`)).toEqual(["Home Plex/alex_03/directPlay", "Home Plex/sam/transcode", "Jellyfin/alex_03/directPlay"]);
    const movie = snapshot.streams[0]!;
    expect(movie).toMatchObject({ id: "plex1:12", srtl: { status: "local", locationName: "Home NAS" }, stop: { available: true } });
    expect(movie.posterUrl).toMatch(/^\/api\/now-playing\/poster\/[A-Za-z0-9_-]{32}$/);
    expect(JSON.stringify(snapshot)).not.toContain(mock.plexToken);
    expect(JSON.stringify(snapshot)).not.toContain(mock.jellyfinKey);
    const poster = hub!.posterSource(movie.posterUrl!.split("/").at(-1)!)!;
    expect(await poster.adapter.fetchPoster(poster.source.path)).toEqual({ contentType: "image/jpeg", body: Buffer.from([0xff, 0xd8, 0xff, 0xd9]) });
    expect(mock.requests.some((entry) => entry.startsWith("GET /pms/photo/:/transcode?width=240"))).toBe(true);
    // Each playing item's library entry is read once, not on every poll.
    const before = mock.requests.filter((entry) => entry.startsWith("GET /pms/library/metadata")).length;
    await waitFor(() => mock.requests.filter((entry) => entry === "GET /pms/status/sessions").length >= 4);
    expect(mock.requests.filter((entry) => entry.startsWith("GET /pms/library/metadata")).length).toBe(before);
    // Plex's own LAN/WAN streaming figures and resource use, from the statistics endpoints.
    const withExtras = await waitFor(() => view.latest()?.servers[0]?.bandwidth && view.latest());
    expect(withExtras.servers[0]!.bandwidth!.lanBps).toBeGreaterThan(withExtras.servers[0]!.bandwidth!.wanBps);
    expect(withExtras.servers[0]!.resources).toEqual({ hostCpu: 12.3, processCpu: 4.5, hostMemory: 40, processMemory: 3 });
    view.unsubscribe();
  });

  it("takes change events from the Plex and Jellyfin sockets, authenticating with headers rather than URLs", async () => {
    mock.sockets = true;
    mock.plexSessions = [plexDirectPlayMovie()];
    // Jellyfin's socket pushes the session list itself; the safety poll answers with the same list.
    mock.jellyfinSessions = [jellyfinDirectPlay()];
    mock.socketMessages.set("jellyfin", [{ MessageType: "ForceKeepAlive", Data: 60 }, { MessageType: "Sessions", Data: [jellyfinDirectPlay(), jellyfinVideoTranscodeWithBurnIn()] }]);
    mock.socketMessages.set("plex", [{ NotificationContainer: { type: "playing", size: 1, PlaySessionStateNotification: [{ sessionKey: "12", state: "playing", viewOffset: 777_000, ratingKey: "101" }] } }]);
    const view = watch(createHub());
    const snapshot = await waitFor(() => view.latest()?.servers.every((server) => server.status === "live" && server.transport === "socket") && view.latest()!.streams.length === 3
      && view.latest()!.streams.find((stream) => stream.sessionKey === "12")?.positionMs === 777_000 && view.latest());
    expect(snapshot.streams.map((stream) => stream.sessionKey)).toEqual(["12", "jf-session-1", "jf-session-2"]);
    expect(mock.socketLog.sort()).toEqual(["jellyfin:header", "plex:header"]);
    expect(mock.socketReceived).toContain(JSON.stringify({ MessageType: "SessionsStart", Data: "0,2000" }));
    view.unsubscribe();
  });

  it("falls back to the token in the socket URL for servers that ignore headers there", async () => {
    mock.sockets = true;
    mock.socketHeaderAuth = false;
    servers = servers.filter((server) => server.kind === "plex");
    const view = watch(createHub());
    await waitFor(() => view.latest()?.servers[0]?.status === "live");
    expect(mock.socketLog).toEqual(["plex:query"]);
    view.unsubscribe();
  });

  it("drops a stream as soon as the latest list no longer contains it", async () => {
    mock.plexSessions = [plexDirectPlayMovie(), plexHardwareTranscodeEpisode()];
    const view = watch(createHub());
    await waitFor(() => view.latest()?.streams.length === 2);
    mock.plexSessions = [plexHardwareTranscodeEpisode()];
    const snapshot = await waitFor(() => view.latest()?.streams.length === 1 && view.latest());
    expect(snapshot.streams[0]!.sessionKey).toBe("15");
    view.unsubscribe();
  });

  describe("stopping streams", () => {
    it("hides Stop on Plex streams without Plex Pass and refuses the request", async () => {
      mock.plexPass = false;
      mock.plexSessions = [plexDirectPlayMovie()];
      const view = watch(createHub());
      const stream = await waitFor(() => view.latest()?.servers[0]?.plexPass === false && view.latest()!.streams[0]);
      expect(stream.stop).toEqual({ available: false, reason: "Stopping Plex streams needs an active Plex Pass on the server owner's account." });
      await expect(hub!.stopStream("plex1", "12", "Bye")).rejects.toMatchObject({ statusCode: 409 });
      expect(mock.requests.some((entry) => entry.includes("/terminate"))).toBe(false);
      view.unsubscribe();
    });

    it("stops a Plex stream by Session.id with the message, and hides Stop for Plexamp", async () => {
      mock.plexSessions = [plexDirectPlayMovie(), plexampTrack()];
      const view = watch(createHub());
      const snapshot = await waitFor(() => view.latest()?.servers[0]?.plexPass === true && view.latest()!.streams.length === 2 && view.latest());
      expect(snapshot.streams.find((stream) => stream.sessionKey === "40")!.stop).toMatchObject({ available: false, reason: expect.stringContaining("Plexamp") });
      expect(snapshot.streams.find((stream) => stream.sessionKey === "12")!.stop).toEqual({ available: true, reason: null });
      const result = await hub!.stopStream("plex1", "12", "Server maintenance, back soon");
      expect(result).toEqual({ result: "stopped", message: "The stream has stopped." });
      expect(mock.requests).toContain("POST /pms/status/sessions/terminate?sessionId=plex-session-abc&reason=Server%20maintenance%2C%20back%20soon");
      view.unsubscribe();
    });

    it("reports honestly when the stream is still there, and maps Plex refusals to clear messages", async () => {
      mock.plexSessions = [plexDirectPlayMovie()];
      mock.ignoreStops = true;
      const view = watch(createHub());
      await waitFor(() => view.latest()?.streams[0]?.stop.available);
      expect(await hub!.stopStream("plex1", "12", "x")).toMatchObject({ result: "stillPlaying", message: expect.stringContaining("still lists this stream") });
      mock.terminateStatus = 401;
      await expect(hub!.stopStream("plex1", "12", "x")).rejects.toThrow(/Plex Pass/);
      mock.terminateStatus = 403;
      await expect(hub!.stopStream("plex1", "12", "x")).rejects.toThrow(/server owner/);
      mock.terminateStatus = 404;
      expect(await hub!.stopStream("plex1", "12", "x")).toMatchObject({ result: "stopped", message: expect.stringContaining("ended already") });
      await expect(hub!.stopStream("plex1", "999", "x")).rejects.toMatchObject({ statusCode: 404 });
      view.unsubscribe();
    });

    it("sends the message to Jellyfin, then stops playback; clients without remote control cannot be stopped", async () => {
      mock.jellyfinSessions = [jellyfinVideoTranscodeWithBurnIn(), jellyfinRemux()];
      servers = servers.filter((server) => server.kind === "jellyfin");
      const view = watch(createHub());
      const snapshot = await waitFor(() => view.latest()?.streams.length === 2 && view.latest());
      expect(snapshot.streams.find((stream) => stream.sessionKey === "jf-session-4")!.stop).toEqual({ available: false, reason: "This Jellyfin client does not accept remote control." });
      expect(await hub!.stopStream("jf1", "jf-session-2", "Please stop")).toMatchObject({ result: "stopped" });
      const calls = mock.requests.filter((entry) => entry.startsWith("POST /jf/Sessions/jf-session-2"));
      expect(calls).toEqual(["POST /jf/Sessions/jf-session-2/Message", "POST /jf/Sessions/jf-session-2/Playing/Stop"]);
      await expect(hub!.stopStream("jf1", "jf-session-4", "x")).rejects.toMatchObject({ statusCode: 409 });
      view.unsubscribe();
    });
  });

  it("marks a server unreachable after three failures and clears its streams, then recovers", async () => {
    mock.jellyfinSessions = [jellyfinDirectPlay()];
    servers = servers.filter((server) => server.kind === "jellyfin");
    const view = watch(createHub());
    await waitFor(() => view.latest()?.streams.length === 1);
    mock.jellyfinOffline = true;
    const down = await waitFor(() => view.latest()?.servers[0]?.status === "unreachable" && view.latest());
    expect(down.streams).toEqual([]);
    expect(down.servers[0]!.message).toContain("not answering (3 failed attempts)");
    mock.jellyfinOffline = false;
    const up = await waitFor(() => view.latest()?.servers[0]?.status === "polling" && view.latest()!.streams.length === 1 && view.latest());
    expect(up.servers[0]!.message).toBeNull();
    view.unsubscribe();
  });

  it("shows a clear sign-in state when Plex rejects the token", async () => {
    servers = [{ ...servers[0]!, token: "expired-token" }];
    const view = watch(createHub());
    const server = await waitFor(() => view.latest()?.servers[0]?.status === "unauthorized" && view.latest()!.servers[0]);
    expect(server.message).toBe("Plex token invalid — sign in again in Settings > Media servers.");
    view.unsubscribe();
  });

  it("looks up public client addresses lazily through plex.tv when enabled", async () => {
    mock.plexSessions = [plexDirectPlayMovie(), plexHardwareTranscodeEpisode()];
    const view = watch(createHub({ geoLookup: true }));
    const stream = await waitFor(() => view.latest()?.streams.find((entry) => entry.network.geo));
    expect(stream.network).toMatchObject({ ip: "198.51.100.23", location: "wan", geo: { city: "Example City", region: "North Holland", country: "Netherlands", code: "NL" } });
    // The LAN client at 192.168.1.40 is never sent to plex.tv.
    expect(mock.geoLookups).toEqual(["198.51.100.23"]);
    expect(view.latest()!.streams.find((entry) => entry.sessionKey === "12")!.network.geo).toBeNull();
    view.unsubscribe();
  });
});

describe("live lifecycle", () => {
  class CountingAdapter implements LiveAdapter {
    fetches = 0;
    sockets = 0;
    closed = 0;
    handlers: SocketHandlers | null = null;
    sessions: ParsedSession[] = [];
    async fetchSessions() { this.fetches += 1; return this.sessions; }
    async openSocket(handlers: SocketHandlers) { this.sockets += 1; this.handlers = handlers; return () => { this.closed += 1; }; }
    async stopStream() { /* not used */ }
    async fetchPoster(): Promise<{ contentType: string; body: Buffer }> { throw new Error("not used"); }
  }

  it("opens no upstream connection without viewers and tears down after the last viewer leaves", async () => {
    const adapter = new CountingAdapter();
    let hostRunning = 0;
    let loads = 0;
    const hub = new NowPlayingHub({
      loadServers: async () => { loads += 1; return [record({ id: "plex1", kind: "plex", url: "http://192.168.1.10:32400", token: "t" })]; },
      clientIdentifier: async () => "client-1",
      loadSettings: async () => ({ geoLookup: false }),
      resolveSource: async () => ({ status: "unknown", locationName: null, policy: null }),
      createAdapter: () => adapter,
      plexPass: async () => true,
      hostMonitor: () => ({ start: () => { hostRunning += 1; }, stop: () => { hostRunning -= 1; }, snapshot: idleHost().snapshot }),
      timing: { ...fastTiming, graceMs: 100 }
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect({ fetches: adapter.fetches, sockets: adapter.sockets, loads, hostRunning, active: hub.isActive, upstream: hub.upstreamCount }).toEqual({ fetches: 0, sockets: 0, loads: 0, hostRunning: 0, active: false, upstream: 0 });

      const events: NowPlayingEvent[] = [];
      const first = hub.subscribe((event) => events.push(event));
      // A new viewer gets the current state straight away.
      expect(events.map((event) => event.type)).toEqual(["sessions", "host"]);
      await waitFor(() => adapter.fetches > 0 && adapter.sockets === 1);
      expect(hostRunning).toBe(1);
      await waitFor(() => (events.at(-1) as Extract<NowPlayingEvent, { type: "sessions" }>).snapshot?.servers[0]?.status === "live");

      const second = hub.subscribe(() => undefined);
      first();
      second();
      expect(hub.isActive).toBe(true);
      // Coming back within the grace period keeps the same connection.
      const third = hub.subscribe(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(adapter.sockets).toBe(1);
      expect(hub.isActive).toBe(true);
      third();
      await waitFor(() => !hub.isActive, 1000);
      expect({ closed: adapter.closed, hostRunning, upstream: hub.upstreamCount }).toEqual({ closed: 1, hostRunning: 0, upstream: 0 });
      const fetches = adapter.fetches;
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(adapter.fetches).toBe(fetches);
    } finally {
      hub.close();
    }
  });

  it("applies socket progress events without polling, and refreshes on a state change", async () => {
    const adapter = new CountingAdapter();
    const { session, library } = plexDirectPlayMovie();
    const { parsePlexSession } = await import("../src/server/lib/nowPlaying/classify");
    adapter.sessions = [parsePlexSession(session, library)!];
    const hub = new NowPlayingHub({
      loadServers: async () => [record({ id: "plex1", kind: "plex", url: "http://192.168.1.10:32400", token: "t" })],
      clientIdentifier: async () => "client-1",
      loadSettings: async () => ({ geoLookup: false }),
      resolveSource: async () => ({ status: "unknown", locationName: null, policy: null }),
      createAdapter: () => adapter,
      plexPass: async () => true,
      hostMonitor: idleHost,
      timing: fastTiming
    });
    try {
      const view = watch(hub);
      await waitFor(() => view.latest()?.streams.length === 1 && adapter.handlers);
      const fetches = adapter.fetches;
      adapter.handlers!.onEvent({ type: "progress", sessionKey: "12", positionMs: 654_321, state: "playing" });
      await waitFor(() => view.latest()?.streams[0]?.positionMs === 654_321);
      expect(adapter.fetches).toBe(fetches);
      adapter.handlers!.onEvent({ type: "progress", sessionKey: "12", positionMs: 654_400, state: "paused" });
      await waitFor(() => view.latest()?.streams[0]?.state === "paused");
      await waitFor(() => adapter.fetches > fetches);
      adapter.sessions = [];
      adapter.handlers!.onEvent({ type: "progress", sessionKey: "12", positionMs: null, state: "stopped" });
      await waitFor(() => view.latest()?.streams.length === 0);
      view.unsubscribe();
    } finally {
      hub.close();
    }
  });
});

describe("geo lookup", () => {
  it("skips private, loopback, link-local, and CGNAT addresses", () => {
    for (const address of ["192.168.1.20", "10.1.2.3", "172.16.0.9", "172.31.255.1", "127.0.0.1", "169.254.10.1", "100.64.0.1", "100.127.255.254", "::1", "fe80::1", "fd12:3456::1", "::ffff:192.168.1.5", "not-an-ip"]) {
      expect(isPrivateAddress(address), address).toBe(true);
    }
    for (const address of ["203.0.113.5", "198.51.100.23", "100.128.0.1", "172.32.0.1", "2001:db8::1", "::ffff:203.0.113.9"]) {
      expect(isPrivateAddress(address), address).toBe(false);
    }
  });

  it("never blocks, caches answers per address, retries failures after a short time, and honors the toggle", async () => {
    const calls: string[] = [];
    let enabled = true;
    let fail = true;
    let resolved = 0;
    const geo = new GeoLookup({
      token: () => "token", clientIdentifier: () => "client-1", enabled: () => enabled, onResolved: () => { resolved += 1; },
      negativeTtlMs: 30,
      fetch: async (ip): Promise<NowPlayingGeo | null> => {
        calls.push(ip);
        if (fail) throw new Error("timeout");
        return { city: "Example City", region: null, country: "Netherlands", code: "NL" };
      }
    });
    expect(geo.get("192.168.1.20")).toBeNull();
    expect(geo.get("100.64.1.1")).toBeNull();
    expect(calls).toEqual([]);
    expect(geo.get("203.0.113.5")).toBeNull();
    expect(geo.get("203.0.113.5")).toBeNull();
    await waitFor(() => resolved === 1);
    expect(calls).toEqual(["203.0.113.5"]);
    // A failed lookup is cached briefly, then retried.
    expect(geo.get("203.0.113.5")).toBeNull();
    expect(calls).toHaveLength(1);
    fail = false;
    await new Promise((resolve) => setTimeout(resolve, 40));
    geo.get("203.0.113.5");
    await waitFor(() => resolved === 2);
    expect(geo.get("203.0.113.5")).toMatchObject({ country: "Netherlands" });
    expect(calls).toHaveLength(2);
    enabled = false;
    expect(geo.get("203.0.113.5")).toBeNull();
    expect(geo.get("198.51.100.1")).toBeNull();
    expect(calls).toHaveLength(2);
  });
});

describe("Plex bandwidth statistics", () => {
  it("averages the last 30 seconds of LAN and WAN bytes and reports zero when nothing is recent", () => {
    const now = 1_800_000_000;
    const data = { MediaContainer: { StatisticsBandwidth: [
      { at: now - 6, lan: true, bytes: 6_000_000 }, { at: now - 12, lan: true, bytes: 6_000_000 }, { at: now - 6, lan: false, bytes: 1_200_000 }, { at: now - 500, lan: false, bytes: 1e12 }
    ] } };
    // Two 6-second intervals: 12 MB LAN and 1.2 MB WAN over 12 seconds.
    expect(plexBandwidthRate(data, now)).toEqual({ lanBps: 1_000_000, wanBps: 100_000 });
    expect(plexBandwidthRate({ MediaContainer: { StatisticsBandwidth: [{ at: now - 120, lan: true, bytes: 5 }] } }, now)).toEqual({ lanBps: 0, wanBps: 0 });
    expect(plexBandwidthRate({ nope: true }, now)).toBeNull();
  });
});
