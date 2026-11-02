import { createHash } from "node:crypto";
import type { MediaServerPrefixMapping } from "../../../shared/mediaServers";
import type {
  NowPlayingHostEvent,
  NowPlayingServerState,
  NowPlayingSettings,
  NowPlayingSnapshot,
  NowPlayingSource,
  NowPlayingStopResult,
  NowPlayingStream
} from "../../../shared/nowPlaying";
import type { MediaServerRecord } from "../mediaServers";
import { WatchSyncError } from "../watchSyncHttp";
import { summarizeStreams, type ParsedSession } from "./classify";
import { GeoLookup, type GeoLookupOptions } from "./geo";
import { HostMonitor } from "./hostStats";
import { NowPlayingError, createLiveAdapter, plexPassActive, type LiveAdapter, type LiveServerConfig, type ServerExtras, type SocketEvent } from "./upstream";

export type NowPlayingEvent = { type: "sessions"; snapshot: NowPlayingSnapshot } | { type: "host"; host: NowPlayingHostEvent };
export type NowPlayingListener = (event: NowPlayingEvent) => void;

export interface NowPlayingTiming {
  // How long upstream connections stay up after the last viewer leaves.
  graceMs: number;
  // Safety poll while the server's socket delivers change events.
  safetyPollMs: number;
  // Poll interval while no socket is available.
  fallbackPollMs: number;
  refreshDebounceMs: number;
  socketRetryMs: number;
  maxBackoffMs: number;
  serverReloadMs: number;
  extrasMs: number;
  failureThreshold: number;
  // How long SRTL waits after a stop before checking whether the stream is gone.
  stopVerifyMs: number;
  broadcastDelayMs: number;
}

export const defaultNowPlayingTiming: NowPlayingTiming = {
  graceMs: 15_000,
  safetyPollMs: 30_000,
  fallbackPollMs: 5000,
  refreshDebounceMs: 750,
  socketRetryMs: 30_000,
  maxBackoffMs: 120_000,
  serverReloadMs: 30_000,
  extrasMs: 10_000,
  failureThreshold: 3,
  stopVerifyMs: 2500,
  broadcastDelayMs: 150
};

interface HostMonitorLike {
  start(): void;
  stop(): void;
  snapshot(): NowPlayingHostEvent;
}

export interface NowPlayingHubOptions {
  loadServers: () => Promise<MediaServerRecord[]>;
  clientIdentifier: () => Promise<string>;
  loadSettings: () => Promise<NowPlayingSettings>;
  resolveSource: (serverId: string, mappings: MediaServerPrefixMapping[], filePath: string | null) => Promise<NowPlayingSource>;
  createAdapter?: (config: LiveServerConfig) => LiveAdapter;
  plexPass?: (token: string, clientIdentifier: string) => Promise<boolean>;
  geoFetch?: GeoLookupOptions["fetch"];
  hostMonitor?: (onSample: (event: NowPlayingHostEvent) => void) => HostMonitorLike;
  timing?: Partial<NowPlayingTiming>;
  onError?: (message: string) => void;
}

const unknownSource: NowPlayingSource = { status: "unknown", locationName: null, policy: null };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// A slow or failed lookup never holds up an update; the card shows the fallback until the next one.
function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise.catch(() => fallback),
    new Promise<T>((resolve) => { timer = setTimeout(() => resolve(fallback), ms); })
  ]).finally(() => clearTimeout(timer));
}

function unauthorizedMessage(kind: MediaServerRecord["kind"]): string {
  return kind === "plex"
    ? "Plex token invalid — sign in again in Settings > Media servers."
    : "Jellyfin API key rejected — update it in Settings > Media servers.";
}

