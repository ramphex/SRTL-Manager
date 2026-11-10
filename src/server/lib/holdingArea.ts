import fs from "node:fs/promises";
import path from "node:path";
import { assertExistingPathInside, withFilesystemTimeout } from "./filesystemSafety";
import { holdingFolderName, isPathInside } from "./media";

type Stats = import("node:fs").Stats;

/**
 * Guards for the holding area (`<storage root>/.srtl-purged/job-N/...`) and
 * for files a purge or restore is about to touch.
 *
 * Anyone who can write at a storage root's top level, such as another
 * container sharing the mount, could replace `.srtl-purged`, a `job-N` folder
 * or a folder inside one with a symlink, and a later delete would then follow
 * it out of the storage root. So before every mkdir, rename, unlink, rmdir or
 * rm in the holding area, each folder from the storage root down is checked
 * with lstat: it must be a real folder, not a symlink, and `.srtl-purged` and
 * `job-N` must belong to the SRTL user (or to whoever owns the storage root,
 * for mounts that map every file to one owner). The checks run immediately
 * before the filesystem call, not when the job starts.
 *
 * Node has no openat-style calls, so a swap in the moment between the check
 * and the call cannot be ruled out entirely; the window is a few system calls.
 */

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error ? String((error as { code: unknown }).code) : undefined;
}

function refusal(message: string, code = "EUNSAFEPATH"): Error {
  return Object.assign(new Error(message), { code });
}

async function lstatOrNull(target: string): Promise<Stats | null> {
  try {
    return await withFilesystemTimeout(fs.lstat(target), `Inspection of ${target}`);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
}

function relativeParts(root: string, target: string): string[] {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  if (relative === "") return [];
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw refusal(`${target} is outside ${root}`);
  return relative.split(path.sep);
}

function appUserId(): number | null {
  return typeof process.getuid === "function" ? process.getuid() : null;
}

interface FolderChainOptions {
  /** Create folders that are missing, one at a time. */
  create?: boolean;
  /** How many folders below the root must belong to the SRTL user. */
  ownedDepth?: number;
  label: string;
}

/**
 * Checks every folder from `root` (exclusive) down to `folder` (inclusive):
 * each must be a real folder, not a symlink or anything else. Throws with code
 * ENOENT when one is missing and `create` is off.
 */
export async function assertRealFolderChain(root: string, folder: string, options: FolderChainOptions): Promise<void> {
  const parts = relativeParts(root, folder);
  const ownedDepth = options.ownedDepth ?? 0;
  const uid = appUserId();
  let rootOwner: number | null = null;
  if (ownedDepth > 0 && uid !== null) rootOwner = (await withFilesystemTimeout(fs.stat(root), `Inspection of ${root}`)).uid;
  let current = path.resolve(root);
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part);
    let stat = await lstatOrNull(current);
    if (!stat && options.create) {
      await withFilesystemTimeout(fs.mkdir(current), `Creating ${current}`).catch((error: unknown) => {
        if (errorCode(error) !== "EEXIST") throw error;
      });
      stat = await lstatOrNull(current);
    }
    if (!stat) throw refusal(`${options.label}: ${current} does not exist`, "ENOENT");
    if (stat.isSymbolicLink()) throw refusal(`${options.label}: ${current} is a symlink; nothing was changed`);
    if (!stat.isDirectory()) throw refusal(`${options.label}: ${current} is not a folder; nothing was changed`);
    if (index < ownedDepth && uid !== null && stat.uid !== uid && stat.uid !== rootOwner) {
      throw refusal(`${options.label}: ${current} does not belong to the SRTL user; nothing was changed`);
    }
  }
}

export function holdingRoot(root: string): string {
  return path.join(root, holdingFolderName);
}

function assertInsideJobFolder(root: string, target: string, label: string): void {
  const parts = relativeParts(holdingRoot(root), target);
  if (parts.length < 2 || !/^job-\d+$/.test(parts[0]!)) throw refusal(`${label}: ${target} is not inside a job's holding folder`);
}

/** Creates (or checks) a folder inside a job's holding folder, refusing symlinks on the way. */
export async function prepareHoldingFolder(root: string, folder: string): Promise<void> {
  const parts = relativeParts(holdingRoot(root), folder);
  if (parts.length < 1 || !/^job-\d+$/.test(parts[0]!)) throw refusal(`Holding area: ${folder} is not inside a job's holding folder`);
  await assertRealFolderChain(root, folder, { create: true, ownedDepth: 2, label: "Holding area" });
}

/**
 * Checks the folders leading to an entry in the holding area and returns the
 * entry's own lstat, or null when it (or a folder above it) is gone.
 */
