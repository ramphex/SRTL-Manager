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

export function geoLabel(geo: NowPlayingGeo | null): string | null {
  if (!geo) return null;
  return [geo.city, geo.region, geo.country].filter(Boolean).join(", ") || null;
}

export function streamTitle(stream: Pick<NowPlayingStream, "mediaType" | "title" | "grandparentTitle" | "episodeLabel" | "year">): { primary: string; secondary: string | null } {
  if (stream.mediaType === "episode" && stream.grandparentTitle) {
    return { primary: stream.grandparentTitle, secondary: [stream.episodeLabel, stream.title].filter(Boolean).join(" · ") };
  }
  if (stream.mediaType === "track" && stream.grandparentTitle) return { primary: stream.title, secondary: stream.grandparentTitle };
  return { primary: stream.title, secondary: stream.year ? String(stream.year) : null };
}

export function summaryPills(summary: NowPlayingSummary): Array<{ key: string; label: string; value: string; tone: "hw" | "cpu" | "unknown" | "stream" | "play" | "bandwidth" }> {
  return [
    { key: "hw", label: "HW transcode", value: String(summary.transcodeHardware), tone: "hw" as const },
    { key: "cpu", label: "CPU transcode", value: String(summary.transcodeCpu), tone: "cpu" as const },
    ...(summary.transcodeUnknown > 0 ? [{ key: "unknown", label: "Transcode, engine not reported", value: String(summary.transcodeUnknown), tone: "unknown" as const }] : []),
    { key: "stream", label: "Direct stream", value: String(summary.directStream), tone: "stream" as const },
    { key: "play", label: "Direct play", value: String(summary.directPlay), tone: "play" as const },
    { key: "bandwidth", label: summary.totalIsEstimate ? "Bandwidth (est.)" : "Bandwidth", value: `${summary.totalIsEstimate ? "≈ " : ""}${formatKbps(summary.totalKbps)}`, tone: "bandwidth" as const }
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
