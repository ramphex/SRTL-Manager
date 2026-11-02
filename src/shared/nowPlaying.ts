// Now Playing: live sessions from the connected Plex and Jellyfin servers plus host load. Nothing here is stored.
import type { MediaServerKind } from "./mediaServers";

export type NowPlayingPlayMethod = "transcode" | "directStream" | "directPlay";
export type NowPlayingState = "playing" | "paused" | "buffering";
// "unknown" when the server does not prove where a transcode runs (Jellyfin video transcodes).
export type NowPlayingTranscodeEngine = "hardware" | "cpu" | "unknown";
export type NowPlayingDecision = "directPlay" | "copy" | "transcode";

export interface NowPlayingMediaInfo {
  container: string | null;
  videoCodec: string | null;
  // A short label such as "4K", "1080p", or "720p".
  resolution: string | null;
  width: number | null;
  height: number | null;
  // "HDR10", "HDR10+", "Dolby Vision", "HLG", or "SDR"; null when the server does not say.
  dynamicRange: string | null;
  audioCodec: string | null;
  audioChannels: number | null;
  bitrateKbps: number | null;
}

export interface NowPlayingTranscode {
  engine: NowPlayingTranscodeEngine;
  // Plex's hardware decoder and encoder names, such as "nvdec" and "nvenc".
  hardwareDecode: string | null;
  hardwareEncode: string | null;
  // Plex only: how fast the transcoder runs relative to playback, and whether it has caught up and is throttled.
  speed: number | null;
  throttled: boolean | null;
  reasons: string[];
  // Plex does not report reasons, so SRTL derives them from the source and output streams.
  reasonsDerived: boolean;
}

export interface NowPlayingGeo {
  city: string | null;
  region: string | null;
  country: string | null;
  code: string | null;
}

export type NowPlayingSourceStatus = "local" | "remote" | "broken" | "unlinked" | "unknown";

// Where the played file currently lives, according to SRTL's own link and storage records.
export interface NowPlayingSource {
  status: NowPlayingSourceStatus;
  // The storage location's friendly name, such as "Home NAS" for local storage.
  locationName: string | null;
  // The storage policy the title has in SRTL, when the link is known.
  policy: string | null;
}

export interface NowPlayingStream {
  // `${serverId}:${sessionKey}`, unique across servers.
  id: string;
  serverId: string;
  serverKind: MediaServerKind;
  serverName: string;
  // The server's own session id: Plex sessionKey, Jellyfin session Id.
  sessionKey: string;
  user: { id: string | null; name: string };
  mediaType: "movie" | "episode" | "track" | "other";
  title: string;
  // Show (or artist) title for episodes and tracks.
  grandparentTitle: string | null;
  // "S02E05" for episodes.
  episodeLabel: string | null;
  year: number | null;
  posterUrl: string | null;
  player: { name: string | null; device: string | null; platform: string | null; product: string | null; version: string | null };
  state: NowPlayingState;
  positionMs: number;
  durationMs: number | null;
  // When the server reported positionMs; the browser advances playing streams from here.
  reportedAt: string;
  playMethod: NowPlayingPlayMethod;
  videoDecision: NowPlayingDecision | null;
  audioDecision: NowPlayingDecision | null;
  subtitle: { decision: "burn" | "transcode" | "copy" | "directPlay" | null; codec: string | null; language: string | null } | null;
  source: NowPlayingMediaInfo;
  // What the client receives when the server changes the stream; null for direct play.
  output: NowPlayingMediaInfo | null;
  transcode: NowPlayingTranscode | null;
  // Plex reports a reserved ("nominal") bandwidth per stream; anything else is an estimate from bitrates.
  bandwidth: { kbps: number | null; kind: "nominal" | "estimate" };
  network: { location: "lan" | "wan" | null; ip: string | null; relayed: boolean; secure: boolean | null; geo: NowPlayingGeo | null };
  srtl: NowPlayingSource;
  stop: { available: boolean; reason: string | null };
}

export type NowPlayingServerStatus = "connecting" | "live" | "polling" | "unreachable" | "unauthorized" | "notConnected";

export interface NowPlayingServerState {
  id: string;
  name: string;
  kind: MediaServerKind;
  status: NowPlayingServerStatus;
  message: string | null;
  // "socket" when change events arrive over the server's websocket, "poll" otherwise.
  transport: "socket" | "poll";
  // Plex only: whether the owner's plex.tv account has an active Plex Pass. null until checked.
  plexPass: boolean | null;
  // Plex's own per-second streaming traffic from /statistics/bandwidth, in bytes per second.
  bandwidth: { lanBps: number; wanBps: number } | null;
  // Plex's own view of its host from /statistics/resources, in percent.
  resources: { hostCpu: number | null; processCpu: number | null; hostMemory: number | null; processMemory: number | null } | null;
  lastUpdatedAt: string | null;
}

export interface NowPlayingSummary {
  transcodeHardware: number;
  transcodeCpu: number;
  transcodeUnknown: number;
  directStream: number;
  directPlay: number;
  paused: number;
  // Sum of the playing streams' bandwidth; paused streams are excluded.
  totalKbps: number;
  // True when any stream's figure is an estimate rather than the server's nominal value.
  totalIsEstimate: boolean;
}

export interface NowPlayingSnapshot {
  generatedAt: string;
  servers: NowPlayingServerState[];
  streams: NowPlayingStream[];
  summary: NowPlayingSummary;
}

export interface NowPlayingGpuSample {
  index: number;
  name: string;
  utilization: number | null;
  encoder: number | null;
  decoder: number | null;
  memoryUsedMb: number | null;
  memoryTotalMb: number | null;
  encoderSessions: number | null;
  temperatureC: number | null;
}

export interface NowPlayingHostSample {
  at: string;
  cpuPercent: number | null;
  memoryUsedBytes: number | null;
  memoryTotalBytes: number | null;
  // Bytes per second across the host's physical interfaces; null until two readings exist.
  networkInBps: number | null;
  networkOutBps: number | null;
  gpus: NowPlayingGpuSample[] | null;
}

export interface NowPlayingHostInfo {
  // "host" when SRTL reads the host's interfaces; "container" when it only sees its own network namespace.
  networkScope: "host" | "container" | "unavailable";
  interfaces: string[];
  gpuAvailable: boolean;
  sampleIntervalMs: number;
}

export interface NowPlayingHostEvent {
  info: NowPlayingHostInfo;
  samples: NowPlayingHostSample[];
}

export interface NowPlayingSettings {
  // Look up the city and country of public client addresses with plex.tv.
  geoLookup: boolean;
}

export interface NowPlayingStopRequest {
  serverId: string;
  sessionKey: string;
  message: string;
}

export interface NowPlayingStopResult {
  // "stopped" when the stream is gone on the next check, "stillPlaying" when the server still lists it.
  result: "stopped" | "stillPlaying";
  message: string;
}

export const nowPlayingDefaultStopMessage = "This stream was stopped by the server administrator.";
