import { and, asc, count, desc, eq, gt, gte, inArray, isNull, lt, ne, sql } from "drizzle-orm";
import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { JobConcurrencySettings } from "../config";
import { dbAll, dbGet, first, getJsonSetting, getSectionSettings, nowIso, type Db, type DbExecutor } from "../db/database";
import * as schema from "../db/schema";
import { auditMediaLink, defaultAuditRunner, type AuditCommandRunner } from "../lib/auditor";
import {
  copyFileIdentitiesMatch,
  copyMediaLink,
  CopyReconciliationRequiredError,
  defaultCopyRunner,
  parseCopyFileIdentity,
  readCopyFileIdentity,
  type CopyFileIdentity,
  type CopyCommandRunner,
  type CopyMediaResult,
  type CopyOperationUpdate,
  type CopyProgressUpdate
} from "../lib/copier";
import { assertDestinationPathInside, assertExistingPathInside, assertPathParentInside, canonicalPathForClaim, withFilesystemTimeout } from "../lib/filesystemSafety";
import { isMediaFile, isPathInside } from "../lib/media";
import { isPathConfigurationBlocked, runPathMigration } from "../lib/pathConfiguration";
import { completeOnboardingScan } from "../lib/onboarding";
import { defaultScanOptions, getStoragePolicyMap, listMediaLinks, persistScanResult, scanLibrary, type ScanActivity } from "../lib/scanner";
import { normalizeAdvancedSettings } from "../../shared/advancedSettings";
import { evaluateSourceTitleRisk } from "../../shared/sourceTitleRisk";
import { CopyTransferLimiter } from "./copyLimiter";
import { runKeyedPool } from "./copyPool";
import { listCopyReconciliation, reconcileProvablySettledCopyOperations, unresolvedCopyReconciliation } from "./copyReconciliation";
import { schedulerLockKey } from "./scheduling";
import type {
  AuditMode,
  AuditOptions,
  CopyConflictPreview,
  CopyDirection,
  CopyLocalConflict,
  CopyLocalConflictCandidate,
  CopyLocalConflictStrategy,
  CopyJobBehaviorSettings,
  CopyOptions,
  InventorySummary,
  JobEventPage,
  JobEventRecord,
  JobRecord,
  CopyReconciliationState,
  JobSelectionSummary,
  JobStatus,
  MediaLinkRow,
  PathsSettings,
  ScanOptions,
  ScanTitleScope,
  StoragePolicyKind,
  StorageRootType
} from "../../shared/types";

type JobRow = typeof schema.jobs.$inferSelect;
type StoredCopyOptions = CopyOptions & { behavior?: CopyJobBehaviorSettings };
type CopyProgressStage = CopyProgressUpdate["stage"] | "queued" | "done" | "skipped" | "conflict" | "partially_failed" | "failed" | "completed" | "cancelled";
const maxSelectionTitlesPerJob = 100;
const maxAdvisorySelectionLinkIds = 1_000;

class WorkerShutdownError extends Error {
  constructor() {
    super("Worker stopped before the job finished");
    this.name = "WorkerShutdownError";
  }
}

