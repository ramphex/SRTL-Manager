import type { NowPlayingGeo, NowPlayingHostEvent, NowPlayingHostInfo, NowPlayingHostSample, NowPlayingMediaInfo, NowPlayingStream, NowPlayingSummary } from "../shared/nowPlaying";

export const hostHistoryLimit = 100;

export function formatKbps(kbps: number | null): string {
  if (kbps === null || !Number.isFinite(kbps)) return "Unknown";
  if (kbps >= 1000) return `${(kbps / 1000).toFixed(kbps >= 100_000 ? 0 : 1)} Mbps`;
  return `${Math.round(kbps)} kbps`;
}

// Network counters are bytes per second; people read link speeds in bits.
export function formatBytesPerSecond(bytesPerSecond: number | null): string {
  if (bytesPerSecond === null || !Number.isFinite(bytesPerSecond)) return "—";
  return formatKbps((bytesPerSecond * 8) / 1000);
}

export function formatGigabytes(bytes: number | null): string {
  if (bytes === null) return "—";
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

export function formatClock(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return "--:--";
  const total = Math.floor(ms / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (value: number) => String(value).padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

// Playing streams advance from the server's last report so the progress bar moves between updates.
export function livePosition(stream: Pick<NowPlayingStream, "state" | "positionMs" | "durationMs" | "reportedAt">, now: number): number {
  const reported = Date.parse(stream.reportedAt);
  const elapsed = stream.state === "playing" && Number.isFinite(reported) ? Math.max(0, now - reported) : 0;
  const position = stream.positionMs + elapsed;
  return stream.durationMs ? Math.min(stream.durationMs, position) : position;
}

const codecNames: Record<string, string> = {
  h264: "H.264", hevc: "HEVC", h265: "HEVC", av1: "AV1", vp9: "VP9", mpeg2video: "MPEG-2", mpeg4: "MPEG-4", vc1: "VC-1",
  aac: "AAC", ac3: "AC3", eac3: "EAC3", truehd: "TrueHD", dts: "DTS", "dca": "DTS", "dts-hd ma": "DTS-HD MA", flac: "FLAC", mp3: "MP3", opus: "Opus", vorbis: "Vorbis", pcm: "PCM",
  srt: "SRT", subrip: "SRT", ass: "ASS", pgs: "PGS", pgssub: "PGS", vobsub: "VobSub", dvdsub: "VobSub", mov_text: "Text"
};

export function codecLabel(codec: string | null): string | null {
  if (!codec) return null;
  return codecNames[codec.toLowerCase()] ?? codec.toUpperCase();
}

export function channelsLabel(channels: number | null): string | null {
  if (!channels) return null;
  if (channels === 1) return "Mono";
  if (channels === 2) return "Stereo";
  if (channels === 6) return "5.1";
  if (channels === 8) return "7.1";
  return `${channels} ch`;
}

export function videoLabel(info: NowPlayingMediaInfo | null): string | null {
  if (!info || !info.videoCodec) return null;
  return [codecLabel(info.videoCodec), info.resolution, info.dynamicRange && info.dynamicRange !== "SDR" ? info.dynamicRange : null].filter(Boolean).join(" ");
}

export function audioLabel(info: NowPlayingMediaInfo | null): string | null {
  if (!info || !info.audioCodec) return null;
  return [codecLabel(info.audioCodec), channelsLabel(info.audioChannels)].filter(Boolean).join(" ");
}

export function playMethodLabel(stream: Pick<NowPlayingStream, "playMethod" | "transcode">): string {
  if (stream.playMethod === "directPlay") return "Direct play";
  if (stream.playMethod === "directStream") return "Direct stream";
  const engine = stream.transcode?.engine;
  return engine === "hardware" ? "Transcode (HW)" : engine === "cpu" ? "Transcode (CPU)" : "Transcode";
}

export function decisionLabel(decision: NowPlayingStream["videoDecision"]): string {
  return decision === "transcode" ? "Transcode" : decision === "copy" ? "Copy" : decision === "directPlay" ? "Direct" : "—";
}

// "City, State" for a client in the US, "City, Country" everywhere else. Missing parts drop out, so a US client
// without a city reads "State, United States" and the label is never empty or left with a dangling comma.
export function geoLabel(geo: NowPlayingGeo | null): string | null {
  if (!geo) return null;
  const clean = (value: string | null | undefined) => value?.trim() || null;
  const city = clean(geo.city);
  const region = clean(geo.region);
  const country = clean(geo.country);
  const code = clean(geo.code);
  const inUS = code ? code.toUpperCase() === "US" : country?.toLowerCase() === "united states";
  if (inUS) {
    // Without a city the state keeps the country beside it; without a state the country stands in for it.
    if (city) return `${city}, ${region ?? "United States"}`;
    return region ? `${region}, United States` : "United States";
  }
  return [city, country].filter(Boolean).join(", ") || region;
}

// One resolution bucket for the folded card line: 4K, 1440p, 1080p, 720p, or SD for anything below 720p.
export function qualityLabel(info: Pick<NowPlayingMediaInfo, "resolution" | "width" | "height"> | null): string | null {
  if (!info) return null;
  const hint = info.resolution?.trim().toLowerCase() ?? "";
  let height: number | null = null;
  if (hint === "4k" || hint === "uhd") return "4K";
  if (hint === "sd") return "SD";
  const numeric = /^(\d{3,4})p?$/.exec(hint);
  if (numeric) height = Number(numeric[1]);
  else if (info.width || info.height) {
    const w = info.width ?? 0;
    const h = info.height ?? 0;
    // Widescreen films are letterboxed, so the width decides as often as the height.
    height = w >= 3200 || h >= 1800 ? 2160 : w >= 1800 || h >= 1000 ? 1080 : w >= 1200 || h >= 700 ? 720 : Math.max(h, 1);
  }
  if (height === null) return null;
  if (height >= 1800) return "4K";
  if (height >= 1300) return "1440p";
  if (height >= 1000) return "1080p";
  if (height >= 700) return "720p";
  return "SD";
}

// "4K → 1080p" when a video transcode changes the resolution bucket, otherwise the one label.
export function streamQuality(stream: Pick<NowPlayingStream, "source" | "output" | "videoDecision">): string | null {
  const source = qualityLabel(stream.source);
  const output = stream.videoDecision === "transcode" ? qualityLabel(stream.output) : null;
  if (source && output && source !== output) return `${source} → ${output}`;
  return source ?? output;
}

export function streamBandwidthLabel(stream: Pick<NowPlayingStream, "bandwidth">): string {
  if (stream.bandwidth.kbps === null) return "Bandwidth unknown";
  return `${stream.bandwidth.kind === "estimate" ? "≈ " : ""}${formatKbps(stream.bandwidth.kbps)}`;
}

// The folded detail line on a stream card: bandwidth and quality side by side, such as "8.2 Mbps · 1080p".
// Audio-only streams fall back to the audio format.
export function streamSummaryLine(stream: Pick<NowPlayingStream, "bandwidth" | "source" | "output" | "videoDecision">): string {
  const quality = streamQuality(stream) ?? audioLabel(stream.output) ?? audioLabel(stream.source);
  return [streamBandwidthLabel(stream), quality].filter(Boolean).join(" · ");
}

// LAN or WAN with the plex.tv location when there is one. The client address is never part of this text.
export function streamLocationLabel(network: Pick<NowPlayingStream["network"], "location" | "relayed"> & { geo?: NowPlayingGeo | null }): string {
  const scope = network.location ? `${network.location.toUpperCase()}${network.relayed ? " relay" : ""}` : null;
  return [scope, geoLabel(network.geo ?? null)].filter(Boolean).join(" · ") || "Unknown";
}

export function streamTitle(stream: Pick<NowPlayingStream, "mediaType" | "title" | "grandparentTitle" | "episodeLabel" | "year">): { primary: string; secondary: string | null } {
  if (stream.mediaType === "episode" && stream.grandparentTitle) {
    return { primary: stream.grandparentTitle, secondary: [stream.episodeLabel, stream.title].filter(Boolean).join(" · ") };
  }
  if (stream.mediaType === "track" && stream.grandparentTitle) return { primary: stream.title, secondary: stream.grandparentTitle };
  return { primary: stream.title, secondary: stream.year ? String(stream.year) : null };
}

// The card shows the app and the player's name; the hover adds the device and platform when they say something new.
export function playerLabels(player: NowPlayingStream["player"]): { short: string; full: string } | null {
  const parts: string[] = [];
  for (const part of [player.product, player.name, player.device, player.platform]) {
    const text = part?.trim();
    if (text && !parts.some((seen) => seen.toLowerCase() === text.toLowerCase())) parts.push(text);
  }
  if (!parts.length) return null;
  return { short: parts.slice(0, 2).join(" · "), full: parts.join(" · ") };
}

type PillTone = "total" | "hw" | "cpu" | "unknown" | "stream" | "play" | "paused" | "bandwidth";

// Total streams first, then each play method and paused only when its count is not 0, then bandwidth.
// Paused streams are also counted under their play method.
export function summaryPills(summary: NowPlayingSummary): Array<{ key: string; label: string; value: string; tone: PillTone }> {
  const total = summary.transcodeHardware + summary.transcodeCpu + summary.transcodeUnknown + summary.directStream + summary.directPlay;
  const counts: Array<{ key: string; label: string; count: number; tone: PillTone }> = [
    { key: "hw", label: "HW transcode", count: summary.transcodeHardware, tone: "hw" },
    { key: "cpu", label: "CPU transcode", count: summary.transcodeCpu, tone: "cpu" },
    { key: "unknown", label: "Transcode, engine not reported", count: summary.transcodeUnknown, tone: "unknown" },
    { key: "stream", label: "Direct stream", count: summary.directStream, tone: "stream" },
    { key: "play", label: "Direct play", count: summary.directPlay, tone: "play" },
    { key: "paused", label: "Paused", count: summary.paused, tone: "paused" }
  ];
  return [
    { key: "total", label: "Streams", value: String(total), tone: "total" },
    ...counts.filter((pill) => pill.count > 0).map(({ count, ...pill }) => ({ ...pill, value: String(count) })),
    { key: "bandwidth", label: summary.totalIsEstimate ? "Bandwidth (est.)" : "Bandwidth", value: `${summary.totalIsEstimate ? "≈ " : ""}${formatKbps(summary.totalKbps)}`, tone: "bandwidth" }
  ];
}

export interface HostState {
  info: NowPlayingHostInfo | null;
  samples: NowPlayingHostSample[];
}

// The first event after connecting carries the server's history; later ones carry one new sample each.
export function applyHostEvent(state: HostState, event: NowPlayingHostEvent): HostState {
  const samples = event.samples.length > 1 || state.samples.length === 0 ? event.samples : [...state.samples, ...event.samples];
  return { info: event.info, samples: samples.slice(-hostHistoryLimit) };
}

export function busiestGpuEngine(sample: NowPlayingHostSample): number | null {
  const gpu = sample.gpus?.[0];
  if (!gpu) return null;
  const values = [gpu.utilization, gpu.encoder, gpu.decoder].filter((value): value is number => value !== null);
  return values.length ? Math.max(...values) : null;
}

export function sparklinePoints(values: Array<number | null>, max: number, width = 120, height = 32): string {
  if (values.length < 2 || max <= 0) return "";
  const step = width / (values.length - 1);
  return values.map((value, index) => value === null ? null : `${(index * step).toFixed(1)},${(height - Math.max(0, Math.min(1, value / max)) * height).toFixed(1)}`)
    .filter(Boolean).join(" ");
}
