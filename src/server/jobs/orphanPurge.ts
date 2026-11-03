import fs from "node:fs/promises";
import path from "node:path";
import { and, eq, inArray, isNull, lte, sql } from "drizzle-orm";
import type { HeldOrphanFile, OrphanCategory, OrphanLeftoverFolder, OrphanPurgeMode, OrphanReview, OrphanReviewItem, PathsSettings, StorageRootType } from "../../shared/types";
import { getSectionSettings, nowIso, type Db, type DbExecutor } from "../db/database";
import * as schema from "../db/schema";
import { ConflictError, publicErrorMessage } from "../errors";
import { assertExistingPathInside, assertPathParentInside, withFilesystemTimeout } from "../lib/filesystemSafety";
import { holdingFolderName, isMediaFile, isPathInside } from "../lib/media";
import { effectiveIntegrity } from "../lib/mediaIntegrity";
import { getInventoryScanTimestamps } from "../lib/scanner";
import { unresolvedCopyReconciliation } from "./copyReconciliation";
import { withResourceMutationGuard } from "./resourceMutationGuard";

export { holdingFolderName };
// Files changed this recently may still be importing or downloading, so they are never purged.
export const purgeGraceMs = 24 * 60 * 60_000;
// Remote files cannot be checked against their title folder, so the symlink inventory must be this fresh.
const maxSymlinkInventoryAgeMs = 24 * 60 * 60_000;
const maxStorageInventoryAgeMs = 24 * 60 * 60_000;
const sidecarExtensions = new Set([".srt", ".ass", ".ssa", ".sub", ".idx", ".vtt", ".sup", ".nfo", ".jpg", ".jpeg", ".png", ".webp", ".tbn"]);
// Copy work that may still move or replace a file: in-flight stages, plus reconciliation records no later copy superseded.
const unfinishedCopyCondition = sql`(copy_operations.stage not in ('committed', 'failed', 'rolled_back', 'reconciliation_required') or (${unresolvedCopyReconciliation()}))`;

type OrphanRow = {
  id: number;
  relative_path: string;
  file_path: string;
  section: string;
  item_name: string;
  size_bytes: number | string;
  mtime_ms: number | string;
  allocated_bytes: number | string | null;
  integrity: string | null;
  integrity_zero_samples: number | null;
  copy_leftover: boolean;
  active_copy: boolean;
};
type PurgeOperation = typeof schema.orphanPurgeOperations.$inferSelect;
type LeftoverFolderRow = typeof schema.storageLeftoverFolders.$inferSelect;
type Extra = { from: string; to: string | null };

export function rootPathFor(paths: PathsSettings, rootType: StorageRootType): string {
  return rootType === "local" ? paths.localDir : paths.remoteDir;
}

export function episodeKey(relativePath: string): string | null {
  const match = path.basename(relativePath).match(/\bs(\d{1,4})e(\d{1,4})\b/i);
  return match ? `s${Number(match[1])}e${Number(match[2])}` : null;
}

function errorCode(error: unknown): string | null {
  return error !== null && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : null;
}

async function orphanRows(db: DbExecutor, rootType: StorageRootType, storageFileIds?: number[]): Promise<OrphanRow[]> {
  const idFilter = storageFileIds ? sql`and sf.id in (select jsonb_array_elements_text(${JSON.stringify(storageFileIds)}::jsonb)::integer)` : sql``;
  // Set-based joins keep this to one pass over each table; per-row subqueries with OR took minutes on real libraries.
  return (
    await db.execute<OrphanRow>(sql`
      with committed_sources as (
        select distinct source_path as path from copy_operations where stage = 'committed'
      ), active_paths as (
        select distinct p as path
        from copy_operations, unnest(array[copy_operations.source_path, copy_operations.destination_path, copy_operations.temp_path, copy_operations.displaced_path]) as p
        where ${unfinishedCopyCondition} and p is not null
      )
      select sf.id, sf.relative_path, sf.file_path, sf.section, sf.item_name, sf.size_bytes, sf.mtime_ms, sf.allocated_bytes, sf.integrity, sf.integrity_zero_samples,
        cs.path is not null as copy_leftover,
        ap.path is not null as active_copy
      from storage_files sf
      left join committed_sources cs on cs.path = sf.file_path
      left join active_paths ap on ap.path = sf.file_path
      where sf.missing_since is null and sf.root_type = ${rootType} ${idFilter}
        and not exists (select 1 from media_links ml where ml.missing_since is null and ml.resolved_storage_file_id = sf.id)
        and not exists (select 1 from media_links ml where ml.missing_since is null and ml.target_path = sf.file_path)
      order by sf.relative_path
    `)
  ).rows;
}

