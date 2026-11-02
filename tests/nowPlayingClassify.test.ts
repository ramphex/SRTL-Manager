import { describe, expect, it } from "vitest";
import { clampKbps, jellyfinPlayMethod, parseJellyfinSession, parsePlexSession, plexPlayMethod, resolutionLabel, summarizeStreams } from "../src/server/lib/nowPlaying/classify";
import {
  jellyfinAudioOnlyTranscode,
  jellyfinDirectPlay,
  jellyfinIdleSession,
  jellyfinRemux,
  jellyfinVideoTranscodeWithBurnIn,
  plexAudioOnlyTranscode,
  plexDirectPlayMovie,
  plexDirectStreamRemux,
  plexHardwareTranscodeEpisode,
  plexampTrack
} from "./nowPlayingFixtures";

const now = new Date("2026-11-02T12:00:00.000Z");

describe("Plex classification", () => {
  it("applies the decision rules: any transcode, else any copy, else direct play", () => {
    expect(plexPlayMethod("transcode", "copy")).toBe("transcode");
    expect(plexPlayMethod("copy", "transcode")).toBe("transcode");
    expect(plexPlayMethod("copy", "directPlay")).toBe("directStream");
    expect(plexPlayMethod("directPlay", "directPlay")).toBe("directPlay");
    expect(plexPlayMethod(null, "directPlay")).toBe("directPlay");
  });

  it("reads a direct play movie with its file, nominal bandwidth, and LAN address", () => {
    const { session, library } = plexDirectPlayMovie();
    const parsed = parsePlexSession(session, library, now)!;
    expect(parsed).toMatchObject({ sessionKey: "12", itemKey: "101", terminateId: "plex-session-abc", posterPath: "/library/metadata/101/thumb/1700000001", filePath: "/data/media/movies/Example Movie (2021)/Example Movie (2021).mkv" });
    expect(parsed.stream).toMatchObject({
      user: { id: "1", name: "alex_03" }, mediaType: "movie", title: "Example Movie", year: 2021, state: "playing", positionMs: 600_000, durationMs: 7_200_000,
      playMethod: "directPlay", videoDecision: "directPlay", audioDecision: "directPlay", output: null, transcode: null,
      source: { container: "mkv", videoCodec: "h264", resolution: "1080p", dynamicRange: "SDR", audioCodec: "eac3", audioChannels: 6 },
      bandwidth: { kbps: 12500, kind: "nominal" },
      network: { location: "lan", ip: "192.168.1.40", relayed: false, secure: true },
      player: { name: "Chrome", product: "Plex Web", platform: "Chrome", device: "Windows" },
      reportedAt: now.toISOString()
    });
  });

  it("reads a hardware transcode of 4K HDR with subtitle burn-in, source from the library and output from the transcoder", () => {
    const { session, library } = plexHardwareTranscodeEpisode();
    const stream = parsePlexSession(session, library, now)!.stream;
    expect(stream).toMatchObject({
      mediaType: "episode", grandparentTitle: "Example Show", episodeLabel: "S02E05", title: "The Fifth One",
      playMethod: "transcode", videoDecision: "transcode", audioDecision: "transcode",
      source: { videoCodec: "hevc", resolution: "4K", dynamicRange: "HDR10", audioCodec: "truehd", audioChannels: 8, container: "mkv" },
      output: { videoCodec: "h264", resolution: "1080p", dynamicRange: "SDR", audioCodec: "aac", audioChannels: 2, container: "mp4" },
      subtitle: { decision: "burn", codec: "pgs", language: "English" },
      network: { location: "wan", ip: "198.51.100.23" }
    });
    expect(stream.transcode).toMatchObject({ engine: "hardware", hardwareDecode: "nvdec", hardwareEncode: "nvenc", speed: 3.4, throttled: false, reasonsDerived: true });
    expect(stream.transcode!.reasons).toEqual(["Subtitle burn-in", "Video codec hevc to h264", "Resolution 4K to 1080p", "HDR10 tone mapping", "Audio codec truehd to aac"]);
    expect(parsePlexSession(session, library, now)!.posterPath).toBe("/library/metadata/200/thumb/1700000002");
  });

  it("counts an audio-only transcode as a CPU transcode, even when hardware was requested", () => {
    const { session, library } = plexAudioOnlyTranscode();
    const stream = parsePlexSession(session, library, now)!.stream;
    expect(stream).toMatchObject({ playMethod: "transcode", videoDecision: "copy", audioDecision: "transcode", state: "paused" });
    expect(stream.source).toMatchObject({ videoCodec: "hevc", dynamicRange: "Dolby Vision", audioCodec: "truehd" });
    expect(stream.output).toMatchObject({ videoCodec: "hevc", resolution: "4K", dynamicRange: "Dolby Vision", audioCodec: "ac3", audioChannels: 6 });
    expect(stream.transcode).toMatchObject({ engine: "cpu", hardwareEncode: null, throttled: true, speed: 0.6, reasons: ["Audio codec truehd to ac3"] });
  });

  it("reads a remux as a direct stream, explains the container change, and clamps placeholder bandwidth", () => {
    const { session, library } = plexDirectStreamRemux();
    const stream = parsePlexSession(session, library, now)!.stream;
    expect(stream).toMatchObject({ playMethod: "directStream", videoDecision: "copy", audioDecision: "copy", state: "buffering" });
    expect(stream.transcode?.reasons).toEqual(["Container avi to mkv"]);
    // INT32_MAX is a placeholder; the estimate from the bitrate is shown instead.
    expect(stream.bandwidth).toEqual({ kbps: 1500, kind: "estimate" });
    expect(stream.network).toMatchObject({ location: "wan", ip: "100.64.3.4" });
  });

  it("keeps Plexamp sessions without a Session.id, and has no video decision for music", () => {
    const { session, library } = plexampTrack();
    const parsed = parsePlexSession(session, library, now)!;
    expect(parsed.terminateId).toBeNull();
    expect(parsed.posterPath).toBe("/library/metadata/504/thumb/1");
    expect(parsed.stream).toMatchObject({ mediaType: "track", grandparentTitle: "Artist", playMethod: "directPlay", videoDecision: null, audioDecision: "directPlay" });
  });

  it("falls back to the session's own media without the library entry", () => {
    const { session } = plexHardwareTranscodeEpisode();
    const stream = parsePlexSession(session, null, now)!.stream;
    expect(stream.source).toMatchObject({ videoCodec: "hevc", audioCodec: "truehd", resolution: null });
    expect(parsePlexSession({ title: "no session key" }, null, now)).toBeNull();
  });
});

