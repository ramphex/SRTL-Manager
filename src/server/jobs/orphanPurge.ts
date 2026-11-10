import fs from "node:fs/promises";
import path from "node:path";
import { and, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import type { HeldOrphanFile, OrphanCategory, OrphanPurgeItem, OrphanPurgeItemOutcome, OrphanPurgeItemPage, OrphanInUseReason, OrphanSkippedInUse, OrphanLeftoverFolder, OrphanPurgeMode, OrphanReview, OrphanReviewItem, OrphanReviewLabel, OrphanSizeComparison, PathsSettings, SectionSettings, StorageRootType } from "../../shared/types";
import { getJsonSetting, getSectionSettings, nowIso, type Db, type DbExecutor } from "../db/database";
import * as schema from "../db/schema";
import { ConflictError, publicErrorMessage } from "../errors";
import { parseEpisodeNumbers } from "../lib/episodeNumbers";
import { extraLinkCovering, extraLinkTouchingFolder, extraSymlinkFolders, extraSymlinkRefusal, readExtraSymlinks, type ExtraSymlinks } from "../lib/extraSymlinkFolders";
import { assertExistingPathInside, assertPathParentInside, withFilesystemTimeout } from "../lib/filesystemSafety";
import { assertStillInside, deleteHoldingEntry, moveIntoHoldingArea, moveOutOfHoldingArea, removeEmptyHoldingFolders } from "../lib/holdingArea";
import { removeExpectedSymlink } from "./symlinkCleanup";
import { holdingFolderName, isCoveredByPath, isMediaFile, isPathInside, pathAndAncestors } from "../lib/media";
import { effectiveIntegrity } from "../lib/mediaIntegrity";
import { buildTitleIndex, matchReleaseTitles, releaseKeyOf, releaseNameOf, type IndexedTitle, type TitleIndex } from "../lib/releaseTitles";
import { completeSymlinkScanTimes, getInventoryScanTimestamps } from "../lib/scanner";
import { unresolvedCopyReconciliation } from "./copyReconciliation";
import { withResourceMutationGuard } from "./resourceMutationGuard";

export { holdingFolderName };
// Files changed this recently may still be importing or downloading, so they are never purged.
export const purgeGraceMs = 24 * 60 * 60_000;
// Remote files cannot be checked against their title folder, so a complete symlink scan must be this recent.
const maxSymlinkInventoryAgeMs = 24 * 60 * 60_000;
const maxStorageInventoryAgeMs = 24 * 60 * 60_000;
const sidecarExtensions = new Set([".srt", ".ass", ".ssa", ".sub", ".idx", ".vtt", ".sup", ".nfo", ".jpg", ".jpeg", ".png", ".webp", ".tbn"]);
// Copy work that may still move or replace a file: in-flight stages, plus reconciliation records no later copy superseded.
export const unfinishedCopyCondition = sql`(copy_operations.stage not in ('committed', 'failed', 'rolled_back', 'reconciliation_required') or (${unresolvedCopyReconciliation()}))`;

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
type RemovedLink = { linkPath: string; targetPath: string; relativePath: string };

export function rootPathFor(paths: PathsSettings, rootType: StorageRootType): string {
  return rootType === "local" ? paths.localDir : paths.remoteDir;
}

// Every episode a file name holds: S01E01E02, S01E01-E02 and S01E01-02 are two each.
export function episodeKeys(relativePath: string): string[] {
  const parsed = parseEpisodeNumbers(relativePath);
  if (parsed) return parsed.episodes.map((episode) => `s${parsed.season}e${episode}`);
  // A range too wide to believe is more likely a tag than episodes, so only its first episode counts.
  const match = path.basename(relativePath).match(/\bs(\d{1,4})e(\d{1,4})/i);
  return match ? [`s${Number(match[1])}e${Number(match[2])}`] : [];
}

export function episodeKey(relativePath: string): string | null {
  return episodeKeys(relativePath)[0] ?? null;
}

function fsErrorText(error: unknown): string {
  return errorCode(error) ?? (error instanceof Error ? error.message : String(error));
}

function errorCode(error: unknown): string | null {
  return error !== null && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : null;
}

// Every live link target, whatever its file type. A link to a folder, or to a file SRTL does not treat as video, still means it is in use.
async function liveLinkTargets(db: DbExecutor): Promise<Set<string>> {
  const rows = (await db.execute<{ target_path: string }>(sql`select distinct target_path from media_links where missing_since is null`)).rows;
  return new Set(rows.map((row) => path.resolve(row.target_path)));
}

async function orphanRows(db: DbExecutor, rootType: StorageRootType, storageFileIds?: number[], includeLinked = false): Promise<OrphanRow[]> {
  const idFilter = storageFileIds ? sql`and sf.id in (select jsonb_array_elements_text(${JSON.stringify(storageFileIds)}::jsonb)::integer)` : sql``;
  // Set-based joins keep this to one pass over each table; per-row subqueries with OR took minutes on real libraries.
  const rows = (
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
        ${includeLinked ? sql`` : sql`and not exists (select 1 from media_links ml where ml.missing_since is null and ml.resolved_storage_file_id = sf.id)
        and not exists (select 1 from media_links ml where ml.missing_since is null and ml.target_path = sf.file_path)`}
      order by sf.relative_path
    `)
  ).rows;
  if (includeLinked || rows.length === 0) return rows;
  // A link to a folder above the file is not an exact match, so it is checked here, one lookup per folder level.
  const targets = await liveLinkTargets(db);
  return rows.filter((row) => !isCoveredByPath(targets, row.file_path));
}

type LinkedFile = { linkPath: string; sizeBytes: number | null };
type LibraryLinks = {
  titles: Set<string>;
  // Linked files by title and episode, and by title for files that name no episode.
  episodes: Map<string, LinkedFile[]>;
  plainFiles: Map<string, LinkedFile[]>;
  titleIndex: TitleIndex;
  targetPaths: string[];
};

async function libraryLinks(db: DbExecutor, settings: SectionSettings, now: number): Promise<LibraryLinks> {
  const links = (
    await db.execute<{ section: string; item_name: string; relative_path: string; link_path: string; target_path: string; is_media: boolean; size_bytes: number | string | null }>(sql`
      select ml.section, ml.item_name, ml.relative_path, ml.link_path, ml.target_path, ml.is_media, coalesce(ml.size_bytes, sf.size_bytes) as size_bytes
      from media_links ml
      left join storage_files sf on sf.id = ml.resolved_storage_file_id
      where ml.missing_since is null
    `)
  ).rows;
  const titles = new Set<string>();
  const episodes = new Map<string, LinkedFile[]>();
  const plainFiles = new Map<string, LinkedFile[]>();
  const libraryTitles = new Map<string, { itemName: string; isShow: boolean | null; key: string }>();
  const add = (files: Map<string, LinkedFile[]>, key: string, file: LinkedFile) => {
    const entries = files.get(key);
    if (entries) entries.push(file);
    else files.set(key, [file]);
  };
  for (const link of links) {
    if (!link.is_media) continue;
    const title = `${link.section}\0${link.item_name}`;
    titles.add(title);
    if (!libraryTitles.has(title)) {
      const type = settings.sectionTypes?.[link.section];
      libraryTitles.set(title, { itemName: link.item_name, isShow: type === "shows" ? true : type === "movies" ? false : null, key: title });
    }
    const file = { linkPath: link.link_path, sizeBytes: link.size_bytes === null ? null : Number(link.size_bytes) };
    const keys = episodeKeys(link.relative_path);
    if (keys.length === 0) add(plainFiles, title, file);
    for (const key of keys) add(episodes, `${title}\0${key}`, file);
  }
  return { titles, episodes, plainFiles, titleIndex: buildTitleIndex(libraryTitles.values(), new Date(now)), targetPaths: links.map((link) => link.target_path) };
}

function classify(row: OrphanRow, keys: Pick<LibraryLinks, "titles" | "episodes">): OrphanCategory {
  // SRTL's temporary, kept, displaced, and backup files all carry a ".srtl-" marker in their names.
  if (/\.srtl-/.test(row.relative_path)) return "srtl_artifact";
  if (row.copy_leftover) return "copy_leftover";
  if (!row.section) return "unlinked";
  const title = `${row.section}\0${row.item_name}`;
  if (!keys.titles.has(title)) return "not_in_library";
  const fileEpisodes = episodeKeys(row.relative_path);
  // A movie folder or episode that still has a linked file means this one is another version of it.
  // A multi-episode file is only that when every episode it holds has a linked file: otherwise it is the sole copy of the rest.
  return fileEpisodes.every((episode) => keys.episodes.has(`${title}\0${episode}`)) ? "superseded" : "not_in_library";
}

function episodeCoverageOf(row: OrphanRow, keys: Pick<LibraryLinks, "episodes">): { linked: number; total: number } | null {
  const fileEpisodes = episodeKeys(row.relative_path);
  if (fileEpisodes.length < 2 || !row.section) return null;
  const title = `${row.section}\0${row.item_name}`;
  return { linked: fileEpisodes.filter((episode) => keys.episodes.has(`${title}\0${episode}`)).length, total: fileEpisodes.length };
}

// Largest linked file for each thing this one could replace. Bytes say nothing about quality, so this only ever informs a review.
function linkedSizeOf(row: OrphanRow, keys: Pick<LibraryLinks, "episodes" | "plainFiles">): number | null {
  const title = `${row.section}\0${row.item_name}`;
  const fileEpisodes = episodeKeys(row.relative_path);
  const groups = fileEpisodes.length > 0 ? fileEpisodes.map((episode) => keys.episodes.get(`${title}\0${episode}`) ?? []) : [keys.plainFiles.get(title) ?? []];
  const counted = new Map<string, number>();
  for (const files of groups) {
    const sized = files.filter((file) => file.sizeBytes !== null);
    if (sized.length === 0) return null;
    const largest = sized.reduce((best, file) => (file.sizeBytes! > best.sizeBytes! ? file : best));
    counted.set(largest.linkPath, largest.sizeBytes!);
  }
  return counted.size > 0 ? [...counted.values()].reduce((total, size) => total + size, 0) : null;
}

// An episode counts as linked if any title the release could be holds it, since a name alone cannot say which one it is.
function hasUnlinkedEpisode(row: OrphanRow, titles: IndexedTitle[], keys: Pick<LibraryLinks, "episodes">): boolean {
  const showTitles = titles.filter((title) => title.isShow !== false);
  if (showTitles.length === 0) return false;
  return episodeKeys(row.relative_path).some((episode) => !showTitles.some((title) => keys.episodes.has(`${title.key}\0${episode}`)));
}

function compareSizes(sizeBytes: number, linkedSizeBytes: number | null): OrphanSizeComparison | null {
  if (linkedSizeBytes === null) return null;
  return sizeBytes > linkedSizeBytes ? "larger" : sizeBytes < linkedSizeBytes ? "smaller" : "same";
}

function integrityOf(row: Pick<OrphanRow, "size_bytes" | "allocated_bytes" | "integrity">) {
  return effectiveIntegrity(Number(row.size_bytes), row.allocated_bytes == null ? null : Number(row.allocated_bytes), row.integrity);
}

function isDamaged(row: Pick<OrphanRow, "size_bytes" | "allocated_bytes" | "integrity">): boolean {
  const integrity = integrityOf(row);
  return integrity === "hollow" || integrity === "partial_hollow";
}

function protectedReason(row: OrphanRow, now: number, extra?: ExtraSymlinks): string | null {
  if (row.active_copy) return "Part of an unfinished copy";
  if (extra) {
    const link = extraLinkCovering(extra, row.file_path);
    if (link) return `Still linked from ${link}`;
  }
  if (now - Number(row.mtime_ms) < purgeGraceMs) return "Modified in the last 24 hours";
  return null;
}

// A folder with nothing in it holds no links, whether or not a scan has been past. If it cannot be read, assume it might.
async function sectionFolderMayHoldLinks(symlinkDir: string, section: string): Promise<boolean> {
  if (!symlinkDir) return true;
  const folder = path.join(symlinkDir, section);
  try {
    return (await withFilesystemTimeout(fs.readdir(folder), `Reading symlink folder ${folder}`)).length > 0;
  } catch (error) {
    return errorCode(error) !== "ENOENT";
  }
}

export async function symlinkInventoryStaleness(db: DbExecutor, now = Date.now()): Promise<{ at: string | null; warning: string | null }> {
  const settings = await getSectionSettings(db);
  const sectionsWithLinks = new Set(
    (await db.execute<{ section: string }>(sql`select distinct section from media_links where missing_since is null`)).rows.map((row) => row.section)
  );
  const paths = await getJsonSetting<PathsSettings>(db, "paths", { symlinkDir: "", localDir: "", remoteDir: "" });
  const scanned = await completeSymlinkScanTimes(db, settings.sections);
  const isFresh = (at: string | undefined) => Boolean(at) && now - Date.parse(at!) <= maxSymlinkInventoryAgeMs;
  const never: string[] = [];
  const stale: string[] = [];
  const counted: string[] = [];
  for (const section of settings.sections) {
    const at = scanned.get(section);
    if (at) counted.push(at);
    if (isFresh(at)) continue;
    // A section that holds no links has nothing a scan could miss, so it must not hold purges up.
    if (!sectionsWithLinks.has(section) && !(await sectionFolderMayHoldLinks(paths.symlinkDir, section))) continue;
    (at ? stale : never).push(settings.sectionTitles?.[section]?.trim() || section);
  }
  const at = never.length > 0 ? null : (counted.sort((left, right) => Date.parse(left) - Date.parse(right))[0] ?? null);
  if (settings.sections.length === 0) return { at, warning: "No library folders are set up yet, so there is nothing to compare files against." };
  const rescan = "Run a full symlink scan of those folders before purging, so linked files are not treated as orphans. A rescan of a single title does not count.";
  if (never.length > 0) return { at, warning: `No complete symlink scan has finished for ${never.join(", ")}. ${rescan}` };
  if (stale.length > 0) return { at, warning: `The last complete symlink scan of ${stale.join(", ")} started more than 24 hours ago. ${rescan}` };
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

type LeftoverFolderReview = LeftoverFolderRow & { protectedReason: string | null; inUse: OrphanInUseReason | null };

async function leftoverFolderRows(db: DbExecutor, rootType: StorageRootType, folderIds?: number[], now = Date.now(), extra?: ExtraSymlinks): Promise<LeftoverFolderReview[]> {
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
  const linkedTargets = new Set(linkTargets.map((link) => path.resolve(link.targetPath)));
  const copyDirectories = ancestorDirectories(copyPaths);
  const extraDirectories = ancestorDirectories(extra?.targets.keys() ?? []);
  return rows.map((row) => {
    const protection = leftoverProtection(row, copyDirectories, linkedDirectories, linkedTargets, extraDirectories, extra, now);
    return { ...row, protectedReason: protection?.reason ?? null, inUse: protection?.inUse ?? null };
  });
}

function leftoverProtection(
  row: LeftoverFolderRow,
  copyDirectories: Set<string>,
  linkedDirectories: Set<string>,
  linkedTargets: Set<string>,
  extraDirectories: Set<string>,
  extra: ExtraSymlinks | undefined,
  now: number
): { reason: string; inUse: OrphanInUseReason | null } | null {
  const directory = path.resolve(row.dirPath);
  if (copyDirectories.has(directory)) return { reason: "Part of an unfinished copy", inUse: null };
  // Any link counts, whatever the file type it points at, and so does a link to this folder or one above it.
  if (linkedDirectories.has(directory) || isCoveredByPath(linkedTargets, directory)) return { reason: "A symlink points into this folder", inUse: "library_link" };
  if (extra && (extraDirectories.has(directory) || extraLinkCovering(extra, directory))) return { reason: "A symlink in an extra symlink folder points into this folder", inUse: "extra_link" };
  if (now - Number(row.newestMtimeMs) < purgeGraceMs) return { reason: "Modified in the last 24 hours", inUse: null };
  return null;
}

// Recomputed under the job's admission transaction so only folders that are still leftovers can be queued.
export async function purgeableLeftoverFolders(db: DbExecutor, rootType: StorageRootType, folderIds: number[], now = Date.now(), extra?: ExtraSymlinks): Promise<{ eligible: LeftoverFolderRow[]; rejected: string[] }> {
  if (folderIds.length === 0) return { eligible: [], rejected: [] };
  const found = new Map((await leftoverFolderRows(db, rootType, folderIds, now, extra)).map((row) => [row.id, row]));
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
  const [settings, paths] = await Promise.all([getSectionSettings(db), getJsonSetting<PathsSettings>(db, "paths", { symlinkDir: "", localDir: "", remoteDir: "" })]);
  const extra = await readExtraSymlinks(paths, settings.sections);
  const [rows, library, staleness, storageInventory, folders] = await Promise.all([
    orphanRows(db, rootType),
    libraryLinks(db, settings, now),
    symlinkInventoryStaleness(db, now),
    storageInventoryAt(db, rootType),
    leftoverFolderRows(db, rootType, undefined, now, extra)
  ]);
  // What a symlink uses is never purged, so it is left out of the lists and only counted.
  const shownFolders = folders.filter((folder) => !folder.inUse);
  const leftoverFolders: OrphanLeftoverFolder[] = shownFolders.map((folder) => ({
    folderId: folder.id,
    rootType,
    relativePath: folder.relativePath,
    dirPath: folder.dirPath,
    fileCount: folder.fileCount,
    totalBytes: Number(folder.totalBytes),
    newestMtimeMs: Number(folder.newestMtimeMs),
    protectedReason: folder.protectedReason
  }));
  const containers = new Set(settings.sections);
  const rootPrefix = `${path.resolve(rootPathFor(paths, rootType))}${path.sep}`;
  // Files in use per release: library link targets and extra folder targets, each counted once.
  const linkedByRelease = new Map<string, Set<string>>();
  for (const target of [...library.targetPaths, ...extra.targets.keys()]) {
    if (!target.startsWith(rootPrefix)) continue;
    const key = releaseKeyOf(target.slice(rootPrefix.length), containers);
    const linked = linkedByRelease.get(key);
    if (linked) linked.add(target);
    else linkedByRelease.set(key, new Set([target]));
  }
  const releaseKeys = rows.map((row) => releaseKeyOf(row.relative_path, containers));
  const unlinkedByRelease = new Map<string, number>();
  for (const [index, row] of rows.entries()) {
    if (extraLinkCovering(extra, row.file_path)) continue;
    unlinkedByRelease.set(releaseKeys[index]!, (unlinkedByRelease.get(releaseKeys[index]!) ?? 0) + 1);
  }
  // Packs repeat one release name many times, so each name is only compared once.
  const titleMatches = new Map<string, IndexedTitle[]>();
  const titleMatch = (name: string): IndexedTitle[] => {
    let matches = titleMatches.get(name);
    if (!matches) {
      matches = matchReleaseTitles(library.titleIndex, name, new Date(now));
      titleMatches.set(name, matches);
    }
    return matches;
  };
  const noTitles: IndexedTitle[] = [];
  const shownRows = rows.flatMap((row, index) => (extraLinkCovering(extra, row.file_path) ? [] : [{ row, index }]));
  const items: OrphanReviewItem[] = shownRows.map(({ row, index }) => {
    const category = classify(row, library);
    const sizeBytes = Number(row.size_bytes);
    const releaseKey = releaseKeys[index]!;
    const releaseName = releaseNameOf(releaseKey, row.relative_path);
    // A folder named after a hash still has a file name to go on.
    const folderTitles = category === "unlinked" ? titleMatch(releaseName) : noTitles;
    const titles = category === "unlinked" && folderTitles.length === 0 ? titleMatch(releaseNameOf(row.relative_path, row.relative_path)) : folderTitles;
    const matchedTitle = titles[0]?.itemName ?? null;
    const label: OrphanReviewLabel = category !== "unlinked" ? category : !matchedTitle ? "no_title_match" : hasUnlinkedEpisode(row, titles, library) ? "episode_not_linked" : "title_in_library";
    const releaseLinkedCount = linkedByRelease.get(releaseKey)?.size ?? 0;
    const linkedSizeBytes = category === "superseded" ? linkedSizeOf(row, library) : null;
    return {
      storageFileId: row.id,
      rootType,
      relativePath: row.relative_path,
      filePath: row.file_path,
      section: row.section,
      itemName: row.item_name,
      sizeBytes,
      mtimeMs: Number(row.mtime_ms),
      category,
      protectedReason: protectedReason(row, now, extra),
      hollow: integrityOf(row) === "hollow",
      integrity: integrityOf(row),
      zeroSamples: row.integrity_zero_samples,
      label,
      matchedTitle,
      releaseName,
      releaseStatus: releaseLinkedCount > 0 ? "partly_linked" : "none_linked",
      releaseFileCount: releaseLinkedCount + (unlinkedByRelease.get(releaseKey) ?? 0),
      releaseLinkedCount,
      linkedSizeBytes,
      sizeComparison: compareSizes(sizeBytes, linkedSizeBytes),
      episodeCoverage: episodeCoverageOf(row, library),
      extraLinkPath: extraLinkCovering(extra, row.file_path)
    };
  });
  const totalsFor = (matching: OrphanReviewItem[]) => ({
    count: matching.length,
    sizeBytes: matching.reduce((total, item) => total + item.sizeBytes, 0),
    purgeableCount: matching.filter((item) => !item.protectedReason).length
  });
  const categories: OrphanCategory[] = ["superseded", "copy_leftover", "not_in_library", "srtl_artifact", "unlinked"];
  const summary = categories.map((category) => ({ category, ...totalsFor(items.filter((item) => item.category === category)) })).filter((entry) => entry.count > 0);
  const labels: OrphanReviewLabel[] = ["superseded", "copy_leftover", "not_in_library", "srtl_artifact", "episode_not_linked", "title_in_library", "no_title_match"];
  const labelSummary = labels.map((label) => ({ label, ...totalsFor(items.filter((item) => item.label === label)) })).filter((entry) => entry.count > 0);
  const hollowCount = items.filter((item) => item.hollow).length;
  const damagedCount = items.filter((item) => item.integrity === "partial_hollow").length;
  return {
    rootType,
    items,
    leftoverFolders,
    summary,
    labelSummary,
    hollowCount,
    damagedCount,
    symlinkInventoryAt: staleness.at,
    storageInventoryAt: storageInventory,
    staleWarning: staleness.warning,
    storageStaleWarning: storageStaleness(storageInventory, now),
    extraSymlinks: { folders: extra.folders, linkCount: extra.linkCount, unmatchedCount: extra.unmatchedCount, problems: extra.problems },
    skippedInUse: skippedInUseSummary(rows.length - shownRows.length, folders),
    holdDays
  };
}

// Library-linked files are never orphan rows, so every skipped file is held by an extra folder link.
function skippedInUseSummary(extraLinkedFiles: number, folders: LeftoverFolderReview[]): OrphanSkippedInUse {
  const byReason: Record<OrphanInUseReason, number> = { library_link: 0, extra_link: extraLinkedFiles };
  let skippedFolders = 0;
  for (const folder of folders) {
    if (!folder.inUse) continue;
    byReason[folder.inUse] += 1;
    skippedFolders += 1;
  }
  return { total: extraLinkedFiles + skippedFolders, files: extraLinkedFiles, folders: skippedFolders, byReason };
}

// Recomputed under the job's admission transaction so only files that are orphans right now can be queued.
export async function purgeableOrphans(db: DbExecutor, rootType: StorageRootType, storageFileIds: number[], now = Date.now(), extra?: ExtraSymlinks): Promise<{ eligible: OrphanRow[]; rejected: string[] }> {
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
    const reason = protectedReason(row, now, extra);
    if (reason) rejected.push(`${path.basename(row.relative_path)}: ${reason}`);
    else eligible.push(row);
  }
  return { eligible, rejected };
}

/** A fresh read of the extra symlink folders for a purge; refuses when any of them cannot be read in full. Empty when none are set. */
export async function extraSymlinksForPurge(db: DbExecutor, paths: PathsSettings): Promise<ExtraSymlinks> {
  const extra = await readExtraSymlinks(paths, extraSymlinkFolders().length > 0 ? (await getSectionSettings(db)).sections : []);
  const refusal = extraSymlinkRefusal(extra);
  if (refusal) throw new ConflictError(refusal);
  return extra;
}

// Recomputed under the job's admission transaction, like purgeableOrphans. A damaged file may have library symlinks: they go with it.
export async function purgeableDamagedFiles(db: DbExecutor, storageFileIds: number[], now = Date.now()): Promise<{ eligible: OrphanRow[]; rejected: string[] }> {
  const found = new Map((await orphanRows(db, "local", storageFileIds, true)).map((row) => [row.id, row]));
  const eligible: OrphanRow[] = [];
  const rejected: string[] = [];
  for (const id of storageFileIds) {
    const row = found.get(id);
    if (!row) {
      rejected.push(`file #${id} is no longer on this storage`);
      continue;
    }
    const reason = !isDamaged(row) ? "A later scan found this file healthy" : protectedReason(row, now);
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

type Stat = import("node:fs").Stats;

// Checks the file right before it is touched: still a regular file, still inside the root, and, for the file the
// purge is about, unchanged since it was inventoried. The holding area is checked folder by folder on the way in.
async function moveOrRemove(root: string, from: string, to: string | null, expect?: (stat: Stat) => void): Promise<void> {
  const stat = await assertStillInside(root, from, "file", from);
  expect?.(stat);
  if (to) await moveIntoHoldingArea(root, from, to);
  else await withFilesystemTimeout(fs.unlink(from), `Deleting ${from}`);
}

function unchangedSince(operation: PurgeOperation, now: number, action: string): (stat: Stat) => void {
  return (stat) => {
    if (stat.size !== Number(operation.sizeBytes) || Math.trunc(stat.mtimeMs) !== Number(operation.mtimeMs)) {
      throw new Error(`File changed after it was inventoried; rescan before ${action}`);
    }
    if (now - stat.mtimeMs < purgeGraceMs) throw new Error("File was modified in the last 24 hours");
  };
}

// When the last video in a folder is purged, its subtitles, artwork, and metadata go with it, then empty folders.
async function cleanFolderAfterPurge(root: string, stopAt: string, directory: string, holdBase: string | null, extra?: ExtraSymlinks): Promise<Extra[]> {
  const extras: Extra[] = [];
  let current = directory;
  while (isPathInside(stopAt, current) && path.resolve(current) !== path.resolve(stopAt)) {
    // A link from another tool can point at a subtitle here, which is still in use with the video gone.
    if (extra && extraLinkTouchingFolder(extra, current)) break;
    // Checked by real path, not by name, right before it is read and again before it is removed.
    if (!(await assertStillInside(root, current, "folder", current).then(() => true, () => false))) break;
    const entries = await withFilesystemTimeout(fs.readdir(current, { withFileTypes: true }), `Reading ${current}`).catch(() => null);
    if (!entries) break;
    if (entries.some((entry) => entry.isDirectory() || (entry.isFile() && isMediaFile(entry.name)) || (!entry.isFile() && !entry.isDirectory()))) break;
    if (entries.some((entry) => !sidecarExtensions.has(path.extname(entry.name).toLowerCase()))) break;
    for (const entry of entries) {
      const from = path.join(current, entry.name);
      const to = holdBase ? path.join(holdBase, path.relative(root, from)) : null;
      // Whatever was moved before a failure is still recorded, so it can be restored or expired.
      try {
        await moveOrRemove(root, from, to);
      } catch {
        return extras;
      }
      extras.push({ from, to });
    }
    if (!(await assertStillInside(root, current, "folder", current).then(() => true, () => false))) break;
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

type PurgeOutcome = { stage: "held" | "deleted" | "already_missing"; heldPath: string | null; extras: Extra[]; removedLinks: RemovedLink[]; linkErrors: string[] };

function holdingAreaError(error: unknown, heldPath: string | null): unknown {
  const code = errorCode(error);
  if (heldPath && code && ["EXDEV", "EPERM", "ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EINVAL", "EACCES"].includes(code)) {
    return new Error(`This storage does not support moving files into the holding area (${code}); purge with immediate deletion instead`, { cause: error });
  }
  return error;
}

type FolderContents = { files: string[]; directories: string[] };

// Re-walks a folder right before it is purged; anything that could be someone's media stops the purge.
// Returns what it saw, deepest folders first, so a delete only ever touches files this walk checked.
async function assertFolderStillLeftover(directory: string, now: number, contents: FolderContents = { files: [], directories: [] }): Promise<FolderContents> {
  const stat = await withFilesystemTimeout(fs.lstat(directory), `Inspection of ${directory}`);
  if (now - stat.mtimeMs < purgeGraceMs) throw new Error(`${directory} was modified in the last 24 hours`);
  const entries = await withFilesystemTimeout(fs.readdir(directory, { withFileTypes: true }), `Reading ${directory}`);
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await assertFolderStillLeftover(entryPath, now, contents);
    } else if (entry.isFile()) {
      if (isMediaFile(entry.name)) throw new Error(`Folder now contains a video (${entryPath}); nothing was purged`);
      const fileStat = await withFilesystemTimeout(fs.lstat(entryPath), `Inspection of ${entryPath}`);
      if (now - fileStat.mtimeMs < purgeGraceMs) throw new Error(`${entryPath} was modified in the last 24 hours`);
      contents.files.push(entryPath);
    } else {
      throw new Error(`Folder contains a symlink or special file (${entryPath}); nothing was purged`);
    }
  }
  contents.directories.push(directory);
  return contents;
}

/** The filesystem calls a folder delete needs; tests swap in a fake that behaves like a debrid mount. */
export type FolderDeleteFs = Pick<typeof fs, "unlink" | "rmdir">;

/** Runs right before each unlink or rmdir of a folder delete; throws to stop it. */
export type FolderDeleteCheck = (target: string, kind: "file" | "folder") => Promise<void>;

/**
 * Deletes the files a re-walk checked one at a time, then the folders that held them, deepest first.
 * Debrid FUSE mounts refuse rmdir on a folder that still has files (EIO), which is all a recursive rm tries,
 * but they allow unlinking files and drop the folder themselves once its last file goes. So a folder that is
 * already gone counts as removed. A failure says how far the delete got.
 */
export async function deleteFolderFileByFile(directory: string, contents: FolderContents, ops: FolderDeleteFs = fs, check?: FolderDeleteCheck): Promise<void> {
  let deleted = 0;
  for (const filePath of contents.files) {
    try {
      // The list was collected earlier, so each file is checked again right before it goes.
      await check?.(filePath, "file");
      await withFilesystemTimeout(ops.unlink(filePath), `Deleting ${filePath}`);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") {
        const progress = deleted > 0 ? `Deleted ${deleted} of ${contents.files.length} files in ${directory}, then` : "Nothing in this folder was deleted:";
        throw new Error(`${progress} ${filePath} could not be deleted (${fsErrorText(error)}); the folder was left in place`, { cause: error });
      }
    }
    deleted += 1;
  }
  for (const folder of contents.directories) {
    try {
      await check?.(folder, "folder");
      await withFilesystemTimeout(ops.rmdir(folder), `Removing folder ${folder}`);
    } catch (error) {
      if (errorCode(error) === "ENOENT") continue;
      const files = contents.files.length === 1 ? "the 1 file" : `all ${contents.files.length} files`;
      throw new Error(`Deleted ${files} in ${directory}, but folder ${folder} could not be removed (${fsErrorText(error)})`, { cause: error });
    }
  }
}

async function executeLeftoverFolderPurge(db: DbExecutor, operation: PurgeOperation, root: string, paths: PathsSettings, now: number): Promise<PurgeOutcome> {
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
  const folderLink = await linkToFolderAbove(db, directory);
  if (folderLink) throw new Error(`Symlink ${folderLink} points to this folder or one above it; nothing was purged`);
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
    return { stage: "already_missing", heldPath: null, extras: [], removedLinks: [], linkErrors: [] };
  }
  if (!stat.isDirectory()) throw new Error("Path is no longer a folder; nothing was purged");
  await assertExistingPathInside(root, directory, "Leftover folder");
  const contents = await assertFolderStillLeftover(directory, now);
  const extraLink = extraLinkTouchingFolder(await extraSymlinksForPurge(db, paths), directory);
  if (extraLink) throw new Error(`Symlink ${extraLink} points into this folder; nothing was purged`);

  const heldPath = operation.mode === "hold" ? path.join(root, holdingFolderName, `job-${operation.jobId}`, path.relative(root, directory)) : null;
  try {
    // The walks above take time, so the folder is checked again right before it is moved or deleted.
    await assertStillInside(root, directory, "folder", "Leftover folder");
    if (heldPath) {
      await moveIntoHoldingArea(root, directory, heldPath);
    } else {
      await deleteFolderFileByFile(directory, contents, fs, async (target, kind) => {
        const stat = await assertStillInside(root, target, kind, target);
        if (kind === "file" && now - stat.mtimeMs < purgeGraceMs) throw new Error(`${target} was modified in the last 24 hours`);
      });
    }
  } catch (error) {
    throw holdingAreaError(error, heldPath);
  }
  await db.delete(schema.storageLeftoverFolders).where(eq(schema.storageLeftoverFolders.id, folder.id));
  return { stage: heldPath ? "held" : "deleted", heldPath, extras: [], removedLinks: [], linkErrors: [] };
}

