import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, CircleAlert, Cloud, Cpu, Film, Globe, HardDrive, LoaderCircle, MemoryStick, Microchip, MonitorPlay, Music, Network, OctagonX, Pause, Play, RefreshCw, Tv, Unlink, X } from "lucide-react";
import type { NowPlayingHostEvent, NowPlayingHostSample, NowPlayingServerState, NowPlayingSettings, NowPlayingSnapshot, NowPlayingStopResult, NowPlayingStream } from "../shared/nowPlaying";
import { nowPlayingDefaultStopMessage } from "../shared/nowPlaying";
import type { StoragePolicyKind } from "../shared/types";
import { Page } from "./App";
import { request } from "./api";
import { storagePolicyLabel, useLiveTimestamp, useModalLifecycle, useStorageLocations } from "./appShared";
import { useAccess } from "./access";
import { mediaServerApi, mediaServersKey } from "./mediaServerApi";
import { MediaServersRequired } from "./mediaServersRequired";
import {
  applyHostEvent,
  audioLabel,
  busiestGpuEngine,
  codecLabel,
  decisionLabel,
  formatBytesPerSecond,
  formatClock,
  formatGigabytes,
  formatKbps,
  geoLabel,
  livePosition,
  playMethodLabel,
  sparklinePoints,
  streamTitle,
  summaryPills,
  videoLabel,
  type HostState
} from "./nowPlayingPresentation";

type Connection = "connecting" | "open" | "reconnecting";

function useNowPlayingEvents() {
  const [snapshot, setSnapshot] = useState<NowPlayingSnapshot | null>(null);
  const [host, setHost] = useState<HostState>({ info: null, samples: [] });
  const [connection, setConnection] = useState<Connection>("connecting");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const source = new EventSource("/api/now-playing/events");
    let retry: number | undefined;
    source.addEventListener("open", () => setConnection("open"));
    source.addEventListener("sessions", (event) => {
      setConnection("open");
      setSnapshot(JSON.parse((event as MessageEvent<string>).data) as NowPlayingSnapshot);
    });
    source.addEventListener("host", (event) => {
      const data = JSON.parse((event as MessageEvent<string>).data) as NowPlayingHostEvent;
      setHost((current) => applyHostEvent(current, data));
    });
    source.addEventListener("error", () => {
      setConnection("reconnecting");
      // The browser retries on its own unless the server refused the stream outright.
      if (source.readyState === EventSource.CLOSED) retry = window.setTimeout(() => setAttempt((value) => value + 1), 10_000);
    });
    return () => {
      if (retry) window.clearTimeout(retry);
      source.close();
    };
  }, [attempt]);

  return { snapshot, host, connection };
}

function Sparkline({ series, max, label }: { series: Array<{ values: Array<number | null>; className: string }>; max: number; label: string }) {
  return (
    <svg className="np-sparkline" viewBox="0 0 120 32" preserveAspectRatio="none" role="img" aria-label={label}>
      {series.map((entry) => {
        const points = sparklinePoints(entry.values, max);
        return points ? <polyline key={entry.className} className={entry.className} points={points} fill="none" vectorEffect="non-scaling-stroke" /> : null;
      })}
    </svg>
  );
}

function MetricCard({ icon, title, value, detail, note, children }: { icon: ReactNode; title: string; value: string; detail?: ReactNode; note?: ReactNode; children?: ReactNode }) {
  return (
    <section className="np-metric" aria-label={title}>
      <div className="np-metric-head">{icon}<span>{title}</span></div>
      <strong className="np-metric-value">{value}</strong>
      {detail ? <div className="np-metric-detail">{detail}</div> : null}
      {children}
      {note ? <div className="np-metric-note">{note}</div> : null}
    </section>
  );
}