describe("Jellyfin classification", () => {
  it("refines PlayMethod with TranscodingInfo", () => {
    expect(jellyfinPlayMethod("DirectPlay", { IsVideoDirect: false })).toMatchObject({ method: "directPlay" });
    expect(jellyfinPlayMethod("DirectStream", null)).toMatchObject({ method: "directStream", video: "copy", audio: "copy" });
    expect(jellyfinPlayMethod("Transcode", { IsVideoDirect: true, IsAudioDirect: true })).toMatchObject({ method: "directStream" });
    expect(jellyfinPlayMethod("Transcode", { IsVideoDirect: true, IsAudioDirect: false })).toEqual({ method: "transcode", video: "copy", audio: "transcode" });
    expect(jellyfinPlayMethod("Transcode", { IsVideoDirect: false, IsAudioDirect: true })).toEqual({ method: "transcode", video: "transcode", audio: "copy" });
    expect(jellyfinPlayMethod("Transcode", null)).toEqual({ method: "transcode", video: null, audio: null });
  });

  it("reads a direct play with Dolby Vision and remote control support", () => {
    const parsed = parseJellyfinSession(jellyfinDirectPlay(), now)!;
    expect(parsed).toMatchObject({ sessionKey: "jf-session-1", remoteControl: true, terminateId: null, posterPath: "/Items/a1b2c3d4e5f60718293a4b5c6d7e8f90/Images/Primary?tag=f00dcafe" });
    expect(parsed.stream).toMatchObject({
      playMethod: "directPlay", output: null, transcode: null, positionMs: 600_000, durationMs: 7_200_000,
      source: { videoCodec: "hevc", resolution: "4K", dynamicRange: "Dolby Vision", audioCodec: "truehd", audioChannels: 8, bitrateKbps: 54_000 },
      bandwidth: { kbps: 54_000, kind: "estimate" }, network: { location: "lan", ip: "192.168.1.50" }
    });
  });

  it("never treats HardwareAccelerationType as proof of a GPU transcode, and reports burn-in from the reasons", () => {
    const parsed = parseJellyfinSession(jellyfinVideoTranscodeWithBurnIn(), now)!;
    expect(parsed.posterPath).toBe("/Items/c1b2c3d4e5f60718293a4b5c6d7e8f92/Images/Primary?tag=beef01");
    expect(parsed.stream).toMatchObject({
      mediaType: "episode", grandparentTitle: "Example Show", episodeLabel: "S01E01", playMethod: "transcode", videoDecision: "transcode", audioDecision: "transcode",
      output: { videoCodec: "h264", resolution: "1080p", dynamicRange: "SDR", audioCodec: "aac", container: "ts", bitrateKbps: 12_000 },
      subtitle: { decision: "burn", codec: "pgssub" },
      bandwidth: { kbps: 12_000, kind: "estimate" },
      network: { location: "wan", ip: "203.0.113.77" }
    });
    expect(parsed.stream.transcode).toEqual({ engine: "unknown", hardwareDecode: null, hardwareEncode: null, speed: null, throttled: null, reasons: ["Video codec not supported", "Subtitle codec not supported"], reasonsDerived: false });
  });

  it("counts an audio-only transcode as a CPU transcode and clamps an INT32_MAX bitrate", () => {
    const stream = parseJellyfinSession(jellyfinAudioOnlyTranscode(), now)!.stream;
    expect(stream).toMatchObject({ playMethod: "transcode", videoDecision: "copy", audioDecision: "transcode", state: "paused" });
    expect(stream.transcode).toMatchObject({ engine: "cpu", reasons: ["Audio codec not supported"] });
    expect(stream.output).toMatchObject({ videoCodec: "hevc", dynamicRange: "HDR10", audioCodec: "ac3", bitrateKbps: null });
    expect(stream.bandwidth).toEqual({ kbps: 54_000, kind: "estimate" });
  });

  it("reads a remux as a direct stream and notes clients without remote control", () => {
    const parsed = parseJellyfinSession(jellyfinRemux(), now)!;
    expect(parsed.remoteControl).toBe(false);
    expect(parsed.stream).toMatchObject({ playMethod: "directStream", videoDecision: "copy", audioDecision: "copy", output: { container: "mp4", bitrateKbps: 54_000 } });
    expect(parsed.stream.transcode?.reasons).toEqual(["Container not supported"]);
  });

  it("ignores sessions with nothing playing, even when TranscodingInfo lingers", () => {
    expect(parseJellyfinSession(jellyfinIdleSession(), now)).toBeNull();
  });
});

