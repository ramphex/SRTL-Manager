import fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";

// Mocked plex.tv, Plex Media Server, and Jellyfin APIs for watch sync tests. No real server is contacted.

export interface MockItem {
  plexKey: string;
  jellyfinId: string;
  type: "movie" | "episode";
  title: string;
  plexFile: string;
  jellyfinPath: string;
  addedAt: number;
}

export interface PlexUserData { viewCount: number; viewOffset: number; lastViewedAt?: number }
export interface JellyfinUserData { played: boolean; positionTicks: number; lastPlayed: string | null; savedAt: number }

export interface MockJellyfin {
  apiKey: string;
  offline: boolean;
  legacyOnly: boolean;
  users: Array<{ id: string; name: string; disabled?: boolean }>;
  data: Map<string, Map<string, JellyfinUserData>>;
  itemSavedAt: Map<string, number>;
}

export interface MockWrite { server: string; action: string; item: string; user: string; value?: number | string | null }

export class MockMediaServers {
  app: FastifyInstance = fastify();
  base = "";
  items: MockItem[] = [];
  plexOffline = false;
  plexHistoryFails = false;
  pinPolls = 0;
  pinAuthorizedAfter = 2;
  ownerToken = "owner-token-abc";
  plexTokens = new Map<string, string>([["owner-token-abc", "1"], ["tok-bob", "200"], ["tok-kids", "300"], ["tok-partner", "400"]]);
  plexData = new Map<string, Map<string, PlexUserData>>();
  plexHistory: Array<{ ratingKey: string; accountID: string; viewedAt: number }> = [];
  jellyfin = new Map<string, MockJellyfin>();
  writes: MockWrite[] = [];
  requests: string[] = [];

  async start(): Promise<void> {
    this.app.all("/*", (request, reply) => this.handle(request, reply));
    await this.app.listen({ host: "127.0.0.1", port: 0 });
    const address = this.app.server.address();
    if (!address || typeof address === "string") throw new Error("mock server did not bind");
    this.base = `http://127.0.0.1:${address.port}`;
  }

  async stop(): Promise<void> {
    await this.app.close();
  }

  addJellyfin(name: string, options: Partial<MockJellyfin> = {}): MockJellyfin {
    const server: MockJellyfin = { apiKey: `${name}-key`, offline: false, legacyOnly: false, users: [], data: new Map(), itemSavedAt: new Map(), ...options };
    this.jellyfin.set(name, server);
    return server;
  }

  plexUser(token: string): Map<string, PlexUserData> {
    let data = this.plexData.get(token);
    if (!data) { data = new Map(); this.plexData.set(token, data); }
    return data;
  }

  jellyfinUser(server: string, userId: string): Map<string, JellyfinUserData> {
    const mock = this.jellyfin.get(server)!;
    let data = mock.data.get(userId);
    if (!data) { data = new Map(); mock.data.set(userId, data); }
    return data;
  }

  setPlex(token: string, plexKey: string, state: { watched?: boolean; offsetMs?: number; at?: Date }): void {
    const at = Math.floor((state.at ?? new Date()).getTime() / 1000);
    this.plexUser(token).set(plexKey, { viewCount: state.watched ? 1 : 0, viewOffset: state.offsetMs ?? 0, lastViewedAt: at });
  }

  setJellyfin(server: string, userId: string, jellyfinId: string, state: { watched?: boolean; offsetMs?: number; at?: Date | null }): void {
    const at = state.at === null ? null : (state.at ?? new Date()).toISOString();
    this.jellyfinUser(server, userId).set(jellyfinId, { played: state.watched === true, positionTicks: (state.offsetMs ?? 0) * 10_000, lastPlayed: at, savedAt: Date.now() });
  }

  plexState(token: string, plexKey: string) {
    const data = this.plexUser(token).get(plexKey);
    return { watched: (data?.viewCount ?? 0) > 0, offsetMs: data?.viewOffset ?? 0 };
  }

  jellyfinState(server: string, userId: string, jellyfinId: string) {
    const data = this.jellyfinUser(server, userId).get(jellyfinId);
    return { watched: data?.played ?? false, offsetMs: (data?.positionTicks ?? 0) / 10_000 };
  }

