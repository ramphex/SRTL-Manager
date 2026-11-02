import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { NowPlayingSettings } from "../../shared/nowPlaying";
import { getJsonSetting, setSetting, type Db } from "../db/database";
import { loadMediaServers, mediaServerClientIdentifier, mediaServerIdSchema } from "../lib/mediaServers";
import { NowPlayingHub, type NowPlayingEvent } from "../lib/nowPlaying/hub";
import { SourceResolver } from "../lib/nowPlaying/sourceResolver";

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

// Live sessions over server-sent events. Upstream connections exist only while a browser holds this stream open.
export function registerNowPlayingRoutes(app: FastifyInstance, db: Db): NowPlayingHub {
  const resolver = new SourceResolver(db);
  const hub = new NowPlayingHub({
    loadServers: () => loadMediaServers(db),
    clientIdentifier: () => mediaServerClientIdentifier(db),
    loadSettings: () => loadNowPlayingSettings(db),
    resolveSource: (serverId, mappings, filePath) => resolver.resolve(serverId, mappings, filePath),
    onError: (message) => app.log.warn(message)
  });
  app.addHook("onClose", async () => hub.close());

  app.get("/api/now-playing/events", async (request, reply) => {
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
    const heartbeat = setInterval(() => write(": keep-alive\n\n"), 20_000);
    const close = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
    };
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
      write(`event: ${event.type}\ndata: ${JSON.stringify(event.type === "sessions" ? event.snapshot : event.host)}\n\n`);
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
    return hub.stopStream(body.serverId, body.sessionKey, body.message);
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
