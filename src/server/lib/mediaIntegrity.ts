import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { openFileWithTimeout, withFilesystemTimeout } from "./filesystemSafety";
import { appendBoundedOutput, terminateChildProcess } from "./processSafety";

const sampleBytes = 64 * 1024;
const middleSampleCount = 6;
export const hollowMinimumBytes = 50 * 1024 * 1024;
export const hollowAllocationRatio = 0.01;
const minimumVideoBitsPerSecond = 64_000;
const probeTimeoutMs = 120_000;
// ffmpeg reports the last processed timestamp; anything short of this fraction of the stated duration is a truncated stream.
const minimumReachedFraction = 0.98;
const reachedSlackSeconds = 2;
const runtimeShortfallRatio = 0.5;
// A recorded size this small cannot be a movie; it means the size of a symlink was recorded instead of its target.
const minimumTrustedExpectedBytes = 1024 * 1024;

export const zeroSampleBytes = 256 * 1024;
export const zeroSampleCount = 24;
// Files storing at least this share of their size are not suspects: ZFS compression alone never gets past it on video.
export const suspectAllocationRatio = 0.9;
// Two all-zero samples of 24 mark a file as partially hollow. Zero-sampling the NAS found 56 damaged files: the
// sampled ones all had 4 or more zero samples (1-10% allocated: 22-24, 10-50%: 15-19, 50-90%: 4-17), while the
// compressed-but-intact files in the 50-90% band (Dora WEBRips, MPEG2 TV captures) had none. Real video never
// contains 256 KB of zeros, so 2 leaves a wide margin below every damaged file and a single stray block is tolerated.
export const partialHollowZeroSamples = 2;
const zeroSampleTimeoutMs = 30_000;

export type IntegrityVerdict = "ok" | "hollow" | "partial_hollow" | "unknown";

// Some network filesystems report zero blocks for real files, so only a small non-zero allocation is trusted.
export function isHollowAllocation(sizeBytes: number, allocatedBytes: number | null | undefined): boolean {
  return allocatedBytes != null && sizeBytes >= hollowMinimumBytes && allocatedBytes > 0 && allocatedBytes < sizeBytes * hollowAllocationRatio;
}

// Allocation alone cannot tell a damaged file from a well-compressed one, so these are the only files worth reading.
export function needsZeroSampling(sizeBytes: number, allocatedBytes: number | null | undefined): boolean {
  return allocatedBytes != null && sizeBytes >= hollowMinimumBytes && allocatedBytes < sizeBytes * suspectAllocationRatio && !isHollowAllocation(sizeBytes, allocatedBytes);
}

// sampling is null for files that were not worth sampling and "failed" when a read error left the result unknown.
export function classifyIntegrity(sizeBytes: number, allocatedBytes: number | null | undefined, sampling: { zeroSamples: number } | "failed" | null): IntegrityVerdict {
  if (isHollowAllocation(sizeBytes, allocatedBytes)) return "hollow";
  if (sampling === "failed") return "unknown";
  if (sampling && sampling.zeroSamples >= partialHollowZeroSamples) return "partial_hollow";
  return "ok";
}

// The verdict shown for a stored row; rows scanned before zero-sampling existed carry no verdict and read as ok.
export function effectiveIntegrity(sizeBytes: number, allocatedBytes: number | null | undefined, stored: string | null | undefined): IntegrityVerdict {
  if (isHollowAllocation(sizeBytes, allocatedBytes)) return "hollow";
  return stored === "hollow" || stored === "partial_hollow" || stored === "unknown" ? stored : "ok";
}

export function zeroSamplePositions(sizeBytes: number): number[] {
  const last = Math.max(0, sizeBytes - zeroSampleBytes);
  return Array.from({ length: zeroSampleCount }, (_unused, index) => Math.floor((last * index) / (zeroSampleCount - 1)));
}

export interface ZeroSampleResult {
  zeroSamples: number;
  totalSamples: number;
}

async function sampleZeroBlocksOpen(handle: fs.FileHandle, filePath: string, sizeBytes: number, signal?: AbortSignal): Promise<ZeroSampleResult> {
  const buffer = Buffer.alloc(zeroSampleBytes);
  let zeroSamples = 0;
  const positions = zeroSamplePositions(sizeBytes);
  for (const position of positions) {
    if (signal?.aborted) throw new Error("Zero sampling was cancelled");
    const expected = Math.min(zeroSampleBytes, sizeBytes - position);
    const { bytesRead } = await withFilesystemTimeout(handle.read(buffer, 0, expected, position), `Zero sampling read for ${filePath}`, zeroSampleTimeoutMs);
    // A short read means the file changed under the scan, so the result says nothing about damage.
    if (bytesRead < expected) throw new Error(`Zero sampling read ${bytesRead} of ${expected} bytes at ${position} in ${filePath}`);
    if (buffer.subarray(0, bytesRead).equals(zeroBlock256.subarray(0, bytesRead))) zeroSamples += 1;
  }
  return { zeroSamples, totalSamples: positions.length };
}

