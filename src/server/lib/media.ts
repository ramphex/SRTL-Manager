import path from "node:path";

const mediaExtensions = new Set([
  ".3g2",
  ".3gp",
  ".avi",
  ".flv",
  ".m2ts",
  ".m4v",
  ".mkv",
  ".mov",
  ".mp4",
  ".mpeg",
  ".mpg",
  ".mts",
  ".ts",
  ".webm",
  ".wmv"
]);

// Purged orphans wait out their holding period here, inside each storage root.
export const holdingFolderName = ".srtl-purged";

export function isMediaFile(filePath: string): boolean {
  return mediaExtensions.has(path.extname(filePath).toLowerCase());
}

export function isPathInside(root: string, candidate: string): boolean {
  const relativePath = path.relative(path.resolve(root), path.resolve(candidate));
  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

export function safeRelativePath(root: string, candidate: string): string {
  const relativePath = path.relative(root, candidate);
  return relativePath.startsWith("..") ? candidate : relativePath;
}
