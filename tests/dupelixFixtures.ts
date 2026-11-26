// Dupelix GET /api/v1/activity/sessions entries, shaped after the ActivitySession schema in Dupelix's OpenAPI
// contract (revision 145). Ids, names and addresses are examples only.

type Json = Record<string, unknown>;

export const dupelixIds = {
  movie: "0b6f3c1e-8a52-4c1d-9e0a-5d3b7f2a6c01",
  episode: "1c7a4d2f-9b63-4d2e-8f1b-6e4c8a3b7d02",
  show: "2d8b5e3a-ac74-4e3f-9a2c-7f5d9b4c8e03",
  account: "3e9c6f4b-bd85-4f4a-8b3d-8a6eac5d9f04",
  device: "4fad7a5c-ce96-4a5b-9c4e-9b7fbd6eaa05",
  version: "5abe8b6d-dfa7-4b6c-8d5f-ac8ace7fbb06",
  artwork: "6bcf9c7e-eab8-4c7d-9e6a-bd9bdf8acc07",
  artworkSmall: "7cd0ad8f-fbc9-4d8e-8f7b-ceacea9bdd08",
  still: "8de1be9a-acda-4e9f-9a8c-dfbdfbacee09"
};

// A signed artwork link as Dupelix issues it to an API key: /api/v1/artwork/{id}/{expires}/k{key}_{account}.{mac}.
export function dupelixArtworkUrl(id: string, expiresAt = Date.now() + 9 * 24 * 60 * 60_000): string {
  return `/api/v1/artwork/${id}/${Math.floor(expiresAt / 1000)}/k${dupelixIds.device}_${dupelixIds.account}.c2lnbmF0dXJlX2V4YW1wbGU`;
}

export function dupelixTitle(overrides: Json = {}): Json {
  return { id: dupelixIds.movie, kind: "movie", identity: "confirmed", name: "Example Movie", year: 2024, available: true, versionCount: 1, accentColor: "#3a6ea5", ...overrides };
}

export function dupelixSession(overrides: Json = {}): Json {
  return {
    id: "9ef2cfab-bdeb-4fa0-8b9d-e0cefcbdff10",
    accountId: dupelixIds.account,
    displayName: "Alex",
    accountType: "adult",
    signInAccountId: dupelixIds.account,
    signInDisplayName: "Alex",
    profileName: "Alex",
    deviceName: "Apple TV 4K",
    deviceFriendlyName: "Living room",
    deviceSessionId: dupelixIds.device,
    platform: "tvOS",
    title: dupelixTitle(),
    versionId: dupelixIds.version,
    route: "direct",
    reason: { code: "direct_supported", message: "This device plays the file as it is." },
    levelHeight: null,
    levelCause: null,
    encoder: null,
    positionMs: 1_234_000,
    state: "active",
    startedAt: "2026-11-25T18:00:00.000Z",
    lastActivityAt: "2026-11-25T18:20:00.000Z",
    ...overrides
  };
}

export const dupelixHardwareTranscode = () => dupelixSession({
  id: "a0f3d0bc-cefc-4ab1-9cae-f1dfacdeaa11",
  displayName: "Sam",
  profileName: "Kids",
  deviceFriendlyName: null,
  deviceName: "Chrome on Windows",
  platform: "web",
  title: dupelixTitle({ id: dupelixIds.episode, kind: "episode", name: "Pilot", showId: dupelixIds.show, seasonNumber: 1, episodeNumber: 3, year: 2023 }),
  route: "transcode",
  reason: { code: "video_codec_unsupported", message: "This browser cannot play HEVC." },
  levelHeight: 720,
  levelCause: "network_limited",
  encoder: "h264_nvenc",
  positionMs: 60_000
});

export const dupelixDirectStream = () => dupelixSession({
  id: "b1a4e1cd-dfad-4bc2-8dbf-a2eabdefbb12",
  route: "direct_stream",
  reason: { code: "container_changed", message: "The container was changed for this device." },
  levelHeight: 2160
});