export async function executeOrphanPurgeOperation(db: DbExecutor, operation: PurgeOperation, context: PurgeExecutionContext): Promise<PurgeOutcome> {
  const now = context.now ?? Date.now();
  const rootType = operation.rootType as StorageRootType;
  const root = rootPathFor(context.paths, rootType);
  if (!root) throw new Error("Storage root is not configured");
  if (operation.targetKind === "folder") return executeLeftoverFolderPurge(db, operation, root, context.paths, now);
  if (operation.targetKind === "damaged_file") return executeDamagedFilePurge(db, operation, root, context, now);
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
  const folderLink = await linkToFolderAbove(db, path.dirname(operation.filePath));
  if (folderLink) throw new Error(`Symlink ${folderLink} points to a folder holding this file; it is still in use`);
  if (await hasUnfinishedCopy(db, operation.filePath)) throw new Error("This file is part of an unfinished copy");

  let stat: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    stat = await withFilesystemTimeout(fs.lstat(operation.filePath), `Inspection of ${operation.filePath}`);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
    await db.update(schema.storageFiles).set({ missingSince: nowIso(), updatedAt: nowIso() }).where(eq(schema.storageFiles.id, operation.storageFileId));
    return { stage: "already_missing", heldPath: null, extras: [], removedLinks: [], linkErrors: [] };
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
  // The last check before the file goes: another tool can add a link at any time, and no scan would have seen it.
  const extraSymlinks = await extraSymlinksForPurge(db, context.paths);
  const extraLink = extraLinkCovering(extraSymlinks, operation.filePath);
  if (extraLink) throw new Error(`Symlink ${extraLink} points to this file; it is still in use`);

  const holdBase = operation.mode === "hold" ? path.join(root, holdingFolderName, `job-${operation.jobId}`) : null;
  const heldPath = holdBase ? path.join(holdBase, path.relative(root, operation.filePath)) : null;
  try {
    // Checked again right before the move or delete: the symlink walks above take time.
    await moveOrRemove(root, operation.filePath, heldPath, unchangedSince(operation, now, "purging"));
  } catch (error) {
    throw holdingAreaError(error, heldPath);
  }
  const stopAt = storageFile.section ? path.join(root, storageFile.section) : root;
  const extras = await cleanFolderAfterPurge(root, stopAt, path.dirname(operation.filePath), holdBase, extraSymlinks).catch(() => []);
  await db.update(schema.storageFiles).set({ missingSince: nowIso(), updatedAt: nowIso() }).where(eq(schema.storageFiles.id, operation.storageFileId));
  return { stage: heldPath ? "held" : "deleted", heldPath, extras, removedLinks: [], linkErrors: [] };
}

