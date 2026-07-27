import { auditOptionsFromJob, copyOptionsFromJob, normalizeAuditTargets, scanOptionsFromJob } from "./jobScopeLocks";
import { type AuditMode, type AuditOptions, type AuditRunRecord, type JobEventRecord, type JobRecord, type JobStatus, type JobType, type CopyOptions, type MediaLinkRow, type ScanOptions, type ScanRunRecord, type ScanTitleScope, type StorageLocationsSettings } from "../shared/types";
import { AuditStatusPrompt, CopyPrompt, finiteNullableNumberFromUnknown, finiteNumberFromUnknown, formatBytes, formatDuration, formatDurationMs, formatNumber, recordFromUnknown, ScanStatusPrompt, sectionDisplayTitle, storageLocationName } from "./appShared";

export type CopyProgressView = {
  current: number;
  total: number;
  copied: number;
  repointed: number;
  skipped: number;
  conflicts: number;
  failed: number;
  stage: string;
  message: string | null;
  currentTitle: string | null;
  currentFile: string | null;
  sourcePath: string | null;
  destinationPath: string | null;
  sizeBytes: number | null;
  bytesCopied: number | null;
  bytesProcessed: number | null;
  totalBytes: number | null;
  bytesPerSecond: number | null;
  remainingSeconds: number | null;
  direction: CopyOptions["direction"] | null;
};

export type CopyFailedItemSummary = {
  key: string;
  title: string;
  fileName: string | null;
  reason: string;
};

export type CopyCompletedItemSummary = {
  key: string;
  title: string;
  fileName: string | null;
  outcome: "Copied and symlinked" | "Matched existing and symlinked";
};

function copyFailureReason(message: string): string {
  const normalized = message.replace(/\s+/g, " ").trim();
  const lower = normalized.toLowerCase();
  if (lower.includes("moov atom not found")) return "Media validation failed: moov atom not found";
  if (lower.includes("invalid data found when processing input")) return "Media validation failed: invalid media data";
  if (lower.startsWith("ffmpeg fast validation failed")) return "Fast media validation failed";
  if (lower.startsWith("ffmpeg deep validation failed")) return "Deep media validation failed";
  return normalized.length > 160 ? `${normalized.slice(0, 157)}...` : normalized;
}

export function copyFailedItemSummaries(events: JobEventRecord[]): CopyFailedItemSummary[] {
  const failures = new Map<string, CopyFailedItemSummary>();
  for (const event of events) {
    if (event.level !== "error") continue;
    const data = recordFromUnknown(event.data);
    const title = typeof data?.itemName === "string" ? data.itemName.trim() : "";
    if (!title) continue;
    const linkPath = typeof data?.linkPath === "string" ? data.linkPath : null;
    const sourcePath = typeof data?.sourcePath === "string" ? data.sourcePath : null;
    const fileName = basenameFromPath(sourcePath) ?? basenameFromPath(linkPath);
    const key = linkPath?.trim() || sourcePath?.trim() || `${title}:${fileName ?? ""}`;
    failures.set(key, { key, title, fileName, reason: copyFailureReason(event.message) });
  }
  return [...failures.values()].sort((left, right) => left.title.localeCompare(right.title, undefined, { sensitivity: "base" }) || (left.fileName ?? "").localeCompare(right.fileName ?? "", undefined, { sensitivity: "base" }));
}

const successfulCopyMessages = new Map<
  string,
  CopyCompletedItemSummary["outcome"]
>([
  ["Verified copy installed", "Copied and symlinked"],
  ["Copy installed without verification", "Copied and symlinked"],
  ["Symlink repointed to existing verified file", "Matched existing and symlinked"]
]);

function copyEventKeys(data: Record<string, unknown> | null): string[] {
  if (!data) return [];
  return [data.linkPath, data.sourcePath, data.destinationPath]
    .filter((value): value is string => typeof value === "string" && Boolean(value.trim()))
    .map((value) => value.trim());
}

