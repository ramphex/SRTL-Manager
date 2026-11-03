import { Agent, WebSocket } from "undici";
import { z } from "zod";
import type { MediaServerKind } from "../../../shared/mediaServers";
import type { NowPlayingServerState, NowPlayingState } from "../../../shared/nowPlaying";
import { jellyfinHeaders } from "../jellyfinClient";
import { plexEndpoints, plexHeaders } from "../plexClient";
import { pinnedLookup } from "../outboundPolicy";
import { WatchSyncError, resolveAllowed, watchSyncJson, watchSyncRequest } from "../watchSyncHttp";
import { parseJellyfinSession, parsePlexSession, type ParsedSession } from "./classify";

export class NowPlayingError extends WatchSyncError {
  override readonly statusCode: number;
  constructor(message: string, httpStatus: number | null = null, statusCode = 400) {
    super(message, httpStatus);
    this.statusCode = statusCode;
  }
}

export interface LiveServerConfig {
  id: string;
  kind: MediaServerKind;
  name: string;
  url: string;
  token: string;
  clientIdentifier: string;
}

export type SocketEvent =
  | { type: "refresh"; minIntervalMs?: number }
  | { type: "progress"; sessionKey: string; positionMs: number | null; state: NowPlayingState | "stopped" };

export interface SocketHandlers {
  onEvent: (event: SocketEvent) => void;
  onClose: (reason: string) => void;
}

export interface ServerExtras {
  bandwidth?: NowPlayingServerState["bandwidth"];
  resources?: NowPlayingServerState["resources"];
}

// Everything Now Playing asks of one media server. Tests substitute their own.
export interface LiveAdapter {
  fetchSessions(signal: AbortSignal): Promise<ParsedSession[]>;
  // Resolves once the socket is open; the returned function closes it. Rejects when no socket can be opened.
  openSocket(handlers: SocketHandlers): Promise<() => void>;
  fetchExtras?(signal: AbortSignal): Promise<ServerExtras>;
  stopStream(session: ParsedSession, message: string): Promise<void>;
  fetchPoster(path: string): Promise<{ contentType: string; body: Buffer }>;
  // Forgets per-item caches for items no longer playing.
  prune?(activeSessions: ParsedSession[]): void;
}

const sessionTimeoutMs = 8000;
const socketOpenTimeoutMs = 10_000;
const posterMaxBytes = 5 * 1024 * 1024;

export function socketUrl(baseUrl: string, path: string, query: Record<string, string>): string {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `${url.pathname.replace(/\/+$/, "")}${path}`;
  url.search = new URLSearchParams(query).toString();
  return url.toString();
}

export interface SocketAttempt { url: string; headers?: Record<string, string> }

