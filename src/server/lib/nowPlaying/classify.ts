import type {
  NowPlayingDecision,
  NowPlayingMediaInfo,
  NowPlayingPlayMethod,
  NowPlayingState,
  NowPlayingStream,
  NowPlayingTranscode
} from "../../../shared/nowPlaying";
import { isPrivateAddress, normalizeAddress } from "./geo";

// What a server reports about one session, before SRTL adds its own details (server name, poster URL, storage
// source, geo, stop availability).
export type ParsedStream = Omit<NowPlayingStream, "id" | "serverId" | "serverKind" | "serverName" | "posterUrl" | "srtl" | "stop">;

export interface ParsedSession {
  sessionKey: string;
  // The library item playing: Plex ratingKey, Jellyfin item Id, Dupelix title id.
  itemKey: string | null;
  stream: ParsedStream;
  // The file as the media server sees it, mapped to SRTL's links through the server's path mappings.
  filePath: string | null;
  // The server-relative artwork path, fetched through SRTL so tokens never reach the browser.
  posterPath: string | null;
  // Plex: the Session.id the terminate API needs. Plexamp and some players have none.
  terminateId: string | null;
  // Jellyfin: whether the client accepts remote or media control commands. Always false for Dupelix, which has no
  // remote stop yet.
  remoteControl: boolean;
}

type Json = Record<string, unknown>;

const int32Max = 2_147_483_647;
// Anything above 1 Gbps for one stream is a placeholder value, not a real bitrate.
const maxStreamKbps = 1_000_000;

function obj(value: unknown): Json | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Json : null;
}

function list(value: unknown): Json[] {
  return Array.isArray(value) ? value.map(obj).filter((entry): entry is Json => Boolean(entry)) : [];
}

function str(value: unknown): string | null {
  if (typeof value === "string") return value.trim() ? value : null;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

// Names and labels a server reports are cut to this length. Nothing real is this long, and every Now Playing
// broadcast passes these fields through the restricted-view scrubber.
export const maxReportedTextLength = 256;

// Display text: names, titles, players, codecs. Keys, ids and paths keep their full value through str.
function text(value: unknown): string | null {
  const found = str(value);
  if (!found || found.length <= maxReportedTextLength) return found;
  const cut = found.charCodeAt(maxReportedTextLength - 1);
  // Never ends on the first half of a surrogate pair.
  return found.slice(0, cut >= 0xd800 && cut <= 0xdbff ? maxReportedTextLength - 1 : maxReportedTextLength);
}

function num(value: unknown): number | null {
  const parsed = typeof value === "string" && value.trim() ? Number(value) : value;
  return typeof parsed === "number" && Number.isFinite(parsed) ? parsed : null;
}

function bool(value: unknown): boolean | null {
  if (value === true || value === "1" || value === 1 || value === "true") return true;
  if (value === false || value === "0" || value === 0 || value === "false") return false;
  return null;
}

function lower(value: unknown): string | null {
  return text(value)?.toLowerCase() ?? null;
}

// Clamps placeholder bitrates (INT32_MAX and similar) to "unknown".
export function clampKbps(kbps: number | null): number | null {
  if (kbps === null || !Number.isFinite(kbps) || kbps <= 0 || kbps >= int32Max / 1000 || kbps > maxStreamKbps) return null;
  return Math.round(kbps);
}

export function bpsToKbps(bps: number | null): number | null {
  if (bps === null || bps >= int32Max) return null;
  return clampKbps(bps / 1000);
}

export function resolutionLabel(width: number | null, height: number | null, hint?: string | null): string | null {
  const value = hint?.toLowerCase();
  if (value) {
    if (value === "4k") return "4K";
    if (value === "sd") return "SD";
    if (/^\d+$/.test(value)) return `${value}p`;
    if (/^\d+p$/.test(value)) return value;
  }
  if (!width && !height) return null;
  const w = width ?? 0;
  const h = height ?? 0;
  if (w >= 3200 || h >= 1800) return "4K";
  if (w >= 1800 || h >= 1000) return "1080p";
  if (w >= 1200 || h >= 700) return "720p";
  if (h >= 560) return "576p";
  return "SD";
}

export function episodeLabel(season: number | null, episode: number | null): string | null {
  if (season === null && episode === null) return null;
  return `S${String(season ?? 0).padStart(2, "0")}E${String(episode ?? 0).padStart(2, "0")}`;
}

function humanizeReason(reason: string): string {
  const spaced = reason.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/_/g, " ").trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
}

function emptyMedia(): NowPlayingMediaInfo {
  return { container: null, videoCodec: null, resolution: null, width: null, height: null, dynamicRange: null, audioCodec: null, audioChannels: null, bitrateKbps: null };
}

// An H.264 output is always SDR; other output codecs may keep HDR, which the servers do not report.
function outputDynamicRange(videoDecision: NowPlayingDecision | null, source: NowPlayingMediaInfo, outputCodec: string | null): string | null {
  if (videoDecision === "copy" || videoDecision === "directPlay") return source.dynamicRange;
  if (outputCodec === "h264") return "SDR";
  return null;
}

// ---------------------------------------------------------------- Plex

function plexDecision(value: unknown): NowPlayingDecision | null {
  const decision = lower(value)?.replace(/\s+/g, "");
  if (decision === "transcode") return "transcode";
  if (decision === "copy") return "copy";
  if (decision === "directplay") return "directPlay";
  return null;
}