async function linkedTitleKeys(db: DbExecutor): Promise<{ titles: Set<string>; episodes: Set<string> }> {
  const links = await db
    .select({ section: schema.mediaLinks.section, itemName: schema.mediaLinks.itemName, relativePath: schema.mediaLinks.relativePath })
    .from(schema.mediaLinks)
    .where(and(isNull(schema.mediaLinks.missingSince), eq(schema.mediaLinks.isMedia, true)));
  const titles = new Set<string>();
  const episodes = new Set<string>();
  for (const link of links) {
    const title = `${link.section}\0${link.itemName}`;
    titles.add(title);
    const episode = episodeKey(link.relativePath);
    if (episode) episodes.add(`${title}\0${episode}`);
  }
  return { titles, episodes };
}

function classify(row: OrphanRow, keys: { titles: Set<string>; episodes: Set<string> }): OrphanCategory {
  // SRTL's temporary, kept, displaced, and backup files all carry a ".srtl-" marker in their names.
  if (/\.srtl-/.test(row.relative_path)) return "srtl_artifact";
  if (row.copy_leftover) return "copy_leftover";
  if (!row.section) return "unlinked";
  const title = `${row.section}\0${row.item_name}`;
  if (!keys.titles.has(title)) return "not_in_library";
  const episode = episodeKey(row.relative_path);
  // A movie folder or episode that still has a linked file means this one is an older or duplicate version.
  return !episode || keys.episodes.has(`${title}\0${episode}`) ? "superseded" : "not_in_library";
}

function integrityOf(row: OrphanRow) {
  return effectiveIntegrity(Number(row.size_bytes), row.allocated_bytes == null ? null : Number(row.allocated_bytes), row.integrity);
}

function protectedReason(row: OrphanRow, now: number): string | null {
  if (row.active_copy) return "Part of an unfinished copy";
  if (now - Number(row.mtime_ms) < purgeGraceMs) return "Modified in the last 24 hours";
  return null;
}

export async function symlinkInventoryStaleness(db: DbExecutor, now = Date.now()): Promise<{ at: string | null; warning: string | null }> {
  // Each section's newest sighting shows when it was last scanned; the oldest of those bounds the whole inventory.
  const rows = (
    await db.execute<{ newest: string | null }>(sql`
      select max(last_seen_at) as newest from media_links where missing_since is null group by section
    `)
  ).rows;
  const sightings = rows.map((row) => row.newest).filter((value): value is string => Boolean(value)).sort();
  const at = sightings[0] ?? null;
  if (!at) return { at, warning: "Symlinks have not been scanned yet. Run a symlink scan before purging." };
  if (now - Date.parse(at) > maxSymlinkInventoryAgeMs) {
    return { at, warning: "Symlinks were last scanned more than 24 hours ago. Run a symlink scan before purging so newly linked files are not treated as orphans." };
  }
  return { at, warning: null };
}

