import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { withFilesystemTimeout } from "./filesystemSafety";
import { appendBoundedOutput, terminateChildProcess } from "./processSafety";

const sampleBytes = 64 * 1024;
const middleSampleCount = 6;
const hollowMinimumBytes = 50 * 1024 * 1024;
const hollowAllocationRatio = 0.01;
const minimumVideoBitsPerSecond = 64_000;
const probeTimeoutMs = 120_000;
// ffmpeg reports the last processed timestamp; anything short of this fraction of the stated duration is a truncated stream.
const minimumReachedFraction = 0.98;
const reachedSlackSeconds = 2;
const runtimeShortfallRatio = 0.5;
// A recorded size this small cannot be a movie; it means the size of a symlink was recorded instead of its target.
const minimumTrustedExpectedBytes = 1024 * 1024;

export interface MediaExpectation {
  source: string;
  sizeBytes?: number;
  runtimeSeconds?: number;
}

export interface MediaInspection {
  status: "pass" | "fail";
  problems: string[];
  warnings: string[];
  durationSeconds: number | null;
}

export interface MediaProbe {
  ok: boolean;
  error: string;
  durationSeconds: number | null;
  streamTypes: string[];
}

export type MediaProber = (filePath: string, signal?: AbortSignal) => Promise<MediaProbe>;

export interface FfmpegRunOutcome {
  exitCode: number | null;
  stderr: string;
  reachedSeconds: number | null;
  durationSeconds: number | null;
}

// Container-structure messages that mean the file is damaged, not merely unusual.
const fatalFfmpegPatterns = [
  /File ended prematurely/i,
  /invalid as first byte of an EBML number/i,
  /exceeds containing master element/i,
  /Invalid data found when processing input/i,
  /moov atom not found/i,
  /stream \d+, offset 0x[0-9a-f]+: partial file/i
];
// Packet and decoder complaints also appear in playable recordings; a handful are tolerated, a burst is not.
const damagePattern = /Packet corrupt|error while decoding|concealing \d+ (?:DC|AC|MV) errors|Invalid NAL unit|corrupt (?:decoded )?frame/i;
const tolerableDamageLines = 10;