// A library link to this folder or any folder above it.
async function linkToFolderAbove(db: DbExecutor, directory: string): Promise<string | null> {
  const row = (
    await db.execute<{ link_path: string }>(sql`
      select link_path from media_links
      where missing_since is null and target_path in (select jsonb_array_elements_text(${JSON.stringify(pathAndAncestors(directory))}::jsonb))
      limit 1
    `)
  ).rows[0];
  return row?.link_path ?? null;
}

async function hasUnfinishedCopy(db: DbExecutor, filePath: string): Promise<boolean> {
  const row = (
    await db.execute<{ id: number }>(sql`
      select copy_operations.id from copy_operations
      where ${unfinishedCopyCondition}
        and ${filePath} in (copy_operations.source_path, copy_operations.destination_path, coalesce(copy_operations.temp_path, ''), coalesce(copy_operations.displaced_path, ''))
      limit 1
    `)
  ).rows[0];
  return Boolean(row);
}

// The file goes first, then the symlinks that pointed to it, so a refused move leaves the library exactly as it was.
async function removeLinksToFile(db: DbExecutor, filePath: string, storageFileId: number, symlinkDir: string, titleFolder: string | null): Promise<{ removed: RemovedLink[]; errors: string[] }> {
  const links = await db
    .select({ linkPath: schema.mediaLinks.linkPath, targetPath: schema.mediaLinks.targetPath, relativePath: schema.mediaLinks.relativePath })
    .from(schema.mediaLinks)
    .where(and(isNull(schema.mediaLinks.missingSince), or(eq(schema.mediaLinks.resolvedStorageFileId, storageFileId), eq(schema.mediaLinks.targetPath, filePath))));
  // A symlink made since the last scan is not in the inventory yet.
  const unlisted = titleFolder ? await findLiveSymlinkTo(titleFolder, path.resolve(filePath)) : null;
  if (unlisted && !links.some((link) => link.linkPath === unlisted)) links.push({ linkPath: unlisted, targetPath: filePath, relativePath: path.relative(path.dirname(titleFolder!), unlisted) });
  const removed: RemovedLink[] = [];
  const errors: string[] = [];
  for (const link of links) {
    try {
      await removeExpectedSymlink(symlinkDir, link.linkPath, link.targetPath);
      await db.update(schema.mediaLinks).set({ missingSince: nowIso(), updatedAt: nowIso() }).where(eq(schema.mediaLinks.linkPath, link.linkPath));
      removed.push(link);
    } catch (error) {
      errors.push(`${path.basename(link.linkPath)}: ${publicErrorMessage(error, "the symlink could not be removed")}`);
    }
  }
  return { removed, errors };
}