function ancestorDirectories(paths: Iterable<string>): Set<string> {
  const ancestors = new Set<string>();
  for (const candidate of paths) {
    let current = path.dirname(path.resolve(candidate));
    while (!ancestors.has(current)) {
      ancestors.add(current);
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  return ancestors;
}

async function leftoverFolderRows(db: DbExecutor, rootType: StorageRootType, folderIds?: number[], now = Date.now()): Promise<Array<LeftoverFolderRow & { protectedReason: string | null }>> {
  const rows = await db
    .select()
    .from(schema.storageLeftoverFolders)
    .where(folderIds ? and(eq(schema.storageLeftoverFolders.rootType, rootType), inArray(schema.storageLeftoverFolders.id, folderIds)) : eq(schema.storageLeftoverFolders.rootType, rootType))
    .orderBy(schema.storageLeftoverFolders.relativePath);
  if (rows.length === 0) return [];
  // One pass over link targets and copy paths, instead of a prefix scan per folder.
  const linkTargets = await db.select({ targetPath: schema.mediaLinks.targetPath }).from(schema.mediaLinks).where(isNull(schema.mediaLinks.missingSince));
  const copyPaths = (
    await db.execute<{ path: string }>(sql`
      select distinct p as path
      from copy_operations, unnest(array[copy_operations.source_path, copy_operations.destination_path, copy_operations.temp_path, copy_operations.displaced_path]) as p
      where ${unfinishedCopyCondition} and p is not null
    `)
  ).rows.map((row) => row.path);
  const linkedDirectories = ancestorDirectories(linkTargets.map((link) => link.targetPath));
  const copyDirectories = ancestorDirectories(copyPaths);
  return rows.map((row) => ({ ...row, protectedReason: leftoverProtectedReason(row, copyDirectories, linkedDirectories, now) }));
}

function leftoverProtectedReason(row: LeftoverFolderRow, copyDirectories: Set<string>, linkedDirectories: Set<string>, now: number): string | null {
  const directory = path.resolve(row.dirPath);
  if (copyDirectories.has(directory)) return "Part of an unfinished copy";
  if (linkedDirectories.has(directory)) return "A symlink points into this folder";
  if (now - Number(row.newestMtimeMs) < purgeGraceMs) return "Modified in the last 24 hours";
  return null;
}

// Recomputed under the job's admission transaction so only folders that are still leftovers can be queued.
export async function purgeableLeftoverFolders(db: DbExecutor, rootType: StorageRootType, folderIds: number[], now = Date.now()): Promise<{ eligible: LeftoverFolderRow[]; rejected: string[] }> {
  if (folderIds.length === 0) return { eligible: [], rejected: [] };
  const found = new Map((await leftoverFolderRows(db, rootType, folderIds, now)).map((row) => [row.id, row]));
  const eligible: LeftoverFolderRow[] = [];
  const rejected: string[] = [];
  for (const id of folderIds) {
    const row = found.get(id);
    if (!row) rejected.push(`folder #${id} is no longer a folder without video on this storage`);
    else if (row.protectedReason) rejected.push(`${row.relativePath}: ${row.protectedReason}`);
    else eligible.push(row);
  }
  return { eligible, rejected };
}

// The oldest completed storage scan covering this root; a local section that was never scanned leaves it unknown.
async function storageInventoryAt(db: Db, rootType: StorageRootType): Promise<string | null> {
  const timestamps = await getInventoryScanTimestamps(db);
  if (rootType === "remote") return timestamps.remoteRoot;
  const sections = (await getSectionSettings(db)).sections;
  const scanned = sections.map((section) => timestamps.localSections[section] ?? null);
  if (scanned.length === 0 || scanned.some((timestamp) => !timestamp)) return null;
  return (scanned as string[]).sort((left, right) => Date.parse(left) - Date.parse(right))[0] ?? null;
}

function storageStaleness(at: string | null, now: number): string | null {
  if (!at) return "Storage has not been fully scanned yet, so files added since are not listed. Purges still re-check every file before touching it.";
  if (now - Date.parse(at) > maxStorageInventoryAgeMs) {
    return "Storage was last scanned more than 24 hours ago, so files added since are not listed. Purges still re-check every file before touching it.";
  }
  return null;
}

export async function listOrphanReview(db: Db, rootType: StorageRootType, holdDays: number, now = Date.now()): Promise<OrphanReview> {
  const [rows, keys, staleness, storageInventory, folders] = await Promise.all([
    orphanRows(db, rootType),
    linkedTitleKeys(db),
    symlinkInventoryStaleness(db, now),
    storageInventoryAt(db, rootType),
    leftoverFolderRows(db, rootType, undefined, now)
  ]);
  const leftoverFolders: OrphanLeftoverFolder[] = folders.map((folder) => ({
    folderId: folder.id,
    rootType,
    relativePath: folder.relativePath,
    dirPath: folder.dirPath,
    fileCount: folder.fileCount,
    totalBytes: Number(folder.totalBytes),
    newestMtimeMs: Number(folder.newestMtimeMs),
    protectedReason: folder.protectedReason
  }));
  const items: OrphanReviewItem[] = rows.map((row) => ({
    storageFileId: row.id,
    rootType,
    relativePath: row.relative_path,
    filePath: row.file_path,
    section: row.section,
    itemName: row.item_name,
    sizeBytes: Number(row.size_bytes),
    mtimeMs: Number(row.mtime_ms),
    category: classify(row, keys),
    protectedReason: protectedReason(row, now),
    hollow: integrityOf(row) === "hollow",
    integrity: integrityOf(row),
    zeroSamples: row.integrity_zero_samples
  }));
  const categories: OrphanCategory[] = ["superseded", "copy_leftover", "not_in_library", "srtl_artifact", "unlinked"];
  const summary = categories
    .map((category) => {
      const matching = items.filter((item) => item.category === category);
      return {
        category,
        count: matching.length,
        sizeBytes: matching.reduce((total, item) => total + item.sizeBytes, 0),
        purgeableCount: matching.filter((item) => !item.protectedReason).length
      };
    })
    .filter((entry) => entry.count > 0);
  const hollowCount = items.filter((item) => item.hollow).length;
  const damagedCount = items.filter((item) => item.integrity === "partial_hollow").length;
  return { rootType, items, leftoverFolders, summary, hollowCount, damagedCount, symlinkInventoryAt: staleness.at, storageInventoryAt: storageInventory, staleWarning: staleness.warning, storageStaleWarning: storageStaleness(storageInventory, now), holdDays };
}

// Recomputed under the job's admission transaction so only files that are orphans right now can be queued.
export async function purgeableOrphans(db: DbExecutor, rootType: StorageRootType, storageFileIds: number[], now = Date.now()): Promise<{ eligible: OrphanRow[]; rejected: string[] }> {
  const rows = await orphanRows(db, rootType, storageFileIds);
  const found = new Map(rows.map((row) => [row.id, row]));
  const eligible: OrphanRow[] = [];
  const rejected: string[] = [];
  for (const id of storageFileIds) {
    const row = found.get(id);
    if (!row) {
      rejected.push(`file #${id} is no longer an orphan on this storage`);
      continue;
    }
    const reason = protectedReason(row, now);
    if (reason) rejected.push(`${path.basename(row.relative_path)}: ${reason}`);
    else eligible.push(row);
  }
  return { eligible, rejected };
}

async function findLiveSymlinkTo(directory: string, target: string, depth = 3): Promise<string | null> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await withFilesystemTimeout(fs.readdir(directory, { withFileTypes: true }), `Reading symlink folder ${directory}`);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      const raw = await withFilesystemTimeout(fs.readlink(entryPath), `Reading symlink ${entryPath}`);
      if (path.resolve(path.dirname(entryPath), raw) === target) return entryPath;
    } else if (entry.isDirectory() && depth > 0) {
      const found = await findLiveSymlinkTo(entryPath, target, depth - 1);
      if (found) return found;
    }
  }
  return null;
}

