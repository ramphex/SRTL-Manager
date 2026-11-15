import fs from "node:fs/promises";
import path from "node:path";
import type { FileHeaderFailReason, FileHeaderStatus } from "../../shared/fileHeaders";
import { withFilesystemTimeout } from "./filesystemSafety";

/**
 * The file header check. It catches files that are broken from the first byte, which the allocation and zero-sampling
 * checks miss: garbage where the container header should be, a file that is all zeros (common on remote storage),
 * an MP4 shell with no content, and empty files. Only the first 64 KB is read, through the same path the scan saw.
 */
export const headerReadBytes = 64 * 1024;
// Smaller than this is never a real movie or episode. DVD menu files (.ifo/.bup) are small by design and are exempt.
export const headerMinimumBytes = 1024 * 1024;
export const headerCheckTimeoutMs = 10_000;

export interface HeaderVerdict {
  status: FileHeaderStatus;
  reason: string | null;
}

const fail = (reason: FileHeaderFailReason): HeaderVerdict => ({ status: "fail", reason });

const discImageExtensions = new Set([".iso", ".img"]);
const dvdMenuExtensions = new Set([".ifo", ".bup"]);

function ascii(bytes: Uint8Array, start: number, end: number): string {
  if (bytes.length < end) return "";
  return Buffer.from(bytes.buffer, bytes.byteOffset + start, end - start).toString("latin1");
}

function startsWith(bytes: Uint8Array, signature: number[], offset = 0): boolean {
  if (bytes.length < offset + signature.length) return false;
  return signature.every((value, index) => bytes[offset + index] === value);
}

const asfGuid = [0x30, 0x26, 0xb2, 0x75, 0x8e, 0x66, 0xcf, 0x11, 0xa6, 0xd9, 0x00, 0xaa, 0x00, 0x62, 0xce, 0x6c];
const wtvGuid = [0xb7, 0xd8, 0x00, 0x20, 0x37, 0x49, 0xda, 0x11, 0xa6, 0x4e, 0x00, 0x07, 0xe9, 0x5e, 0xad, 0x8d];
const mp4LeadingBoxes = new Set(["ftyp", "moov", "mdat", "free", "wide", "skip", "pnot"]);
// ISO 9660 ("CD001") and UDF ("BEA01", "NSR02", "NSR03") volume descriptors start at 32 KB, one per 2 KB sector.
const volumeDescriptorIds = new Set(["CD001", "BEA01", "NSR02", "NSR03"]);
const volumeDescriptorOffsets = [0x8001, 0x8801, 0x9001];

/** The container whose signature starts these bytes, whatever the file is called; null when none matches. */
export function detectHeaderContainer(bytes: Uint8Array): string | null {
  if (startsWith(bytes, [0x1a, 0x45, 0xdf, 0xa3])) return "matroska";
  if (bytes.length >= 8 && mp4LeadingBoxes.has(ascii(bytes, 4, 8))) {
    // A box size of 0 means "to the end of the file" and 1 means a 64-bit size follows; anything else is at least 8.
    const boxSize = Buffer.from(bytes.buffer, bytes.byteOffset, 4).readUInt32BE(0);
    if (boxSize === 0 || boxSize === 1 || boxSize >= 8) return "mp4";
  }
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "AVI ") return "avi";
  if (bytes.length > 188 && bytes[0] === 0x47 && bytes[188] === 0x47) return "mpeg_ts";
  if (bytes.length > 196 && bytes[4] === 0x47 && bytes[196] === 0x47) return "m2ts";
  if (startsWith(bytes, [0x00, 0x00, 0x01, 0xba])) return "mpeg_ps";
  if (startsWith(bytes, [0x00, 0x00, 0x01, 0xb3])) return "mpeg_video";
  if (startsWith(bytes, asfGuid)) return "asf";
  if (startsWith(bytes, wtvGuid)) return "wtv";
  if (ascii(bytes, 0, 3) === "FLV" && bytes[3] === 0x01) return "flv";
  if (ascii(bytes, 0, 4) === "OggS") return "ogg";
  if (ascii(bytes, 0, 4) === ".RMF") return "realmedia";
  if (ascii(bytes, 0, 9) === "DVDVIDEO-") return "dvd_ifo";
  if (volumeDescriptorOffsets.some((offset) => volumeDescriptorIds.has(ascii(bytes, offset, offset + 5)))) return "disc_image";
  return null;
}

export function isAllZero(bytes: Uint8Array): boolean {
  for (let index = 0; index < bytes.length; index += 1) if (bytes[index] !== 0) return false;
  return true;
}

/** The verdict that needs no read: empty and tiny video files fail on their size alone. */
export function headerVerdictFromSize(filePath: string, sizeBytes: number): HeaderVerdict | null {
  if (sizeBytes <= 0) return fail("empty");
  if (dvdMenuExtensions.has(path.extname(filePath).toLowerCase())) return null;
  if (sizeBytes < headerMinimumBytes) return fail("too_small");
  return null;
}