// Any transcode means transcode; otherwise any copy means direct stream; otherwise direct play.
export function plexPlayMethod(video: NowPlayingDecision | null, audio: NowPlayingDecision | null): NowPlayingPlayMethod {
  if (video === "transcode" || audio === "transcode") return "transcode";
  if (video === "copy" || audio === "copy") return "directStream";
  return "directPlay";
}

function plexDynamicRange(stream: Json | null): string | null {
  if (!stream) return null;
  if (bool(stream.DOVIPresent) || num(stream.DOVIProfile) !== null) return "Dolby Vision";
  const transfer = lower(stream.colorTrc);
  if (transfer === "smpte2084") return "HDR10";
  if (transfer === "arib-std-b67") return "HLG";
  return "SDR";
}

function selectedEntry(entries: Json[]): Json | null {
  return entries.find((entry) => bool(entry.selected) === true) ?? entries[0] ?? null;
}

function plexStreams(part: Json | null): Json[] {
  return list(part?.Stream);
}

function plexStream(streams: Json[], type: 1 | 2 | 3): Json | null {
  const ofType = streams.filter((stream) => num(stream.streamType) === type);
  if (type === 3) return ofType.find((stream) => bool(stream.selected) === true) ?? null;
  return ofType.find((stream) => bool(stream.selected) === true) ?? ofType[0] ?? null;
}

function plexMediaInfo(media: Json | null): NowPlayingMediaInfo {
  if (!media) return emptyMedia();
  const part = selectedEntry(list(media.Part));
  const streams = plexStreams(part);
  const video = plexStream(streams, 1);
  const audio = plexStream(streams, 2);
  const width = num(media.width) ?? num(video?.width);
  const height = num(media.height) ?? num(video?.height);
  return {
    container: lower(media.container) ?? lower(part?.container),
    videoCodec: lower(media.videoCodec) ?? lower(video?.codec),
    resolution: resolutionLabel(width, height, text(media.videoResolution)),
    width,
    height,
    dynamicRange: video ? plexDynamicRange(video) : null,
    audioCodec: lower(media.audioCodec) ?? lower(audio?.codec),
    audioChannels: num(media.audioChannels) ?? num(audio?.channels),
    bitrateKbps: clampKbps(num(media.bitrate))
  };
}

// The library version that is playing: the session's media id when Plex reports it, otherwise the first.
function plexSourceMedia(sourceMetadata: Json | null, sessionMedia: Json | null): Json | null {
  const versions = list(sourceMetadata?.Media);
  if (!versions.length) return null;
  const id = str(sessionMedia?.id);
  return (id ? versions.find((media) => str(media.id) === id) : null) ?? versions[0] ?? null;
}

function plexFile(media: Json | null): string | null {
  return str(selectedEntry(list(media?.Part))?.file);
}

// Plex reports what it does but not why; the reasons are worked out from the source and output streams.
export function derivePlexReasons(source: NowPlayingMediaInfo, output: NowPlayingMediaInfo | null, video: NowPlayingDecision | null, audio: NowPlayingDecision | null, subtitleBurn: boolean): string[] {
  const reasons: string[] = [];
  if (subtitleBurn) reasons.push("Subtitle burn-in");
  if (video === "transcode") {
    const codecChanged = Boolean(source.videoCodec && output?.videoCodec && source.videoCodec !== output.videoCodec);
    const sourceHeight = source.height ?? 0;
    const outputHeight = output?.height ?? 0;
    if (codecChanged) reasons.push(`Video codec ${source.videoCodec} to ${output!.videoCodec}`);
    if (sourceHeight && outputHeight && outputHeight < sourceHeight) reasons.push(`Resolution ${source.resolution ?? sourceHeight} to ${output?.resolution ?? outputHeight}`);
    if (source.dynamicRange && source.dynamicRange !== "SDR" && output?.dynamicRange === "SDR") reasons.push(`${source.dynamicRange} tone mapping`);
    if (!codecChanged && !(sourceHeight && outputHeight && outputHeight < sourceHeight) && !subtitleBurn) reasons.push("Video bitrate or quality limit");
  }
  if (audio === "transcode") {
    const codecChanged = Boolean(source.audioCodec && output?.audioCodec && source.audioCodec !== output.audioCodec);
    reasons.push(codecChanged ? `Audio codec ${source.audioCodec} to ${output!.audioCodec}` : "Audio conversion");
  }
  if (video !== "transcode" && audio !== "transcode" && (video === "copy" || audio === "copy") && source.container && output?.container && source.container !== output.container) {
    reasons.push(`Container ${source.container} to ${output.container}`);
  }
  return reasons;
}

function plexState(value: unknown): NowPlayingState {
  const state = lower(value);
  return state === "paused" ? "paused" : state === "buffering" ? "buffering" : "playing";
}

function plexMediaType(value: unknown): ParsedStream["mediaType"] {
  const type = lower(value);
  return type === "movie" ? "movie" : type === "episode" ? "episode" : type === "track" ? "track" : "other";
}

