import { spawn } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { defaultCopyJobBehaviorSettings } from "../../shared/advancedSettings";
import type { AuditMode, CopyDirection, CopyJobBehaviorSettings, CopyLocalConflictStrategy, MediaLinkRow, PathsSettings, StorageRootType } from "../../shared/types";
import { isMediaFile, isPathInside } from "./media";
import { assertDestinationPathInside, assertExistingPathInside, assertPathParentInside, assertReadableRegularFile } from "./filesystemSafety";
import { appendBoundedOutput, commandTimeoutMs, terminateChildProcess } from "./processSafety";

const copyDirectoryMode = 0o755;
const copyFileMode = 0o644;

export interface CopyCommandResult {
  status: "pass" | "fail";
  output: string;
}

export interface CopyCommandRunner {
  copyFile(sourcePath: string, tempPath: string, reportProgress?: CopyFileProgressReporter, signal?: AbortSignal): Promise<void>;
  runCmp(sourcePath: string, targetPath: string, reportProgress?: CopyFileProgressReporter, signal?: AbortSignal): Promise<CopyCommandResult>;
  runFfmpeg(mode: AuditMode, targetPath: string, reportProgress?: CopyFileProgressReporter, signal?: AbortSignal): Promise<CopyCommandResult>;
}

export type CopyStage = "preparing" | "copying" | "verifying" | "symlinking";

export interface CopyFileProgress {
  bytesCopied?: number;
  bytesProcessed?: number;
  totalBytes: number;
  bytesPerSecond: number;
  remainingSeconds: number | null;
}

export type CopyFileProgressReporter = (progress: CopyFileProgress) => Promise<void> | void;

export interface CopyProgressUpdate {
  stage: CopyStage;
  message: string;
  sourcePath?: string;
  destinationPath?: string;
  linkPath?: string;
  sizeBytes?: number;
  bytesCopied?: number;
  bytesProcessed?: number;
  totalBytes?: number;
  bytesPerSecond?: number;
  remainingSeconds?: number | null;
}

export type CopyProgressReporter = (update: CopyProgressUpdate) => Promise<void> | void;

export type CopyOperationStage = "planned" | "transferring" | "verified" | "destination_displaced" | "promoted" | "repointed";

export interface CopyFileIdentity {
  dev: string;
  ino: string;
  size: string;
  mtimeNs: string;
  ctimeNs: string;
}

export interface CopyOperationUpdate {
  stage: CopyOperationStage;
  tempPath?: string | null;
  displacedPath?: string | null;
  tempIdentity?: string | null;
  destinationIdentity?: string | null;
  displacedIdentity?: string | null;
  sizeBytes?: number | null;
  resultStatus?: CopyMediaResult["status"] | null;
}

export type CopyOperationReporter = (update: CopyOperationUpdate) => Promise<void>;

export type CopyMutationGuard = <T>(mutation: () => Promise<T>) => Promise<T>;

export class CopyReconciliationRequiredError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CopyReconciliationRequiredError";
  }
}

export interface CopyMediaResult {
  status: "copied" | "repointed" | "skipped" | "conflict";
  direction: CopyDirection;
  sourceRootType: StorageRootType;
  destinationRootType: StorageRootType;
  sourcePath: string;
  destinationPath: string;
  linkPath: string;
  sizeBytes: number;
  message: string;
}

function abortError(signal?: AbortSignal): Error {
  return signal?.reason instanceof Error ? signal.reason : new Error("Job terminated");
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError(signal);
}

function runCommand(command: string, args: string[], signal?: AbortSignal): Promise<CopyCommandResult> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError(signal));
      return;
    }
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | null = null;
    const abort = () => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      killTimer = terminateChildProcess(child);
      reject(abortError(signal));
    };
    const deadline = setTimeout(() => {
      if (settled) return;
      settled = true;
      killTimer = terminateChildProcess(child);
      signal?.removeEventListener("abort", abort);
      resolve({ status: "fail", output: `${command} timed out after ${commandTimeoutMs() / 1_000} seconds` });
    }, commandTimeoutMs());
    deadline.unref();
    signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      output = appendBoundedOutput(output, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output = appendBoundedOutput(output, chunk);
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      signal?.removeEventListener("abort", abort);
      resolve({ status: "fail", output: error.message });
    });
    child.on("close", (code) => {
      if (killTimer) clearTimeout(killTimer);
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      signal?.removeEventListener("abort", abort);
      resolve({ status: code === 0 ? "pass" : "fail", output: output.trim() });
    });
  });
}

async function emitByteProgress(
  reportProgress: CopyFileProgressReporter | undefined,
  state: { startedAt: number; lastReportAt: number },
  bytesProcessed: number,
  totalBytes: number,
  force = false,
  includeCopiedBytes = false
): Promise<void> {
  if (!reportProgress) return;
  const now = Date.now();
  if (!force && now - state.lastReportAt < 500 && bytesProcessed < totalBytes) return;
  state.lastReportAt = now;
  const elapsedSeconds = Math.max((now - state.startedAt) / 1000, 0.001);
  const bytesPerSecond = bytesProcessed / elapsedSeconds;
  const remainingBytes = Math.max(0, totalBytes - bytesProcessed);
  await reportProgress({
    ...(includeCopiedBytes ? { bytesCopied: bytesProcessed } : {}),
    bytesProcessed,
    totalBytes,
    bytesPerSecond,
    remainingSeconds: bytesPerSecond > 0 ? remainingBytes / bytesPerSecond : null
  });
}