// Tries each way of authenticating in turn: headers first, then the token in the query string that some servers
// expect. The socket host is checked against the same address rules as every other media server request, and the
// socket connects to the checked address: the host is never looked up a second time.
async function openWebSocket(attempts: SocketAttempt[], service: string, handlers: SocketHandlers, onOpen: (socket: WebSocket) => void, onMessage: (data: string, socket: WebSocket) => void): Promise<() => void> {
  let lastError: unknown = new NowPlayingError(`${service} socket could not be opened.`);
  for (const attempt of attempts) {
    try {
      return await openWebSocketOnce(attempt, service, handlers, onOpen, onMessage);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

async function openWebSocketOnce(attempt: SocketAttempt, service: string, handlers: SocketHandlers, onOpen: (socket: WebSocket) => void, onMessage: (data: string, socket: WebSocket) => void): Promise<() => void> {
  const address = await resolveAllowed(new URL(attempt.url).hostname, service);
  // TLS still verifies the certificate against the host name; only the address lookup is fixed.
  const dispatcher = new Agent({ connect: { lookup: pinnedLookup(address) } });
  const release = () => { void dispatcher.destroy().catch(() => undefined); };
  return new Promise((resolve, reject) => {
    let opened = false;
    let closed = false;
    let socket: WebSocket;
    try {
      socket = new WebSocket(attempt.url, { dispatcher, ...(attempt.headers ? { headers: attempt.headers } : {}) });
    } catch {
      release();
      reject(new NowPlayingError(`${service} socket could not be opened.`));
      return;
    }
    const timer = setTimeout(() => {
      if (opened) return;
      closed = true;
      socket.close();
      reject(new NowPlayingError(`${service} socket did not open in time.`));
    }, socketOpenTimeoutMs);
    const close = () => {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      try { socket.close(); } catch { /* already closed */ }
    };
    socket.addEventListener("open", () => {
      opened = true;
      clearTimeout(timer);
      onOpen(socket);
      resolve(close);
    });
    socket.addEventListener("message", (event) => {
      if (typeof event.data === "string") onMessage(event.data, socket);
    });
    socket.addEventListener("error", () => {
      if (!opened) {
        closed = true;
        clearTimeout(timer);
        reject(new NowPlayingError(`${service} socket could not be opened.`));
      }
    });
    socket.addEventListener("close", () => {
      clearTimeout(timer);
      release();
      if (!opened) {
        if (!closed) reject(new NowPlayingError(`${service} socket closed before it opened.`));
        closed = true;
        return;
      }
      const wasClosedHere = closed;
      closed = true;
      if (!wasClosedHere) handlers.onClose(`${service} socket closed.`);
    });
  });
}

function statusMessage(error: unknown, messages: Partial<Record<number, string>>): never {
  if (error instanceof WatchSyncError && error.httpStatus !== null && messages[error.httpStatus]) {
    throw new NowPlayingError(messages[error.httpStatus]!, error.httpStatus);
  }
  throw error;
}

// ---------------------------------------------------------------- Plex

const plexThumbPattern = /^\/library\/metadata\/\d+\/(?:thumb|art|grandparentThumb|parentThumb)(?:\/\d+)?$/;

export function plexPosterAllowed(path: string): boolean {
  return plexThumbPattern.test(path);
}

const bandwidthSchema = z.object({ at: z.number(), lan: z.union([z.boolean(), z.number(), z.string()]).optional(), bytes: z.number() }).loose();
const resourcesSchema = z.object({
  at: z.number(),
  hostCpuUtilization: z.number().optional(),
  processCpuUtilization: z.number().optional(),
  hostMemoryUtilization: z.number().optional(),
  processMemoryUtilization: z.number().optional()
}).loose();

// /statistics/bandwidth lists bytes per device and interval. The rate is the bytes of the last 30 seconds of
// reports over the time they cover; nothing reported in the last 30 seconds means nothing is streaming.
export function plexBandwidthRate(raw: unknown, nowSeconds: number): { lanBps: number; wanBps: number } | null {
  const entries = (raw && typeof raw === "object" ? (raw as { MediaContainer?: { StatisticsBandwidth?: unknown } }).MediaContainer?.StatisticsBandwidth : null);
  if (!Array.isArray(entries)) return null;
  const parsed = entries.flatMap((entry) => {
    const result = bandwidthSchema.safeParse(entry);
    return result.success ? [result.data] : [];
  });
  if (!parsed.length) return { lanBps: 0, wanBps: 0 };
  const latest = Math.max(...parsed.map((entry) => entry.at));
  if (latest < nowSeconds - 30) return { lanBps: 0, wanBps: 0 };
  const recent = parsed.filter((entry) => entry.at > latest - 30);
  const times = [...new Set(recent.map((entry) => entry.at))].sort((a, b) => a - b);
  const steps = times.slice(1).map((time, index) => time - times[index]!).filter((step) => step > 0);
  const step = steps.length ? Math.min(...steps) : 1;
  const seconds = Math.max(1, times[times.length - 1]! - times[0]! + step);
  let lan = 0;
  let wan = 0;
  for (const entry of recent) {
    const isLan = entry.lan === true || entry.lan === 1 || entry.lan === "1" || entry.lan === "true";
    if (isLan) lan += entry.bytes;
    else wan += entry.bytes;
  }
  return { lanBps: Math.round(lan / seconds), wanBps: Math.round(wan / seconds) };
}

export function plexResources(raw: unknown): NowPlayingServerState["resources"] {
  const entries = (raw && typeof raw === "object" ? (raw as { MediaContainer?: { StatisticsResources?: unknown } }).MediaContainer?.StatisticsResources : null);
  if (!Array.isArray(entries)) return null;
  const latest = entries.flatMap((entry) => {
    const result = resourcesSchema.safeParse(entry);
    return result.success ? [result.data] : [];
  }).sort((a, b) => b.at - a.at)[0];
  if (!latest) return null;
  const round = (value: number | undefined) => value === undefined ? null : Math.round(value * 10) / 10;
  return { hostCpu: round(latest.hostCpuUtilization), processCpu: round(latest.processCpuUtilization), hostMemory: round(latest.hostMemoryUtilization), processMemory: round(latest.processMemoryUtilization) };
}

export class PlexLiveAdapter implements LiveAdapter {
  private readonly metadata = new Map<string, { value: unknown; fetchedAt: number }>();
  private statisticsDisabledUntil = 0;

  constructor(private readonly config: LiveServerConfig) {}

  private headers(): Record<string, string> {
    return plexHeaders(this.config.clientIdentifier, this.config.token);
  }

  private get(path: string, signal?: AbortSignal, timeoutMs = sessionTimeoutMs) {
    return watchSyncJson({ url: `${this.config.url}${path}`, service: "Plex", headers: this.headers(), timeoutMs, retries: 0, signal, maxBytes: 16 * 1024 * 1024 });
  }

  // The library entry of each playing item describes its original file (codec, HDR, path). It is read once
  // per item and kept while the item plays.
  private async sourceMetadata(ratingKeys: string[], signal: AbortSignal): Promise<void> {
    const now = Date.now();
    const missing = [...new Set(ratingKeys)].filter((key) => /^\d+$/.test(key) && (this.metadata.get(key)?.fetchedAt ?? 0) < now - 10 * 60_000);
    if (!missing.length) return;
    try {
      const { data } = await this.get(`/library/metadata/${missing.join(",")}`, signal);
      const items = (data as { MediaContainer?: { Metadata?: unknown } } | null)?.MediaContainer?.Metadata;
      for (const item of Array.isArray(items) ? items : []) {
        const key = (item as { ratingKey?: unknown }).ratingKey;
        if (key !== undefined) this.metadata.set(String(key), { value: item, fetchedAt: now });
      }
    } catch {
      // Without it, the card shows what the session itself reports.
    }
    for (const key of missing) if (!this.metadata.has(key)) this.metadata.set(key, { value: null, fetchedAt: now });
  }

  async fetchSessions(signal: AbortSignal): Promise<ParsedSession[]> {
    const { data } = await this.get("/status/sessions", signal);
    const container = (data as { MediaContainer?: { Metadata?: unknown } } | null)?.MediaContainer;
    if (!container || typeof container !== "object") throw new NowPlayingError("Plex returned an unsupported sessions response.");
    const items = Array.isArray(container.Metadata) ? container.Metadata : [];
    const keys = items.map((item) => String((item as { ratingKey?: unknown }).ratingKey ?? ""));
    await this.sourceMetadata(keys, signal);
    const now = new Date();
    return items.flatMap((item, index) => {
      const parsed = parsePlexSession(item, this.metadata.get(keys[index]!)?.value ?? null, now);
      return parsed ? [parsed] : [];
    });
  }

  prune(activeSessions: ParsedSession[]): void {
    const active = new Set(activeSessions.map((session) => session.itemKey).filter(Boolean));
    for (const key of this.metadata.keys()) if (!active.has(key)) this.metadata.delete(key);
  }

  async openSocket(handlers: SocketHandlers): Promise<() => void> {
    const attempts = [
      { url: socketUrl(this.config.url, "/:/websockets/notifications", {}), headers: this.headers() },
      { url: socketUrl(this.config.url, "/:/websockets/notifications", { "X-Plex-Token": this.config.token }) }
    ];
    return openWebSocket(attempts, "Plex", handlers, () => undefined, (data) => {
      let message: { NotificationContainer?: { type?: unknown; PlaySessionStateNotification?: unknown } };
      try { message = JSON.parse(data) as typeof message; } catch { return; }
      const container = message.NotificationContainer;
      if (!container) return;
      if (container.type === "playing" && Array.isArray(container.PlaySessionStateNotification)) {
        for (const entry of container.PlaySessionStateNotification as Array<{ sessionKey?: unknown; state?: unknown; viewOffset?: unknown }>) {
          if (entry.sessionKey === undefined) continue;
          const state = entry.state === "paused" || entry.state === "buffering" || entry.state === "stopped" ? entry.state : "playing";
          handlers.onEvent({ type: "progress", sessionKey: String(entry.sessionKey), positionMs: typeof entry.viewOffset === "number" ? entry.viewOffset : null, state });
        }
      } else if (typeof container.type === "string" && container.type.startsWith("transcodeSession.")) {
        // Speed and throttling change continuously; picking them up every 10 seconds is enough.
        handlers.onEvent({ type: "refresh", minIntervalMs: container.type === "transcodeSession.update" ? 10_000 : 0 });
      }
    });
  }

  // Both statistics endpoints need Plex Pass. When Plex refuses them, SRTL stops asking for a while.
  async fetchExtras(signal: AbortSignal): Promise<ServerExtras> {
    if (Date.now() < this.statisticsDisabledUntil) return {};
    try {
      const [bandwidth, resources] = await Promise.all([
        this.get("/statistics/bandwidth?timespan=6", signal, 5000),
        this.get("/statistics/resources?timespan=6", signal, 5000)
      ]);
      const nowSeconds = (bandwidth.serverTime ?? new Date()).getTime() / 1000;
      return { bandwidth: plexBandwidthRate(bandwidth.data, nowSeconds), resources: plexResources(resources.data) };
    } catch (error) {
      if (error instanceof WatchSyncError && error.httpStatus !== null && error.httpStatus >= 400 && error.httpStatus < 500) this.statisticsDisabledUntil = Date.now() + 10 * 60_000;
      return {};
    }
  }

  async stopStream(session: ParsedSession, message: string): Promise<void> {
    if (!session.terminateId) throw new NowPlayingError("This Plex player does not report a session id, so Plex cannot stop it remotely.");
    const path = `/status/sessions/terminate?sessionId=${encodeURIComponent(session.terminateId)}&reason=${encodeURIComponent(message)}`;
    const send = (method: "POST" | "GET") => watchSyncRequest({ url: `${this.config.url}${path}`, service: "Plex", method, headers: this.headers(), timeoutMs: sessionTimeoutMs, retries: 0 });
    try {
      try {
        await send("POST");
      } catch (error) {
        // Older servers only accept the terminate call as GET.
        if (error instanceof WatchSyncError && error.httpStatus === 405) await send("GET");
        else throw error;
      }
    } catch (error) {
      statusMessage(error, {
        401: "Plex refused to stop the stream (HTTP 401). Stopping streams needs an active Plex Pass on the server owner's account and the owner's sign-in.",
        403: "Plex refused to stop the stream (HTTP 403). Sign in with the server owner's Plex account in Settings > Media servers.",
        404: "Plex no longer has this stream (HTTP 404). It has probably ended already."
      });
    }
  }

  async fetchPoster(path: string): Promise<{ contentType: string; body: Buffer }> {
    if (!plexPosterAllowed(path)) throw new NowPlayingError("Unsupported artwork path.");
    const query = new URLSearchParams({ width: "240", height: "360", minSize: "1", upscale: "1", url: path });
    const response = await watchSyncRequest({ url: `${this.config.url}/photo/:/transcode?${query.toString()}`, service: "Plex", headers: { ...this.headers(), Accept: "image/*" }, timeoutMs: sessionTimeoutMs, retries: 0, maxBytes: posterMaxBytes });
    return { contentType: String(response.headers["content-type"] ?? ""), body: response.buffer };
  }
}

// ---------------------------------------------------------------- Jellyfin

export class JellyfinLiveAdapter implements LiveAdapter {
  constructor(private readonly config: LiveServerConfig) {}

  private headers(): Record<string, string> {
    return jellyfinHeaders(this.config.token, this.config.clientIdentifier);
  }

  async fetchSessions(signal: AbortSignal): Promise<ParsedSession[]> {
    const { data } = await watchSyncJson({ url: `${this.config.url}/Sessions`, service: "Jellyfin", headers: this.headers(), timeoutMs: sessionTimeoutMs, retries: 0, signal, maxBytes: 16 * 1024 * 1024 });
    if (!Array.isArray(data)) throw new NowPlayingError("Jellyfin returned an unsupported sessions response.");
    return parseJellyfinSessions(data);
  }

  async openSocket(handlers: SocketHandlers): Promise<() => void> {
    const attempts = [
      { url: socketUrl(this.config.url, "/socket", { deviceId: this.config.clientIdentifier }), headers: this.headers() },
      { url: socketUrl(this.config.url, "/socket", { api_key: this.config.token, deviceId: this.config.clientIdentifier }) }
    ];
    let keepAlive: NodeJS.Timeout | null = null;
    const close = await openWebSocket(attempts, "Jellyfin", {
      onEvent: handlers.onEvent,
      onClose: (reason) => {
        if (keepAlive) clearInterval(keepAlive);
        handlers.onClose(reason);
      }
    }, (socket) => {
      // Jellyfin then pushes the session list whenever playback changes, at most every 2 seconds.
      socket.send(JSON.stringify({ MessageType: "SessionsStart", Data: "0,2000" }));
    }, (data, socket) => {
      let message: { MessageType?: unknown; Data?: unknown };
      try { message = JSON.parse(data) as typeof message; } catch { return; }
      // The pushed list may be filtered by the connection's user, which an API key does not have, so it only
      // signals a change; the session list itself always comes from /Sessions.
      if (message.MessageType === "Sessions") {
        handlers.onEvent({ type: "refresh", minIntervalMs: 1000 });
      } else if (message.MessageType === "ForceKeepAlive") {
        const seconds = typeof message.Data === "number" && message.Data > 0 ? message.Data : 60;
        if (keepAlive) clearInterval(keepAlive);
        keepAlive = setInterval(() => {
          try { socket.send(JSON.stringify({ MessageType: "KeepAlive" })); } catch { /* closing */ }
        }, Math.max(5, seconds / 2) * 1000);
        keepAlive.unref?.();
      }
    });
    return () => {
      if (keepAlive) clearInterval(keepAlive);
      close();
    };
  }

  async stopStream(session: ParsedSession, message: string): Promise<void> {
    if (!session.remoteControl) throw new NowPlayingError("This Jellyfin client does not accept remote control, so it cannot be stopped from SRTL.");
    const base = `${this.config.url}/Sessions/${encodeURIComponent(session.sessionKey)}`;
    const request = { service: "Jellyfin", method: "POST", headers: this.headers(), timeoutMs: sessionTimeoutMs, retries: 0 } as const;
    // Many clients ignore messages; the stop command is what matters.
    if (message.trim()) {
      await watchSyncRequest({ ...request, url: `${base}/Message`, body: JSON.stringify({ Text: message, Header: "SRTL Manager", TimeoutMs: 10_000 }) }).catch(() => undefined);
    }
    try {
      await watchSyncRequest({ ...request, url: `${base}/Playing/Stop` });
    } catch (error) {
      statusMessage(error, {
        401: "Jellyfin rejected the API key. Check it in Settings > Media servers.",
        403: "Jellyfin refused to stop the stream (HTTP 403). The API key needs administrator rights.",
        404: "Jellyfin no longer has this session (HTTP 404). It has probably ended already."
      });
    }
  }

  async fetchPoster(path: string): Promise<{ contentType: string; body: Buffer }> {
    if (!/^\/Items\/[A-Za-z0-9-]{1,64}\/Images\/Primary\?tag=[A-Za-z0-9]{1,64}$/.test(path)) throw new NowPlayingError("Unsupported artwork path.");
    const response = await watchSyncRequest({ url: `${this.config.url}${path}&fillHeight=360&quality=85`, service: "Jellyfin", headers: { ...this.headers(), Accept: "image/*" }, timeoutMs: sessionTimeoutMs, retries: 0, maxBytes: posterMaxBytes });
    return { contentType: String(response.headers["content-type"] ?? ""), body: response.buffer };
  }
}

export function parseJellyfinSessions(data: unknown[]): ParsedSession[] {
  const now = new Date();
  return data.flatMap((entry) => {
    const parsed = parseJellyfinSession(entry, now);
    return parsed ? [parsed] : [];
  });
}

export function createLiveAdapter(config: LiveServerConfig): LiveAdapter {
  return config.kind === "plex" ? new PlexLiveAdapter(config) : new JellyfinLiveAdapter(config);
}

// plex.tv reports the account's subscription; an active one is Plex Pass.
export async function plexPassActive(token: string, clientIdentifier: string): Promise<boolean> {
  const { data } = await watchSyncJson({ url: `${plexEndpoints.plexTv}/api/v2/user`, service: "plex.tv", trusted: true, headers: plexHeaders(clientIdentifier, token), timeoutMs: 8000, retries: 1, maxBytes: 1024 * 1024 });
  const parsed = z.object({
    subscription: z.object({ active: z.boolean().optional(), status: z.string().optional() }).loose().nullish()
  }).loose().safeParse(data);
  if (!parsed.success) throw new NowPlayingError("plex.tv returned an unsupported account response.");
  const subscription = parsed.data.subscription;
  return subscription?.active === true || subscription?.status?.toLowerCase() === "active";
}