// One media server's live sessions: a socket for change events where the server offers one, a safety poll,
// a faster poll when the socket is down, and backoff when the server stops answering.
class ServerWatcher {
  readonly sessions = new Map<string, ParsedSession>();
  status: NowPlayingServerState["status"] = "connecting";
  message: string | null = null;
  transport: "socket" | "poll" = "poll";
  lastUpdatedAt: string | null = null;
  extras: ServerExtras = {};
  private failures = 0;
  private socketFailures = 0;
  private closeSocket: (() => void) | null = null;
  private socketConnecting = false;
  private pollTimer: NodeJS.Timeout | null = null;
  private socketTimer: NodeJS.Timeout | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;
  private extrasTimer: NodeJS.Timeout | null = null;
  private inFlight: Promise<boolean> | null = null;
  private lastRefreshAt = 0;
  private stopped = false;
  private readonly abort = new AbortController();

  constructor(
    public record: MediaServerRecord,
    readonly fingerprint: string,
    readonly adapter: LiveAdapter,
    private readonly timing: NowPlayingTiming,
    private readonly changed: () => void
  ) {}

  start(): void {
    void this.refresh().then(() => this.schedulePoll());
    void this.connectSocket();
    if (this.adapter.fetchExtras) this.scheduleExtras(0);
  }

  stop(): void {
    this.stopped = true;
    this.abort.abort();
    for (const timer of [this.pollTimer, this.socketTimer, this.debounceTimer, this.extrasTimer]) if (timer) clearTimeout(timer);
    this.pollTimer = this.socketTimer = this.debounceTimer = this.extrasTimer = null;
    this.closeSocket?.();
    this.closeSocket = null;
    this.sessions.clear();
  }

  private liveStatus(): NowPlayingServerState["status"] {
    return this.transport === "socket" ? "live" : "polling";
  }

  private async connectSocket(): Promise<void> {
    if (this.stopped || this.closeSocket || this.socketConnecting || this.status === "unauthorized") return;
    this.socketConnecting = true;
    try {
      const close = await this.adapter.openSocket({
        onEvent: (event) => this.onSocketEvent(event),
        onClose: () => {
          this.closeSocket = null;
          this.transport = "poll";
          if (this.status === "live") this.status = "polling";
          this.changed();
          this.schedulePoll();
          this.scheduleSocketRetry();
        }
      });
      if (this.stopped) { close(); return; }
      this.closeSocket = close;
      this.socketFailures = 0;
      this.transport = "socket";
      if (this.status === "polling") this.status = "live";
      this.changed();
      this.schedulePoll();
    } catch {
      if (this.stopped) return;
      this.socketFailures += 1;
      this.transport = "poll";
      this.schedulePoll();
      this.scheduleSocketRetry();
    } finally {
      this.socketConnecting = false;
    }
  }

  private scheduleSocketRetry(): void {
    if (this.stopped || this.socketTimer || this.status === "unauthorized") return;
    const delay = Math.min(this.timing.maxBackoffMs * 2.5, this.timing.socketRetryMs * 2 ** Math.min(4, Math.max(0, this.socketFailures - 1)));
    this.socketTimer = setTimeout(() => {
      this.socketTimer = null;
      // While the server is unreachable, polling decides when it is back.
      if (this.status === "unreachable") this.scheduleSocketRetry();
      else void this.connectSocket();
    }, delay);
    this.socketTimer.unref?.();
  }

  pollDelay(): number {
    if (this.status === "unauthorized") return Math.max(60_000, this.timing.safetyPollMs);
    if (this.failures >= this.timing.failureThreshold) {
      return Math.min(this.timing.maxBackoffMs, this.timing.fallbackPollMs * 2 ** (this.failures - this.timing.failureThreshold + 1));
    }
    return this.transport === "socket" ? this.timing.safetyPollMs : this.timing.fallbackPollMs;
  }

