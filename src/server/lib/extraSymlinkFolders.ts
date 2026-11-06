import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { PathsSettings } from "../../shared/types";
import { withFilesystemTimeout } from "./filesystemSafety";
import { isPathInside } from "./media";

let configured: string[] = [];

/** Sets the process-wide list. Called at startup from SRTL_EXTRA_SYMLINK_DIRS. */
export function configureExtraSymlinkFolders(folders: string[]): void {
  configured = [...folders];
}

export function extraSymlinkFolders(): string[] {
  return configured;
}

export function parseExtraSymlinkFolders(value: string | undefined): string[] {
  return [...new Set((value ?? "").split(",").map((entry) => entry.trim()).filter(Boolean).map((entry) => (path.isAbsolute(entry) ? path.resolve(entry) : entry)))];
}

/** What a configured list is wrong about. SRTL changes files inside its own roots, so a folder there could not stay read-only. */
export function extraSymlinkFolderProblems(folders: string[], paths: PathsSettings, sections: string[]): string[] {
  const problems: string[] = [];
  const managedRoots = [paths.symlinkDir, paths.localDir, paths.remoteDir].filter(Boolean);
  const storageRoots = [paths.localDir, paths.remoteDir].filter(Boolean);
  const sectionRoots = paths.symlinkDir ? sections.map((section) => path.join(paths.symlinkDir, section)) : [];
  for (const folder of folders) {
    if (!path.isAbsolute(folder)) problems.push(`Extra symlink folder ${folder} must be an absolute path.`);
    else if (managedRoots.some((root) => isPathInside(folder, root))) problems.push(`Extra symlink folder ${folder} cannot be the same as, or contain, a symlink or storage root.`);
    else if (storageRoots.some((root) => isPathInside(root, folder))) problems.push(`Extra symlink folder ${folder} cannot be inside a storage root.`);
    else if (sectionRoots.some((root) => isPathInside(root, folder))) problems.push(`Extra symlink folder ${folder} cannot be inside a library folder SRTL manages.`);
  }
  return problems;
}

export interface ExtraSymlinks {
  folders: string[];
  // Each file or folder a link resolves to inside a storage root, with one link that points there.
  targets: Map<string, string>;
  linkCount: number;
  // Links whose targets are outside both storage roots, so they cannot protect anything.
  unmatchedCount: number;
  // Anything here means the targets are incomplete, so nothing may be purged on the strength of them.
  problems: string[];
}

function emptyExtraSymlinks(folders: string[]): ExtraSymlinks {
  return { folders, targets: new Map(), linkCount: 0, unmatchedCount: 0, problems: [] };
}

function errorCode(error: unknown): string | null {
  return error !== null && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : null;
}

function reasonOf(error: unknown): string {
  return errorCode(error) ?? (error instanceof Error ? error.message : String(error));
}

type StorageRoot = { root: string; real: string };

async function resolveTarget(linkPath: string, storageRoots: StorageRoot[]): Promise<string | null> {
  const raw = await withFilesystemTimeout(fs.readlink(linkPath), `Reading symlink ${linkPath}`);
  const target = path.resolve(path.dirname(linkPath), raw);
  if (storageRoots.some(({ root }) => isPathInside(root, target))) return target;
  // A link to another link, such as one in the library, still ends up at a stored file.
  const real = await withFilesystemTimeout(fs.realpath(target), `Resolving symlink ${linkPath}`).catch(() => null);
  if (!real) return null;
  const storage = storageRoots.find((candidate) => isPathInside(candidate.real, real));
  return storage ? path.join(storage.root, path.relative(storage.real, real)) : null;
}

async function walkFolder(directory: string, isRoot: boolean, storageRoots: StorageRoot[], result: ExtraSymlinks): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await withFilesystemTimeout(fs.readdir(directory, { withFileTypes: true }), `Reading extra symlink folder ${directory}`);
  } catch (error) {
    // A subfolder can disappear mid-walk. The configured folder itself must always be there.
    if (!isRoot && errorCode(error) === "ENOENT") return;
    result.problems.push(`Extra symlink folder ${directory} could not be read (${reasonOf(error)}).`);
    return;
  }
  // An unmounted folder looks empty, the same way an unmounted storage root does.
  if (isRoot && entries.length === 0) result.problems.push(`Extra symlink folder ${directory} is empty, so it may not be mounted.`);
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await walkFolder(entryPath, false, storageRoots, result);
    } else if (entry.isSymbolicLink()) {
      try {
        const target = await resolveTarget(entryPath, storageRoots);
        result.linkCount += 1;
        if (target === null) result.unmatchedCount += 1;
        else if (!result.targets.has(target)) result.targets.set(target, entryPath);
      } catch (error) {
        if (errorCode(error) !== "ENOENT" && errorCode(error) !== "EINVAL") result.problems.push(`Symlink ${entryPath} could not be read (${reasonOf(error)}).`);
      }
    }
  }
}

/** Walks every configured folder. Only ever reads. Problems are reported, never thrown, so each caller can refuse in its own way. */
export async function readExtraSymlinks(paths: PathsSettings, sections: string[]): Promise<ExtraSymlinks> {
  const folders = extraSymlinkFolders();
  const result = emptyExtraSymlinks(folders);
  if (folders.length === 0) return result;
  result.problems.push(...extraSymlinkFolderProblems(folders, paths, sections));
  if (result.problems.length > 0) return result;
  const storageRoots = await Promise.all(
    [paths.localDir, paths.remoteDir].filter(Boolean).map(async (configuredRoot) => {
      const root = path.resolve(configuredRoot);
      return { root, real: await withFilesystemTimeout(fs.realpath(root), `Resolving ${root}`).catch(() => root) };
    })
  );
  for (const folder of folders) await walkFolder(folder, true, storageRoots, result);
  return result;
}

/** The link that points at this path or at a folder above it. Links are often made to a whole release folder. */
export function extraLinkCovering(extra: ExtraSymlinks, targetPath: string): string | null {
  if (extra.targets.size === 0) return null;
  let current = path.resolve(targetPath);
  while (true) {
    const link = extra.targets.get(current);
    if (link) return link;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/** The link that points at this folder, above it, or at anything inside it. */
export function extraLinkTouchingFolder(extra: ExtraSymlinks, directory: string): string | null {
  const covering = extraLinkCovering(extra, directory);
  if (covering) return covering;
  for (const [target, link] of extra.targets) if (isPathInside(directory, target)) return link;
  return null;
}

export function extraSymlinkRefusal(extra: ExtraSymlinks): string | null {
  return extra.problems.length > 0 ? `${extra.problems.join(" ")} Purging is refused until SRTL_EXTRA_SYMLINK_DIRS can be read in full.` : null;
}
