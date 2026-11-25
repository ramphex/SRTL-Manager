import fs from "node:fs/promises";
import path from "node:path";
import { and, asc, count, desc, eq, gte, inArray, isNull } from "drizzle-orm";
import type {
  BrokenLinkCleanupRecord,
  BrokenLinkCleanupStage,
  BrokenLinkItem,
  BrokenLinkMountCheck,
  BrokenLinkRescanResult,
  BrokenLinkReview,
  BrokenLinkSafety,
  BrokenLinkTargetRoot,
  PathsSettings,
  StorageRootType
} from "../../shared/types";
import { getJsonSetting, getSectionSettings, type Db } from "../db/database";
import * as schema from "../db/schema";
import { withFilesystemTimeout } from "./filesystemSafety";
import { isPathInside } from "./media";
import { queueRescansForJob, queueSearchesForRemovedLinks } from "./reRequests";
import { storageRootLooksMounted, wholeLibrarySymlinkScans } from "./scanner";

// Links whose target exists but cannot be read (a first-byte read failure at a title rescan) are not broken links and are
// never listed or removed here. They could get a list of their own; for now a title rescan logs them as job warnings.

/** The jump that blocks deletes: the broken count is this many times the full scan before, and at least this many higher. */
export const brokenLinkJump = { factor: 3, minimum: 50 } as const;

export const brokenLinkRule =
  `Deleting is blocked while a storage location the links point into looks down or empty, and when the broken count is at least ${brokenLinkJump.factor} times ` +
  `the full scan before it and at least ${brokenLinkJump.minimum} higher. A mount that restarts during a scan makes every link into it look broken. ` +
  "A full symlink scan with the mount up clears the jump: either the links work again, or the scan finds the same number and confirms them.";

export function isBrokenLinkJump(current: number, previous: number): boolean {
  return current >= previous * brokenLinkJump.factor && current - previous >= brokenLinkJump.minimum;
}

const recheckConcurrency = 16;
const removedListDays = 30;
const removedListLimit = 2_000;
const emptyPaths: PathsSettings = { symlinkDir: "", localDir: "", remoteDir: "" };

function errorCode(error: unknown): string | null {
  return error !== null && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : null;
}

const isNotFound = (error: unknown) => ["ENOENT", "ENOTDIR"].includes(errorCode(error) ?? "");
const describe = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function brokenLinkTargetRoot(paths: PathsSettings, targetPath: string): BrokenLinkTargetRoot {
  if (paths.remoteDir && isPathInside(paths.remoteDir, targetPath)) return "remote";
  if (paths.localDir && isPathInside(paths.localDir, targetPath)) return "local";
  return "other";
}

export type BrokenTargetState = { state: "broken" | "target_exists" | "unchecked"; detail: string };

/** Whether a link target is gone. Only "not found" counts as gone; any other error means it could not be told. Read-only. */
export async function brokenTargetState(targetPath: string): Promise<BrokenTargetState> {
  try {
    await withFilesystemTimeout(fs.stat(targetPath), `Target check for ${targetPath}`);
    return { state: "target_exists", detail: "The target exists again." };
  } catch (error) {
    if (isNotFound(error)) return { state: "broken", detail: "The target is gone." };
    return { state: "unchecked", detail: `The target could not be checked (${describe(error)}).` };
  }
}

export type BrokenLinkDiskState = { state: "broken" | "target_exists" | "changed" | "unchecked"; detail: string };

/** Checks one listed link on disk: still a symlink, still pointing at the recorded target, and that target still gone. Read-only. */
export async function inspectBrokenLink(linkPath: string, recordedTarget: string): Promise<BrokenLinkDiskState> {
  let stat: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    stat = await withFilesystemTimeout(fs.lstat(linkPath), `Inspection of broken symlink ${linkPath}`);
  } catch (error) {
    if (isNotFound(error)) return { state: "changed", detail: "The link is gone." };
    return { state: "unchecked", detail: `The link could not be checked (${describe(error)}).` };
  }
  if (!stat.isSymbolicLink()) return { state: "changed", detail: "The path is no longer a symlink." };
  try {
    const raw = await withFilesystemTimeout(fs.readlink(linkPath), `Target read for broken symlink ${linkPath}`);
    const actual = path.isAbsolute(raw) ? raw : path.resolve(path.dirname(linkPath), raw);
    if (path.resolve(actual) !== path.resolve(recordedTarget)) return { state: "changed", detail: "The link points somewhere else now." };
  } catch (error) {
    return { state: "unchecked", detail: `The link could not be read (${describe(error)}).` };
  }
  return brokenTargetState(recordedTarget);
}