// Reads evenly spaced samples across the whole file; any read error rejects, and callers must treat that as "unknown".
export async function sampleZeroBlocks(filePath: string, sizeBytes: number, signal?: AbortSignal): Promise<ZeroSampleResult> {
  const handle = await openFileWithTimeout(filePath, `Zero sampling open for ${filePath}`, zeroSampleTimeoutMs);
  try {
    return await sampleZeroBlocksOpen(handle, filePath, sizeBytes, signal);
  } finally {
    await handle.close().catch(() => undefined);
  }
}

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

export interface MatroskaTail {
  // Declared end of the Segment minus the file size; zero or less means nothing is missing.
  missingBytes: number;
  sizeBytes: number;
  durationSeconds: number | null;
}

export interface FfmpegRunOutcome {
  exitCode: number | null;
  stderr: string;
  reachedSeconds: number | null;
  durationSeconds: number | null;
  matroskaTail?: MatroskaTail | null;
}

export interface FfmpegValidation {
  status: "pass" | "fail";
  output: string;
  warning?: string;
}

// Some MKV sources stop a few KB short of their own header, inside the last cluster. They always read this way, so
// retrying never helps, and everything before the cut plays. The largest shortfall seen on real files was 3,862 bytes.
export const maximumMatroskaShortfallBytes = 16 * 1024;
const matroskaHeadBytes = 4 * 1024;
const ebmlHeaderId = 0x1a45dfa3;
const matroskaSegmentId = 0x18538067;