export const dupelixEnded = () => dupelixSession({ id: "c2b5f2de-eabe-4cd3-9eca-b3fbcefacc13", state: "ended" });

// The richer, key-readable session Dupelix is adding. Field names here are the ones SRTL reads when present.
export const dupelixRichSession = () => dupelixSession({
  id: "d3c6a3ef-fbcf-4de4-8fdb-c4acdfabdd14",
  title: dupelixTitle({ id: dupelixIds.episode, kind: "episode", name: "Pilot", seasonNumber: 1, episodeNumber: 3 }),
  route: "transcode",
  reason: { code: "audio_converted", message: "The audio was converted." },
  encoder: "libx264",
  levelHeight: 1080,
  state: "active",
  paused: true,
  durationMs: 2_700_000,
  show: { id: dupelixIds.show, name: "Example Show" },
  seasonNumber: 2,
  episodeNumber: 5,
  artwork: [
    { kind: "still", url: dupelixArtworkUrl(dupelixIds.still), width: 780, height: 439 },
    { kind: "poster", url: dupelixArtworkUrl(dupelixIds.artworkSmall), width: 320, height: 480 },
    { kind: "poster", url: dupelixArtworkUrl(dupelixIds.artwork), width: 780, height: 1170 }
  ],
  source: { container: "mkv", videoCodec: "hevc", width: 3840, height: 2160, dynamicRange: "HDR10", audioCodec: "truehd", audioChannels: 8, bitrateKbps: 42_000 },
  output: { container: "ts", videoCodec: "h264", width: 1920, height: 1080, audioCodec: "aac", audioChannels: 2, bitrateKbps: 8000 },
  remoteAddress: "203.0.113.25",
  bandwidthKbps: 8500,
  filePath: "/data/media/tv/Example Show/Season 02/Example Show - S02E05.mkv",
  clientName: "Dupelix for tvOS",
  clientVersion: "1.4.0"
});

// The session shape the Dupelix Coordinator previewed for the key-readable session (names may still shift).
export const dupelixPreviewSession = () => dupelixSession({
  id: "e4d7b4fa-acda-4ef5-9aec-d5bdeabcee15",
  title: dupelixTitle({
    id: dupelixIds.episode, kind: "episode", name: "Pilot", year: 2023, showId: dupelixIds.show, showName: "Example Show", seasonNumber: 1, episodeNumber: 3,
    artwork: [
      { kind: "still", url: dupelixArtworkUrl(dupelixIds.still), width: 780, height: 439 },
      { kind: "poster", url: dupelixArtworkUrl(dupelixIds.artworkSmall), width: 320, height: 480 }
    ]
  }),
  route: "transcode",
  reason: { code: "video_codec_unsupported", message: "This TV cannot play HEVC." },
  encoder: "h264_nvenc",
  levelHeight: 1080,
  paused: false,
  buffering: true,
  durationMs: 3_000_000,
  positionMs: 600_000,
  client: { product: "Dupelix for Android TV", version: "2.1.0" },
  source: { container: "mkv", videoCodec: "hevc", hdr: "dolby_vision", width: 3840, height: 2160, bitrateKbps: 38_000, audio: [{ codec: "eac3", channels: 6 }] },
  output: { container: "mp4", videoCodec: "h264", audioCodec: "eac3", width: 1920, height: 1080, hdr: "sdr", bitrateKbps: 9000 },
  video: { decision: "transcode", codec: "h264", language: null },
  audio: { decision: "copy", codec: "eac3", language: "eng" },
  subtitle: { decision: "burn", codec: "pgs", language: "English" },
  hardwareEncode: true,
  hardwareDecode: true,
  toneMapping: "gpu",
  encoderSpeed: 2.37,
  throttled: false,
  readyAheadMs: 45_000,
  throughputKbps: 9100,
  network: { local: false, secure: true },
  remoteAddress: "198.51.100.40",
  canStop: true
});

export const dupelixGuestSession = () => dupelixSession({ id: "f5e8c5ab-bdeb-4fa6-8bfd-e6cefbcdff16", displayName: "Guest", profileName: "Guest", accountType: "adult" });
