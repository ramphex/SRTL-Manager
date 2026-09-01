import type { AuditMode, CopyOptions, JobRecord, MediaLinkRow, ScanOptions, ScanTitleScope, StoragePolicyTitle, StorageRootType } from "../shared/types";

type AuditJobOptions = {
  mode: AuditMode | null;
  sections?: string[];
  targets?: StorageRootType[];
  linkIds?: number[];
  section?: string;
  itemName?: string;
  relativePathPrefix?: string;
  byteCompare?: boolean;
};

function recordFromUnknown(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

export function normalizeAuditTargets(targets: unknown): StorageRootType[] {
  if (!Array.isArray(targets)) return ["local", "remote"];
  const normalized = [...new Set(targets)].filter((target): target is StorageRootType => target === "local" || target === "remote");
  return normalized.length > 0 ? normalized : [];
}

export function auditOptionsFromJob(job: JobRecord): AuditJobOptions {
  const progress = recordFromUnknown(job.progress);
  const options = recordFromUnknown(job.options) ?? recordFromUnknown(progress?.options) ?? progress;
  return {
    mode: options?.mode === "fast" || options?.mode === "deep" ? options.mode : null,
    sections: Array.isArray(options?.sections) ? options.sections.filter((section): section is string => typeof section === "string") : undefined,
    targets: Array.isArray(options?.targets) ? normalizeAuditTargets(options.targets) : undefined,
    linkIds: job.selection?.linkIds ?? (Array.isArray(options?.linkIds) ? options.linkIds.filter((id): id is number => Number.isInteger(id)) : undefined),
    section: typeof options?.section === "string" ? options.section : undefined,
    itemName: typeof options?.itemName === "string" ? options.itemName : undefined,
    relativePathPrefix: typeof options?.relativePathPrefix === "string" ? options.relativePathPrefix : undefined,
    byteCompare: typeof options?.byteCompare === "boolean" ? options.byteCompare : undefined
  };
}

export function copyOptionsFromJob(job: JobRecord): CopyOptions | null {
  const progress = recordFromUnknown(job.progress);
  const options = recordFromUnknown(job.options) ?? recordFromUnknown(progress?.options) ?? progress;
  const direction = options?.direction === "to_local" || options?.direction === "to_remote" ? options.direction : null;
  if (!direction) return null;
  return {
    direction,
    linkIds: job.selection?.linkIds ?? (Array.isArray(options?.linkIds) ? options.linkIds.filter((id): id is number => Number.isInteger(id)) : undefined),
    section: typeof options?.section === "string" ? options.section : undefined,
    itemName: typeof options?.itemName === "string" ? options.itemName : undefined,
    relativePathPrefix: typeof options?.relativePathPrefix === "string" ? options.relativePathPrefix : undefined,
    localConflictStrategy: options?.localConflictStrategy === "keep_both" || options?.localConflictStrategy === "replace" ? options.localConflictStrategy : undefined,
    allowSourceTitleMismatch: options?.allowSourceTitleMismatch === true ? true : undefined
  };
}

function scanTitleScopesFromUnknown(value: unknown): ScanTitleScope[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value
    .map((scope) => recordFromUnknown(scope))
    .filter((scope): scope is Record<string, unknown> => Boolean(scope))
    .filter((scope) => typeof scope.section === "string" && typeof scope.itemName === "string")
    .map((scope) => ({ section: String(scope.section), itemName: String(scope.itemName) }));
}

export function scanOptionsFromJob(job: JobRecord): Partial<ScanOptions> | null {
  const progress = recordFromUnknown(job.progress);
  const options = recordFromUnknown(job.options) ?? recordFromUnknown(progress?.options) ?? progress;
  if (!options) return null;
  return {
    scanSymlinks: options.scanSymlinks === true,
    scanLocal: options.scanLocal === true,
    scanRemote: options.scanRemote === true,
    symlinkSections: Array.isArray(options.symlinkSections) ? options.symlinkSections.filter((section): section is string => typeof section === "string") : undefined,
    localSections: Array.isArray(options.localSections) ? options.localSections.filter((section): section is string => typeof section === "string") : undefined,
    titleScopes: scanTitleScopesFromUnknown(options.titleScopes),
    sections: Array.isArray(options.sections) ? options.sections.filter((section): section is string => typeof section === "string") : undefined
  };
}

function normalizedJobPath(value: string | undefined): string {
  return (value ?? "").replace(/\\/g, "/").split("/").filter(Boolean).join("/");
}

function jobPathMatchesPrefix(relativePath: string, prefix: string | undefined): boolean {
  const normalizedPath = normalizedJobPath(relativePath);
  const normalizedPrefix = normalizedJobPath(prefix);
  if (!normalizedPrefix) return true;
  return normalizedPath === normalizedPrefix || normalizedPath.startsWith(`${normalizedPrefix}/`);
}

function canonicalTitleKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/['\u2019]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function titleMatchesPolicyTitle(item: StoragePolicyTitle, title: string | undefined): boolean {
  if (!title) return true;
  return canonicalTitleKey(title) === canonicalTitleKey(item.normalizedTitle || item.title);
}

function policyTitleHasTarget(item: StoragePolicyTitle, target: StorageRootType): boolean {
  return target === "local" ? item.localLinkCount > 0 : item.remoteLinkCount > 0;
}

function policyTitleSectionMatches(item: StoragePolicyTitle, section: string | undefined): boolean {
  return !section || item.sections.includes(section);
}

export function isActiveQueueJob(job: JobRecord): boolean {
  return job.status === "queued" || job.status === "running";
}

function copyJobMatchesLink(job: JobRecord, link: MediaLinkRow): boolean {
  if (!isActiveQueueJob(job) || job.type !== "copy") return false;
  const options = copyOptionsFromJob(job);
  if (!options) return false;
  const requestedIds = options.linkIds?.length ? new Set(options.linkIds) : null;
  const sourceKind = options.direction === "to_local" ? "remote" : "local";
  const storagePolicy = options.direction === "to_local" ? "location_1" : "location_2";
  if (requestedIds && !requestedIds.has(link.id)) return false;
  if (link.kind !== sourceKind || link.storagePolicy !== storagePolicy || !link.isMedia || link.missingSince) return false;
  if (options.section && link.section !== options.section) return false;
  if (options.itemName && link.itemName !== options.itemName) return false;
  if (!jobPathMatchesPrefix(link.relativePath, options.relativePathPrefix)) return false;
  return true;
}

function scanJobMatchesLink(job: JobRecord, link: MediaLinkRow): boolean {
  if (!isActiveQueueJob(job) || job.type !== "scan") return false;
  const options = scanOptionsFromJob(job);
  if (!options?.scanSymlinks || !link.isMedia || link.missingSince) return false;
  if (options.titleScopes?.length) {
    return options.titleScopes.some((scope) => scope.section === link.section && canonicalTitleKey(scope.itemName) === canonicalTitleKey(link.itemName));
  }
  const sections = options.symlinkSections ?? options.sections;
  return !sections || sections.includes(link.section);
}

function auditJobMatchesLink(job: JobRecord, link: MediaLinkRow): boolean {
  if (!isActiveQueueJob(job) || job.type !== "audit") return false;
  const options = auditOptionsFromJob(job);
  const requestedIds = options.linkIds?.length ? new Set(options.linkIds) : null;
  const requestedTargets = new Set(normalizeAuditTargets(options.targets));
  const hasScopedOptions = Boolean(options.linkIds?.length || options.section || options.itemName || options.relativePathPrefix);

  if (hasScopedOptions) {
    if (requestedIds && !requestedIds.has(link.id)) return false;
    if (!link.isMedia || link.missingSince || (link.kind !== "local" && link.kind !== "remote")) return false;
    if (!requestedTargets.has(link.kind)) return false;
    if (options.section && link.section !== options.section) return false;
    if (options.itemName && link.itemName !== options.itemName) return false;
    if (!jobPathMatchesPrefix(link.relativePath, options.relativePathPrefix)) return false;
    return true;
  }

  const selectedSections = new Set(options.sections ?? []);
  return (link.kind === "local" || link.kind === "remote") && requestedTargets.has(link.kind) && (link.kind !== "local" || selectedSections.has(link.section)) && link.isMedia && !link.missingSince;
}

function symlinkCleanupJobMatchesLink(job: JobRecord, link: MediaLinkRow): boolean {
  return Boolean(isActiveQueueJob(job) && job.type === "symlink_cleanup" && job.selection?.linkIds?.includes(link.id));
}

function copyJobMatchesStoragePolicyTitle(job: JobRecord, item: StoragePolicyTitle): boolean {
  if (!isActiveQueueJob(job) || job.type !== "copy") return false;
  const options = copyOptionsFromJob(job);
  if (!options) return false;
  if (options.linkIds?.length && !options.itemName) return false;
  const sourceKind = options.direction === "to_local" ? "remote" : "local";
  const storagePolicy = options.direction === "to_local" ? "location_1" : "location_2";
  return item.policy === storagePolicy && policyTitleHasTarget(item, sourceKind) && policyTitleSectionMatches(item, options.section) && titleMatchesPolicyTitle(item, options.itemName);
}

function auditJobMatchesStoragePolicyTitle(job: JobRecord, item: StoragePolicyTitle): boolean {
  if (!isActiveQueueJob(job) || job.type !== "audit") return false;
  const options = auditOptionsFromJob(job);
  if (options.linkIds?.length && !options.itemName) return false;
  const requestedTargets = new Set(normalizeAuditTargets(options.targets));
  if (!titleMatchesPolicyTitle(item, options.itemName)) return false;
  if (!policyTitleSectionMatches(item, options.section)) return false;
  if (options.section || options.itemName || options.relativePathPrefix) {
    return (requestedTargets.has("local") && item.localLinkCount > 0) || (requestedTargets.has("remote") && item.remoteLinkCount > 0);
  }

  const selectedSections = new Set(options.sections ?? []);
  return (requestedTargets.has("remote") && item.remoteLinkCount > 0) || (requestedTargets.has("local") && item.localLinkCount > 0 && item.sections.some((section) => selectedSections.has(section)));
}

function scanJobMatchesStoragePolicyTitle(job: JobRecord, item: StoragePolicyTitle): boolean {
  if (!isActiveQueueJob(job) || job.type !== "scan") return false;
  const options = scanOptionsFromJob(job);
  if (!options?.scanSymlinks) return false;
  if (options.titleScopes?.length) {
    return options.titleScopes.some(
      (scope) => item.sections.includes(scope.section) && canonicalTitleKey(scope.itemName) === canonicalTitleKey(item.normalizedTitle || item.title)
    );
  }
  const sections = options.symlinkSections ?? options.sections;
  return !sections || item.sections.some((section) => sections.includes(section));
}

function symlinkCleanupJobMatchesStoragePolicyTitle(job: JobRecord, item: StoragePolicyTitle): boolean {
  if (!isActiveQueueJob(job) || job.type !== "symlink_cleanup") return false;
  return Boolean(
    job.selection?.titles.some(
      (title) => item.sections.includes(title.section) && canonicalTitleKey(title.itemName) === canonicalTitleKey(item.normalizedTitle || item.title)
    )
  );
}

export function activeJobForLink(link: MediaLinkRow, jobs: JobRecord[]): JobRecord | null {
  return jobs.find((job) => scanJobMatchesLink(job, link) || copyJobMatchesLink(job, link) || auditJobMatchesLink(job, link) || symlinkCleanupJobMatchesLink(job, link)) ?? null;
}

export function activeJobsForStoragePolicyTitle(item: StoragePolicyTitle, jobs: JobRecord[]): JobRecord[] {
  return jobs.filter(
    (job) =>
      scanJobMatchesStoragePolicyTitle(job, item) ||
      copyJobMatchesStoragePolicyTitle(job, item) ||
      auditJobMatchesStoragePolicyTitle(job, item) ||
      symlinkCleanupJobMatchesStoragePolicyTitle(job, item)
  );
}

export function activeJobsForLinks(links: MediaLinkRow[], jobByLinkId: Map<number, JobRecord>): JobRecord[] {
  const jobs = new Map<number, JobRecord>();
  for (const link of links) {
    const job = jobByLinkId.get(link.id);
    if (job) jobs.set(job.id, job);
  }
  return [...jobs.values()];
}

export function activeJobNotice(jobs: JobRecord[]): string | null {
  if (jobs.length === 0) return null;
  if (jobs.length === 1) {
    const job = jobs[0];
    return `Job #${job.id} is ${job.status}. Wait for it to finish or terminate it before issuing more actions.`;
  }
  return `${jobs.length.toLocaleString()} jobs are already queued/running. Wait for them to finish or terminate them before issuing more actions.`;
}