function HostCards({ host, servers }: { host: HostState; servers: NowPlayingServerState[] }) {
  const latest: NowPlayingHostSample | undefined = host.samples.at(-1);
  const cpu = host.samples.map((sample) => sample.cpuPercent);
  const memory = host.samples.map((sample) => sample.memoryUsedBytes !== null && sample.memoryTotalBytes ? (sample.memoryUsedBytes / sample.memoryTotalBytes) * 100 : null);
  const netIn = host.samples.map((sample) => sample.networkInBps);
  const netOut = host.samples.map((sample) => sample.networkOutBps);
  const netMax = Math.max(1, ...netIn.map((value) => value ?? 0), ...netOut.map((value) => value ?? 0));
  const plexResources = servers.find((server) => server.resources?.hostCpu !== null && server.resources?.hostCpu !== undefined)?.resources ?? null;
  const plexBandwidth = servers.filter((server) => server.bandwidth);
  const lan = plexBandwidth.reduce((sum, server) => sum + server.bandwidth!.lanBps, 0);
  const wan = plexBandwidth.reduce((sum, server) => sum + server.bandwidth!.wanBps, 0);
  const gpu = latest?.gpus?.[0] ?? null;
  const scope = host.info?.networkScope;
  return (
    <div className="np-metrics">
      <MetricCard icon={<Cpu size={15} />} title="CPU" value={latest?.cpuPercent !== null && latest?.cpuPercent !== undefined ? `${latest.cpuPercent.toFixed(0)}%` : "—"}
        note={plexResources ? `Plex reports host ${plexResources.hostCpu?.toFixed(0) ?? "—"}%, Plex ${plexResources.processCpu?.toFixed(0) ?? "—"}%` : "SRTL host"}>
        <Sparkline series={[{ values: cpu, className: "np-line-primary" }]} max={100} label="CPU over the last few minutes" />
      </MetricCard>
      <MetricCard icon={<MemoryStick size={15} />} title="RAM" value={latest?.memoryTotalBytes ? `${Math.round(((latest.memoryUsedBytes ?? 0) / latest.memoryTotalBytes) * 100)}%` : "—"}
        note={latest ? `${formatGigabytes(latest.memoryUsedBytes)} of ${formatGigabytes(latest.memoryTotalBytes)}` : "SRTL host"}>
        <Sparkline series={[{ values: memory, className: "np-line-primary" }]} max={100} label="Memory over the last few minutes" />
      </MetricCard>
      <MetricCard icon={<Network size={15} />} title={scope === "container" ? "Network (container traffic only)" : "Network (host total)"}
        value={scope === "unavailable" ? "Unavailable" : formatBytesPerSecond(latest ? (latest.networkInBps ?? 0) + (latest.networkOutBps ?? 0) : null)}
        detail={scope === "unavailable" ? null : <><span className="np-in"><ArrowDown size={12} />{formatBytesPerSecond(latest?.networkInBps ?? null)}</span><span className="np-out"><ArrowUp size={12} />{formatBytesPerSecond(latest?.networkOutBps ?? null)}</span></>}
        note={plexBandwidth.length ? <span title="Plex's own streaming traffic from its bandwidth statistics">Plex streaming: LAN {formatBytesPerSecond(lan)} · WAN {formatBytesPerSecond(wan)}</span> : scope === "container" ? "Mount the host's /proc to see host totals" : null}>
        <Sparkline series={[{ values: netIn, className: "np-line-in" }, { values: netOut, className: "np-line-out" }]} max={netMax} label="Network in and out over the last few minutes" />
      </MetricCard>
      {host.info?.gpuAvailable ? (
        <MetricCard icon={<Microchip size={15} />} title={gpu?.name ?? "GPU"} value={gpu?.utilization !== null && gpu?.utilization !== undefined ? `${gpu.utilization}%` : "—"}
          detail={gpu ? <><span>Enc {gpu.encoder ?? "—"}%</span><span>Dec {gpu.decoder ?? "—"}%</span><span>{gpu.encoderSessions ?? 0} enc sessions</span></> : null}
          note={gpu?.memoryUsedMb !== null && gpu?.memoryUsedMb !== undefined ? `VRAM ${(gpu.memoryUsedMb / 1024).toFixed(1)} of ${((gpu.memoryTotalMb ?? 0) / 1024).toFixed(1)} GB` : null}>
          <Sparkline series={[{ values: host.samples.map(busiestGpuEngine), className: "np-line-primary" }]} max={100} label="Busiest GPU engine over the last few minutes" />
        </MetricCard>
      ) : null}
    </div>
  );
}