  private handle(request: FastifyRequest, reply: FastifyReply) {
    const url = new URL(request.url, "http://mock");
    this.requests.push(`${request.method} ${request.url}`);
    const [, prefix, ...rest] = url.pathname.split("/");
    const route = `/${rest.join("/")}`;
    if (prefix === "plextv") return this.plexTv(request, reply, route);
    if (prefix === "pms") return this.pms(request, reply, route, url);
    const jellyfin = this.jellyfin.get(prefix ?? "");
    if (jellyfin) return this.handleJellyfin(jellyfin, prefix!, request, reply, route, url);
    return reply.code(404).send({ error: "unknown" });
  }

  private plexTv(request: FastifyRequest, reply: FastifyReply, route: string) {
    if (!request.headers["x-plex-client-identifier"]) return reply.code(400).send({ error: "client identifier required" });
    if (request.headers["x-plex-provides"]) return reply.code(400).send({ error: "SRTL must not claim to provide anything" });
    if (request.method === "POST" && route === "/api/v2/pins") return { id: 77, code: "WXYZ", expiresAt: new Date(Date.now() + 900_000).toISOString(), authToken: null };
    if (route === "/api/v2/pins/77") {
      this.pinPolls += 1;
      return { id: 77, code: "WXYZ", expiresAt: new Date(Date.now() + 900_000).toISOString(), authToken: this.pinPolls >= this.pinAuthorizedAfter ? this.ownerToken : null };
    }
    if (request.headers["x-plex-token"] !== this.ownerToken) return reply.code(401).send("unauthorized");
    if (route === "/api/v2/user") return { id: 100, uuid: "owner-uuid", username: "alex_03", title: "alex_03", email: "owner@example.invalid" };
    if (route === "/api/users") {
      return reply.type("application/xml").send(`<?xml version="1.0" encoding="UTF-8"?>
<MediaContainer friendlyName="myPlex" identifier="com.plexapp.plugins.myplex" size="5">
  <User id="200" title="Friend.Bob" username="friendbob" email="bob@example.invalid" home="0" restricted="0">
    <Server id="1" serverId="9" machineIdentifier="machine-1" name="Home" lastSeenAt="1" numLibraries="2" allLibraries="1" owned="1" pending="0"/>
  </User>
  <User id="300" title="Kids &amp; Co" username="" email="" home="1" restricted="1">
    <Server id="2" serverId="9" machineIdentifier="machine-1" name="Home" owned="1"/>
  </User>
  <User id="400" title="Partner" username="partner" home="1" restricted="0"/>
  <User id="500" title="NoShare" username="noshare" home="0" restricted="0">
    <Server id="3" serverId="9" machineIdentifier="machine-1" name="Home" owned="1"/>
  </User>
  <User id="600" title="Elsewhere" username="elsewhere" home="0" restricted="0">
    <Server id="4" serverId="8" machineIdentifier="machine-other" name="Other" owned="1"/>
  </User>
</MediaContainer>`);
    }
    if (route === "/api/servers/machine-1/shared_servers") {
      return reply.type("application/xml").send(`<MediaContainer size="3">
  <SharedServer id="1" username="friendbob" email="bob@example.invalid" userID="200" accessToken="tok-bob" name="Home" acceptedAt="1" invitedAt="1" allowSync="0" owned="0"><Section id="1" key="1" title="Movies" type="movie" shared="1"/></SharedServer>
  <SharedServer id="2" username="" userID="300" accessToken="tok-kids" name="Home"/>
  <SharedServer id="3" username="partner" userID="400" accessToken="tok-partner" name="Home"/>
</MediaContainer>`);
    }
    return reply.code(404).send({ error: "unknown plex.tv route" });
  }

  private plexMetadata(token: string, item: MockItem) {
    const data = this.plexUser(token).get(item.plexKey);
    return {
      ratingKey: item.plexKey,
      type: item.type,
      title: item.title,
      ...(item.type === "episode" ? { grandparentTitle: "Show", parentIndex: 1, index: Number(item.plexKey.slice(-1)) } : {}),
      addedAt: item.addedAt,
      ...(data?.viewCount ? { viewCount: data.viewCount } : {}),
      ...(data?.viewOffset ? { viewOffset: data.viewOffset } : {}),
      ...(data?.lastViewedAt ? { lastViewedAt: data.lastViewedAt } : {}),
      Media: [{ Part: [{ file: item.plexFile }] }]
    };
  }