async function executeDamagedFilePurge(db: DbExecutor, operation: PurgeOperation, root: string, context: PurgeExecutionContext, now: number): Promise<PurgeOutcome> {
  const storageFile = (
    await db.select().from(schema.storageFiles).where(eq(schema.storageFiles.id, operation.storageFileId)).for("update").limit(1)
  )[0];
  if (!storageFile || path.resolve(storageFile.filePath) !== path.resolve(operation.filePath)) throw new Error("Inventory record changed after the delete was queued; rescan before deleting");
  if (!isDamaged({ size_bytes: storageFile.sizeBytes, allocated_bytes: storageFile.allocatedBytes, integrity: storageFile.integrity })) throw new Error("A later scan found this file healthy; nothing was deleted");
  if (await hasUnfinishedCopy(db, operation.filePath)) throw new Error("This file is part of an unfinished copy");

  const symlinkDir = context.paths.symlinkDir;
  const titleFolder = symlinkDir && storageFile.section && storageFile.itemName ? path.join(symlinkDir, storageFile.section, storageFile.itemName) : null;
  let stat: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    stat = await withFilesystemTimeout(fs.lstat(operation.filePath), `Inspection of ${operation.filePath}`);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
    const links = await removeLinksToFile(db, operation.filePath, operation.storageFileId, symlinkDir, titleFolder);
    await db.update(schema.storageFiles).set({ missingSince: nowIso(), updatedAt: nowIso() }).where(eq(schema.storageFiles.id, operation.storageFileId));
    return { stage: "already_missing", heldPath: null, extras: [], removedLinks: links.removed, linkErrors: links.errors };
  }
  if (!stat.isFile()) throw new Error("Path is no longer a regular file; nothing was deleted");
  await assertExistingPathInside(root, operation.filePath, "Damaged file");
  if (stat.size !== Number(operation.sizeBytes) || Math.trunc(stat.mtimeMs) !== Number(operation.mtimeMs)) {
    throw new Error("File changed after it was inventoried; rescan before deleting");
  }
  if (now - stat.mtimeMs < purgeGraceMs) throw new Error("File was modified in the last 24 hours");

  const holdBase = operation.mode === "hold" ? path.join(root, holdingFolderName, `job-${operation.jobId}`) : null;
  const heldPath = holdBase ? path.join(holdBase, path.relative(root, operation.filePath)) : null;
  try {
    await moveOrRemove(root, operation.filePath, heldPath, unchangedSince(operation, now, "deleting"));
  } catch (error) {
    throw holdingAreaError(error, heldPath);
  }
  const stopAt = storageFile.section ? path.join(root, storageFile.section) : root;
  const extras = await cleanFolderAfterPurge(root, stopAt, path.dirname(operation.filePath), holdBase).catch(() => []);
  const links = await removeLinksToFile(db, operation.filePath, operation.storageFileId, symlinkDir, titleFolder);
  await db.update(schema.storageFiles).set({ missingSince: nowIso(), updatedAt: nowIso() }).where(eq(schema.storageFiles.id, operation.storageFileId));
  return { stage: heldPath ? "held" : "deleted", heldPath, extras, removedLinks: links.removed, linkErrors: links.errors };
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

