import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runFfmpegWithProgress } from "../src/server/lib/copier";
import { containerSignatureMatches, evaluateFfmpegValidation, inspectMediaContent, probeMedia, type MediaProber } from "../src/server/lib/mediaIntegrity";

const mkvHeader = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]);
const healthyProbe: MediaProber = async () => ({ ok: true, error: "", durationSeconds: 60, streamTypes: ["video", "audio"] });
const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0 && spawnSync("ffprobe", ["-version"]).status === 0;

let root: string;

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "srtl-media-integrity-"));
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function writeFile(name: string, content: Buffer): Promise<string> {
  const filePath = path.join(root, name);
  await fs.writeFile(filePath, content);
  return filePath;
}

function mkvLike(size: number): Buffer {
  return Buffer.concat([mkvHeader, randomBytes(size - mkvHeader.length)]);
}

describe("container signatures", () => {
  it("recognizes common containers and declines unknown extensions", () => {
    expect(containerSignatureMatches(".mkv", mkvHeader)).toBe(true);
    expect(containerSignatureMatches(".mkv", Buffer.from("RIFF0000AVI "))).toBe(false);
    expect(containerSignatureMatches(".mp4", Buffer.from("\0\0\0\x20ftypisom"))).toBe(true);
    expect(containerSignatureMatches(".avi", Buffer.from("RIFF\0\0\0\0AVI LIST"))).toBe(true);
    const transportStream = Buffer.alloc(188 * 3);
    for (let offset = 0; offset < transportStream.length; offset += 188) transportStream[offset] = 0x47;
    expect(containerSignatureMatches(".ts", transportStream)).toBe(true);
    expect(containerSignatureMatches(".ts", Buffer.alloc(188 * 3))).toBe(false);
    expect(containerSignatureMatches(".xyz", Buffer.alloc(16))).toBeNull();
  });
});

describe("source content inspection", () => {
  it("passes a file with a valid header, real data, and a healthy probe", async () => {
    const filePath = await writeFile("healthy.mkv", mkvLike(2 * 1024 * 1024));
    expect(await inspectMediaContent(filePath, { prober: healthyProbe })).toMatchObject({ status: "pass", problems: [], durationSeconds: 60 });
  });

  it("rejects zero-filled headers and tails without probing junk", async () => {
    let probed = false;
    const prober: MediaProber = async () => { probed = true; return healthyProbe(""); };
    const zeroHead = await writeFile("zero-head.mkv", Buffer.concat([Buffer.alloc(128 * 1024), randomBytes(512 * 1024)]));
    const result = await inspectMediaContent(zeroHead, { prober });
    expect(result.status).toBe("fail");
    expect(result.problems.join()).toContain("starts with zero-filled data");
    expect(probed).toBe(false);
    const zeroTail = await writeFile("zero-tail.mkv", Buffer.concat([mkvLike(1024 * 1024), Buffer.alloc(1024 * 1024)]));
    expect((await inspectMediaContent(zeroTail, { prober: healthyProbe })).problems.join()).toContain("incomplete download");
  });

  it("warns on mislabeled containers, rejects unknown content, and rejects zero-filled middles", async () => {
    const wrongContainer = await writeFile("wrong.mkv", Buffer.concat([Buffer.from("RIFF\0\0\0\0AVI "), randomBytes(1024 * 1024)]));
    const mislabeled = await inspectMediaContent(wrongContainer, { prober: healthyProbe });
    expect(mislabeled).toMatchObject({ status: "pass", warnings: ["File is AVI content named .mkv"] });
    const unknownContent = await writeFile("unknown.mkv", Buffer.concat([Buffer.from("NOTMEDIA"), randomBytes(256 * 1024)]));
    expect((await inspectMediaContent(unknownContent, { prober: healthyProbe })).problems.join()).toContain("does not match the .mkv container format or any other known media format");
    const size = 8 * 1024 * 1024;
    const zeroMiddle = mkvLike(size);
    zeroMiddle.fill(0, Math.floor(size / 7), Math.floor((size * 5) / 7));
    const middlePath = await writeFile("zero-middle.mkv", zeroMiddle);
    expect((await inspectMediaContent(middlePath, { prober: healthyProbe })).problems.join()).toMatch(/of 6 sampled regions are zero-filled/);
  });

  it("rejects sparse placeholder files", async () => {
    const filePath = path.join(root, "hollow.mkv");
    const handle = await fs.open(filePath, "w");
    await handle.truncate(64 * 1024 * 1024);
    await handle.close();
    const result = await inspectMediaContent(filePath, { prober: healthyProbe });
    expect(result.status).toBe("fail");
    expect(result.problems.join()).toMatch(/hollow|starts with zero-filled/);
  });

  it("rejects missing video, implausible bitrate, and failed probes", async () => {
    const filePath = await writeFile("probed.mkv", mkvLike(1024 * 1024));
    expect((await inspectMediaContent(filePath, { prober: async () => ({ ok: true, error: "", durationSeconds: 60, streamTypes: ["audio"] }) })).problems).toContain("No video stream found");
    expect((await inspectMediaContent(filePath, { prober: async () => ({ ok: true, error: "", durationSeconds: 7200, streamTypes: ["video"] }) })).problems.join()).toContain("Bitrate is implausibly low");
    expect((await inspectMediaContent(filePath, { prober: async () => ({ ok: false, error: "Invalid data found when processing input", durationSeconds: null, streamTypes: [] }) })).problems.join()).toContain("ffprobe could not read the file");
  });

  it("compares against external size and runtime expectations", async () => {
    const size = 2 * 1024 * 1024;
    const filePath = await writeFile("expected.mkv", mkvLike(size));
    const smaller = await inspectMediaContent(filePath, { prober: healthyProbe, expectation: { source: "Radarr", sizeBytes: 5 * 1024 * 1024 } });
    expect(smaller.problems.join()).toContain("Radarr reports 5.0 MB for this file, but it is 2.0 MB");
    const larger = await inspectMediaContent(filePath, { prober: healthyProbe, expectation: { source: "Radarr", sizeBytes: size - 4096 } });
    expect(larger).toMatchObject({ status: "pass", warnings: [expect.stringContaining("Radarr reports")] });
    expect((await inspectMediaContent(filePath, { prober: healthyProbe, expectation: { source: "Radarr", sizeBytes: 120 } })).warnings).toEqual([]);
    const sample = await inspectMediaContent(filePath, { prober: healthyProbe, expectation: { source: "Radarr", sizeBytes: size, runtimeSeconds: 7200 } });
    expect(sample.problems.join()).toContain("looks like a sample or partial file");
    expect((await inspectMediaContent(filePath, { prober: healthyProbe, expectation: { source: "Radarr", sizeBytes: size, runtimeSeconds: 100 } })).status).toBe("pass");
  });
});

