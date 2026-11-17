import { describe, expect, it } from "vitest";
import { applyHostEvent, formatBytesPerSecond, formatClock, formatKbps, geoLabel, livePosition, playMethodLabel, qualityLabel, sparklinePoints, streamLocationLabel, streamQuality, streamSummaryLine, summaryPills, videoLabel } from "../src/client/nowPlayingPresentation";
import type { NowPlayingHostEvent, NowPlayingHostSample, NowPlayingMediaInfo } from "../src/shared/nowPlaying";

const sample = (at: number): NowPlayingHostSample => ({ at: new Date(at).toISOString(), cpuPercent: 10, memoryUsedBytes: 1, memoryTotalBytes: 2, networkInBps: 1, networkOutBps: 1, gpus: null });
const info: NowPlayingHostEvent["info"] = { networkScope: "host", interfaces: ["eth0"], gpuAvailable: false, sampleIntervalMs: 3000 };

describe("Now Playing presentation", () => {
  it("formats bitrates, link speeds, and clock times", () => {
    expect(formatKbps(850)).toBe("850 kbps");
    expect(formatKbps(12_500)).toBe("12.5 Mbps");
    expect(formatKbps(120_000)).toBe("120 Mbps");
    expect(formatKbps(null)).toBe("Unknown");
    expect(formatBytesPerSecond(1_500_000)).toBe("12.0 Mbps");
    expect(formatClock(3_725_000)).toBe("1:02:05");
    expect(formatClock(65_000)).toBe("1:05");
  });

  it("advances playing streams between updates and holds paused ones", () => {
    const reportedAt = new Date(1_000_000).toISOString();
    expect(livePosition({ state: "playing", positionMs: 10_000, durationMs: 60_000, reportedAt }, 1_005_000)).toBe(15_000);
    expect(livePosition({ state: "paused", positionMs: 10_000, durationMs: 60_000, reportedAt }, 1_005_000)).toBe(10_000);
    expect(livePosition({ state: "playing", positionMs: 58_000, durationMs: 60_000, reportedAt }, 1_005_000)).toBe(60_000);
  });

  it("labels play methods and media", () => {
    expect(playMethodLabel({ playMethod: "transcode", transcode: { engine: "hardware", hardwareDecode: null, hardwareEncode: "nvenc", speed: null, throttled: null, reasons: [], reasonsDerived: true } })).toBe("Transcode (HW)");
    expect(playMethodLabel({ playMethod: "transcode", transcode: null })).toBe("Transcode");
    expect(playMethodLabel({ playMethod: "directStream", transcode: null })).toBe("Direct stream");
    expect(videoLabel({ container: "mkv", videoCodec: "hevc", resolution: "4K", width: 3840, height: 2160, dynamicRange: "Dolby Vision", audioCodec: null, audioChannels: null, bitrateKbps: null })).toBe("HEVC 4K Dolby Vision");
  });

  it("orders the pills and shows a count only when it is not 0", () => {
    const base = { transcodeHardware: 1, transcodeCpu: 0, transcodeUnknown: 0, directStream: 0, directPlay: 2, paused: 0, totalKbps: 20_000, totalIsEstimate: false };
    expect(summaryPills(base).map((pill) => `${pill.key}=${pill.value}`)).toEqual(["total=3", "hw=1", "play=2", "bandwidth=20.0 Mbps"]);
    expect(summaryPills({ ...base, transcodeCpu: 1, directStream: 1, paused: 1 }).map((pill) => pill.key)).toEqual(["total", "hw", "cpu", "stream", "play", "paused", "bandwidth"]);
    expect(summaryPills({ ...base, transcodeHardware: 0, directPlay: 0, totalKbps: 0 }).map((pill) => `${pill.key}=${pill.value}`)).toEqual(["total=0", "bandwidth=0 kbps"]);
    expect(summaryPills({ ...base, transcodeUnknown: 1, totalIsEstimate: true }).map((pill) => `${pill.label}=${pill.value}`)).toContain("Transcode, engine not reported=1");
    expect(summaryPills({ ...base, totalIsEstimate: true }).at(-1)).toMatchObject({ label: "Bandwidth (est.)", value: "≈ 20.0 Mbps" });
  });

  it("keeps a bounded host history: the first event replaces it, later ones append", () => {
    const history = Array.from({ length: 5 }, (_value, index) => sample(index * 3000));
    let state = applyHostEvent({ info: null, samples: [] }, { info, samples: history });
    expect(state.samples).toHaveLength(5);
    state = applyHostEvent(state, { info, samples: [sample(15_000)] });
    expect(state.samples).toHaveLength(6);
    for (let index = 0; index < 120; index += 1) state = applyHostEvent(state, { info, samples: [sample(18_000 + index * 3000)] });
    expect(state.samples).toHaveLength(100);
  });

  it("draws sparkline points across the full width", () => {
    expect(sparklinePoints([0, 50, 100], 100)).toBe("0.0,32.0 60.0,16.0 120.0,0.0");
    expect(sparklinePoints([5], 100)).toBe("");
  });

  it("buckets resolutions into the quality labels of the folded card line", () => {
    const at = (resolution: string | null, width: number | null = null, height: number | null = null) => qualityLabel({ resolution, width, height });
    expect(at("4K")).toBe("4K");
    expect(at("2160p")).toBe("4K");
    expect(at("1080p")).toBe("1080p");
    expect(at("1080")).toBe("1080p");
    expect(at("720p")).toBe("720p");
    expect(at("576p")).toBe("SD");
    expect(at("480")).toBe("SD");
    expect(at("SD")).toBe("SD");
    // Letterboxed films report a short height, so the width decides.
    expect(at(null, 1920, 800)).toBe("1080p");
    expect(at(null, 3840, 1600)).toBe("4K");
    expect(at(null, 640, 360)).toBe("SD");
    expect(at(null)).toBeNull();
    expect(qualityLabel(null)).toBeNull();
  });

  it("folds bandwidth and quality into one line, with an arrow when a transcode changes the resolution", () => {
    const media = (overrides: Partial<NowPlayingMediaInfo>): NowPlayingMediaInfo => ({ container: "mkv", videoCodec: "h264", resolution: "1080p", width: 1920, height: 1080, dynamicRange: null, audioCodec: "aac", audioChannels: 2, bitrateKbps: null, ...overrides });
    const direct = { bandwidth: { kbps: 8_200, kind: "nominal" as const }, source: media({}), output: null, videoDecision: "directPlay" as const };
    expect(streamSummaryLine(direct)).toBe("8.2 Mbps · 1080p");
    const transcode = { bandwidth: { kbps: 10_500, kind: "nominal" as const }, source: media({ resolution: "4K", width: 3840, height: 2160 }), output: media({}), videoDecision: "transcode" as const };
    expect(streamQuality(transcode)).toBe("4K → 1080p");
    expect(streamSummaryLine(transcode)).toBe("10.5 Mbps · 4K → 1080p");
    // A transcode that keeps the resolution shows it once; a copied video ignores the output.
    expect(streamQuality({ ...transcode, source: media({}) })).toBe("1080p");
    expect(streamQuality({ ...transcode, videoDecision: "copy", output: media({ resolution: "720p" }) })).toBe("4K");
    expect(streamSummaryLine({ ...direct, bandwidth: { kbps: 54_000, kind: "estimate" } })).toBe("≈ 54.0 Mbps · 1080p");
    expect(streamSummaryLine({ ...direct, bandwidth: { kbps: null, kind: "nominal" } })).toBe("Bandwidth unknown · 1080p");
    // Music has no video, so the line names the audio format instead.
    expect(streamSummaryLine({ ...direct, source: media({ videoCodec: null, resolution: null, width: null, height: null, audioCodec: "flac" }) })).toBe("8.2 Mbps · FLAC Stereo");
  });

  it("labels the card's location from LAN or WAN and the plex.tv location, never the address", () => {
    expect(streamLocationLabel({ location: "lan", relayed: false, geo: null })).toBe("LAN");
    expect(streamLocationLabel({ location: "wan", relayed: true, geo: { city: "Example City", region: null, country: "Netherlands", code: "NL" } })).toBe("WAN relay · Example City, Netherlands");
    expect(streamLocationLabel({ location: null, relayed: false })).toBe("Unknown");
  });

  it("shows City, State for US clients and City, Country for everyone else", () => {
    const label = (geo: { city: string | null; region: string | null; country: string | null; code: string | null }) => geoLabel(geo);
    // US: the state replaces the country, and the region never appears next to a non-US country.
    expect(label({ city: "Sample Town", region: "Texas", country: "United States", code: "US" })).toBe("Sample Town, Texas");
    expect(label({ city: "Sample Town", region: "Texas", country: "United States", code: null })).toBe("Sample Town, Texas");
    expect(label({ city: "Sample Town", region: "Texas", country: null, code: "US" })).toBe("Sample Town, Texas");
    expect(label({ city: "Sample Town", region: null, country: "United States", code: "US" })).toBe("Sample Town, United States");
    expect(label({ city: null, region: "Texas", country: "United States", code: "US" })).toBe("Texas, United States");
    expect(label({ city: null, region: null, country: "United States", code: "US" })).toBe("United States");
    expect(label({ city: null, region: null, country: null, code: "US" })).toBe("United States");
    // Outside the US: the region is left out.
    expect(label({ city: "Example City", region: "Example Province", country: "Netherlands", code: "NL" })).toBe("Example City, Netherlands");
    expect(label({ city: null, region: "Example Province", country: "Netherlands", code: "NL" })).toBe("Netherlands");
    expect(label({ city: "Example City", region: null, country: null, code: null })).toBe("Example City");
    // A known non-US code wins over a stray US-looking country, and nothing produces an empty label.
    expect(label({ city: "Example City", region: "Example Province", country: "United States", code: "NL" })).toBe("Example City, United States");
    expect(label({ city: null, region: null, country: null, code: null })).toBeNull();
    expect(geoLabel(null)).toBeNull();
    expect(streamLocationLabel({ location: "wan", relayed: false, geo: { city: "Sample Town", region: "Texas", country: "United States", code: "US" } })).toBe("WAN · Sample Town, Texas");
  });
});
