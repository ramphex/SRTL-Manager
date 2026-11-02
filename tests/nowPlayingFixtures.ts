// Representative /status/sessions (Plex) and /Sessions (Jellyfin) entries, shaped after real responses.
// Names, addresses, and paths are examples only.

type Json = Record<string, unknown>;

const plexPlayer = (overrides: Json = {}): Json => ({
  address: "192.168.1.40", device: "Windows", machineIdentifier: "player-1", platform: "Chrome", platformVersion: "130.0", product: "Plex Web",
  profile: "Web", remotePublicAddress: "203.0.113.10", state: "playing", title: "Chrome", version: "4.142.0", local: true, relayed: false, secure: true, userID: 1,
  ...overrides
});

function plexStreams(video: Json | null, audio: Json | null, subtitle?: Json): Json[] {
  return [
    ...(video ? [{ id: "1", streamType: 1, selected: true, ...video }] : []),
    ...(audio ? [{ id: "2", streamType: 2, selected: true, ...audio }] : []),
    ...(subtitle ? [{ id: "3", streamType: 3, selected: true, ...subtitle }] : [])
  ];
}

// A library entry from /library/metadata/<ratingKey>: describes the original file.
export function plexLibraryItem(ratingKey: string, media: { container: string; videoCodec?: string; width?: number; height?: number; videoResolution?: string; audioCodec: string; audioChannels: number; bitrate: number; file: string; video?: Json | null; subtitle?: Json }): Json {
  const video = media.videoCodec ? { codec: media.videoCodec, width: media.width, height: media.height, ...(media.video ?? {}) } : null;
  return {
    ratingKey, key: `/library/metadata/${ratingKey}`,
    Media: [{
      id: `m${ratingKey}`, container: media.container, videoCodec: media.videoCodec, width: media.width, height: media.height, videoResolution: media.videoResolution,
      audioCodec: media.audioCodec, audioChannels: media.audioChannels, bitrate: media.bitrate,
      Part: [{ id: `p${ratingKey}`, container: media.container, file: media.file, Stream: plexStreams(video, { codec: media.audioCodec, channels: media.audioChannels }, media.subtitle) }]
    }]
  };
}

export function plexDirectPlayMovie(): { session: Json; library: Json } {
  const library = plexLibraryItem("101", { container: "mkv", videoCodec: "h264", width: 1920, height: 1080, videoResolution: "1080", audioCodec: "eac3", audioChannels: 6, bitrate: 12000, file: "/data/media/movies/Example Movie (2021)/Example Movie (2021).mkv" });
  const session = {
    sessionKey: "12", ratingKey: "101", key: "/library/metadata/101", type: "movie", title: "Example Movie", year: 2021, duration: 7_200_000, viewOffset: 600_000,
    thumb: "/library/metadata/101/thumb/1700000001",
    Media: [{ ...(library.Media as Json[])[0], selected: true }],
    User: { id: "1", title: "alex_03" },
    Player: plexPlayer(),
    Session: { id: "plex-session-abc", bandwidth: 12500, location: "lan" }
  };
  return { session, library };
}

// 4K HDR10 HEVC transcoded to 1080p H.264 on the GPU, with PGS subtitles burned in.
export function plexHardwareTranscodeEpisode(): { session: Json; library: Json } {
  const library = plexLibraryItem("202", {
    container: "mkv", videoCodec: "hevc", width: 3840, height: 2160, videoResolution: "4k", audioCodec: "truehd", audioChannels: 8, bitrate: 58000,
    file: "/data/media/tv/Example Show/Season 02/Example Show - S02E05.mkv", video: { colorTrc: "smpte2084", bitDepth: 10 }, subtitle: { codec: "pgs", language: "English", selected: false }
  });
  const session = {
    sessionKey: "15", ratingKey: "202", type: "episode", title: "The Fifth One", grandparentTitle: "Example Show", parentIndex: 2, index: 5, duration: 3_000_000, viewOffset: 120_000,
    thumb: "/library/metadata/202/thumb/1", grandparentThumb: "/library/metadata/200/thumb/1700000002",
    Media: [{
      id: "m202", container: "mpegts", videoCodec: "h264", width: 1920, height: 1080, videoResolution: "1080", audioCodec: "aac", audioChannels: 2, bitrate: 10000, selected: true,
      Part: [{ id: "p202", decision: "transcode", selected: true, Stream: plexStreams({ codec: "h264", decision: "transcode" }, { codec: "aac", decision: "transcode" }, { codec: "pgs", language: "English", decision: "burn", burn: "1" }) }]
    }],
    User: { id: "7", title: "sam" },
    Player: plexPlayer({ local: false, address: "198.51.100.23", remotePublicAddress: "198.51.100.23", product: "Plex for Android (TV)", platform: "Android", device: "SHIELD Android TV", title: "Living Room" }),
    Session: { id: "plex-session-def", bandwidth: 10500, location: "wan" },
    TranscodeSession: {
      key: "/transcode/sessions/t1", throttled: false, complete: false, progress: 12.5, speed: 3.4, videoDecision: "transcode", audioDecision: "transcode", subtitleDecision: "burn",
      protocol: "dash", container: "mp4", videoCodec: "h264", audioCodec: "aac", audioChannels: 2, width: 1920, height: 1080,
      transcodeHwRequested: true, transcodeHwDecoding: "nvdec", transcodeHwEncoding: "nvenc", transcodeHwFullPipeline: false, sourceVideoCodec: "hevc", sourceAudioCodec: "truehd"
    }
  };
  return { session, library };
}