async function moveOrRemove(from: string, to: string | null): Promise<void> {
  if (to) {
    await fs.mkdir(path.dirname(to), { recursive: true });
    await withFilesystemTimeout(fs.rename(from, to), `Moving ${from} to the holding area`);
  } else {
    await withFilesystemTimeout(fs.unlink(from), `Deleting ${from}`);
  }
}

// When the last video in a folder is purged, its subtitles, artwork, and metadata go with it, then empty folders.
async function cleanFolderAfterPurge(root: string, stopAt: string, directory: string, holdBase: string | null): Promise<Extra[]> {
  const extras: Extra[] = [];
  let current = directory;
  while (isPathInside(stopAt, current) && path.resolve(current) !== path.resolve(stopAt)) {
    const entries = await withFilesystemTimeout(fs.readdir(current, { withFileTypes: true }), `Reading ${current}`).catch(() => null);
    if (!entries) break;
    if (entries.some((entry) => entry.isDirectory() || (entry.isFile() && isMediaFile(entry.name)) || (!entry.isFile() && !entry.isDirectory()))) break;
    if (entries.some((entry) => !sidecarExtensions.has(path.extname(entry.name).toLowerCase()))) break;
    for (const entry of entries) {
      const from = path.join(current, entry.name);
      const to = holdBase ? path.join(holdBase, path.relative(root, from)) : null;
      await moveOrRemove(from, to);
      extras.push({ from, to });
    }
    await fs.rmdir(current).catch(() => undefined);
    current = path.dirname(current);
  }
  return extras;
}