function QuickGlance({ snapshot, host, connection }: { snapshot: NowPlayingSnapshot | null; host: HostState; connection: Connection }) {
  const pills = snapshot ? summaryPills(snapshot.summary) : [];
  return (
    <div className="np-strip" role="region" aria-label="Quick glance">
      <div className="np-pills">
        {pills.map((pill) => (
          <span key={pill.key} className={`np-pill np-pill-${pill.tone}`} aria-label={`${pill.label}: ${pill.value}`}>
            <span>{pill.label}</span><strong>{pill.value}</strong>
          </span>
        ))}
        {snapshot?.summary.paused ? <span className="np-pill np-pill-paused" aria-label={`Paused: ${snapshot.summary.paused}`}><span>Paused</span><strong>{snapshot.summary.paused}</strong></span> : null}
        <span className={`np-connection np-connection-${connection}`} role="status">
          {connection === "open" ? <><span className="np-live-dot" aria-hidden="true" />Live</> : connection === "connecting" ? <><LoaderCircle className="is-spinning" size={13} />Connecting</> : <><RefreshCw className="is-spinning" size={13} />Reconnecting</>}
        </span>
      </div>
      <HostCards host={host} servers={snapshot?.servers ?? []} />
    </div>
  );
}

const serverStatusLabels: Record<NowPlayingServerState["status"], string> = {
  connecting: "Connecting", live: "Live", polling: "Polling", unreachable: "Unreachable", unauthorized: "Sign-in needed", notConnected: "Not connected"
};

function ServerStatusList({ servers }: { servers: NowPlayingServerState[] }) {
  if (!servers.length) return null;
  return (
    <ul className="np-servers" aria-label="Media servers">
      {servers.map((server) => (
        <li key={server.id} className={`np-server np-server-${server.status}`}>
          <strong>{server.name}</strong>
          <span className="np-server-status">{serverStatusLabels[server.status]}</span>
          {server.status === "polling" ? <span className="np-server-note">no live socket, checking every few seconds</span> : null}
          {server.kind === "plex" && server.plexPass === false && server.status !== "unauthorized" ? <span className="np-server-note">Stop needs Plex Pass</span> : null}
          {server.message && (server.status === "unreachable" || server.status === "unauthorized" || server.status === "notConnected") ? <span className="np-server-message" role={server.status === "unauthorized" ? "alert" : undefined}>{server.message}</span> : null}
        </li>
      ))}
    </ul>
  );
}

function SourceBadge({ stream }: { stream: NowPlayingStream }) {
  const locations = useStorageLocations();
  const { status, locationName, policy } = stream.srtl;
  const policyText = policy ? ` · policy ${storagePolicyLabel(policy as StoragePolicyKind, locations)}` : "";
  if (status === "local") return <span className="np-badge np-badge-local" title={`Playing from local storage${policyText}`}><HardDrive size={12} />{locationName ?? "Local"}</span>;
  if (status === "remote") return <span className="np-badge np-badge-remote" title={`Playing from remote storage${policyText}`}><Cloud size={12} />{locationName ?? "Remote"}</span>;
  if (status === "broken") return <span className="np-badge np-badge-bad" title="SRTL's link for this file is broken"><Unlink size={12} />Broken link</span>;
  if (status === "unlinked") return <span className="np-badge np-badge-neutral" title="This file is not one of SRTL's links">Not in SRTL</span>;
  return <span className="np-badge np-badge-neutral" title="Check the media server's path mappings in Settings > Media servers">Source unknown</span>;
}

function MediaIcon({ type }: { type: NowPlayingStream["mediaType"] }) {
  if (type === "track") return <Music size={28} />;
  if (type === "episode") return <Tv size={28} />;
  return <Film size={28} />;
}