async function copyFileWithProgress(sourcePath: string, tempPath: string, reportProgress?: CopyFileProgressReporter, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  const stat = await fs.stat(sourcePath);
  const totalBytes = stat.size;
  const progressState = { startedAt: Date.now(), lastReportAt: 0 };
  let bytesCopied = 0;

  async function emitProgress(force = false): Promise<void> {
    await emitByteProgress(reportProgress, progressState, bytesCopied, totalBytes, force, true);
  }

  await emitProgress(true);
  const sourceStream = createReadStream(sourcePath);
  const targetStream = createWriteStream(tempPath, { flags: "wx", mode: copyFileMode });
  const configuredStallTimeout = Number(process.env.SRTL_COPY_STALL_TIMEOUT_MS);
  const stallTimeoutMs = Number.isInteger(configuredStallTimeout) && configuredStallTimeout >= 60_000 ? Math.min(configuredStallTimeout, 60 * 60_000) : 10 * 60_000;
  let stallTimer: ReturnType<typeof setTimeout> | null = null;
  const resetStallTimer = () => {
    if (stallTimer) clearTimeout(stallTimer);
    stallTimer = setTimeout(() => {
      const error = new Error(`Copy made no progress for ${Math.round(stallTimeoutMs / 60_000)} minutes`);
      sourceStream.destroy(error);
      progressStream.destroy(error);
      targetStream.destroy(error);
    }, stallTimeoutMs);
    stallTimer.unref();
  };
  const progressStream = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      if (signal?.aborted) {
        callback(abortError(signal));
        return;
      }
      bytesCopied += chunk.length;
      resetStallTimer();
      emitProgress(false)
        .then(() => callback(null, chunk))
        .catch((error: unknown) => callback(error instanceof Error ? error : new Error(String(error))));
    }
  });
  resetStallTimer();
  const abort = () => {
    const error = abortError(signal);
    sourceStream.destroy(error);
    progressStream.destroy(error);
    targetStream.destroy(error);
  };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    await pipeline(sourceStream, progressStream, targetStream);
  } finally {
    if (stallTimer) clearTimeout(stallTimer);
    signal?.removeEventListener("abort", abort);
  }
  throwIfAborted(signal);
  await emitProgress(true);
}

async function compareFilesWithProgress(sourcePath: string, targetPath: string, reportProgress?: CopyFileProgressReporter, signal?: AbortSignal): Promise<CopyCommandResult> {
  throwIfAborted(signal);
  const [sourceStat, targetStat] = await Promise.all([fs.stat(sourcePath), fs.stat(targetPath)]);
  if (sourceStat.size !== targetStat.size) {
    return { status: "fail", output: `size mismatch (${sourceStat.size} != ${targetStat.size})` };
  }

  const totalBytes = sourceStat.size;
  const progressState = { startedAt: Date.now(), lastReportAt: 0 };
  let bytesProcessed = 0;
  await emitByteProgress(reportProgress, progressState, bytesProcessed, totalBytes, true);

  const sourceFile = await fs.open(sourcePath, "r");
  const targetFile = await fs.open(targetPath, "r");
  try {
    const chunkSize = 1024 * 1024;
    const sourceBuffer = Buffer.allocUnsafe(chunkSize);
    const targetBuffer = Buffer.allocUnsafe(chunkSize);

    while (bytesProcessed < totalBytes) {
      throwIfAborted(signal);
      const readLength = Math.min(chunkSize, totalBytes - bytesProcessed);
      const [sourceRead, targetRead] = await Promise.all([
        sourceFile.read(sourceBuffer, 0, readLength, bytesProcessed),
        targetFile.read(targetBuffer, 0, readLength, bytesProcessed)
      ]);

      if (sourceRead.bytesRead !== targetRead.bytesRead) {
        return { status: "fail", output: `read length mismatch at byte ${bytesProcessed + 1}` };
      }
      if (sourceRead.bytesRead === 0) {
        return { status: "fail", output: `unexpected end of file at byte ${bytesProcessed + 1}` };
      }

      const sourceChunk = sourceBuffer.subarray(0, sourceRead.bytesRead);
      const targetChunk = targetBuffer.subarray(0, targetRead.bytesRead);
      if (!sourceChunk.equals(targetChunk)) {
        let differenceOffset = 0;
        while (differenceOffset < sourceChunk.length && sourceChunk[differenceOffset] === targetChunk[differenceOffset]) {
          differenceOffset += 1;
        }
        return { status: "fail", output: `byte ${bytesProcessed + differenceOffset + 1} differs` };
      }

      bytesProcessed += sourceRead.bytesRead;
      await emitByteProgress(reportProgress, progressState, bytesProcessed, totalBytes);
    }

    throwIfAborted(signal);
    await emitByteProgress(reportProgress, progressState, bytesProcessed, totalBytes, true);
    return { status: "pass", output: "" };
  } catch (error) {
    return { status: "fail", output: error instanceof Error ? error.message : String(error) };
  } finally {
    await Promise.all([sourceFile.close(), targetFile.close()]);
  }
}

function nullOutputPath(): string {
  return process.platform === "win32" ? "NUL" : "/dev/null";
}

async function readMediaDurationSeconds(targetPath: string, signal?: AbortSignal): Promise<number | null> {
  const result = await runCommand("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", targetPath], signal);
  if (result.status === "fail") return null;
  const duration = Number.parseFloat(result.output.trim());
  return Number.isFinite(duration) && duration > 0 ? duration : null;
}