export interface PurgeExecutionContext {
  paths: PathsSettings;
  holdDays: number;
  now?: number;
}

type PurgeOutcome = { stage: "held" | "deleted" | "already_missing"; heldPath: string | null; extras: Extra[] };

function holdingAreaError(error: unknown, heldPath: string | null): unknown {
  const code = errorCode(error);
  if (heldPath && code && ["EXDEV", "EPERM", "ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EINVAL", "EACCES"].includes(code)) {
    return new Error(`This storage does not support moving files into the holding area (${code}); purge with immediate deletion instead`, { cause: error });
  }
  return error;
}

// Re-walks a folder right before it is purged; anything that could be someone's media stops the purge.
async function assertFolderStillLeftover(directory: string, now: number): Promise<void> {
  const stat = await withFilesystemTimeout(fs.lstat(directory), `Inspection of ${directory}`);
  if (now - stat.mtimeMs < purgeGraceMs) throw new Error(`${directory} was modified in the last 24 hours`);
  const entries = await withFilesystemTimeout(fs.readdir(directory, { withFileTypes: true }), `Reading ${directory}`);
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await assertFolderStillLeftover(entryPath, now);
    } else if (entry.isFile()) {
      if (isMediaFile(entry.name)) throw new Error(`Folder now contains a video (${entryPath}); nothing was purged`);
      const fileStat = await withFilesystemTimeout(fs.lstat(entryPath), `Inspection of ${entryPath}`);
      if (now - fileStat.mtimeMs < purgeGraceMs) throw new Error(`${entryPath} was modified in the last 24 hours`);
    } else {
      throw new Error(`Folder contains a symlink or special file (${entryPath}); nothing was purged`);
    }
  }
}