function parseRemovedLinks(raw: string): RemovedLink[] {
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) ? value.filter((entry): entry is RemovedLink => Boolean(entry) && typeof entry.linkPath === "string" && typeof entry.targetPath === "string" && typeof entry.relativePath === "string") : [];
  } catch {
    return [];
  }
}

// A symlink is put back only where nothing has taken its place, such as the new copy of the title.
async function restoreRemovedLinks(db: DbExecutor, symlinkDir: string, links: RemovedLink[]): Promise<void> {
  for (const link of links) {
    if (!symlinkDir || !isPathInside(symlinkDir, link.linkPath)) continue;
    const occupied = await fs.lstat(link.linkPath).then(() => true, () => false);
    if (occupied) continue;
    await fs.mkdir(path.dirname(link.linkPath), { recursive: true });
    await assertPathParentInside(symlinkDir, link.linkPath, "Restored symlink");
    await fs.symlink(link.targetPath, link.linkPath);
    await db.update(schema.mediaLinks).set({ missingSince: null, updatedAt: nowIso() }).where(eq(schema.mediaLinks.linkPath, link.linkPath));
  }
}

/**
 * Puts one held file (or folder) back. The caller holds the locks: a restore
 * job's resource claims, or {@link restoreHeldOrphans}' mutation guard.
 */