function rootLabel(rootType: StorageRootType): string {
  return rootType === "remote" ? "remote" : "local";
}

/** The remote storage root, and the local one when any link points into it, checked for being mounted and not empty. */
export async function brokenLinkMountChecks(paths: PathsSettings, targetRoots: Iterable<BrokenLinkTargetRoot>): Promise<BrokenLinkMountCheck[]> {
  const roots = new Set<StorageRootType>(["remote"]);
  for (const root of targetRoots) if (root !== "other") roots.add(root);
  const checks: BrokenLinkMountCheck[] = [];
  for (const rootType of ["remote", "local"] as const) {
    if (!roots.has(rootType)) continue;
    const rootPath = rootType === "remote" ? paths.remoteDir : paths.localDir;
    const result = await storageRootLooksMounted(rootPath);
    checks.push({ rootType, path: rootPath, mounted: result.mounted, reason: result.reason });
  }
  return checks;
}

export function mountWarning(check: BrokenLinkMountCheck): string {
  return `The ${rootLabel(check.rootType)} storage at ${check.path || "(not set)"} looks down: ${check.reason ?? "it lists nothing."} Every link into it looks broken while it is down, so nothing can be deleted or rescanned until it is back and a full symlink scan has run.`;
}

export async function currentBrokenLinkCount(db: Db): Promise<number> {
  const [row] = await db.select({ value: count() }).from(schema.mediaLinks).where(and(eq(schema.mediaLinks.kind, "broken"), isNull(schema.mediaLinks.missingSince)));
  return Number(row?.value ?? 0);
}

/** A jump in broken links that a mount restart would explain, or null. */
export async function brokenLinkSpike(db: Db, currentCount: number): Promise<BrokenLinkSafety["spike"]> {
  const sections = (await getSectionSettings(db)).sections;
  if (sections.length === 0) return null;
  const [latest, previous] = await wholeLibrarySymlinkScans(db, sections, 2);
  if (!latest) return null;
  if (previous && isBrokenLinkJump(latest.brokenLinks, previous.brokenLinks)) {
    return {
      current: latest.brokenLinks,
      previous: previous.brokenLinks,
      message: `The last full symlink scan found ${latest.brokenLinks.toLocaleString()} broken links, up from ${previous.brokenLinks.toLocaleString()} in the full scan before it. That looks like a storage mount that dropped during the scan. Run a full symlink scan with the mount up before deleting.`
    };
  }
  if (isBrokenLinkJump(currentCount, latest.brokenLinks)) {
    return {
      current: currentCount,
      previous: latest.brokenLinks,
      message: `${currentCount.toLocaleString()} links are broken now, up from ${latest.brokenLinks.toLocaleString()} at the last full symlink scan. Title rescans since then found the rest, which can happen while a storage mount is down. Run a full symlink scan with the mount up before deleting.`
    };
  }
  return null;
}

export async function brokenLinkSafety(db: Db, paths: PathsSettings, targetRoots: Iterable<BrokenLinkTargetRoot>, currentCount?: number): Promise<BrokenLinkSafety> {
  const mounts = await brokenLinkMountChecks(paths, targetRoots);
  const spike = await brokenLinkSpike(db, currentCount ?? (await currentBrokenLinkCount(db)));
  const warnings = [...mounts.filter((check) => !check.mounted).map(mountWarning), ...(spike ? [spike.message] : [])];
  return { blocked: warnings.length > 0, mounts, spike, warnings, rule: brokenLinkRule };
}