// One entry of /status/sessions MediaContainer.Metadata. sourceMetadata is the item's /library/metadata entry,
// which describes the original file while the session's own Media describes the transcoder's output.
// A percent of the file turned into a position, kept within the file.
function bufferedFromPercent(percent: number | null, durationMs: number | null): number | null {
  if (percent === null || durationMs === null || durationMs <= 0 || percent < 0) return null;
  return Math.round(Math.min(100, percent) / 100 * durationMs);
}

// Plex's transcoder reports the furthest position it has ready in seconds (maxOffsetAvailable), and otherwise a percent done.
function plexBufferedMs(transcodeSession: Record<string, unknown> | null, durationMs: number | null): number | null {
  if (!transcodeSession) return null;
  if (bool(transcodeSession.complete) === true && durationMs !== null) return durationMs;
  const offset = num(transcodeSession.maxOffsetAvailable);
  if (offset !== null && offset >= 0) return Math.round(durationMs !== null ? Math.min(durationMs, offset * 1000) : offset * 1000);
  return bufferedFromPercent(num(transcodeSession.progress), durationMs);
}

export function parsePlexSession(raw: unknown, sourceMetadata: unknown, now: Date = new Date()): ParsedSession | null {
  const meta = obj(raw);
  const sessionKey = str(meta?.sessionKey);
  if (!meta || !sessionKey) return null;
  const player = obj(meta.Player);
  const session = obj(meta.Session);
  const user = obj(meta.User);
  const transcodeSession = obj(meta.TranscodeSession);
  const sessionMedia = selectedEntry(list(meta.Media));
  const sessionPart = selectedEntry(list(sessionMedia?.Part));
  const sessionStreams = plexStreams(sessionPart);
  const sourceMedia = plexSourceMedia(obj(sourceMetadata), sessionMedia);

  const sessionInfo = plexMediaInfo(sessionMedia);
  const hasVideo = Boolean(sessionInfo.videoCodec || plexStream(sessionStreams, 1) || lower(transcodeSession?.sourceVideoCodec));
  const hasAudio = Boolean(sessionInfo.audioCodec || plexStream(sessionStreams, 2) || lower(transcodeSession?.sourceAudioCodec));
  let videoDecision: NowPlayingDecision | null = hasVideo ? "directPlay" : null;
  let audioDecision: NowPlayingDecision | null = hasAudio ? "directPlay" : null;
  if (transcodeSession) {
    videoDecision = plexDecision(transcodeSession.videoDecision) ?? (hasVideo ? "directPlay" : null);
    audioDecision = plexDecision(transcodeSession.audioDecision) ?? (hasAudio ? "directPlay" : null);
  }
  const playMethod = plexPlayMethod(videoDecision, audioDecision);

  // Without the library entry, a direct play session's own media is the source; a transcode only names codecs.
  let source: NowPlayingMediaInfo;
  if (sourceMedia) source = plexMediaInfo(sourceMedia);
  else if (playMethod === "directPlay") source = sessionInfo;
  else {
    source = {
      ...emptyMedia(),
      videoCodec: lower(transcodeSession?.sourceVideoCodec) ?? (videoDecision === "copy" ? sessionInfo.videoCodec : null),
      audioCodec: lower(transcodeSession?.sourceAudioCodec) ?? (audioDecision === "copy" ? sessionInfo.audioCodec : null),
      ...(videoDecision === "copy" ? { width: sessionInfo.width, height: sessionInfo.height, resolution: sessionInfo.resolution, dynamicRange: sessionInfo.dynamicRange } : {})
    };
  }

  let output: NowPlayingMediaInfo | null = null;
  if (playMethod !== "directPlay") {
    const videoCopied = videoDecision === "copy";
    const width = videoCopied ? source.width : num(transcodeSession?.width) ?? sessionInfo.width;
    const height = videoCopied ? source.height : num(transcodeSession?.height) ?? sessionInfo.height;
    const videoCodec = videoDecision === null ? null : videoCopied ? source.videoCodec : lower(transcodeSession?.videoCodec) ?? sessionInfo.videoCodec;
    output = {
      container: lower(transcodeSession?.container) ?? sessionInfo.container,
      videoCodec,
      resolution: videoDecision === null ? null : videoCopied ? source.resolution : resolutionLabel(width, height),
      width: videoDecision === null ? null : width,
      height: videoDecision === null ? null : height,
      dynamicRange: videoDecision === null ? null : outputDynamicRange(videoDecision, source, videoCodec),
      audioCodec: audioDecision === "copy" ? source.audioCodec : lower(transcodeSession?.audioCodec) ?? sessionInfo.audioCodec,
      audioChannels: audioDecision === "copy" ? source.audioChannels : num(transcodeSession?.audioChannels) ?? sessionInfo.audioChannels,
      bitrateKbps: sessionInfo.bitrateKbps
    };
  }

  const subtitleStream = plexStream(sessionStreams, 3) ?? plexStream(plexStreams(selectedEntry(list(sourceMedia?.Part))), 3);
  const subtitleDecisionRaw = lower(transcodeSession?.subtitleDecision) ?? lower(subtitleStream?.decision);
  const burn = subtitleDecisionRaw === "burn" || bool(subtitleStream?.burn) === true;
  const subtitle = subtitleStream || subtitleDecisionRaw ? {
    decision: burn ? "burn" as const : subtitleDecisionRaw === "transcode" ? "transcode" as const : subtitleDecisionRaw === "copy" ? "copy" as const : subtitleStream ? "directPlay" as const : null,
    codec: lower(subtitleStream?.codec),
    language: text(subtitleStream?.language) ?? text(subtitleStream?.languageCode)
  } : null;

  let transcode: NowPlayingTranscode | null = null;
  if (playMethod === "transcode") {
    const hardwareEncode = videoDecision === "transcode" ? text(transcodeSession?.transcodeHwEncoding) : null;
    const hardwareDecode = videoDecision === "transcode" ? text(transcodeSession?.transcodeHwDecoding) : null;
    transcode = {
      // Audio is always converted on the CPU; a video transcode counts as hardware when Plex encodes on the GPU.
      engine: videoDecision === "transcode" && hardwareEncode ? "hardware" : "cpu",
      hardwareDecode,
      hardwareEncode,
      speed: num(transcodeSession?.speed),
      throttled: bool(transcodeSession?.throttled),
      reasons: derivePlexReasons(source, output, videoDecision, audioDecision, burn),
      reasonsDerived: true
    };
  } else if (playMethod === "directStream") {
    const reasons = derivePlexReasons(source, output, videoDecision, audioDecision, false);
    if (reasons.length) transcode = { engine: "cpu", hardwareDecode: null, hardwareEncode: null, speed: num(transcodeSession?.speed), throttled: bool(transcodeSession?.throttled), reasons, reasonsDerived: true };
  }

  const nominal = clampKbps(num(session?.bandwidth));
  const estimate = output?.bitrateKbps ?? source.bitrateKbps ?? sessionInfo.bitrateKbps;
  const local = bool(player?.local);
  const locationRaw = lower(session?.location);
  const location = locationRaw === "lan" || locationRaw === "wan" ? locationRaw : local === null ? null : local ? "lan" : "wan";
  const address = local === false ? text(player?.remotePublicAddress) ?? text(player?.address) : text(player?.address) ?? text(player?.remotePublicAddress);
  const mediaType = plexMediaType(meta.type);
  const posterPath = mediaType === "episode"
    ? str(meta.grandparentThumb) ?? str(meta.parentThumb) ?? str(meta.thumb)
    : mediaType === "track" ? str(meta.parentThumb) ?? str(meta.thumb) : str(meta.thumb);

  return {
    sessionKey,
    itemKey: str(meta.ratingKey),
    filePath: plexFile(sourceMedia) ?? plexFile(sessionMedia),
    posterPath,
    terminateId: str(session?.id),
    remoteControl: false,
    stream: {
      sessionKey,
      user: { id: str(user?.id), name: text(user?.title) ?? "Unknown user" },
      mediaType,
      title: text(meta.title) ?? "Unknown title",
      grandparentTitle: mediaType === "episode" || mediaType === "track" ? text(meta.grandparentTitle) : null,
      episodeLabel: mediaType === "episode" ? episodeLabel(num(meta.parentIndex), num(meta.index)) : null,
      year: num(meta.year),
      player: { name: text(player?.title), device: text(player?.device), platform: text(player?.platform), product: text(player?.product), version: text(player?.version) },
      state: plexState(player?.state),
      positionMs: Math.max(0, Math.round(num(meta.viewOffset) ?? 0)),
      durationMs: num(meta.duration),
      bufferedMs: playMethod === "directPlay" ? null : plexBufferedMs(transcodeSession, num(meta.duration)),
      reportedAt: now.toISOString(),
      playMethod,
      videoDecision,
      audioDecision,
      subtitle,
      source,
      output,
      transcode,
      bandwidth: nominal !== null ? { kbps: nominal, kind: "nominal" } : { kbps: estimate, kind: "estimate" },
      network: { location, ip: address ? normalizeAddress(address) : null, relayed: bool(player?.relayed) === true, secure: bool(player?.secure), geo: null }
    }
  };
}