  private schedulePoll(): void {
    if (this.stopped) return;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null;
      void this.refresh().then(() => this.schedulePoll());
    }, this.pollDelay());
    this.pollTimer.unref?.();
  }

  private scheduleExtras(delay: number): void {
    if (this.stopped) return;
    this.extrasTimer = setTimeout(() => {
      this.extrasTimer = null;
      if (this.status !== "live" && this.status !== "polling") { this.scheduleExtras(this.timing.extrasMs); return; }
      void this.adapter.fetchExtras!(this.abort.signal).then((extras) => {
        if (this.stopped) return;
        this.extras = extras;
        this.changed();
      }).catch(() => undefined).finally(() => this.scheduleExtras(this.timing.extrasMs));
    }, delay);
    this.extrasTimer.unref?.();
  }

  requestRefresh(minIntervalMs = 0): void {
    if (this.stopped || this.debounceTimer) return;
    const delay = Math.max(this.timing.refreshDebounceMs, this.lastRefreshAt + minIntervalMs - Date.now());
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.refresh();
    }, delay);
    this.debounceTimer.unref?.();
  }

  // Concurrent callers share one request. Resolves true when the server answered.
  refresh(): Promise<boolean> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = (async () => {
      try {
        const sessions = await this.adapter.fetchSessions(this.abort.signal);
        if (this.stopped) return false;
        this.applySessions(sessions);
        const recovered = this.failures >= this.timing.failureThreshold || this.status === "unauthorized";
        this.failures = 0;
        this.status = this.liveStatus();
        this.message = null;
        if (recovered && !this.closeSocket) void this.connectSocket();
        return true;
      } catch (error) {
        if (this.stopped) return false;
        const httpStatus = error instanceof WatchSyncError ? error.httpStatus : null;
        if (httpStatus === 401 || httpStatus === 403) {
          this.status = "unauthorized";
          this.message = unauthorizedMessage(this.record.kind);
          this.sessions.clear();
          this.closeSocket?.();
          this.closeSocket = null;
          this.transport = "poll";
          return false;
        }
        this.failures += 1;
        if (this.failures >= this.timing.failureThreshold) {
          this.status = "unreachable";
          this.message = `${this.record.name} is not answering (${this.failures} failed attempts). ${error instanceof Error ? error.message : ""}`.trim();
          // Nothing current is known, so nothing is shown as playing.
          this.sessions.clear();
        }
        return false;
      } finally {
        this.lastRefreshAt = Date.now();
        this.inFlight = null;
        if (!this.stopped) this.changed();
      }
    })();
    return this.inFlight;
  }

  // The latest list replaces the previous one: sessions it no longer contains disappear immediately.
  private applySessions(sessions: ParsedSession[]): void {
    this.sessions.clear();
    for (const session of sessions) this.sessions.set(session.sessionKey, session);
    this.adapter.prune?.(sessions);
    this.lastUpdatedAt = new Date().toISOString();
  }

  private onSocketEvent(event: SocketEvent): void {
    if (this.stopped) return;
    if (event.type === "refresh") {
      this.requestRefresh(event.minIntervalMs);
      return;
    }
    const session = this.sessions.get(event.sessionKey);
    if (event.state === "stopped") {
      if (session) {
        this.sessions.delete(event.sessionKey);
        this.changed();
      }
      this.requestRefresh();
      return;
    }
    if (!session) {
      this.requestRefresh();
      return;
    }
    const stateChanged = session.stream.state !== event.state;
    session.stream = {
      ...session.stream,
      state: event.state,
      positionMs: event.positionMs ?? session.stream.positionMs,
      reportedAt: new Date().toISOString()
    };
    this.changed();
    if (stateChanged) this.requestRefresh();
  }
}

export interface PosterSource { serverId: string; path: string }

export class NowPlayingHub {
  private readonly listeners = new Set<NowPlayingListener>();
  private readonly watchers = new Map<string, ServerWatcher>();
  private records: MediaServerRecord[] = [];
  private active = false;
  private graceTimer: NodeJS.Timeout | null = null;
  private reloadTimer: NodeJS.Timeout | null = null;
  private broadcastTimer: NodeJS.Timeout | null = null;
  private broadcasting = false;
  private broadcastAgain = false;
  private syncing: Promise<void> | null = null;
  // Null until the first snapshot after activation is built, so a new viewer never sees an empty placeholder.
  private snapshotCache: NowPlayingSnapshot | null = null;
  private settings: NowPlayingSettings = { geoLookup: true };
  private clientId: string | null = null;
  private readonly plexPass = new Map<string, { token: string; value: boolean | null; checkedAt: number; inFlight: boolean }>();
  private readonly posters = new Map<string, PosterSource>();
  private readonly timing: NowPlayingTiming;
  private readonly geo: GeoLookup;
  private readonly host: HostMonitorLike;
  private generation = 0;