export function copyCompletedItemSummaries(events: JobEventRecord[]): CopyCompletedItemSummary[] {
  const titlesByPath = new Map<string, string>();
  for (const event of events) {
    const data = recordFromUnknown(event.data);
    const title = typeof data?.itemName === "string"
      ? data.itemName.trim()
      : typeof data?.currentTitle === "string"
        ? data.currentTitle.trim()
        : "";
    if (!title) continue;
    for (const key of copyEventKeys(data)) titlesByPath.set(key, title);
  }

  const completed = new Map<string, CopyCompletedItemSummary>();
  for (const event of events) {
    const outcome = successfulCopyMessages.get(event.message);
    if (!outcome) continue;
    const data = recordFromUnknown(event.data);
    const keys = copyEventKeys(data);
    const filePath = typeof data?.destinationPath === "string"
      ? data.destinationPath
      : typeof data?.sourcePath === "string"
        ? data.sourcePath
        : typeof data?.linkPath === "string"
          ? data.linkPath
          : null;
    const fileName = basenameFromPath(filePath);
    const directTitle = typeof data?.itemName === "string"
      ? data.itemName.trim()
      : typeof data?.currentTitle === "string"
        ? data.currentTitle.trim()
        : "";
    const title = directTitle || keys.map((key) => titlesByPath.get(key)).find(Boolean) || fileName || "Completed item";
    const key = keys[0] ?? `${title}:${fileName ?? ""}`;
    completed.set(key, { key, title, fileName, outcome });
  }

  return [...completed.values()].sort((left, right) => left.title.localeCompare(right.title, undefined, { sensitivity: "base" }) || (left.fileName ?? "").localeCompare(right.fileName ?? "", undefined, { sensitivity: "base" }));
}

export function copyProgressFromJob(job: JobRecord | null): CopyProgressView {
  const progress = recordFromUnknown(job?.progress);
  const options = recordFromUnknown(progress?.options);
  const direction = options?.direction === "to_local" || options?.direction === "to_remote" ? options.direction : null;
  return {
    current: finiteNumberFromUnknown(progress?.current),
    total: finiteNumberFromUnknown(progress?.total),
    copied: finiteNumberFromUnknown(progress?.copied),
    repointed: finiteNumberFromUnknown(progress?.repointed),
    skipped: finiteNumberFromUnknown(progress?.skipped),
    conflicts: finiteNumberFromUnknown(progress?.conflicts),
    failed: finiteNumberFromUnknown(progress?.failed),
    stage: typeof progress?.stage === "string" ? progress.stage : job?.status === "queued" ? "queued" : "waiting",
    message: typeof progress?.message === "string" ? progress.message : null,
    currentTitle: typeof progress?.currentTitle === "string" ? progress.currentTitle : null,
    currentFile: typeof progress?.currentFile === "string" ? progress.currentFile : null,
    sourcePath: typeof progress?.sourcePath === "string" ? progress.sourcePath : null,
    destinationPath: typeof progress?.destinationPath === "string" ? progress.destinationPath : null,
    sizeBytes: finiteNullableNumberFromUnknown(progress?.sizeBytes),
    bytesCopied: finiteNullableNumberFromUnknown(progress?.bytesCopied),
    bytesProcessed: finiteNullableNumberFromUnknown(progress?.bytesProcessed),
    totalBytes: finiteNullableNumberFromUnknown(progress?.totalBytes),
    bytesPerSecond: finiteNullableNumberFromUnknown(progress?.bytesPerSecond),
    remainingSeconds: finiteNullableNumberFromUnknown(progress?.remainingSeconds),
    direction
  };
}

export function copyCompletedCount(progress: Pick<CopyProgressView, "copied" | "repointed" | "skipped" | "conflicts" | "failed">): number {
  return progress.copied + progress.repointed + progress.skipped + progress.conflicts + progress.failed;
}

export function copySymlinkedCount(progress: Pick<CopyProgressView, "copied" | "repointed">): number {
  return progress.copied + progress.repointed;
}

