import fs from "node:fs/promises";
import path from "node:path";
import { isPathInside } from "./media";

const defaultFilesystemTimeoutMs = 15_000;

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