  constructor(private readonly options: NowPlayingHubOptions) {
    this.timing = { ...defaultNowPlayingTiming, ...options.timing };
    this.snapshotCache = null;
    this.geo = new GeoLookup({
      enabled: () => this.settings.geoLookup,
      token: () => this.records.find((record) => record.kind === "plex" && record.token)?.token ?? null,
      clientIdentifier: () => this.clientId,
      onResolved: () => this.scheduleBroadcast(),
      fetch: options.geoFetch
    });
    const onSample = (host: NowPlayingHostEvent) => this.emit({ type: "host", host });
    this.host = options.hostMonitor ? options.hostMonitor(onSample) : new HostMonitor({ onSample });
  }

  get viewers(): number {
    return this.listeners.size;
  }

  get isActive(): boolean {
    return this.active;
  }

  // Number of servers with upstream connections or polls running.
  get upstreamCount(): number {
    return this.watchers.size;
  }

  snapshot(): NowPlayingSnapshot {
    return this.snapshotCache ?? this.emptySnapshot();
  }

  subscribe(listener: NowPlayingListener): () => void {
    this.listeners.add(listener);
    if (this.graceTimer) {
      clearTimeout(this.graceTimer);
      this.graceTimer = null;
    }
    if (!this.active) this.activate();
    if (this.snapshotCache) listener({ type: "sessions", snapshot: this.snapshotCache });
    listener({ type: "host", host: this.host.snapshot() });
    return () => {
      if (!this.listeners.delete(listener)) return;
      if (this.listeners.size === 0 && this.active && !this.graceTimer) {
        this.graceTimer = setTimeout(() => {
          this.graceTimer = null;
          if (this.listeners.size === 0) this.deactivate();
        }, this.timing.graceMs);
        this.graceTimer.unref?.();
      }
    };
  }

  private activate(): void {
    this.active = true;
    this.generation += 1;
    this.host.start();
    void this.syncServers();
    this.reloadTimer = setInterval(() => void this.syncServers(), this.timing.serverReloadMs);
    this.reloadTimer.unref?.();
  }

  private deactivate(): void {
    this.active = false;
    this.generation += 1;
    if (this.reloadTimer) clearInterval(this.reloadTimer);
    if (this.broadcastTimer) clearTimeout(this.broadcastTimer);
    this.reloadTimer = this.broadcastTimer = null;
    for (const watcher of this.watchers.values()) watcher.stop();
    this.watchers.clear();
    this.host.stop();
    this.snapshotCache = null;
  }

  close(): void {
    if (this.graceTimer) clearTimeout(this.graceTimer);
    this.graceTimer = null;
    this.listeners.clear();
    if (this.active) this.deactivate();
  }