  private pms(request: FastifyRequest, reply: FastifyReply, route: string, url: URL) {
    if (this.plexOffline) return reply.code(503).send({ error: "offline" });
    const token = String(request.headers["x-plex-token"] ?? "");
    if (!this.plexTokens.has(token)) return reply.code(401).send({ error: "bad token" });
    const user = token;
    if (route === "/identity") return { MediaContainer: { machineIdentifier: "machine-1", version: "1.43.0" } };
    if (route === "/library/sections") return { MediaContainer: { Directory: [{ key: "1", type: "movie", title: "Movies" }, { key: "2", type: "show", title: "TV" }, { key: "3", type: "artist", title: "Music" }] } };
    const section = route.match(/^\/library\/sections\/(\d+)\/all$/);
    if (section) {
      const type = url.searchParams.get("type") === "1" ? "movie" : "episode";
      const start = Number(url.searchParams.get("X-Plex-Container-Start") ?? 0);
      const size = Number(url.searchParams.get("X-Plex-Container-Size") ?? 50);
      const viewedSince = url.searchParams.get("lastViewedAt>>");
      const addedSince = url.searchParams.get("addedAt>>");
      const matching = this.items.filter((item) => item.type === type && (section[1] === "1") === (type === "movie"))
        .filter((item) => viewedSince === null || (this.plexUser(user).get(item.plexKey)?.lastViewedAt ?? 0) >= Number(viewedSince))
        .filter((item) => addedSince === null || item.addedAt >= Number(addedSince));
      return { MediaContainer: { totalSize: matching.length, size: Math.min(size, Math.max(0, matching.length - start)), Metadata: matching.slice(start, start + size).map((item) => this.plexMetadata(user, item)) } };
    }
    const metadata = route.match(/^\/library\/metadata\/([^/]+)$/);
    if (metadata) {
      const keys = decodeURIComponent(metadata[1]!).split(",");
      const found = keys.map((key) => this.items.find((item) => item.plexKey === key)).filter((item): item is MockItem => Boolean(item));
      if (found.length !== keys.length) return reply.code(404).send({ error: "missing" });
      return { MediaContainer: { size: found.length, Metadata: found.map((item) => this.plexMetadata(user, item)) } };
    }
    if (route === "/library/onDeck") {
      const inProgress = this.items.filter((item) => (this.plexUser(user).get(item.plexKey)?.viewOffset ?? 0) > 0);
      return { MediaContainer: { size: inProgress.length, Metadata: inProgress.map((item) => this.plexMetadata(user, item)) } };
    }
    if (route === "/status/sessions/history/all") {
      if (this.plexHistoryFails || token !== this.ownerToken) return reply.code(500).send({ error: "history failed" });
      const since = Number(url.searchParams.get("viewedAt>") ?? 0);
      const entries = this.plexHistory.filter((entry) => entry.viewedAt >= since);
      return { MediaContainer: { size: entries.length, Metadata: entries } };
    }
    const key = url.searchParams.get("key") ?? "";
    const data = this.plexUser(user);
    const now = Math.floor(Date.now() / 1000);
    if (route === "/:/scrobble") {
      data.set(key, { viewCount: (data.get(key)?.viewCount ?? 0) + 1, viewOffset: 0, lastViewedAt: now });
      this.writes.push({ server: "plex", action: "scrobble", item: key, user: this.plexTokens.get(token)! });
      return reply.send("");
    }
    if (route === "/:/unscrobble") {
      data.set(key, { viewCount: 0, viewOffset: 0, lastViewedAt: data.get(key)?.lastViewedAt });
      this.writes.push({ server: "plex", action: "unscrobble", item: key, user: this.plexTokens.get(token)! });
      return reply.send("");
    }
    if (route === "/:/progress") {
      const time = Number(url.searchParams.get("time"));
      data.set(key, { viewCount: data.get(key)?.viewCount ?? 0, viewOffset: time, lastViewedAt: now });
      this.writes.push({ server: "plex", action: "progress", item: key, user: this.plexTokens.get(token)!, value: time });
      return reply.send("");
    }
    return reply.code(404).send({ error: "unknown pms route" });
  }