function StreamCard({ stream, now, onStop }: { stream: NowPlayingStream; now: number; onStop: (stream: NowPlayingStream) => void }) {
  const canStop = useAccess().can("streams.stop");
  const [posterFailed, setPosterFailed] = useState(false);
  const title = streamTitle(stream);
  const position = livePosition(stream, now);
  const percent = stream.durationMs ? Math.min(100, (position / stream.durationMs) * 100) : 0;
  const player = [stream.player.product, stream.player.name, stream.player.platform && stream.player.platform !== stream.player.name ? stream.player.platform : null].filter(Boolean).join(" · ");
  const sourceVideo = videoLabel(stream.source);
  const outputVideo = videoLabel(stream.output);
  const sourceAudio = audioLabel(stream.source);
  const outputAudio = audioLabel(stream.output);
  const geo = geoLabel(stream.network.geo);
  const methodClass = stream.playMethod === "transcode" ? `np-method-transcode np-engine-${stream.transcode?.engine ?? "unknown"}` : `np-method-${stream.playMethod}`;
  return (
    <article className={`np-card np-state-${stream.state}`} aria-label={`${title.primary} — ${stream.user.name}`}>
      <div className="np-poster">
        {stream.posterUrl && !posterFailed ? <img src={stream.posterUrl} alt="" loading="lazy" onError={() => setPosterFailed(true)} /> : <MediaIcon type={stream.mediaType} />}
      </div>
      <div className="np-card-body">
        <header className="np-card-header">
          <div className="np-card-title">
            <h3 title={title.primary}>{title.primary}</h3>
            {title.secondary ? <p title={title.secondary}>{title.secondary}</p> : null}
          </div>
          {stream.stop.available && canStop ? (
            <button type="button" className="np-stop-button" onClick={() => onStop(stream)} aria-label={`Stop stream for ${stream.user.name}`}>
              <OctagonX size={15} />Stop
            </button>
          ) : null}
        </header>
        <div className="np-card-who">
          <strong>{stream.user.name}</strong>
          <span>on {stream.serverName}</span>
          {player ? <span className="np-player">{player}</span> : null}
        </div>
        <div className="np-badges">
          <span className={`np-badge np-method ${methodClass}`}>{playMethodLabel(stream)}</span>
          <span className={`np-badge np-badge-state np-badge-${stream.state}`}>
            {stream.state === "paused" ? <Pause size={12} /> : stream.state === "buffering" ? <LoaderCircle size={12} /> : <Play size={12} />}
            {stream.state === "paused" ? "Paused" : stream.state === "buffering" ? "Buffering" : "Playing"}
          </span>
          {stream.network.location ? <span className={`np-badge np-badge-${stream.network.location}`}>{stream.network.location.toUpperCase()}{stream.network.relayed ? " relay" : ""}</span> : null}
          <SourceBadge stream={stream} />
        </div>
        <div className="np-progress" role="progressbar" aria-label="Playback position" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(percent)}>
          <span style={{ width: `${percent}%` }} />
        </div>
        <div className="np-progress-times"><span>{formatClock(position)}</span><span>{formatClock(stream.durationMs)}</span></div>
        <dl className="np-details">
          {sourceVideo ? (
            <div><dt>Video</dt><dd>{sourceVideo}{stream.videoDecision === "transcode" && outputVideo ? <> → {outputVideo}</> : stream.videoDecision ? <span className="np-decision"> ({decisionLabel(stream.videoDecision)})</span> : null}</dd></div>
          ) : null}
          {sourceAudio ? (
            <div><dt>Audio</dt><dd>{sourceAudio}{stream.audioDecision === "transcode" && outputAudio ? <> → {outputAudio}</> : stream.audioDecision ? <span className="np-decision"> ({decisionLabel(stream.audioDecision)})</span> : null}</dd></div>
          ) : null}
          {stream.subtitle ? (
            <div><dt>Subtitles</dt><dd>{[codecLabel(stream.subtitle.codec), stream.subtitle.language].filter(Boolean).join(" ") || "On"}{stream.subtitle.decision === "burn" ? <strong className="np-burn"> burned in</strong> : null}</dd></div>
          ) : null}
          {stream.output?.container && stream.source.container && stream.output.container !== stream.source.container ? (
            <div><dt>Container</dt><dd>{stream.source.container.toUpperCase()} → {stream.output.container.toUpperCase()}</dd></div>
          ) : null}
          {stream.playMethod === "transcode" && stream.transcode ? (
            <div><dt>Transcoder</dt><dd>
              {stream.transcode.engine === "hardware" ? `GPU (${[stream.transcode.hardwareDecode && `${stream.transcode.hardwareDecode} decode`, stream.transcode.hardwareEncode && `${stream.transcode.hardwareEncode} encode`].filter(Boolean).join(", ")})`
                : stream.transcode.engine === "cpu" ? (stream.transcode.hardwareDecode ? `CPU encode, ${stream.transcode.hardwareDecode} decode` : "CPU")
                  : "Not reported by the server"}
              {stream.transcode.speed !== null ? ` · ${stream.transcode.speed.toFixed(1)}x` : ""}
              {stream.transcode.throttled ? " · throttled" : ""}
            </dd></div>
          ) : null}
          {stream.transcode?.reasons.length ? (
            <div><dt>{stream.transcode.reasonsDerived ? "Why (derived)" : "Why"}</dt><dd>{stream.transcode.reasons.join("; ")}</dd></div>
          ) : null}
          <div><dt>Bandwidth</dt><dd>{stream.bandwidth.kbps === null ? "Unknown" : `${stream.bandwidth.kind === "estimate" ? "≈ " : ""}${formatKbps(stream.bandwidth.kbps)}`}{stream.bandwidth.kind === "estimate" && stream.bandwidth.kbps !== null ? <span className="np-decision"> (estimate)</span> : null}{stream.state === "paused" ? <span className="np-decision"> (paused, not counted)</span> : null}</dd></div>
          {stream.network.ip ? (
            <div><dt>Address</dt><dd>{stream.network.ip}{geo ? <span className="np-geo"><Globe size={12} />{geo}</span> : null}</dd></div>
          ) : null}
        </dl>
      </div>
    </article>
  );
}