  // Picks up servers added, removed, or changed in Settings > Media servers while the page is open.
  syncServers(): Promise<void> {
    if (this.syncing) return this.syncing;
    const generation = this.generation;
    this.syncing = (async () => {
      try {
        const [records, clientId, settings] = await Promise.all([this.options.loadServers(), this.options.clientIdentifier(), this.options.loadSettings()]);
        if (!this.active || generation !== this.generation) return;
        this.records = records;
        this.clientId = clientId;
        this.settings = settings;
        const seen = new Set<string>();
        for (const record of records) {
          if (!record.token) continue;
          seen.add(record.id);
          const fingerprint = createHash("sha256").update(`${record.kind}\n${record.url}\n${record.token}`).digest("hex");
          const existing = this.watchers.get(record.id);
          if (existing && existing.fingerprint === fingerprint) {
            existing.record = record;
            continue;
          }
          existing?.stop();
          const adapter = (this.options.createAdapter ?? createLiveAdapter)({ id: record.id, kind: record.kind, name: record.name, url: record.url, token: record.token, clientIdentifier: clientId });
          const watcher = new ServerWatcher(record, fingerprint, adapter, this.timing, () => this.scheduleBroadcast());
          this.watchers.set(record.id, watcher);
          watcher.start();
        }
        for (const [id, watcher] of this.watchers) {
          if (!seen.has(id)) {
            watcher.stop();
            this.watchers.delete(id);
          }
        }
        this.scheduleBroadcast();
      } catch (error) {
        this.options.onError?.(`Now Playing could not load media servers: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        this.syncing = null;
      }
    })();
    return this.syncing;
  }

  updateSettings(settings: NowPlayingSettings): void {
    this.settings = settings;
    this.scheduleBroadcast();
  }

  private emit(event: NowPlayingEvent): void {
    for (const listener of [...this.listeners]) {
      try { listener(event); } catch { /* a closed connection unsubscribes itself */ }
    }
  }

  private scheduleBroadcast(): void {
    if (!this.active || this.broadcastTimer) return;
    this.broadcastTimer = setTimeout(() => {
      this.broadcastTimer = null;
      void this.broadcast();
    }, this.timing.broadcastDelayMs);
    this.broadcastTimer.unref?.();
  }

  private async broadcast(): Promise<void> {
    if (this.broadcasting) {
      this.broadcastAgain = true;
      return;
    }
    this.broadcasting = true;
    try {
      const generation = this.generation;
      const snapshot = await this.buildSnapshot();
      if (!this.active || generation !== this.generation) return;
      this.snapshotCache = snapshot;
      this.emit({ type: "sessions", snapshot });
    } catch (error) {
      this.options.onError?.(`Now Playing update failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.broadcasting = false;
      if (this.broadcastAgain) {
        this.broadcastAgain = false;
        this.scheduleBroadcast();
      }
    }
  }

  // Plex Pass is checked against the owner's plex.tv account, then cached: a day when active, half an hour
  // when not, two minutes after a failed check.
  private plexPassFor(record: MediaServerRecord): boolean | null {
    const now = Date.now();
    let entry = this.plexPass.get(record.id);
    if (entry && entry.token !== record.token) entry = undefined;
    const ttl = entry?.value === true ? 24 * 60 * 60_000 : entry?.value === false ? 30 * 60_000 : 2 * 60_000;
    if (!entry || (!entry.inFlight && now - entry.checkedAt > ttl)) {
      const next = { token: record.token, value: entry?.value ?? null, checkedAt: now, inFlight: true };
      this.plexPass.set(record.id, next);
      const clientId = this.clientId;
      if (clientId) {
        void (this.options.plexPass ?? plexPassActive)(record.token, clientId)
          .then((value) => { next.value = value; })
          .catch(() => { next.value = next.value ?? null; })
          .finally(() => {
            next.inFlight = false;
            next.checkedAt = Date.now();
            this.scheduleBroadcast();
          });
      } else next.inFlight = false;
      entry = next;
    }
    return entry.value;
  }

  private posterUrl(serverId: string, path: string | null): string | null {
    if (!path) return null;
    const key = createHash("sha256").update(`${serverId}\n${path}`).digest("base64url").slice(0, 32);
    if (!this.posters.has(key)) {
      if (this.posters.size >= 1000) this.posters.delete(this.posters.keys().next().value!);
      this.posters.set(key, { serverId, path });
    }
    return `/api/now-playing/poster/${key}`;
  }

  posterSource(key: string): { source: PosterSource; adapter: LiveAdapter } | null {
    const source = this.posters.get(key);
    const watcher = source ? this.watchers.get(source.serverId) : undefined;
    return source && watcher ? { source, adapter: watcher.adapter } : null;
  }

  private stopAvailability(record: MediaServerRecord, session: ParsedSession, plexPass: boolean | null): NowPlayingStream["stop"] {
    if (record.kind === "plex") {
      if (!session.terminateId) return { available: false, reason: "This player does not report a Plex session id (Plexamp and some players), so Plex cannot stop it." };
      if (plexPass === null) return { available: false, reason: "Checking Plex Pass on the server owner's account." };
      if (!plexPass) return { available: false, reason: "Stopping Plex streams needs an active Plex Pass on the server owner's account." };
      return { available: true, reason: null };
    }
    return session.remoteControl ? { available: true, reason: null } : { available: false, reason: "This Jellyfin client does not accept remote control." };
  }

  private async buildSnapshot(): Promise<NowPlayingSnapshot> {
    const servers: NowPlayingServerState[] = [];
    const streams: NowPlayingStream[] = [];
    for (const record of this.records) {
      const watcher = this.watchers.get(record.id);
      const plexPass = record.kind === "plex" && record.token ? this.plexPassFor(record) : null;
      if (!watcher) {
        servers.push({ id: record.id, name: record.name, kind: record.kind, status: "notConnected", message: record.kind === "plex" ? "Sign in with Plex in Settings > Media servers." : "Add an API key in Settings > Media servers.", transport: "poll", plexPass: null, bandwidth: null, resources: null, lastUpdatedAt: null });
        continue;
      }
      servers.push({
        id: record.id, name: record.name, kind: record.kind, status: watcher.status, message: watcher.message, transport: watcher.transport, plexPass,
        bandwidth: watcher.extras.bandwidth ?? null, resources: watcher.extras.resources ?? null, lastUpdatedAt: watcher.lastUpdatedAt
      });
      const sessions = [...watcher.sessions.values()];
      const sources = await Promise.all(sessions.map((session) => withTimeout(this.options.resolveSource(record.id, record.prefixMappings, session.filePath), 1500, unknownSource)));
      sessions.forEach((session, index) => {
        streams.push({
          ...session.stream,
          id: `${record.id}:${session.sessionKey}`,
          serverId: record.id,
          serverKind: record.kind,
          serverName: record.name,
          posterUrl: this.posterUrl(record.id, session.posterPath),
          srtl: sources[index]!,
          stop: this.stopAvailability(record, session, plexPass),
          network: { ...session.stream.network, geo: this.geo.get(session.stream.network.ip) }
        });
      });
    }
    streams.sort((a, b) => a.serverName.localeCompare(b.serverName) || a.user.name.localeCompare(b.user.name) || a.sessionKey.localeCompare(b.sessionKey));
    return { generatedAt: new Date().toISOString(), servers, streams, summary: summarizeStreams(streams) };
  }

  private emptySnapshot(): NowPlayingSnapshot {
    return { generatedAt: new Date().toISOString(), servers: [], streams: [], summary: summarizeStreams([]) };
  }

  // Stops a stream with a message, then checks whether the server still lists it.
  async stopStream(serverId: string, sessionKey: string, message: string): Promise<NowPlayingStopResult> {
    const watcher = this.watchers.get(serverId);
    if (!watcher) throw new NowPlayingError("This media server is not connected.", null, 404);
    const session = watcher.sessions.get(sessionKey);
    if (!session) throw new NowPlayingError("This stream has already ended.", null, 404);
    const availability = this.stopAvailability(watcher.record, session, watcher.record.kind === "plex" ? this.plexPassFor(watcher.record) : null);
    if (!availability.available) throw new NowPlayingError(availability.reason ?? "This stream cannot be stopped from SRTL.", null, 409);
    try {
      await watcher.adapter.stopStream(session, message);
    } catch (error) {
      if (error instanceof WatchSyncError && error.httpStatus === 404) {
        watcher.sessions.delete(sessionKey);
        this.scheduleBroadcast();
        return { result: "stopped", message: error.message };
      }
      throw error;
    }
    await sleep(this.timing.stopVerifyMs);
    // A poll that started before the stop may still be running; the check needs one that starts after it.
    await watcher.refresh();
    const answered = await watcher.refresh();
    if (answered && !watcher.sessions.has(sessionKey)) return { result: "stopped", message: "The stream has stopped." };
    return {
      result: "stillPlaying",
      message: answered
        ? `${watcher.record.name} still lists this stream. The player may have ignored the request; it can take a few seconds more.`
        : `${watcher.record.name} accepted the request, but SRTL could not check whether the stream stopped.`
    };
  }
}