  private jellyfinItem(item: MockItem, data: JellyfinUserData | undefined) {
    return {
      Id: item.jellyfinId,
      Type: item.type === "movie" ? "Movie" : "Episode",
      Name: item.title,
      ...(item.type === "episode" ? { SeriesName: "Show", ParentIndexNumber: 1, IndexNumber: Number(item.plexKey.slice(-1)) } : {}),
      Path: item.jellyfinPath,
      UserData: { Played: data?.played ?? false, PlaybackPositionTicks: data?.positionTicks ?? 0, ...(data?.lastPlayed ? { LastPlayedDate: data.lastPlayed } : {}) }
    };
  }

  private handleJellyfin(server: MockJellyfin, name: string, request: FastifyRequest, reply: FastifyReply, route: string, url: URL) {
    if (server.offline) return reply.code(503).send({ error: "offline" });
    if (!String(request.headers.authorization ?? "").includes(`Token="${server.apiKey}"`)) return reply.code(401).send({ error: "bad key" });
    if (route === "/System/Info") return { ServerName: name, Version: "10.10.0" };
    if (route === "/Users") return server.users.map((user) => ({ Id: user.id, Name: user.name, Policy: { IsDisabled: user.disabled === true } }));
    if (route === "/Items") {
      const userId = url.searchParams.get("userId") ?? "";
      const start = Number(url.searchParams.get("StartIndex") ?? 0);
      const limit = Number(url.searchParams.get("Limit") ?? 100);
      const savedForUser = url.searchParams.get("MinDateLastSavedForUser");
      const saved = url.searchParams.get("MinDateLastSaved");
      const ids = url.searchParams.get("Ids")?.split(",");
      const data = this.jellyfinUser(name, userId);
      const matching = this.items.filter((item) => !ids || ids.includes(item.jellyfinId))
        .filter((item) => savedForUser === null || (data.get(item.jellyfinId)?.savedAt ?? 0) >= Date.parse(savedForUser))
        .filter((item) => saved === null || (server.itemSavedAt.get(item.jellyfinId) ?? item.addedAt * 1000) >= Date.parse(saved));
      return { Items: matching.slice(start, start + limit).map((item) => this.jellyfinItem(item, data.get(item.jellyfinId))), TotalRecordCount: matching.length };
    }
    const modern = route.match(/^\/(UserPlayedItems|UserItems)\/([^/]+)(\/UserData)?$/);
    const legacy = route.match(/^\/Users\/([^/]+)\/(PlayedItems|Items)\/([^/]+)(\/UserData)?$/);
    if (modern && server.legacyOnly) return reply.code(404).send({ error: "not found" });
    if (!modern && !legacy) return reply.code(404).send({ error: "unknown jellyfin route" });
    const userId = modern ? url.searchParams.get("userId") ?? "" : legacy![1]!;
    const itemId = modern ? modern[2]! : legacy![3]!;
    const kind = modern ? (modern[1] === "UserPlayedItems" ? "played" : "userdata") : (legacy![2] === "PlayedItems" ? "played" : "userdata");
    const data = this.jellyfinUser(name, userId);
    const current = data.get(itemId);
    if (kind === "played" && request.method === "POST") {
      const date = url.searchParams.get("datePlayed");
      data.set(itemId, { played: true, positionTicks: 0, lastPlayed: date ?? new Date().toISOString(), savedAt: Date.now() });
      this.writes.push({ server: name, action: "played", item: itemId, user: userId, value: date });
      return reply.send({});
    }
    if (kind === "played" && request.method === "DELETE") {
      data.set(itemId, { played: false, positionTicks: 0, lastPlayed: null, savedAt: Date.now() });
      this.writes.push({ server: name, action: "unplayed", item: itemId, user: userId });
      return reply.send({});
    }
    if (kind === "userdata" && request.method === "POST") {
      const body = request.body as { PlaybackPositionTicks?: number; Played?: boolean; LastPlayedDate?: string };
      data.set(itemId, { played: body.Played ?? current?.played ?? false, positionTicks: body.PlaybackPositionTicks ?? 0, lastPlayed: body.LastPlayedDate ?? current?.lastPlayed ?? null, savedAt: Date.now() });
      this.writes.push({ server: name, action: "position", item: itemId, user: userId, value: (body.PlaybackPositionTicks ?? 0) / 10_000 });
      return reply.send({});
    }
    return reply.code(405).send({ error: "method" });
  }
}