function StopDialog({ stream, onClose }: { stream: NowPlayingStream | null; onClose: () => void }) {
  const [message, setMessage] = useState(nowPlayingDefaultStopMessage);
  const stop = useMutation({
    mutationFn: (target: NowPlayingStream) => request<NowPlayingStopResult>("/api/now-playing/stop", { method: "POST", body: JSON.stringify({ serverId: target.serverId, sessionKey: target.sessionKey, message }) })
  });
  const close = () => { if (!stop.isPending) onClose(); };
  const dialogRef = useModalLifecycle(Boolean(stream), close);
  if (!stream) return null;
  const title = streamTitle(stream);
  const result = stop.data;
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && close()}>
      <section ref={dialogRef} className="audit-dialog terminate-dialog np-stop-dialog" role="dialog" aria-modal="true" aria-labelledby="np-stop-title" tabIndex={-1}>
        <div className="audit-dialog-header">
          <div className="audit-dialog-title-block">
            <span className="audit-dialog-eyebrow">{stream.serverName}</span>
            <h2 id="np-stop-title">Stop {stream.user.name}'s stream?</h2>
            <p>{title.primary}{title.secondary ? ` · ${title.secondary}` : ""} on {[stream.player.product, stream.player.name].filter(Boolean).join(" · ") || "an unknown player"}</p>
          </div>
          <button type="button" className="icon-button" onClick={close} aria-label="Close stop stream" disabled={stop.isPending}><X size={18} /></button>
        </div>
        {result ? (
          <p className={`panel-message ${result.result === "stopped" ? "np-stop-done" : "np-stop-warning"}`} role="status">
            {result.result === "stopped" ? null : <CircleAlert size={15} />}{result.message}
          </p>
        ) : (
          <label className="np-stop-message">
            <span>Message shown to {stream.user.name}{stream.serverKind === "jellyfin" ? " (if the app displays messages)" : ""}</span>
            <textarea value={message} maxLength={250} rows={3} onChange={(event) => setMessage(event.target.value)} disabled={stop.isPending} />
          </label>
        )}
        {stop.error ? <p className="panel-message action-error" role="alert">{stop.error instanceof Error ? stop.error.message : "The stream could not be stopped."}</p> : null}
        <div className="terminate-dialog-actions">
          <button type="button" className="secondary" onClick={close} disabled={stop.isPending}>{result ? "Close" : "Cancel"}</button>
          {!result ? (
            <button type="button" className="danger" onClick={() => stop.mutate(stream)} disabled={stop.isPending}>
              {stop.isPending ? <LoaderCircle className="is-spinning" size={16} /> : <OctagonX size={16} />}
              {stop.isPending ? "Stopping…" : "Stop stream"}
            </button>
          ) : null}
        </div>
      </section>
    </div>
  );
}