export function copyStageFraction(stage: string): number {
  if (stage === "preparing" || stage === "queued") return 0.05;
  if (stage === "copying") return 0.35;
  if (stage === "verifying") return 0.75;
  if (stage === "symlinking") return 0.9;
  if (stage === "done" || stage === "skipped" || stage === "conflict" || stage === "partially_failed" || stage === "failed") return 1;
  if (stage === "completed" || stage === "cancelled") return 1;
  return 0;
}

export function copyStageHasByteProgress(stage: string): boolean {
  return stage === "copying" || stage === "verifying";
}

export function copyStageBytes(progress: Pick<CopyProgressView, "stage" | "bytesCopied" | "bytesProcessed">): number | null {
  if (progress.stage === "copying") return progress.bytesCopied ?? progress.bytesProcessed;
  if (progress.stage === "verifying") return progress.bytesProcessed ?? progress.bytesCopied;
  return null;
}

export function copyStagePercent(job: JobRecord | null, progress: CopyProgressView): number {
  if (job?.status === "completed") return 100;
  if (job?.status === "partially_failed" || job?.status === "failed" || job?.status === "cancelled") return Math.round(copyStageFraction(progress.stage) * 100);
  const stageBytes = copyStageBytes(progress);
  if (copyStageHasByteProgress(progress.stage) && progress.totalBytes && progress.totalBytes > 0 && stageBytes != null) {
    return Math.min(99, Math.max(0, Math.round((stageBytes / progress.totalBytes) * 100)));
  }
  return Math.round(copyStageFraction(progress.stage) * 100);
}

export function copyStageLabel(stage: string, direction?: CopyOptions["direction"] | null): string {
  if (stage === "queued") return "Queued";
  if (stage === "preparing") return "Preparing";
  if (stage === "copying" && direction === "to_local") return "Downloading";
  if (stage === "copying" && direction === "to_remote") return "Uploading";
  if (stage === "copying") return "Copying";
  if (stage === "verifying") return "Verifying";
  if (stage === "symlinking") return "Symlinking";
  if (stage === "done") return "Done";
  if (stage === "skipped") return "Skipped";
  if (stage === "conflict") return "Conflict";
  if (stage === "partially_failed" || stage === "partial_failed") return "Partially failed";
  if (stage === "failed") return "Failed";
  if (stage === "completed") return "Completed";
  if (stage === "cancelled") return "Cancelled";
  return "Waiting";
}

export function copyOverallProgressPercent(job: JobRecord | null, progress: CopyProgressView): number {
  if (progress.total <= 0) return job?.status === "completed" ? 100 : 0;
  const completed = copyCompletedCount(progress);
  if (job?.status === "completed") return 100;
  if (job?.status === "partially_failed" || job?.status === "failed" || job?.status === "cancelled") return Math.min(100, Math.round((completed / progress.total) * 100));
  const activeItemBase = progress.current > completed ? Math.max(0, progress.current - 1) : completed;
  const activeProgress = progress.current > completed ? copyItemFraction(progress) : 0;
  return Math.min(99, Math.round(((activeItemBase + activeProgress) / progress.total) * 100));
}

export function copyItemFraction(progress: CopyProgressView): number {
  const stageBytes = copyStageBytes(progress);
  if (progress.stage === "copying" && progress.totalBytes && progress.totalBytes > 0 && stageBytes != null) {
    const transferFraction = Math.min(1, Math.max(0, stageBytes / progress.totalBytes));
    return 0.05 + transferFraction * 0.65;
  }
  if (progress.stage === "verifying" && progress.totalBytes && progress.totalBytes > 0 && stageBytes != null) {
    const verifyFraction = Math.min(1, Math.max(0, stageBytes / progress.totalBytes));
    return 0.7 + verifyFraction * 0.2;
  }
  return copyStageFraction(progress.stage);
}

