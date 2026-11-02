import { describe, expect, it } from "vitest";
import { applyHostEvent, formatBytesPerSecond, formatClock, formatKbps, livePosition, playMethodLabel, sparklinePoints, summaryPills, videoLabel } from "../src/client/nowPlayingPresentation";
import type { NowPlayingHostEvent, NowPlayingHostSample } from "../src/shared/nowPlaying";

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

  it("shows the unconfirmed-engine pill only when needed", () => {
    const base = { transcodeHardware: 1, transcodeCpu: 0, transcodeUnknown: 0, directStream: 0, directPlay: 2, paused: 0, totalKbps: 20_000, totalIsEstimate: false };
    expect(summaryPills(base).map((pill) => pill.key)).toEqual(["hw", "cpu", "stream", "play", "bandwidth"]);
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
});