function GeoSetting() {
  const queryClient = useQueryClient();
  const settings = useQuery({ queryKey: ["now-playing-settings"], queryFn: () => request<NowPlayingSettings>("/api/now-playing/settings") });
  const update = useMutation({
    mutationFn: (value: NowPlayingSettings) => request<NowPlayingSettings>("/api/now-playing/settings", { method: "PUT", body: JSON.stringify(value) }),
    onSuccess: (value) => queryClient.setQueryData(["now-playing-settings"], value)
  });
  return (
    <label className="np-setting">
      <input type="checkbox" checked={settings.data?.geoLookup ?? true} disabled={!settings.data || update.isPending} onChange={(event) => update.mutate({ geoLookup: event.target.checked })} />
      <span>Look up the location of public client addresses with plex.tv. Private and LAN addresses are never sent.</span>
      {update.error ? <span className="action-error">{update.error instanceof Error ? update.error.message : "Could not save."}</span> : null}
    </label>
  );
}

function LiveNowPlaying() {
  const canManageSettings = useAccess().can("settings.manage");
  const { snapshot, host, connection } = useNowPlayingEvents();
  const [stopping, setStopping] = useState<NowPlayingStream | null>(null);
  const streams = useMemo(() => snapshot?.streams ?? [], [snapshot]);
  const now = useLiveTimestamp(streams.some((stream) => stream.state === "playing"), 1000);
  return (
    <>
      <QuickGlance snapshot={snapshot} host={host} connection={connection} />
      <ServerStatusList servers={snapshot?.servers ?? []} />
      {snapshot === null || (streams.length === 0 && snapshot.servers.some((server) => server.status === "connecting")) ? (
        <p className="panel-message" role="status"><LoaderCircle className="is-spinning" size={16} /> Connecting to your media servers</p>
      ) : streams.length === 0 ? (
        <section className="np-empty" role="status"><MonitorPlay size={22} /><p>Nothing is playing right now.</p></section>
      ) : (
        <div className="np-cards" aria-label="Streams">
          {streams.map((stream) => <StreamCard key={stream.id} stream={stream} now={now} onStop={setStopping} />)}
        </div>
      )}
      {canManageSettings ? <GeoSetting /> : null}
      <StopDialog key={stopping?.id ?? "none"} stream={stopping} onClose={() => setStopping(null)} />
    </>
  );
}

export function NowPlayingPage() {
  const canManageServers = useAccess().can("settings.manage");
  // Only people who manage connections can read them or act on the list being empty.
  const servers = useQuery({ queryKey: mediaServersKey, queryFn: mediaServerApi.list, enabled: canManageServers });
  const connected = servers.data?.servers.some((server) => server.hasToken) ?? false;
  return (
    <Page title="Now Playing" subtitle="Live streams on your Plex and Jellyfin servers, with host load. Nothing here is recorded.">
      {!canManageServers ? (
        <LiveNowPlaying />
      ) : servers.isLoading ? (
        <p className="panel-message" role="status"><LoaderCircle className="is-spinning" size={16} /> Loading media servers</p>
      ) : servers.isError ? (
        <p className="panel-message action-error" role="alert">{servers.error instanceof Error ? servers.error.message : "Media servers could not be loaded."}</p>
      ) : !connected ? (
        <MediaServersRequired />
      ) : (
        <LiveNowPlaying />
      )}
    </Page>
  );
}