// ---------------------------------------------------------------- Jellyfin

const ticksPerMs = 10_000;

function jellyfinDynamicRange(stream: Json | null): string | null {
  if (!stream) return null;
  const type = text(stream.VideoRangeType) ?? "";
  if (/^dovi/i.test(type)) return "Dolby Vision";
  if (/^hdr10plus$/i.test(type)) return "HDR10+";
  if (/^hdr10$/i.test(type)) return "HDR10";
  if (/^hlg$/i.test(type)) return "HLG";
  if (/^sdr$/i.test(type)) return "SDR";
  const range = lower(stream.VideoRange);
  return range === "hdr" ? "HDR" : range === "sdr" ? "SDR" : null;
}

function jellyfinReasons(value: unknown): string[] {
  const raw = Array.isArray(value) ? value.map(text).filter((entry): entry is string => Boolean(entry)) : (str(value) ?? "").split(",").map((entry) => text(entry.trim())).filter((entry): entry is string => Boolean(entry));
  return [...new Set(raw)].map(humanizeReason);
}

// PlayState.PlayMethod, refined by TranscodingInfo: a "transcode" that copies both video and audio is a remux,
// which is a direct stream. A transcode that converts only the audio is still a transcode, as on Plex.
export function jellyfinPlayMethod(playMethod: unknown, transcoding: Json | null): { method: NowPlayingPlayMethod; video: NowPlayingDecision | null; audio: NowPlayingDecision | null } {
  const method = lower(playMethod);
  if (method === "directplay") return { method: "directPlay", video: "directPlay", audio: "directPlay" };
  if (method === "directstream") return { method: "directStream", video: "copy", audio: "copy" };
  if (method === "transcode" || (!method && transcoding)) {
    if (!transcoding) return { method: "transcode", video: null, audio: null };
    const videoDirect = bool(transcoding.IsVideoDirect) === true;
    const audioDirect = bool(transcoding.IsAudioDirect) === true;
    if (videoDirect && audioDirect) return { method: "directStream", video: "copy", audio: "copy" };
    return { method: "transcode", video: videoDirect ? "copy" : "transcode", audio: audioDirect ? "copy" : "transcode" };
  }
  return { method: "directPlay", video: "directPlay", audio: "directPlay" };
}

