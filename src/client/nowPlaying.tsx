import { useCallback, useId, useMemo, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Check, ChevronDown, CircleAlert, CircleX, Cloud, Cpu, Film, HardDrive, LoaderCircle, MapPin, MemoryStick, Microchip, MonitorPlay, MonitorSmartphone, Music, Network, OctagonX, Pause, Play, RefreshCw, Tv, UserRound, X } from "lucide-react";
import type { NowPlayingHostSample, NowPlayingServerState, NowPlayingSettings, NowPlayingSnapshot, NowPlayingStopResult, NowPlayingStream, NowPlayingSummary } from "../shared/nowPlaying";
import { nowPlayingDefaultStopMessage, summarizeStreams } from "../shared/nowPlaying";
import type { UserPreferences } from "../shared/types";
import type { StoragePolicyKind } from "../shared/types";
import { Page } from "./App";
import { api, request } from "./api";
import { defaultUserPreferences, storagePolicyLabel, useLiveTimestamp, useModalLifecycle, useStorageLocations, useUserPreferences } from "./appShared";
import { useAccess } from "./access";
import { mediaServerApi, mediaServersKey } from "./mediaServerApi";
import { useNowPlayingEvents, type NowPlayingConnection } from "./nowPlayingFeed";
import { MediaServersRequired } from "./mediaServersRequired";
import { MediaServerIcon } from "./serverIcons";
import { TextTooltip } from "./tooltip";
import {
  audioLabel,
  bufferedLabel,
  bufferedPercent,
  busiestGpuEngine,
  codecLabel,
  decisionLabel,
  endsAtLabel,
  formatBytesPerSecond,
  formatClock,
  formatGigabytes,
  formatKbps,
  livePosition,
  playMethodLabel,
  playerLabels,
  sparklinePoints,
  streamLocationLabel,
  streamSummaryLine,
  streamTitle,
  timeLeft,
  summaryPills,
  videoLabel,
  type HostState
} from "./nowPlayingPresentation";

type Connection = NowPlayingConnection;

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