async function executeLeftoverFolderPurge(db: DbExecutor, operation: PurgeOperation, root: string, now: number): Promise<PurgeOutcome> {
  const folder = (
    await db.select().from(schema.storageLeftoverFolders).where(eq(schema.storageLeftoverFolders.id, operation.storageFileId)).for("update").limit(1)
  )[0];
  if (!folder || path.resolve(folder.dirPath) !== path.resolve(operation.filePath)) throw new Error("Folder record changed after the purge was queued; rescan before purging");
  const directory = path.resolve(operation.filePath);
  const sectionRoots = (await getSectionSettings(db)).sections.map((section) => path.resolve(root, section));
  if (!isPathInside(root, directory) || directory === path.resolve(root) || sectionRoots.includes(directory) || isPathInside(path.join(root, holdingFolderName), directory)) {
    throw new Error("Only folders inside a storage title area can be purged");
  }

  const prefix = `${directory}${path.sep}`;
  const linked = (
    await db.execute<{ id: number }>(sql`
      select id from media_links
      where missing_since is null and (target_path = ${directory} or left(target_path, ${prefix.length}) = ${prefix})
      limit 1
    `)
  ).rows[0];
  if (linked) throw new Error("A symlink points into this folder; nothing was purged");
  const activeCopy = (
    await db.execute<{ id: number }>(sql`
      select copy_operations.id
      from copy_operations, unnest(array[copy_operations.source_path, copy_operations.destination_path, copy_operations.temp_path, copy_operations.displaced_path]) as p
      where ${unfinishedCopyCondition} and p is not null and left(p, ${prefix.length}) = ${prefix}
      limit 1
    `)
  ).rows[0];
  if (activeCopy) throw new Error("This folder holds part of an unfinished copy");

  let stat: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    stat = await withFilesystemTimeout(fs.lstat(directory), `Inspection of ${directory}`);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
    await db.delete(schema.storageLeftoverFolders).where(eq(schema.storageLeftoverFolders.id, folder.id));
    return { stage: "already_missing", heldPath: null, extras: [] };
  }
  if (!stat.isDirectory()) throw new Error("Path is no longer a folder; nothing was purged");
  await assertExistingPathInside(root, directory, "Leftover folder");
  await assertFolderStillLeftover(directory, now);

  const heldPath = operation.mode === "hold" ? path.join(root, holdingFolderName, `job-${operation.jobId}`, path.relative(root, directory)) : null;
  try {
    if (heldPath) {
      await assertPathParentInside(root, heldPath, "Holding area").catch(() => undefined);
      await fs.mkdir(path.dirname(heldPath), { recursive: true });
      await withFilesystemTimeout(fs.rename(directory, heldPath), `Moving ${directory} to the holding area`);
    } else {
      await withFilesystemTimeout(fs.rm(directory, { recursive: true }), `Deleting ${directory}`);
    }
  } catch (error) {
    throw holdingAreaError(error, heldPath);
  }
  await db.delete(schema.storageLeftoverFolders).where(eq(schema.storageLeftoverFolders.id, folder.id));
  return { stage: heldPath ? "held" : "deleted", heldPath, extras: [] };
}

export async function executeOrphanPurgeOperation(db: DbExecutor, operation: PurgeOperation, context: PurgeExecutionContext): Promise<PurgeOutcome> {
  const now = context.now ?? Date.now();
  const rootType = operation.rootType as StorageRootType;
  const root = rootPathFor(context.paths, rootType);
  if (!root) throw new Error("Storage root is not configured");
  if (operation.targetKind === "folder") return executeLeftoverFolderPurge(db, operation, root, now);
  const storageFile = (
    await db.select().from(schema.storageFiles).where(eq(schema.storageFiles.id, operation.storageFileId)).for("update").limit(1)
  )[0];
  if (!storageFile || path.resolve(storageFile.filePath) !== path.resolve(operation.filePath)) throw new Error("Inventory record changed after the purge was queued; rescan before purging");

  const linked = (
    await db.execute<{ id: number }>(sql`
      select id from media_links
      where missing_since is null and (resolved_storage_file_id = ${operation.storageFileId} or target_path = ${operation.filePath})
      limit 1
    `)
  ).rows[0];
  if (linked) throw new Error("A symlink now points to this file; it is no longer an orphan");
  const activeCopy = (
    await db.execute<{ id: number }>(sql`
      select copy_operations.id from copy_operations
      where ${unfinishedCopyCondition}
        and ${operation.filePath} in (copy_operations.source_path, copy_operations.destination_path, coalesce(copy_operations.temp_path, ''), coalesce(copy_operations.displaced_path, ''))
      limit 1
    `)
  ).rows[0];
  if (activeCopy) throw new Error("This file is part of an unfinished copy");

  let stat: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    stat = await withFilesystemTimeout(fs.lstat(operation.filePath), `Inspection of ${operation.filePath}`);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
    await db.update(schema.storageFiles).set({ missingSince: nowIso(), updatedAt: nowIso() }).where(eq(schema.storageFiles.id, operation.storageFileId));
    return { stage: "already_missing", heldPath: null, extras: [] };
  }
  if (!stat.isFile()) throw new Error("Path is no longer a regular file; nothing was purged");
  await assertExistingPathInside(root, operation.filePath, "Orphan file");
  if (stat.size !== Number(operation.sizeBytes) || Math.trunc(stat.mtimeMs) !== Number(operation.mtimeMs)) {
    throw new Error("File changed after it was inventoried; rescan before purging");
  }
  if (now - stat.mtimeMs < purgeGraceMs) throw new Error("File was modified in the last 24 hours");

  if (storageFile.section && storageFile.itemName && context.paths.symlinkDir) {
    const titleFolder = path.join(context.paths.symlinkDir, storageFile.section, storageFile.itemName);
    const liveLink = await findLiveSymlinkTo(titleFolder, path.resolve(operation.filePath));
    if (liveLink) throw new Error(`Symlink ${liveLink} points to this file; it is no longer an orphan`);
  }

  const holdBase = operation.mode === "hold" ? path.join(root, holdingFolderName, `job-${operation.jobId}`) : null;
  const heldPath = holdBase ? path.join(holdBase, path.relative(root, operation.filePath)) : null;
  if (heldPath) await assertPathParentInside(root, heldPath, "Holding area").catch(() => undefined);
  try {
    await moveOrRemove(operation.filePath, heldPath);
  } catch (error) {
    throw holdingAreaError(error, heldPath);
  }
  const stopAt = storageFile.section ? path.join(root, storageFile.section) : root;
  const extras = await cleanFolderAfterPurge(root, stopAt, path.dirname(operation.filePath), holdBase).catch(() => []);
  await db.update(schema.storageFiles).set({ missingSince: nowIso(), updatedAt: nowIso() }).where(eq(schema.storageFiles.id, operation.storageFileId));
  return { stage: heldPath ? "held" : "deleted", heldPath, extras };
}

