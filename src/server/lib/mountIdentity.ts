import fs from "node:fs/promises";
import path from "node:path";
import type { PathMountIdentity, PathRootIdentity } from "../../shared/types";

function decodeMountInfoField(value: string): string {
  return value.replace(/\\([0-7]{3})/g, (_match, octal: string) => String.fromCharCode(Number.parseInt(octal, 8)));
}

export function parseLinuxMountInfo(contents: string): PathMountIdentity[] {
  const mounts: PathMountIdentity[] = [];
  for (const line of contents.split("\n")) {
    const separator = line.indexOf(" - ");
    if (separator < 0) continue;
    const mounted = line.slice(0, separator).split(" ");
    const filesystem = line.slice(separator + 3).split(" ");
    if (mounted.length < 5 || filesystem.length < 2) continue;
    mounts.push({
      mountPoint: path.resolve(decodeMountInfoField(mounted[4])),
      root: decodeMountInfoField(mounted[3]),
      filesystemType: decodeMountInfoField(filesystem[0]),
      source: decodeMountInfoField(filesystem[1])
    });
  }
  return mounts;
}

export function findMountIdentity(realPath: string, mounts: PathMountIdentity[]): PathMountIdentity | null {
  const candidate = path.resolve(realPath);
  let match: PathMountIdentity | null = null;
  for (const mount of mounts) {
    const relative = path.relative(mount.mountPoint, candidate);
    const containsCandidate = relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
    if (containsCandidate && (!match || mount.mountPoint.length > match.mountPoint.length)) match = mount;
  }
  return match;
}

function mountIdentitiesMatch(expected: PathMountIdentity, actual: PathMountIdentity): boolean {
  return (
    expected.mountPoint === actual.mountPoint &&
    expected.root === actual.root &&
    expected.filesystemType === actual.filesystemType &&
    expected.source === actual.source
  );
}

export function persistentRootIdentityMatch(expected: PathRootIdentity | null, actual: PathRootIdentity): boolean {
  if (!expected?.available || !actual.available) return false;
  if (!expected.realPath || !actual.realPath || expected.realPath !== actual.realPath) return false;
  if (expected.mount) return Boolean(actual.mount && mountIdentitiesMatch(expected.mount, actual.mount));
  if (expected.device && actual.device && expected.device === actual.device) return true;
  if (!actual.mount) return true;
  return actual.mount.mountPoint !== path.parse(actual.realPath).root;
}

export async function inspectMountIdentity(realPath: string): Promise<PathMountIdentity | null> {
  if (process.platform !== "linux") return null;
  const contents = await fs.readFile("/proc/self/mountinfo", "utf8");
  const mount = findMountIdentity(realPath, parseLinuxMountInfo(contents));
  if (!mount) throw new Error(`No Linux mount contains ${realPath}`);
  return mount;
}
