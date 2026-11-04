import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { NowPlayingSettings } from "../../shared/nowPlaying";
import { onAccountChanged } from "../accounts";
import { assertSessionActive } from "../auth";
import { defaultNowPlayingStreamLimits, type NowPlayingStreamLimits } from "../config";
import { getJsonSetting, setSetting, type Db } from "../db/database";
import { recordActionAudit } from "../lib/actionAudit";
import { loadMediaServers, mediaServerClientIdentifier, mediaServerIdSchema } from "../lib/mediaServers";
import { NowPlayingHub, type NowPlayingEvent } from "../lib/nowPlaying/hub";
import { SourceResolver } from "../lib/nowPlaying/sourceResolver";
import { isRestrictedRequest, loadSensitiveRoots, scrubValue, type RestrictedViewRuntime, type SensitiveRoot } from "../lib/restrictedView";

const settingKey = "nowPlaying";
const defaultSettings: NowPlayingSettings = { geoLookup: true };
const settingsSchema = z.object({ geoLookup: z.boolean() });
const stopSchema = z.object({
  serverId: mediaServerIdSchema,
  sessionKey: z.string().min(1).max(200),
  message: z.string().trim().max(250, "Keep the message under 250 characters.")
});
const posterParams = z.object({ key: z.string().regex(/^[A-Za-z0-9_-]{32}$/) });

export async function loadNowPlayingSettings(db: Db): Promise<NowPlayingSettings> {
  const saved = await getJsonSetting<Partial<NowPlayingSettings>>(db, settingKey, {});
  return { geoLookup: typeof saved.geoLookup === "boolean" ? saved.geoLookup : defaultSettings.geoLookup };
}

export interface NowPlayingRouteOptions {
  limits?: Partial<NowPlayingStreamLimits>;
  restrictedView?: RestrictedViewRuntime;
}