export async function listHeldOrphans(db: Db): Promise<HeldOrphanFile[]> {
  const rows = await db.select().from(schema.orphanPurgeOperations).where(eq(schema.orphanPurgeOperations.stage, "held"));
  return rows
    .filter((row) => row.heldPath && row.purgeAfter)
    .map((row) => ({
      operationId: row.id,
      jobId: row.jobId,
      rootType: row.rootType as StorageRootType,
      filePath: row.filePath,
      heldPath: row.heldPath!,
      sizeBytes: Number(row.sizeBytes),
      heldAt: row.completedAt ?? row.updatedAt,
      purgeAfter: row.purgeAfter!
    }))
    .sort((left, right) => left.purgeAfter.localeCompare(right.purgeAfter));
}

function parseExtras(raw: string): Extra[] {
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) ? value.filter((entry): entry is Extra => Boolean(entry) && typeof entry.from === "string") : [];
  } catch {
    return [];
  }
}

export async function restoreHeldOrphans(db: Db, paths: PathsSettings, operationIds: number[], onError?: (error: unknown, operationId: number) => void): Promise<{ restored: number; errors: string[] }> {
  let restored = 0;
  const errors: string[] = [];
  for (const operationId of operationIds) {
    try {
      await withResourceMutationGuard(db, async (transaction) => {
        const operation = (await transaction.select().from(schema.orphanPurgeOperations).where(eq(schema.orphanPurgeOperations.id, operationId)).for("update").limit(1))[0];
        if (!operation || operation.stage !== "held" || !operation.heldPath) throw new ConflictError(`Held file #${operationId} is not available to restore`);
        return {
          resources: [{ resourceType: "path", resourceKey: path.resolve(operation.filePath) }],
          mutate: async () => {
            const root = rootPathFor(paths, operation.rootType as StorageRootType);
            if (!isPathInside(root, operation.heldPath!) || !isPathInside(root, operation.filePath)) throw new ConflictError(`Held file #${operationId} is outside its storage root.`);
            const occupied = await fs.lstat(operation.filePath).then(() => true, () => false);
            if (occupied) throw new ConflictError(`A file now exists where held file #${operationId} came from; restore it manually.`, { detail: operation.filePath });
            await fs.mkdir(path.dirname(operation.filePath), { recursive: true });
            await fs.rename(operation.heldPath!, operation.filePath);
            for (const extra of parseExtras(operation.extras)) {
              if (!extra.to) continue;
              const occupiedExtra = await fs.lstat(extra.from).then(() => true, () => false);
              if (!occupiedExtra) await fs.rename(extra.to, extra.from).catch(() => undefined);
            }
            const holdRoot = path.join(root, holdingFolderName);
            await removeEmptyHoldingFolders(path.dirname(operation.heldPath!), holdRoot);
            await fs.rmdir(holdRoot).catch(() => undefined);
            const timestamp = nowIso();
            // A restored folder is found again by the next storage scan.
            if (operation.targetKind !== "folder") {
              await transaction.update(schema.storageFiles).set({ missingSince: null, updatedAt: timestamp }).where(eq(schema.storageFiles.id, operation.storageFileId));
            }
            await transaction.update(schema.orphanPurgeOperations).set({ stage: "restored", updatedAt: timestamp }).where(eq(schema.orphanPurgeOperations.id, operation.id));
          }
        };
      });
      restored += 1;
    } catch (error) {
      onError?.(error, operationId);
      errors.push(publicErrorMessage(error, `Held file #${operationId} could not be restored.`));
    }
  }
  return { restored, errors };
}