function bytesLabel(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${bytes} bytes`;
}

function minutesLabel(seconds: number): string {
  return `${Math.round(seconds / 60)} min`;
}

const zeroBlock = Buffer.alloc(sampleBytes);

function isAllZero(buffer: Buffer): boolean {
  return buffer.length > 0 && buffer.equals(zeroBlock.subarray(0, buffer.length));
}

function hasPacketSync(buffer: Buffer, offset: number, stride: number): boolean {
  return buffer.length > offset + stride * 2 && buffer[offset] === 0x47 && buffer[offset + stride] === 0x47 && buffer[offset + stride * 2] === 0x47;
}

// Returns null when the extension has no reliable signature to check.
export function containerSignatureMatches(extension: string, head: Buffer): boolean | null {
  const ascii = (start: number, end: number) => head.subarray(start, end).toString("latin1");
  switch (extension) {
    case ".mkv":
    case ".webm":
      return head.length >= 4 && head.readUInt32BE(0) === 0x1a45dfa3;
    case ".mp4":
    case ".m4v":
    case ".mov":
    case ".3gp":
    case ".3g2":
      return head.length >= 8 && ["ftyp", "moov", "mdat", "free", "wide", "skip", "pnot"].includes(ascii(4, 8));
    case ".ts":
      return hasPacketSync(head, 0, 188) || hasPacketSync(head, 4, 192);
    case ".m2ts":
    case ".mts":
      return hasPacketSync(head, 4, 192) || hasPacketSync(head, 0, 188);
    case ".avi":
      return head.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "AVI ";
    case ".mpg":
    case ".mpeg":
      return head.length >= 4 && head[0] === 0 && head[1] === 0 && head[2] === 1 && (head[3] === 0xba || head[3] === 0xb3);
    case ".wmv":
      return head.length >= 4 && head.readUInt32BE(0) === 0x3026b275;
    case ".flv":
      return ascii(0, 3) === "FLV";
    default:
      return null;
  }
}

const recognizedContainers: Array<[label: string, extension: string]> = [["MKV", ".mkv"], ["MP4", ".mp4"], ["MPEG-TS", ".ts"], ["AVI", ".avi"], ["MPEG-PS", ".mpg"], ["WMV", ".wmv"], ["FLV", ".flv"]];

export function detectContainer(head: Buffer): string | null {
  return recognizedContainers.find(([, extension]) => containerSignatureMatches(extension, head))?.[0] ?? null;
}

async function readSample(handle: fs.FileHandle, position: number, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, position);
  return buffer.subarray(0, bytesRead);
}

function spawnCapture(command: string, args: string[], signal?: AbortSignal): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new Error("Operation aborted"));
      return;
    }
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result: { code: number | null; stdout: string; stderr: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      signal?.removeEventListener("abort", abort);
      resolve(result);
    };
    const abort = () => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      terminateChildProcess(child);
      reject(signal?.reason instanceof Error ? signal.reason : new Error("Operation aborted"));
    };
    const deadline = setTimeout(() => {
      terminateChildProcess(child);
      finish({ code: null, stdout, stderr: `${command} timed out after ${probeTimeoutMs / 1_000} seconds` });
    }, probeTimeoutMs);
    deadline.unref();
    signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => { stdout = appendBoundedOutput(stdout, chunk); });
    child.stderr.on("data", (chunk: Buffer) => { stderr = appendBoundedOutput(stderr, chunk); });
    child.on("error", (error) => finish({ code: null, stdout, stderr: error.message }));
    child.on("close", (code) => finish({ code, stdout, stderr }));
  });
}

export const probeMedia: MediaProber = async (filePath, signal) => {
  // A bounded probe reads a few megabytes, which keeps remote sources cheap to check before a full transfer.
  const result = await spawnCapture("ffprobe", ["-v", "error", "-probesize", "50M", "-analyzeduration", "20M", "-show_entries", "format=duration:stream=codec_type", "-of", "json", filePath], signal);
  if (result.code !== 0) return { ok: false, error: result.stderr.trim() || "ffprobe exited non-zero", durationSeconds: null, streamTypes: [] };
  try {
    const parsed = JSON.parse(result.stdout) as { format?: { duration?: string }; streams?: Array<{ codec_type?: string }> };
    const duration = Number(parsed.format?.duration);
    return {
      ok: true,
      error: "",
      durationSeconds: Number.isFinite(duration) && duration > 0 ? duration : null,
      streamTypes: (parsed.streams ?? []).map((stream) => stream.codec_type ?? "unknown")
    };
  } catch {
    return { ok: false, error: "ffprobe returned unreadable output", durationSeconds: null, streamTypes: [] };
  }
};

export async function inspectMediaContent(
  filePath: string,
  options: { expectation?: MediaExpectation; prober?: MediaProber; signal?: AbortSignal } = {}
): Promise<MediaInspection> {
  const problems: string[] = [];
  const warnings: string[] = [];
  const stat = await withFilesystemTimeout(fs.stat(filePath), `Media inspection stat for ${filePath}`);
  if (stat.size === 0) return { status: "fail", problems: ["File is empty"], warnings, durationSeconds: null };

  // Some network filesystems report zero blocks for real files, so only a small non-zero allocation is trusted.
  const allocated = stat.blocks * 512;
  if (stat.size >= hollowMinimumBytes && stat.blocks > 0 && allocated < stat.size * hollowAllocationRatio) {
    problems.push(`File is hollow: only ${bytesLabel(allocated)} of ${bytesLabel(stat.size)} is stored on disk`);
  }

  const handle = await withFilesystemTimeout(fs.open(filePath, "r"), `Media inspection open for ${filePath}`);
  try {
    const head = await withFilesystemTimeout(readSample(handle, 0, Math.min(sampleBytes, stat.size)), `Media inspection read for ${filePath}`);
    const tail = await withFilesystemTimeout(readSample(handle, Math.max(0, stat.size - sampleBytes), Math.min(sampleBytes, stat.size)), `Media inspection read for ${filePath}`);
    if (isAllZero(head)) problems.push("File starts with zero-filled data instead of a media header");
    else {
      const extension = path.extname(filePath).toLowerCase();
      if (containerSignatureMatches(extension, head) === false) {
        // A known container under the wrong extension still plays; ffprobe below decides whether it is readable.
        const detected = detectContainer(head);
        if (detected) warnings.push(`File is ${detected} content named ${extension}`);
        else problems.push(`File content does not match the ${extension} container format or any other known media format`);
      }
    }
    if (stat.size > sampleBytes * 2 && isAllZero(tail)) problems.push("File ends with zero-filled data, which usually means an incomplete download");

    if (stat.size > sampleBytes * (middleSampleCount + 2)) {
      let zeroSamples = 0;
      for (let index = 1; index <= middleSampleCount; index += 1) {
        const position = Math.floor((stat.size * index) / (middleSampleCount + 1));
        const sample = await withFilesystemTimeout(readSample(handle, position, sampleBytes), `Media inspection read for ${filePath}`);
        if (isAllZero(sample)) zeroSamples += 1;
      }
      if (zeroSamples >= 2) problems.push(`${zeroSamples} of ${middleSampleCount} sampled regions are zero-filled`);
      else if (zeroSamples === 1) warnings.push("One sampled region is zero-filled");
    }
  } finally {
    await handle.close().catch(() => undefined);
  }

  let durationSeconds: number | null = null;
  // Skip the probe when the header is already known to be junk; ffprobe would only restate it.
  if (!problems.some((problem) => /starts with zero|does not match/.test(problem))) {
    const probe = await (options.prober ?? probeMedia)(filePath, options.signal);
    if (!probe.ok) problems.push(`ffprobe could not read the file: ${probe.error.split("\n")[0]}`);
    else {
      durationSeconds = probe.durationSeconds;
      if (!probe.streamTypes.includes("video")) problems.push("No video stream found");
      if (durationSeconds === null) warnings.push("Duration is not reported");
      else if ((stat.size * 8) / durationSeconds < minimumVideoBitsPerSecond) problems.push(`Bitrate is implausibly low for a ${minutesLabel(durationSeconds)} video`);
    }
  }

  const expectation = options.expectation;
  if (expectation?.sizeBytes && expectation.sizeBytes >= minimumTrustedExpectedBytes && expectation.sizeBytes !== stat.size) {
    // A smaller file is incomplete; a larger one usually means the external record is stale, not that the file is junk.
    const message = `${expectation.source} reports ${bytesLabel(expectation.sizeBytes)} for this file, but it is ${bytesLabel(stat.size)}`;
    if (stat.size < expectation.sizeBytes) problems.push(message);
    else warnings.push(message);
  }
  if (expectation?.runtimeSeconds && durationSeconds && durationSeconds < expectation.runtimeSeconds * runtimeShortfallRatio) {
    problems.push(`Duration is ${minutesLabel(durationSeconds)}, under half of the ${minutesLabel(expectation.runtimeSeconds)} runtime ${expectation.source} expects; this looks like a sample or partial file`);
  }

  return { status: problems.length ? "fail" : "pass", problems, warnings, durationSeconds };
}

export function describeInspectionFailure(inspection: MediaInspection): string {
  return inspection.problems.join("; ");
}

export function evaluateFfmpegValidation(outcome: FfmpegRunOutcome): { status: "pass" | "fail"; output: string } {
  const lines = outcome.stderr.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (outcome.exitCode !== 0) return { status: "fail", output: outcome.stderr.trim() || "ffmpeg exited non-zero" };
  // Error-level output only overflows the capture buffer when a file is badly damaged.
  if (outcome.stderr.startsWith("[earlier command output truncated]")) return { status: "fail", output: `ffmpeg reported more errors than could be recorded; last: ${lines.at(-1) ?? ""}` };
  const fatal = lines.find((line) => fatalFfmpegPatterns.some((pattern) => pattern.test(line)));
  if (fatal) return { status: "fail", output: fatal };
  const damage = lines.filter((line) => damagePattern.test(line));
  if (damage.length > tolerableDamageLines) {
    return { status: "fail", output: `${damage.length} damaged packet or decoding errors, first: ${damage[0]}` };
  }
  if (outcome.durationSeconds && outcome.reachedSeconds !== null && outcome.reachedSeconds < outcome.durationSeconds * minimumReachedFraction - reachedSlackSeconds) {
    return { status: "fail", output: `Stream ends at ${minutesLabel(outcome.reachedSeconds)} of a stated ${minutesLabel(outcome.durationSeconds)}; the file is truncated` };
  }
  return { status: "pass", output: outcome.stderr.trim() };
}