function QuickGlance({ snapshot, summary, host, connection }: { snapshot: NowPlayingSnapshot | null; summary: NowPlayingSummary | null; host: HostState; connection: Connection }) {
  const pills = summary ? summaryPills(summary) : [];
  return (
    <div className="np-strip" role="region" aria-label="Quick glance">
      <div className="np-pills">
        {pills.map((pill) => (
          <span key={pill.key} className={`np-pill np-pill-${pill.tone}`} aria-label={`${pill.label}: ${pill.value}`}>
            <span>{pill.label}</span><strong>{pill.value}</strong>
          </span>
        ))}
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

// Which servers' streams show on Now Playing, saved with the signed-in account's preferences.
// The preference lists hidden servers, so a server added later starts shown.
function useServerFilter() {
  const queryClient = useQueryClient();
  const preferences = useQuery({ queryKey: ["user-preferences"], queryFn: api.getUserPreferences });
  const hidden = useMemo(() => new Set(preferences.data?.nowPlayingHiddenServers ?? []), [preferences.data]);
  const { mutate: save, error } = useMutation({
    mutationFn: api.saveUserPreferences,
    onSuccess: (saved) => queryClient.setQueryData(["user-preferences"], saved),
    onError: () => void queryClient.invalidateQueries({ queryKey: ["user-preferences"] })
  });
  const toggle = useCallback((serverId: string) => {
    const current = queryClient.getQueryData<UserPreferences>(["user-preferences"]) ?? defaultUserPreferences;
    const ids = new Set(current.nowPlayingHiddenServers ?? []);
    if (!ids.delete(serverId)) ids.add(serverId);
    const next: UserPreferences = { ...defaultUserPreferences, ...current, nowPlayingHiddenServers: [...ids] };
    // Show the change at once; the saved answer replaces it.
    queryClient.setQueryData(["user-preferences"], next);
    save(next);
  }, [queryClient, save]);
  return { hidden, toggle, error };
}

function ServerStatusList({ servers, hidden, onToggle }: { servers: NowPlayingServerState[]; hidden: Set<string>; onToggle: (serverId: string) => void }) {
  if (!servers.length) return null;
  return (
    <ul className="np-servers" aria-label="Media servers">
      {servers.map((server) => (
        <li key={server.id} className={`np-server np-server-${server.status}${hidden.has(server.id) ? " is-hidden" : ""}`}>
          <button type="button" className="np-server-toggle" aria-pressed={!hidden.has(server.id)} title={hidden.has(server.id) ? `Show streams from ${server.name}` : `Hide streams from ${server.name}`} onClick={() => onToggle(server.id)}>
            <span className="np-server-check" aria-hidden="true">{hidden.has(server.id) ? null : <Check size={11} strokeWidth={3} />}</span>
            <MediaServerIcon kind={server.kind} />
            <strong>{server.name}</strong>
          </button>
          <span className="np-server-status">{serverStatusLabels[server.status]}</span>
          {server.status === "polling" ? <span className="np-server-note">{server.kind === "dupelix" ? "checking every few seconds" : "no live socket, checking every few seconds"}</span> : null}
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
  // Only files SRTL places on local or remote storage get a badge; anything else shows none.
  return null;
}

function MediaIcon({ type }: { type: NowPlayingStream["mediaType"] }) {
  if (type === "track") return <Music size={28} />;
  if (type === "episode") return <Tv size={28} />;
  return <Film size={28} />;
}

const expandedStorageKey = "srtl-now-playing-expanded";
const expandedLimit = 50;

function readExpanded(): Set<string> {
  try {
    const value: unknown = JSON.parse(window.sessionStorage.getItem(expandedStorageKey) ?? "[]");
    return new Set(Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : []);
  } catch {
    return new Set();
  }
}

// Which cards show their full details, per stream, for this browser session. Cards start folded.
function useExpandedStreams() {
  const [expanded, setExpanded] = useState<Set<string>>(readExpanded);
  const toggle = useCallback((id: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      const kept = [...next].slice(-expandedLimit);
      try {
        window.sessionStorage.setItem(expandedStorageKey, JSON.stringify(kept));
      } catch {
        // Storage can be unavailable in private windows; the state still holds for this page.
      }
      return new Set(kept);
    });
  }, []);
  return { expanded, toggle };
}

function StreamDetails({ stream, id, hidden }: { stream: NowPlayingStream; id: string; hidden: boolean }) {
  const sourceVideo = videoLabel(stream.source);
  const outputVideo = videoLabel(stream.output);
  const sourceAudio = audioLabel(stream.source);
  const outputAudio = audioLabel(stream.output);
  return (
    <dl className="np-details" id={id} hidden={hidden}>
      <div><dt>Play method</dt><dd>{playMethodLabel(stream)}</dd></div>
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
    </dl>
  );
}

function StreamLocation({ network }: { network: NowPlayingStream["network"] }) {
  const text = <><MapPin size={13} aria-hidden="true" /><span className="np-footer-text">{streamLocationLabel(network)}</span></>;
  // The client address stays out of the visible text; hover, focus or a tap shows it.
  if (!network.ip) return <span className={`np-location np-location-${network.location ?? "unknown"}`}>{text}</span>;
  return (
    <TextTooltip className={`np-location np-location-${network.location ?? "unknown"}`} trigger={text}>
      Client IP {network.ip}
    </TextTooltip>
  );
}

export function StreamCard({ stream, now, expanded, onToggle, onStop, showServerName = true }: { stream: NowPlayingStream; now: number; expanded: boolean; onToggle: (id: string) => void; onStop: (stream: NowPlayingStream) => void; showServerName?: boolean }) {
  const canStop = useAccess().can("streams.stop");
  const [posterFailed, setPosterFailed] = useState(false);
  const detailsId = useId();
  const title = streamTitle(stream);
  const position = livePosition(stream, now);
  const percent = stream.durationMs ? Math.min(100, (position / stream.durationMs) * 100) : 0;
  const bufferPercent = bufferedPercent(stream);
  const buffered = bufferedLabel(stream, position);
  const left = timeLeft(stream, position);
  const { timeFormat } = useUserPreferences();
  const player = playerLabels(stream.player);
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
            <button type="button" className="np-stop-button" onClick={() => onStop(stream)} aria-label="Terminate the stream" title="Terminate the stream">
              <CircleX size={20} aria-hidden="true" />
            </button>
          ) : null}
        </header>
        <div className="np-badges">
          <span className={`np-badge np-badge-state np-badge-${stream.state}`}>
            {stream.state === "paused" ? <Pause size={12} /> : stream.state === "buffering" ? <LoaderCircle size={12} /> : <Play size={12} />}
            {stream.state === "paused" ? "Paused" : stream.state === "buffering" ? "Buffering" : "Playing"}
          </span>
          <SourceBadge stream={stream} />
        </div>
        <div className="np-progress" role="progressbar" aria-label="Playback position" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(percent)} aria-valuetext={`${formatClock(position)} of ${formatClock(stream.durationMs)}${buffered ? `. ${buffered}` : ""}`} title={buffered ?? undefined}>
          {bufferPercent !== null ? <span className="np-progress-buffer" style={{ width: `${bufferPercent}%` }} /> : null}
          <span className="np-progress-played" style={{ width: `${percent}%` }} />
        </div>
        <div className="np-progress-times">
          <span>{formatClock(position)}</span>
          {left !== null ? (
            <TextTooltip className="np-time-left" trigger={<span aria-label={`${formatClock(left)} left`}>-{formatClock(left)}</span>}>
              <span className="np-time-total">Total {formatClock(stream.durationMs)}</span>
              <span>{endsAtLabel(stream, position, now, timeFormat === "12h")}</span>
            </TextTooltip>
          ) : <span>--:--</span>}
        </div>
        <div className={`np-summary${expanded ? " is-expanded" : ""}`}>
          {expanded ? (
            <span className="np-summary-heading">Details</span>
          ) : (
            <span className="np-summary-line">
              <span className={`np-badge np-method ${methodClass}`}>{playMethodLabel(stream)}</span>
              <span className="np-summary-text">{streamSummaryLine(stream)}</span>
            </span>
          )}
          <button type="button" className="np-details-toggle" aria-expanded={expanded} aria-controls={detailsId} aria-label="Stream details" title={expanded ? "Hide details" : "Show details"} onClick={() => onToggle(stream.id)}>
            <ChevronDown size={16} aria-hidden="true" />
          </button>
        </div>
        <StreamDetails stream={stream} id={detailsId} hidden={!expanded} />
      </div>
      <dl className="np-card-footer">
        <div className="np-footer-user"><dt className="sr-only">User</dt><dd title={stream.user.signedInAs ? `${stream.user.name}, signed in as ${stream.user.signedInAs}` : "User"}><UserRound size={13} aria-hidden="true" /><span className="np-footer-text">{stream.user.name}{stream.user.signedInAs ? <span className="np-footer-secondary"> · signed in as {stream.user.signedInAs}</span> : null}</span></dd></div>
        <div className="np-footer-server"><dt className="sr-only">Server</dt><dd>{showServerName ? <span className="np-server-name"><MediaServerIcon kind={stream.serverKind} size={13} decorative /><span className="np-footer-text">{stream.serverName}</span></span> : (
          // One server of each kind: the icon is enough, and hover, focus or a tap shows the name.
          <TextTooltip className="np-server-tooltip" trigger={<><MediaServerIcon kind={stream.serverKind} size={13} decorative /><span className="sr-only">{stream.serverName}</span></>}>{stream.serverName}</TextTooltip>
        )}</dd></div>
        <div className="np-footer-location"><dt className="sr-only">Location</dt><dd><StreamLocation network={stream.network} /></dd></div>
        {player ? <div className="np-footer-player"><dt className="sr-only">Player</dt><dd title={player.full}><MonitorSmartphone size={13} aria-hidden="true" /><span className="np-footer-text">{player.short}</span></dd></div> : null}
      </dl>
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
            <span>Message shown to {stream.user.name}{stream.serverKind !== "plex" ? " (if the app displays messages)" : ""}</span>
            <textarea value={message} maxLength={stream.serverKind === "dupelix" ? 200 : 250} rows={3} onChange={(event) => setMessage(event.target.value)} disabled={stop.isPending} />
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
  const { expanded, toggle } = useExpandedStreams();
  const serverFilter = useServerFilter();
  const servers = useMemo(() => snapshot?.servers ?? [], [snapshot]);
  const shownServers = servers.filter((server) => !serverFilter.hidden.has(server.id));
  // Cards name their server only when the icon alone could mean more than one server.
  // All servers count, not just the ones shown, so turning one off does not change the cards.
  const showServerNames = useMemo(() => servers.some((server, index) => servers.findIndex((other) => other.kind === server.kind) !== index), [servers]);
  const streams = useMemo(() => (snapshot?.streams ?? []).filter((stream) => !serverFilter.hidden.has(stream.serverId)), [snapshot, serverFilter.hidden]);
  // The pills count only the servers shown; host CPU, memory, network and GPU stay whole.
  const summary = useMemo(() => snapshot ? (streams.length === snapshot.streams.length ? snapshot.summary : summarizeStreams(streams)) : null, [snapshot, streams]);
  const now = useLiveTimestamp(streams.some((stream) => stream.state === "playing"), 1000);
  return (
    <>
      <QuickGlance snapshot={snapshot} summary={summary} host={host} connection={connection} />
      <ServerStatusList servers={servers} hidden={serverFilter.hidden} onToggle={serverFilter.toggle} />
      {serverFilter.error ? <p className="panel-message action-error" role="alert">{serverFilter.error instanceof Error ? serverFilter.error.message : "The server choice could not be saved."}</p> : null}
      {snapshot !== null && servers.length > 0 && shownServers.length === 0 ? (
        <section className="np-empty" role="status"><MonitorPlay size={22} /><p>No servers selected. Turn on a server above to see its streams.</p></section>
      ) : snapshot === null || (streams.length === 0 && shownServers.some((server) => server.status === "connecting")) ? (
        <p className="panel-message" role="status"><LoaderCircle className="is-spinning" size={16} /> Connecting to your media servers</p>
      ) : streams.length === 0 ? (
        <section className="np-empty" role="status"><MonitorPlay size={22} /><p>{shownServers.length < servers.length ? "Nothing is playing on the selected servers." : "Nothing is playing right now."}</p></section>
      ) : (
        <div className="np-cards" aria-label="Streams">
          {streams.map((stream) => <StreamCard key={stream.id} stream={stream} now={now} expanded={expanded.has(stream.id)} onToggle={toggle} onStop={setStopping} showServerName={showServerNames} />)}
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
    <Page title="Now Playing" subtitle="" hideHeader>
      <h1 className="sr-only">Now Playing</h1>
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