describe("ffmpeg validation evaluation", () => {
  const healthy = { exitCode: 0, stderr: "", reachedSeconds: 599.5, durationSeconds: 600 };

  it("passes complete streams and tolerates occasional damage", () => {
    expect(evaluateFfmpegValidation(healthy).status).toBe("pass");
    expect(evaluateFfmpegValidation({ ...healthy, stderr: "[mpegts @ 0x1] Packet corrupt (stream = 0, dts = 1).\n[mov @ 0x2] stream 0, timescale not set" }).status).toBe("pass");
    expect(evaluateFfmpegValidation({ ...healthy, reachedSeconds: null, durationSeconds: null }).status).toBe("pass");
  });

  it("fails on exit codes, structural damage, damage bursts, truncation, and overflowing errors", () => {
    expect(evaluateFfmpegValidation({ ...healthy, exitCode: 183, stderr: "Invalid data" }).status).toBe("fail");
    expect(evaluateFfmpegValidation({ ...healthy, stderr: "[matroska,webm @ 0x1] File ended prematurely" })).toEqual({ status: "fail", output: "[matroska,webm @ 0x1] File ended prematurely" });
    expect(evaluateFfmpegValidation({ ...healthy, stderr: Array.from({ length: 11 }, (_, index) => `[h264 @ 0x1] error while decoding MB ${index} 1`).join("\n") }).output).toContain("11 damaged packet or decoding errors");
    expect(evaluateFfmpegValidation({ ...healthy, reachedSeconds: 300 }).output).toContain("the file is truncated");
    expect(evaluateFfmpegValidation({ ...healthy, stderr: "[earlier command output truncated]\nlast line" }).status).toBe("fail");
  });
});

describe.runIf(hasFfmpeg)("real ffmpeg media", () => {
  let good: string;
  let size: number;

  beforeAll(async () => {
    good = path.join(root, "real.mkv");
    execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=24", "-f", "lavfi", "-i", "sine=frequency=440", "-t", "20", "-c:v", "mpeg4", "-q:v", "3", "-c:a", "aac", good]);
    size = (await fs.stat(good)).size;
  });

  async function variant(name: string, mutate: (content: Buffer) => Buffer): Promise<string> {
    return writeFile(name, mutate(await fs.readFile(good)));
  }

  it("passes a healthy file through the probe and both validation modes", async () => {
    expect(await probeMedia(good)).toMatchObject({ ok: true, streamTypes: expect.arrayContaining(["video", "audio"]) });
    expect((await inspectMediaContent(good)).status).toBe("pass");
    expect((await runFfmpegWithProgress("fast", good)).status).toBe("pass");
    expect((await runFfmpegWithProgress("deep", good)).status).toBe("pass");
  });

  it("fails truncated and half-zeroed files that ffmpeg alone exits cleanly on", async () => {
    const truncated = await variant("real-truncated.mkv", (content) => content.subarray(0, Math.floor(size / 2)));
    const halfZero = await variant("real-half-zero.mkv", (content) => { const copy = Buffer.from(content); copy.fill(0, Math.floor(size / 2)); return copy; });
    for (const filePath of [truncated, halfZero]) {
      expect((await runFfmpegWithProgress("fast", filePath)).status).toBe("fail");
      expect((await runFfmpegWithProgress("deep", filePath)).status).toBe("fail");
    }
    expect((await inspectMediaContent(halfZero)).problems.join()).toContain("incomplete download");
  });
});