export class LeaseLostError extends Error {
  constructor(jobId: number, options?: ErrorOptions) {
    super(`Worker lease lost for job #${jobId}`, options);
    this.name = "LeaseLostError";
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
  maxRunningCopies: 1,
  copyFileConcurrency: 1,
  maxActiveCopyFiles: 1
};

type ResourceClaimAccess = "shared" | "exclusive";

interface ResourceClaim {
  resourceType: string;
  resourceKey: string;
  access: ResourceClaimAccess;
}

interface PreparedJob {
  progress: unknown;
  options?: unknown;
  selection?: MediaLinkRow[];
  selectionFrozen?: boolean;
  exclusive: boolean;
  claims: ResourceClaim[];
}

type LeasedJob = JobRecord & { leaseVersion: number; exclusive: boolean };

interface ClaimedJob {
  job: LeasedJob;
  reclaimed: boolean;
}

export interface JobContext {
  jobId: number;
  signal: AbortSignal;
  event(level: JobEventRecord["level"], message: string, data?: unknown): Promise<void>;
  setProgress(progress: unknown): Promise<void>;
  isCancelled(): Promise<boolean>;
  assertLease(): Promise<void>;
  withLease<T>(action: () => Promise<T>): Promise<T>;
  withLeaseDb<T>(action: (db: DbExecutor) => Promise<T>): Promise<T>;
  finishCompleted(action: (db: DbExecutor) => Promise<void>): Promise<boolean>;
  finishCompletedIsolated(action: (db: DbExecutor) => Promise<void>): Promise<boolean>;
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
  copyTransferLimiter?: CopyTransferLimiter;
  dispatchConcurrency?: number;
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

function compactJobProgress(progress: unknown): unknown {
  if (!isRecord(progress) || !("options" in progress)) return progress;
  const { options: _options, ...compact } = progress;
  return compact;
}

function progressOptions(progress: unknown): unknown {
  return isRecord(progress) && "options" in progress ? progress.options : {};
}

function compactFrozenOptions(options: unknown): unknown {
  if (!isRecord(options) || !("linkIds" in options)) return options;
  const { linkIds: _linkIds, ...compact } = options;
  return compact;
}

function progressWithOptions(progress: unknown, options: unknown): unknown {
  if (!isRecord(progress) || !isRecord(options) || Object.keys(options).length === 0) return progress;
  return { ...progress, options };
}

function finiteNumberFromRecord(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function jobProgressOptions<T>(job: JobRecord): T | null {
  if (isRecord(job.options) && Object.keys(job.options).length > 0) return job.options as T;
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
  const hasScopedAudit = Boolean(linkIds !== undefined || section || itemName || relativePathPrefix);
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
    ...(linkIds !== undefined ? { linkIds } : {}),
    ...(itemName ? { itemName } : {}),
    ...(relativePathPrefix ? { relativePathPrefix } : {}),
    ...(requestedOptions.byteCompare === false ? { byteCompare: false } : {})
  };
}

function readAuditOptions(job: JobRecord, frozenLinkIds?: number[]): AuditOptions {
  const options = jobProgressOptions<AuditOptions>(job);
  if (!options || (options.mode !== "fast" && options.mode !== "deep")) {
    throw new Error("Audit job is missing valid options");
  }
  return {
    mode: options.mode,
    ...(Array.isArray(options.sections) ? { sections: options.sections.filter((section) => typeof section === "string" && section.trim()).map((section) => section.trim()) } : {}),
    ...(Array.isArray(options.targets) ? { targets: normalizeAuditTargets(options.targets) } : {}),
    ...(frozenLinkIds !== undefined
      ? { linkIds: frozenLinkIds }
      : Array.isArray(options.linkIds)
        ? { linkIds: options.linkIds.filter((id) => Number.isInteger(id) && id > 0) }
        : {}),
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
    ...(options.localConflictStrategy === "keep_both" || options.localConflictStrategy === "replace" ? { localConflictStrategy: options.localConflictStrategy } : {}),
    ...(options.allowSourceTitleMismatch === true ? { allowSourceTitleMismatch: true } : {})
  };
  if (!normalized.linkIds?.length && !normalized.section && !normalized.itemName) throw new Error("Copy requires link IDs, a folder scope, or a title");
  return normalized;
}

function readCopyOptions(job: JobRecord, frozenLinkIds?: number[]): StoredCopyOptions {
  const options = jobProgressOptions<StoredCopyOptions>(job);
  if (!options) throw new Error("Copy job is missing options");
  return normalizeCopyOptionsFromProgress({ ...options, ...(frozenLinkIds !== undefined ? { linkIds: frozenLinkIds } : {}) });
}

function normalizeCopyOptionsFromProgress(options: StoredCopyOptions): StoredCopyOptions {
  if (options.direction !== "to_local" && options.direction !== "to_remote") throw new Error("Copy job has invalid direction");
  const behavior = options.behavior ? normalizeAdvancedSettings({ copy: options.behavior }).copy : undefined;
  return {
    direction: options.direction,
    ...(Array.isArray(options.linkIds) ? { linkIds: options.linkIds.filter((id) => Number.isInteger(id) && id > 0) } : {}),
    ...(typeof options.section === "string" && options.section.trim() ? { section: options.section.trim() } : {}),
    ...(typeof options.itemName === "string" && options.itemName.trim() ? { itemName: options.itemName.trim() } : {}),
    ...(typeof options.relativePathPrefix === "string" && options.relativePathPrefix.trim() ? { relativePathPrefix: normalizeRelativePrefix(options.relativePathPrefix) } : {}),
    ...(options.localConflictStrategy === "keep_both" || options.localConflictStrategy === "replace" ? { localConflictStrategy: options.localConflictStrategy } : {}),
    ...(options.allowSourceTitleMismatch === true ? { allowSourceTitleMismatch: true } : {}),
    ...(behavior ? { behavior } : {})
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
  return Boolean(options.linkIds !== undefined || options.section || options.itemName || options.relativePathPrefix);
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
  const requestedIds = options.linkIds === undefined ? null : new Set(options.linkIds);
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
  const requestedIds = options.linkIds === undefined ? null : new Set(options.linkIds);
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
  const requestedIds = options.linkIds === undefined ? null : new Set(options.linkIds);
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

function orderedCopySelection(links: MediaLinkRow[], options: CopyOptions): MediaLinkRow[] {
  const selected = filterCopyLinks(links, options);
  const requestedOrder = options.linkIds?.length ? new Map(options.linkIds.map((id, index) => [id, index])) : null;
  return requestedOrder
    ? [...selected].sort((firstLink, secondLink) => (requestedOrder.get(firstLink.id) ?? 0) - (requestedOrder.get(secondLink.id) ?? 0))
    : selected;
}

function copyAdmissionFingerprint(link: MediaLinkRow): string {
  return JSON.stringify([
    link.id,
    link.section,
    link.itemName,
    link.relativePath,
    path.resolve(link.linkPath),
    path.resolve(link.targetPath),
    link.kind,
    link.targetExists,
    link.isMedia,
    link.storagePolicy,
    link.resolvedStorageFileId,
    link.sizeBytes,
    link.missingSince
  ]);
}

export function copyAdmissionSelectionFingerprint(links: readonly MediaLinkRow[]): string {
  return JSON.stringify(links.map(copyAdmissionFingerprint).sort());
}

function resourceClaimKey(claim: Pick<ResourceClaim, "resourceType" | "resourceKey">): string {
  return `${claim.resourceType}\0${claim.resourceKey}`;
}

function normalizeResourceClaims(claims: ResourceClaim[]): ResourceClaim[] {
  const normalized = new Map<string, ResourceClaim>();
  for (const claim of claims) {
    const key = resourceClaimKey(claim);
    const current = normalized.get(key);
    if (!current || claim.access === "exclusive") normalized.set(key, claim);
  }
  return [...normalized.values()];
}

async function managedPathResourceClaims(
  root: string | null,
  candidate: string,
  label: string,
  access: ResourceClaimAccess,
  preserveLeaf = false
): Promise<ResourceClaim[]> {
  const lexicalPath = path.resolve(candidate);
  if (!root) return [{ resourceType: "path", resourceKey: lexicalPath, access }];
  const canonicalPath = await canonicalPathForClaim(root, lexicalPath, label, preserveLeaf);
  return [...new Set([lexicalPath, canonicalPath])].map((resourceKey) => ({ resourceType: "path", resourceKey, access }));
}

function managedRootForTarget(paths: PathsSettings, targetPath: string): string | null {
  if (isPathInside(paths.localDir, targetPath)) return paths.localDir;
  if (isPathInside(paths.remoteDir, targetPath)) return paths.remoteDir;
  return null;
}

async function mediaLinkResourceClaims(link: MediaLinkRow, paths: PathsSettings, access: ResourceClaimAccess): Promise<ResourceClaim[]> {
  const [linkPathClaims, targetPathClaims] = await Promise.all([
    managedPathResourceClaims(paths.symlinkDir, link.linkPath, "Library symlink claim", access, true),
    managedPathResourceClaims(managedRootForTarget(paths, link.targetPath), link.targetPath, "Media target claim", access)
  ]);
  return [
    { resourceType: "media", resourceKey: String(link.id), access },
    ...linkPathClaims,
    ...targetPathClaims,
    { resourceType: "title", resourceKey: JSON.stringify([link.section, link.itemName]), access }
  ];
}

async function batchedMediaLinkResourceClaims(
  links: MediaLinkRow[],
  paths: PathsSettings,
  access: ResourceClaimAccess
): Promise<ResourceClaim[]> {
  const claims: ResourceClaim[] = [];
  for (let offset = 0; offset < links.length; offset += 16) {
    const batch = await Promise.all(links.slice(offset, offset + 16).map((link) => mediaLinkResourceClaims(link, paths, access)));
    claims.push(...batch.flat());
  }
  return claims;
}

async function titleScanResourceClaims(options: ScanOptions, links: MediaLinkRow[], paths: PathsSettings): Promise<ResourceClaim[]> {
  const claims: ResourceClaim[] = [];
  for (const scope of options.titleScopes ?? []) {
    claims.push({ resourceType: "title", resourceKey: JSON.stringify([scope.section, scope.itemName]), access: "exclusive" });
  }
  claims.push(...(await batchedMediaLinkResourceClaims(links, paths, "exclusive")));
  return normalizeResourceClaims(claims);
}

async function auditResourceClaims(links: MediaLinkRow[], paths: PathsSettings): Promise<ResourceClaim[]> {
  return normalizeResourceClaims(await batchedMediaLinkResourceClaims(links, paths, "shared"));
}

type CopyPathBindingRole = "link" | "source" | "destination";

interface CopyPathBinding {
  linkId: number;
  role: CopyPathBindingRole;
  lexicalPath: string;
  canonicalPath: string;
}

interface CopySelectedDestination {
  linkId: number;
  lexicalPath: string;
  canonicalPath: string;
}

interface CopySelectedDestinationIndex {
  entries: CopySelectedDestination[];
  lexicalOwners: Map<string, Set<number>>;
  canonicalOwners: Map<string, Set<number>>;
}

function addCopyDestinationOwner(owners: Map<string, Set<number>>, filePath: string, linkId: number): void {
  const existing = owners.get(filePath);
  if (existing) existing.add(linkId);
  else owners.set(filePath, new Set([linkId]));
}

function indexCopySelectedDestinations(entries: CopySelectedDestination[]): CopySelectedDestinationIndex {
  const lexicalOwners = new Map<string, Set<number>>();
  const canonicalOwners = new Map<string, Set<number>>();
  for (const entry of entries) {
    addCopyDestinationOwner(lexicalOwners, entry.lexicalPath, entry.linkId);
    addCopyDestinationOwner(canonicalOwners, entry.canonicalPath, entry.linkId);
  }
  return { entries, lexicalOwners, canonicalOwners };
}

async function copySelectedDestinationForLink(
  link: MediaLinkRow,
  paths: PathsSettings,
  direction: CopyOptions["direction"]
): Promise<CopySelectedDestination> {
  const destinationRoot = storageRootForDirection(paths, direction);
  const lexicalPath = path.resolve(copyDestinationPathForLink(link, paths, direction));
  const canonicalPath = await canonicalPathForClaim(destinationRoot, lexicalPath, "Copy destination claim");
  return { linkId: link.id, lexicalPath, canonicalPath };
}

async function copySelectedDestinationsForLinks(
  links: MediaLinkRow[],
  paths: PathsSettings,
  direction: CopyOptions["direction"]
): Promise<CopySelectedDestinationIndex> {
  const entries: CopySelectedDestination[] = [];
  for (let offset = 0; offset < links.length; offset += 16) {
    entries.push(...(await Promise.all(links.slice(offset, offset + 16).map((link) => copySelectedDestinationForLink(link, paths, direction)))));
  }
  return indexCopySelectedDestinations(entries);
}

async function isOtherSelectedCopyDestination(
  paths: PathsSettings,
  filePath: string,
  currentLinkId: number,
  selectedDestinations: CopySelectedDestinationIndex
): Promise<boolean> {
  if (selectedDestinations.entries.length === 0) return false;
  const lexicalPath = path.resolve(filePath);
  const canonicalPath = await canonicalPathForClaim(paths.localDir, lexicalPath, "Local replacement candidate");
  const owners = new Set([
    ...(selectedDestinations.lexicalOwners.get(lexicalPath) ?? []),
    ...(selectedDestinations.canonicalOwners.get(canonicalPath) ?? [])
  ]);
  return owners.size > 0 && !owners.has(currentLinkId);
}

function copyPathBindingMapKey(linkId: number, role: CopyPathBindingRole): string {
  return `${linkId}\0${role}`;
}

function copyPathBindingResourceKey(binding: CopyPathBinding): string {
  return JSON.stringify([binding.linkId, binding.role, binding.lexicalPath, binding.canonicalPath]);
}

function parseCopyPathBindingResourceKey(value: string): CopyPathBinding | null {
  const parsed = parseJson(value);
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 4 ||
    !Number.isSafeInteger(parsed[0]) ||
    Number(parsed[0]) < 1 ||
    !["link", "source", "destination"].includes(String(parsed[1])) ||
    typeof parsed[2] !== "string" ||
    typeof parsed[3] !== "string"
  ) {
    return null;
  }
  return {
    linkId: Number(parsed[0]),
    role: parsed[1] as CopyPathBindingRole,
    lexicalPath: path.resolve(parsed[2]),
    canonicalPath: path.resolve(parsed[3])
  };
}

async function copyPathBindingsForLink(
  link: MediaLinkRow,
  paths: PathsSettings,
  direction: CopyOptions["direction"]
): Promise<CopyPathBinding[]> {
  const sourceRoot = direction === "to_local" ? paths.remoteDir : paths.localDir;
  const linkPath = path.resolve(link.linkPath);
  const sourcePath = path.resolve(link.targetPath);
  const [canonicalLinkPath, canonicalSourcePath, destination] = await Promise.all([
    canonicalPathForClaim(paths.symlinkDir, linkPath, "Library symlink claim", true),
    canonicalPathForClaim(sourceRoot, sourcePath, "Media target claim"),
    copySelectedDestinationForLink(link, paths, direction)
  ]);
  return [
    { linkId: link.id, role: "link", lexicalPath: linkPath, canonicalPath: canonicalLinkPath },
    { linkId: link.id, role: "source", lexicalPath: sourcePath, canonicalPath: canonicalSourcePath },
    { linkId: link.id, role: "destination", lexicalPath: destination.lexicalPath, canonicalPath: destination.canonicalPath }
  ];
}

async function copyResourceClaims(workLinks: MediaLinkRow[], claimedLinks: MediaLinkRow[], paths: PathsSettings, options: CopyOptions): Promise<ResourceClaim[]> {
  const eligibleLinks = filterCopyLinks(workLinks, options);
  const claims = await batchedMediaLinkResourceClaims(claimedLinks, paths, "exclusive");
  for (let offset = 0; offset < eligibleLinks.length; offset += 16) {
    const batch = eligibleLinks.slice(offset, offset + 16);
    const [destinationClaims, pathBindings] = await Promise.all([
      Promise.all(
        batch.map((link) =>
          managedPathResourceClaims(
            storageRootForDirection(paths, options.direction),
            copyDestinationPathForLink(link, paths, options.direction),
            "Copy destination claim",
            "exclusive"
          )
        )
      ),
      Promise.all(batch.map((link) => copyPathBindingsForLink(link, paths, options.direction)))
    ]);
    claims.push(...destinationClaims.flat());
    claims.push(
      ...pathBindings.flat().map((binding) => ({
        resourceType: "copy_path_binding",
        resourceKey: copyPathBindingResourceKey(binding),
        access: "exclusive" as const
      }))
    );
  }
  return normalizeResourceClaims(claims);
}

interface CopyCleanupIdentity {
  device: string;
  inode: string;
  size: string;
  modifiedNs: string;
  changedNs: string;
}

async function copyCleanupIdentity(filePath: string): Promise<CopyCleanupIdentity | null> {
  const stat = await fs.stat(filePath, { bigint: true }).catch(() => null);
  if (!stat?.isFile()) return null;
  return {
    device: stat.dev.toString(),
    inode: stat.ino.toString(),
    size: stat.size.toString(),
    modifiedNs: stat.mtimeNs.toString(),
    changedNs: stat.ctimeNs.toString()
  };
}

function sameCopyCleanupIdentity(first: CopyCleanupIdentity | null | undefined, second: CopyCleanupIdentity | null | undefined): boolean {
  return Boolean(
    first &&
      second &&
      first.device === second.device &&
      first.inode === second.inode &&
      first.size === second.size &&
      first.modifiedNs === second.modifiedNs &&
      first.changedNs === second.changedNs
  );
}

function copyCleanupMarkerKey(linkId: number, filePath: string, identity: CopyCleanupIdentity): string {
  return JSON.stringify([linkId, path.resolve(filePath), identity]);
}

function isCopyCleanupIdentity(value: unknown): value is CopyCleanupIdentity {
  if (!isRecord(value)) return false;
  return ["device", "inode", "size", "modifiedNs", "changedNs"].every(
    (key) => typeof value[key] === "string" && /^\d+$/.test(value[key])
  );
}

function parseCopyCleanupMarker(value: string): { linkId: number; filePath: string; identity: CopyCleanupIdentity | null } | null {
  const parsed = parseJson(value);
  if (!Array.isArray(parsed) || (parsed.length !== 2 && parsed.length !== 3) || !Number.isSafeInteger(parsed[0]) || Number(parsed[0]) < 1 || typeof parsed[1] !== "string") {
    return null;
  }
  const identity = isCopyCleanupIdentity(parsed[2]) ? parsed[2] : null;
  return { linkId: Number(parsed[0]), filePath: path.resolve(parsed[1]), identity };
}

async function copyReplacementResourceClaims(
  db: Db,
  links: MediaLinkRow[],
  paths: PathsSettings,
  options: CopyOptions
): Promise<ResourceClaim[]> {
  const selectedDestinations = await copySelectedDestinationsForLinks(links, paths, options.direction);
  const destinations = new Map<string, number>();
  const libraryLinks = new Map<string, number>();
  for (const destination of selectedDestinations.entries) {
    const existingLinkId = destinations.get(destination.canonicalPath);
    if (existingLinkId != null && existingLinkId !== destination.linkId) {
      throw new Error(`Selected media #${existingLinkId} and #${destination.linkId} resolve to the same copy destination: ${destination.lexicalPath}`);
    }
    destinations.set(destination.canonicalPath, destination.linkId);
  }
  for (const link of links) {
    const canonicalLinkPath = await canonicalPathForClaim(paths.symlinkDir, link.linkPath, "Library symlink claim", true);
    const existingLibraryLinkId = libraryLinks.get(canonicalLinkPath);
    if (existingLibraryLinkId != null && existingLibraryLinkId !== link.id) {
      throw new Error(`Selected media #${existingLibraryLinkId} and #${link.id} resolve to the same library symlink: ${link.linkPath}`);
    }
    libraryLinks.set(canonicalLinkPath, link.id);
  }
  if (options.direction !== "to_local" || options.localConflictStrategy !== "replace") return [];

  const claims: ResourceClaim[] = [];
  const cleanupOwners = new Map<string, number>();
  const eligibleLinks = filterCopyLinks(links, { ...options, linkIds: links.map((link) => link.id) });
  for (const link of eligibleLinks) {
    const conflict = await copyLocalConflictForLink(db, link, paths, selectedDestinations);
    for (const candidate of conflict?.candidates ?? []) {
      const candidatePath = path.resolve(candidate.filePath);
      const canonicalCandidatePath = await canonicalPathForClaim(paths.localDir, candidatePath, "Local replacement claim");
      const destinationOwner = destinations.get(canonicalCandidatePath);
      if (destinationOwner != null && destinationOwner !== link.id) {
        throw new Error(`Replacement cleanup for media #${link.id} overlaps selected destination for media #${destinationOwner}: ${candidatePath}`);
      }
      const cleanupOwner = cleanupOwners.get(canonicalCandidatePath);
      if (cleanupOwner != null && cleanupOwner !== link.id) {
        throw new Error(`Replacement cleanup for media #${link.id} overlaps cleanup for media #${cleanupOwner}: ${candidatePath}`);
      }
      cleanupOwners.set(canonicalCandidatePath, link.id);
      const identity = await copyCleanupIdentity(candidatePath);
      if (!identity) continue;
      claims.push(
        ...(await managedPathResourceClaims(paths.localDir, candidatePath, "Local replacement claim", "exclusive")),
        { resourceType: "copy_cleanup", resourceKey: copyCleanupMarkerKey(link.id, candidatePath, identity), access: "exclusive" }
      );
    }
  }
  return normalizeResourceClaims(claims);
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

async function localConflictCandidatesForLink(
  db: Db,
  link: MediaLinkRow,
  paths: PathsSettings,
  selectedDestinations: CopySelectedDestinationIndex
): Promise<CopyLocalConflictCandidate[]> {
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

  const filteredCandidates: CopyLocalConflictCandidate[] = [];
  for (const candidate of candidates.values()) {
    if (!(await isOtherSelectedCopyDestination(paths, candidate.filePath, link.id, selectedDestinations))) {
      filteredCandidates.push(candidate);
    }
  }
  return filteredCandidates.sort((first, second) => first.relativePath.localeCompare(second.relativePath, undefined, { numeric: true, sensitivity: "base" }));
}

async function copyLocalConflictForLink(
  db: Db,
  link: MediaLinkRow,
  paths: PathsSettings,
  selectedDestinations: CopySelectedDestinationIndex
): Promise<CopyLocalConflict | null> {
  const candidates = await localConflictCandidatesForLink(db, link, paths, selectedDestinations);
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
  const selectedLinks = orderedCopySelection(await listMediaLinks(db), options);
  const links = filterCopyLinks(selectedLinks, { ...options, linkIds: selectedLinks.map((link) => link.id) });
  const sourceTitleRisks = links.flatMap((link) => {
    const risk = evaluateSourceTitleRisk({ expectedTitle: link.itemName, sourcePath: link.targetPath });
    return risk.severity === "block"
      ? [{ linkId: link.id, itemName: link.itemName, relativePath: link.relativePath, sourcePath: link.targetPath, reason: risk.reason }]
      : [];
  });
  const selectedDestinations = await copySelectedDestinationsForLinks(selectedLinks, paths, options.direction);
  const conflicts: CopyLocalConflict[] = [];
  if (options.direction === "to_local") {
    for (const link of links) {
      const conflict = await copyLocalConflictForLink(db, link, paths, selectedDestinations);
      if (conflict) conflicts.push(conflict);
    }
  }
  return {
    conflicts,
    totalConflicts: conflicts.length,
    totalCandidates: conflicts.reduce((total, conflict) => total + conflict.candidates.length, 0),
    sourceTitleRisks,
    totalSourceTitleBlocks: sourceTitleRisks.length
  };
}

async function removeLocalConflictCandidates(
  db: DbExecutor,
  paths: PathsSettings,
  candidates: CopyLocalConflictCandidate[],
  preservedPath: string,
  expectedIdentities: Map<string, CopyCleanupIdentity>,
  currentLinkId: number,
  selectedDestinations: CopySelectedDestinationIndex
): Promise<string[]> {
  const timestamp = nowIso();
  const removed: string[] = [];
  const preserved = path.resolve(preservedPath);
  for (const candidate of candidates) {
    const candidatePath = path.resolve(candidate.filePath);
    if (candidatePath === preserved) continue;
    if (await isOtherSelectedCopyDestination(paths, candidatePath, currentLinkId, selectedDestinations)) continue;
    await assertExistingPathInside(paths.localDir, candidatePath, "Local replacement candidate");
    const stat = await fs.stat(candidatePath).catch(() => null);
    if (!stat?.isFile()) continue;
    const expectedIdentity = expectedIdentities.get(candidatePath);
    const actualIdentity = await copyCleanupIdentity(candidatePath);
    if (!sameCopyCleanupIdentity(expectedIdentity, actualIdentity) || stat.size !== candidate.sizeBytes) {
      throw new Error(`Local replacement candidate changed after copy admission: ${candidatePath}`);
    }
    await fs.rm(candidatePath, { force: true });
    await db.update(schema.storageFiles).set({ missingSince: timestamp, updatedAt: timestamp }).where(eq(schema.storageFiles.filePath, candidatePath));
    removed.push(candidatePath);
  }
  return removed;
}

type CopySourceRow = typeof schema.copySources.$inferSelect;
type CopyOperationRow = typeof schema.copyOperations.$inferSelect;

async function prepareCopyOperation(
  db: DbExecutor,
  jobId: number,
  link: MediaLinkRow,
  destinationPath: string,
  previousCopySource: CopySourceRow | null,
  localConflictStrategy: CopyLocalConflictStrategy | undefined
): Promise<CopyOperationRow> {
  const existing = await first(
    db
      .select({ id: schema.copyOperations.id, stage: schema.copyOperations.stage, errorMessage: schema.copyOperations.errorMessage })
      .from(schema.copyOperations)
      .where(and(eq(schema.copyOperations.jobId, jobId), eq(schema.copyOperations.mediaLinkId, link.id)))
      .limit(1)
  );
  if (existing?.stage === "reconciliation_required") {
    throw new Error(`Copy operation #${existing.id} requires manual reconciliation: ${existing.errorMessage ?? "filesystem state is uncertain"}`);
  }
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
        tempIdentity: null,
        destinationIdentity: null,
        displacedIdentity: null,
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
          tempIdentity: null,
          destinationIdentity: null,
          displacedIdentity: null,
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

async function updateCopyOperation(db: DbExecutor, operationId: number, update: CopyOperationUpdate): Promise<void> {
  const row = await first(
    db
      .update(schema.copyOperations)
      .set({
        stage: update.stage,
        ...(update.tempPath !== undefined ? { tempPath: update.tempPath } : {}),
        ...(update.displacedPath !== undefined ? { displacedPath: update.displacedPath } : {}),
        ...(update.tempIdentity !== undefined ? { tempIdentity: update.tempIdentity } : {}),
        ...(update.destinationIdentity !== undefined ? { destinationIdentity: update.destinationIdentity } : {}),
        ...(update.displacedIdentity !== undefined ? { displacedIdentity: update.displacedIdentity } : {}),
        ...(update.sizeBytes !== undefined ? { sizeBytes: update.sizeBytes } : {}),
        ...(update.resultStatus !== undefined ? { resultStatus: update.resultStatus } : {}),
        updatedAt: nowIso()
      })
      .where(eq(schema.copyOperations.id, operationId))
      .returning({ id: schema.copyOperations.id })
  );
  if (!row) throw new Error(`Copy operation #${operationId} disappeared before its journal could be updated`);
}

async function commitCopyOperation(db: DbExecutor, operationId: number, link: MediaLinkRow, result: CopyMediaResult): Promise<void> {
  const timestamp = nowIso();
  await db
    .insert(schema.copySources)
    .values({ destinationPath: result.destinationPath, sourcePath: result.sourcePath, linkPath: result.linkPath, recordedAt: timestamp })
    .onConflictDoUpdate({
      target: schema.copySources.destinationPath,
      set: { sourcePath: result.sourcePath, linkPath: result.linkPath, recordedAt: timestamp }
    });
  await db
    .update(schema.mediaLinks)
    .set({
      targetPath: result.destinationPath,
      kind: result.destinationRootType,
      targetExists: true,
      sizeBytes: result.sizeBytes,
      updatedAt: timestamp
    })
    .where(eq(schema.mediaLinks.id, link.id));
  const operation = await first(db
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
    .where(eq(schema.copyOperations.id, operationId))
    .returning({ id: schema.copyOperations.id }));
  if (!operation) throw new Error(`Copy operation #${operationId} disappeared before commit`);
}

async function failCopyOperation(db: DbExecutor, operationId: number, message: string): Promise<void> {
  const row = await first(db
    .update(schema.copyOperations)
    .set({ stage: "failed", errorMessage: message, updatedAt: nowIso(), completedAt: nowIso() })
    .where(eq(schema.copyOperations.id, operationId))
    .returning({ id: schema.copyOperations.id }));
  if (!row) throw new Error(`Copy operation #${operationId} disappeared before failure could be recorded`);
}

async function requireCopyOperationReconciliation(db: DbExecutor, operationId: number, message: string): Promise<void> {
  const row = await first(db
    .update(schema.copyOperations)
    .set({ stage: "reconciliation_required", errorMessage: message, updatedAt: nowIso(), completedAt: null })
    .where(eq(schema.copyOperations.id, operationId))
    .returning({ id: schema.copyOperations.id }));
  if (!row) throw new Error(`Copy operation #${operationId} disappeared before reconciliation could be recorded`);
}

async function completeCopyOperationWithoutMutation(db: DbExecutor, operationId: number, result: CopyMediaResult): Promise<void> {
  const timestamp = nowIso();
  const row = await first(db
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
    .where(eq(schema.copyOperations.id, operationId))
    .returning({ id: schema.copyOperations.id }));
  if (!row) throw new Error(`Copy operation #${operationId} disappeared before completion could be recorded`);
}

interface CopyRollbackEntry {
  link: MediaLinkRow;
  result: CopyMediaResult;
  previousCopySource: CopySourceRow | null;
  displacedPath: string | null;
  destinationIdentity: string | null;
  displacedIdentity: string | null;
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

async function restoreCopySource(db: DbExecutor, entry: CopyRollbackEntry): Promise<void> {
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

function requiredJournalIdentity(rawIdentity: string | null, label: string): CopyFileIdentity {
  if (!rawIdentity) throw new Error(`${label} has no durable file identity; refusing automatic filesystem recovery`);
  try {
    return parseCopyFileIdentity(rawIdentity);
  } catch (error) {
    throw new Error(`${label} has an invalid durable file identity`, { cause: error });
  }
}

async function currentJournalFileIdentity(filePath: string, label: string): Promise<CopyFileIdentity | null> {
  const stat = await fs.lstat(filePath).catch((error: unknown) => {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return null;
    throw error;
  });
  if (!stat) return null;
  if (!stat.isFile()) throw new Error(`${label} is not a regular file`);
  const identity = await readCopyFileIdentity(filePath);
  if (!identity) throw new Error(`${label} disappeared while its identity was being checked`);
  return identity;
}

function assertJournalIdentity(actual: CopyFileIdentity, rawExpected: string | null, label: string): void {
  const expected = requiredJournalIdentity(rawExpected, label);
  if (!copyFileIdentitiesMatch(actual, expected)) throw new Error(`${label} changed after its file identity was journaled`);
}

async function rollbackCopiedMediaLink(
  db: Db,
  entry: CopyRollbackEntry,
  paths: PathsSettings,
  ctx: Pick<JobContext, "withLease" | "withLeaseDb">
): Promise<{ rolledBack: boolean; warning?: string }> {
  const currentTarget = await currentSymlinkTarget(entry.link.linkPath);
  const resolvedDestination = path.resolve(entry.result.destinationPath);
  const resolvedOriginal = path.resolve(entry.link.targetPath);
  if (currentTarget !== resolvedDestination && currentTarget !== resolvedOriginal) {
    return {
      rolledBack: false,
      warning: `Skipped rollback for ${entry.link.linkPath}; symlink no longer points to the job destination or original source`
    };
  }

  const originalRoot = entry.link.kind === "local" ? paths.localDir : entry.link.kind === "remote" ? paths.remoteDir : null;
  if (!originalRoot) return { rolledBack: false, warning: `Skipped rollback for ${entry.link.linkPath}; original target root is unknown` };
  await assertExistingPathInside(originalRoot, entry.link.targetPath, "Original copy source");
  await assertDestinationPathInside(entry.result.destinationRootType === "local" ? paths.localDir : paths.remoteDir, entry.result.destinationPath, "Copy destination");
  if (currentTarget === resolvedDestination) {
    await ctx.withLease(async () => {
      const lockedTarget = await currentSymlinkTarget(entry.link.linkPath);
      if (lockedTarget !== resolvedDestination) throw new Error("Symlink changed while copy rollback was waiting for its lease");
      await replaceSymlinkTarget(paths.symlinkDir, entry.link.linkPath, entry.link.targetPath);
    });
  }
  await ctx.withLeaseDb(async (leaseDb) => {
    await leaseDb
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
    await restoreCopySource(leaseDb, entry);
  });

  if (entry.result.status === "copied") {
    try {
      const restored = await ctx.withLease(async () => {
        const destinationIdentity = await currentJournalFileIdentity(entry.result.destinationPath, "Copy destination");
        const displacedIdentity = entry.displacedPath
          ? await currentJournalFileIdentity(entry.displacedPath, "Displaced copy destination")
          : null;

        if (
          currentTarget === resolvedOriginal &&
          entry.displacedPath &&
          destinationIdentity &&
          !displacedIdentity &&
          copyFileIdentitiesMatch(destinationIdentity, requiredJournalIdentity(entry.displacedIdentity, "Displaced copy destination"))
        ) {
          return true;
        }
        if (currentTarget === resolvedOriginal && !entry.displacedPath && !destinationIdentity) return true;

        if (destinationIdentity) {
          assertJournalIdentity(destinationIdentity, entry.destinationIdentity, "Copy destination");
          await assertExistingPathInside(entry.result.destinationRootType === "local" ? paths.localDir : paths.remoteDir, entry.result.destinationPath, "Copy destination");
          await fs.rm(entry.result.destinationPath, { force: true });
        }
        if (entry.displacedPath) {
          if (!displacedIdentity) throw new Error("Journaled displaced destination is missing");
          assertJournalIdentity(displacedIdentity, entry.displacedIdentity, "Displaced copy destination");
          const occupiedDestination = await currentJournalFileIdentity(entry.result.destinationPath, "Copy destination restore path");
          if (occupiedDestination) throw new Error("Copy destination became occupied before displaced-file restoration");
          await assertExistingPathInside(entry.result.destinationRootType === "local" ? paths.localDir : paths.remoteDir, entry.displacedPath, "Displaced copy destination");
          await assertDestinationPathInside(entry.result.destinationRootType === "local" ? paths.localDir : paths.remoteDir, entry.result.destinationPath, "Copy destination restore path");
          await fs.rename(entry.displacedPath, entry.result.destinationPath);
        }
        return true;
      });
      if (!restored) {
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

async function removeJournalFile(root: string, filePath: string | null, expectedIdentity: string | null, label: string): Promise<void> {
  if (!filePath) return;
  await assertDestinationPathInside(root, filePath, label);
  const actualIdentity = await currentJournalFileIdentity(filePath, label);
  if (!actualIdentity) return;
  assertJournalIdentity(actualIdentity, expectedIdentity, label);
  await assertExistingPathInside(root, filePath, label);
  await fs.rm(filePath, { force: true });
}

async function reconcileCopyOperationsForJob(
  db: Db,
  jobId: number,
  paths: PathsSettings,
  ctx: JobContext
): Promise<void> {
  const allOperations = await db.select().from(schema.copyOperations).where(eq(schema.copyOperations.jobId, jobId));
  const blockedOperation = allOperations.find((operation) => operation.stage === "reconciliation_required");
  if (blockedOperation) {
    throw new Error(
      `Copy operation #${blockedOperation.id} requires manual reconciliation: ${blockedOperation.errorMessage ?? "filesystem state is uncertain"}`
    );
  }
  const terminalStages = new Set(["committed", "rolled_back", "failed"]);
  const operations = allOperations.filter(
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
        const link = copyOperationLink(operation);
        await ctx.withLeaseDb(async (leaseDb) => {
          if ((await currentSymlinkTarget(operation.linkPath)) !== resolvedDestination) {
            throw new Error("Recovered symlink changed while copy recovery was waiting for its lease");
          }
          await assertExistingPathInside(destinationRoot, operation.destinationPath, "Recovered copy destination");
          const destinationIdentity = await currentJournalFileIdentity(operation.destinationPath, "Recovered copy destination");
          if (!destinationIdentity) throw new Error("Recovered copy destination is missing");
          assertJournalIdentity(destinationIdentity, operation.destinationIdentity, "Recovered copy destination");
          const stat = await fs.stat(operation.destinationPath);
          const result = copyOperationResult(operation, paths, stat.size);
          await removeJournalFile(destinationRoot, operation.tempPath, operation.tempIdentity, "Temporary copy");
          await commitCopyOperation(leaseDb, operation.id, link, result);
        });
        await ctx.event("warn", "Recovered copy operation after worker interruption", {
          operationId: operation.id,
          linkPath: operation.linkPath,
          destinationPath: operation.destinationPath,
          resolution: "committed"
        });
        continue;
      }

      if (currentTarget === resolvedOriginal) {
        await ctx.withLease(async () => {
          if ((await currentSymlinkTarget(operation.linkPath)) !== resolvedOriginal) {
            throw new Error("Recovered symlink changed while copy rollback was waiting for its lease");
          }
          const tempIdentity = operation.tempPath
            ? await currentJournalFileIdentity(operation.tempPath, "Temporary copy")
            : null;
          if ((operation.stage === "promoted" || operation.stage === "repointed") && operation.resultStatus !== "repointed" && !tempIdentity) {
            await removeJournalFile(destinationRoot, operation.destinationPath, operation.destinationIdentity, "Uncommitted promoted copy");
          }
          await removeJournalFile(destinationRoot, operation.tempPath, operation.tempIdentity, "Temporary copy");
          if (operation.displacedPath) {
            const destinationIdentity = await currentJournalFileIdentity(operation.destinationPath, "Destination restore path");
            const displacedIdentity = await currentJournalFileIdentity(operation.displacedPath, "Displaced destination");
            if (destinationIdentity && displacedIdentity) {
              throw new Error("Cannot restore displaced destination because its original path is occupied");
            }
            if (!destinationIdentity && displacedIdentity) {
              assertJournalIdentity(displacedIdentity, operation.displacedIdentity, "Displaced destination");
              await assertExistingPathInside(destinationRoot, operation.displacedPath, "Displaced destination");
              await assertDestinationPathInside(destinationRoot, operation.destinationPath, "Destination restore path");
              await fs.rename(operation.displacedPath, operation.destinationPath);
            } else if (destinationIdentity && operation.displacedIdentity) {
              assertJournalIdentity(destinationIdentity, operation.displacedIdentity, "Restored displaced destination");
            } else if (!destinationIdentity) {
              throw new Error("Journaled displaced destination is missing from both paths");
            }
          }
        });
        const timestamp = nowIso();
        await ctx.withLeaseDb(async (leaseDb) => {
          await leaseDb
            .update(schema.copyOperations)
            .set({
              stage: "rolled_back",
              tempPath: null,
              displacedPath: null,
              tempIdentity: null,
              destinationIdentity: null,
              displacedIdentity: null,
              errorMessage: null,
              updatedAt: timestamp,
              completedAt: timestamp
            })
            .where(eq(schema.copyOperations.id, operation.id));
        });
        await ctx.event("warn", "Rolled back incomplete copy operation after worker interruption", {
          operationId: operation.id,
          linkPath: operation.linkPath,
          resolution: "rolled_back"
        });
        continue;
      }

      throw new Error("Symlink no longer points to either the original target or the journaled destination");
    } catch (error: unknown) {
      if (error instanceof LeaseLostError || (error instanceof Error && error.name === "LeaseLostError")) throw error;
      const message = errorMessage(error);
      await ctx.withLeaseDb(async (leaseDb) => {
        await leaseDb
          .update(schema.copyOperations)
          .set({ stage: "reconciliation_required", errorMessage: message, updatedAt: nowIso() })
          .where(eq(schema.copyOperations.id, operation.id));
      });
      await ctx.event("error", "Copy operation requires manual reconciliation", {
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
  ctx: JobContext
): Promise<{ rolledBack: number; warnings: string[] }> {
  await reconcileCopyOperationsForJob(db, jobId, paths, ctx);
  const operations = (await db.select().from(schema.copyOperations).where(and(eq(schema.copyOperations.jobId, jobId), eq(schema.copyOperations.stage, "committed")))).reverse();
  let rolledBack = 0;
  const warnings: string[] = [];

  for (const operation of operations) {
    if (operation.resultStatus !== "copied" && operation.resultStatus !== "repointed") {
      await ctx.withLeaseDb(async (leaseDb) => {
        await leaseDb
          .update(schema.copyOperations)
          .set({ stage: "rolled_back", updatedAt: nowIso(), completedAt: nowIso() })
          .where(eq(schema.copyOperations.id, operation.id));
      });
      continue;
    }
    try {
      const link = copyOperationLink(operation);
      const result = copyOperationResult(operation, paths, operation.sizeBytes ?? link.sizeBytes ?? 0);
      const rollback = await rollbackCopiedMediaLink(
        db,
        {
          link,
          result,
          previousCopySource: copyOperationPreviousSource(operation),
          displacedPath: operation.displacedPath,
          destinationIdentity: operation.destinationIdentity,
          displacedIdentity: operation.displacedIdentity
        },
        paths,
        ctx
      );
      if (rollback.rolledBack) {
        rolledBack += 1;
        await ctx.withLeaseDb(async (leaseDb) => {
          await leaseDb
            .update(schema.copyOperations)
            .set({ stage: "rolled_back", errorMessage: null, updatedAt: nowIso(), completedAt: nowIso() })
            .where(eq(schema.copyOperations.id, operation.id));
        });
      }
      if (rollback.warning) warnings.push(rollback.warning);
    } catch (error: unknown) {
      if (error instanceof LeaseLostError || (error instanceof Error && error.name === "LeaseLostError")) throw error;
      const warning = `Rollback failed for ${operation.linkPath}: ${errorMessage(error)}`;
      warnings.push(warning);
      await ctx.withLeaseDb(async (leaseDb) => {
        await leaseDb
          .update(schema.copyOperations)
          .set({ stage: "reconciliation_required", errorMessage: warning, updatedAt: nowIso() })
          .where(eq(schema.copyOperations.id, operation.id));
      });
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

function toJobRecord(row: JobRow): LeasedJob {
  const progress = parseJson(row.progress);
  const options = parseJson(row.options);
  const normalizedProgress = normalizeJobProgress(row.type, row.status, progressWithOptions(progress, options));
  const status = normalizeJobStatus(row.type, row.status, progress);
  return {
    ...row,
    type: row.type as JobRecord["type"],
    status,
    options,
    selectionFrozen: row.selectionFrozen,
    progress: normalizedProgress,
    leaseVersion: row.leaseVersion,
    exclusive: row.exclusive
  };
}

function legacySelectionCount(job: JobRecord): number {
  const options = jobProgressOptions<{ linkIds?: unknown }>(job);
  return Array.isArray(options?.linkIds) ? options.linkIds.length : 0;
}

async function attachJobSelections(db: DbExecutor, jobs: JobRecord[]): Promise<JobRecord[]> {
  const selectedJobs = jobs.filter((job) => job.selectionFrozen);
  if (selectedJobs.length === 0) return jobs;
  const jobIds = selectedJobs.map((job) => job.id);
  const titleRows = await dbAll<{ jobId: number; section: string; itemName: string; count: number; titleCount: number; selectionCount: number }>(db as Db, sql`
    WITH selected_job_ids AS (
      SELECT value::integer AS job_id
      FROM jsonb_array_elements_text(${JSON.stringify(jobIds)}::jsonb)
    ), title_counts AS (
      SELECT items.job_id,
             items.section,
             items.item_name,
             count(*)::integer AS count
      FROM job_selection_items AS items
      JOIN selected_job_ids ON selected_job_ids.job_id = items.job_id
      GROUP BY items.job_id, items.section, items.item_name
    ), ranked_titles AS (
      SELECT title_counts.*,
             count(*) OVER (PARTITION BY title_counts.job_id)::integer AS title_count,
             sum(title_counts.count) OVER (PARTITION BY title_counts.job_id)::integer AS selection_count,
             row_number() OVER (PARTITION BY title_counts.job_id ORDER BY title_counts.item_name, title_counts.section) AS title_order
      FROM title_counts
    )
    SELECT ranked_titles.job_id AS "jobId",
           ranked_titles.section,
           ranked_titles.item_name AS "itemName",
           ranked_titles.count,
           ranked_titles.title_count AS "titleCount",
           ranked_titles.selection_count AS "selectionCount"
    FROM ranked_titles
    WHERE ranked_titles.title_order <= ${maxSelectionTitlesPerJob}
    ORDER BY ranked_titles.job_id, ranked_titles.title_order
  `);
  const activeJobIds = selectedJobs.filter((job) => job.status === "queued" || job.status === "running").map((job) => job.id);
  const activeLinkRows = activeJobIds.length === 0
    ? []
    : await dbAll<{ jobId: number; mediaLinkId: number; selectionOrder: number }>(db as Db, sql`
        WITH active_job_ids AS (
          SELECT value::integer AS job_id
          FROM jsonb_array_elements_text(${JSON.stringify(activeJobIds)}::jsonb)
        ), eligible_jobs AS (
          SELECT items.job_id
          FROM job_selection_items AS items
          JOIN active_job_ids ON active_job_ids.job_id = items.job_id
          GROUP BY items.job_id
          HAVING count(*) <= ${maxAdvisorySelectionLinkIds}
        )
        SELECT items.job_id AS "jobId",
               items.media_link_id AS "mediaLinkId",
               items.selection_order AS "selectionOrder"
        FROM job_selection_items AS items
        JOIN eligible_jobs ON eligible_jobs.job_id = items.job_id
        ORDER BY items.job_id, items.selection_order
      `);
  const summaryByJobId = new Map<number, JobSelectionSummary>();
  const titleCountByJobId = new Map<number, number>();
  const selectionCountByJobId = new Map<number, number>();
  for (const job of selectedJobs) {
    summaryByJobId.set(job.id, { total: legacySelectionCount(job), titles: [], unavailable: 0 });
  }
  for (const row of titleRows) {
    const summary = summaryByJobId.get(row.jobId);
    if (!summary) continue;
    summary.titles.push({ section: row.section, itemName: row.itemName, count: Number(row.count) });
    titleCountByJobId.set(row.jobId, Number(row.titleCount));
    selectionCountByJobId.set(row.jobId, Number(row.selectionCount));
  }
  for (const [jobId, summary] of summaryByJobId) {
    const snapshotCount = selectionCountByJobId.get(jobId) ?? 0;
    summary.total = Math.max(summary.total, snapshotCount);
    summary.unavailable = Math.max(0, summary.total - snapshotCount);
    const omittedTitles = Math.max(0, (titleCountByJobId.get(jobId) ?? summary.titles.length) - summary.titles.length);
    if (omittedTitles > 0) summary.omittedTitles = omittedTitles;
  }
  for (const row of activeLinkRows) {
    const summary = summaryByJobId.get(row.jobId);
    if (!summary) continue;
    (summary.linkIds ??= []).push(row.mediaLinkId);
  }
  return jobs.map((job) => ({ ...job, ...(summaryByJobId.has(job.id) ? { selection: summaryByJobId.get(job.id) } : {}) }));
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

export class JobRunner {
  constructor(private readonly db: Db) {}

  async createJob(type: JobRecord["type"], progress: unknown = {}): Promise<number> {
    return this.enqueueJob(type, progress, true, []);
  }

  private async enqueueJob(type: JobRecord["type"], progress: unknown, exclusive: boolean, requestedClaims: ResourceClaim[]): Promise<number> {
    return this.enqueuePreparedJob(type, async () => ({ progress, options: progressOptions(progress), exclusive, claims: requestedClaims }));
  }

  private async enqueuePreparedJob(type: JobRecord["type"], prepare: (db: DbExecutor) => Promise<PreparedJob>): Promise<number> {
    await reconcileProvablySettledCopyOperations(this.db);
    if (type !== "path_migration" && (await isPathConfigurationBlocked(this.db))) {
      throw new Error("Managed storage paths changed. Resolve the required path migration before starting another job.");
    }
    return this.db.transaction(async (transaction) => {
      await transaction.execute(sql`select pg_advisory_xact_lock(${schedulerLockKey})`);
      if (type !== "path_migration" && (await isPathConfigurationBlocked(transaction))) {
        throw new Error("Managed storage paths changed. Resolve the required path migration before starting another job.");
      }
      const prepared = await prepare(transaction);
      const claims = normalizeResourceClaims(prepared.claims);

      if (!prepared.exclusive && claims.length > 0) {
        const conflict = await dbGet<{ jobId: number; status: string; overlapCount: number }>(transaction, sql`
          WITH requested_claims AS (
            SELECT "resourceType" AS resource_type, "resourceKey" AS resource_key, access
            FROM jsonb_to_recordset(${JSON.stringify(claims)}::jsonb)
              AS requested("resourceType" text, "resourceKey" text, access text)
          ), blocking_claims AS (
            SELECT active.job_id, active.resource_type, active.resource_key, active.access, jobs.status
            FROM job_resource_claims AS active
            JOIN jobs ON jobs.id = active.job_id
            WHERE jobs.status IN ('queued', 'running')
            UNION
            SELECT copy_operations.job_id, 'media'::text, copy_operations.media_link_id::text, 'exclusive'::text, 'reconciliation_required'::text AS status
            FROM copy_operations
            WHERE ${unresolvedCopyReconciliation()}
            UNION
            SELECT copy_operations.job_id, 'path'::text, paths.resource_key, 'exclusive'::text, 'reconciliation_required'::text AS status
            FROM copy_operations
            CROSS JOIN LATERAL unnest(ARRAY[
              copy_operations.link_path,
              copy_operations.source_path,
              copy_operations.destination_path,
              copy_operations.temp_path,
              copy_operations.displaced_path
            ]) AS paths(resource_key)
            WHERE ${unresolvedCopyReconciliation()}
              AND paths.resource_key IS NOT NULL
            UNION
            SELECT copy_operations.job_id, 'path'::text, binding_paths.resource_key, 'exclusive'::text, 'reconciliation_required'::text AS status
            FROM copy_operations
            JOIN job_resource_claims AS binding
              ON binding.job_id = copy_operations.job_id
             AND binding.resource_type = 'copy_path_binding'
             AND binding.resource_key::jsonb ->> 0 = copy_operations.media_link_id::text
            CROSS JOIN LATERAL (VALUES (binding.resource_key::jsonb ->> 2), (binding.resource_key::jsonb ->> 3)) AS binding_paths(resource_key)
            WHERE ${unresolvedCopyReconciliation()}
              AND binding_paths.resource_key IS NOT NULL
          )
          SELECT active.job_id AS "jobId",
                 active.status,
                 greatest(1, count(*) FILTER (WHERE requested.resource_type = 'media'))::integer AS "overlapCount"
          FROM requested_claims AS requested
          JOIN blocking_claims AS active
            ON active.resource_type = requested.resource_type
           AND active.resource_key = requested.resource_key
           AND (active.access = 'exclusive' OR requested.access = 'exclusive')
          GROUP BY active.job_id, active.status
          ORDER BY active.job_id
          LIMIT 1
        `);
        if (conflict) {
          if (conflict.status === "reconciliation_required") {
            throw new Error(
              `Copy data from job #${conflict.jobId} requires manual reconciliation before another action can touch the same media item or managed path.`
            );
          }
          throw new Error(
            `Job #${conflict.jobId} is already ${conflict.status} for ${conflict.overlapCount} matching media item${conflict.overlapCount === 1 ? "" : "s"}. Wait for it to finish or terminate it before queuing another action.`
          );
        }
      }

      const timestamp = nowIso();
      const selection = prepared.selection ?? [];
      const selectionFrozen = prepared.selectionFrozen === true;
      const immutableOptions = selectionFrozen ? compactFrozenOptions(prepared.options ?? progressOptions(prepared.progress)) : (prepared.options ?? progressOptions(prepared.progress));
      const row = await first(
        transaction
          .insert(schema.jobs)
          .values({
            type,
            status: "queued",
            createdAt: timestamp,
            startedAt: null,
            finishedAt: null,
            lockedBy: null,
            lockedAt: null,
            heartbeatAt: null,
            leaseVersion: 0,
            exclusive: prepared.exclusive,
            options: JSON.stringify(immutableOptions),
            selectionFrozen,
            cancelRequestedAt: null,
            progress: JSON.stringify(compactJobProgress(prepared.progress))
          })
          .returning({ id: schema.jobs.id })
      );
      if (!row) throw new Error("Job was not queued");
      for (let offset = 0; offset < selection.length; offset += 500) {
        await transaction.insert(schema.jobSelectionItems).values(
          selection.slice(offset, offset + 500).map((link, index) => ({
            jobId: row.id,
            mediaLinkId: link.id,
            selectionOrder: offset + index,
            section: link.section,
            itemName: link.itemName,
            relativePath: link.relativePath,
            linkPath: link.linkPath,
            createdAt: timestamp
          }))
        );
      }
      for (let offset = 0; offset < claims.length; offset += 500) {
        await transaction.insert(schema.jobResourceClaims).values(
          claims.slice(offset, offset + 500).map((claim) => ({
            jobId: row.id,
            resourceType: claim.resourceType,
            resourceKey: claim.resourceKey,
            access: claim.access,
            createdAt: timestamp
          }))
        );
      }
      await transaction.insert(schema.jobEvents).values({ jobId: row.id, timestamp, level: "info", message: "Job queued", data: JSON.stringify({ type }) });
      return row.id;
    });
  }

  async listJobs(options: JobListOptions = {}): Promise<JobRecord[]> {
    const limit = Math.min(Math.max(options.limit ?? 500, 1), 1000);
    const activeStatuses: JobStatus[] = ["queued", "running"];
    const terminalStatuses: JobStatus[] = ["completed", "partially_failed", "failed", "cancelled"];
    const activeRows = await this.db.select().from(schema.jobs).where(inArray(schema.jobs.status, activeStatuses)).orderBy(desc(schema.jobs.id));
    if (options.activeOnly) return attachJobSelections(this.db, activeRows.map(toJobRecord));

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
    return attachJobSelections(this.db, [...activeRows, ...terminalRows].sort((a, b) => b.id - a.id).map(toJobRecord));
  }

  async getJob(jobId: number): Promise<JobRecord | null> {
    const row = await first(this.db.select().from(schema.jobs).where(eq(schema.jobs.id, jobId)).limit(1));
    if (!row) return null;
    return (await attachJobSelections(this.db, [toJobRecord(row)]))[0] ?? null;
  }

  async copyReconciliationState(): Promise<CopyReconciliationState> {
    const unresolved = await listCopyReconciliation(this.db);
    return { unresolved, unresolvedCount: unresolved.length, resolvedNow: 0 };
  }

  async recheckCopyReconciliation(): Promise<CopyReconciliationState> {
    return reconcileProvablySettledCopyOperations(this.db);
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
    return this.db.transaction(async (transaction) => {
      const row = await first(transaction.select().from(schema.jobs).where(eq(schema.jobs.id, jobId)).for("update").limit(1));
      if (!row) return false;
      const job = toJobRecord(row);
      const timestamp = nowIso();
      if (job.status === "queued") {
        const terminated = await first(
          transaction
            .update(schema.jobs)
            .set({ status: "cancelled", finishedAt: timestamp, cancelRequestedAt: timestamp })
            .where(and(eq(schema.jobs.id, jobId), eq(schema.jobs.status, "queued")))
            .returning({ id: schema.jobs.id })
        );
        if (!terminated) return false;
        if (job.type === "path_migration" && isRecord(job.progress) && Number.isInteger(job.progress.migrationId)) {
          await transaction
            .update(schema.pathMigrations)
            .set({ status: "failed", finishedAt: timestamp, errorMessage: "Path migration was terminated before it started. Analyze the path change again or restore the previous environment paths." })
            .where(and(eq(schema.pathMigrations.id, Number(job.progress.migrationId)), eq(schema.pathMigrations.status, "queued")));
        }
        await transaction.insert(schema.jobEvents).values({ jobId, timestamp, level: "warn", message: "Queued job terminated", data: "{}" });
        return true;
      }
      if (job.status === "running") {
        const requested = await first(
          transaction
            .update(schema.jobs)
            .set({ cancelRequestedAt: timestamp })
            .where(and(eq(schema.jobs.id, jobId), eq(schema.jobs.status, "running")))
            .returning({ id: schema.jobs.id })
        );
        if (!requested) return false;
        await transaction.insert(schema.jobEvents).values({ jobId, timestamp, level: "warn", message: "Termination requested", data: "{}" });
        return true;
      }
      return false;
    });
  }

  async cancel(jobId: number): Promise<boolean> {
    return this.terminate(jobId);
  }

  async startScan(options: ScanOptions = defaultScanOptions): Promise<number> {
    const normalizedOptions = await normalizeScanOptions(this.db, options);
    const targeted = Boolean(normalizedOptions.titleScopes?.length);
    if (!targeted) return this.enqueueJob("scan", { options: normalizedOptions }, true, []);
    return this.enqueuePreparedJob("scan", async (transaction) => {
      const scanLinks = filterScanLinks(await listMediaLinks(transaction, undefined, "current"), normalizedOptions);
      const paths = await getJsonSetting<PathsSettings>(transaction, "paths", { symlinkDir: "", localDir: "", remoteDir: "" });
      if (!paths.symlinkDir || !paths.localDir || !paths.remoteDir) throw new Error("Path settings are incomplete");
      const availableScopes = new Set(scanLinks.map((link) => `${link.section}\0${link.itemName}`));
      const unavailableScopes = (normalizedOptions.titleScopes ?? []).filter(
        (scope) => !availableScopes.has(`${scope.section}\0${scope.itemName}`)
      );
      if (unavailableScopes.length > 0) {
        throw new Error(`Title is not available in the current symlink inventory: ${unavailableScopes.map((scope) => scope.itemName).join(", ")}`);
      }
      return {
        progress: { options: normalizedOptions },
        options: normalizedOptions,
        exclusive: false,
        claims: await titleScanResourceClaims(normalizedOptions, scanLinks, paths)
      };
    });
  }

  async startAudit(input: AuditMode | AuditOptions): Promise<number> {
    const normalizedOptions = await normalizeAuditOptions(this.db, input);
    const advancedSettings = normalizeAdvancedSettings(await getJsonSetting<unknown>(this.db, "advancedSettings", {}));
    const requestedOptions: Partial<AuditOptions> = typeof input === "string" ? {} : input;
    const optionsWithDefaults: AuditOptions = {
      ...normalizedOptions,
      ...(requestedOptions.byteCompare === undefined && !advancedSettings.audit.byteCompareWhenSourceKnown ? { byteCompare: false } : {})
    };
    const scoped = hasScopedAuditOptions(optionsWithDefaults);
    if (!scoped) return this.enqueueJob("audit", { options: optionsWithDefaults }, true, []);
    return this.enqueuePreparedJob("audit", async (transaction) => {
      const auditLinks = filterAuditLinks(await listMediaLinks(transaction, undefined, "current"), optionsWithDefaults);
      const paths = await getJsonSetting<PathsSettings>(transaction, "paths", { symlinkDir: "", localDir: "", remoteDir: "" });
      if (!paths.symlinkDir || !paths.localDir || !paths.remoteDir) throw new Error("Path settings are incomplete");
      const frozenOptions = { ...optionsWithDefaults, linkIds: auditLinks.map((link) => link.id) };
      return {
        progress: { options: frozenOptions },
        options: frozenOptions,
        selection: auditLinks,
        selectionFrozen: true,
        exclusive: false,
        claims: await auditResourceClaims(auditLinks, paths)
      };
    });
  }

  async startCopy(input: CopyOptions): Promise<number> {
    const normalizedOptions = await normalizeCopyOptions(this.db, input);
    const links = await listMediaLinks(this.db, undefined, "current");
    const orderedSelectedLinks = orderedCopySelection(links, normalizedOptions);
    const claimedLinks = normalizedOptions.linkIds === undefined ? orderedSelectedLinks : filterCopySelectedLinks(links, normalizedOptions);
    const optionsWithResolvedLinks = { ...normalizedOptions, linkIds: orderedSelectedLinks.map((link) => link.id) };
    const advancedSettings = normalizeAdvancedSettings(await getJsonSetting<unknown>(this.db, "advancedSettings", {}));
    const storedOptions: StoredCopyOptions = { ...optionsWithResolvedLinks, behavior: advancedSettings.copy };
    const paths = await getJsonSetting<PathsSettings>(this.db, "paths", { symlinkDir: "", localDir: "", remoteDir: "" });
    if (!paths.localDir || !paths.remoteDir) throw new Error("Path settings are incomplete");
    const replacementClaims = await copyReplacementResourceClaims(this.db, orderedSelectedLinks, paths, optionsWithResolvedLinks);
    const expectedSelection = copyAdmissionSelectionFingerprint(orderedSelectedLinks);
    const expectedClaimedSelection = copyAdmissionSelectionFingerprint(claimedLinks);
    return this.enqueuePreparedJob("copy", async (transaction) => {
      const currentLinks = await listMediaLinks(transaction, undefined, "current");
      const currentSelection = orderedCopySelection(currentLinks, normalizedOptions);
      const currentClaimedSelection = normalizedOptions.linkIds === undefined ? currentSelection : filterCopySelectedLinks(currentLinks, normalizedOptions);
      const currentPaths = await getJsonSetting<PathsSettings>(transaction, "paths", { symlinkDir: "", localDir: "", remoteDir: "" });
      if (
        copyAdmissionSelectionFingerprint(currentSelection) !== expectedSelection ||
        copyAdmissionSelectionFingerprint(currentClaimedSelection) !== expectedClaimedSelection ||
        currentPaths.symlinkDir !== paths.symlinkDir ||
        currentPaths.localDir !== paths.localDir ||
        currentPaths.remoteDir !== paths.remoteDir
      ) {
        throw new Error("Copy selection changed while the job was being prepared. Review the current inventory and queue it again.");
      }
      return {
        progress: { options: storedOptions },
        options: storedOptions,
        selection: orderedSelectedLinks,
        selectionFrozen: true,
        exclusive: false,
        claims: [...(await copyResourceClaims(orderedSelectedLinks, claimedLinks, paths, normalizedOptions)), ...replacementClaims]
      };
    });
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
    const jobId = await this.db.transaction(async (transaction) => {
      await transaction.execute(sql`select pg_advisory_xact_lock(${schedulerLockKey})`);
      const readyMigration = await first(transaction.select().from(schema.pathMigrations).where(eq(schema.pathMigrations.id, migrationId)).for("update").limit(1));
      if (!readyMigration || readyMigration.status !== "planned") throw new Error("Analyze the path change before starting migration");
      const blocked = await first(
        transaction
          .select({ value: count() })
          .from(schema.pathMigrationItems)
          .where(and(eq(schema.pathMigrationItems.migrationId, migrationId), eq(schema.pathMigrationItems.validationStatus, "blocked")))
      );
      if (Number(blocked?.value ?? 0) > 0) throw new Error("Resolve every blocked symlink before starting migration");
      const timestamp = nowIso();
      const row = await first(
        transaction
          .insert(schema.jobs)
          .values({
            type: "path_migration",
            status: "queued",
            createdAt: timestamp,
            startedAt: null,
            finishedAt: null,
            lockedBy: null,
            lockedAt: null,
            heartbeatAt: null,
            leaseVersion: 0,
            exclusive: true,
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
      await transaction.insert(schema.jobEvents).values({ jobId: row.id, timestamp, level: "info", message: "Job queued", data: JSON.stringify({ type: "path_migration", migrationId }) });
      return row.id;
    });
    return jobId;
  }
}

export class JobWorker {
  private readonly workerId: string;
  private readonly pollIntervalMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly reclaimStaleAfterMs: number;
  private readonly reclaimOwnInterruptedAfterMs: number;
  private readonly dispatchConcurrency: number;
  private readonly logger: Pick<Console, "info" | "warn" | "error">;
  private readonly copyRunner: CopyCommandRunner;
  private readonly auditRunner: AuditCommandRunner;
  private readonly concurrency: JobConcurrencySettings;
  private readonly copyTransferLimiter: CopyTransferLimiter;
  private readonly activeAbortControllers = new Map<number, AbortController>();
  private readonly activeRuns = new Set<Promise<void>>();
  private stopRequested = false;
  private loopRunning = false;
  private sleepTimer: NodeJS.Timeout | null = null;
  private resolveSleep: (() => void) | null = null;

  constructor(private readonly db: Db, options: JobWorkerOptions = {}) {
    this.workerId = options.workerId ?? `worker-${process.pid}`;
    this.pollIntervalMs = options.pollIntervalMs ?? 2000;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 10_000;
    this.reclaimStaleAfterMs = options.reclaimStaleAfterMs ?? 15 * 60_000;
    this.reclaimOwnInterruptedAfterMs = options.reclaimOwnInterruptedAfterMs ?? Math.max(30_000, this.heartbeatIntervalMs * 2);
    this.dispatchConcurrency = options.dispatchConcurrency ?? 1;
    if (!Number.isSafeInteger(this.dispatchConcurrency) || this.dispatchConcurrency < 1) throw new Error("Worker dispatch concurrency must be a positive safe integer");
    this.logger = options.logger ?? console;
    this.copyRunner = options.copyRunner ?? defaultCopyRunner;
    this.auditRunner = options.auditRunner ?? defaultAuditRunner;
    this.concurrency = options.concurrency ?? defaultJobConcurrency;
    this.copyTransferLimiter = options.copyTransferLimiter ?? new CopyTransferLimiter(this.concurrency.maxActiveCopyFiles);
  }

  async start(): Promise<void> {
    if (this.loopRunning) return;
    this.loopRunning = true;
    this.stopRequested = false;
    this.logger.info(
      `SRTL worker ${this.workerId} started with limits: jobs=${this.concurrency.maxRunningJobs}, scans=${this.concurrency.maxRunningScans}, audits=${this.concurrency.maxRunningAudits}, copies=${this.concurrency.maxRunningCopies}`
    );
    try {
      while (!this.stopRequested) {
        let claimedAny = false;
        while (!this.stopRequested && this.activeRuns.size < this.dispatchConcurrency) {
          if (await isPathConfigurationBlocked(this.db)) await this.requeueInterruptedJobsForPathMigration();
          const claimed = await this.claimNextJob();
          if (this.stopRequested) {
            if (claimed) await this.requeueInterruptedJob(claimed.job);
            break;
          }
          if (!claimed) break;
          claimedAny = true;
          const run = this.runClaimedJob(claimed.job)
            .catch((error: unknown) => {
              this.logger.error(`SRTL worker ${this.workerId} dispatcher failed job #${claimed.job.id}: ${errorMessage(error)}`);
            })
            .finally(() => {
              this.activeRuns.delete(run);
              this.wake();
            });
          this.activeRuns.add(run);
        }
        if (!this.stopRequested && (!claimedAny || this.activeRuns.size >= this.dispatchConcurrency)) {
          await this.sleep(this.pollIntervalMs);
        }
      }
    } finally {
      this.stopRequested = true;
      for (const abortController of this.activeAbortControllers.values()) {
        if (!abortController.signal.aborted) abortController.abort(new WorkerShutdownError());
      }
      await Promise.allSettled([...this.activeRuns]);
      this.loopRunning = false;
      this.logger.info(`SRTL worker ${this.workerId} stopped`);
    }
  }

  stop(): void {
    this.stopRequested = true;
    for (const abortController of this.activeAbortControllers.values()) {
      if (!abortController.signal.aborted) abortController.abort(new WorkerShutdownError());
    }
    this.wake();
  }

  async runOnce(): Promise<boolean> {
    if (this.stopRequested) return false;
    if (await isPathConfigurationBlocked(this.db)) await this.requeueInterruptedJobsForPathMigration();
    if (this.stopRequested) return false;
    const claimed = await this.claimNextJob();
    if (!claimed) return false;
    if (this.stopRequested) {
      await this.requeueInterruptedJob(claimed.job);
      return false;
    }
    await this.runClaimedJob(claimed.job);
    return true;
  }

  private wake(): void {
    if (this.sleepTimer) clearTimeout(this.sleepTimer);
    this.sleepTimer = null;
    this.resolveSleep?.();
    this.resolveSleep = null;
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

  private isReclaimableWithHeartbeat(
    job: LeasedJob,
    ownerHeartbeat: typeof schema.workerHeartbeats.$inferSelect | undefined
  ): boolean {
    if (job.lockedBy === this.workerId) {
      if (this.activeAbortControllers.has(job.id)) return false;
      return isStaleRunningJob(job, this.reclaimOwnInterruptedAfterMs);
    }
    if (!ownerHeartbeat) return isStaleRunningJob(job, this.reclaimStaleAfterMs);
    if (ownerHeartbeat.status !== "running") return true;
    const ownerHeartbeatAt = Date.parse(ownerHeartbeat.heartbeatAt);
    const processHeartbeatStale =
      !Number.isFinite(ownerHeartbeatAt) || Date.now() - ownerHeartbeatAt >= this.reclaimOwnInterruptedAfterMs;
    return processHeartbeatStale && isStaleRunningJob(job, this.reclaimOwnInterruptedAfterMs);
  }

  private async claimNextJob(): Promise<ClaimedJob | null> {
    return this.db.transaction(async (transaction) => {
      await transaction.execute(sql`select pg_advisory_xact_lock(${schedulerLockKey})`);
      const pathConfigurationBlocked = await isPathConfigurationBlocked(transaction);
      const recoveryCopyJobIds = pathConfigurationBlocked
        ? new Set(
            (
              await transaction.execute<{ jobId: number }>(sql`
                select distinct jobs.id as "jobId"
                from jobs
                join copy_operations on copy_operations.job_id = jobs.id
                where jobs.type = 'copy'
                  and jobs.status in ('queued', 'running')
                  and copy_operations.stage not in ('rolled_back', 'failed')
              `)
            ).rows.map((row) => row.jobId)
          )
        : new Set<number>();
      const allowedWhilePathsBlocked = (job: Pick<JobRow, "id" | "type">): boolean =>
        job.type === "path_migration" || (job.type === "copy" && recoveryCopyJobIds.has(job.id));
      const initialRunningRows = await transaction.select().from(schema.jobs).where(eq(schema.jobs.status, "running")).orderBy(asc(schema.jobs.id));
      const initialRunningJobs = initialRunningRows.map(toJobRecord);
      const ownerIds = [...new Set(initialRunningJobs.map((job) => job.lockedBy).filter((ownerId): ownerId is string => Boolean(ownerId)))];
      const ownerHeartbeats = ownerIds.length > 0
        ? await transaction.select().from(schema.workerHeartbeats).where(inArray(schema.workerHeartbeats.workerId, ownerIds))
        : [];
      const ownerHeartbeatById = new Map(ownerHeartbeats.map((heartbeat) => [heartbeat.workerId, heartbeat]));
      const isReclaimable = (job: LeasedJob): boolean =>
        this.isReclaimableWithHeartbeat(job, job.lockedBy ? ownerHeartbeatById.get(job.lockedBy) : undefined);
      const eligibleRunning = pathConfigurationBlocked ? initialRunningJobs.filter(allowedWhilePathsBlocked) : initialRunningJobs;
      const staleCandidates = eligibleRunning.filter(isReclaimable);
      const fencedJobIds = new Set<number>();
      for (const staleCandidate of staleCandidates) {
        const lockedStaleRow = await first(
          transaction
            .select()
            .from(schema.jobs)
            .where(
              and(
                eq(schema.jobs.id, staleCandidate.id),
                eq(schema.jobs.status, "running"),
                eq(schema.jobs.leaseVersion, staleCandidate.leaseVersion)
              )
            )
            .for("update", { skipLocked: true })
            .limit(1)
        );
        if (!lockedStaleRow) continue;
        const stale = toJobRecord(lockedStaleRow);
        const lockedOwnerHeartbeat = stale.lockedBy && stale.lockedBy !== this.workerId
          ? await first(
              transaction
                .select()
                .from(schema.workerHeartbeats)
                .where(eq(schema.workerHeartbeats.workerId, stale.lockedBy))
                .for("update")
                .limit(1)
            )
          : undefined;
        if (!this.isReclaimableWithHeartbeat(stale, lockedOwnerHeartbeat)) continue;
        const interruptedOwn = stale.lockedBy === this.workerId;
        const timestamp = nowIso();
        const ownerFilter = stale.lockedBy == null ? isNull(schema.jobs.lockedBy) : eq(schema.jobs.lockedBy, stale.lockedBy);
        const fencedRow = await first(
          transaction
            .update(schema.jobs)
            .set({
              status: "queued",
              lockedBy: null,
              lockedAt: null,
              heartbeatAt: null,
              leaseVersion: sql`${schema.jobs.leaseVersion} + 1`
            })
            .where(
              and(
                eq(schema.jobs.id, stale.id),
                eq(schema.jobs.status, "running"),
                ownerFilter,
                eq(schema.jobs.leaseVersion, stale.leaseVersion)
              )
            )
            .returning()
        );
        if (!fencedRow) continue;
        fencedJobIds.add(stale.id);
        const message = interruptedOwn ? "Interrupted job lease fenced and requeued" : "Stale running job lease fenced and requeued";
        await transaction.insert(schema.jobEvents).values({
          jobId: stale.id,
          timestamp,
          level: "warn",
          message,
          data: JSON.stringify({ workerId: this.workerId, leaseVersion: fencedRow.leaseVersion })
        });
        await transaction
          .update(schema.scanRuns)
          .set({ status: "failed", finishedAt: timestamp, errorMessage: message })
          .where(and(eq(schema.scanRuns.jobId, stale.id), eq(schema.scanRuns.status, "running")));
        await transaction
          .update(schema.auditRuns)
          .set({ status: "failed", finishedAt: timestamp })
          .where(and(eq(schema.auditRuns.jobId, stale.id), eq(schema.auditRuns.status, "running")));
      }

      const runningRows = await transaction.select().from(schema.jobs).where(eq(schema.jobs.status, "running")).orderBy(asc(schema.jobs.id));
      const runningJobs = runningRows.map(toJobRecord);
      const queuedRows = await transaction.select().from(schema.jobs).where(eq(schema.jobs.status, "queued")).orderBy(asc(schema.jobs.id)).for("update");
      const eligibleQueued = pathConfigurationBlocked ? queuedRows.filter(allowedWhilePathsBlocked) : queuedRows;
      const firstExclusive = eligibleQueued.find((job) => job.exclusive && this.limitForType(job.type as JobRecord["type"]) > 0);
      const candidates = firstExclusive ? eligibleQueued.filter((job) => job.id <= firstExclusive.id) : eligibleQueued;
      if (runningJobs.some((job) => job.exclusive)) return null;

      let candidate: JobRow | undefined;
      for (const queuedJob of candidates) {
        const jobType = queuedJob.type as JobRecord["type"];
        const typeLimit = this.limitForType(jobType);
        if (typeLimit < 1) continue;
        if (runningJobs.length >= this.concurrency.maxRunningJobs) continue;
        if (runningJobs.filter((job) => job.type === jobType).length >= typeLimit) continue;
        if (queuedJob.exclusive) {
          if (runningJobs.length === 0) candidate = queuedJob;
          break;
        }
        if (!(await this.hasClaimConflict(transaction, queuedJob.id, runningJobs.map((job) => job.id)))) {
          candidate = queuedJob;
          break;
        }
      }
      if (!candidate) return null;
      const timestamp = nowIso();
      const claimedRow = await first(
        transaction
          .update(schema.jobs)
          .set({
            status: "running",
            startedAt: candidate.startedAt ?? timestamp,
            lockedBy: this.workerId,
            lockedAt: timestamp,
            heartbeatAt: timestamp,
            leaseVersion: sql`${schema.jobs.leaseVersion} + 1`
          })
          .where(and(eq(schema.jobs.id, candidate.id), eq(schema.jobs.status, "queued"), eq(schema.jobs.leaseVersion, candidate.leaseVersion)))
          .returning()
      );
      return claimedRow ? { job: toJobRecord(claimedRow), reclaimed: fencedJobIds.has(claimedRow.id) } : null;
    });
  }

  private async hasClaimConflict(db: DbExecutor, candidateJobId: number, runningJobIds: number[]): Promise<boolean> {
    if (runningJobIds.length === 0) return false;
    const conflict = await dbGet<{ value: number }>(db, sql`
      WITH running_job_ids AS (
        SELECT value::integer AS job_id
        FROM jsonb_array_elements_text(${JSON.stringify(runningJobIds)}::jsonb)
      )
      SELECT 1 AS value
      FROM job_resource_claims AS candidate
      JOIN job_resource_claims AS active
        ON active.resource_type = candidate.resource_type
       AND active.resource_key = candidate.resource_key
       AND (active.access = 'exclusive' OR candidate.access = 'exclusive')
      JOIN running_job_ids ON running_job_ids.job_id = active.job_id
      WHERE candidate.job_id = ${candidateJobId}
      LIMIT 1
    `);
    return Boolean(conflict);
  }

  private limitForType(type: JobRecord["type"]): number {
    if (type === "scan") return this.concurrency.maxRunningScans;
    if (type === "audit") return this.concurrency.maxRunningAudits;
    if (type === "copy") return this.concurrency.maxRunningCopies;
    return this.concurrency.maxRunningJobs;
  }

  private async requeueInterruptedJobsForPathMigration(): Promise<void> {
    await this.db.transaction(async (transaction) => {
      await transaction.execute(sql`select pg_advisory_xact_lock(${schedulerLockKey})`);
      const rows = await transaction
        .select()
        .from(schema.jobs)
        .where(and(eq(schema.jobs.status, "running"), ne(schema.jobs.type, "path_migration")))
        .orderBy(asc(schema.jobs.id));
      const jobs = rows.map(toJobRecord);
      const ownerIds = [...new Set(jobs.map((job) => job.lockedBy).filter((ownerId): ownerId is string => Boolean(ownerId)))];
      const ownerHeartbeats = ownerIds.length > 0
        ? await transaction.select().from(schema.workerHeartbeats).where(inArray(schema.workerHeartbeats.workerId, ownerIds))
        : [];
      const ownerHeartbeatById = new Map(ownerHeartbeats.map((heartbeat) => [heartbeat.workerId, heartbeat]));
      const timestamp = nowIso();
      for (const job of jobs) {
        if (!this.isReclaimableWithHeartbeat(job, job.lockedBy ? ownerHeartbeatById.get(job.lockedBy) : undefined)) continue;
        const lockedRow = await first(
          transaction
            .select()
            .from(schema.jobs)
            .where(and(eq(schema.jobs.id, job.id), eq(schema.jobs.status, "running"), eq(schema.jobs.leaseVersion, job.leaseVersion)))
            .for("update", { skipLocked: true })
            .limit(1)
        );
        if (!lockedRow) continue;
        const lockedJob = toJobRecord(lockedRow);
        const lockedOwnerHeartbeat = lockedJob.lockedBy && lockedJob.lockedBy !== this.workerId
          ? await first(
              transaction
                .select()
                .from(schema.workerHeartbeats)
                .where(eq(schema.workerHeartbeats.workerId, lockedJob.lockedBy))
                .for("update")
                .limit(1)
            )
          : undefined;
        if (!this.isReclaimableWithHeartbeat(lockedJob, lockedOwnerHeartbeat)) continue;
        const requeued = await first(
          transaction
            .update(schema.jobs)
            .set({
              status: "queued",
              lockedBy: null,
              lockedAt: null,
              heartbeatAt: null,
              leaseVersion: sql`${schema.jobs.leaseVersion} + 1`
            })
            .where(and(eq(schema.jobs.id, job.id), eq(schema.jobs.status, "running"), eq(schema.jobs.leaseVersion, job.leaseVersion)))
            .returning({ id: schema.jobs.id })
        );
        if (requeued) {
          await transaction.insert(schema.jobEvents).values({
            jobId: job.id,
            timestamp,
            level: "warn",
            message: "Managed storage paths changed; interrupted job paused and requeued",
            data: JSON.stringify({ workerId: this.workerId })
          });
        }
      }
    });
  }

  private async runClaimedJob(job: LeasedJob): Promise<void> {
    const abortController = new AbortController();
    this.activeAbortControllers.set(job.id, abortController);
    let leaseLost = false;
    const loseLease = (cause: unknown) => {
      leaseLost = true;
      const reason = cause instanceof LeaseLostError ? cause : new LeaseLostError(job.id, { cause });
      if (!abortController.signal.aborted) abortController.abort(reason);
      return reason;
    };
    let heartbeatInFlight = false;
    const heartbeat = setInterval(() => {
      if (heartbeatInFlight) return;
      heartbeatInFlight = true;
      void this.heartbeat(job)
        .catch((error: unknown) => {
          const leaseError = loseLease(error);
          this.logger.warn(`SRTL worker ${this.workerId} heartbeat failed for job #${job.id}: ${leaseError.message}`);
        })
        .finally(() => {
          heartbeatInFlight = false;
        });
    }, this.heartbeatIntervalMs);
    let heartbeatStopped = false;
    const stopHeartbeat = () => {
      if (heartbeatStopped) return;
      clearInterval(heartbeat);
      heartbeatStopped = true;
    };
    let pathMigrationPauseRequested = false;
    let completedByHandler = false;
    let cancellationWatchInFlight = false;
    const cancellationWatcher = setInterval(() => {
      if (cancellationWatchInFlight) return;
      cancellationWatchInFlight = true;
      void Promise.all([this.isCancellationRequested(job.id), job.type === "path_migration" ? Promise.resolve(false) : isPathConfigurationBlocked(this.db)])
        .then(([cancelled, pathConfigurationBlocked]) => {
          if (pathConfigurationBlocked) pathMigrationPauseRequested = true;
          if ((cancelled || pathConfigurationBlocked) && !abortController.signal.aborted) abortController.abort();
        })
        .catch((error: unknown) => {
          this.logger.warn(`SRTL worker ${this.workerId} cancellation watch failed for job #${job.id}: ${errorMessage(error)}`);
        })
        .finally(() => {
          cancellationWatchInFlight = false;
        });
    }, 500);
    const isCancelled = async () => {
      const cancelled = await this.isCancellationRequested(job.id);
      const pathConfigurationBlocked = job.type === "path_migration" ? false : await isPathConfigurationBlocked(this.db);
      if (pathConfigurationBlocked) pathMigrationPauseRequested = true;
      if ((cancelled || pathConfigurationBlocked) && !abortController.signal.aborted) abortController.abort();
      return cancelled || pathConfigurationBlocked;
    };
    const assertLease = async () => {
      try {
        await this.assertLease(job);
      } catch (error: unknown) {
        throw loseLease(error);
      }
    };
    const withLeaseDb = async <T>(action: (db: DbExecutor) => Promise<T>): Promise<T> => {
      let actionFailed = false;
      let actionError: unknown;
      try {
        return await this.withLease(job, async (transaction) => {
          try {
            return await action(transaction);
          } catch (error: unknown) {
            actionFailed = true;
            actionError = error;
            throw error;
          }
        });
      } catch (error: unknown) {
        if (actionFailed) throw actionError;
        throw loseLease(error);
      }
    };
    const withLease = <T>(action: () => Promise<T>): Promise<T> => withLeaseDb(() => action());
    const finishCompleted = async (action: (db: DbExecutor) => Promise<void>): Promise<boolean> => {
      const completed = await this.finishCompletedJob(job, action);
      if (completed) completedByHandler = true;
      return completed;
    };
    const finishCompletedIsolated = async (action: (db: DbExecutor) => Promise<void>): Promise<boolean> => {
      const completed = await this.finishCompletedJob(job, action, false);
      if (completed) completedByHandler = true;
      return completed;
    };
    const ctx: JobContext = {
      jobId: job.id,
      signal: abortController.signal,
      event: async (level, message, data) => {
        try {
          await this.addLeasedEvent(job, level, message, data);
        } catch (error: unknown) {
          throw loseLease(error);
        }
      },
      setProgress: async (progress) => {
        try {
          await this.setLeasedProgress(job, progress);
        } catch (error: unknown) {
          throw loseLease(error);
        }
      },
      isCancelled,
      assertLease,
      withLease,
      withLeaseDb,
      finishCompleted,
      finishCompletedIsolated
    };

    try {
      await ctx.event("info", "Worker started job", { workerId: this.workerId, leaseVersion: job.leaseVersion });
      await this.runHandler(job, ctx);
      if (completedByHandler) return;
      if (job.type !== "path_migration" && (pathMigrationPauseRequested || (await isPathConfigurationBlocked(this.db)))) {
        stopHeartbeat();
        if (job.type === "copy") await this.settlePathInterruptedCopy(job);
        else await this.requeueInterruptedJob(job, "Managed storage paths changed; job paused and requeued");
        return;
      }
      const status: JobStatus = (await this.isCancellationRequested(job.id)) ? "cancelled" : "completed";
      if (status === "completed" && job.type === "scan") {
        await assertLease();
        await completeOnboardingScan(this.db, job.id);
      }
      stopHeartbeat();
      await this.finishJob(job, status, status === "cancelled" ? "warn" : "info", status === "cancelled" ? "Job cancelled" : "Job completed");
    } catch (error: unknown) {
      if (leaseLost || error instanceof LeaseLostError) {
        this.logger.warn(`SRTL worker ${this.workerId} stopped job #${job.id} after losing its lease`);
        return;
      }
      if (pathMigrationPauseRequested) {
        stopHeartbeat();
        if (job.type === "copy") await this.settlePathInterruptedCopy(job, errorMessage(error));
        else await this.requeueInterruptedJob(job, "Managed storage paths changed; job paused and requeued");
        return;
      }
      if (await this.shouldRequeueInterruptedJob(job.id, abortController)) {
        stopHeartbeat();
        await this.requeueInterruptedJob(job);
        return;
      }
      if (error instanceof CopyReconciliationRequiredError) {
        stopHeartbeat();
        await this.finishJob(job, "failed", "error", error.message);
        this.logger.error(`SRTL worker ${this.workerId} stopped copy job #${job.id} for manual reconciliation: ${error.message}`);
        return;
      }
      if (await this.isCancellationRequested(job.id)) {
        stopHeartbeat();
        await this.finishJob(job, "cancelled", "warn", "Job cancelled");
        return;
      }
      if (error instanceof PartialJobFailureError) {
        stopHeartbeat();
        await this.finishJob(job, "partially_failed", "warn", error.message);
        this.logger.warn(`SRTL worker ${this.workerId} partially failed job #${job.id}: ${error.message}`);
        return;
      }
      stopHeartbeat();
      await this.finishJob(job, "failed", "error", errorMessage(error));
      this.logger.error(`SRTL worker ${this.workerId} failed job #${job.id}: ${errorMessage(error)}`);
    } finally {
      stopHeartbeat();
      clearInterval(cancellationWatcher);
      this.activeAbortControllers.delete(job.id);
    }
  }

  private async runHandler(job: JobRecord, ctx: JobContext): Promise<void> {
    const frozenLinkIds = job.selectionFrozen
      ? (() => {
          const legacyIds = jobProgressOptions<{ linkIds?: unknown }>(job)?.linkIds;
          return Array.isArray(legacyIds) && legacyIds.every((id) => Number.isInteger(id) && Number(id) > 0)
            ? legacyIds.map(Number)
            : null;
        })() ??
        (
          await this.db
            .select({ mediaLinkId: schema.jobSelectionItems.mediaLinkId })
            .from(schema.jobSelectionItems)
            .where(eq(schema.jobSelectionItems.jobId, job.id))
            .orderBy(asc(schema.jobSelectionItems.selectionOrder))
        ).map((item) => item.mediaLinkId)
      : undefined;
    if (job.type === "scan") {
      const options = jobProgressOptions<ScanOptions>(job) ?? defaultScanOptions;
      await this.runScanJob(job.id, await normalizeScanOptions(this.db, { ...defaultScanOptions, ...options }), ctx);
      return;
    }
    if (job.type === "audit") {
      await this.runAuditJob(job.id, readAuditOptions(job, frozenLinkIds), ctx);
      return;
    }
    if (job.type === "copy") {
      await this.runCopyJob(readCopyOptions(job, frozenLinkIds), ctx);
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

  private async assertLease(job: LeasedJob): Promise<void> {
    const row = await first(
      this.db
        .select({ id: schema.jobs.id })
        .from(schema.jobs)
        .where(
          and(
            eq(schema.jobs.id, job.id),
            eq(schema.jobs.status, "running"),
            eq(schema.jobs.lockedBy, this.workerId),
            eq(schema.jobs.leaseVersion, job.leaseVersion)
          )
        )
        .limit(1)
    );
    if (!row) throw new LeaseLostError(job.id);
  }

  private async withLease<T>(job: LeasedJob, action: (db: DbExecutor) => Promise<T>): Promise<T> {
    return this.db.transaction(async (transaction) => {
      const row = await first(
        transaction
          .select({ id: schema.jobs.id })
          .from(schema.jobs)
          .where(
            and(
              eq(schema.jobs.id, job.id),
              eq(schema.jobs.status, "running"),
              eq(schema.jobs.lockedBy, this.workerId),
              eq(schema.jobs.leaseVersion, job.leaseVersion)
            )
          )
          .for("update")
          .limit(1)
      );
      if (!row) throw new LeaseLostError(job.id);
      return action(transaction);
    });
  }

  private async heartbeat(job: LeasedJob): Promise<void> {
    const row = await first(
      this.db
        .update(schema.jobs)
        .set({ heartbeatAt: nowIso() })
        .where(
          and(
            eq(schema.jobs.id, job.id),
            eq(schema.jobs.status, "running"),
            eq(schema.jobs.lockedBy, this.workerId),
            eq(schema.jobs.leaseVersion, job.leaseVersion)
          )
        )
        .returning({ id: schema.jobs.id })
    );
    if (!row) throw new LeaseLostError(job.id);
  }

  private async setLeasedProgress(job: LeasedJob, progress: unknown): Promise<void> {
    const row = await first(
      this.db
        .update(schema.jobs)
        .set({ progress: JSON.stringify(compactJobProgress(progress)) })
        .where(
          and(
            eq(schema.jobs.id, job.id),
            eq(schema.jobs.status, "running"),
            eq(schema.jobs.lockedBy, this.workerId),
            eq(schema.jobs.leaseVersion, job.leaseVersion)
          )
        )
        .returning({ id: schema.jobs.id })
    );
    if (!row) throw new LeaseLostError(job.id);
  }

  private async addLeasedEvent(job: LeasedJob, level: JobEventRecord["level"], message: string, data: unknown = {}): Promise<void> {
    const inserted = await this.db.transaction(async (transaction) => {
      const lease = await first(
        transaction
          .select({ id: schema.jobs.id })
          .from(schema.jobs)
          .where(
            and(
              eq(schema.jobs.id, job.id),
              eq(schema.jobs.status, "running"),
              eq(schema.jobs.lockedBy, this.workerId),
              eq(schema.jobs.leaseVersion, job.leaseVersion)
            )
          )
          .for("update")
          .limit(1)
      );
      if (!lease) return false;
      await transaction.insert(schema.jobEvents).values({ jobId: job.id, timestamp: nowIso(), level, message, data: JSON.stringify(data) });
      return true;
    });
    if (!inserted) throw new LeaseLostError(job.id);
  }

  private async shouldRequeueInterruptedJob(jobId: number, abortController: AbortController): Promise<boolean> {
    return this.stopRequested && abortController.signal.aborted && !(await this.isCancellationRequested(jobId));
  }

  private async settlePathInterruptedCopy(job: LeasedJob, failureMessage?: string): Promise<void> {
    const operations = await this.db
      .select({ stage: schema.copyOperations.stage, errorMessage: schema.copyOperations.errorMessage })
      .from(schema.copyOperations)
      .where(eq(schema.copyOperations.jobId, job.id));
    const manual = operations.find((operation) => operation.stage === "reconciliation_required");
    if (manual) {
      await this.finishJob(
        job,
        "failed",
        "error",
        manual.errorMessage ?? failureMessage ?? "Copy recovery requires manual reconciliation before paths can be migrated"
      );
      return;
    }
    const hasUnreconciledOperations = operations.some(
      (operation) => operation.stage !== "rolled_back" && operation.stage !== "failed"
    );
    if (hasUnreconciledOperations) {
      await this.requeueInterruptedJob(job, "Managed storage paths changed; copy recovery remains queued");
      return;
    }
    await this.finishJob(job, "cancelled", "warn", "Copy cancelled after managed-path recovery");
  }

  private async requeueInterruptedJob(job: LeasedJob, message = "Worker stopped; job requeued for resume"): Promise<void> {
    const requeued = await this.db.transaction(async (transaction) => {
      const timestamp = nowIso();
      const row = await first(
        transaction
          .update(schema.jobs)
          .set({ status: "queued", lockedBy: null, lockedAt: null, heartbeatAt: null })
          .where(
            and(
              eq(schema.jobs.id, job.id),
              eq(schema.jobs.status, "running"),
              eq(schema.jobs.lockedBy, this.workerId),
              eq(schema.jobs.leaseVersion, job.leaseVersion)
            )
          )
          .returning({ id: schema.jobs.id })
      );
      if (!row) return false;
      await transaction.insert(schema.jobEvents).values({ jobId: job.id, timestamp, level: "warn", message, data: JSON.stringify({ workerId: this.workerId }) });
      return true;
    });
    if (!requeued) throw new LeaseLostError(job.id);
  }

  private async finishCompletedJob(
    job: LeasedJob,
    action: (db: DbExecutor) => Promise<void>,
    useSchedulerBarrier = true
  ): Promise<boolean> {
    return this.db.transaction(async (transaction) => {
      if (useSchedulerBarrier) await transaction.execute(sql`select pg_advisory_xact_lock(${schedulerLockKey})`);
      const lease = await first(
        transaction
          .select({ id: schema.jobs.id, cancelRequestedAt: schema.jobs.cancelRequestedAt })
          .from(schema.jobs)
          .where(
            and(
              eq(schema.jobs.id, job.id),
              eq(schema.jobs.status, "running"),
              eq(schema.jobs.lockedBy, this.workerId),
              eq(schema.jobs.leaseVersion, job.leaseVersion)
            )
          )
          .for("update")
          .limit(1)
      );
      if (!lease) throw new LeaseLostError(job.id);
      if (job.type !== "path_migration" && (await isPathConfigurationBlocked(transaction))) return false;
      if (lease.cancelRequestedAt) return false;

      await action(transaction);
      const timestamp = nowIso();
      const completed = await first(
        transaction
          .update(schema.jobs)
          .set({ status: "completed", finishedAt: timestamp, lockedBy: null, lockedAt: null, heartbeatAt: null, cancelRequestedAt: null })
          .where(
            and(
              eq(schema.jobs.id, job.id),
              eq(schema.jobs.status, "running"),
              eq(schema.jobs.lockedBy, this.workerId),
              eq(schema.jobs.leaseVersion, job.leaseVersion),
              isNull(schema.jobs.cancelRequestedAt)
            )
          )
          .returning({ id: schema.jobs.id })
      );
      if (!completed) return false;
      await transaction.insert(schema.jobEvents).values({ jobId: job.id, timestamp, level: "info", message: "Job completed", data: "{}" });
      return true;
    });
  }

  private async finishJob(job: LeasedJob, status: JobStatus, level: JobEventRecord["level"], message: string): Promise<void> {
    const finished = await this.db.transaction(async (transaction) => {
      const timestamp = nowIso();
      const row = await first(
        transaction
          .update(schema.jobs)
          .set({
            status,
            finishedAt: timestamp,
            lockedBy: null,
            lockedAt: null,
            heartbeatAt: null,
            cancelRequestedAt: status === "completed" ? null : undefined
          })
          .where(
            and(
              eq(schema.jobs.id, job.id),
              eq(schema.jobs.status, "running"),
              eq(schema.jobs.lockedBy, this.workerId),
              eq(schema.jobs.leaseVersion, job.leaseVersion)
            )
          )
          .returning({ id: schema.jobs.id })
      );
      if (!row) return false;
      await transaction.insert(schema.jobEvents).values({ jobId: job.id, timestamp, level, message, data: "{}" });
      return true;
    });
    if (!finished) throw new LeaseLostError(job.id);
  }

  private async isCancellationRequested(jobId: number): Promise<boolean> {
    const row = await first(this.db.select({ cancelRequestedAt: schema.jobs.cancelRequestedAt }).from(schema.jobs).where(eq(schema.jobs.id, jobId)).limit(1));
    return Boolean(row?.cancelRequestedAt);
  }

  private async runScanJob(jobId: number, normalizedOptions: ScanOptions, ctx: JobContext): Promise<void> {
    const scanRun = await ctx.withLeaseDb((leaseDb) =>
      first(
        leaseDb
          .insert(schema.scanRuns)
          .values({ jobId, status: "running", startedAt: nowIso(), finishedAt: null, errorMessage: null, ...emptyScanTotals() })
          .returning({ id: schema.scanRuns.id })
      )
    );
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
        async () => ctx.signal.aborted || (await ctx.isCancelled()),
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
      for (const link of result.links) {
        if (!link.targetReadError) continue;
        await ctx.event("warn", "Symlink target remained unreadable after retry", {
          section: link.section,
          itemName: link.itemName,
          linkPath: link.linkPath,
          targetPath: link.targetPath,
          message: link.targetReadError
        });
      }
      if (await ctx.isCancelled()) {
        await ctx.withLeaseDb(async (leaseDb) => {
          await leaseDb.update(schema.scanRuns).set({ status: "cancelled", finishedAt: nowIso(), errorMessage: "Job cancelled" }).where(eq(schema.scanRuns.id, scanRun.id));
        });
        await ctx.setProgress(scanProgressPayload(normalizedOptions, "cancelled", "Scan cancelled before inventory results were written", result.inventory));
        return;
      }
      let persistedInventory: InventorySummary | null = null;
      const completionMessage = isTitleRescan
        ? "Title rescan completed and symlink inventory was reconciled"
        : "Scan completed and inventory counters were updated";
      const completionEvent = isTitleRescan
        ? "Targeted title rescan reconciled symlinks"
        : "Manual inventory scan indexed library links and storage files";
      const finalized = await ctx.finishCompleted(async (leaseDb) => {
        if (ctx.signal.aborted) throw (ctx.signal.reason instanceof Error ? ctx.signal.reason : new Error("Scan indexing was cancelled"));
        const inventory = await persistScanResult(leaseDb, result, jobId, async () => ctx.signal.aborted);
        if (ctx.signal.aborted) throw (ctx.signal.reason instanceof Error ? ctx.signal.reason : new Error("Scan indexing was cancelled"));
        await leaseDb.update(schema.scanRuns).set({ status: "completed", finishedAt: nowIso(), errorMessage: null, ...inventory }).where(eq(schema.scanRuns.id, scanRun.id));
        await completeOnboardingScan(leaseDb, jobId);
        await leaseDb
          .update(schema.jobs)
          .set({ progress: JSON.stringify(compactJobProgress(scanProgressPayload(normalizedOptions, "completed", completionMessage, inventory))) })
          .where(eq(schema.jobs.id, jobId));
        await leaseDb.insert(schema.jobEvents).values({
          jobId,
          timestamp: nowIso(),
          level: "info",
          message: completionEvent,
          data: JSON.stringify({ options: normalizedOptions, ...inventory })
        });
        persistedInventory = inventory;
      });
      if (finalized && persistedInventory) return;
      await ctx.withLeaseDb(async (leaseDb) => {
        await leaseDb.update(schema.scanRuns).set({ status: "cancelled", finishedAt: nowIso(), errorMessage: "Job cancelled" }).where(eq(schema.scanRuns.id, scanRun.id));
      });
      await ctx.setProgress(scanProgressPayload(normalizedOptions, "cancelled", "Scan cancelled before inventory results were written", result.inventory));
      await ctx.event("warn", "Scan cancelled before inventory results were written");
    } catch (error: unknown) {
      if (error instanceof LeaseLostError || (error instanceof Error && error.name === "LeaseLostError")) throw error;
      if (await ctx.isCancelled()) {
        await ctx.withLeaseDb(async (leaseDb) => {
          await leaseDb.update(schema.scanRuns).set({ status: "cancelled", finishedAt: nowIso(), errorMessage: "Job terminated" }).where(eq(schema.scanRuns.id, scanRun.id));
        });
        await ctx.setProgress(scanProgressPayload(normalizedOptions, "cancelled", "Scan terminated before inventory results were written"));
        await ctx.event("warn", "Scan terminated before inventory results were written");
        return;
      }
      await ctx.withLeaseDb(async (leaseDb) => {
        await leaseDb.update(schema.scanRuns).set({ status: "failed", finishedAt: nowIso(), errorMessage: errorMessage(error) }).where(eq(schema.scanRuns.id, scanRun.id));
      });
      await ctx.setProgress(scanProgressPayload(normalizedOptions, "failed", errorMessage(error)));
      throw error;
    }
  }

  private async runAuditJob(jobId: number, normalizedOptions: AuditOptions, ctx: JobContext): Promise<void> {
    const links = filterAuditLinks(await listMediaLinks(this.db), normalizedOptions);
    const startedAt = nowIso();
    const auditRun = await ctx.withLeaseDb((leaseDb) =>
      first(
        leaseDb
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
          .returning({ id: schema.auditRuns.id })
      )
    );
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
        selectedLinkCount: normalizedOptions.linkIds?.length,
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

        await ctx.withLeaseDb(async (leaseDb) => {
          await leaseDb.insert(schema.auditResults).values({ ...result, auditRunId: auditRun.id, createdAt: nowIso() });
        });
        await ctx.setProgress(auditProgress("auditing", "Recorded audit result", link));
      }

      const cancelAudit = async () => {
        checked = 0;
        passed = 0;
        failed = 0;
        sourceUnknown = 0;
        sourceMissing = 0;
        sourceCompareErrors = 0;
        byteMismatches = 0;
        targetValidationFailures = 0;
        await ctx.withLeaseDb(async (leaseDb) => {
          await leaseDb.delete(schema.auditResults).where(eq(schema.auditResults.auditRunId, auditRun.id));
          await leaseDb
            .update(schema.auditRuns)
            .set({ status: "cancelled", finishedAt: nowIso(), checked, passed, failed, sourceUnknown, sourceMissing, sourceCompareErrors, byteMismatches, targetValidationFailures, errorMessage: null })
            .where(eq(schema.auditRuns.id, auditRun.id));
        });
        await ctx.setProgress(auditProgress("cancelled", "Audit cancelled"));
        await ctx.event("warn", `${normalizedOptions.mode} audit terminated; partial results discarded`, {
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
      };
      if (await ctx.isCancelled()) {
        await cancelAudit();
        return;
      }

      const completedProgress = auditProgress("completed", "Audit completed");
      const finalized = await ctx.finishCompleted(async (leaseDb) => {
        if (ctx.signal.aborted) throw (ctx.signal.reason instanceof Error ? ctx.signal.reason : new Error("Audit was interrupted"));
        await leaseDb
          .update(schema.auditRuns)
          .set({ status: "completed", finishedAt: nowIso(), checked, passed, failed, sourceUnknown, sourceMissing, sourceCompareErrors, byteMismatches, targetValidationFailures, errorMessage: null })
          .where(eq(schema.auditRuns.id, auditRun.id));
        await leaseDb.update(schema.jobs).set({ progress: JSON.stringify(compactJobProgress(completedProgress)) }).where(eq(schema.jobs.id, jobId));
        await leaseDb.insert(schema.jobEvents).values({
          jobId,
          timestamp: nowIso(),
          level: "info",
          message: `${normalizedOptions.mode} audit indexed results`,
          data: JSON.stringify({
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
          })
        });
      });
      if (finalized) return;
      await cancelAudit();
    } catch (error: unknown) {
      if (error instanceof LeaseLostError || (error instanceof Error && error.name === "LeaseLostError")) throw error;
      const message = errorMessage(error);
      await ctx.withLeaseDb(async (leaseDb) => {
        await leaseDb
          .update(schema.auditRuns)
          .set({ status: "failed", finishedAt: nowIso(), checked, passed, failed, sourceUnknown, sourceMissing, sourceCompareErrors, byteMismatches, targetValidationFailures, errorMessage: message })
          .where(eq(schema.auditRuns.id, auditRun.id));
      });
      await ctx.setProgress(auditProgress("failed", message));
      throw error;
    }
  }

  private async runCopyJob(normalizedOptions: StoredCopyOptions, ctx: JobContext): Promise<void> {
    const paths = await getJsonSetting<PathsSettings>(this.db, "paths", { symlinkDir: "", localDir: "", remoteDir: "" });
    if (!paths.symlinkDir || !paths.localDir || !paths.remoteDir) throw new Error("Path settings are incomplete");
    const durableClaims = await this.db.select().from(schema.jobResourceClaims).where(eq(schema.jobResourceClaims.jobId, ctx.jobId));
    const claimedPaths = new Set(durableClaims.filter((claim) => claim.resourceType === "path").map((claim) => path.resolve(claim.resourceKey)));
    const claimedCopyPathBindings = new Map<string, CopyPathBinding>();
    const cleanupPathsByLink = new Map<number, Map<string, CopyCleanupIdentity>>();
    for (const claim of durableClaims) {
      if (claim.resourceType === "copy_path_binding") {
        const binding = parseCopyPathBindingResourceKey(claim.resourceKey);
        if (binding) claimedCopyPathBindings.set(copyPathBindingMapKey(binding.linkId, binding.role), binding);
      }
      if (claim.resourceType !== "copy_cleanup") continue;
      const marker = parseCopyCleanupMarker(claim.resourceKey);
      if (!marker?.identity) continue;
      const existing = cleanupPathsByLink.get(marker.linkId);
      if (existing) existing.set(marker.filePath, marker.identity);
      else cleanupPathsByLink.set(marker.linkId, new Map([[marker.filePath, marker.identity]]));
    }
    const copyPathsRemainClaimed = async (link: MediaLinkRow, destinationPath: string): Promise<boolean> => {
      if (claimedPaths.size === 0 && claimedCopyPathBindings.size === 0) return true;
      const currentBindings = await copyPathBindingsForLink(link, paths, normalizedOptions.direction);
      const currentDestination = currentBindings.find((binding) => binding.role === "destination");
      if (!currentDestination || currentDestination.lexicalPath !== path.resolve(destinationPath)) return false;
      if (
        claimedPaths.size > 0 &&
        currentBindings.some(
          (binding) => !claimedPaths.has(binding.lexicalPath) || !claimedPaths.has(binding.canonicalPath)
        )
      ) {
        return false;
      }
      if (claimedCopyPathBindings.size === 0) return true;
      return currentBindings.every((binding) => {
        const expected = claimedCopyPathBindings.get(copyPathBindingMapKey(binding.linkId, binding.role));
        return expected?.lexicalPath === binding.lexicalPath && expected.canonicalPath === binding.canonicalPath;
      });
    };
    const copyBehavior = normalizedOptions.behavior ?? normalizeAdvancedSettings(await getJsonSetting<unknown>(this.db, "advancedSettings", {})).copy;
    await ctx.assertLease();
    // Path-blocked copy jobs are admitted only to reconcile and roll back their
    // durable journal. Mark the context cancelled before replaying that journal.
    await ctx.isCancelled();
    await reconcileCopyOperationsForJob(this.db, ctx.jobId, paths, ctx);

    const allLinks = await listMediaLinks(this.db, undefined, "current");
    const links = filterCopyLinks(allLinks, normalizedOptions);
    const hasDurableSelection = normalizedOptions.linkIds !== undefined;
    const selectedLinks = hasDurableSelection ? filterCopySelectedLinks(allLinks, normalizedOptions) : links;
    const durableSelectedDestinations = [...claimedCopyPathBindings.values()]
      .filter((binding) => binding.role === "destination")
      .map((binding) => ({
        linkId: binding.linkId,
        lexicalPath: binding.lexicalPath,
        canonicalPath: binding.canonicalPath
      }));
    const durableDestinationLinkIds = new Set(durableSelectedDestinations.map((destination) => destination.linkId));
    const supplementalSelectedDestinations = await copySelectedDestinationsForLinks(
      selectedLinks.filter((link) => !durableDestinationLinkIds.has(link.id)),
      paths,
      normalizedOptions.direction
    );
    const selectedDestinations = indexCopySelectedDestinations([
      ...durableSelectedDestinations,
      ...supplementalSelectedDestinations.entries
    ]);
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
    const replacementCandidateEntries = new Map<
      number,
      { linkId: number; destinationPath: string; candidates: CopyLocalConflictCandidate[]; expectedIdentities: Map<string, CopyCleanupIdentity> }
    >();
    const committedReplacementOperations = await this.db
      .select()
      .from(schema.copyOperations)
      .where(
        and(
          eq(schema.copyOperations.jobId, ctx.jobId),
          eq(schema.copyOperations.stage, "committed"),
          eq(schema.copyOperations.localConflictStrategy, "replace")
        )
      );
    for (const operation of committedReplacementOperations) {
      const originalLink = copyOperationLink(operation);
      const conflict = await copyLocalConflictForLink(this.db, originalLink, paths, selectedDestinations);
      if (conflict) {
        const expectedIdentities = cleanupPathsByLink.get(originalLink.id) ?? new Map<string, CopyCleanupIdentity>();
        const allowedCandidates: CopyLocalConflictCandidate[] = [];
        for (const candidate of conflict.candidates) {
          const candidatePath = path.resolve(candidate.filePath);
          if (sameCopyCleanupIdentity(expectedIdentities.get(candidatePath), await copyCleanupIdentity(candidatePath))) allowedCandidates.push(candidate);
        }
        if (allowedCandidates.length === 0) continue;
        replacementCandidateEntries.set(originalLink.id, {
          linkId: originalLink.id,
          destinationPath: operation.destinationPath,
          candidates: allowedCandidates,
          expectedIdentities
        });
      }
    }
    let progressWrite = Promise.resolve();
    const setCopyProgress = (stage: CopyProgressStage, message: string, link?: MediaLinkRow, update?: Partial<CopyProgressUpdate>) => {
      const payload = copyProgressPayload({
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
      });
      progressWrite = progressWrite.then(() => ctx.setProgress(payload));
      return progressWrite;
    };

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
      copyBehavior
    });
    if (links.length === 0) {
      if (failed > 0) {
        const itemLabel = total === 1 ? "media item" : "media items";
        const failureMessage = `Copy job failed: ${failed} of ${total} ${itemLabel} failed`;
        await setCopyProgress("failed", failureMessage);
        await ctx.event("error", "Copy job failed processing media", { total, copied, repointed, skipped, conflicts, failed, unavailable });
        throw new Error(failureMessage);
      }
    }

    const withCopyMutationLease = <T>(link: MediaLinkRow, destinationPath: string, mutation: () => Promise<T>): Promise<T> =>
      ctx.withLeaseDb(async (leaseDb) => {
        if (await isPathConfigurationBlocked(leaseDb)) {
          throw new Error("Managed storage paths changed before copy promotion");
        }
        if (!(await copyPathsRemainClaimed(link, destinationPath))) {
          throw new Error("Media paths changed after copy admission; queue the copy again");
        }
        return mutation();
      });
    let cancellationReported = false;
    const processLink = async (link: MediaLinkRow): Promise<void> => {
      if (await ctx.isCancelled()) return;
      let linkUpdate: Partial<CopyProgressUpdate> | undefined;
      let activeOperationId: number | null = null;
      let filesystemMutationCompleted = false;
      current += 1;
      await setCopyProgress("preparing", "Preparing media copy", link);
      const destinationPath = copyDestinationPathForLink(link, paths, normalizedOptions.direction);
      if (!(await copyPathsRemainClaimed(link, destinationPath))) {
        conflicts += 1;
        await setCopyProgress("conflict", "Media paths changed after copy admission; queue the copy again", link);
        await ctx.event("warn", "Media paths changed after copy admission", { linkId: link.id, linkPath: link.linkPath, sourcePath: link.targetPath, destinationPath });
        return;
      }
      const sourceTitleRisk = evaluateSourceTitleRisk({ expectedTitle: link.itemName, sourcePath: link.targetPath });
      if (sourceTitleRisk.severity === "block" && !normalizedOptions.allowSourceTitleMismatch) {
        conflicts += 1;
        linkUpdate = {
          sourcePath: link.targetPath,
          linkPath: link.linkPath,
          sizeBytes: link.sizeBytes ?? undefined
        };
        await setCopyProgress("conflict", "Source title mismatch blocked copy", link, linkUpdate);
        await ctx.event("warn", "Source title mismatch blocked copy", {
          direction: normalizedOptions.direction,
          itemName: link.itemName,
          linkPath: link.linkPath,
          sourcePath: link.targetPath,
          risk: sourceTitleRisk
        });
        return;
      }
      if (sourceTitleRisk.severity === "block" && normalizedOptions.allowSourceTitleMismatch) {
        await ctx.event("warn", "Source title mismatch override accepted", {
          direction: normalizedOptions.direction,
          itemName: link.itemName,
          linkPath: link.linkPath,
          sourcePath: link.targetPath,
          risk: sourceTitleRisk
        });
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
        const localConflict =
          normalizedOptions.direction === "to_local"
            ? await copyLocalConflictForLink(this.db, link, paths, selectedDestinations)
            : null;
        if (localConflict && normalizedOptions.localConflictStrategy === "replace") {
          const expectedIdentities = cleanupPathsByLink.get(link.id) ?? new Map<string, CopyCleanupIdentity>();
          const unclaimedCandidates: CopyLocalConflictCandidate[] = [];
          for (const candidate of localConflict.candidates) {
            const candidatePath = path.resolve(candidate.filePath);
            if (!sameCopyCleanupIdentity(expectedIdentities.get(candidatePath), await copyCleanupIdentity(candidatePath))) unclaimedCandidates.push(candidate);
          }
          if (unclaimedCandidates.length > 0) {
            conflicts += 1;
            linkUpdate = {
              sourcePath: link.targetPath,
              destinationPath: localConflict.destinationPath,
              linkPath: link.linkPath,
              sizeBytes: link.sizeBytes ?? undefined
            };
            await setCopyProgress("conflict", "Local replacement candidates changed after copy admission; queue the copy again", link, linkUpdate);
            await ctx.event("warn", "Local replacement candidates changed after copy admission", {
              ...localConflict,
              unclaimedPaths: unclaimedCandidates.map((candidate) => candidate.filePath)
            });
            return;
          }
        }
        if (localConflict && !normalizedOptions.localConflictStrategy) {
          conflicts += 1;
          linkUpdate = {
            sourcePath: link.targetPath,
            destinationPath: localConflict.destinationPath,
            linkPath: link.linkPath,
            sizeBytes: link.sizeBytes ?? undefined
          };
          await setCopyProgress("conflict", "Existing local file requires copy resolution", link, linkUpdate);
          await ctx.event("warn", "Existing local file requires copy resolution", localConflict);
          return;
        }
        const previousCopySource =
          (await first(this.db.select().from(schema.copySources).where(eq(schema.copySources.destinationPath, destinationPath)).limit(1))) ?? null;
        const operation = await ctx.withLeaseDb((leaseDb) =>
          prepareCopyOperation(
            leaseDb,
            ctx.jobId,
            link,
            destinationPath,
            previousCopySource,
            normalizedOptions.localConflictStrategy
          )
        );
        activeOperationId = operation.id;
        const releaseTransfer = await this.copyTransferLimiter.acquire(ctx.signal);
        let result: CopyMediaResult;
        try {
          result = await copyMediaLink(
            link,
            paths,
            normalizedOptions.direction,
            this.copyRunner,
            async (update) => {
              linkUpdate = update;
              await setCopyProgress(update.stage, update.message, link, linkUpdate);
              if (update.stage === "copying" || (update.stage === "preparing" && !/retry/i.test(update.message))) return;
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
                  update: linkUpdate
                })
              );
            },
            copyBehavior,
            ctx.signal,
            normalizedOptions.localConflictStrategy,
            (update) => ctx.withLeaseDb((leaseDb) => updateCopyOperation(leaseDb, operation.id, update)),
            (mutation) => withCopyMutationLease(link, destinationPath, mutation)
          );
        } finally {
          releaseTransfer();
        }
        filesystemMutationCompleted = result.status === "copied" || result.status === "repointed";
        if (result.status === "copied") {
          await ctx.withLeaseDb((leaseDb) => commitCopyOperation(leaseDb, operation.id, link, result));
          copied += 1;
          linkUpdate = { ...(linkUpdate ?? {}), ...result };
          await setCopyProgress("done", result.message, link, linkUpdate);
          await ctx.event("info", copyBehavior.profile === "off" ? "Copy installed without verification" : "Verified copy installed", { ...result, itemName: link.itemName });
          if (normalizedOptions.localConflictStrategy === "replace" && localConflict) {
            replacementCandidateEntries.set(link.id, {
              linkId: link.id,
              destinationPath: result.destinationPath,
              candidates: localConflict.candidates,
              expectedIdentities: cleanupPathsByLink.get(link.id) ?? new Map<string, CopyCleanupIdentity>()
            });
          }
        } else if (result.status === "repointed") {
          await ctx.withLeaseDb((leaseDb) => commitCopyOperation(leaseDb, operation.id, link, result));
          repointed += 1;
          linkUpdate = { ...(linkUpdate ?? {}), ...result };
          await setCopyProgress("done", result.message, link, linkUpdate);
          await ctx.event("info", "Symlink repointed to existing verified file", { ...result, itemName: link.itemName });
          if (normalizedOptions.localConflictStrategy === "replace" && localConflict) {
            replacementCandidateEntries.set(link.id, {
              linkId: link.id,
              destinationPath: result.destinationPath,
              candidates: localConflict.candidates,
              expectedIdentities: cleanupPathsByLink.get(link.id) ?? new Map<string, CopyCleanupIdentity>()
            });
          }
        } else if (result.status === "conflict") {
          conflicts += 1;
          await ctx.withLeaseDb((leaseDb) => completeCopyOperationWithoutMutation(leaseDb, operation.id, result));
          linkUpdate = { ...(linkUpdate ?? {}), ...result };
          await setCopyProgress("conflict", result.message, link, linkUpdate);
          await ctx.event("warn", "Destination conflict; file was not overwritten", result);
        } else {
          skipped += 1;
          await ctx.withLeaseDb((leaseDb) => completeCopyOperationWithoutMutation(leaseDb, operation.id, result));
          linkUpdate = { ...(linkUpdate ?? {}), ...result };
          await setCopyProgress("skipped", result.message, link, linkUpdate);
          await ctx.event("info", "Copy skipped", result);
        }
      } catch (error: unknown) {
        if (error instanceof CopyReconciliationRequiredError || filesystemMutationCompleted) {
          const reconciliationError =
            error instanceof CopyReconciliationRequiredError
              ? error
              : new CopyReconciliationRequiredError(`Copy operation could not be committed after filesystem promotion: ${errorMessage(error)}`, { cause: error });
          if (activeOperationId) {
            await ctx.withLeaseDb((leaseDb) => requireCopyOperationReconciliation(leaseDb, activeOperationId!, reconciliationError.message));
          }
          throw reconciliationError;
        }
        if (await ctx.isCancelled()) {
          if (!cancellationReported) {
            cancellationReported = true;
            await setCopyProgress("cancelled", "Copy job termination requested", link, linkUpdate);
            await ctx.event("warn", "Copy job termination requested; active copies were stopped before promotion", {
              direction: normalizedOptions.direction,
              itemName: link.itemName,
              linkPath: link.linkPath,
              sourcePath: link.targetPath
            });
          }
          return;
        }
        if (ctx.signal.aborted) throw (ctx.signal.reason instanceof Error ? ctx.signal.reason : error);
        failed += 1;
        if (activeOperationId && !filesystemMutationCompleted) {
          await ctx.withLeaseDb((leaseDb) => failCopyOperation(leaseDb, activeOperationId!, errorMessage(error)));
        }
        await setCopyProgress("failed", errorMessage(error), link);
        await ctx.event("error", errorMessage(error), {
          direction: normalizedOptions.direction,
          itemName: link.itemName,
          linkPath: link.linkPath,
          sourcePath: link.targetPath
        });
      }
    };

    await runKeyedPool(
      links,
      this.concurrency.copyFileConcurrency,
      (link) => String(link.id),
      processLink,
      () => !ctx.signal.aborted
    );

    const cancelled = await ctx.isCancelled();
    if (!cancelled && ctx.signal.aborted) {
      throw (ctx.signal.reason instanceof Error ? ctx.signal.reason : new WorkerShutdownError());
    }
    const rollbackCancelledCopy = async () => {
      await setCopyProgress("cancelled", "Rolling back completed copy changes");
      const { rolledBack, warnings } = await rollbackDurableCopyOperations(this.db, ctx.jobId, paths, ctx);
      copied = resumedCopied;
      repointed = resumedRepointed;
      for (const warning of warnings) {
        await ctx.event("warn", warning);
      }
      await ctx.event("warn", "Copy job terminated; completed copy changes rolled back", { rolledBack, warnings });
    };
    if (cancelled) await rollbackCancelledCopy();
    if (!cancelled && failed > 0) {
      const itemLabel = total === 1 ? "media item" : "media items";
      const completed = copied + repointed + skipped + conflicts;
      const partialFailure = completed > 0;
      const failureMessage = partialFailure ? `Copy job partially failed: ${failed} of ${total} ${itemLabel} failed` : `Copy job failed: ${failed} of ${total} ${itemLabel} failed`;
      await setCopyProgress(partialFailure ? "partially_failed" : "failed", failureMessage);
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
    if (!cancelled) {
      if (replacementCandidateEntries.size > 0) {
        await setCopyProgress("symlinking", "Finalizing previous local-file replacements");
      }
      await setCopyProgress("completed", links.length === 0 && alreadyCompleted === 0 ? "No matching media found" : "Copy job finished");
      await ctx.event("info", "Copy job finished processing media", { total, copied, repointed, skipped, conflicts, failed, unavailable });
      const finalized = await ctx.finishCompletedIsolated(async (leaseDb) => {
        const finalizationWarnings: string[] = [];
        for (const entry of replacementCandidateEntries.values()) {
          try {
            const removed = await removeLocalConflictCandidates(
              leaseDb,
              paths,
              entry.candidates,
              entry.destinationPath,
              entry.expectedIdentities,
              entry.linkId,
              selectedDestinations
            );
            if (removed.length > 0) {
              await leaseDb.insert(schema.jobEvents).values({
                jobId: ctx.jobId,
                timestamp: nowIso(),
                level: "info",
                message: "Replaced previous local files",
                data: JSON.stringify({ linkId: entry.linkId, removed })
              });
            }
          } catch (error: unknown) {
            finalizationWarnings.push(`Could not remove every previous local file for media #${entry.linkId}: ${errorMessage(error)}`);
          }
        }

        const operationsWithBackups = (
          await leaseDb
            .select()
            .from(schema.copyOperations)
            .where(and(eq(schema.copyOperations.jobId, ctx.jobId), eq(schema.copyOperations.stage, "committed")))
        ).filter((operation) => Boolean(operation.displacedPath));
        for (const operation of operationsWithBackups) {
          try {
            if (operation.localConflictStrategy === "replace") {
              const rootType = copyOperationDestinationRoot(operation, paths);
              await removeJournalFile(
                rootType === "local" ? paths.localDir : paths.remoteDir,
                operation.displacedPath,
                operation.displacedIdentity,
                "Displaced destination backup"
              );
            }
            await leaseDb
              .update(schema.copyOperations)
              .set({ displacedPath: null, displacedIdentity: null, updatedAt: nowIso() })
              .where(eq(schema.copyOperations.id, operation.id));
          } catch (error: unknown) {
            finalizationWarnings.push(`Could not finalize displaced backup for copy operation #${operation.id}: ${errorMessage(error)}`);
          }
        }
        for (const warning of finalizationWarnings) {
          await leaseDb.insert(schema.jobEvents).values({ jobId: ctx.jobId, timestamp: nowIso(), level: "warn", message: warning, data: "{}" });
        }
      });
      if (finalized) return;
      await rollbackCancelledCopy();
    }
    await setCopyProgress("cancelled", "Copy job terminated");
    await ctx.event("warn", "Copy job terminated", { total, copied, repointed, skipped, conflicts, failed, unavailable });
  }
}