export function copyRemainingLabel(job: JobRecord | null, progress: CopyProgressView, overallPercent: number): string {
  if (!job || job.status === "queued") return "-";
  if (job.status !== "running") return "Done";
  if (progress.total <= 0) return "-";
  if (copyStageHasByteProgress(progress.stage) && progress.remainingSeconds != null && Number.isFinite(progress.remainingSeconds)) return formatDurationMs(progress.remainingSeconds * 1000);
  const startedAt = Date.parse(job.startedAt ?? "");
  const overallFraction = overallPercent / 100;
  if (!Number.isFinite(startedAt) || overallFraction <= 0) return "Estimating";
  if (overallPercent >= 99) return "Finalizing";
  return formatDurationMs(((Date.now() - startedAt) / overallFraction) * (1 - overallFraction));
}

export function copyTransferSpeedLabel(progress: CopyProgressView): string {
  if (!copyStageHasByteProgress(progress.stage)) return "-";
  if (!progress.bytesPerSecond || progress.bytesPerSecond <= 0) return "-";
  return `${formatBytes(Math.round(progress.bytesPerSecond))}/s`;
}

export function formatMegabitsPerSecond(bytesPerSecond: number): string {
  const megabitsPerSecond = (bytesPerSecond * 8) / 1_000_000;
  const precision = megabitsPerSecond >= 100 ? 0 : megabitsPerSecond >= 10 ? 1 : 2;
  return `${megabitsPerSecond.toFixed(precision)} Mbps`;
}

export function copyTransferSpeedSecondaryLabel(progress: CopyProgressView): string | null {
  if (progress.stage !== "copying") return null;
  if (!progress.bytesPerSecond || progress.bytesPerSecond <= 0) return null;
  return formatMegabitsPerSecond(progress.bytesPerSecond);
}

export function copyThroughputLabel(progress: CopyProgressView): string {
  if (progress.stage === "verifying") return "Verify speed";
  if (progress.stage === "copying") return "Transfer speed";
  return "Speed";
}

export function basenameFromPath(value: string | null | undefined): string | null {
  const normalized = value?.trim().replace(/\\/g, "/");
  if (!normalized) return null;
  return normalized.split("/").filter(Boolean).pop() ?? normalized;
}

export function copyCurrentItem(progress: CopyProgressView, job: JobRecord | null): { title: string; fileName: string | null; detail: string } {
  const fileName = basenameFromPath(progress.currentFile) ?? basenameFromPath(progress.sourcePath) ?? basenameFromPath(progress.destinationPath);
  const title = progress.currentTitle ?? fileName ?? (job ? "Waiting for current item" : "Waiting for copy job");
  return {
    title,
    fileName: fileName && fileName !== title ? fileName : null,
    detail: progress.message ?? "Waiting for worker progress."
  };
}

export function copyEventChips(record: Record<string, unknown> | null): Array<{ label: string; value: string }> {
  if (!record) return [];
  const chips: Array<{ label: string; value: string }> = [];
  const current = finiteNullableNumberFromUnknown(record.current);
  const total = finiteNumberFromUnknown(record.total);
  const completed = copyCompletedCount({
    copied: finiteNumberFromUnknown(record.copied),
    repointed: finiteNumberFromUnknown(record.repointed),
    skipped: finiteNumberFromUnknown(record.skipped),
    conflicts: finiteNumberFromUnknown(record.conflicts),
    failed: finiteNumberFromUnknown(record.failed)
  });
  const bytesPerSecond = finiteNullableNumberFromUnknown(record.bytesPerSecond);
  const remainingSeconds = finiteNullableNumberFromUnknown(record.remainingSeconds);
  const sizeBytes = finiteNullableNumberFromUnknown(record.sizeBytes ?? record.totalBytes);
  const title = typeof record.currentTitle === "string" ? record.currentTitle : typeof record.itemName === "string" ? record.itemName : null;
  const stage = typeof record.stage === "string" ? record.stage : null;
  const progressCurrent = current ?? completed;

  if (progressCurrent > 0 || total > 0) chips.push({ label: "Progress", value: `${formatNumber(progressCurrent)} / ${formatNumber(total)}` });
  if (stage) chips.push({ label: "Step", value: copyStageLabel(stage, record.direction === "to_remote" || record.direction === "to_local" ? record.direction : null) });
  if (stage && copyStageHasByteProgress(stage) && bytesPerSecond && bytesPerSecond > 0) {
    chips.push({
      label: stage === "verifying" ? "Verify speed" : "Transfer speed",
      value: stage === "copying" ? `${formatBytes(Math.round(bytesPerSecond))}/s - ${formatMegabitsPerSecond(bytesPerSecond)}` : `${formatBytes(Math.round(bytesPerSecond))}/s`
    });
  }
  if (remainingSeconds != null) chips.push({ label: "Remaining", value: formatDurationMs(remainingSeconds * 1000) });
  if (sizeBytes != null && sizeBytes > 0) chips.push({ label: "Size", value: formatBytes(sizeBytes) });
  if (record.direction === "to_local" || record.direction === "to_remote") chips.push({ label: "Direction", value: record.direction === "to_local" ? "To local" : "To remote" });
  if (title) chips.push({ label: "Title", value: title });

  return chips.slice(0, 6);
}