// Live sessions over server-sent events. Upstream connections exist only while a browser holds this stream open.
// Each stream belongs to the session that opened it: it closes once that session signs out or expires, and the
// number of open streams is capped per session and overall.
export function registerNowPlayingRoutes(app: FastifyInstance, db: Db, options: NowPlayingRouteOptions = {}): NowPlayingHub {
  const limits = { ...defaultNowPlayingStreamLimits, ...options.limits };
  const resolver = new SourceResolver(db);
  const hub = new NowPlayingHub({
    loadServers: () => loadMediaServers(db),
    clientIdentifier: () => mediaServerClientIdentifier(db),
    loadSettings: () => loadNowPlayingSettings(db),
    resolveSource: (serverId, mappings, filePath) => resolver.resolve(serverId, mappings, filePath),
    onError: (message) => app.log.warn(message)
  });
  const openStreams = new Map<string, Set<() => void>>();
  const streamsByUser = new Map<number, Set<() => void>>();
  let openStreamCount = 0;
  // A changed account loses its streams at once; the browser's reconnect then goes through the guard as the account now is.
  const stopListening = onAccountChanged((userId) => {
    for (const close of [...(streamsByUser.get(userId) ?? [])]) close();
  });
  app.addHook("onClose", async () => {
    stopListening();
    for (const streams of [...openStreams.values()]) for (const close of [...streams]) close();
    hub.close();
  });

  app.get("/api/now-playing/events", async (request, reply) => {
    // The route guard has already accepted this session; the stream keeps checking it.
    const session = request.adminSession;
    if (!session) return reply.code(401).send({ error: "Authentication required" });
    const sessionKey = session.tokenHash;
    const sessionStreams = openStreams.get(sessionKey) ?? new Set<() => void>();
    if (sessionStreams.size >= limits.perSession) {
      return reply.code(429).header("Retry-After", "10").send({ error: `Now Playing is already open in ${limits.perSession} tabs for this sign-in. Close one and try again.` });
    }
    if (openStreamCount >= limits.total) {
      return reply.code(429).header("Retry-After", "10").send({ error: "Too many Now Playing streams are open. Try again shortly." });
    }
    // Fixed for the stream's life: any change to the account closes it.
    const restrictedRoots: readonly SensitiveRoot[] | null = isRestrictedRequest(request) && options.restrictedView ? await loadSensitiveRoots(db, options.restrictedView) : null;
    reply.hijack();
    const response = reply.raw;
    response.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no"
    });
    response.write("retry: 5000\n\n");
    let closed = false;
    let unsubscribe: () => void = () => undefined;
    const close = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      clearInterval(revalidate);
      unsubscribe();
      sessionStreams.delete(close);
      if (sessionStreams.size === 0 && openStreams.get(sessionKey) === sessionStreams) openStreams.delete(sessionKey);
      userStreams.delete(close);
      if (userStreams.size === 0 && streamsByUser.get(session.userId) === userStreams) streamsByUser.delete(session.userId);
      openStreamCount -= 1;
      if (!response.writableEnded) response.end();
    };
    const userStreams = streamsByUser.get(session.userId) ?? new Set<() => void>();
    sessionStreams.add(close);
    openStreams.set(sessionKey, sessionStreams);
    userStreams.add(close);
    streamsByUser.set(session.userId, userStreams);
    openStreamCount += 1;
    const heartbeat = setInterval(() => write(": keep-alive\n\n"), 20_000);
    // A signed-out, expired or revoked session loses the stream; the browser's reconnect then gets a 401.
    let checking = false;
    const revalidate = setInterval(() => {
      if (checking || closed) return;
      checking = true;
      assertSessionActive(db, sessionKey)
        .then((current) => { if (current.role !== session.role) close(); })
        .catch(() => close())
        .finally(() => { checking = false; });
    }, limits.revalidateMs);
    function write(chunk: string) {
      if (closed) return;
      // A browser that stops reading is dropped rather than buffered without limit; it reconnects on its own.
      if (response.writableLength > 2 * 1024 * 1024) {
        close();
        response.destroy();
        return;
      }
      response.write(chunk);
    }
    response.on("close", close);
    request.raw.socket?.setKeepAlive?.(true);
    unsubscribe = hub.subscribe((event: NowPlayingEvent) => {
      const data = event.type === "sessions" ? event.snapshot : event.host;
      write(`event: ${event.type}\ndata: ${JSON.stringify(restrictedRoots ? scrubValue(data, restrictedRoots) : data)}\n\n`);
    });
  });

  app.get("/api/now-playing/poster/:key", { config: { rateLimit: { max: 600, timeWindow: "1 minute" } } }, async (request, reply) => {
    const { key } = posterParams.parse(request.params);
    const found = hub.posterSource(key);
    if (!found) return reply.code(404).send({ error: "Artwork is no longer available." });
    try {
      const poster = await found.adapter.fetchPoster(found.source.path);
      if (!/^image\/[a-z0-9.+-]+$/i.test(poster.contentType.split(";")[0]!.trim())) return reply.code(502).send({ error: "The media server returned no image." });
      return reply.header("Cache-Control", "private, max-age=3600").type(poster.contentType).send(poster.body);
    } catch {
      return reply.code(502).send({ error: "The media server did not return the artwork." });
    }
  });

  app.post("/api/now-playing/stop", { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (request) => {
    const body = stopSchema.parse(request.body);
    const result = await hub.stopStream(body.serverId, body.sessionKey, body.message);
    // The viewer's name and the message text are not recorded; the server and session identify the stream.
    await recordActionAudit(db, request, {
      action: "now_playing.stop_stream",
      summary: "Stopped a Now Playing stream",
      targets: { serverId: body.serverId, sessionKey: body.sessionKey, result: result.result }
    });
    return result;
  });

  app.get("/api/now-playing/settings", async () => loadNowPlayingSettings(db));
  app.put("/api/now-playing/settings", async (request) => {
    const settings = settingsSchema.parse(request.body);
    await setSetting(db, settingKey, settings);
    hub.updateSettings(settings);
    return settings;
  });

  return hub;
}