// Video copied, TrueHD audio converted to AC-3 on the CPU.
export function plexAudioOnlyTranscode(): { session: Json; library: Json } {
  const library = plexLibraryItem("303", { container: "mkv", videoCodec: "hevc", width: 3840, height: 2160, videoResolution: "4k", audioCodec: "truehd", audioChannels: 8, bitrate: 60000, file: "/data/media/movies/Big Film (2019)/Big Film (2019).mkv", video: { DOVIPresent: true, DOVIProfile: 8 } });
  const session = {
    sessionKey: "21", ratingKey: "303", type: "movie", title: "Big Film", year: 2019, duration: 8_000_000, viewOffset: 10_000, thumb: "/library/metadata/303/thumb/1",
    Media: [{ id: "m303", container: "mkv", videoCodec: "hevc", width: 3840, height: 2160, videoResolution: "4k", audioCodec: "ac3", audioChannels: 6, bitrate: 59000, selected: true, Part: [{ id: "p303", selected: true, Stream: plexStreams({ codec: "hevc", decision: "copy" }, { codec: "ac3", decision: "transcode" }) }] }],
    User: { id: "1", title: "alex_03" },
    Player: plexPlayer({ state: "paused", title: "Bedroom TV", product: "Plex for LG", platform: "webOS" }),
    Session: { id: "plex-session-ghi", bandwidth: 61000, location: "lan" },
    TranscodeSession: { key: "/transcode/sessions/t2", throttled: true, speed: 0.6, videoDecision: "copy", audioDecision: "transcode", container: "mkv", videoCodec: "hevc", audioCodec: "ac3", audioChannels: 6, transcodeHwRequested: true }
  };
  return { session, library };
}

// Remux: video and audio copied into a new container.
export function plexDirectStreamRemux(): { session: Json; library: Json } {
  const library = plexLibraryItem("404", { container: "avi", videoCodec: "mpeg4", width: 720, height: 400, videoResolution: "sd", audioCodec: "mp3", audioChannels: 2, bitrate: 1500, file: "/data/media/movies/Old Film (1999)/Old Film (1999).avi" });
  const session = {
    sessionKey: "30", ratingKey: "404", type: "movie", title: "Old Film", year: 1999, duration: 5_400_000, viewOffset: 1_000_000, thumb: "/library/metadata/404/thumb/1",
    Media: [{ id: "m404", container: "mkv", videoCodec: "mpeg4", width: 720, height: 400, audioCodec: "mp3", audioChannels: 2, bitrate: 1500, selected: true, Part: [{ id: "p404", selected: true, Stream: plexStreams({ codec: "mpeg4", decision: "copy" }, { codec: "mp3", decision: "copy" }) }] }],
    User: { id: "9", title: "sam" },
    Player: plexPlayer({ state: "buffering", local: false, address: "100.64.3.4", remotePublicAddress: "100.64.3.4" }),
    Session: { id: "plex-session-jkl", bandwidth: 2147483647, location: "wan" },
    TranscodeSession: { key: "/transcode/sessions/t3", speed: 25, throttled: true, videoDecision: "copy", audioDecision: "copy", container: "mkv", videoCodec: "mpeg4", audioCodec: "mp3", audioChannels: 2 }
  };
  return { session, library };
}

// Plexamp reports no Session.id, so Plex cannot terminate it.
export function plexampTrack(): { session: Json; library: Json } {
  const library = { ratingKey: "505", Media: [{ id: "m505", container: "flac", audioCodec: "flac", audioChannels: 2, bitrate: 900, Part: [{ id: "p505", file: "/data/media/music/Artist/Album/01 - Song.flac", Stream: [{ id: "1", streamType: 2, codec: "flac", channels: 2, selected: true }] }] }] };
  const session = {
    sessionKey: "40", ratingKey: "505", type: "track", title: "Song", grandparentTitle: "Artist", parentTitle: "Album", duration: 240_000, viewOffset: 30_000,
    thumb: "/library/metadata/505/thumb/1", parentThumb: "/library/metadata/504/thumb/1",
    Media: [{ id: "m505", container: "flac", audioCodec: "flac", audioChannels: 2, bitrate: 900, selected: true, Part: [{ id: "p505", selected: true, Stream: [{ id: "1", streamType: 2, codec: "flac", channels: 2, selected: true }] }] }],
    User: { id: "1", title: "alex_03" },
    Player: plexPlayer({ product: "Plexamp", platform: "iOS", title: "Phone" }),
    Session: { bandwidth: 1000, location: "lan" }
  };
  return { session, library };
}