describe("shared helpers", () => {
  it("labels resolutions and clamps absurd bitrates", () => {
    expect(resolutionLabel(1920, 800)).toBe("1080p");
    expect(resolutionLabel(3840, 1600)).toBe("4K");
    expect(resolutionLabel(1280, 720)).toBe("720p");
    expect(resolutionLabel(720, 576)).toBe("576p");
    expect(resolutionLabel(null, null, "4k")).toBe("4K");
    expect(clampKbps(2_147_483_647)).toBeNull();
    expect(clampKbps(2_000_000)).toBeNull();
    expect(clampKbps(-5)).toBeNull();
    expect(clampKbps(8000.4)).toBe(8000);
  });

  it("summarizes streams by method and engine, excluding paused streams from bandwidth", () => {
    const plex = [plexDirectPlayMovie(), plexHardwareTranscodeEpisode(), plexAudioOnlyTranscode(), plexDirectStreamRemux()].map(({ session, library }) => parsePlexSession(session, library, now)!.stream);
    const jellyfin = [jellyfinDirectPlay(), jellyfinVideoTranscodeWithBurnIn()].map((session) => parseJellyfinSession(session, now)!.stream);
    expect(summarizeStreams([...plex, ...jellyfin])).toEqual({
      transcodeHardware: 1, transcodeCpu: 1, transcodeUnknown: 1, directStream: 1, directPlay: 2, paused: 1,
      // 12500 + 10500 + 1500 (buffering remux) + 54000 + 12000; the paused 61000 is excluded.
      totalKbps: 90_500, totalIsEstimate: true
    });
  });
});