async function removeEmptyHoldingFolders(directory: string, stopAt: string): Promise<void> {
  let current = directory;
  while (isPathInside(stopAt, current) && path.resolve(current) !== path.resolve(stopAt)) {
    const removed = await fs.rmdir(current).then(() => true, () => false);
    if (!removed) return;
    current = path.dirname(current);
  }
}

// Permanently deletes held files whose retention ended. Runs during worker maintenance.
export async function expireHeldOrphans(db: Db, paths: PathsSettings, now = Date.now()): Promise<number> {
  const due = await db
    .select()
    .from(schema.orphanPurgeOperations)
    .where(and(eq(schema.orphanPurgeOperations.stage, "held"), lte(schema.orphanPurgeOperations.purgeAfter, new Date(now).toISOString())));
  let expired = 0;
  for (const operation of due) {
    const root = rootPathFor(paths, operation.rootType as StorageRootType);
    const holdRoot = path.join(root, holdingFolderName);
    const targets = [operation.heldPath, ...parseExtras(operation.extras).map((extra) => extra.to)].filter((value): value is string => Boolean(value));
    if (!root || targets.some((target) => !isPathInside(holdRoot, target))) continue;
    for (const target of targets) {
      if (operation.targetKind === "folder") {
        await fs.rm(target, { recursive: true, force: true });
      } else {
        await fs.unlink(target).catch((error: unknown) => {
          if (errorCode(error) !== "ENOENT") throw error;
        });
      }
      await removeEmptyHoldingFolders(path.dirname(target), holdRoot);
    }
    await db.update(schema.orphanPurgeOperations).set({ stage: "expired", updatedAt: nowIso() }).where(eq(schema.orphanPurgeOperations.id, operation.id));
    await fs.rmdir(holdRoot).catch(() => undefined);
    expired += 1;
  }
  return expired;
}

export function purgeModeIsValid(value: unknown): value is OrphanPurgeMode {
  return value === "hold" || value === "delete";
}

export async function operationsForJob(db: DbExecutor, jobId: number): Promise<PurgeOperation[]> {
  return db.select().from(schema.orphanPurgeOperations).where(eq(schema.orphanPurgeOperations.jobId, jobId)).orderBy(schema.orphanPurgeOperations.id);
}

export async function operationsByIds(db: DbExecutor, ids: number[]): Promise<PurgeOperation[]> {
  return ids.length ? db.select().from(schema.orphanPurgeOperations).where(inArray(schema.orphanPurgeOperations.id, ids)) : [];
}