const jellyfinBase = (overrides: Json): Json => ({
  Id: "jf-session-1", UserId: "user-1", UserName: "alex_03", Client: "Jellyfin Web", DeviceName: "Firefox", DeviceId: "device-1", ApplicationVersion: "10.10.3",
  RemoteEndPoint: "192.168.1.50", SupportsRemoteControl: true, SupportsMediaControl: true, IsActive: true,
  ...overrides
});

const jellyfinMovie = (streams: Json[], overrides: Json = {}): Json => ({
  Id: "a1b2c3d4e5f60718293a4b5c6d7e8f90", Name: "Example Movie", Type: "Movie", ProductionYear: 2021, RunTimeTicks: 72_000_000_000, Container: "mkv",
  Path: "/media/movies/Example Movie (2021)/Example Movie (2021).mkv", ImageTags: { Primary: "f00dcafe" }, MediaStreams: streams, ...overrides
});

const hevcHdr = { Type: "Video", Index: 0, Codec: "hevc", Width: 3840, Height: 2160, VideoRange: "HDR", VideoRangeType: "HDR10", BitRate: 50_000_000 };
const truehd = { Type: "Audio", Index: 1, Codec: "truehd", Channels: 8, BitRate: 4_000_000, IsDefault: true };

export function jellyfinDirectPlay(): Json {
  return jellyfinBase({
    PlayState: { PositionTicks: 6_000_000_000, IsPaused: false, PlayMethod: "DirectPlay", AudioStreamIndex: 1 },
    NowPlayingItem: jellyfinMovie([{ ...hevcHdr, VideoRangeType: "DOVIWithHDR10" }, truehd])
  });
}

// Video transcoded with PGS subtitles burned in; TranscodingInfo names the reasons.
export function jellyfinVideoTranscodeWithBurnIn(): Json {
  return jellyfinBase({
    Id: "jf-session-2", UserName: "sam", RemoteEndPoint: "203.0.113.77", Client: "Jellyfin Android TV", DeviceName: "Living Room TV",
    PlayState: { PositionTicks: 1_200_000_000, IsPaused: false, PlayMethod: "Transcode", AudioStreamIndex: 1, SubtitleStreamIndex: 2 },
    NowPlayingItem: {
      Id: "b1b2c3d4e5f60718293a4b5c6d7e8f91", Name: "Pilot", Type: "Episode", SeriesName: "Example Show", SeriesId: "c1b2c3d4e5f60718293a4b5c6d7e8f92", SeriesPrimaryImageTag: "beef01",
      ParentIndexNumber: 1, IndexNumber: 1, RunTimeTicks: 30_000_000_000, Container: "mkv", Path: "/media/tv/Example Show/Season 01/Example Show - S01E01.mkv",
      MediaStreams: [hevcHdr, truehd, { Type: "Subtitle", Index: 2, Codec: "PGSSUB", Language: "eng", DeliveryMethod: "Encode" }]
    },
    TranscodingInfo: {
      AudioCodec: "aac", VideoCodec: "h264", Container: "ts", IsVideoDirect: false, IsAudioDirect: false, Bitrate: 12_000_000, Width: 1920, Height: 1080, AudioChannels: 2,
      HardwareAccelerationType: "nvenc", TranscodeReasons: ["VideoCodecNotSupported", "SubtitleCodecNotSupported"]
    }
  });
}

// Video copied, TrueHD converted: Jellyfin reports PlayMethod "Transcode" with IsVideoDirect true.
export function jellyfinAudioOnlyTranscode(): Json {
  return jellyfinBase({
    Id: "jf-session-3",
    PlayState: { PositionTicks: 100_000_000, IsPaused: true, PlayMethod: "Transcode", AudioStreamIndex: 1 },
    NowPlayingItem: jellyfinMovie([hevcHdr, truehd]),
    TranscodingInfo: { AudioCodec: "ac3", VideoCodec: "hevc", Container: "mp4", IsVideoDirect: true, IsAudioDirect: false, Bitrate: 2_147_483_647, Width: 3840, Height: 2160, AudioChannels: 6, HardwareAccelerationType: "nvenc", TranscodeReasons: "AudioCodecNotSupported" }
  });
}

// Remux: both streams copied into a new container.
export function jellyfinRemux(): Json {
  return jellyfinBase({
    Id: "jf-session-4", SupportsRemoteControl: false, SupportsMediaControl: false,
    PlayState: { PositionTicks: 100_000_000, IsPaused: false, PlayMethod: "Transcode", AudioStreamIndex: 1 },
    NowPlayingItem: jellyfinMovie([hevcHdr, truehd]),
    TranscodingInfo: { AudioCodec: "truehd", VideoCodec: "hevc", Container: "mp4", IsVideoDirect: true, IsAudioDirect: true, Bitrate: 54_000_000, TranscodeReasons: ["ContainerNotSupported"] }
  });
}

export function jellyfinIdleSession(): Json {
  return jellyfinBase({ Id: "jf-idle", PlayState: { CanSeek: false }, TranscodingInfo: { IsVideoDirect: false } });
}
