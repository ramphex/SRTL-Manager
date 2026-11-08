import path from "node:path";

// Video containers, plus disc images and DVD/Blu-ray structure files, which media servers can also play.
const mediaExtensions = new Set([
  ".3g2",
  ".3gp",
  ".asf",
  ".avi",
  ".bup",
  ".divx",
  ".evo",
  ".f4v",
  ".flv",
  ".ifo",
  ".img",
  ".iso",
  ".m2t",
  ".m2ts",
  ".m2v",
  ".m4v",
  ".mk3d",
  ".mkv",
  ".mov",
  ".mp4",
  ".mpe",
  ".mpeg",
  ".mpg",
  ".mpv",
  ".mts",
  ".ogm",
  ".ogv",
  ".rm",
  ".rmvb",
  ".ts",
  ".vob",
  ".webm",
  ".wmv",
  ".wtv",
  ".xvid"
]);

// Purged orphans wait out their holding period here, inside each storage root.
export const holdingFolderName = ".srtl-purged";

export function isMediaFile(filePath: string): boolean {
  return mediaExtensions.has(path.extname(filePath).toLowerCase());
}

/** True when the path, or any folder above it, is in the set. A link to a folder covers everything inside it. */
export function isCoveredByPath(paths: ReadonlySet<string>, candidate: string): boolean {
  let current = path.resolve(candidate);
  while (true) {
    if (paths.has(current)) return true;
    const parent = path.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

/** The path itself and every folder above it, nearest first. */
export function pathAndAncestors(candidate: string): string[] {
  const result: string[] = [];
  let current = path.resolve(candidate);
  while (true) {
    result.push(current);
    const parent = path.dirname(current);
    if (parent === current) return result;
    current = parent;
  }
}

export function isPathInside(root: string, candidate: string): boolean {
  const relativePath = path.relative(path.resolve(root), path.resolve(candidate));
  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

export function safeRelativePath(root: string, candidate: string): string {
  const relativePath = path.relative(root, candidate);
  return relativePath.startsWith("..") ? candidate : relativePath;
}