export function countJobsByStatus(jobs: JobRecord[], status: JobStatus): number {
  return jobs.filter((job) => job.status === status).length;
}

export function countJobsByType(jobs: JobRecord[], type: JobType): number {
  return jobs.filter((job) => job.type === type).length;
}

export function countEventsByLevel(events: JobEventRecord[], level: JobEventRecord["level"]): number {
  return events.filter((event) => event.level === level).length;
}

export function jobDurationLabel(job: JobRecord): string {
  if (!job.startedAt) return job.status === "queued" ? "Queued" : "-";
  if (!job.finishedAt) return job.status === "running" ? "Running" : "In progress";
  return formatDuration(job.startedAt, job.finishedAt);
}

export type AuditProgressView = {
  checked: number;
  total: number;
  passed: number;
  failed: number;
  sourceUnknown: number;
  sourceMissing: number;
  sourceCompareErrors: number;
  byteMismatches: number;
  stage: string;
  message: string | null;
  currentTitle: string | null;
  currentFile: string | null;
};

export function auditProgressFromJob(job: JobRecord | null, auditRun?: AuditRunRecord | null): AuditProgressView {
  const progress = recordFromUnknown(job?.progress);
  const stage = typeof progress?.stage === "string" ? progress.stage : job?.status === "queued" ? "queued" : job?.status === "running" ? "auditing" : job?.status ?? "waiting";
  return {
    checked: finiteNumberFromUnknown(progress?.checked) || (auditRun?.checked ?? 0),
    total: finiteNumberFromUnknown(progress?.total) || (auditRun?.checked ?? 0),
    passed: finiteNumberFromUnknown(progress?.passed) || (auditRun?.passed ?? 0),
    failed: finiteNumberFromUnknown(progress?.failed) || (auditRun?.failed ?? 0),
    sourceUnknown: finiteNumberFromUnknown(progress?.sourceUnknown) || (auditRun?.sourceUnknown ?? 0),
    sourceMissing: finiteNumberFromUnknown(progress?.sourceMissing) || (auditRun?.sourceMissing ?? 0),
    sourceCompareErrors: finiteNumberFromUnknown(progress?.sourceCompareErrors) || (auditRun?.sourceCompareErrors ?? 0),
    byteMismatches: finiteNumberFromUnknown(progress?.byteMismatches) || (auditRun?.byteMismatches ?? 0),
    stage,
    message: typeof progress?.message === "string" ? progress.message : null,
    currentTitle: typeof progress?.currentTitle === "string" ? progress.currentTitle : null,
    currentFile: typeof progress?.currentFile === "string" ? progress.currentFile : typeof progress?.targetPath === "string" ? progress.targetPath : null
  };
}