async function mapLimit<T, R>(items: T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await run(items[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}

type MediaLinkRow = typeof schema.mediaLinks.$inferSelect;

export async function brokenLinkRows(db: Db, ids?: number[]): Promise<MediaLinkRow[]> {
  const broken = and(eq(schema.mediaLinks.kind, "broken"), isNull(schema.mediaLinks.missingSince));
  return db
    .select()
    .from(schema.mediaLinks)
    .where(ids ? and(broken, inArray(schema.mediaLinks.id, ids)) : broken)
    .orderBy(asc(schema.mediaLinks.section), asc(schema.mediaLinks.itemName), asc(schema.mediaLinks.relativePath));
}

/** The broken link review: links the last scans found broken, each checked again on disk unless a mount looks down. */
export async function listBrokenLinkReview(db: Db): Promise<BrokenLinkReview> {
  const paths = await getJsonSetting<PathsSettings>(db, "paths", emptyPaths);
  const settings = await getSectionSettings(db);
  const rows = await brokenLinkRows(db);
  const targetRoots = rows.map((row) => brokenLinkTargetRoot(paths, row.targetPath));
  const safety = await brokenLinkSafety(db, paths, targetRoots, rows.length);
  const mountsUp = safety.mounts.every((check) => check.mounted);
  const notListed = { targetExists: 0, changed: 0, unchecked: 0 };
  // With a mount down every recheck would say "gone", so the last scan's list is shown as it is, and nothing can be deleted.
  const states = mountsUp ? await mapLimit(rows, recheckConcurrency, (row) => inspectBrokenLink(row.linkPath, row.targetPath)) : null;
  const items: BrokenLinkItem[] = [];
  rows.forEach((row, index) => {
    const state = states?.[index]?.state ?? "broken";
    if (state === "target_exists") notListed.targetExists += 1;
    else if (state === "changed") notListed.changed += 1;
    else if (state === "unchecked") notListed.unchecked += 1;
    if (state !== "broken") return;
    items.push({
      mediaLinkId: row.id,
      section: row.section,
      sectionTitle: settings.sectionTitles?.[row.section]?.trim() || row.section,
      itemName: row.itemName,
      relativePath: row.relativePath,
      linkPath: row.linkPath,
      targetPath: row.targetPath,
      targetRoot: targetRoots[index]!,
      brokenSince: row.brokenSince ?? null,
      lastSeenAt: row.lastSeenAt ?? null
    });
  });
  const [lastFull] = settings.sections.length ? await wholeLibrarySymlinkScans(db, settings.sections, 1) : [];
  return { items, safety, rechecked: mountsUp, notListed, lastFullScanAt: lastFull?.startedAt ?? null };
}

function cleanupRecord(row: { operation: typeof schema.symlinkCleanupOperations.$inferSelect; link: MediaLinkRow }): BrokenLinkCleanupRecord {
  return {
    operationId: row.operation.id,
    jobId: row.operation.jobId,
    mediaLinkId: row.operation.mediaLinkId,
    section: row.link.section,
    itemName: row.link.itemName,
    relativePath: row.link.relativePath,
    linkPath: row.operation.linkPath,
    targetPath: row.operation.expectedTargetPath,
    stage: row.operation.stage as BrokenLinkCleanupStage,
    message: row.operation.errorMessage,
    completedAt: row.operation.completedAt
  };
}

/** Every link of one broken link cleanup job, with what happened to it. */
export async function brokenLinkCleanupResults(db: Db, jobId: number): Promise<BrokenLinkCleanupRecord[]> {
  const rows = await db
    .select({ operation: schema.symlinkCleanupOperations, link: schema.mediaLinks })
    .from(schema.symlinkCleanupOperations)
    .innerJoin(schema.mediaLinks, eq(schema.mediaLinks.id, schema.symlinkCleanupOperations.mediaLinkId))
    .where(and(eq(schema.symlinkCleanupOperations.jobId, jobId), eq(schema.symlinkCleanupOperations.reason, "broken_link")))
    .orderBy(asc(schema.symlinkCleanupOperations.id));
  return rows.map(cleanupRecord);
}

/** Broken links removed in the last 30 days, newest first, for asking Radarr or Sonarr to rescan them again. */
export async function listRemovedBrokenLinks(db: Db, now = Date.now()): Promise<BrokenLinkCleanupRecord[]> {
  const since = new Date(now - removedListDays * 24 * 60 * 60 * 1000).toISOString();
  const rows = await db
    .select({ operation: schema.symlinkCleanupOperations, link: schema.mediaLinks })
    .from(schema.symlinkCleanupOperations)
    .innerJoin(schema.mediaLinks, eq(schema.mediaLinks.id, schema.symlinkCleanupOperations.mediaLinkId))
    .where(
      and(
        eq(schema.symlinkCleanupOperations.reason, "broken_link"),
        inArray(schema.symlinkCleanupOperations.stage, ["removed", "already_missing"]),
        gte(schema.symlinkCleanupOperations.completedAt, since)
      )
    )
    .orderBy(desc(schema.symlinkCleanupOperations.completedAt), desc(schema.symlinkCleanupOperations.id))
    .limit(removedListLimit);
  return rows.map(cleanupRecord);
}

/** The removed links behind these journal rows, with whether a link is back at the same path since. */
export async function removedBrokenLinks(db: Db, operationIds: number[]): Promise<Array<BrokenLinkCleanupRecord & { relinked: boolean }>> {
  if (operationIds.length === 0) return [];
  const rows = await db
    .select({ operation: schema.symlinkCleanupOperations, link: schema.mediaLinks })
    .from(schema.symlinkCleanupOperations)
    .innerJoin(schema.mediaLinks, eq(schema.mediaLinks.id, schema.symlinkCleanupOperations.mediaLinkId))
    .where(
      and(
        inArray(schema.symlinkCleanupOperations.id, operationIds),
        eq(schema.symlinkCleanupOperations.reason, "broken_link"),
        inArray(schema.symlinkCleanupOperations.stage, ["removed", "already_missing"])
      )
    );
  return rows.map((row) => ({ ...cleanupRecord(row), relinked: row.link.missingSince === null }));
}

/** The title-relative file name Radarr and Sonarr report for a library link. */
export function linkFileName(relativePath: string, section: string, itemName: string): string {
  const parts = relativePath.split("/");
  if (section && parts[0] === section) parts.shift();
  if (itemName && parts[0] === itemName) parts.shift();
  return parts.join("/");
}

/**
 * Asks Radarr or Sonarr to rescan the titles of links that broken link cleanups removed, and with `search` also searches for
 * the removed items. Rows go to the job that removed the links, so its log shows what each arr was sent.
 */
export async function requestRescansForRemovedLinks(db: Db, operationIds: number[], search: boolean): Promise<BrokenLinkRescanResult> {
  const records = await removedBrokenLinks(db, [...new Set(operationIds)]);
  const result: BrokenLinkRescanResult = { titles: 0, asked: 0, searched: 0, notMatched: 0, failed: 0, problems: [], relinked: 0 };
  const byJob = new Map<number, typeof records>();
  for (const record of records) {
    // A link is back at this path, so the title is not missing anything a rescan or search would fix.
    if (record.relinked) {
      result.relinked += 1;
      continue;
    }
    const group = byJob.get(record.jobId);
    if (group) group.push(record);
    else byJob.set(record.jobId, [record]);
  }
  const titleKeys = new Set<string>();
  for (const [jobId, group] of byJob) {
    const removed = group.map((record) => ({ section: record.section, itemName: record.itemName, fileNames: [linkFileName(record.relativePath, record.section, record.itemName)], displayName: path.basename(record.linkPath) }));
    for (const entry of removed) titleKeys.add(`${entry.section}\0${entry.itemName}`);
    const covered = search ? await queueSearchesForRemovedLinks(db, jobId, removed) : new Set<string>();
    if (search) result.searched += removed.length;
    const summary = await queueRescansForJob(db, jobId, removed, covered);
    result.asked += summary.asked;
    result.notMatched += summary.notMatched;
    result.failed += summary.failed;
    for (const problem of summary.problems) if (result.problems.length < 20) result.problems.push(problem);
  }
  result.titles = titleKeys.size;
  return result;
}