const prematureEndPattern = /File ended prematurely(?: at pos\. (\d+))?/i;
// Container-structure messages that mean the file is damaged, not merely unusual.
const otherFatalFfmpegPatterns = [
  /invalid as first byte of an EBML number/i,
  /exceeds containing master element/i,
  /Invalid data found when processing input/i,
  /moov atom not found/i,
  /stream \d+, offset 0x[0-9a-f]+: partial file/i
];
const fatalFfmpegPatterns = [prematureEndPattern, ...otherFatalFfmpegPatterns];
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
const zeroBlock256 = Buffer.alloc(zeroSampleBytes);

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

  const allocated = stat.blocks * 512;
  if (isHollowAllocation(stat.size, allocated)) {
    problems.push(`File is hollow: only ${bytesLabel(allocated)} of ${bytesLabel(stat.size)} is stored on disk`);
  }
  const suspect = needsZeroSampling(stat.size, allocated);

  const handle = await openFileWithTimeout(filePath, `Media inspection open for ${filePath}`);
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
    if (suspect) {
      // Same sampling and threshold as storage scans, so audits and copy pre-checks agree with the Damaged files list.
      try {
        const sampled = await sampleZeroBlocksOpen(handle, filePath, stat.size, options.signal);
        if (classifyIntegrity(stat.size, allocated, sampled) === "partial_hollow") {
          problems.push(`File is partially hollow: ${sampled.zeroSamples} of ${sampled.totalSamples} sampled regions are zero-filled and only ${bytesLabel(allocated)} of ${bytesLabel(stat.size)} is stored on disk`);
        }
      } catch (error) {
        if (options.signal?.aborted) throw error;
        warnings.push("Zero-fill sampling could not read the whole file");
      }
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

// Returns null for an unset or unknown size, which a live muxer writes as all ones.
function readEbmlSize(buffer: Buffer, offset: number): { length: number; value: number } | null {
  const first = buffer[offset];
  if (!first) return null;
  const length = Math.clz32(first) - 23;
  if (offset + length > buffer.length) return null;
  const firstMask = 0xff >> length;
  let value = first & firstMask;
  let unknown = value === firstMask;
  for (let index = 1; index < length; index += 1) {
    value = value * 256 + buffer[offset + index];
    unknown &&= buffer[offset + index] === 0xff;
  }
  return unknown ? null : { length, value };
}

// Where the Segment says the file ends; null when this is not Matroska or the Segment size is unknown.
export function matroskaDeclaredEnd(head: Buffer): number | null {
  if (head.length < 4 || head.readUInt32BE(0) !== ebmlHeaderId) return null;
  const header = readEbmlSize(head, 4);
  if (!header) return null;
  const segmentOffset = 4 + header.length + header.value;
  if (segmentOffset + 4 > head.length || head.readUInt32BE(segmentOffset) !== matroskaSegmentId) return null;
  const segment = readEbmlSize(head, segmentOffset + 4);
  if (!segment) return null;
  const end = segmentOffset + 4 + segment.length + segment.value;
  return Number.isSafeInteger(end) ? end : null;
}

export function reportsPrematureEnd(stderr: string): boolean {
  return prematureEndPattern.test(stderr);
}

export async function readMatroskaTail(filePath: string, signal?: AbortSignal): Promise<MatroskaTail | null> {
  let declaredEnd: number | null;
  let sizeBytes: number;
  try {
    const handle = await openFileWithTimeout(filePath, `Media tail open for ${filePath}`);
    try {
      sizeBytes = (await withFilesystemTimeout(handle.stat(), `Media tail stat for ${filePath}`)).size;
      declaredEnd = matroskaDeclaredEnd(await withFilesystemTimeout(readSample(handle, 0, matroskaHeadBytes), `Media tail read for ${filePath}`));
    } finally {
      await handle.close().catch(() => undefined);
    }
  } catch {
    return null;
  }
  if (declaredEnd === null) return null;
  // ffprobe prints the same complaint on these files, so the duration has to come from its stdout alone.
  const probe = await probeMedia(filePath, signal);
  return { missingBytes: declaredEnd - sizeBytes, sizeBytes, durationSeconds: probe.ok ? probe.durationSeconds : null };
}

function isStreamShort(reachedSeconds: number, durationSeconds: number): boolean {
  return reachedSeconds < durationSeconds * minimumReachedFraction - reachedSlackSeconds;
}

// Returns the warning when a premature end is only a short tail, and null when it has to stay a failure.
function shortTailWarning(outcome: FfmpegRunOutcome, lines: string[]): string | null {
  const tail = outcome.matroskaTail;
  if (!tail || tail.missingBytes <= 0 || tail.missingBytes > maximumMatroskaShortfallBytes) return null;
  if (lines.some((line) => otherFatalFfmpegPatterns.some((pattern) => pattern.test(line)))) return null;
  // A stated position before the end of the file means reading stopped early, whatever the header says.
  if (lines.some((line) => { const position = prematureEndPattern.exec(line)?.[1]; return position !== undefined && Number(position) < tail.sizeBytes; })) return null;
  if (lines.filter((line) => damagePattern.test(line)).length > tolerableDamageLines) return null;
  if (!tail.durationSeconds || outcome.reachedSeconds === null || isStreamShort(outcome.reachedSeconds, tail.durationSeconds)) return null;
  return `File is ${tail.missingBytes} byte${tail.missingBytes === 1 ? "" : "s"} shorter than its header declares; accepted because ffmpeg still read it to the end`;
}

export function evaluateFfmpegValidation(outcome: FfmpegRunOutcome): FfmpegValidation {
  const lines = outcome.stderr.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (outcome.exitCode !== 0) return { status: "fail", output: outcome.stderr.trim() || "ffmpeg exited non-zero" };
  // Error-level output only overflows the capture buffer when a file is badly damaged.
  if (outcome.stderr.startsWith("[earlier command output truncated]")) return { status: "fail", output: `ffmpeg reported more errors than could be recorded; last: ${lines.at(-1) ?? ""}` };
  const fatal = lines.find((line) => fatalFfmpegPatterns.some((pattern) => pattern.test(line)));
  const warning = fatal ? shortTailWarning(outcome, lines) : null;
  if (fatal && !warning) return { status: "fail", output: fatal };
  const damage = lines.filter((line) => damagePattern.test(line));
  if (damage.length > tolerableDamageLines) {
    return { status: "fail", output: `${damage.length} damaged packet or decoding errors, first: ${damage[0]}` };
  }
  if (outcome.durationSeconds && outcome.reachedSeconds !== null && isStreamShort(outcome.reachedSeconds, outcome.durationSeconds)) {
    return { status: "fail", output: `Stream ends at ${minutesLabel(outcome.reachedSeconds)} of a stated ${minutesLabel(outcome.durationSeconds)}; the file is truncated` };
  }
  return warning ? { status: "pass", output: outcome.stderr.trim(), warning } : { status: "pass", output: outcome.stderr.trim() };
}