function jellyfinMediaType(value: unknown): ParsedStream["mediaType"] {
  const type = lower(value);
  return type === "movie" ? "movie" : type === "episode" ? "episode" : type === "audio" ? "track" : "other";
}

function jellyfinImage(id: string | null, tag: string | null): string | null {
  if (!id || !tag || !/^[A-Za-z0-9-]{1,64}$/.test(id) || !/^[A-Za-z0-9]{1,64}$/.test(tag)) return null;
  return `/Items/${id}/Images/Primary?tag=${tag}`;
}

// One entry of /Sessions (or of the socket's "Sessions" message). Sessions without NowPlayingItem are idle.
export function parseJellyfinSession(raw: unknown, now: Date = new Date()): ParsedSession | null {
  const session = obj(raw);
  const item = obj(session?.NowPlayingItem);
  const sessionKey = str(session?.Id);
  if (!session || !item || !sessionKey) return null;
  const playState = obj(session.PlayState);
  const transcoding = obj(session.TranscodingInfo);
  const capabilities = obj(session.Capabilities);
  const streams = list(item.MediaStreams);
  const video = streams.find((stream) => lower(stream.Type) === "video") ?? null;
  const audioIndex = num(playState?.AudioStreamIndex);
  const audioStreams = streams.filter((stream) => lower(stream.Type) === "audio");
  const audio = (audioIndex !== null ? audioStreams.find((stream) => num(stream.Index) === audioIndex) : null) ?? audioStreams.find((stream) => bool(stream.IsDefault) === true) ?? audioStreams[0] ?? null;
  const subtitleIndex = num(playState?.SubtitleStreamIndex);
  const subtitleStream = subtitleIndex !== null && subtitleIndex >= 0 ? streams.find((stream) => lower(stream.Type) === "subtitle" && num(stream.Index) === subtitleIndex) ?? null : null;

  const width = num(video?.Width);
  const height = num(video?.Height);
  const sourceBps = num(item.Bitrate) ?? (num(video?.BitRate) !== null || num(audio?.BitRate) !== null ? (num(video?.BitRate) ?? 0) + (num(audio?.BitRate) ?? 0) : null);
  const source: NowPlayingMediaInfo = {
    container: lower(item.Container)?.split(",")[0] ?? null,
    videoCodec: lower(video?.Codec),
    resolution: video ? resolutionLabel(width, height) : null,
    width,
    height,
    dynamicRange: jellyfinDynamicRange(video),
    audioCodec: lower(audio?.Codec),
    audioChannels: num(audio?.Channels),
    bitrateKbps: bpsToKbps(sourceBps)
  };

  const decided = jellyfinPlayMethod(playState?.PlayMethod, transcoding);
  const playMethod = decided.method;
  const videoDecision = video ? decided.video : null;
  const audioDecision = audio || transcoding?.AudioCodec ? decided.audio : null;
  const reasons = playMethod === "directPlay" ? [] : jellyfinReasons(transcoding?.TranscodeReasons);
  const burn = playMethod === "transcode" && (lower(subtitleStream?.DeliveryMethod) === "encode" || reasons.some((reason) => reason.toLowerCase().startsWith("subtitle")));

  let output: NowPlayingMediaInfo | null = null;
  if (playMethod !== "directPlay") {
    const videoCopied = videoDecision !== "transcode";
    const outWidth = videoCopied ? source.width : num(transcoding?.Width);
    const outHeight = videoCopied ? source.height : num(transcoding?.Height);
    const videoCodec = !video ? null : videoCopied ? source.videoCodec : lower(transcoding?.VideoCodec);
    output = {
      container: lower(transcoding?.Container) ?? source.container,
      videoCodec,
      resolution: !video ? null : videoCopied ? source.resolution : resolutionLabel(outWidth, outHeight),
      width: video ? outWidth : null,
      height: video ? outHeight : null,
      dynamicRange: !video ? null : outputDynamicRange(videoDecision, source, videoCodec),
      audioCodec: audioDecision === "transcode" ? lower(transcoding?.AudioCodec) : source.audioCodec,
      audioChannels: audioDecision === "transcode" ? num(transcoding?.AudioChannels) : source.audioChannels,
      bitrateKbps: bpsToKbps(num(transcoding?.Bitrate))
    };
  }

  let transcode: NowPlayingTranscode | null = null;
  if (playMethod === "transcode") {
    // Jellyfin's HardwareAccelerationType is the server-wide setting, not proof that this stream uses the GPU.
    transcode = { engine: videoDecision === "transcode" ? "unknown" : "cpu", hardwareDecode: null, hardwareEncode: null, speed: null, throttled: null, reasons, reasonsDerived: false };
  } else if (playMethod === "directStream" && reasons.length) {
    transcode = { engine: "cpu", hardwareDecode: null, hardwareEncode: null, speed: null, throttled: null, reasons, reasonsDerived: false };
  }

  const endPoint = text(session.RemoteEndPoint);
  const ip = endPoint ? normalizeAddress(endPoint) : null;
  const mediaType = jellyfinMediaType(item.Type);
  const posterPath = mediaType === "episode"
    ? jellyfinImage(str(item.SeriesId), str(item.SeriesPrimaryImageTag)) ?? jellyfinImage(str(item.Id), str(obj(item.ImageTags)?.Primary))
    : mediaType === "track"
      ? jellyfinImage(str(item.AlbumId), str(item.AlbumPrimaryImageTag)) ?? jellyfinImage(str(item.Id), str(obj(item.ImageTags)?.Primary))
      : jellyfinImage(str(item.Id), str(obj(item.ImageTags)?.Primary));
  const runTicks = num(item.RunTimeTicks);

  return {
    sessionKey,
    itemKey: str(item.Id),
    filePath: str(item.Path),
    posterPath,
    terminateId: null,
    remoteControl: bool(session.SupportsRemoteControl) === true || bool(session.SupportsMediaControl) === true || bool(capabilities?.SupportsMediaControl) === true,
    stream: {
      sessionKey,
      user: { id: str(session.UserId), name: text(session.UserName) ?? "Unknown user" },
      mediaType,
      title: text(item.Name) ?? "Unknown title",
      grandparentTitle: mediaType === "episode" ? text(item.SeriesName) : mediaType === "track" ? text(item.AlbumArtist) ?? (Array.isArray(item.Artists) ? text(item.Artists[0]) : null) : null,
      episodeLabel: mediaType === "episode" ? episodeLabel(num(item.ParentIndexNumber), num(item.IndexNumber)) : null,
      year: num(item.ProductionYear),
      player: { name: text(session.DeviceName), device: null, platform: null, product: text(session.Client), version: text(session.ApplicationVersion) },
      state: bool(playState?.IsPaused) === true ? "paused" : "playing",
      positionMs: Math.max(0, Math.round((num(playState?.PositionTicks) ?? 0) / ticksPerMs)),
      durationMs: runTicks !== null ? Math.round(runTicks / ticksPerMs) : null,
      bufferedMs: playMethod === "directPlay" ? null : bufferedFromPercent(num(transcoding?.CompletionPercentage), runTicks !== null ? Math.round(runTicks / ticksPerMs) : null),
      reportedAt: now.toISOString(),
      playMethod,
      videoDecision,
      audioDecision,
      subtitle: subtitleStream ? {
        decision: burn ? "burn" : playMethod === "directPlay" ? "directPlay" : "copy",
        codec: lower(subtitleStream.Codec),
        language: text(subtitleStream.Language)
      } : null,
      source,
      output,
      transcode,
      bandwidth: { kbps: output?.bitrateKbps ?? source.bitrateKbps, kind: "estimate" },
      network: { location: ip ? (isPrivateAddress(ip) ? "lan" : "wan") : null, ip, relayed: false, secure: null, geo: null }
    }
  };
}