export async function restoreHeldOrphan(transaction: DbExecutor, paths: PathsSettings, operationId: number): Promise<RestoredOrphan> {
  const operation = (await transaction.select().from(schema.orphanPurgeOperations).where(eq(schema.orphanPurgeOperations.id, operationId)).for("update").limit(1))[0];
  if (!operation || operation.stage !== "held" || !operation.heldPath) throw new ConflictError(`Held file #${operationId} is not available to restore`);
  const root = rootPathFor(paths, operation.rootType as StorageRootType);
  const holdRoot = path.join(root, holdingFolderName);
  if (!root || !isPathInside(holdRoot, operation.heldPath!) || !isPathInside(root, operation.filePath) || isPathInside(holdRoot, operation.filePath)) {
    throw new ConflictError(`Held file #${operationId} is outside its storage root.`);
  }
  try {
    // Checks the holding area folder by folder, creates the way back inside the root, and never replaces anything.
    await moveOutOfHoldingArea(root, operation.heldPath!, operation.filePath, `Held file #${operationId}`);
  } catch (error) {
    if (errorCode(error) === "EEXIST") throw new ConflictError(`A file now exists where held file #${operationId} came from; restore it manually.`, { detail: operation.filePath });
    if (errorCode(error) === "EUNSAFEPATH") throw new ConflictError(`Held file #${operationId} could not be restored safely: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
  for (const extra of parseExtras(operation.extras)) {
    if (!extra.to || !isPathInside(holdRoot, extra.to) || !isPathInside(root, extra.from) || isPathInside(holdRoot, extra.from)) continue;
    // A sidecar that cannot go back safely, or whose place is taken, stays in the holding area.
    await moveOutOfHoldingArea(root, extra.to, extra.from, "Sidecar").catch(() => undefined);
  }
  await removeEmptyHoldingFolders(root, path.dirname(operation.heldPath!));
  await restoreRemovedLinks(transaction, paths.symlinkDir, parseRemovedLinks(operation.removedLinks));
  const timestamp = nowIso();
  // A restored folder is found again by the next storage scan.
  if (operation.targetKind !== "folder") {
    await transaction.update(schema.storageFiles).set({ missingSince: null, updatedAt: timestamp }).where(eq(schema.storageFiles.id, operation.storageFileId));
  }
  await transaction.update(schema.orphanPurgeOperations).set({ stage: "restored", updatedAt: timestamp }).where(eq(schema.orphanPurgeOperations.id, operation.id));
  // The file is back, so nothing should go looking for another copy of it.
  await transaction
    .update(schema.reRequests)
    .set({ status: "skipped", message: "The file was restored, so nothing was requested.", updatedAt: timestamp })
    .where(and(eq(schema.reRequests.operationId, operation.id), inArray(schema.reRequests.status, ["queued", "pending", "failed"])));
  return { operationId: operation.id, filePath: operation.filePath, rootType: operation.rootType as StorageRootType, targetKind: operation.targetKind };
}

export interface RestoredOrphan {
  operationId: number;
  filePath: string;
  rootType: StorageRootType;
  targetKind: string;
}

/** Restores held files one at a time, each under the mutation guard. The API queues a restore job instead; this is for callers already in the worker. */
export async function restoreHeldOrphans(db: Db, paths: PathsSettings, operationIds: number[], onError?: (error: unknown, operationId: number) => void): Promise<{ restored: number; errors: string[] }> {
  let restored = 0;
  const errors: string[] = [];
  for (const operationId of operationIds) {
    try {
      await withResourceMutationGuard(db, async (transaction) => {
        const operation = (await transaction.select().from(schema.orphanPurgeOperations).where(eq(schema.orphanPurgeOperations.id, operationId)).limit(1))[0];
        if (!operation || operation.stage !== "held" || !operation.heldPath) throw new ConflictError(`Held file #${operationId} is not available to restore`);
        return {
          resources: [{ resourceType: "path", resourceKey: path.resolve(operation.filePath) }],
          mutate: () => restoreHeldOrphan(transaction, paths, operationId)
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

// Permanently deletes held files whose retention ended. Runs during worker maintenance.
// Every path is checked folder by folder right before the delete; an operation with any unsafe path is left for a person to look at.
export async function expireHeldOrphans(db: Db, paths: PathsSettings, now = Date.now(), onError?: (error: unknown, operationId: number) => void): Promise<number> {
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
    try {
      for (const target of targets) {
        await deleteHoldingEntry(root, target, operation.targetKind === "folder");
        await removeEmptyHoldingFolders(root, path.dirname(target));
      }
    } catch (error) {
      onError?.(error, operation.id);
      continue;
    }
    await db.update(schema.orphanPurgeOperations).set({ stage: "expired", updatedAt: nowIso() }).where(eq(schema.orphanPurgeOperations.id, operation.id));
    expired += 1;
  }
  return expired;
}

function titleRelativePath(relativePath: string, section: string, itemName: string): string {
  const parts = relativePath.split("/");
  if (section && parts[0] === section) parts.shift();
  if (itemName && parts[0] === itemName) parts.shift();
  return parts.join("/");
}

// Called when a delete job ends, so a re-request only ever follows a delete that happened. Files it did not delete are recorded as not requested.
export async function queueReRequestsForJob(db: DbExecutor, jobId: number): Promise<void> {
  const operations = (await operationsForJob(db, jobId)).filter((operation) => operation.targetKind !== "folder");
  const timestamp = nowIso();
  for (let offset = 0; offset < operations.length; offset += 500) {
    const batch = operations.slice(offset, offset + 500);
    const files = new Map((await db.select().from(schema.storageFiles).where(inArray(schema.storageFiles.id, batch.map((operation) => operation.storageFileId)))).map((file) => [file.id, file]));
    const rows = batch.map((operation): typeof schema.reRequests.$inferInsert => {
      const file = files.get(operation.storageFileId);
      const section = file?.section ?? "";
      const itemName = file?.itemName ?? "";
      const links = parseRemovedLinks(operation.removedLinks);
      const names = [file ? titleRelativePath(file.relativePath, section, itemName) : path.basename(operation.filePath), ...links.map((link) => titleRelativePath(link.relativePath, section, itemName))];
      const deleted = ["held", "deleted", "already_missing"].includes(operation.stage);
      return {
        jobId,
        operationId: operation.id,
        section,
        itemName,
        fileNames: JSON.stringify([...new Set(names)]),
        wasLinked: links.length > 0,
        displayName: path.basename(operation.filePath),
        status: deleted ? "queued" : "skipped",
        message: deleted ? null : "The file was not deleted, so nothing was requested.",
        createdAt: timestamp,
        updatedAt: timestamp
      };
    });
    await db.insert(schema.reRequests).values(rows).onConflictDoNothing();
  }
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

const purgeItemStages: Record<OrphanPurgeItemOutcome, string[]> = {
  failed: ["failed"],
  // Held files stay in this list after they are restored or their holding period ends, with their current stage.
  held: ["held", "restored", "expired"]
};

/** One page of a purge job's items with the given outcome, oldest first. */
export async function listPurgeJobItems(db: DbExecutor, jobId: number, outcome: OrphanPurgeItemOutcome, offset: number, limit: number): Promise<OrphanPurgeItemPage> {
  const where = and(eq(schema.orphanPurgeOperations.jobId, jobId), inArray(schema.orphanPurgeOperations.stage, purgeItemStages[outcome]));
  const [countRow] = await db.select({ count: sql<number>`count(*)::int` }).from(schema.orphanPurgeOperations).where(where);
  const rows = await db.select().from(schema.orphanPurgeOperations).where(where).orderBy(schema.orphanPurgeOperations.id).offset(offset).limit(limit);
  const total = Number(countRow?.count ?? 0);
  return {
    jobId,
    outcome,
    items: rows.map((row) => ({
      operationId: row.id,
      targetKind: row.targetKind === "folder" ? "folder" : "file",
      rootType: row.rootType as StorageRootType,
      filePath: row.filePath,
      sizeBytes: Number(row.sizeBytes),
      stage: row.stage as OrphanPurgeItem["stage"],
      errorMessage: row.errorMessage,
      heldPath: row.heldPath,
      purgeAfter: row.purgeAfter,
      completedAt: row.completedAt
    })),
    total,
    offset,
    limit,
    hasMore: offset + rows.length < total
  };
}