/**
 * Judges the first bytes of a file. Any known container passes, whatever the extension, since a mislabelled file
 * still plays. Disc images and DVD menu files are only failed when they are plainly empty or zero-filled: a raw .img
 * has no signature to look for, so one SRTL does not recognise is skipped rather than failed.
 */
export function classifyFileHeader(filePath: string, sizeBytes: number, head: Uint8Array): HeaderVerdict {
  const bySize = headerVerdictFromSize(filePath, sizeBytes);
  if (bySize) return bySize;
  const container = detectHeaderContainer(head);
  if (container) return { status: "pass", reason: container };
  if (head.length > 0 && isAllZero(head)) return fail("zeros");
  const extension = path.extname(filePath).toLowerCase();
  if (discImageExtensions.has(extension) || dvdMenuExtensions.has(extension)) return { status: "skipped", reason: null };
  return fail("not_video");
}

export interface HeaderRead {
  head: Uint8Array;
  sizeBytes: number;
}

export type HeaderReader = (filePath: string, length: number, timeoutMs: number) => Promise<HeaderRead>;

/** Opens the file, reads up to `length` bytes from the start and its current size, all within one deadline. */
export const readFileHead: HeaderReader = async (filePath, length, timeoutMs) => {
  const work = (async () => {
    const handle = await fs.open(filePath, "r");
    try {
      const stat = await handle.stat();
      const buffer = Buffer.alloc(Math.max(0, Math.min(length, stat.size)));
      let offset = 0;
      while (offset < buffer.length) {
        const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      return { head: buffer.subarray(0, offset), sizeBytes: stat.size };
    } finally {
      // A read that outlives the deadline still closes its handle when it finishes.
      await handle.close().catch(() => undefined);
    }
  })();
  work.catch(() => undefined);
  return withFilesystemTimeout(work, `Reading the header of ${filePath}`, timeoutMs);
};

export interface HeaderCheckTarget {
  filePath: string;
  sizeBytes: number;
  mtimeMs: number;
}

export interface HeaderCheckResult extends HeaderVerdict {
  // The size and modification time the verdict describes: the ones SRTL had recorded for the file.
  checkedSizeBytes: number;
  checkedMtimeMs: number;
}

export interface HeaderCheckOptions {
  reader?: HeaderReader;
  timeoutMs?: number;
}

function describeReadError(error: unknown): string {
  if (error !== null && typeof error === "object" && "code" in error && typeof error.code === "string") return error.code;
  const message = error instanceof Error ? error.message : String(error);
  return /timed out/i.test(message) ? "timed out" : message.slice(0, 200);
}

/**
 * Checks one file. A file that cannot be read in time, or that changed size since the scan saw it, gets "retry":
 * a failed or slow read says nothing about whether the file is broken.
 */
export async function checkFileHeader(target: HeaderCheckTarget, options: HeaderCheckOptions = {}): Promise<HeaderCheckResult> {
  const checked = { checkedSizeBytes: target.sizeBytes, checkedMtimeMs: target.mtimeMs };
  const bySize = headerVerdictFromSize(target.filePath, target.sizeBytes);
  if (bySize) return { ...bySize, ...checked };
  let read: HeaderRead;
  try {
    read = await (options.reader ?? readFileHead)(target.filePath, headerReadBytes, options.timeoutMs ?? headerCheckTimeoutMs);
  } catch (error) {
    return { status: "retry", reason: describeReadError(error), ...checked };
  }
  if (read.sizeBytes !== target.sizeBytes) return { status: "retry", reason: "changed since the last scan", ...checked };
  if (read.head.length < Math.min(headerReadBytes, read.sizeBytes)) return { status: "retry", reason: "short read", ...checked };
  return { ...classifyFileHeader(target.filePath, read.sizeBytes, read.head), ...checked };
}

export interface HeaderBatchOptions extends HeaderCheckOptions {
  concurrency?: number;
  // No new file is started after this many milliseconds; checks already running finish.
  deadlineMs?: number;
  isCancelled?: () => Promise<boolean> | boolean;
  now?: () => number;
}

/** Checks files a few at a time, in order, until the list or the time runs out. Files not started are left out. */
export async function checkFileHeaders<T extends HeaderCheckTarget>(targets: T[], options: HeaderBatchOptions = {}): Promise<Array<{ target: T; result: HeaderCheckResult }>> {
  const now = options.now ?? Date.now;
  const startedAt = now();
  const results: Array<{ target: T; result: HeaderCheckResult }> = [];
  let next = 0;
  const worker = async () => {
    for (;;) {
      if (options.deadlineMs !== undefined && now() - startedAt >= options.deadlineMs) return;
      if (options.isCancelled && (await options.isCancelled())) return;
      // Taken only after the await, so two workers never pick the same file or one past the end.
      if (next >= targets.length) return;
      const target = targets[next++]!;
      results.push({ target, result: await checkFileHeader(target, options) });
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(options.concurrency ?? 4, targets.length || 1)) }, worker));
  return results;
}