// ---------------------------------------------------------------- Dupelix

// One entry of Dupelix's GET /api/v1/activity/sessions (ActivitySession). Today it carries the account, profile,
// device, title, playback route, encoder, output height and position. Dupelix is adding a richer session (pause
// state, duration, show and episode, artwork, media info, address, bandwidth, file path); each of those is read
// when present and left empty when not, never guessed.

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Sessions Dupelix still lists after playback ended.
const dupelixEndedStates = new Set(["ended", "expired", "revoked", "stopped"]);
const dupelixHardwareEncoder = /(?:nvenc|qsv|vaapi|videotoolbox|amf|v4l2m2m|mediacodec|rkmpp|omx|mf)(?:$|[@_])/i;
const dupelixSoftwareEncoder = /^(?:lib[a-z0-9]+|software)$/i;

// The poster path SRTL keeps for a Dupelix session: the title it plays. The adapter turns it into a signed
// artwork URL when the browser asks for the picture.
export function dupelixPosterPath(titleId: string | null): string | null {
  return titleId && uuidPattern.test(titleId) ? `title:${titleId.toLowerCase()}` : null;
}

export function dupelixEncoderEngine(encoder: string | null): NowPlayingTranscode["engine"] {
  if (!encoder) return "unknown";
  if (dupelixHardwareEncoder.test(encoder)) return "hardware";
  if (dupelixSoftwareEncoder.test(encoder)) return "cpu";
  return "unknown";
}

// h264_nvenc, hevc_qsv, libx264, libx265, libsvtav1: the codec the encoder writes.
export function dupelixEncoderCodec(encoder: string | null): string | null {
  const value = encoder?.toLowerCase() ?? "";
  if (/^(?:h264_|libx264$|libopenh264$)/.test(value)) return "h264";
  if (/^(?:hevc_|h265_|libx265$)/.test(value)) return "hevc";
  if (/^(?:av1_|libsvtav1$|libaom-av1$|librav1e$)/.test(value)) return "av1";
  if (/^(?:vp9_|libvpx-vp9$)/.test(value)) return "vp9";
  return null;
}