export function auditStageLabel(stage: string, status?: JobStatus | null): string {
  if (status === "completed" || stage === "completed") return "Completed";
  if (status === "failed" || stage === "failed") return "Failed";
  if (status === "cancelled" || stage === "cancelled") return "Cancelled";
  if (stage === "queued") return "Queued";
  if (stage === "auditing" || stage === "running") return "Auditing media";
  return "Waiting";
}

export function auditProgressPercent(job: JobRecord | null, progress: AuditProgressView): number {
  if (job?.status === "completed" || progress.stage === "completed") return 100;
  if (job?.status === "failed" || job?.status === "cancelled") return 100;
  if (progress.total > 0) return Math.min(100, Math.round((progress.checked / progress.total) * 100));
  return job?.status === "queued" ? 5 : job?.status === "running" ? 35 : 0;
}

export function auditStatusDetail(job: JobRecord | null, progress: AuditProgressView): string {
  if (!job) return "Loading audit job status.";
  if (job.status === "queued") return "Waiting for a worker to start this audit.";
  if (job.status === "running") return progress.message ?? "Reading media and recording validation results.";
  if (job.status === "completed") return "Audit finished and results were indexed.";
  if (job.status === "failed") return progress.message ?? "Audit failed.";
  if (job.status === "cancelled") return "Audit was cancelled.";
  return progress.message ?? "Waiting for audit progress.";
}

export function selectedAllFolders(sections: string[], availableSections: Array<{ section: string; title?: string | null }>): boolean {
  if (availableSections.length === 0 || sections.length !== availableSections.length) return false;
  const selected = new Set(sections);
  return availableSections.every((section) => selected.has(section.section));
}

export function formatFolderScope(sections: string[] | undefined, availableSections: Array<{ section: string; title?: string | null }>): string {
  if (sections == null) return "All folders";
  if (sections.length === 0) return "No folders";
  if (selectedAllFolders(sections, availableSections)) return "All folders";

  const titleBySection = new Map(availableSections.map((section) => [section.section, sectionDisplayTitle(section)]));
  return sections.map((section) => titleBySection.get(section) ?? section).join(", ");
}

export function formatScopedFolderParts(parts: Array<{ label: string; folders: string }>): string {
  if (parts.length === 0) return "No folders";
  const uniqueFolderLabels = new Set(parts.map((part) => part.folders));
  if (uniqueFolderLabels.size === 1) return parts[0]?.folders ?? "No folders";
  return parts.map((part) => `${part.label}: ${part.folders}`).join(" / ");
}

export function formatTitleScanScope(titleScopes: ScanTitleScope[], availableSections: Array<{ section: string; title?: string | null }>): string {
  const titleBySection = new Map(availableSections.map((section) => [section.section, sectionDisplayTitle(section)]));
  const labels = titleScopes.map((scope) => `${titleBySection.get(scope.section) ?? scope.section} / ${scope.itemName}`);
  if (labels.length <= 2) return labels.join(", ");
  return `${labels.slice(0, 2).join(", ")} +${labels.length - 2}`;
}

export function formatTitleScanJobDetail(titleScopes: ScanTitleScope[], availableSections: Array<{ section: string; title?: string | null }>): string {
  const titleBySection = new Map(availableSections.map((section) => [section.section, sectionDisplayTitle(section)]));
  const labels = titleScopes.map((scope) => `${scope.itemName} - ${titleBySection.get(scope.section) ?? scope.section}`);
  if (labels.length <= 2) return labels.join(", ");
  return `${labels.slice(0, 2).join(", ")} +${labels.length - 2}`;
}

export function scanScopeLabels(options: Partial<ScanOptions>): string[] {
  return [
    options.scanSymlinks ? "Symlinks" : null,
    options.scanLocal ? "Local files" : null,
    options.scanRemote ? "Remote files" : null
  ].filter((scope): scope is string => Boolean(scope));
}

