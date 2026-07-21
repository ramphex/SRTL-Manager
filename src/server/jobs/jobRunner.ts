import { and, asc, count, desc, eq, gt, gte, inArray, lt, ne } from "drizzle-orm";
import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { JobConcurrencySettings } from "../config";
import { first, getJsonSetting, getSectionSettings, nowIso, type Db } from "../db/database";
import * as schema from "../db/schema";
import { auditMediaLink, defaultAuditRunner, type AuditCommandRunner } from "../lib/auditor";
import { copyMediaLink, defaultCopyRunner, type CopyCommandRunner, type CopyMediaResult, type CopyOperationUpdate, type CopyProgressUpdate } from "../lib/copier";
import { assertDestinationPathInside, assertExistingPathInside, assertPathParentInside, withFilesystemTimeout } from "../lib/filesystemSafety";
import { isMediaFile, isPathInside } from "../lib/media";
import { assertPathMigrationReady, isPathConfigurationBlocked, runPathMigration } from "../lib/pathConfiguration";
import { completeOnboardingScan } from "../lib/onboarding";
import { defaultScanOptions, getStoragePolicyMap, listMediaLinks, persistScanResult, scanLibrary, type ScanActivity } from "../lib/scanner";
import { normalizeAdvancedSettings } from "../../shared/advancedSettings";
import { evaluateSourceTitleRisk } from "../../shared/sourceTitleRisk";
import type {
  AuditMode,
  AuditOptions,
  CopyConflictPreview,
  CopyDirection,
  CopyLocalConflict,
  CopyLocalConflictCandidate,
  CopyLocalConflictStrategy,
  CopyOptions,
  InventorySummary,
  JobEventPage,
  JobEventRecord,
  JobRecord,
  JobStatus,
  MediaLinkRow,
  PathsSettings,
  ScanOptions,
  ScanTitleScope,
  StoragePolicyKind,
  StorageRootType
} from "../../shared/types";

type JobRow = typeof schema.jobs.$inferSelect;
type CopyProgressStage = CopyProgressUpdate["stage"] | "queued" | "done" | "skipped" | "conflict" | "partially_failed" | "failed" | "completed" | "cancelled";

class WorkerShutdownError extends Error {
  constructor() {
    super("Worker stopped before the job finished");
    this.name = "WorkerShutdownError";
  }
}

class PartialJobFailureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PartialJobFailureError";
  }
}

const defaultJobConcurrency: JobConcurrencySettings = {
  workerCount: 1,
  maxRunningJobs: 1,
  maxRunningScans: 1,
  maxRunningAudits: 1,
  maxRunningCopies: 1
};

export interface JobContext {
  jobId: number;
  signal: AbortSignal;
  event(level: JobEventRecord["level"], message: string, data?: unknown): Promise<void>;
  setProgress(progress: unknown): Promise<void>;
  isCancelled(): Promise<boolean>;
}

export interface JobListOptions {
  activeOnly?: boolean;
  completedSince?: string;
  limit?: number;
}

export interface JobWorkerOptions {
  workerId?: string;
  pollIntervalMs?: number;
  heartbeatIntervalMs?: number;
  reclaimStaleAfterMs?: number;
  reclaimOwnInterruptedAfterMs?: number;
  logger?: Pick<Console, "info" | "warn" | "error">;
  copyRunner?: CopyCommandRunner;
  auditRunner?: AuditCommandRunner;
  concurrency?: JobConcurrencySettings;
}

function normalizeSelectedSections(selectedSections: string[] | undefined, configuredSections: string[], label: string): string[] {
  const configured = new Set(configuredSections);
  const requested = selectedSections ?? configuredSections;
  const normalized = [...new Set(requested.map((section) => section.trim()).filter(Boolean))];
  const invalid = normalized.filter((section) => !configured.has(section));
  if (invalid.length > 0) {
    throw new Error(`Unknown ${label}: ${invalid.join(", ")}`);
  }
  return normalized;
}

function normalizeOptionalSections(selectedSections: string[] | undefined, configuredSections: string[], label: string): string[] | undefined {
  if (!selectedSections) return undefined;
  return normalizeSelectedSections(selectedSections, configuredSections, label);
}

function normalizeScanTitleScopes(scopes: ScanTitleScope[] | undefined, configuredSections: string[]): ScanTitleScope[] | undefined {
  if (!scopes?.length) return undefined;
  const configured = new Set(configuredSections);
  const normalized = new Map<string, ScanTitleScope>();
  for (const scope of scopes) {
    const section = scope.section.trim();
    const itemName = scope.itemName.trim();
    if (!configured.has(section)) throw new Error(`Unknown title scan folder: ${section}`);
    if (!itemName || itemName === "." || itemName === ".." || itemName.includes("/") || itemName.includes("\\") || itemName.includes("\0")) {
      throw new Error("Title scan names must identify one title folder");
    }
    normalized.set(`${section}\0${itemName}`, { section, itemName });
  }
  return [...normalized.values()];
}

function emptyScanTotals(): InventorySummary {
  return {
    totalLinks: 0,
    remoteLinks: 0,
    localLinks: 0,
    brokenLinks: 0,
    otherLinks: 0,
    nonMediaLinks: 0,
    actionableRemoteLinks: 0,
    actionableLocalLinks: 0,
    assignedRemoteLinks: 0,
    unassignedRemoteLinks: 0,
    unassignedLocalLinks: 0,
    localFiles: 0,
    remoteFiles: 0,
    actionableRemoteFiles: 0,
    actionableLocalFiles: 0,
    assignedRemoteFiles: 0,
    unassignedRemoteFiles: 0,
    unassignedLocalFiles: 0,
    localOrphanFiles: 0,
    remoteOrphanFiles: 0,
    missingLinks: 0,
    missingLocalFiles: 0,
    missingRemoteFiles: 0
  };
}