function parseFfmpegOutTimeSeconds(key: string, value: string): number | null {
  if (key === "out_time_us" || key === "out_time_ms") {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed / 1_000_000 : null;
  }
  if (key !== "out_time") return null;
  const match = value.match(/^(\d+):(\d{2}):(\d{2}(?:\.\d+)?)$/);
  if (!match) return null;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

async function runFfmpegWithProgress(mode: AuditMode, targetPath: string, reportProgress?: CopyFileProgressReporter, signal?: AbortSignal): Promise<CopyCommandResult> {
  throwIfAborted(signal);
  const [targetStat, durationSeconds] = await Promise.all([fs.stat(targetPath).catch(() => null), readMediaDurationSeconds(targetPath, signal)]);
  const totalBytes = targetStat?.size ?? 0;
  const canReportProgress = Boolean(reportProgress && durationSeconds && totalBytes > 0);
  const progressState = { startedAt: Date.now(), lastReportAt: 0 };
  let progressChain = Promise.resolve();
  let progressBuffer = "";
  let settled = false;

  if (canReportProgress) await emitByteProgress(reportProgress, progressState, 0, totalBytes, true);

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError(signal));
      return;
    }
    const args =
      mode === "fast"
        ? ["-v", "error", "-nostats", "-progress", "pipe:1", "-i", targetPath, "-map", "0", "-c", "copy", "-f", "null", nullOutputPath()]
        : ["-v", "error", "-nostats", "-progress", "pipe:1", "-i", targetPath, "-f", "null", nullOutputPath()];
    const child = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let killTimer: ReturnType<typeof setTimeout> | null = null;
    const abort = () => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      killTimer = terminateChildProcess(child);
      reject(abortError(signal));
    };
    const deadline = setTimeout(() => {
      if (settled) return;
      settled = true;
      killTimer = terminateChildProcess(child);
      signal?.removeEventListener("abort", abort);
      resolve({ status: "fail", output: `ffmpeg timed out after ${commandTimeoutMs() / 1_000} seconds` });
    }, commandTimeoutMs());
    deadline.unref();
    signal?.addEventListener("abort", abort, { once: true });

    function failFromProgress(error: unknown): void {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      killTimer = terminateChildProcess(child);
      reject(error instanceof Error ? error : new Error(String(error)));
    }

    function queueProgress(bytesProcessed: number, force = false): void {
      if (!canReportProgress) return;
      progressChain = progressChain.then(() => emitByteProgress(reportProgress, progressState, bytesProcessed, totalBytes, force));
      progressChain.catch(failFromProgress);
    }

    child.stdout.on("data", (chunk: Buffer) => {
      progressBuffer += chunk.toString("utf8");
      const lines = progressBuffer.split(/\r?\n/);
      progressBuffer = lines.pop() ?? "";
      for (const line of lines) {
        const separator = line.indexOf("=");
        if (separator === -1) continue;
        const key = line.slice(0, separator);
        const value = line.slice(separator + 1);
        const outTimeSeconds = parseFfmpegOutTimeSeconds(key, value);
        if (outTimeSeconds != null && durationSeconds && totalBytes > 0) {
          const fraction = Math.min(1, Math.max(0, outTimeSeconds / durationSeconds));
          queueProgress(Math.round(totalBytes * fraction));
        }
        if (key === "progress" && value === "end" && totalBytes > 0) queueProgress(totalBytes, true);
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      output = appendBoundedOutput(output, chunk);
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      signal?.removeEventListener("abort", abort);
      resolve({ status: "fail", output: error.message });
    });
    child.on("close", (code) => {
      if (killTimer) clearTimeout(killTimer);
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      signal?.removeEventListener("abort", abort);
      progressChain
        .then(async () => {
          if (canReportProgress && code === 0) await emitByteProgress(reportProgress, progressState, totalBytes, totalBytes, true);
          resolve({ status: code === 0 ? "pass" : "fail", output: output.trim() });
        })
        .catch((error: unknown) => reject(error instanceof Error ? error : new Error(String(error))));
    });
  });
}

export const defaultCopyRunner: CopyCommandRunner = {
  copyFile(sourcePath, tempPath, reportProgress, signal) {
    return copyFileWithProgress(sourcePath, tempPath, reportProgress, signal);
  },
  runCmp(sourcePath, targetPath, reportProgress, signal) {
    return compareFilesWithProgress(sourcePath, targetPath, reportProgress, signal);
  },
  runFfmpeg(mode, targetPath, reportProgress, signal) {
    return runFfmpegWithProgress(mode, targetPath, reportProgress, signal);
  }
};

function rootForType(paths: PathsSettings, rootType: StorageRootType): string {
  return rootType === "local" ? paths.localDir : paths.remoteDir;
}

function rootForDirection(direction: CopyDirection): StorageRootType {
  return direction === "to_local" ? "local" : "remote";
}

function oppositeRoot(rootType: StorageRootType): StorageRootType {
  return rootType === "local" ? "remote" : "local";
}

function assertInside(root: string, candidate: string, label: string): void {
  if (!isPathInside(root, candidate)) {
    throw new Error(`${label} is outside configured root`);
  }
}

function copyDestinationPath(link: MediaLinkRow, paths: PathsSettings, destinationRootType: StorageRootType): string {
  const root = rootForType(paths, destinationRootType);
  const destinationPath = path.resolve(root, link.section, link.relativePath);
  assertInside(root, destinationPath, "Destination path");
  return destinationPath;
}