function dupelixState(session: Json): NowPlayingState | null {
  const state = lower(session.state);
  if (state && dupelixEndedStates.has(state)) return null;
  const playback = lower(session.playbackState) ?? state;
  if (bool(session.paused) === true || bool(session.isPaused) === true || playback === "paused") return "paused";
  if (playback === "buffering") return "buffering";
  return "playing";
}

function dupelixDynamicRange(value: unknown): string | null {
  const range = lower(value)?.replace(/[\s_-]+/g, "");
  if (!range) return null;
  if (range.startsWith("dolbyvision") || range.startsWith("dovi") || range === "dv") return "Dolby Vision";
  if (range === "hdr10+" || range === "hdr10plus") return "HDR10+";
  if (range === "hdr10" || range === "pq") return "HDR10";
  if (range === "hlg") return "HLG";
  if (range === "sdr") return "SDR";
  if (range === "hdr") return "HDR";
  return null;
}

function kbpsField(media: Json | null, ...prefixes: string[]): number | null {
  for (const prefix of prefixes) {
    const kbps = num(media?.[`${prefix}Kbps`]);
    if (kbps !== null) return clampKbps(kbps);
    const bps = num(media?.[`${prefix}Bps`]);
    if (bps !== null) return bpsToKbps(bps);
  }
  return null;
}

// A media description such as the session's future `source` or `output`. Only fields that say their unit are read.
function dupelixMedia(media: Json | null): NowPlayingMediaInfo | null {
  if (!media) return null;
  const video = obj(media.video);
  const audio = obj(media.audio);
  const width = num(media.width) ?? num(video?.width);
  const height = num(media.height) ?? num(video?.height);
  const info: NowPlayingMediaInfo = {
    container: lower(media.container),
    videoCodec: lower(media.videoCodec) ?? lower(video?.codec),
    resolution: resolutionLabel(width, height, text(media.resolution)),
    width,
    height,
    dynamicRange: dupelixDynamicRange(media.dynamicRange ?? media.videoRange ?? video?.dynamicRange),
    audioCodec: lower(media.audioCodec) ?? lower(audio?.codec),
    audioChannels: num(media.audioChannels) ?? num(audio?.channels),
    bitrateKbps: kbpsField(media, "bitrate", "bitRate")
  };
  return Object.values(info).some((value) => value !== null) ? info : null;
}

function dupelixAudioDecision(reasonCode: string | null, source: NowPlayingMediaInfo, output: NowPlayingMediaInfo | null): NowPlayingDecision | null {
  if (reasonCode === "audio_converted" || reasonCode === "audio_downmixed") return "transcode";
  if (source.audioCodec && output?.audioCodec) return source.audioCodec === output.audioCodec && (source.audioChannels === null || output.audioChannels === null || source.audioChannels === output.audioChannels) ? "copy" : "transcode";
  return null;
}

const dupelixLevelCauses: Record<string, string> = {
  encoder_limited: "Quality lowered because the encoder is busy",
  network_limited: "Quality lowered for the network",
  client_requested: "Quality chosen by the player"
};

