import fs from "node:fs/promises";
import path from "node:path";
import { isPathInside } from "./media";

const defaultFilesystemTimeoutMs = 15_000;

export interface ReadableFileSnapshot {
  size: number;
  mtimeMs: number;
}

export interface ReadableFileOptions {
  attempts?: number;
  retryDelayMs?: number;
  signal?: AbortSignal;
  timeoutMs?: number;
  onRetry?: (attempt: number, error: unknown) => Promise<void> | void;
}

function configuredTimeoutMs(): number {
  const parsed = Number(process.env.SRTL_FILESYSTEM_TIMEOUT_MS);
  if (!Number.isFinite(parsed) || parsed < 1_000) return defaultFilesystemTimeoutMs;
  return Math.min(parsed, 5 * 60_000);
}

export async function withFilesystemTimeout<T>(operation: Promise<T>, description: string, timeoutMs = configuredTimeoutMs()): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new Error(`${description} timed out after ${(timeoutMs / 1_000).toFixed(1)} seconds`)), timeoutMs);
  });
  try {
    return await Promise.race([operation, deadline]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function abortError(): Error {
  return new Error("Job terminated");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function waitForRetry(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw abortError();
  if (delayMs <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    const timeout = setTimeout(finish, delayMs);
    const abort = () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      reject(abortError());
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

export async function assertReadableRegularFile(filePath: string, label: string, options: ReadableFileOptions = {}): Promise<ReadableFileSnapshot> {
  const attempts = Math.max(1, Math.min(Math.trunc(options.attempts ?? 1), 5));
  const retryDelayMs = Math.max(0, Math.min(Math.trunc(options.retryDelayMs ?? 250), 5_000));
  let lastError: unknown = new Error(`${label} could not be read`);

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (options.signal?.aborted) throw abortError();
    let fileHandle: Awaited<ReturnType<typeof fs.open>> | null = null;
    try {
      const stat = await withFilesystemTimeout(fs.stat(filePath), `${label} metadata check`, options.timeoutMs);
      if (!stat.isFile()) throw new Error(`${label} is not a regular file`);
      fileHandle = await withFilesystemTimeout(fs.open(filePath, "r"), `${label} read check`, options.timeoutMs);
      if (stat.size > 0) {
        const buffer = Buffer.allocUnsafe(1);
        const read = await withFilesystemTimeout(fileHandle.read(buffer, 0, 1, 0), `${label} first-byte read`, options.timeoutMs);
        if (read.bytesRead !== 1) throw new Error(`${label} returned no data during its read check`);
      }
      return { size: stat.size, mtimeMs: stat.mtimeMs };
    } catch (error) {
      lastError = error;
    } finally {
      if (fileHandle) await fileHandle.close().catch(() => undefined);
    }

    if (attempt < attempts) {
      await options.onRetry?.(attempt, lastError);
      await waitForRetry(retryDelayMs, options.signal);
    }
  }

  const attemptsLabel = attempts === 1 ? "read check" : `${attempts} read attempts`;
  throw new Error(`${label} is missing or unreadable after ${attemptsLabel}: ${errorMessage(lastError)}`, { cause: lastError });
}

async function realPath(filePath: string, label: string): Promise<string> {
  return withFilesystemTimeout(fs.realpath(filePath), `${label} realpath`);
}

async function nearestExistingAncestor(candidate: string, root: string): Promise<string> {
  let current = path.resolve(candidate);
  const resolvedRoot = path.resolve(root);
  while (isPathInside(resolvedRoot, current)) {
    try {
      await withFilesystemTimeout(fs.lstat(current), `Inspection of ${current}`);
      return current;
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
    }
    if (current === resolvedRoot) break;
    current = path.dirname(current);
  }
  throw new Error(`No existing parent for ${candidate} is inside configured root`);
}

export async function assertExistingPathInside(root: string, candidate: string, label: string): Promise<string> {
  if (!isPathInside(root, candidate)) throw new Error(`${label} is outside configured root`);
  const [rootRealPath, candidateRealPath] = await Promise.all([realPath(root, "Configured root"), realPath(candidate, label)]);
  if (!isPathInside(rootRealPath, candidateRealPath)) throw new Error(`${label} resolves outside configured root`);
  return candidateRealPath;
}

export async function assertPathParentInside(root: string, candidate: string, label: string): Promise<void> {
  if (!isPathInside(root, candidate)) throw new Error(`${label} is outside configured root`);
  const rootRealPath = await realPath(root, "Configured root");
  const existingParent = await nearestExistingAncestor(path.dirname(candidate), root);
  const parentRealPath = await realPath(existingParent, `${label} parent`);
  if (!isPathInside(rootRealPath, parentRealPath)) throw new Error(`${label} parent resolves outside configured root`);
}

export async function assertDestinationPathInside(root: string, candidate: string, label: string): Promise<void> {
  await assertPathParentInside(root, candidate, label);
  try {
    await withFilesystemTimeout(fs.lstat(candidate), `Inspection of ${label}`);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  await assertExistingPathInside(root, candidate, label);
}