export function scanFolderScopeParts(options: Partial<ScanOptions>, availableSections: Array<{ section: string; title?: string | null }>): Array<{ label: string; folders: string }> {
  return [
    options.scanSymlinks ? { label: "Symlinks", folders: formatFolderScope(options.symlinkSections ?? options.sections, availableSections) } : null,
    options.scanLocal ? { label: "Local", folders: formatFolderScope(options.localSections ?? options.sections, availableSections) } : null,
    options.scanRemote ? { label: "Remote", folders: "All folders" } : null
  ].filter((part): part is { label: string; folders: string } => Boolean(part));
}

export function formatScanScope(options: Partial<ScanOptions> | null, availableSections: Array<{ section: string; title?: string | null }>): string {
  if (!options) return "Inventory scan";
  if (options.titleScopes?.length) return `Title rescan - ${formatTitleScanScope(options.titleScopes, availableSections)}`;
  const scopes = scanScopeLabels(options);
  const folderText = formatScopedFolderParts(scanFolderScopeParts(options, availableSections));
  return scopes.length > 0 ? `${scopes.join(", ")} - ${folderText}` : folderText;
}

export type AuditScopeDisplayOptions = Omit<Partial<AuditOptions>, "mode"> & { mode?: AuditMode | null };

export function formatAuditScope(options: AuditScopeDisplayOptions, availableSections: Array<{ section: string; title?: string | null }>): string {
  if (options.linkIds?.length) return options.linkIds.length === 1 ? "1 selected link" : `${options.linkIds.length} selected links`;
  if (options.itemName) {
    const folderTitle = options.section ? (availableSections.find((section) => section.section === options.section)?.title ?? options.section) : null;
    const pathScope = options.relativePathPrefix ? ` / ${options.relativePathPrefix}` : "";
    return `${folderTitle ? `${folderTitle} / ` : ""}${options.itemName}${pathScope}`;
  }
  if (options.section) return availableSections.find((section) => section.section === options.section)?.title ?? options.section;
  const targets = normalizeAuditTargets(options.targets);
  const parts = [
    targets.includes("local") ? { label: "Local", scope: formatFolderScope(options.sections, availableSections) } : null,
    targets.includes("remote") ? { label: "Remote", scope: "Remote root" } : null
  ].filter((part): part is { label: string; scope: string } => Boolean(part));
  if (parts.length === 0) return "No targets";
  return parts.map((part) => `${part.label}: ${part.scope}`).join(" / ");
}

export function formatCopyScope(options: CopyOptions | null, availableSections: Array<{ section: string; title?: string | null }>): string {
  if (!options) return "Copy job";
  if (options.linkIds?.length) return options.linkIds.length === 1 ? "1 selected link" : `${options.linkIds.length} selected links`;
  if (options.itemName) {
    const folderTitle = options.section ? (availableSections.find((section) => section.section === options.section)?.title ?? options.section) : null;
    const pathScope = options.relativePathPrefix ? ` / ${options.relativePathPrefix}` : "";
    return `${folderTitle ? `${folderTitle} / ` : ""}${options.itemName}${pathScope}`;
  }
  if (options.section) return availableSections.find((section) => section.section === options.section)?.title ?? options.section;
  return "Scoped copy";
}

export function selectedLinkIdsFromJob(job: JobRecord): number[] {
  if (job.type === "copy") return copyOptionsFromJob(job)?.linkIds ?? [];
  if (job.type === "audit") return auditOptionsFromJob(job).linkIds ?? [];
  return [];
}

export function selectedLinkIdsFromJobs(jobs: JobRecord[]): number[] {
  const ids = new Set<number>();
  for (const job of jobs) {
    for (const id of selectedLinkIdsFromJob(job)) ids.add(id);
  }
  return [...ids].sort((first, second) => first - second);
}