export function parseDupelixSession(raw: unknown, now: Date = new Date()): ParsedSession | null {
  const session = obj(raw);
  const title = obj(session?.title);
  const sessionKey = str(session?.id);
  if (!session || !title || !sessionKey) return null;
  const state = dupelixState(session);
  if (!state) return null;
  const titleId = str(title.id);
  const kind = lower(title.kind);
  const mediaType: ParsedStream["mediaType"] = kind === "movie" ? "movie" : kind === "episode" ? "episode" : "other";
  const route = lower(session.route);
  const reason = obj(session.reason);
  const reasonCode = lower(reason?.code);
  const encoder = text(session.encoder);
  const media = obj(session.media);
  const source = dupelixMedia(obj(session.source) ?? obj(media?.source)) ?? emptyMedia();
  const reportedOutput = dupelixMedia(obj(session.output) ?? obj(media?.output));
  const levelHeight = num(session.levelHeight);

  let playMethod: NowPlayingPlayMethod;
  let videoDecision: NowPlayingDecision | null;
  let audioDecision: NowPlayingDecision | null;
  if (route === "direct" || route === "stored_version") {
    // A stored version is a ready-made copy sent untouched, so it plays directly too.
    playMethod = "directPlay";
    videoDecision = "directPlay";
    audioDecision = "directPlay";
  } else if (route === "direct_stream") {
    videoDecision = "copy";
    audioDecision = dupelixAudioDecision(reasonCode, source, reportedOutput);
    // As on Plex and Jellyfin, a stream whose audio is converted counts as a transcode.
    playMethod = audioDecision === "transcode" ? "transcode" : "directStream";
  } else if (route === "transcode") {
    playMethod = "transcode";
    videoDecision = "transcode";
    audioDecision = dupelixAudioDecision(reasonCode, source, reportedOutput);
  } else {
    // A route this version of SRTL does not know yet: only an encoder proves that something is encoded.
    playMethod = encoder ? "transcode" : "directStream";
    videoDecision = null;
    audioDecision = null;
  }

  let output: NowPlayingMediaInfo | null = null;
  if (playMethod !== "directPlay") {
    const videoCopied = videoDecision === "copy";
    const height = reportedOutput?.height ?? levelHeight ?? (videoCopied ? source.height : null);
    const width = reportedOutput?.width ?? (videoCopied && height === source.height ? source.width : null);
    const videoCodec = reportedOutput?.videoCodec ?? (videoCopied ? source.videoCodec : dupelixEncoderCodec(encoder));
    output = {
      container: reportedOutput?.container ?? null,
      videoCodec,
      resolution: reportedOutput?.resolution ?? resolutionLabel(width, height),
      width,
      height,
      dynamicRange: reportedOutput?.dynamicRange ?? outputDynamicRange(videoDecision, source, videoCodec),
      audioCodec: reportedOutput?.audioCodec ?? (audioDecision === "copy" ? source.audioCodec : null),
      audioChannels: reportedOutput?.audioChannels ?? (audioDecision === "copy" ? source.audioChannels : null),
      bitrateKbps: reportedOutput?.bitrateKbps ?? null
    };
  }

  const reasons = playMethod === "directPlay" ? [] : [...new Set([text(reason?.message), dupelixLevelCauses[lower(session.levelCause) ?? ""] ?? null].filter((entry): entry is string => Boolean(entry)))];
  let transcode: NowPlayingTranscode | null = null;
  if (playMethod === "transcode") {
    // Only the video encoder is reported. Audio-only conversion runs on the CPU.
    const engine = videoDecision === "transcode" || videoDecision === null ? dupelixEncoderEngine(encoder) : "cpu";
    transcode = { engine, hardwareDecode: null, hardwareEncode: engine === "hardware" ? encoder : null, speed: null, throttled: null, reasons, reasonsDerived: false };
  } else if (playMethod === "directStream" && reasons.length) {
    transcode = { engine: "cpu", hardwareDecode: null, hardwareEncode: null, speed: null, throttled: null, reasons, reasonsDerived: false };
  }

  const subtitleInfo = obj(session.subtitle);
  const burn = reasonCode === "subtitle_burn_in_required" || bool(subtitleInfo?.burnIn) === true;
  const subtitle = subtitleInfo || burn ? {
    decision: burn ? "burn" as const : playMethod === "directPlay" ? "directPlay" as const : "copy" as const,
    codec: lower(subtitleInfo?.codec),
    language: text(subtitleInfo?.language)
  } : null;

  const show = obj(session.show);
  const season = num(session.seasonNumber) ?? num(title.seasonNumber);
  const episode = num(session.episodeNumber) ?? num(title.episodeNumber);
  const address = text(session.remoteAddress) ?? text(session.ipAddress) ?? text(session.clientAddress) ?? text(session.ip);
  const ip = address ? normalizeAddress(address) : null;
  const reportedLocation = lower(session.location) ?? lower(session.network);
  const local = bool(session.local) ?? bool(session.isLocal);
  const location = reportedLocation === "lan" || reportedLocation === "wan" ? reportedLocation : local !== null ? (local ? "lan" : "wan") : ip ? (isPrivateAddress(ip) ? "lan" : "wan") : null;
  const reportedBandwidth = kbpsField(session, "bandwidth");
  const duration = num(session.durationMs) ?? num(title.runtimeMs);
  const accountName = text(session.displayName) ?? text(session.signInDisplayName);
  const profileName = text(session.profileName);
  const userName = accountName && profileName && profileName.toLowerCase() !== accountName.toLowerCase() ? text(`${accountName} (${profileName})`) : accountName ?? profileName;
  const file = obj(session.file);

  return {
    sessionKey,
    itemKey: titleId,
    filePath: str(session.filePath) ?? str(file?.path) ?? null,
    posterPath: dupelixPosterPath(titleId),
    terminateId: null,
    remoteControl: false,
    stream: {
      sessionKey,
      user: { id: str(session.accountId), name: userName ?? "Unknown user" },
      mediaType,
      title: text(title.name) ?? "Unknown title",
      grandparentTitle: mediaType === "episode" ? text(show?.name) ?? text(session.showName) ?? text(title.showName) : null,
      episodeLabel: mediaType === "episode" ? episodeLabel(season, episode) : null,
      year: num(title.year),
      player: {
        name: text(session.deviceFriendlyName) ?? text(session.deviceName),
        device: text(session.deviceName),
        platform: text(session.platform),
        product: text(session.clientName) ?? text(session.appName),
        version: text(session.clientVersion) ?? text(session.appVersion)
      },
      state,
      positionMs: Math.max(0, Math.round(num(session.positionMs) ?? 0)),
      durationMs: duration !== null && duration > 0 ? Math.round(duration) : null,
      bufferedMs: null,
      reportedAt: now.toISOString(),
      playMethod,
      videoDecision,
      audioDecision,
      subtitle,
      source,
      output,
      transcode,
      bandwidth: reportedBandwidth !== null ? { kbps: reportedBandwidth, kind: "nominal" } : { kbps: output?.bitrateKbps ?? source.bitrateKbps, kind: "estimate" },
      network: { location, ip, relayed: bool(session.relayed) === true, secure: bool(session.secure), geo: null }
    }
  };
}

// Shared with the browser, which sums only the servers a person has chosen to show.
export { summarizeStreams } from "../../../shared/nowPlaying";