async function statRegularFile(filePath: string, label: string): Promise<{ size: number; mtimeMs: number }> {
  let stat;
  try {
    stat = await fs.stat(filePath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} is missing or unreadable: ${message}`, { cause: error });
  }
  if (!stat.isFile()) throw new Error(`${label} is not a regular file`);
  return { size: stat.size, mtimeMs: stat.mtimeMs };
}

async function destinationExists(destinationPath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(destinationPath);
    if (!stat.isFile()) throw new Error("Destination exists and is not a regular file");
    return stat.isFile();
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

export async function readCopyFileIdentity(filePath: string): Promise<CopyFileIdentity | null> {
  try {
    const stat = await fs.lstat(filePath, { bigint: true });
    if (!stat.isFile()) throw new Error(`Copy identity path is not a regular file: ${filePath}`);
    return {
      dev: stat.dev.toString(),
      ino: stat.ino.toString(),
      size: stat.size.toString(),
      mtimeNs: stat.mtimeNs.toString(),
      ctimeNs: stat.ctimeNs.toString()
    };
  } catch (error) {
    if (isMissingPathError(error)) return null;
    throw error;
  }
}

export function copyFileIdentitiesMatch(left: CopyFileIdentity | null, right: CopyFileIdentity | null): boolean {
  if (!left || !right) return left === right;
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

export function serializeCopyFileIdentity(identity: CopyFileIdentity): string {
  return JSON.stringify(identity);
}

export function parseCopyFileIdentity(rawIdentity: string): CopyFileIdentity {
  const identity = JSON.parse(rawIdentity) as Partial<CopyFileIdentity> | null;
  const keys: Array<keyof CopyFileIdentity> = ["dev", "ino", "size", "mtimeNs", "ctimeNs"];
  if (!identity || typeof identity !== "object" || !keys.every((key) => typeof identity[key] === "string" && /^\d+$/.test(identity[key]))) {
    throw new Error("Copy file identity is invalid");
  }
  return {
    dev: identity.dev!,
    ino: identity.ino!,
    size: identity.size!,
    mtimeNs: identity.mtimeNs!,
    ctimeNs: identity.ctimeNs!
  };
}

async function requireCopyFileIdentity(filePath: string, label: string): Promise<CopyFileIdentity> {
  const identity = await readCopyFileIdentity(filePath);
  if (!identity) throw new Error(`${label} is missing or is not a regular file`);
  return identity;
}

async function destinationState(destinationPath: string): Promise<CopyFileIdentity | null> {
  return readCopyFileIdentity(destinationPath);
}

async function assertDestinationState(destinationPath: string, expected: CopyFileIdentity | null): Promise<void> {
  const current = await destinationState(destinationPath);
  if (!copyFileIdentitiesMatch(current, expected)) {
    throw new Error("Destination changed before copy promotion; the copy was not installed");
  }
}

function ensureMediaCandidate(sourcePath: string, destinationPath: string, linkPath: string): void {
  if (!isMediaFile(sourcePath) && !isMediaFile(destinationPath) && !isMediaFile(linkPath)) {
    throw new Error("Source is not a recognized media file");
  }
}

function tempFilePath(destinationPath: string): string {
  const directory = path.dirname(destinationPath);
  const basename = path.basename(destinationPath);
  return path.join(directory, `.${basename}.srtl-copy-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
}

function isMissingPathError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

const retryableTransferErrorCodes = new Set(["EAGAIN", "EBUSY", "EIO", "ENETDOWN", "ENETRESET", "ENETUNREACH", "ENOTCONN", "EREMOTEIO", "ESTALE", "ETIMEDOUT"]);

function transferErrorCode(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  if ("code" in error && typeof error.code === "string") return error.code;
  if ("cause" in error) return transferErrorCode(error.cause);
  return null;
}

function isRetryableTransferError(error: unknown): boolean {
  const code = transferErrorCode(error);
  if (code && retryableTransferErrorCodes.has(code)) return true;
  return error instanceof Error && /timed out|temporarily unavailable/i.test(error.message);
}

async function waitForSourceRetry(signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  await new Promise<void>((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    const timeout = setTimeout(finish, 500);
    const abort = () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      reject(abortError(signal));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

async function assertExistingSourcePathInside(root: string, sourcePath: string, signal?: AbortSignal): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    throwIfAborted(signal);
    try {
      await assertExistingPathInside(root, sourcePath, "Source path");
      return;
    } catch (error) {
      lastError = error;
      if (attempt === 3 || !isRetryableTransferError(error)) throw error;
      await waitForSourceRetry(signal);
    }
  }
  throw lastError;
}

async function createDestinationParent(destinationRoot: string, destinationPath: string): Promise<void> {
  const destinationDirectory = path.dirname(destinationPath);
  const missingDirectories: string[] = [];
  let current = destinationDirectory;

  while (isPathInside(destinationRoot, current)) {
    try {
      await fs.lstat(current);
      break;
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
      missingDirectories.push(current);
    }

    if (path.resolve(current) === path.resolve(destinationRoot)) break;
    current = path.dirname(current);
  }

  await fs.mkdir(destinationDirectory, { recursive: true, mode: copyDirectoryMode });
  await assertPathParentInside(destinationRoot, destinationPath, "Destination path");

  for (const directory of missingDirectories.reverse()) {
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory()) throw new Error(`Created destination path is not a directory: ${directory}`);
    await fs.chmod(directory, copyDirectoryMode);
  }
}

async function destinationDisplacementPath(destinationPath: string, strategy: CopyLocalConflictStrategy): Promise<string> {
  const directory = path.dirname(destinationPath);
  const extension = path.extname(destinationPath);
  const stem = path.basename(destinationPath, extension);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const token = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const basename =
      strategy === "keep_both"
        ? `${stem}.srtl-kept-${token}${extension}`
        : `.${path.basename(destinationPath)}.srtl-replace-${process.pid}-${token}`;
    const candidate = path.join(directory, basename);
    if (!(await destinationExists(candidate).catch(() => true))) return candidate;
  }
  throw new Error("Unable to reserve a conflict-safe destination path");
}

async function validateLinkStillPointsTo(link: MediaLinkRow, expectedTargetPath: string): Promise<void> {
  const stat = await fs.lstat(link.linkPath);
  if (!stat.isSymbolicLink()) throw new Error("Library path is no longer a symlink");
  const rawTarget = await fs.readlink(link.linkPath);
  const actualTarget = path.isAbsolute(rawTarget) ? rawTarget : path.resolve(path.dirname(link.linkPath), rawTarget);
  if (path.resolve(actualTarget) !== path.resolve(expectedTargetPath)) {
    throw new Error("Symlink target changed since the last inventory scan; rescan before copying");
  }
}