function scanProgressPayload(
  options: ScanOptions,
  stage: string,
  message: string,
  totals: InventorySummary = emptyScanTotals(),
  activity?: ScanActivity
): unknown {
  return {
    options,
    stage,
    message,
    ...totals,
    ...(activity
      ? {
          scanActivity: activity.phase,
          currentSection: activity.currentSection,
          discoveredLinks: activity.discoveredLinks,
          checkedLinks: activity.checkedLinks,
          completedWorkUnits: activity.completedWorkUnits,
          totalWorkUnits: activity.totalWorkUnits
        }
      : {})
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (error: unknown) {
    return { invalidJson: errorMessage(error) };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function finiteNumberFromRecord(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function jobProgressOptions<T>(job: JobRecord): T | null {
  if (!isRecord(job.progress)) return null;
  return "options" in job.progress ? (job.progress.options as T) : null;
}

async function normalizeScanOptions(db: Db, options: ScanOptions = defaultScanOptions): Promise<ScanOptions> {
  const configuredSections = await getSectionSettings(db);
  const titleScopes = normalizeScanTitleScopes(options.titleScopes, configuredSections.sections);
  if (titleScopes?.length && (!options.scanSymlinks || options.scanLocal || options.scanRemote)) {
    throw new Error("Title rescans can only scan symlinks");
  }
  const legacySections = normalizeOptionalSections(options.sections, configuredSections.sections, "scan folder");
  const symlinkSections = titleScopes?.length
    ? [...new Set(titleScopes.map((scope) => scope.section))]
    : normalizeSelectedSections(options.symlinkSections ?? legacySections, configuredSections.sections, "scan symlink folder");
  const localSections = normalizeSelectedSections(options.localSections ?? legacySections, configuredSections.sections, "scan local folder");
  return {
    scanSymlinks: options.scanSymlinks,
    scanLocal: options.scanLocal,
    scanRemote: options.scanRemote,
    symlinkSections,
    localSections,
    ...(titleScopes ? { titleScopes } : {}),
    ...(legacySections ? { sections: legacySections } : {})
  };
}

async function normalizeAuditOptions(db: Db, input: AuditMode | AuditOptions): Promise<AuditOptions> {
  const requestedOptions: { mode: AuditMode; sections?: string[]; targets?: StorageRootType[]; byteCompare?: boolean } = typeof input === "string" ? { mode: input } : input;
  const configuredSections = await getSectionSettings(db);
  if (requestedOptions.mode !== "fast" && requestedOptions.mode !== "deep") throw new Error("Audit mode must be fast or deep");
  const section = typeof input === "string" ? undefined : input.section?.trim();
  if (section && !configuredSections.sections.includes(section)) throw new Error(`Unknown audit folder: ${section}`);
  const linkIds = typeof input === "string" || !input.linkIds ? undefined : [...new Set(input.linkIds)].filter((id) => Number.isInteger(id) && id > 0);
  if (typeof input !== "string" && input.linkIds && linkIds?.length !== input.linkIds.length) throw new Error("Audit link IDs must be positive integers");
  const itemName = typeof input === "string" ? undefined : input.itemName?.trim();
  const relativePathPrefix = typeof input === "string" ? undefined : normalizeRelativePrefix(input.relativePathPrefix);
  const hasScopedAudit = Boolean(linkIds?.length || section || itemName || relativePathPrefix);
  const hasRequestedTargets = Array.isArray(requestedOptions.targets);
  const targets = normalizeAuditTargets(requestedOptions.targets);
  const selectedSections = requestedOptions.sections
    ? normalizeSelectedSections(requestedOptions.sections, configuredSections.sections, "audit folder")
    : hasScopedAudit || !targets.includes("local")
      ? undefined
      : normalizeSelectedSections(undefined, configuredSections.sections, "audit folder");
  if ((!hasScopedAudit || hasRequestedTargets) && targets.length === 0) throw new Error("Select at least one audit target");
  if (!hasScopedAudit && targets.includes("local") && (!selectedSections || selectedSections.length === 0)) throw new Error("Select at least one local audit folder");
  return {
    mode: requestedOptions.mode,
    ...(selectedSections ? { sections: selectedSections } : {}),
    ...(!hasScopedAudit ? { targets } : hasRequestedTargets ? { targets } : {}),
    ...(section ? { section } : {}),
    ...(linkIds && linkIds.length > 0 ? { linkIds } : {}),
    ...(itemName ? { itemName } : {}),
    ...(relativePathPrefix ? { relativePathPrefix } : {}),
    ...(requestedOptions.byteCompare === false ? { byteCompare: false } : {})
  };
}

function readAuditOptions(job: JobRecord): AuditOptions {
  const options = jobProgressOptions<AuditOptions>(job);
  if (!options || (options.mode !== "fast" && options.mode !== "deep")) {
    throw new Error("Audit job is missing valid options");
  }
  return {
    mode: options.mode,
    ...(Array.isArray(options.sections) ? { sections: options.sections.filter((section) => typeof section === "string" && section.trim()).map((section) => section.trim()) } : {}),
    ...(Array.isArray(options.targets) ? { targets: normalizeAuditTargets(options.targets) } : {}),
    ...(Array.isArray(options.linkIds) ? { linkIds: options.linkIds.filter((id) => Number.isInteger(id) && id > 0) } : {}),
    ...(typeof options.section === "string" && options.section.trim() ? { section: options.section.trim() } : {}),
    ...(typeof options.itemName === "string" && options.itemName.trim() ? { itemName: options.itemName.trim() } : {}),
    ...(typeof options.relativePathPrefix === "string" && options.relativePathPrefix.trim() ? { relativePathPrefix: normalizeRelativePrefix(options.relativePathPrefix) } : {}),
    ...(options.byteCompare === false ? { byteCompare: false } : {})
  };
}

function normalizeAuditTargets(targets: unknown): StorageRootType[] {
  if (!Array.isArray(targets)) return ["local", "remote"];
  return [...new Set(targets)].filter((target): target is StorageRootType => target === "local" || target === "remote");
}

function normalizeRelativePrefix(prefix: string | undefined): string | undefined {
  if (!prefix) return undefined;
  const normalized = prefix.replace(/\\/g, "/").split("/").filter(Boolean).join("/");
  if (!normalized || normalized === "." || normalized.startsWith("../") || normalized.includes("/../")) {
    throw new Error("Copy prefix must stay inside the selected folder");
  }
  return normalized;
}

async function normalizeCopyOptions(db: Db, options: CopyOptions): Promise<CopyOptions> {
  if (options.direction !== "to_local" && options.direction !== "to_remote") throw new Error("Copy direction must be to_local or to_remote");
  const configuredSections = await getSectionSettings(db);
  const section = options.section?.trim();
  if (section && !configuredSections.sections.includes(section)) throw new Error(`Unknown copy folder: ${section}`);
  const linkIds = options.linkIds ? [...new Set(options.linkIds)].filter((id) => Number.isInteger(id) && id > 0) : undefined;
  if (options.linkIds && linkIds?.length !== options.linkIds.length) throw new Error("Copy link IDs must be positive integers");
  const normalized: CopyOptions = {
    direction: options.direction,
    ...(linkIds && linkIds.length > 0 ? { linkIds } : {}),
    ...(section ? { section } : {}),
    ...(options.itemName?.trim() ? { itemName: options.itemName.trim() } : {}),
    ...(normalizeRelativePrefix(options.relativePathPrefix) ? { relativePathPrefix: normalizeRelativePrefix(options.relativePathPrefix) } : {}),
    ...(options.localConflictStrategy === "keep_both" || options.localConflictStrategy === "replace" ? { localConflictStrategy: options.localConflictStrategy } : {})
  };
  if (!normalized.linkIds?.length && !normalized.section && !normalized.itemName) throw new Error("Copy requires link IDs, a folder scope, or a title");
  return normalized;
}

function readCopyOptions(job: JobRecord): CopyOptions {
  const options = jobProgressOptions<CopyOptions>(job);
  if (!options) throw new Error("Copy job is missing options");
  return normalizeCopyOptionsFromProgress(options);
}

function normalizeCopyOptionsFromProgress(options: CopyOptions): CopyOptions {
  if (options.direction !== "to_local" && options.direction !== "to_remote") throw new Error("Copy job has invalid direction");
  return {
    direction: options.direction,
    ...(Array.isArray(options.linkIds) ? { linkIds: options.linkIds.filter((id) => Number.isInteger(id) && id > 0) } : {}),
    ...(typeof options.section === "string" && options.section.trim() ? { section: options.section.trim() } : {}),
    ...(typeof options.itemName === "string" && options.itemName.trim() ? { itemName: options.itemName.trim() } : {}),
    ...(typeof options.relativePathPrefix === "string" && options.relativePathPrefix.trim() ? { relativePathPrefix: normalizeRelativePrefix(options.relativePathPrefix) } : {}),
    ...(options.localConflictStrategy === "keep_both" || options.localConflictStrategy === "replace" ? { localConflictStrategy: options.localConflictStrategy } : {})
  };
}

function normalizedRelativePath(value: string): string {
  return value.replace(/\\/g, "/").split("/").filter(Boolean).join("/");
}

function relativePathMatchesPrefix(relativePath: string, prefix: string): boolean {
  const normalizedPath = normalizedRelativePath(relativePath);
  const normalizedPrefix = normalizedRelativePath(prefix);
  return normalizedPath === normalizedPrefix || normalizedPath.startsWith(`${normalizedPrefix}/`);
}

function hasScopedAuditOptions(options: AuditOptions): boolean {
  return Boolean(options.linkIds?.length || options.section || options.itemName || options.relativePathPrefix);
}

function filterScanLinks(links: MediaLinkRow[], options: ScanOptions): MediaLinkRow[] {
  if (!options.scanSymlinks) return [];
  const selectedSections = new Set(options.symlinkSections ?? options.sections ?? []);
  const titleScopes = options.titleScopes?.length
    ? new Set(options.titleScopes.map((scope) => `${scope.section}\0${scope.itemName}`))
    : null;
  return links.filter((link) => {
    if (!link.isMedia || link.missingSince) return false;
    if (titleScopes) return titleScopes.has(`${link.section}\0${link.itemName}`);
    return selectedSections.size === 0 || selectedSections.has(link.section);
  });
}

function filterAuditLinks(links: MediaLinkRow[], options: AuditOptions): MediaLinkRow[] {
  const requestedIds = options.linkIds?.length ? new Set(options.linkIds) : null;
  const requestedTargetSet = options.targets ? new Set(normalizeAuditTargets(options.targets)) : null;
  if (hasScopedAuditOptions(options)) {
    return links.filter((link) => {
      if (requestedIds && !requestedIds.has(link.id)) return false;
      if (!link.isMedia || link.missingSince || (link.kind !== "local" && link.kind !== "remote")) return false;
      if (requestedTargetSet && !requestedTargetSet.has(link.kind)) return false;
      if (options.section && link.section !== options.section) return false;
      if (options.itemName && link.itemName !== options.itemName) return false;
      if (options.relativePathPrefix && !relativePathMatchesPrefix(link.relativePath, options.relativePathPrefix)) return false;
      return true;
    });
  }

  const selectedSectionSet = new Set(options.sections ?? []);
  const selectedTargetSet = requestedTargetSet ?? new Set(normalizeAuditTargets(options.targets));
  return links.filter(
    (link) =>
      (link.kind === "local" || link.kind === "remote") &&
      selectedTargetSet.has(link.kind) &&
      (link.kind !== "local" || selectedSectionSet.has(link.section)) &&
      link.isMedia
  );
}

function filterCopyLinks(links: MediaLinkRow[], options: CopyOptions): MediaLinkRow[] {
  const requestedIds = options.linkIds?.length ? new Set(options.linkIds) : null;
  const sourceKind = options.direction === "to_local" ? "remote" : "local";
  const storagePolicy = options.direction === "to_local" ? "location_1" : "location_2";
  return links.filter((link) => {
    if (requestedIds && !requestedIds.has(link.id)) return false;
    if (link.kind !== sourceKind || link.storagePolicy !== storagePolicy || !link.isMedia || link.missingSince) return false;
    if (options.section && link.section !== options.section) return false;
    if (options.itemName && link.itemName !== options.itemName) return false;
    if (options.relativePathPrefix && !relativePathMatchesPrefix(link.relativePath, options.relativePathPrefix)) return false;
    return true;
  });
}

function copyDestinationKind(direction: CopyOptions["direction"]): StorageRootType {
  return direction === "to_local" ? "local" : "remote";
}

function copyStoragePolicy(direction: CopyOptions["direction"]): StoragePolicyKind {
  return direction === "to_local" ? "location_1" : "location_2";
}

function filterCopySelectedLinks(links: MediaLinkRow[], options: CopyOptions): MediaLinkRow[] {
  const requestedIds = options.linkIds?.length ? new Set(options.linkIds) : null;
  const sourceKind = options.direction === "to_local" ? "remote" : "local";
  const destinationKind = copyDestinationKind(options.direction);
  const storagePolicy = copyStoragePolicy(options.direction);
  return links.filter((link) => {
    if (requestedIds && !requestedIds.has(link.id)) return false;
    if ((link.kind !== sourceKind && link.kind !== destinationKind) || link.storagePolicy !== storagePolicy || !link.isMedia || link.missingSince) return false;
    if (options.section && link.section !== options.section) return false;
    if (options.itemName && link.itemName !== options.itemName) return false;
    if (options.relativePathPrefix && !relativePathMatchesPrefix(link.relativePath, options.relativePathPrefix)) return false;
    return true;
  });
}

function activeJobLinks(job: JobRecord, links: MediaLinkRow[]): MediaLinkRow[] {
  if (job.type === "scan") return filterScanLinks(links, jobProgressOptions<ScanOptions>(job) ?? defaultScanOptions);
  if (job.type === "copy") return filterCopyLinks(links, readCopyOptions(job));
  if (job.type === "audit") return filterAuditLinks(links, readAuditOptions(job));
  return [];
}

function overlappingLinkCount(first: MediaLinkRow[], second: MediaLinkRow[]): number {
  const secondIds = new Set(second.map((link) => link.id));
  return first.filter((link) => secondIds.has(link.id)).length;
}

async function assertNoActiveJobOverlap(db: Db, links: MediaLinkRow[], requestedLinks: MediaLinkRow[]): Promise<void> {
  if (requestedLinks.length === 0) return;
  const activeJobs = (await db.select().from(schema.jobs))
    .map(toJobRecord)
    .filter((job) => (job.type === "scan" || job.type === "copy" || job.type === "audit") && (job.status === "queued" || job.status === "running"));

  for (const job of activeJobs) {
    const overlapCount = overlappingLinkCount(requestedLinks, activeJobLinks(job, links));
    if (overlapCount > 0) {
      throw new Error(
        `Job #${job.id} is already ${job.status} for ${overlapCount} matching media item${overlapCount === 1 ? "" : "s"}. Wait for it to finish or terminate it before queuing another action.`
      );
    }
  }
}

function storageRootForDirection(paths: PathsSettings, direction: CopyOptions["direction"]): string {
  return direction === "to_local" ? paths.localDir : paths.remoteDir;
}

function copyDestinationPathForLink(link: MediaLinkRow, paths: PathsSettings, direction: CopyOptions["direction"]): string {
  const root = storageRootForDirection(paths, direction);
  const destinationPath = path.resolve(root, link.section, link.relativePath);
  if (!isPathInside(root, destinationPath)) throw new Error("Copy destination is outside configured storage root");
  return destinationPath;
}

function localTitleRoot(link: MediaLinkRow, paths: PathsSettings): string {
  const titleRoot = path.resolve(paths.localDir, link.section, link.itemName);
  if (!isPathInside(paths.localDir, titleRoot)) throw new Error("Local title path is outside configured local root");
  return titleRoot;
}

function relativeToRoot(root: string, filePath: string): string {
  return path.relative(root, filePath).replace(/\\/g, "/");
}

type LocalConflictSearchScope = { mode: "title" } | { mode: "episode"; key: string } | { mode: "exact" };

function sectionRelativePath(section: string, relativePath: string): string {
  const normalized = normalizedRelativePath(relativePath);
  const sectionPrefix = `${normalizedRelativePath(section)}/`;
  return normalized.startsWith(sectionPrefix) ? normalized.slice(sectionPrefix.length) : normalized;
}

function episodeKeyFromRelativePath(relativePath: string): string | null {
  const parts = normalizedRelativePath(relativePath).split("/").filter(Boolean);
  if (parts.length < 3) return null;
  const seasonFolder = parts[1]?.toLowerCase() ?? "";
  const fileName = parts.at(-1) ?? "";
  const seasonEpisode = fileName.match(/\bs(\d{1,3})e(\d{1,4})\b/i);
  if (seasonEpisode) return `${seasonFolder}:s${Number(seasonEpisode[1])}:e${Number(seasonEpisode[2])}`;
  const xEpisode = fileName.match(/\b(\d{1,3})x(\d{1,4})\b/i);
  if (xEpisode) return `${seasonFolder}:s${Number(xEpisode[1])}:e${Number(xEpisode[2])}`;
  return null;
}

function localConflictSearchScope(link: MediaLinkRow): LocalConflictSearchScope {
  const parts = normalizedRelativePath(link.relativePath).split("/").filter(Boolean);
  if (parts.length <= 2) return { mode: "title" };
  const episodeKey = episodeKeyFromRelativePath(link.relativePath);
  return episodeKey ? { mode: "episode", key: episodeKey } : { mode: "exact" };
}

function localConflictCandidateMatches(link: MediaLinkRow, scope: LocalConflictSearchScope, candidateRelativePath: string): boolean {
  if (scope.mode === "title") return true;
  if (scope.mode === "exact") return normalizedRelativePath(candidateRelativePath) === normalizedRelativePath(link.relativePath);
  return episodeKeyFromRelativePath(candidateRelativePath) === scope.key;
}

async function localFileCandidateFromPath(paths: PathsSettings, filePath: string, source: CopyLocalConflictCandidate["source"]): Promise<CopyLocalConflictCandidate | null> {
  const resolvedPath = path.resolve(filePath);
  if (!isPathInside(paths.localDir, resolvedPath)) return null;
  let stat;
  try {
    await assertExistingPathInside(paths.localDir, resolvedPath, "Local conflict candidate");
    stat = await withFilesystemTimeout(fs.stat(resolvedPath), `Local conflict candidate check for ${resolvedPath}`);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
  if (!stat?.isFile()) return null;
  return {
    filePath: resolvedPath,
    relativePath: relativeToRoot(paths.localDir, resolvedPath),
    sizeBytes: stat.size,
    source
  };
}

async function collectFilesystemLocalCandidates(
  paths: PathsSettings,
  root: string,
  destinationPath: string,
  matchesCandidate: (filePath: string) => boolean,
  maxCandidates = 100
): Promise<CopyLocalConflictCandidate[]> {
  const candidates: CopyLocalConflictCandidate[] = [];
  try {
    await assertExistingPathInside(paths.localDir, root, "Local title directory");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return candidates;
    throw error;
  }
  async function walk(dir: string): Promise<void> {
    if (candidates.length >= maxCandidates) return;
    let entries: Dirent[];
    try {
      entries = await withFilesystemTimeout(fs.readdir(dir, { withFileTypes: true }), `Local conflict scan for ${dir}`);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (candidates.length >= maxCandidates) return;
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(entryPath);
      } else if (entry.isFile() && isMediaFile(entryPath) && path.resolve(entryPath) !== path.resolve(destinationPath) && matchesCandidate(entryPath)) {
        const candidate = await localFileCandidateFromPath(paths, entryPath, "filesystem");
        if (candidate) candidates.push(candidate);
      }
    }
  }
  await walk(root);
  return candidates;
}

function addUniqueLocalCandidate(candidates: Map<string, CopyLocalConflictCandidate>, candidate: CopyLocalConflictCandidate | null): void {
  if (!candidate) return;
  const key = path.resolve(candidate.filePath);
  const existing = candidates.get(key);
  if (!existing || existing.source === "filesystem") candidates.set(key, candidate);
}

async function localConflictCandidatesForLink(db: Db, link: MediaLinkRow, paths: PathsSettings): Promise<CopyLocalConflictCandidate[]> {
  const destinationPath = copyDestinationPathForLink(link, paths, "to_local");
  const candidates = new Map<string, CopyLocalConflictCandidate>();
  const scope = localConflictSearchScope(link);

  addUniqueLocalCandidate(candidates, await localFileCandidateFromPath(paths, destinationPath, "destination"));

  for (const copySource of await db.select().from(schema.copySources).where(eq(schema.copySources.linkPath, link.linkPath))) {
    if (path.resolve(copySource.destinationPath) !== path.resolve(destinationPath)) {
      addUniqueLocalCandidate(candidates, await localFileCandidateFromPath(paths, copySource.destinationPath, "copy_history"));
    }
  }

  for (const file of await db
    .select()
    .from(schema.storageFiles)
    .where(and(eq(schema.storageFiles.rootType, "local"), eq(schema.storageFiles.section, link.section), eq(schema.storageFiles.itemName, link.itemName)))) {
    const candidateRelativePath = sectionRelativePath(link.section, file.relativePath);
    if (!file.missingSince && path.resolve(file.filePath) !== path.resolve(destinationPath) && localConflictCandidateMatches(link, scope, candidateRelativePath)) {
      addUniqueLocalCandidate(candidates, await localFileCandidateFromPath(paths, file.filePath, "inventory"));
    }
  }

  if (scope.mode !== "exact") {
    for (const candidate of await collectFilesystemLocalCandidates(paths, localTitleRoot(link, paths), destinationPath, (filePath) => {
      const candidateRelativePath = sectionRelativePath(link.section, relativeToRoot(paths.localDir, filePath));
      return localConflictCandidateMatches(link, scope, candidateRelativePath);
    })) {
      addUniqueLocalCandidate(candidates, candidate);
    }
  }

  return [...candidates.values()].sort((first, second) => first.relativePath.localeCompare(second.relativePath, undefined, { numeric: true, sensitivity: "base" }));
}

async function copyLocalConflictForLink(db: Db, link: MediaLinkRow, paths: PathsSettings): Promise<CopyLocalConflict | null> {
  const candidates = await localConflictCandidatesForLink(db, link, paths);
  if (candidates.length === 0) return null;
  return {
    linkId: link.id,
    section: link.section,
    itemName: link.itemName,
    relativePath: link.relativePath,
    linkPath: link.linkPath,
    destinationPath: copyDestinationPathForLink(link, paths, "to_local"),
    candidates
  };
}

async function previewCopyConflicts(db: Db, paths: PathsSettings, options: CopyOptions): Promise<CopyConflictPreview> {
  if (options.direction !== "to_local") return { conflicts: [], totalConflicts: 0, totalCandidates: 0 };
  const links = filterCopyLinks(await listMediaLinks(db), options);
  const conflicts: CopyLocalConflict[] = [];
  for (const link of links) {
    const conflict = await copyLocalConflictForLink(db, link, paths);
    if (conflict) conflicts.push(conflict);
  }
  return {
    conflicts,
    totalConflicts: conflicts.length,
    totalCandidates: conflicts.reduce((total, conflict) => total + conflict.candidates.length, 0)
  };
}

async function removeLocalConflictCandidates(db: Db, paths: PathsSettings, candidates: CopyLocalConflictCandidate[], preservedPath: string): Promise<string[]> {
  const timestamp = nowIso();
  const removed: string[] = [];
  const preserved = path.resolve(preservedPath);
  for (const candidate of candidates) {
    const candidatePath = path.resolve(candidate.filePath);
    if (candidatePath === preserved) continue;
    await assertExistingPathInside(paths.localDir, candidatePath, "Local replacement candidate");
    const stat = await fs.stat(candidatePath).catch(() => null);
    if (!stat?.isFile()) continue;
    await fs.rm(candidatePath, { force: true });
    await db.update(schema.storageFiles).set({ missingSince: timestamp, updatedAt: timestamp }).where(eq(schema.storageFiles.filePath, candidatePath));
    removed.push(candidatePath);
  }
  return removed;
}

type CopySourceRow = typeof schema.copySources.$inferSelect;
type CopyOperationRow = typeof schema.copyOperations.$inferSelect;

async function prepareCopyOperation(
  db: Db,
  jobId: number,
  link: MediaLinkRow,
  destinationPath: string,
  previousCopySource: CopySourceRow | null,
  localConflictStrategy: CopyLocalConflictStrategy | undefined
): Promise<CopyOperationRow> {
  const timestamp = nowIso();
  const row = await first(
    db
      .insert(schema.copyOperations)
      .values({
        jobId,
        mediaLinkId: link.id,
        linkPath: link.linkPath,
        sourcePath: link.targetPath,
        destinationPath,
        originalTargetPath: link.targetPath,
        originalLinkState: JSON.stringify(link),
        previousCopySource: previousCopySource ? JSON.stringify(previousCopySource) : null,
        tempPath: null,
        displacedPath: null,
        stage: "planned",
        resultStatus: null,
        localConflictStrategy: localConflictStrategy ?? null,
        sizeBytes: link.sizeBytes,
        errorMessage: null,
        createdAt: timestamp,
        updatedAt: timestamp,
        completedAt: null
      })
      .onConflictDoUpdate({
        target: [schema.copyOperations.jobId, schema.copyOperations.mediaLinkId],
        set: {
          linkPath: link.linkPath,
          sourcePath: link.targetPath,
          destinationPath,
          originalTargetPath: link.targetPath,
          originalLinkState: JSON.stringify(link),
          previousCopySource: previousCopySource ? JSON.stringify(previousCopySource) : null,
          tempPath: null,
          displacedPath: null,
          stage: "planned",
          resultStatus: null,
          localConflictStrategy: localConflictStrategy ?? null,
          sizeBytes: link.sizeBytes,
          errorMessage: null,
          updatedAt: timestamp,
          completedAt: null
        }
      })
      .returning()
  );
  if (!row) throw new Error("Copy operation journal entry was not created");
  return row;
}

async function updateCopyOperation(db: Db, operationId: number, update: CopyOperationUpdate): Promise<void> {
  await db
    .update(schema.copyOperations)
    .set({
      stage: update.stage,
      ...(update.tempPath !== undefined ? { tempPath: update.tempPath } : {}),
      ...(update.displacedPath !== undefined ? { displacedPath: update.displacedPath } : {}),
      ...(update.sizeBytes !== undefined ? { sizeBytes: update.sizeBytes } : {}),
      ...(update.resultStatus !== undefined ? { resultStatus: update.resultStatus } : {}),
      updatedAt: nowIso()
    })
    .where(eq(schema.copyOperations.id, operationId));
}

async function commitCopyOperation(db: Db, operationId: number, link: MediaLinkRow, result: CopyMediaResult): Promise<void> {
  const timestamp = nowIso();
  await db.transaction(async (transaction) => {
    await transaction
      .insert(schema.copySources)
      .values({ destinationPath: result.destinationPath, sourcePath: result.sourcePath, linkPath: result.linkPath, recordedAt: timestamp })
      .onConflictDoUpdate({
        target: schema.copySources.destinationPath,
        set: { sourcePath: result.sourcePath, linkPath: result.linkPath, recordedAt: timestamp }
      });
    await transaction
      .update(schema.mediaLinks)
      .set({
        targetPath: result.destinationPath,
        kind: result.destinationRootType,
        targetExists: true,
        sizeBytes: result.sizeBytes,
        updatedAt: timestamp
      })
      .where(eq(schema.mediaLinks.id, link.id));
    await transaction
      .update(schema.copyOperations)
      .set({
        stage: "committed",
        resultStatus: result.status,
        sizeBytes: result.sizeBytes,
        tempPath: null,
        errorMessage: null,
        updatedAt: timestamp,
        completedAt: timestamp
      })
      .where(eq(schema.copyOperations.id, operationId));
  });
}

async function failCopyOperation(db: Db, operationId: number, message: string): Promise<void> {
  await db
    .update(schema.copyOperations)
    .set({ stage: "failed", errorMessage: message, updatedAt: nowIso(), completedAt: nowIso() })
    .where(eq(schema.copyOperations.id, operationId));
}

async function completeCopyOperationWithoutMutation(db: Db, operationId: number, result: CopyMediaResult): Promise<void> {
  const timestamp = nowIso();
  await db
    .update(schema.copyOperations)
    .set({
      stage: "committed",
      resultStatus: result.status,
      sizeBytes: result.sizeBytes,
      tempPath: null,
      errorMessage: null,
      updatedAt: timestamp,
      completedAt: timestamp
    })
    .where(eq(schema.copyOperations.id, operationId));
}

interface CopyRollbackEntry {
  link: MediaLinkRow;
  result: CopyMediaResult;
  previousCopySource: CopySourceRow | null;
}

async function currentSymlinkTarget(linkPath: string): Promise<string | null> {
  try {
    const stat = await fs.lstat(linkPath);
    if (!stat.isSymbolicLink()) return null;
    const rawTarget = await fs.readlink(linkPath);
    return path.resolve(path.dirname(linkPath), rawTarget);
  } catch {
    return null;
  }
}

function copyOperationLink(operation: CopyOperationRow): MediaLinkRow {
  const value = parseJson(operation.originalLinkState);
  if (!isRecord(value)) throw new Error(`Copy operation #${operation.id} has invalid original link state`);
  const kind = value.kind;
  const storagePolicy = value.storagePolicy;
  if (kind !== "local" && kind !== "remote" && kind !== "broken" && kind !== "other" && kind !== "non_media") {
    throw new Error(`Copy operation #${operation.id} has an invalid original link kind`);
  }
  if (storagePolicy !== "unassigned" && storagePolicy !== "location_1" && storagePolicy !== "location_2") {
    throw new Error(`Copy operation #${operation.id} has an invalid original storage policy`);
  }
  const { section, itemName, relativePath, linkPath, targetPath } = value;
  if (typeof section !== "string" || typeof itemName !== "string" || typeof relativePath !== "string" || typeof linkPath !== "string" || typeof targetPath !== "string") {
    throw new Error(`Copy operation #${operation.id} is missing required path metadata`);
  }
  if (!Number.isInteger(value.id) || typeof value.targetExists !== "boolean" || typeof value.isMedia !== "boolean") {
    throw new Error(`Copy operation #${operation.id} has incomplete original link state`);
  }
  return {
    id: Number(value.id),
    section,
    itemName,
    relativePath,
    linkPath,
    targetPath,
    kind,
    targetExists: value.targetExists,
    isMedia: value.isMedia,
    storagePolicy,
    resolvedStorageFileId: Number.isInteger(value.resolvedStorageFileId) ? Number(value.resolvedStorageFileId) : null,
    sizeBytes: typeof value.sizeBytes === "number" && Number.isFinite(value.sizeBytes) ? value.sizeBytes : null,
    firstSeenAt: typeof value.firstSeenAt === "string" ? value.firstSeenAt : "",
    lastSeenAt: typeof value.lastSeenAt === "string" ? value.lastSeenAt : "",
    lastChangedAt: typeof value.lastChangedAt === "string" ? value.lastChangedAt : "",
    missingSince: typeof value.missingSince === "string" ? value.missingSince : null,
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : ""
  };
}

function copyOperationPreviousSource(operation: CopyOperationRow): CopySourceRow | null {
  if (!operation.previousCopySource) return null;
  const value = parseJson(operation.previousCopySource);
  if (
    !isRecord(value) ||
    !Number.isInteger(value.id) ||
    typeof value.destinationPath !== "string" ||
    typeof value.sourcePath !== "string" ||
    typeof value.linkPath !== "string" ||
    typeof value.recordedAt !== "string"
  ) {
    throw new Error(`Copy operation #${operation.id} has invalid previous copy-source state`);
  }
  return {
    id: Number(value.id),
    destinationPath: value.destinationPath,
    sourcePath: value.sourcePath,
    linkPath: value.linkPath,
    recordedAt: value.recordedAt
  };
}

function copyOperationDestinationRoot(operation: CopyOperationRow, paths: PathsSettings): StorageRootType {
  if (isPathInside(paths.localDir, operation.destinationPath)) return "local";
  if (isPathInside(paths.remoteDir, operation.destinationPath)) return "remote";
  throw new Error(`Copy operation #${operation.id} destination is outside configured roots`);
}

function copyOperationResult(operation: CopyOperationRow, paths: PathsSettings, sizeBytes: number): CopyMediaResult {
  const destinationRootType = copyOperationDestinationRoot(operation, paths);
  const sourceRootType: StorageRootType = destinationRootType === "local" ? "remote" : "local";
  const direction: CopyDirection = destinationRootType === "local" ? "to_local" : "to_remote";
  const status =
    operation.resultStatus === "copied" || operation.resultStatus === "repointed"
      ? operation.resultStatus
      : operation.stage === "planned"
        ? "repointed"
        : "copied";
  return {
    status,
    direction,
    sourceRootType,
    destinationRootType,
    sourcePath: operation.sourcePath,
    destinationPath: operation.destinationPath,
    linkPath: operation.linkPath,
    sizeBytes,
    message: "Recovered durable copy operation"
  };
}

async function replaceSymlinkTarget(linkRoot: string, linkPath: string, targetPath: string): Promise<void> {
  await assertPathParentInside(linkRoot, linkPath, "Symlink path");
  const tempLink = `${linkPath}.srtl-rollback-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  try {
    await fs.symlink(targetPath, tempLink);
    const rawTarget = await fs.readlink(tempLink);
    const actualTarget = path.resolve(path.dirname(tempLink), rawTarget);
    if (actualTarget !== path.resolve(targetPath)) throw new Error("Rollback symlink target validation failed");
    await assertPathParentInside(linkRoot, linkPath, "Symlink path");
    await fs.rename(tempLink, linkPath);
  } catch (error) {
    await fs.rm(tempLink, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function restoreCopySource(db: Db, entry: CopyRollbackEntry): Promise<void> {
  if (entry.previousCopySource) {
    await db
      .insert(schema.copySources)
      .values({
        destinationPath: entry.previousCopySource.destinationPath,
        sourcePath: entry.previousCopySource.sourcePath,
        linkPath: entry.previousCopySource.linkPath,
        recordedAt: entry.previousCopySource.recordedAt
      })
      .onConflictDoUpdate({
        target: schema.copySources.destinationPath,
        set: {
          sourcePath: entry.previousCopySource.sourcePath,
          linkPath: entry.previousCopySource.linkPath,
          recordedAt: entry.previousCopySource.recordedAt
        }
      });
    return;
  }
  await db.delete(schema.copySources).where(eq(schema.copySources.destinationPath, entry.result.destinationPath));
}

async function rollbackCopiedMediaLink(db: Db, entry: CopyRollbackEntry, paths: PathsSettings): Promise<{ rolledBack: boolean; warning?: string }> {
  const currentTarget = await currentSymlinkTarget(entry.link.linkPath);
  if (currentTarget !== path.resolve(entry.result.destinationPath)) {
    return {
      rolledBack: false,
      warning: `Skipped rollback for ${entry.link.linkPath}; symlink no longer points to the job destination`
    };
  }

  const originalRoot = entry.link.kind === "local" ? paths.localDir : entry.link.kind === "remote" ? paths.remoteDir : null;
  if (!originalRoot) return { rolledBack: false, warning: `Skipped rollback for ${entry.link.linkPath}; original target root is unknown` };
  await assertExistingPathInside(originalRoot, entry.link.targetPath, "Original copy source");
  await assertDestinationPathInside(entry.result.destinationRootType === "local" ? paths.localDir : paths.remoteDir, entry.result.destinationPath, "Copy destination");
  await replaceSymlinkTarget(paths.symlinkDir, entry.link.linkPath, entry.link.targetPath);
  await db
    .update(schema.mediaLinks)
    .set({
      targetPath: entry.link.targetPath,
      kind: entry.link.kind,
      targetExists: entry.link.targetExists,
      resolvedStorageFileId: entry.link.resolvedStorageFileId,
      sizeBytes: entry.link.sizeBytes,
      updatedAt: nowIso()
    })
    .where(eq(schema.mediaLinks.id, entry.link.id));
  await restoreCopySource(db, entry);

  if (entry.result.status === "copied") {
    try {
      const stat = await fs.stat(entry.result.destinationPath);
      if (stat.isFile() && stat.size === entry.result.sizeBytes) {
        await assertExistingPathInside(entry.result.destinationRootType === "local" ? paths.localDir : paths.remoteDir, entry.result.destinationPath, "Copy destination");
        await fs.rm(entry.result.destinationPath, { force: true });
      } else {
        return {
          rolledBack: true,
          warning: `Restored symlink for ${entry.link.linkPath}, but left ${entry.result.destinationPath} because it changed after copy`
        };
      }
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
    }
  }

  return { rolledBack: true };
}

async function removeJournalFile(root: string, filePath: string | null, expectedSize: number | null, label: string): Promise<void> {
  if (!filePath) return;
  try {
    await assertExistingPathInside(root, filePath, label);
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) throw new Error(`${label} is not a regular file`);
    if (expectedSize != null && stat.size !== expectedSize) throw new Error(`${label} changed size after it was journaled`);
    await fs.rm(filePath, { force: true });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
}

async function reconcileCopyOperationsForJob(
  db: Db,
  jobId: number,
  paths: PathsSettings,
  event: JobContext["event"]
): Promise<void> {
  const terminalStages = new Set(["committed", "rolled_back", "failed", "reconciliation_required"]);
  const operations = (await db.select().from(schema.copyOperations).where(eq(schema.copyOperations.jobId, jobId))).filter(
    (operation) => !terminalStages.has(operation.stage)
  );

  for (const operation of operations) {
    try {
      const destinationRootType = copyOperationDestinationRoot(operation, paths);
      const destinationRoot = destinationRootType === "local" ? paths.localDir : paths.remoteDir;
      const currentTarget = await currentSymlinkTarget(operation.linkPath);
      const resolvedDestination = path.resolve(operation.destinationPath);
      const resolvedOriginal = path.resolve(operation.originalTargetPath);

      if (currentTarget === resolvedDestination) {
        await assertExistingPathInside(destinationRoot, operation.destinationPath, "Recovered copy destination");
        const stat = await fs.stat(operation.destinationPath);
        if (!stat.isFile()) throw new Error("Recovered copy destination is not a regular file");
        if (operation.sizeBytes != null && stat.size !== operation.sizeBytes) throw new Error("Recovered copy destination changed size");
        const link = copyOperationLink(operation);
        const result = copyOperationResult(operation, paths, stat.size);
        await commitCopyOperation(db, operation.id, link, result);
        await removeJournalFile(destinationRoot, operation.tempPath, operation.sizeBytes, "Temporary copy");
        if (operation.displacedPath && operation.localConflictStrategy === "replace") {
          await removeJournalFile(destinationRoot, operation.displacedPath, null, "Displaced destination");
        }
        await event("warn", "Recovered copy operation after worker interruption", {
          operationId: operation.id,
          linkPath: operation.linkPath,
          destinationPath: operation.destinationPath,
          resolution: "committed"
        });
        continue;
      }

      if (currentTarget === resolvedOriginal) {
        await removeJournalFile(destinationRoot, operation.tempPath, operation.sizeBytes, "Temporary copy");
        if (operation.stage === "promoted" || operation.stage === "repointed") {
          await removeJournalFile(destinationRoot, operation.destinationPath, operation.sizeBytes, "Uncommitted promoted copy");
        }
        if (operation.displacedPath) {
          const destinationExistsNow = await fs.stat(operation.destinationPath).then(() => true).catch((error: unknown) => {
            if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return false;
            throw error;
          });
          if (destinationExistsNow) throw new Error("Cannot restore displaced destination because its original path is occupied");
          await assertExistingPathInside(destinationRoot, operation.displacedPath, "Displaced destination");
          await assertDestinationPathInside(destinationRoot, operation.destinationPath, "Destination restore path");
          await fs.rename(operation.displacedPath, operation.destinationPath);
        }
        const timestamp = nowIso();
        await db
          .update(schema.copyOperations)
          .set({ stage: "rolled_back", tempPath: null, displacedPath: null, errorMessage: null, updatedAt: timestamp, completedAt: timestamp })
          .where(eq(schema.copyOperations.id, operation.id));
        await event("warn", "Rolled back incomplete copy operation after worker interruption", {
          operationId: operation.id,
          linkPath: operation.linkPath,
          resolution: "rolled_back"
        });
        continue;
      }

      throw new Error("Symlink no longer points to either the original target or the journaled destination");
    } catch (error: unknown) {
      const message = errorMessage(error);
      await db
        .update(schema.copyOperations)
        .set({ stage: "reconciliation_required", errorMessage: message, updatedAt: nowIso() })
        .where(eq(schema.copyOperations.id, operation.id));
      await event("error", "Copy operation requires manual reconciliation", {
        operationId: operation.id,
        linkPath: operation.linkPath,
        destinationPath: operation.destinationPath,
        error: message
      });
      throw new Error(`Copy operation #${operation.id} requires manual reconciliation: ${message}`, { cause: error });
    }
  }
}

async function rollbackDurableCopyOperations(
  db: Db,
  jobId: number,
  paths: PathsSettings,
  event: JobContext["event"]
): Promise<{ rolledBack: number; warnings: string[] }> {
  await reconcileCopyOperationsForJob(db, jobId, paths, event);
  const operations = (await db.select().from(schema.copyOperations).where(and(eq(schema.copyOperations.jobId, jobId), eq(schema.copyOperations.stage, "committed")))).reverse();
  let rolledBack = 0;
  const warnings: string[] = [];

  for (const operation of operations) {
    if (operation.resultStatus !== "copied" && operation.resultStatus !== "repointed") {
      await db
        .update(schema.copyOperations)
        .set({ stage: "rolled_back", updatedAt: nowIso(), completedAt: nowIso() })
        .where(eq(schema.copyOperations.id, operation.id));
      continue;
    }
    try {
      const link = copyOperationLink(operation);
      const result = copyOperationResult(operation, paths, operation.sizeBytes ?? link.sizeBytes ?? 0);
      const rollback = await rollbackCopiedMediaLink(
        db,
        { link, result, previousCopySource: copyOperationPreviousSource(operation) },
        paths
      );
      if (rollback.rolledBack) {
        rolledBack += 1;
        await db
          .update(schema.copyOperations)
          .set({ stage: "rolled_back", errorMessage: null, updatedAt: nowIso(), completedAt: nowIso() })
          .where(eq(schema.copyOperations.id, operation.id));
      }
      if (rollback.warning) warnings.push(rollback.warning);
    } catch (error: unknown) {
      const warning = `Rollback failed for ${operation.linkPath}: ${errorMessage(error)}`;
      warnings.push(warning);
      await db
        .update(schema.copyOperations)
        .set({ stage: "reconciliation_required", errorMessage: warning, updatedAt: nowIso() })
        .where(eq(schema.copyOperations.id, operation.id));
    }
  }
  return { rolledBack, warnings };
}

function copyProgressPayload({
  options,
  current,
  total,
  copied,
  repointed,
  skipped,
  conflicts,
  failed,
  alreadyCompleted = 0,
  remaining,
  stage,
  message,
  link,
  update
}: {
  options: CopyOptions;
  current: number;
  total: number;
  copied: number;
  repointed: number;
  skipped: number;
  conflicts: number;
  failed: number;
  alreadyCompleted?: number;
  remaining?: number;
  stage: CopyProgressStage;
  message: string;
  link?: MediaLinkRow;
  update?: Partial<CopyProgressUpdate>;
}): Record<string, unknown> {
  const hasByteProgress = stage === "copying" || stage === "verifying";
  return {
    options,
    current,
    total,
    copied,
    repointed,
    skipped,
    conflicts,
    failed,
    alreadyCompleted,
    remaining: remaining ?? Math.max(0, total - current),
    stage,
    message,
    currentTitle: link?.itemName ?? null,
    currentFile: link?.relativePath ?? null,
    sourcePath: update?.sourcePath ?? link?.targetPath ?? null,
    destinationPath: update?.destinationPath ?? null,
    linkPath: update?.linkPath ?? link?.linkPath ?? null,
    sizeBytes: update?.sizeBytes ?? link?.sizeBytes ?? null,
    bytesCopied: stage === "copying" ? (update?.bytesCopied ?? update?.bytesProcessed ?? null) : null,
    bytesProcessed: hasByteProgress ? (update?.bytesProcessed ?? update?.bytesCopied ?? null) : null,
    totalBytes: hasByteProgress ? (update?.totalBytes ?? update?.sizeBytes ?? link?.sizeBytes ?? null) : null,
    bytesPerSecond: hasByteProgress ? (update?.bytesPerSecond ?? null) : null,
    remainingSeconds: hasByteProgress ? (update?.remainingSeconds ?? null) : null,
    updatedAt: nowIso()
  };
}

type SuccessfulCopyOutcome = "copied" | "repointed" | "skipped";

const successfulCopyOutcomeMessages = new Map<string, SuccessfulCopyOutcome>([
  ["Verified copy installed", "copied"],
  ["Copy installed without verification", "copied"],
  ["Symlink repointed to existing verified file", "repointed"],
  ["Copy skipped", "skipped"]
]);

interface CopyResumeState {
  copied: number;
  repointed: number;
  skipped: number;
  alreadyCompleted: number;
  startedTotal: number | null;
}

function copyLinkEventKey(value: unknown): string | null {
  if (!isRecord(value)) return null;
  if (typeof value.linkPath === "string" && value.linkPath.trim()) return `path:${path.resolve(value.linkPath)}`;
  if (Number.isInteger(value.linkId) && Number(value.linkId) > 0) return `id:${Number(value.linkId)}`;
  return null;
}

function copyLinkRowKey(link: MediaLinkRow): string {
  return `path:${path.resolve(link.linkPath)}`;
}

async function readCopyResumeState(db: Db, jobId: number, selectedLinks: MediaLinkRow[], destinationKind: StorageRootType, includeUntrackedCompleted: boolean): Promise<CopyResumeState> {
  const selectedKeys = new Set(selectedLinks.flatMap((link) => [copyLinkRowKey(link), `id:${link.id}`]));
  const destinationLinks = selectedLinks.filter((link) => link.kind === destinationKind);
  const outcomes = new Map<string, SuccessfulCopyOutcome>();
  let startedTotal: number | null = null;
  const rows = await db
    .select({ message: schema.jobEvents.message, data: schema.jobEvents.data })
    .from(schema.jobEvents)
    .where(eq(schema.jobEvents.jobId, jobId))
    .orderBy(asc(schema.jobEvents.id));

  for (const row of rows) {
    const data = parseJson(row.data);
    if (row.message === "Copy job started" && startedTotal === null && isRecord(data) && Number.isInteger(data.total) && Number(data.total) >= 0) {
      startedTotal = Number(data.total);
    }
    const outcome = successfulCopyOutcomeMessages.get(row.message);
    if (!outcome) continue;
    const key = copyLinkEventKey(data);
    if (key && selectedKeys.has(key)) outcomes.set(key, outcome);
  }

  for (const operation of await db.select().from(schema.copyOperations).where(and(eq(schema.copyOperations.jobId, jobId), eq(schema.copyOperations.stage, "committed")))) {
    if (operation.resultStatus === "copied" || operation.resultStatus === "repointed" || operation.resultStatus === "skipped") {
      outcomes.set(`id:${operation.mediaLinkId}`, operation.resultStatus);
      outcomes.set(`path:${path.resolve(operation.linkPath)}`, operation.resultStatus);
    }
  }

  let copied = 0;
  let repointed = 0;
  let skipped = 0;
  let alreadyCompleted = 0;
  for (const link of destinationLinks) {
    const outcome = outcomes.get(copyLinkRowKey(link)) ?? outcomes.get(`id:${link.id}`);
    if (outcome === "copied") copied += 1;
    else if (outcome === "repointed") repointed += 1;
    else if (outcome === "skipped") skipped += 1;
    else if (includeUntrackedCompleted) {
      skipped += 1;
      alreadyCompleted += 1;
    }
  }

  return { copied, repointed, skipped, alreadyCompleted, startedTotal };
}

function toJobRecord(row: JobRow): JobRecord {
  const progress = parseJson(row.progress);
  const normalizedProgress = normalizeJobProgress(row.type, row.status, progress);
  const status = normalizeJobStatus(row.type, row.status, progress);
  return {
    ...row,
    type: row.type as JobRecord["type"],
    status,
    progress: normalizedProgress
  };
}

function normalizeJobStatus(type: string, status: string, progress: unknown): JobStatus {
  if (!isPartiallyFailedCopyProgress(type, status, progress)) return status as JobStatus;
  return "partially_failed";
}

function normalizeJobProgress(type: string, status: string, progress: unknown): unknown {
  if (!isPartiallyFailedCopyProgress(type, status, progress) || !isRecord(progress)) return progress;
  const message = typeof progress.message === "string" ? progress.message.replace("Copy job failed:", "Copy job partially failed:") : progress.message;
  return {
    ...progress,
    stage: progress.stage === "failed" || progress.stage === "partial_failed" ? "partially_failed" : progress.stage,
    message
  };
}

function isPartiallyFailedCopyProgress(type: string, status: string, progress: unknown): boolean {
  if (type !== "copy" || status !== "failed" || !isRecord(progress)) return false;
  const failed = finiteNumberFromRecord(progress, "failed");
  const completed =
    finiteNumberFromRecord(progress, "copied") +
    finiteNumberFromRecord(progress, "repointed") +
    finiteNumberFromRecord(progress, "skipped") +
    finiteNumberFromRecord(progress, "conflicts") +
    finiteNumberFromRecord(progress, "alreadyCompleted");
  return failed > 0 && completed > 0;
}

function isStaleRunningJob(job: Pick<JobRecord, "createdAt" | "startedAt" | "heartbeatAt">, staleAfterMs: number): boolean {
  const referenceAt = Date.parse(job.heartbeatAt ?? job.startedAt ?? job.createdAt);
  return Number.isFinite(referenceAt) && Date.now() - referenceAt >= staleAfterMs;
}

async function addEvent(db: Db, jobId: number, level: JobEventRecord["level"], message: string, data: unknown = {}): Promise<void> {
  await db.insert(schema.jobEvents).values({ jobId, timestamp: nowIso(), level, message, data: JSON.stringify(data) });
}

async function setProgress(db: Db, jobId: number, progress: unknown): Promise<void> {
  await db.update(schema.jobs).set({ progress: JSON.stringify(progress) }).where(eq(schema.jobs.id, jobId));
}

export class JobRunner {
  constructor(private readonly db: Db) {}

  async createJob(type: JobRecord["type"], progress: unknown = {}): Promise<number> {
    if (type !== "path_migration" && (await isPathConfigurationBlocked(this.db))) {
      throw new Error("Managed storage paths changed. Resolve the required path migration before starting another job.");
    }
    const row = await first(this.db
      .insert(schema.jobs)
      .values({
        type,
        status: "queued",
        createdAt: nowIso(),
        startedAt: null,
        finishedAt: null,
        lockedBy: null,
        lockedAt: null,
        heartbeatAt: null,
        cancelRequestedAt: null,
        progress: JSON.stringify(progress)
      })
      .returning({ id: schema.jobs.id }));
    if (!row) throw new Error("Job was not queued");
    await addEvent(this.db, row.id, "info", "Job queued", { type });
    return row.id;
  }

  async listJobs(options: JobListOptions = {}): Promise<JobRecord[]> {
    const limit = Math.min(Math.max(options.limit ?? 500, 1), 1000);
    const activeStatuses: JobStatus[] = ["queued", "running"];
    const terminalStatuses: JobStatus[] = ["completed", "partially_failed", "failed", "cancelled"];
    const activeRows = await this.db.select().from(schema.jobs).where(inArray(schema.jobs.status, activeStatuses)).orderBy(desc(schema.jobs.id));
    if (options.activeOnly) return activeRows.map(toJobRecord);

    const terminalRows = options.completedSince
      ? await this.db
          .select()
          .from(schema.jobs)
          .where(and(inArray(schema.jobs.status, terminalStatuses), gte(schema.jobs.finishedAt, options.completedSince)))
          .orderBy(desc(schema.jobs.id))
          .limit(limit)
      : await this.db
          .select()
          .from(schema.jobs)
          .where(inArray(schema.jobs.status, terminalStatuses))
          .orderBy(desc(schema.jobs.id))
          .limit(limit);
    return [...activeRows, ...terminalRows].sort((a, b) => b.id - a.id).map(toJobRecord);
  }

  async getJob(jobId: number): Promise<JobRecord | null> {
    const row = await first(this.db.select().from(schema.jobs).where(eq(schema.jobs.id, jobId)).limit(1));
    return row ? toJobRecord(row) : null;
  }

  async listEvents(jobId: number, afterId = 0, limit = 100): Promise<JobEventRecord[]> {
    const boundedLimit = Math.min(Math.max(limit, 1), 500);
    const rows = afterId > 0
      ? await this.db
          .select()
          .from(schema.jobEvents)
          .where(and(eq(schema.jobEvents.jobId, jobId), gt(schema.jobEvents.id, afterId)))
          .orderBy(asc(schema.jobEvents.id))
          .limit(boundedLimit)
      : (await this.db
          .select()
          .from(schema.jobEvents)
          .where(eq(schema.jobEvents.jobId, jobId))
          .orderBy(desc(schema.jobEvents.id))
          .limit(boundedLimit))
          .reverse();
    return rows.map((row) => ({ ...row, level: row.level as JobEventRecord["level"], timestamp: row.timestamp, data: parseJson(row.data) }));
  }

  async listEventPage(jobId: number, beforeId: number | undefined, limit = 100): Promise<JobEventPage> {
    const boundedLimit = Math.min(Math.max(limit, 1), 500);
    const where = beforeId
      ? and(eq(schema.jobEvents.jobId, jobId), lt(schema.jobEvents.id, beforeId))
      : eq(schema.jobEvents.jobId, jobId);
    const rows = await this.db
      .select()
      .from(schema.jobEvents)
      .where(where)
      .orderBy(desc(schema.jobEvents.id))
      .limit(boundedLimit + 1);
    const totalRow = await first(this.db.select({ value: count() }).from(schema.jobEvents).where(eq(schema.jobEvents.jobId, jobId)).limit(1));
    const hasOlder = rows.length > boundedLimit;
    const pageRows = rows.slice(0, boundedLimit).reverse();
    return {
      events: pageRows.map((row) => ({ ...row, level: row.level as JobEventRecord["level"], timestamp: row.timestamp, data: parseJson(row.data) })),
      total: Number(totalRow?.value ?? 0),
      hasOlder
    };
  }

  async terminate(jobId: number): Promise<boolean> {
    const job = await this.getJob(jobId);
    if (!job) return false;
    const timestamp = nowIso();
    if (job.status === "queued") {
      await this.db
        .update(schema.jobs)
        .set({ status: "cancelled", finishedAt: timestamp, cancelRequestedAt: timestamp })
        .where(eq(schema.jobs.id, jobId));
      if (job.type === "path_migration" && isRecord(job.progress) && Number.isInteger(job.progress.migrationId)) {
        await this.db
          .update(schema.pathMigrations)
          .set({ status: "failed", finishedAt: timestamp, errorMessage: "Path migration was terminated before it started. Analyze the path change again or restore the previous environment paths." })
          .where(and(eq(schema.pathMigrations.id, Number(job.progress.migrationId)), eq(schema.pathMigrations.status, "queued")));
      }
      await addEvent(this.db, jobId, "warn", "Queued job terminated");
      return true;
    }
    if (job.status === "running") {
      await this.db.update(schema.jobs).set({ cancelRequestedAt: timestamp }).where(eq(schema.jobs.id, jobId));
      await addEvent(this.db, jobId, "warn", "Termination requested");
      return true;
    }
    return false;
  }

  async cancel(jobId: number): Promise<boolean> {
    return this.terminate(jobId);
  }

  async startScan(options: ScanOptions = defaultScanOptions): Promise<number> {
    const normalizedOptions = await normalizeScanOptions(this.db, options);
    const links = await listMediaLinks(this.db, undefined, "current");
    const scanLinks = filterScanLinks(links, normalizedOptions);
    if (normalizedOptions.titleScopes?.length) {
      const availableScopes = new Set(scanLinks.map((link) => `${link.section}\0${link.itemName}`));
      const unavailableScopes = normalizedOptions.titleScopes.filter((scope) => !availableScopes.has(`${scope.section}\0${scope.itemName}`));
      if (unavailableScopes.length > 0) {
        throw new Error(`Title is not available in the current symlink inventory: ${unavailableScopes.map((scope) => scope.itemName).join(", ")}`);
      }
    }
    await assertNoActiveJobOverlap(this.db, links, scanLinks);
    return this.createJob("scan", { options: normalizedOptions });
  }

  async startAudit(input: AuditMode | AuditOptions): Promise<number> {
    const normalizedOptions = await normalizeAuditOptions(this.db, input);
    const advancedSettings = normalizeAdvancedSettings(await getJsonSetting<unknown>(this.db, "advancedSettings", {}));
    const requestedOptions: Partial<AuditOptions> = typeof input === "string" ? {} : input;
    const optionsWithDefaults: AuditOptions = {
      ...normalizedOptions,
      ...(requestedOptions.byteCompare === undefined && !advancedSettings.audit.byteCompareWhenSourceKnown ? { byteCompare: false } : {})
    };
    const links = await listMediaLinks(this.db, undefined, "current");
    await assertNoActiveJobOverlap(this.db, links, filterAuditLinks(links, optionsWithDefaults));
    return this.createJob("audit", { options: optionsWithDefaults });
  }

  async startCopy(input: CopyOptions): Promise<number> {
    const normalizedOptions = await normalizeCopyOptions(this.db, input);
    const links = await listMediaLinks(this.db, undefined, "current");
    const copyLinks = filterCopyLinks(links, normalizedOptions);
    await assertNoActiveJobOverlap(this.db, links, copyLinks);
    const requestedOrder = normalizedOptions.linkIds?.length ? new Map(normalizedOptions.linkIds.map((id, index) => [id, index])) : null;
    const orderedCopyLinks = requestedOrder ? [...copyLinks].sort((firstLink, secondLink) => (requestedOrder.get(firstLink.id) ?? 0) - (requestedOrder.get(secondLink.id) ?? 0)) : copyLinks;
    const optionsWithResolvedLinks = orderedCopyLinks.length > 0 ? { ...normalizedOptions, linkIds: orderedCopyLinks.map((link) => link.id) } : normalizedOptions;
    return this.createJob("copy", { options: optionsWithResolvedLinks });
  }

  async previewCopyConflicts(input: CopyOptions): Promise<CopyConflictPreview> {
    if (await isPathConfigurationBlocked(this.db)) {
      throw new Error("Managed storage paths changed. Resolve the required path migration before previewing copy work.");
    }
    const normalizedOptions = await normalizeCopyOptions(this.db, input);
    const paths = await getJsonSetting<PathsSettings>(this.db, "paths", { symlinkDir: "", localDir: "", remoteDir: "" });
    if (!paths.localDir || !paths.remoteDir) throw new Error("Path settings are incomplete");
    return previewCopyConflicts(this.db, paths, normalizedOptions);
  }

  async startPathMigration(migrationId: number): Promise<number> {
    await assertPathMigrationReady(this.db, migrationId);
    const jobId = await this.db.transaction(async (transaction) => {
      const row = await first(
        transaction
          .insert(schema.jobs)
          .values({
            type: "path_migration",
            status: "queued",
            createdAt: nowIso(),
            startedAt: null,
            finishedAt: null,
            lockedBy: null,
            lockedAt: null,
            heartbeatAt: null,
            cancelRequestedAt: null,
            progress: JSON.stringify({ migrationId, stage: "queued", current: 0, total: 0, message: "Path migration queued" })
          })
          .returning({ id: schema.jobs.id })
      );
      if (!row) throw new Error("Path migration job was not queued");
      const migration = await first(
        transaction
          .update(schema.pathMigrations)
          .set({ status: "queued", jobId: row.id, errorMessage: null, finishedAt: null })
          .where(and(eq(schema.pathMigrations.id, migrationId), eq(schema.pathMigrations.status, "planned")))
          .returning({ id: schema.pathMigrations.id })
      );
      if (!migration) throw new Error("Path migration is no longer ready to start");
      await transaction.insert(schema.jobEvents).values({ jobId: row.id, timestamp: nowIso(), level: "info", message: "Job queued", data: JSON.stringify({ type: "path_migration", migrationId }) });
      return row.id;
    });
    return jobId;
  }
}

export class JobWorker {
  private readonly queue: JobRunner;
  private readonly workerId: string;
  private readonly pollIntervalMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly reclaimStaleAfterMs: number;
  private readonly reclaimOwnInterruptedAfterMs: number;
  private readonly logger: Pick<Console, "info" | "warn" | "error">;
  private readonly copyRunner: CopyCommandRunner;
  private readonly auditRunner: AuditCommandRunner;
  private readonly concurrency: JobConcurrencySettings;
  private readonly activeAbortControllers = new Map<number, AbortController>();
  private stopped = true;
  private sleepTimer: NodeJS.Timeout | null = null;
  private resolveSleep: (() => void) | null = null;

  constructor(private readonly db: Db, options: JobWorkerOptions = {}) {
    this.queue = new JobRunner(db);
    this.workerId = options.workerId ?? `worker-${process.pid}`;
    this.pollIntervalMs = options.pollIntervalMs ?? 2000;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 10_000;
    this.reclaimStaleAfterMs = options.reclaimStaleAfterMs ?? 15 * 60_000;
    this.reclaimOwnInterruptedAfterMs = options.reclaimOwnInterruptedAfterMs ?? Math.max(30_000, this.heartbeatIntervalMs * 2);
    this.logger = options.logger ?? console;
    this.copyRunner = options.copyRunner ?? defaultCopyRunner;
    this.auditRunner = options.auditRunner ?? defaultAuditRunner;
    this.concurrency = options.concurrency ?? defaultJobConcurrency;
  }

  async start(): Promise<void> {
    if (!this.stopped) return;
    this.stopped = false;
    this.logger.info(
      `SRTL worker ${this.workerId} started with limits: jobs=${this.concurrency.maxRunningJobs}, scans=${this.concurrency.maxRunningScans}, audits=${this.concurrency.maxRunningAudits}, copies=${this.concurrency.maxRunningCopies}`
    );
    while (!this.stopped) {
      const ranJob = await this.runOnce();
      if (!ranJob) await this.sleep(this.pollIntervalMs);
    }
    this.logger.info(`SRTL worker ${this.workerId} stopped`);
  }

  stop(): void {
    this.stopped = true;
    for (const abortController of this.activeAbortControllers.values()) {
      if (!abortController.signal.aborted) abortController.abort(new WorkerShutdownError());
    }
    if (this.sleepTimer) clearTimeout(this.sleepTimer);
    this.sleepTimer = null;
    this.resolveSleep?.();
    this.resolveSleep = null;
  }

  async runOnce(): Promise<boolean> {
    if (await isPathConfigurationBlocked(this.db)) await this.requeueInterruptedJobsForPathMigration();
    const job = await this.claimNextJob();
    if (!job) return false;
    await this.runClaimedJob(job);
    return true;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.resolveSleep = resolve;
      this.sleepTimer = setTimeout(() => {
        this.sleepTimer = null;
        this.resolveSleep = null;
        resolve();
      }, ms);
    });
  }

  private async claimNextJob(): Promise<JobRecord | null> {
    const pathConfigurationBlocked = await isPathConfigurationBlocked(this.db);
    const allowedType = pathConfigurationBlocked ? "path_migration" : undefined;
    return (await this.claimInterruptedOwnJob(allowedType)) ?? (await this.claimStaleRunningJob(allowedType)) ?? (await this.claimQueuedJob(allowedType));
  }

  private async claimQueuedJob(allowedType?: JobRecord["type"]): Promise<JobRecord | null> {
    const queuedRows = await this.db
      .select()
      .from(schema.jobs)
      .where(eq(schema.jobs.status, "queued"))
      .orderBy(asc(schema.jobs.id));
    let row: JobRow | undefined;
    for (const queuedJob of queuedRows) {
      if (allowedType && queuedJob.type !== allowedType) continue;
      if (await this.canStartJobType(queuedJob.type as JobRecord["type"])) {
        row = queuedJob;
        break;
      }
    }
    if (!row) return null;
    const timestamp = nowIso();
    const claimedRow = await first(this.db
      .update(schema.jobs)
      .set({ status: "running", startedAt: row.startedAt ?? timestamp, lockedBy: this.workerId, lockedAt: timestamp, heartbeatAt: timestamp })
      .where(and(eq(schema.jobs.id, row.id), eq(schema.jobs.status, "queued")))
      .returning());
    if (!claimedRow) return null;
    const claimed = await this.queue.getJob(row.id);
    return claimed?.status === "running" && claimed.lockedBy === this.workerId ? claimed : null;
  }

  private async claimStaleRunningJob(allowedType?: JobRecord["type"]): Promise<JobRecord | null> {
    const runningRows = await this.db
      .select()
      .from(schema.jobs)
      .where(eq(schema.jobs.status, "running"))
      .orderBy(asc(schema.jobs.id));
    let staleJob: JobRecord | null = null;
    for (const job of runningRows.map(toJobRecord)) {
      if (allowedType && job.type !== allowedType) continue;
      if (isStaleRunningJob(job, this.reclaimStaleAfterMs) && (await this.canStartJobType(job.type, job.id))) {
        staleJob = job;
        break;
      }
    }
    if (!staleJob) return null;

    const timestamp = nowIso();
    const claimedRow = await first(this.db
      .update(schema.jobs)
      .set({ lockedBy: this.workerId, lockedAt: timestamp, heartbeatAt: timestamp })
      .where(and(eq(schema.jobs.id, staleJob.id), eq(schema.jobs.status, "running")))
      .returning());
    if (!claimedRow) return null;
    const claimed = await this.queue.getJob(staleJob.id);
    if (claimed?.status === "running" && claimed.lockedBy === this.workerId) {
      await this.markExistingRunsStale(claimed.id);
      await addEvent(this.db, claimed.id, "warn", "Stale running job reclaimed by worker", { workerId: this.workerId });
      return claimed;
    }
    return null;
  }

  private async claimInterruptedOwnJob(allowedType?: JobRecord["type"]): Promise<JobRecord | null> {
    const runningRows = await this.db
      .select()
      .from(schema.jobs)
      .where(eq(schema.jobs.status, "running"))
      .orderBy(asc(schema.jobs.id));
    let interruptedJob: JobRecord | null = null;
    for (const job of runningRows.map(toJobRecord)) {
      if (allowedType && job.type !== allowedType) continue;
      if (job.lockedBy === this.workerId && isStaleRunningJob(job, this.reclaimOwnInterruptedAfterMs) && (await this.canStartJobType(job.type, job.id))) {
        interruptedJob = job;
        break;
      }
    }
    if (!interruptedJob) return null;

    const timestamp = nowIso();
    const claimedRow = await first(this.db
      .update(schema.jobs)
      .set({ lockedBy: this.workerId, lockedAt: timestamp, heartbeatAt: timestamp })
      .where(and(eq(schema.jobs.id, interruptedJob.id), eq(schema.jobs.status, "running")))
      .returning());
    if (!claimedRow) return null;
    const claimed = await this.queue.getJob(interruptedJob.id);
    if (claimed?.status === "running" && claimed.lockedBy === this.workerId) {
      await this.markExistingRunsStale(claimed.id);
      await addEvent(this.db, claimed.id, "warn", "Interrupted job reclaimed by replacement worker", { workerId: this.workerId });
      return claimed;
    }
    return null;
  }

  private async activeRunningJobs(excludedJobId?: number): Promise<JobRecord[]> {
    return (await this.db
      .select()
      .from(schema.jobs)
      .where(eq(schema.jobs.status, "running"))
    )
      .map(toJobRecord)
      .filter((job) => job.id !== excludedJobId && !isStaleRunningJob(job, this.reclaimStaleAfterMs));
  }

  private limitForType(type: JobRecord["type"]): number {
    if (type === "scan") return this.concurrency.maxRunningScans;
    if (type === "audit") return this.concurrency.maxRunningAudits;
    if (type === "copy") return this.concurrency.maxRunningCopies;
    return this.concurrency.maxRunningJobs;
  }

  private async canStartJobType(type: JobRecord["type"], excludedJobId?: number): Promise<boolean> {
    const activeJobs = await this.activeRunningJobs(excludedJobId);
    if (activeJobs.length >= this.concurrency.maxRunningJobs) return false;
    return activeJobs.filter((job) => job.type === type).length < this.limitForType(type);
  }

  private async requeueInterruptedJobsForPathMigration(): Promise<void> {
    const rows = await this.db
      .select()
      .from(schema.jobs)
      .where(and(eq(schema.jobs.status, "running"), ne(schema.jobs.type, "path_migration")));
    for (const job of rows.map(toJobRecord)) {
      if (!isStaleRunningJob(job, this.reclaimOwnInterruptedAfterMs)) continue;
      await this.requeueInterruptedJob(job.id, "Managed storage paths changed; interrupted job paused and requeued");
    }
  }

  private async runClaimedJob(job: JobRecord): Promise<void> {
    const abortController = new AbortController();
    this.activeAbortControllers.set(job.id, abortController);
    const heartbeat = setInterval(() => {
      void this.heartbeat(job.id).catch((error: unknown) => {
        this.logger.warn(`SRTL worker ${this.workerId} heartbeat failed for job #${job.id}: ${errorMessage(error)}`);
      });
    }, this.heartbeatIntervalMs);
    let pathMigrationPauseRequested = false;
    const cancellationWatcher = setInterval(() => {
      void Promise.all([this.isCancellationRequested(job.id), job.type === "path_migration" ? Promise.resolve(false) : isPathConfigurationBlocked(this.db)])
        .then(([cancelled, pathConfigurationBlocked]) => {
          if (pathConfigurationBlocked) pathMigrationPauseRequested = true;
          if ((cancelled || pathConfigurationBlocked) && !abortController.signal.aborted) abortController.abort();
        })
        .catch((error: unknown) => {
          this.logger.warn(`SRTL worker ${this.workerId} cancellation watch failed for job #${job.id}: ${errorMessage(error)}`);
        });
    }, 500);
    const isCancelled = async () => {
      const cancelled = await this.isCancellationRequested(job.id);
      const pathConfigurationBlocked = job.type === "path_migration" ? false : await isPathConfigurationBlocked(this.db);
      if (pathConfigurationBlocked) pathMigrationPauseRequested = true;
      if ((cancelled || pathConfigurationBlocked) && !abortController.signal.aborted) abortController.abort();
      return cancelled || pathConfigurationBlocked;
    };
    const ctx: JobContext = {
      jobId: job.id,
      signal: abortController.signal,
      event: (level, message, data) => addEvent(this.db, job.id, level, message, data),
      setProgress: (progress) => setProgress(this.db, job.id, progress),
      isCancelled
    };

    await addEvent(this.db, job.id, "info", "Worker started job", { workerId: this.workerId });
    try {
      await this.runHandler(job, ctx);
      if (job.type !== "path_migration" && (pathMigrationPauseRequested || (await isPathConfigurationBlocked(this.db)))) {
        await this.requeueInterruptedJob(job.id, "Managed storage paths changed; job paused and requeued");
        return;
      }
      const status: JobStatus = (await this.isCancellationRequested(job.id)) ? "cancelled" : "completed";
      await this.finishJob(job.id, status);
      if (status === "completed" && job.type === "scan") await completeOnboardingScan(this.db, job.id);
      await addEvent(this.db, job.id, status === "cancelled" ? "warn" : "info", status === "cancelled" ? "Job cancelled" : "Job completed");
    } catch (error: unknown) {
      if (pathMigrationPauseRequested) {
        await this.requeueInterruptedJob(job.id, "Managed storage paths changed; job paused and requeued");
        return;
      }
      if (await this.shouldRequeueInterruptedJob(job.id, abortController)) {
        await this.requeueInterruptedJob(job.id);
        return;
      }
      if (await this.isCancellationRequested(job.id)) {
        await this.finishJob(job.id, "cancelled");
        await addEvent(this.db, job.id, "warn", "Job cancelled");
        return;
      }
      if (error instanceof PartialJobFailureError) {
        await this.finishJob(job.id, "partially_failed");
        await addEvent(this.db, job.id, "warn", error.message);
        this.logger.warn(`SRTL worker ${this.workerId} partially failed job #${job.id}: ${error.message}`);
        return;
      }
      await this.finishJob(job.id, "failed");
      await addEvent(this.db, job.id, "error", errorMessage(error));
      this.logger.error(`SRTL worker ${this.workerId} failed job #${job.id}: ${errorMessage(error)}`);
    } finally {
      clearInterval(heartbeat);
      clearInterval(cancellationWatcher);
      this.activeAbortControllers.delete(job.id);
    }
  }

  private async runHandler(job: JobRecord, ctx: JobContext): Promise<void> {
    if (job.type === "scan") {
      const options = jobProgressOptions<ScanOptions>(job) ?? defaultScanOptions;
      await this.runScanJob(job.id, await normalizeScanOptions(this.db, { ...defaultScanOptions, ...options }), ctx);
      return;
    }
    if (job.type === "audit") {
      await this.runAuditJob(job.id, readAuditOptions(job), ctx);
      return;
    }
    if (job.type === "copy") {
      await this.runCopyJob(readCopyOptions(job), ctx);
      return;
    }
    if (job.type === "path_migration") {
      if (!isRecord(job.progress) || !Number.isInteger(job.progress.migrationId) || Number(job.progress.migrationId) < 1) {
        throw new Error("Path migration job is missing its migration identifier");
      }
      await runPathMigration(this.db, Number(job.progress.migrationId), ctx);
      return;
    }
    throw new Error(`No worker handler is registered for ${job.type} jobs`);
  }

  private async heartbeat(jobId: number): Promise<void> {
    await this.db.update(schema.jobs).set({ heartbeatAt: nowIso() }).where(and(eq(schema.jobs.id, jobId), eq(schema.jobs.status, "running")));
  }

  private async shouldRequeueInterruptedJob(jobId: number, abortController: AbortController): Promise<boolean> {
    return this.stopped && abortController.signal.aborted && !(await this.isCancellationRequested(jobId));
  }

  private async requeueInterruptedJob(jobId: number, message = "Worker stopped; job requeued for resume"): Promise<void> {
    const requeued = await first(this.db
      .update(schema.jobs)
      .set({ status: "queued", lockedBy: null, lockedAt: null, heartbeatAt: null })
      .where(and(eq(schema.jobs.id, jobId), eq(schema.jobs.status, "running")))
      .returning({ id: schema.jobs.id }));
    if (requeued) await addEvent(this.db, jobId, "warn", message, { workerId: this.workerId });
  }

  private async markExistingRunsStale(jobId: number): Promise<void> {
    const timestamp = nowIso();
    await this.db
      .update(schema.scanRuns)
      .set({ status: "failed", finishedAt: timestamp, errorMessage: "Stale job reclaimed by worker" })
      .where(and(eq(schema.scanRuns.jobId, jobId), eq(schema.scanRuns.status, "running")));
    await this.db
      .update(schema.auditRuns)
      .set({ status: "failed", finishedAt: timestamp })
      .where(and(eq(schema.auditRuns.jobId, jobId), eq(schema.auditRuns.status, "running")));
  }

  private async finishJob(jobId: number, status: JobStatus): Promise<void> {
    await this.db
      .update(schema.jobs)
      .set({
        status,
        finishedAt: nowIso(),
        lockedBy: null,
        lockedAt: null,
        heartbeatAt: null,
        cancelRequestedAt: status === "completed" ? null : undefined
      })
      .where(eq(schema.jobs.id, jobId));
  }

  private async isCancellationRequested(jobId: number): Promise<boolean> {
    const row = await first(this.db.select({ cancelRequestedAt: schema.jobs.cancelRequestedAt }).from(schema.jobs).where(eq(schema.jobs.id, jobId)).limit(1));
    return Boolean(row?.cancelRequestedAt);
  }

  private async runScanJob(jobId: number, normalizedOptions: ScanOptions, ctx: JobContext): Promise<void> {
    const scanRun = await first(this.db
      .insert(schema.scanRuns)
      .values({ jobId, status: "running", startedAt: nowIso(), finishedAt: null, errorMessage: null, ...emptyScanTotals() })
      .returning({ id: schema.scanRuns.id }));
    if (!scanRun) throw new Error("Scan run was not created");

    try {
      const configuredSections = await getSectionSettings(this.db);
      const paths = await getJsonSetting<PathsSettings>(this.db, "paths", { symlinkDir: "", localDir: "", remoteDir: "" });
      const isTitleRescan = Boolean(normalizedOptions.titleScopes?.length);
      if (!normalizedOptions.scanSymlinks && !normalizedOptions.scanLocal && !normalizedOptions.scanRemote) throw new Error("At least one scan scope must be selected");
      if (normalizedOptions.scanSymlinks && (!paths.symlinkDir || !paths.localDir || !paths.remoteDir)) throw new Error("Path settings are incomplete");
      if (normalizedOptions.scanLocal && !paths.localDir) throw new Error("Local path setting is incomplete");
      if (normalizedOptions.scanRemote && !paths.remoteDir) throw new Error("Remote path setting is incomplete");
      if (normalizedOptions.scanSymlinks && normalizedOptions.symlinkSections?.length === 0) throw new Error("Select at least one symlink folder");
      if (normalizedOptions.scanLocal && normalizedOptions.localSections?.length === 0) throw new Error("Select at least one local folder");
      await ctx.event("info", isTitleRescan ? "Targeted title rescan started" : "Manual inventory scan started", {
        symlinkSections: normalizedOptions.symlinkSections,
        titleScopes: normalizedOptions.titleScopes,
        localSections: normalizedOptions.localSections,
        options: normalizedOptions
      });
      await ctx.setProgress(
        scanProgressPayload(normalizedOptions, "scanning", isTitleRescan ? "Reading selected title symlinks" : "Reading selected folders and collecting inventory data")
      );
      const result = await scanLibrary(
        paths,
        configuredSections,
        await getStoragePolicyMap(this.db),
        normalizedOptions,
        ctx.isCancelled,
        async (activity) => {
          const liveTotals = emptyScanTotals();
          liveTotals.totalLinks = activity.checkedLinks;
          await ctx.setProgress(scanProgressPayload(normalizedOptions, "scanning", activity.message, liveTotals, activity));
        }
      );
      await ctx.setProgress(scanProgressPayload(normalizedOptions, "indexing", "Writing scan results to the inventory database", result.inventory));
      for (const issue of result.storageScanIssues) {
        await ctx.event("warn", "Remote storage directory remained unreadable after retry", issue);
      }
      if (await ctx.isCancelled()) {
        await this.db.update(schema.scanRuns).set({ status: "cancelled", finishedAt: nowIso(), errorMessage: "Job cancelled" }).where(eq(schema.scanRuns.id, scanRun.id));
        await ctx.setProgress(scanProgressPayload(normalizedOptions, "cancelled", "Scan cancelled before inventory results were written", result.inventory));
        return;
      }
      const persistedInventory = await this.db.transaction(async (transaction) => {
        const inventory = await persistScanResult(transaction, result, jobId, ctx.isCancelled);
        if (await ctx.isCancelled()) throw new Error("Scan indexing was cancelled");
        await transaction.update(schema.scanRuns).set({ status: "completed", finishedAt: nowIso(), errorMessage: null, ...inventory }).where(eq(schema.scanRuns.id, scanRun.id));
        return inventory;
      });
      await ctx.setProgress(
        scanProgressPayload(
          normalizedOptions,
          "completed",
          isTitleRescan ? "Title rescan completed and symlink inventory was reconciled" : "Scan completed and inventory counters were updated",
          persistedInventory
        )
      );
      await ctx.event("info", isTitleRescan ? "Targeted title rescan reconciled symlinks" : "Manual inventory scan indexed library links and storage files", {
        options: normalizedOptions,
        ...persistedInventory
      });
    } catch (error: unknown) {
      if (await ctx.isCancelled()) {
        await this.db.update(schema.scanRuns).set({ status: "cancelled", finishedAt: nowIso(), errorMessage: "Job terminated" }).where(eq(schema.scanRuns.id, scanRun.id));
        await ctx.setProgress(scanProgressPayload(normalizedOptions, "cancelled", "Scan terminated before inventory results were written"));
        await ctx.event("warn", "Scan terminated before inventory results were written");
        return;
      }
      await this.db.update(schema.scanRuns).set({ status: "failed", finishedAt: nowIso(), errorMessage: errorMessage(error) }).where(eq(schema.scanRuns.id, scanRun.id));
      await ctx.setProgress(scanProgressPayload(normalizedOptions, "failed", errorMessage(error)));
      throw error;
    }
  }

  private async runAuditJob(jobId: number, normalizedOptions: AuditOptions, ctx: JobContext): Promise<void> {
    const links = filterAuditLinks(await listMediaLinks(this.db), normalizedOptions);
    const startedAt = nowIso();
    const auditRun = await first(this.db
      .insert(schema.auditRuns)
      .values({
        jobId,
        mode: normalizedOptions.mode,
        status: "running",
        startedAt,
        finishedAt: null,
        checked: 0,
        passed: 0,
        failed: 0,
        sourceUnknown: 0,
        sourceMissing: 0,
        sourceCompareErrors: 0,
        byteMismatches: 0,
        targetValidationFailures: 0,
        errorMessage: null
      })
      .returning({ id: schema.auditRuns.id }));
    if (!auditRun) throw new Error("Audit run was not created");
    let checked = 0;
    let passed = 0;
    let failed = 0;
    let sourceUnknown = 0;
    let sourceMissing = 0;
    let sourceCompareErrors = 0;
    let byteMismatches = 0;
    let targetValidationFailures = 0;

    const auditMediaOptions = { byteCompare: normalizedOptions.byteCompare !== false };
    const auditProgress = (stage: string, message: string, link?: MediaLinkRow) => ({
      options: normalizedOptions,
      stage,
      message,
      current: checked,
      total: links.length,
      checked,
      passed,
      failed,
      sourceUnknown,
      sourceMissing,
      sourceCompareErrors,
      byteMismatches,
      targetValidationFailures,
      ...(link
        ? {
            currentTitle: link.itemName,
            currentFile: link.targetPath,
            targetPath: link.targetPath
          }
        : {})
    });
    try {
      await ctx.event("info", `${normalizedOptions.mode} audit started`, {
        total: links.length,
        sections: normalizedOptions.sections,
        section: normalizedOptions.section,
        itemName: normalizedOptions.itemName,
        linkIds: normalizedOptions.linkIds,
        relativePathPrefix: normalizedOptions.relativePathPrefix
      });
      const sourceLookup = await this.db.select().from(schema.copySources);
      const sourceByDestination = new Map(sourceLookup.map((row) => [row.destinationPath, row.sourcePath]));
      await ctx.setProgress(auditProgress("auditing", "Starting audit"));

      for (const link of links) {
        if (await ctx.isCancelled()) break;
        await ctx.setProgress({ ...auditProgress("auditing", "Auditing media", link), current: checked + 1 });
        checked += 1;
        await ctx.event("info", "Auditing media", { current: checked, total: links.length, targetPath: link.targetPath, storage: link.kind });
        let result;
        try {
          result = await auditMediaLink(link, sourceByDestination.get(link.targetPath) ?? null, normalizedOptions.mode, this.auditRunner, { ...auditMediaOptions, signal: ctx.signal });
        } catch (error: unknown) {
          if (await ctx.isCancelled()) break;
          throw error;
        }
        if (result.status === "pass") passed += 1;
        else failed += 1;
        if (result.cmpStatus === "source_unknown") sourceUnknown += 1;
        if (result.cmpStatus === "source_missing") sourceMissing += 1;
        if (result.cmpStatus === "source_error") sourceCompareErrors += 1;
        if (result.cmpStatus === "fail") byteMismatches += 1;
        if (result.ffmpegStatus === "fail") targetValidationFailures += 1;

        await this.db.insert(schema.auditResults).values({ ...result, auditRunId: auditRun.id, createdAt: nowIso() });
        await ctx.setProgress(auditProgress("auditing", "Recorded audit result", link));
      }

      const status = (await ctx.isCancelled()) ? "cancelled" : "completed";
      if (status === "cancelled") {
        await this.db.delete(schema.auditResults).where(eq(schema.auditResults.auditRunId, auditRun.id));
        checked = 0;
        passed = 0;
        failed = 0;
        sourceUnknown = 0;
        sourceMissing = 0;
        sourceCompareErrors = 0;
        byteMismatches = 0;
        targetValidationFailures = 0;
      }
      await this.db
        .update(schema.auditRuns)
        .set({ status, finishedAt: nowIso(), checked, passed, failed, sourceUnknown, sourceMissing, sourceCompareErrors, byteMismatches, targetValidationFailures, errorMessage: null })
        .where(eq(schema.auditRuns.id, auditRun.id));
      await ctx.setProgress(auditProgress(status, status === "cancelled" ? "Audit cancelled" : "Audit completed"));
      await ctx.event(status === "cancelled" ? "warn" : "info", status === "cancelled" ? `${normalizedOptions.mode} audit terminated; partial results discarded` : `${normalizedOptions.mode} audit indexed results`, {
        checked,
        passed,
        failed,
        sourceUnknown,
        sourceMissing,
        sourceCompareErrors,
        byteMismatches,
        targetValidationFailures,
        sections: normalizedOptions.sections,
        section: normalizedOptions.section,
        itemName: normalizedOptions.itemName
      });
    } catch (error: unknown) {
      const message = errorMessage(error);
      await this.db
        .update(schema.auditRuns)
        .set({ status: "failed", finishedAt: nowIso(), checked, passed, failed, sourceUnknown, sourceMissing, sourceCompareErrors, byteMismatches, targetValidationFailures, errorMessage: message })
        .where(eq(schema.auditRuns.id, auditRun.id));
      await ctx.setProgress(auditProgress("failed", message));
      throw error;
    }
  }

  private async runCopyJob(normalizedOptions: CopyOptions, ctx: JobContext): Promise<void> {
    const paths = await getJsonSetting<PathsSettings>(this.db, "paths", { symlinkDir: "", localDir: "", remoteDir: "" });
    if (!paths.symlinkDir || !paths.localDir || !paths.remoteDir) throw new Error("Path settings are incomplete");
    const advancedSettings = normalizeAdvancedSettings(await getJsonSetting<unknown>(this.db, "advancedSettings", {}));
    await reconcileCopyOperationsForJob(this.db, ctx.jobId, paths, ctx.event);

    const allLinks = await listMediaLinks(this.db, undefined, "current");
    const links = filterCopyLinks(allLinks, normalizedOptions);
    const hasDurableSelection = Boolean(normalizedOptions.linkIds?.length);
    const selectedLinks = hasDurableSelection ? filterCopySelectedLinks(allLinks, normalizedOptions) : links;
    const destinationKind = copyDestinationKind(normalizedOptions.direction);
    const resumeState = await readCopyResumeState(this.db, ctx.jobId, selectedLinks, destinationKind, hasDurableSelection);
    const selectedTotal = hasDurableSelection ? (normalizedOptions.linkIds?.length ?? 0) : selectedLinks.length;
    const alreadyCompleted = resumeState.copied + resumeState.repointed + resumeState.skipped;
    const total = Math.max(selectedTotal, resumeState.startedTotal ?? 0, links.length + alreadyCompleted);
    const unavailable = hasDurableSelection ? Math.max(0, total - selectedLinks.length) : 0;
    let current = alreadyCompleted + unavailable;
    let copied = resumeState.copied;
    let repointed = resumeState.repointed;
    let skipped = resumeState.skipped;
    let conflicts = 0;
    let failed = unavailable;
    const resumedCopied = copied;
    const resumedRepointed = repointed;
    let activeLink: MediaLinkRow | undefined;
    let activeUpdate: Partial<CopyProgressUpdate> | undefined;
    const replacementCandidateEntries: Array<{ linkId: number; destinationPath: string; candidates: CopyLocalConflictCandidate[] }> = [];
    const setCopyProgress = (stage: CopyProgressStage, message: string, link?: MediaLinkRow, update?: Partial<CopyProgressUpdate>) =>
      ctx.setProgress(
        copyProgressPayload({
          options: normalizedOptions,
          current,
          total,
          copied,
          repointed,
          skipped,
          conflicts,
          failed,
          alreadyCompleted,
          remaining: Math.max(0, total - current),
          stage,
          message,
          link,
          update
        })
      );

    if (unavailable > 0) {
      await ctx.event("warn", "Selected copy media is no longer available", { total, unavailable });
    }
    await setCopyProgress("queued", links.length > 0 ? (alreadyCompleted > 0 ? "Resuming worker copy loop" : "Waiting for worker copy loop") : alreadyCompleted > 0 ? "All selected media already completed" : "No matching media found");
    await ctx.event("info", resumeState.startedTotal === null ? "Copy job started" : "Copy job resumed", {
      options: normalizedOptions,
      total,
      remaining: links.length,
      copied,
      repointed,
      skipped,
      unavailable,
      alreadyCompleted,
      copyBehavior: advancedSettings.copy
    });
    if (links.length === 0) {
      if (failed > 0) {
        const itemLabel = total === 1 ? "media item" : "media items";
        const failureMessage = `Copy job failed: ${failed} of ${total} ${itemLabel} failed`;
        await setCopyProgress("failed", failureMessage);
        await ctx.event("error", "Copy job failed processing media", { total, copied, repointed, skipped, conflicts, failed, unavailable });
        throw new Error(failureMessage);
      }
      await setCopyProgress("completed", alreadyCompleted > 0 ? "Copy job finished" : "No matching media found");
      await ctx.event("info", "Copy job finished processing media", { total, copied, repointed, skipped, conflicts, failed, unavailable });
      return;
    }

    for (const link of links) {
      if (await ctx.isCancelled()) break;
      activeLink = link;
      activeUpdate = undefined;
      let activeOperationId: number | null = null;
      current += 1;
      await setCopyProgress("preparing", "Preparing media copy", link);
      const sourceTitleRisk = evaluateSourceTitleRisk({ expectedTitle: link.itemName, sourcePath: link.targetPath });
      if (sourceTitleRisk.severity === "block") {
        conflicts += 1;
        activeUpdate = {
          sourcePath: link.targetPath,
          linkPath: link.linkPath,
          sizeBytes: link.sizeBytes ?? undefined
        };
        await setCopyProgress("conflict", "Source title mismatch blocked copy", link, activeUpdate);
        await ctx.event("warn", "Source title mismatch blocked copy", {
          direction: normalizedOptions.direction,
          itemName: link.itemName,
          linkPath: link.linkPath,
          sourcePath: link.targetPath,
          risk: sourceTitleRisk
        });
        continue;
      }
      if (sourceTitleRisk.severity === "warn") {
        await ctx.event("warn", "Source title risk warning", {
          direction: normalizedOptions.direction,
          itemName: link.itemName,
          linkPath: link.linkPath,
          sourcePath: link.targetPath,
          risk: sourceTitleRisk
        });
      }
      await ctx.event("info", "Copying media", {
        current,
        total,
        direction: normalizedOptions.direction,
        itemName: link.itemName,
        linkPath: link.linkPath,
        sourcePath: link.targetPath
      });

      try {
        let lastProgressEventKey: string | null = null;
        const localConflict = normalizedOptions.direction === "to_local" ? await copyLocalConflictForLink(this.db, link, paths) : null;
        if (localConflict && !normalizedOptions.localConflictStrategy) {
          conflicts += 1;
          activeUpdate = {
            sourcePath: link.targetPath,
            destinationPath: localConflict.destinationPath,
            linkPath: link.linkPath,
            sizeBytes: link.sizeBytes ?? undefined
          };
          await setCopyProgress("conflict", "Existing local file requires copy resolution", link, activeUpdate);
          await ctx.event("warn", "Existing local file requires copy resolution", localConflict);
          continue;
        }
        const destinationPath = copyDestinationPathForLink(link, paths, normalizedOptions.direction);
        const previousCopySource =
          (await first(this.db.select().from(schema.copySources).where(eq(schema.copySources.destinationPath, destinationPath)).limit(1))) ?? null;
        const operation = await prepareCopyOperation(
          this.db,
          ctx.jobId,
          link,
          destinationPath,
          previousCopySource,
          normalizedOptions.localConflictStrategy
        );
        activeOperationId = operation.id;
        const result = await copyMediaLink(
          link,
          paths,
          normalizedOptions.direction,
          this.copyRunner,
          async (update) => {
            activeUpdate = update;
            await setCopyProgress(update.stage, update.message, link, activeUpdate);
            if (update.stage === "copying" || update.stage === "preparing") return;
            const progressEventKey = `${update.stage}:${update.message}`;
            if (progressEventKey === lastProgressEventKey) return;
            lastProgressEventKey = progressEventKey;
            await ctx.event(
              "info",
              update.message,
              copyProgressPayload({
                options: normalizedOptions,
                current,
                total,
                copied,
                repointed,
                skipped,
                conflicts,
                failed,
                alreadyCompleted,
                remaining: Math.max(0, total - current),
                stage: update.stage,
                message: update.message,
                link,
                update: activeUpdate
              })
            );
          },
          advancedSettings.copy,
          ctx.signal,
          normalizedOptions.localConflictStrategy,
          (update) => updateCopyOperation(this.db, operation.id, update)
        );
        if (result.status === "copied") {
          copied += 1;
          await commitCopyOperation(this.db, operation.id, link, result);
          activeUpdate = { ...(activeUpdate ?? {}), ...result };
          await setCopyProgress("done", result.message, link, activeUpdate);
          await ctx.event("info", advancedSettings.copy.profile === "off" ? "Copy installed without verification" : "Verified copy installed", { ...result, itemName: link.itemName });
          if (normalizedOptions.localConflictStrategy === "replace" && localConflict) {
            replacementCandidateEntries.push({ linkId: link.id, destinationPath: result.destinationPath, candidates: localConflict.candidates });
          }
        } else if (result.status === "repointed") {
          repointed += 1;
          await commitCopyOperation(this.db, operation.id, link, result);
          activeUpdate = { ...(activeUpdate ?? {}), ...result };
          await setCopyProgress("done", result.message, link, activeUpdate);
          await ctx.event("info", "Symlink repointed to existing verified file", { ...result, itemName: link.itemName });
          if (normalizedOptions.localConflictStrategy === "replace" && localConflict) {
            replacementCandidateEntries.push({ linkId: link.id, destinationPath: result.destinationPath, candidates: localConflict.candidates });
          }
        } else if (result.status === "conflict") {
          conflicts += 1;
          await completeCopyOperationWithoutMutation(this.db, operation.id, result);
          activeUpdate = { ...(activeUpdate ?? {}), ...result };
          await setCopyProgress("conflict", result.message, link, activeUpdate);
          await ctx.event("warn", "Destination conflict; file was not overwritten", result);
        } else {
          skipped += 1;
          await completeCopyOperationWithoutMutation(this.db, operation.id, result);
          activeUpdate = { ...(activeUpdate ?? {}), ...result };
          await setCopyProgress("skipped", result.message, link, activeUpdate);
          await ctx.event("info", "Copy skipped", result);
        }
      } catch (error: unknown) {
        if (await ctx.isCancelled()) {
          await setCopyProgress("cancelled", "Copy job termination requested", link, activeUpdate);
          await ctx.event("warn", "Copy job termination requested; active copy was stopped before promotion", {
            direction: normalizedOptions.direction,
            itemName: link.itemName,
            linkPath: link.linkPath,
            sourcePath: link.targetPath
          });
          break;
        }
        if (ctx.signal.aborted) throw error;
        failed += 1;
        if (activeOperationId) await failCopyOperation(this.db, activeOperationId, errorMessage(error));
        await setCopyProgress("failed", errorMessage(error), link);
        await ctx.event("error", errorMessage(error), {
          direction: normalizedOptions.direction,
          itemName: link.itemName,
          linkPath: link.linkPath,
          sourcePath: link.targetPath
        });
      }
    }

    const cancelled = await ctx.isCancelled();
    if (cancelled) {
      await setCopyProgress("cancelled", "Rolling back completed copy changes", activeLink, activeUpdate);
      const { rolledBack, warnings } = await rollbackDurableCopyOperations(this.db, ctx.jobId, paths, ctx.event);
      copied = resumedCopied;
      repointed = resumedRepointed;
      for (const warning of warnings) {
        await ctx.event("warn", warning);
      }
      await ctx.event("warn", "Copy job terminated; completed copy changes rolled back", { rolledBack, warnings });
    }
    if (!cancelled && failed > 0) {
      const itemLabel = total === 1 ? "media item" : "media items";
      const completed = copied + repointed + skipped + conflicts;
      const partialFailure = completed > 0;
      const failureMessage = partialFailure ? `Copy job partially failed: ${failed} of ${total} ${itemLabel} failed` : `Copy job failed: ${failed} of ${total} ${itemLabel} failed`;
      await setCopyProgress(partialFailure ? "partially_failed" : "failed", failureMessage, activeLink, activeUpdate);
      await ctx.event(partialFailure ? "warn" : "error", partialFailure ? "Copy job partially failed processing media" : "Copy job failed processing media", {
        total,
        copied,
        repointed,
        skipped,
        conflicts,
        failed,
        unavailable
      });
      if (partialFailure) throw new PartialJobFailureError(failureMessage);
      throw new Error(failureMessage);
    }
    if (!cancelled && replacementCandidateEntries.length > 0) {
      await setCopyProgress("symlinking", "Removing previous local files", activeLink, activeUpdate);
      for (const entry of replacementCandidateEntries) {
        const removed = await removeLocalConflictCandidates(this.db, paths, entry.candidates, entry.destinationPath);
        if (removed.length > 0) await ctx.event("info", "Replaced previous local files", { linkId: entry.linkId, removed });
      }
    }
    await setCopyProgress(cancelled ? "cancelled" : "completed", cancelled ? "Copy job terminated" : "Copy job finished", activeLink, activeUpdate);
    await ctx.event(cancelled ? "warn" : "info", cancelled ? "Copy job terminated" : "Copy job finished processing media", { total, copied, repointed, skipped, conflicts, failed, unavailable });
  }
}