export function selectedLinkTitleSummaries(linkIds: number[], linkRowsById: Map<number, MediaLinkRow> | undefined): string[] {
  if (!linkRowsById) return [];
  const counts = new Map<string, number>();
  let missingCount = 0;

  for (const id of linkIds) {
    const link = linkRowsById.get(id);
    if (!link) {
      missingCount += 1;
      continue;
    }
    const title = link.itemName.trim() || link.relativePath || `Link #${id}`;
    counts.set(title, (counts.get(title) ?? 0) + 1);
  }

  const summaries = [...counts.entries()]
    .sort(([firstTitle], [secondTitle]) => firstTitle.localeCompare(secondTitle, undefined, { numeric: true, sensitivity: "base" }))
    .map(([title, count]) => (count > 1 ? `${title} (${formatNumber(count)} links)` : title));
  if (missingCount > 0) summaries.push(`${formatNumber(missingCount)} link${missingCount === 1 ? "" : "s"} not found in current inventory`);
  return summaries;
}

export function singleSelectedLinkTitle(linkIds: number[], linkRowsById: Map<number, MediaLinkRow> | undefined): string | null {
  if (!linkRowsById || linkIds.length === 0) return null;
  let selectedTitle: { key: string; label: string } | null = null;

  for (const id of linkIds) {
    const link = linkRowsById.get(id);
    const label = link?.itemName.trim();
    if (!link || !label) return null;
    const key = `${link.section}\0${label}`;
    if (selectedTitle && selectedTitle.key !== key) return null;
    selectedTitle = { key, label };
  }

  return selectedTitle?.label ?? null;
}

export function copyPromptFromJob(
  job: JobRecord,
  availableSections: Array<{ section: string; title?: string | null }>,
  storageLocations: StorageLocationsSettings
): CopyPrompt {
  const options = copyOptionsFromJob(job);
  const directionLabel = options?.direction === "to_remote" ? storageLocationName(storageLocations, "remote") : storageLocationName(storageLocations, "local");
  return {
    key: `copy-job-${job.id}`,
    title: `Copy to ${directionLabel}`,
    description: formatCopyScope(options, availableSections),
    jobId: job.id
  };
}

export function scanStatusPromptFromJob(job: JobRecord, availableSections: Array<{ section: string; title?: string | null }>): ScanStatusPrompt {
  const options = scanOptionsFromJob(job);
  return {
    key: `scan-job-${job.id}`,
    title: options?.titleScopes?.length ? "Title rescan" : "Inventory scan",
    description: formatScanScope(options, availableSections),
    jobId: job.id
  };
}

export function scanStatusPromptFromRun(run: ScanRunRecord, availableSections: Array<{ section: string; title?: string | null }>): ScanStatusPrompt {
  return {
    key: `scan-run-${run.id ?? run.jobId}`,
    title: run.options?.titleScopes?.length ? "Title rescan" : "Inventory scan",
    description: run.options ? formatScanScope(run.options, availableSections) : run.id == null ? "No scan run record was created" : `Scan #${run.id}`,
    jobId: run.jobId
  };
}

export function auditStatusPromptFromJob(job: JobRecord, availableSections: Array<{ section: string; title?: string | null }>): AuditStatusPrompt {
  const options = auditOptionsFromJob(job);
  const modeText = options.mode === "deep" ? "Deep audit" : "Fast audit";
  return {
    key: `audit-job-${job.id}`,
    title: modeText,
    description: formatAuditScope(options, availableSections),
    jobId: job.id
  };
}

export function auditStatusPromptFromRun(run: AuditRunRecord, availableSections: Array<{ section: string; title?: string | null }>): AuditStatusPrompt {
  return {
    key: `audit-run-${run.id}`,
    title: run.mode === "deep" ? "Deep audit" : "Fast audit",
    description: run.options ? formatAuditScope(run.options, availableSections) : `Audit #${run.id}`,
    jobId: run.jobId,
    auditRunId: run.id
  };
}

export function copyPromptKey(options: CopyOptions): string {
  return [
    "copy",
    options.direction,
    options.section ?? "",
    options.itemName ?? "",
    options.relativePathPrefix ?? "",
    options.linkIds?.join(",") ?? "",
    options.localConflictStrategy ?? ""
  ].join(":");
}