async function replaceSymlink(linkRoot: string, linkPath: string, destinationPath: string): Promise<void> {
  await assertPathParentInside(linkRoot, linkPath, "Symlink path");
  const tempLink = `${linkPath}.srtl-link-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  try {
    await fs.symlink(destinationPath, tempLink);
    const rawTarget = await fs.readlink(tempLink);
    const actualTarget = path.isAbsolute(rawTarget) ? rawTarget : path.resolve(path.dirname(tempLink), rawTarget);
    if (path.resolve(actualTarget) !== path.resolve(destinationPath)) {
      throw new Error("Temporary symlink target validation failed");
    }
    await assertPathParentInside(linkRoot, linkPath, "Symlink path");
    await fs.rename(tempLink, linkPath);
  } catch (error) {
    await fs.rm(tempLink, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function compareMediaBytes(
  runner: CopyCommandRunner,
  sourcePath: string,
  targetPath: string,
  reportProgress: CopyProgressReporter | undefined,
  baseUpdate: Omit<CopyProgressUpdate, "stage" | "message">,
  message: string,
  signal?: AbortSignal
): Promise<CopyCommandResult> {
  await reportCopyProgress(reportProgress, {
    stage: "verifying",
    message,
    sourcePath,
    destinationPath: targetPath,
    bytesProcessed: 0,
    totalBytes: baseUpdate.sizeBytes,
    bytesPerSecond: 0,
    remainingSeconds: null,
    ...baseUpdate
  });
  return runner.runCmp(
    sourcePath,
    targetPath,
    (progress) =>
      reportCopyProgress(reportProgress, {
        stage: "verifying",
        message,
        sourcePath,
        destinationPath: targetPath,
        ...baseUpdate,
        ...progress
      }),
    signal
  );
}

async function requireMatchingMediaBytes(
  runner: CopyCommandRunner,
  sourcePath: string,
  targetPath: string,
  reportProgress: CopyProgressReporter | undefined,
  baseUpdate: Omit<CopyProgressUpdate, "stage" | "message">,
  message: string,
  signal?: AbortSignal
): Promise<void> {
  const cmp = await compareMediaBytes(runner, sourcePath, targetPath, reportProgress, baseUpdate, message, signal);
  if (cmp.status === "fail") {
    throw new Error(`Byte compare failed: ${cmp.output || "cmp exited non-zero"}`);
  }
}

async function validateMediaStream(
  runner: CopyCommandRunner,
  mode: AuditMode,
  targetPath: string,
  reportProgress: CopyProgressReporter | undefined,
  baseUpdate: Omit<CopyProgressUpdate, "stage" | "message">,
  message: string,
  signal?: AbortSignal
): Promise<void> {
  await reportCopyProgress(reportProgress, {
    stage: "verifying",
    message,
    destinationPath: targetPath,
    bytesProcessed: 0,
    totalBytes: baseUpdate.sizeBytes,
    bytesPerSecond: 0,
    remainingSeconds: null,
    ...baseUpdate
  });
  const ffmpeg = await runner.runFfmpeg(
    mode,
    targetPath,
    (progress) =>
      reportCopyProgress(reportProgress, {
        stage: "verifying",
        message,
        destinationPath: targetPath,
        ...baseUpdate,
        ...progress
      }),
    signal
  );
  if (ffmpeg.status === "fail") {
    throw new Error(`ffmpeg ${mode} validation failed: ${ffmpeg.output || "ffmpeg exited non-zero"}`);
  }
}

async function verifyCopiedFile(
  runner: CopyCommandRunner,
  sourcePath: string,
  targetPath: string,
  reportProgress: CopyProgressReporter | undefined,
  baseUpdate: Omit<CopyProgressUpdate, "stage" | "message">,
  behavior: CopyJobBehaviorSettings,
  signal?: AbortSignal
): Promise<void> {
  if (!behavior.byteCompare && behavior.mediaValidation === "off") {
    await reportCopyProgress(reportProgress, { stage: "verifying", message: "Copy verification disabled by advanced settings", ...baseUpdate });
    return;
  }

  if (behavior.byteCompare) {
    await requireMatchingMediaBytes(runner, sourcePath, targetPath, reportProgress, baseUpdate, "Comparing source and destination bytes", signal);
  } else {
    await reportCopyProgress(reportProgress, { stage: "verifying", message: "Byte compare skipped by advanced settings", ...baseUpdate });
  }

  if (behavior.mediaValidation === "off") {
    await reportCopyProgress(reportProgress, { stage: "verifying", message: "Media validation skipped by advanced settings", ...baseUpdate });
  } else {
    const message = behavior.mediaValidation === "fast" ? "Fast media validation" : "Deep media validation";
    await validateMediaStream(runner, behavior.mediaValidation, targetPath, reportProgress, baseUpdate, message, signal);
  }
}

async function reportCopyProgress(reporter: CopyProgressReporter | undefined, update: CopyProgressUpdate): Promise<void> {
  if (reporter) await reporter(update);
}

export async function copyMediaLink(
  link: MediaLinkRow,
  paths: PathsSettings,
  direction: CopyDirection,
  runner: CopyCommandRunner = defaultCopyRunner,
  reportProgress?: CopyProgressReporter,
  behavior: CopyJobBehaviorSettings = defaultCopyJobBehaviorSettings,
  signal?: AbortSignal,
  localConflictStrategy?: CopyLocalConflictStrategy,
  reportOperation?: CopyOperationReporter,
  assertMutationAllowed?: CopyMutationGuard
): Promise<CopyMediaResult> {
  throwIfAborted(signal);
  let mutationAuthorityLost = false;
  const guardOwnedMutation = async <T>(mutation: () => Promise<T>): Promise<T> => {
    if (assertMutationAllowed) {
      let mutationCompleted = false;
      try {
        return await assertMutationAllowed(async () => {
          const result = await mutation();
          mutationCompleted = true;
          return result;
        });
      } catch (error) {
        if (error instanceof Error && error.name === "LeaseLostError") mutationAuthorityLost = true;
        if (mutationCompleted && !(error instanceof CopyReconciliationRequiredError)) {
          throw new CopyReconciliationRequiredError(
            "Filesystem mutation completed, but the worker could not confirm its mutation lease; durable copy reconciliation is required",
            { cause: error }
          );
        }
        throw error;
      }
    }
    return mutation();
  };
  const guardMutation = async <T>(mutation: () => Promise<T>): Promise<T> => {
    throwIfAborted(signal);
    return guardOwnedMutation(async () => {
      throwIfAborted(signal);
      return mutation();
    });
  };
  const canRollbackSharedPaths = async () => {
    if (mutationAuthorityLost || (signal?.reason instanceof Error && signal.reason.name === "LeaseLostError")) return false;
    if (!assertMutationAllowed) return true;
    try {
      await guardOwnedMutation(async () => undefined);
      return true;
    } catch {
      mutationAuthorityLost = true;
      return false;
    }
  };
  const verificationEnabled = behavior.byteCompare || behavior.mediaValidation !== "off";
  const postTransferCheck = verificationEnabled ? "verification" : "transfer checks";
  const destinationRootType = rootForDirection(direction);
  const sourceRootType = oppositeRoot(destinationRootType);
  const sourceRoot = rootForType(paths, sourceRootType);
  const destinationRoot = rootForType(paths, destinationRootType);

  if (link.storagePolicy === "unassigned") throw new Error("Content must have a destination policy before copying");
  if (direction === "to_local" && link.storagePolicy !== "location_1") throw new Error("Copy destination does not match the assigned storage policy");
  if (direction === "to_remote" && link.storagePolicy !== "location_2") throw new Error("Copy destination does not match the assigned storage policy");
  if (link.kind === destinationRootType) {
    return {
      status: "skipped",
      direction,
      sourceRootType,
      destinationRootType,
      sourcePath: link.targetPath,
      destinationPath: link.targetPath,
      linkPath: link.linkPath,
      sizeBytes: link.sizeBytes ?? 0,
      message: `Symlink already points to ${destinationRootType}`
    };
  }
  if (link.kind !== sourceRootType) throw new Error(`Copy requires a ${sourceRootType} symlink source`);

  const sourcePath = path.resolve(link.targetPath);
  await reportCopyProgress(reportProgress, { stage: "preparing", message: "Checking source, destination, and symlink state", sourcePath, linkPath: link.linkPath });
  assertInside(sourceRoot, sourcePath, "Source path");
  await assertExistingSourcePathInside(sourceRoot, sourcePath, signal);
  await assertPathParentInside(paths.symlinkDir, link.linkPath, "Symlink path");
  ensureMediaCandidate(sourcePath, link.relativePath, link.linkPath);
  await validateLinkStillPointsTo(link, sourcePath);

  const sourceStatBefore = await assertReadableRegularFile(sourcePath, "Source file", {
    attempts: 3,
    retryDelayMs: 500,
    signal,
    onRetry: () => reportCopyProgress(reportProgress, { stage: "preparing", message: "Source is temporarily unreadable; retrying preflight", sourcePath, linkPath: link.linkPath })
  });
  const destinationPath = copyDestinationPath(link, paths, destinationRootType);
  assertInside(destinationRoot, destinationPath, "Destination path");
  await assertDestinationPathInside(destinationRoot, destinationPath, "Destination path");
  const baseProgress = { sourcePath, destinationPath, linkPath: link.linkPath, sizeBytes: sourceStatBefore.size };
  const canResolveLocalDestination = direction === "to_local" && (localConflictStrategy === "replace" || localConflictStrategy === "keep_both");
  await createDestinationParent(destinationRoot, destinationPath);

  const initialDestinationState = await destinationState(destinationPath);
  if (initialDestinationState) {
    await assertExistingPathInside(destinationRoot, destinationPath, "Destination path");
    const cmp = await compareMediaBytes(runner, sourcePath, destinationPath, reportProgress, baseProgress, "Comparing existing destination file", signal);
    if (cmp.status === "pass") {
      if (behavior.mediaValidation !== "off") {
        await validateMediaStream(runner, behavior.mediaValidation, destinationPath, reportProgress, baseProgress, behavior.mediaValidation === "fast" ? "Fast validation of existing destination media" : "Deep validation of existing destination media", signal);
      }
      throwIfAborted(signal);
      const finalStat = await statRegularFile(destinationPath, "Destination file");
      await reportCopyProgress(reportProgress, { stage: "symlinking", message: "Repointing symlink to existing verified file", sourcePath, destinationPath, linkPath: link.linkPath, sizeBytes: finalStat.size });
      await reportOperation?.({
        stage: "repointed",
        destinationIdentity: serializeCopyFileIdentity(initialDestinationState),
        sizeBytes: finalStat.size,
        resultStatus: "repointed"
      });
      await guardMutation(async () => {
        await validateLinkStillPointsTo(link, sourcePath);
        await assertDestinationState(destinationPath, initialDestinationState);
        await replaceSymlink(paths.symlinkDir, link.linkPath, destinationPath);
      });
      return {
        status: "repointed",
        direction,
        sourceRootType,
        destinationRootType,
        sourcePath,
        destinationPath,
        linkPath: link.linkPath,
        sizeBytes: finalStat.size,
        message: "Destination already matched source; symlink repointed"
      };
    }
    if (!canResolveLocalDestination) {
      return {
        status: "conflict",
        direction,
        sourceRootType,
        destinationRootType,
        sourcePath,
        destinationPath,
        linkPath: link.linkPath,
        sizeBytes: sourceStatBefore.size,
        message: "Destination already exists and differs from source"
      };
    }
    await reportCopyProgress(reportProgress, {
      stage: "preparing",
      message: localConflictStrategy === "keep_both" ? `Existing destination will be preserved after ${postTransferCheck}` : `Existing destination will be replaced after ${postTransferCheck}`,
      sourcePath,
      destinationPath,
      linkPath: link.linkPath,
      sizeBytes: sourceStatBefore.size
    });
  }

  const tempPath = tempFilePath(destinationPath);
  let displacedDestinationPath: string | null = null;
  let destinationDisplaced = false;
  let promotedPath: string | null = null;
  let tempIdentity: CopyFileIdentity | null = null;
  let displacedIdentity: CopyFileIdentity | null = null;
  let promotedIdentity: CopyFileIdentity | null = null;
  let linkRepointed = false;
  try {
    await reportOperation?.({
      stage: "transferring",
      tempPath,
      tempIdentity: null,
      destinationIdentity: null,
      displacedIdentity: null,
      sizeBytes: sourceStatBefore.size
    });
    const transferMessage = direction === "to_local" ? "Downloading source file to a temporary destination" : "Uploading source file to a temporary destination";
    await reportCopyProgress(reportProgress, {
      stage: "copying",
      message: transferMessage,
      sourcePath,
      destinationPath,
      linkPath: link.linkPath,
      sizeBytes: sourceStatBefore.size,
      bytesProcessed: 0,
      bytesCopied: 0,
      totalBytes: sourceStatBefore.size,
      bytesPerSecond: 0,
      remainingSeconds: null
    });
    for (let transferAttempt = 1; transferAttempt <= 2; transferAttempt += 1) {
      try {
        await runner.copyFile(
          sourcePath,
          tempPath,
          (progress) =>
            reportCopyProgress(reportProgress, {
              stage: "copying",
              message: transferMessage,
              sourcePath,
              destinationPath,
              linkPath: link.linkPath,
              sizeBytes: sourceStatBefore.size,
              ...progress
            }),
          signal
        );
        break;
      } catch (error) {
        if (transferAttempt === 2 || !isRetryableTransferError(error) || signal?.aborted) throw error;
        await fs.rm(tempPath, { force: true }).catch(() => undefined);
        await reportCopyProgress(reportProgress, {
          stage: "preparing",
          message: "Transfer hit a temporary I/O error; retrying once",
          sourcePath,
          destinationPath,
          linkPath: link.linkPath,
          sizeBytes: sourceStatBefore.size
        });
        await waitForSourceRetry(signal);
        await assertReadableRegularFile(sourcePath, "Source file", { attempts: 3, retryDelayMs: 500, signal });
      }
    }
    throwIfAborted(signal);
    await fs.chmod(tempPath, copyFileMode);
    const tempStat = await statRegularFile(tempPath, "Temporary copy");
    if (tempStat.size !== sourceStatBefore.size) {
      throw new Error(`Size mismatch after copy (${sourceStatBefore.size} != ${tempStat.size})`);
    }
    await verifyCopiedFile(runner, sourcePath, tempPath, reportProgress, baseProgress, behavior, signal);
    tempIdentity = await requireCopyFileIdentity(tempPath, "Verified temporary copy");
    await reportOperation?.({
      stage: "verified",
      tempPath,
      tempIdentity: serializeCopyFileIdentity(tempIdentity),
      sizeBytes: tempStat.size
    });
    throwIfAborted(signal);
    const sourceStatAfter = await assertReadableRegularFile(sourcePath, "Source file", { attempts: 3, retryDelayMs: 500, signal });
    if (sourceStatAfter.size !== sourceStatBefore.size || sourceStatAfter.mtimeMs !== sourceStatBefore.mtimeMs) {
      throw new Error("Source file changed during copy; destination was not promoted");
    }
    const destinationStateBeforePromotion = await destinationState(destinationPath);
    if (destinationStateBeforePromotion) {
      const cmp = await compareMediaBytes(runner, sourcePath, destinationPath, reportProgress, baseProgress, "Destination appeared during copy; comparing before promotion", signal);
      if (cmp.status === "pass") {
        if (behavior.mediaValidation !== "off") {
          await validateMediaStream(runner, behavior.mediaValidation, destinationPath, reportProgress, baseProgress, behavior.mediaValidation === "fast" ? "Fast validation of matching destination media" : "Deep validation of matching destination media", signal);
        }
        await fs.rm(tempPath, { force: true });
        tempIdentity = null;
        throwIfAborted(signal);
        await reportCopyProgress(reportProgress, { stage: "symlinking", message: "Repointing symlink to matching destination", sourcePath, destinationPath, linkPath: link.linkPath, sizeBytes: tempStat.size });
        await reportOperation?.({
          stage: "repointed",
          tempPath: null,
          tempIdentity: null,
          destinationIdentity: serializeCopyFileIdentity(destinationStateBeforePromotion),
          sizeBytes: tempStat.size,
          resultStatus: "repointed"
        });
        await guardMutation(async () => {
          await validateLinkStillPointsTo(link, sourcePath);
          await assertDestinationState(destinationPath, destinationStateBeforePromotion);
          await replaceSymlink(paths.symlinkDir, link.linkPath, destinationPath);
        });
        linkRepointed = true;
        return {
          status: "repointed",
          direction,
          sourceRootType,
          destinationRootType,
          sourcePath,
          destinationPath,
          linkPath: link.linkPath,
          sizeBytes: tempStat.size,
          message: "Destination appeared during copy and matched source; symlink repointed"
        };
      }
      if (!canResolveLocalDestination || !localConflictStrategy) throw new Error("Destination appeared during copy and differs from source");
      await reportCopyProgress(reportProgress, {
        stage: "symlinking",
        message: localConflictStrategy === "keep_both" ? "Preserving existing destination before promotion" : `Replacing existing destination after ${postTransferCheck}`,
        sourcePath,
        destinationPath,
        linkPath: link.linkPath,
        sizeBytes: tempStat.size
      });
      displacedDestinationPath = await destinationDisplacementPath(destinationPath, localConflictStrategy);
      await reportOperation?.({
        stage: "destination_displaced",
        tempPath,
        displacedPath: displacedDestinationPath,
        tempIdentity: serializeCopyFileIdentity(tempIdentity),
        displacedIdentity: null,
        sizeBytes: tempStat.size
      });
      await guardMutation(async () => {
        await assertDestinationState(destinationPath, destinationStateBeforePromotion);
        await fs.rename(destinationPath, displacedDestinationPath!);
        destinationDisplaced = true;
        displacedIdentity = await requireCopyFileIdentity(displacedDestinationPath!, "Displaced destination");
      });
      if (!displacedIdentity) throw new Error("Displaced destination identity was not captured");
      await reportOperation?.({
        stage: "destination_displaced",
        tempPath,
        displacedPath: displacedDestinationPath,
        tempIdentity: serializeCopyFileIdentity(tempIdentity),
        displacedIdentity: serializeCopyFileIdentity(displacedIdentity),
        sizeBytes: tempStat.size
      });
    }
    throwIfAborted(signal);
    await reportCopyProgress(reportProgress, {
      stage: "symlinking",
      message: verificationEnabled ? "Promoting verified copy and repointing symlink" : "Promoting transferred copy without verification and repointing symlink",
      sourcePath,
      destinationPath,
      linkPath: link.linkPath,
      sizeBytes: tempStat.size
    });
    await reportOperation?.({
      stage: "promoted",
      tempPath,
      displacedPath: displacedDestinationPath,
      tempIdentity: serializeCopyFileIdentity(tempIdentity),
      displacedIdentity: displacedIdentity ? serializeCopyFileIdentity(displacedIdentity) : null,
      destinationIdentity: null,
      sizeBytes: tempStat.size
    });
    await guardMutation(async () => {
      await assertDestinationState(destinationPath, null);
      await fs.rename(tempPath, destinationPath);
      promotedPath = destinationPath;
      promotedIdentity = await requireCopyFileIdentity(destinationPath, "Promoted destination file");
    });
    if (!promotedIdentity) throw new Error("Promoted destination identity was not captured");
    const installedDestinationIdentity = promotedIdentity;
    await reportOperation?.({
      stage: "promoted",
      tempPath,
      displacedPath: displacedDestinationPath,
      tempIdentity: serializeCopyFileIdentity(tempIdentity),
      destinationIdentity: serializeCopyFileIdentity(installedDestinationIdentity),
      displacedIdentity: displacedIdentity ? serializeCopyFileIdentity(displacedIdentity) : null,
      sizeBytes: tempStat.size
    });
    await reportOperation?.({
      stage: "repointed",
      tempPath: null,
      displacedPath: displacedDestinationPath,
      tempIdentity: null,
      destinationIdentity: serializeCopyFileIdentity(installedDestinationIdentity),
      displacedIdentity: displacedIdentity ? serializeCopyFileIdentity(displacedIdentity) : null,
      sizeBytes: tempStat.size,
      resultStatus: "copied"
    });
    await guardMutation(async () => {
      await validateLinkStillPointsTo(link, sourcePath);
      await assertDestinationState(destinationPath, installedDestinationIdentity);
      await replaceSymlink(paths.symlinkDir, link.linkPath, destinationPath);
    });
    linkRepointed = true;
    promotedPath = null;
    return {
      status: "copied",
      direction,
      sourceRootType,
      destinationRootType,
      sourcePath,
      destinationPath,
      linkPath: link.linkPath,
      sizeBytes: tempStat.size,
      message: verificationEnabled ? "Verified copy installed and symlink repointed" : "Copy installed without verification and symlink repointed"
    };
  } catch (error) {
    const rollbackErrors: string[] = [];
    try {
      const currentTempIdentity = await readCopyFileIdentity(tempPath);
      if (currentTempIdentity && tempIdentity && !copyFileIdentitiesMatch(currentTempIdentity, tempIdentity)) {
        rollbackErrors.push("temporary copy changed before cleanup");
      } else if (currentTempIdentity) {
        await fs.rm(tempPath, { force: true });
      }
    } catch (rollbackError) {
      rollbackErrors.push(`temporary copy cleanup failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
    }
    const rollbackSharedPaths = await canRollbackSharedPaths();
    let rollbackDestination = rollbackSharedPaths;
    if (rollbackSharedPaths && linkRepointed) {
      try {
        await guardOwnedMutation(async () => {
          await validateLinkStillPointsTo(link, destinationPath);
          await replaceSymlink(paths.symlinkDir, link.linkPath, sourcePath);
        });
      } catch (rollbackError) {
        rollbackDestination = false;
        rollbackErrors.push(`symlink restore failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
      }
    }
    if (rollbackDestination && promotedPath) {
      try {
        await guardOwnedMutation(async () => {
          const currentPromotedIdentity = await readCopyFileIdentity(promotedPath!);
          if (!promotedIdentity || !copyFileIdentitiesMatch(currentPromotedIdentity, promotedIdentity)) {
            throw new Error("promoted destination changed before rollback");
          }
          await fs.rm(promotedPath!, { force: true });
        });
      } catch (rollbackError) {
        rollbackDestination = false;
        rollbackErrors.push(`promoted destination cleanup failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
      }
    }
    if (rollbackDestination && displacedDestinationPath && destinationDisplaced) {
      try {
        await guardOwnedMutation(async () => {
          const currentDestinationIdentity = await destinationState(destinationPath);
          if (currentDestinationIdentity) throw new Error("destination path became occupied before displaced destination rollback");
          const currentDisplacedIdentity = await readCopyFileIdentity(displacedDestinationPath!);
          if (!displacedIdentity || !copyFileIdentitiesMatch(currentDisplacedIdentity, displacedIdentity)) {
            throw new Error("displaced destination changed before rollback");
          }
          await fs.rename(displacedDestinationPath!, destinationPath);
        });
      } catch (rollbackError) {
        rollbackErrors.push(`displaced destination restore failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
      }
    }
    if (rollbackErrors.length > 0) {
      throw new CopyReconciliationRequiredError(`Copy rollback requires manual reconciliation (${rollbackErrors.join("; ")})`, { cause: error });
    }
    throw error;
  }
}