export async function inspectHoldingEntry(root: string, target: string, label = "Holding area"): Promise<Stats | null> {
  assertInsideJobFolder(root, target, label);
  try {
    await assertRealFolderChain(root, path.dirname(target), { ownedDepth: 2, label });
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
  return lstatOrNull(target);
}

/** Moves a file or folder into the holding area. Refuses to replace anything already there. */
export async function moveIntoHoldingArea(root: string, from: string, to: string): Promise<void> {
  await prepareHoldingFolder(root, path.dirname(to));
  if (await lstatOrNull(to)) throw refusal(`Holding area: ${to} already exists; nothing was moved`, "EEXIST");
  await withFilesystemTimeout(fs.rename(from, to), `Moving ${from} to the holding area`);
}

/** Removes empty folders in the holding area from `directory` up to the holding root, checking each before removing it. */
export async function removeEmptyHoldingFolders(root: string, directory: string): Promise<void> {
  const stopAt = holdingRoot(root);
  let current = path.resolve(directory);
  while (isPathInside(stopAt, current) && current !== path.resolve(stopAt)) {
    try {
      await assertRealFolderChain(root, current, { ownedDepth: 2, label: "Holding area" });
    } catch {
      return;
    }
    const removed = await fs.rmdir(current).then(() => true, () => false);
    if (!removed) return;
    current = path.dirname(current);
  }
  // The holding root itself goes once it is empty.
  try {
    await assertRealFolderChain(root, stopAt, { ownedDepth: 1, label: "Holding area" });
    await fs.rmdir(stopAt);
  } catch {
    // Not empty, missing or not ours: leave it.
  }
}

/**
 * Permanently deletes an entry in the holding area after checking the whole
 * path right before the delete. A symlink in the entry's own place is removed
 * as a link; nothing it points to is touched.
 */
export async function deleteHoldingEntry(root: string, target: string, recursive: boolean): Promise<void> {
  const stat = await inspectHoldingEntry(root, target);
  if (!stat) return;
  if (stat.isDirectory() && recursive) {
    await fs.rm(target, { recursive: true, force: true });
    return;
  }
  await fs.unlink(target).catch((error: unknown) => {
    if (errorCode(error) !== "ENOENT") throw error;
  });
}

/**
 * Checks a path a purge is about to move or delete, immediately before the
 * call: it must still resolve inside the storage root, and lstat must show the
 * expected kind of entry. Returns the lstat.
 */
export async function assertStillInside(root: string, target: string, kind: "file" | "folder", label: string): Promise<Stats> {
  const stat = await withFilesystemTimeout(fs.lstat(target), `Inspection of ${target}`);
  if (kind === "file" ? !stat.isFile() : !stat.isDirectory()) {
    throw new Error(kind === "file" ? `${label} is no longer a regular file; nothing was changed` : `${label} is no longer a folder; nothing was changed`);
  }
  await assertExistingPathInside(root, target, label);
  return stat;
}

/**
 * Puts a held entry back where it came from. The folders on the way back are
 * created one at a time and must be real folders inside the storage root, and
 * an entry that has appeared at the destination is never replaced: files are
 * hard-linked into place (which fails if anything is there) and then removed
 * from the holding area. Where hard links are not supported, and for folders,
 * the destination is checked immediately before the rename.
 */
export async function moveOutOfHoldingArea(root: string, from: string, to: string, label: string): Promise<void> {
  const held = await inspectHoldingEntry(root, from, label);
  if (!held) throw refusal(`${label} is no longer in the holding area`, "ENOENT");
  if (held.isSymbolicLink() || (!held.isFile() && !held.isDirectory())) throw refusal(`${label} in the holding area is not a regular file or folder; nothing was restored`);
  await ensureFolderInside(root, path.dirname(to), label);
  if (await lstatOrNull(to)) throw refusal(`Something now exists at ${to}; nothing was restored`, "EEXIST");
  if (held.isFile()) {
    try {
      await withFilesystemTimeout(fs.link(from, to), `Restoring ${to}`);
      await fs.unlink(from);
      return;
    } catch (error) {
      if (errorCode(error) === "EEXIST") throw refusal(`Something now exists at ${to}; nothing was restored`, "EEXIST");
      if (!["EPERM", "ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EXDEV", "EMLINK"].includes(errorCode(error) ?? "")) throw error;
    }
    if (await lstatOrNull(to)) throw refusal(`Something now exists at ${to}; nothing was restored`, "EEXIST");
  }
  await withFilesystemTimeout(fs.rename(from, to), `Restoring ${to}`);
}

/**
 * Creates the folders leading to a path inside a storage root one at a time.
 * Existing folders may be symlinks (a section folder can be), but each must
 * resolve inside the root.
 */
export async function ensureFolderInside(root: string, folder: string, label: string): Promise<void> {
  const parts = relativeParts(root, folder);
  let current = path.resolve(root);
  for (const part of parts) {
    current = path.join(current, part);
    if (!(await lstatOrNull(current))) {
      await withFilesystemTimeout(fs.mkdir(current), `Creating ${current}`).catch((error: unknown) => {
        if (errorCode(error) !== "EEXIST") throw error;
      });
    }
    await assertExistingPathInside(root, current, label);
    const stat = await withFilesystemTimeout(fs.stat(current), `Inspection of ${current}`);
    if (!stat.isDirectory()) throw refusal(`${label}: ${current} is not a folder; nothing was restored`);
  }
}
