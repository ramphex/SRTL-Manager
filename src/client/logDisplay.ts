import type { JobEventRecord, JobRecord, JobStatus, JobType } from "../shared/types";

export type JobStatusFilter = JobStatus | "all";
export type JobTypeFilter = JobType | "all";
export type EventLevelFilter = JobEventRecord["level"] | "all";

export interface LogDataChip {
  label: string;
  value: string;
}

const dataLabels: Record<string, string> = {
  action: "Action",
  actionableLocalFiles: "Copy to remote files",
  actionableLocalLinks: "Copy to remote links",
  actionableRemoteFiles: "Copy to local files",
  actionableRemoteLinks: "Copy to local links",
  assignedRemoteFiles: "Location 2 policy files",
  assignedRemoteLinks: "Location 2 policy links",
  bytesCopied: "Copied bytes",
  byteCompare: "Byte compare",
  bytesProcessed: "Processed bytes",
  bytesPerSecond: "Speed",
  byteMismatches: "Byte mismatches",
  checked: "Checked",
  conflicts: "Conflicts",
  copied: "Copied",
  current: "Current",
  currentFile: "Current file",
  currentTitle: "Current title",
  destinationPath: "Destination",
  direction: "Direction",
  failed: "Failed",
  itemName: "Title",
  migrationId: "Migration",
  localFiles: "Local files",
  localLinks: "Local links",
  localOrphanFiles: "Local orphans",
  localSections: "Local folders",
  missingLinks: "No longer found symlinks",
  missingLocalFiles: "No longer found local files",
  missingRemoteFiles: "No longer found remote files",
  message: "Message",
  mode: "Mode",
  passed: "Passed",
  remoteFiles: "Remote files",
  remoteLinks: "Remote links",
  remoteOrphanFiles: "Remote orphans",
  repointed: "Repointed",
  relativePathPrefix: "Path scope",
  scanLocal: "Local files",
  scanRemote: "Remote files",
  scanSymlinks: "Symlinks",
  sections: "Folders",
  sizeBytes: "Size",
  skipped: "Skipped",
  sourceCompareErrors: "Source compare errors",
  sourceMissing: "Recorded source missing",
  sourcePath: "Source",
  sourceUnknown: "No recorded source",
  stage: "Stage",
  symlinkSections: "Symlink folders",
  titleScopes: "Titles",
  targetPath: "Target",
  targets: "Targets",
  total: "Total",
  totalBytes: "Total bytes",
  totalLinks: "Total links",
  remainingSeconds: "Remaining",
  unassignedLocalFiles: "Unassigned local files",
  unassignedLocalLinks: "Unassigned local links",
  unassignedRemoteFiles: "Unassigned remote files",
  unassignedRemoteLinks: "Unassigned remote links"
};

const chipPriority = [
  "current",
  "stage",
  "message",
  "currentFile",
  "currentTitle",
  "bytesCopied",
  "byteCompare",
  "bytesProcessed",
  "totalBytes",
  "bytesPerSecond",
  "remainingSeconds",
  "checked",
  "total",
  "copied",
  "repointed",
  "skipped",
  "conflicts",
  "passed",
  "failed",
  "sourceUnknown",
  "sourceMissing",
  "sourceCompareErrors",
  "byteMismatches",
  "totalLinks",
  "unassignedRemoteLinks",
  "unassignedLocalLinks",
  "unassignedRemoteFiles",
  "unassignedLocalFiles",
  "actionableRemoteLinks",
  "actionableRemoteFiles",
  "actionableLocalLinks",
  "actionableLocalFiles",
  "remoteLinks",
  "localLinks",
  "localFiles",
  "remoteFiles",
  "localOrphanFiles",
  "remoteOrphanFiles",
  "missingLinks",
  "missingLocalFiles",
  "missingRemoteFiles",
  "symlinkSections",
  "titleScopes",
  "localSections",
  "sections",
  "targetPath",
  "sourcePath",
  "destinationPath",
  "sizeBytes",
  "direction",
  "linkIds",
  "section",
  "itemName",
  "relativePathPrefix",
  "targets",
  "scanSymlinks",
  "scanLocal",
  "scanRemote"
];

export function formatJobType(type: JobType): string {
  if (type === "scan") return "Inventory scan";
  if (type === "audit") return "Audit";
  if (type === "copy") return "Copy";
  if (type === "path_migration") return "Path migration";
  return "Integration sync";
}

export function formatEventLevel(level: JobEventRecord["level"]): string {
  if (level === "warn") return "Warning";
  if (level === "error") return "Error";
  return "Info";
}

export function matchesJobFilters(job: JobRecord, filters: { search: string; status: JobStatusFilter; type: JobTypeFilter }): boolean {
  if (filters.status !== "all" && job.status !== filters.status) return false;
  if (filters.type !== "all" && job.type !== filters.type) return false;
  const search = filters.search.trim().toLowerCase();
  return !search || getJobSearchText(job).includes(search);
}

export function matchesEventFilters(event: JobEventRecord, filters: { search: string; level: EventLevelFilter }): boolean {
  if (filters.level !== "all" && event.level !== filters.level) return false;
  const search = filters.search.trim().toLowerCase();
  return !search || getEventSearchText(event).includes(search);
}

export function jobProgressChips(job: JobRecord, maxChips = 6): LogDataChip[] {
  const progress = recordFromUnknown(job.progress);
  if (!progress) return [];

  const chips: LogDataChip[] = [];
  const options = recordFromUnknown(progress.options);
  let allowedKeys: Set<string> | null = null;

  if (job.type === "scan" && options) {
    chips.push(...scanOptionChips(options));
    allowedKeys = scanScopedDataKeys(options);
  }

  if (job.type === "audit" && options) {
    chips.push(...auditOptionChips(options));
    if (Array.isArray(options.linkIds)) chips.push({ label: "Links", value: options.linkIds.length === 0 ? "None" : `${options.linkIds.length}` });
    if (typeof options.section === "string") chips.push({ label: "Folder", value: options.section });
    if (typeof options.itemName === "string") chips.push({ label: "Title", value: options.itemName });
    if (typeof options.relativePathPrefix === "string") chips.push({ label: "Path scope", value: options.relativePathPrefix });
    if (typeof options.byteCompare === "boolean") chips.push({ label: "Byte compare", value: options.byteCompare ? "Enabled" : "Skipped" });
  }

  if (job.type === "copy" && options) {
    if (typeof options.direction === "string") chips.push({ label: "Direction", value: options.direction === "to_remote" ? "To remote" : "To local" });
    if (Array.isArray(options.linkIds)) chips.push({ label: "Links", value: options.linkIds.length === 0 ? "None" : `${options.linkIds.length}` });
    if (typeof options.section === "string") chips.push({ label: "Folder", value: options.section });
    if (typeof options.itemName === "string") chips.push({ label: "Title", value: options.itemName });
  }

  return [...chips, ...dataChipsFromRecord(progress, maxChips, new Set(["options", ...(job.type === "scan" ? ["stage", "message"] : [])]), allowedKeys)].slice(0, maxChips);
}

export function eventDataChips(data: unknown, maxChips = 6, fallbackOptions?: unknown): LogDataChip[] {
  const record = recordFromUnknown(data);
  if (!record) return [];
  const options = recordFromUnknown(record.options) ?? recordFromUnknown(fallbackOptions);
  if (options) {
    const chips = typeof options.mode === "string" ? auditOptionChips(options) : scanOptionChips(options);
    return [...chips, ...dataChipsFromRecord(record, maxChips, new Set(["options", "stage", "message"]), scanScopedDataKeys(options))].slice(0, maxChips);
  }
  return dataChipsFromRecord(record, maxChips, new Set(["options"]));
}

export function hasLogData(data: unknown): boolean {
  const record = recordFromUnknown(data);
  return Boolean(record && Object.keys(record).length > 0);
}

export function formatLogData(data: unknown): string {
  return JSON.stringify(data, null, 2);
}

function getJobSearchText(job: JobRecord): string {
  return [job.id, job.type, formatJobType(job.type), job.status, job.createdAt, job.startedAt, job.finishedAt, JSON.stringify(job.progress)]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function getEventSearchText(event: JobEventRecord): string {
  return [event.id, event.level, formatEventLevel(event.level), event.message, event.timestamp, JSON.stringify(event.data)]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function dataChipsFromRecord(record: Record<string, unknown>, maxChips: number, ignoredKeys: Set<string>, allowedKeys: Set<string> | null = null): LogDataChip[] {
  const keys = Object.keys(record).filter((key) => !ignoredKeys.has(key) && (!allowedKeys || allowedKeys.has(key)));
  const orderedKeys = [
    ...chipPriority.filter((key) => keys.includes(key)),
    ...keys.filter((key) => !chipPriority.includes(key)).sort((left, right) => left.localeCompare(right))
  ];

  return orderedKeys
    .map((key) => {
      const value = formatDataValue(key, record[key]);
      return value ? { label: dataLabels[key] ?? humanizeKey(key), value } : null;
    })
    .filter((chip): chip is LogDataChip => Boolean(chip))
    .slice(0, maxChips);
}

function formatDataValue(key: string, value: unknown): string | null {
  if (value == null) return null;
  if ((key === "bytesCopied" || key === "bytesProcessed" || key === "totalBytes" || key === "sizeBytes" || key === "bytesPerSecond") && typeof value === "number" && Number.isFinite(value)) {
    return `${formatBytes(Math.round(value))}${key === "bytesPerSecond" ? "/s" : ""}`;
  }
  if (key === "remainingSeconds" && typeof value === "number" && Number.isFinite(value)) return formatDurationSeconds(value);
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number") return Number.isFinite(value) ? new Intl.NumberFormat().format(value) : null;
  if (typeof value === "string") return value.trim() || null;
  if (Array.isArray(value)) {
    if (value.length === 0) return "None";
    const visibleValues = value.slice(0, 3).map((item) => formatDataValue(key, item)).filter((item): item is string => Boolean(item));
    const suffix = value.length > visibleValues.length ? ` +${value.length - visibleValues.length}` : "";
    return `${visibleValues.join(", ")}${suffix}`;
  }
  return null;
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  const units = ["KB", "MB", "GB", "TB", "PB"];
  let size = value / 1024;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  return `${size.toFixed(size >= 10 ? 1 : 2)} ${units[unitIndex]}`;
}

function formatDurationSeconds(value: number): string {
  const seconds = Math.max(0, Math.round(value));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) return remainingSeconds ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}

function addArrayCountChip(chips: LogDataChip[], label: string, value: unknown): void {
  if (!Array.isArray(value)) return;
  chips.push({ label, value: value.length === 0 ? "None" : `${value.length}` });
}

function scanOptionChips(options: Record<string, unknown>): LogDataChip[] {
  const chips: LogDataChip[] = [];
  const scopes = [
    options.scanSymlinks === true ? "Symlinks" : null,
    options.scanLocal === true ? "Local files" : null,
    options.scanRemote === true ? "Remote files" : null
  ].filter((scope): scope is string => Boolean(scope));
  chips.push({ label: "Scan scope", value: scopes.length ? scopes.join(", ") : "No scopes" });
  if (options.scanSymlinks === true && Array.isArray(options.titleScopes) && options.titleScopes.length > 0) {
    const titles = options.titleScopes
      .map((scope) => recordFromUnknown(scope))
      .filter((scope): scope is Record<string, unknown> => Boolean(scope))
      .map((scope) => (typeof scope.itemName === "string" ? scope.itemName : null))
      .filter((title): title is string => Boolean(title));
    const visibleTitles = titles.slice(0, 2);
    chips.push({ label: titles.length === 1 ? "Title" : "Titles", value: `${visibleTitles.join(", ")}${titles.length > visibleTitles.length ? ` +${titles.length - visibleTitles.length}` : ""}` });
  } else if (options.scanSymlinks === true) {
    addArrayCountChip(chips, "Symlink folders", options.symlinkSections);
  }
  if (options.scanLocal === true) addArrayCountChip(chips, "Local folders", options.localSections);
  return chips;
}

function auditOptionChips(options: Record<string, unknown>): LogDataChip[] {
  const chips: LogDataChip[] = [];
  if (typeof options.mode === "string") chips.push({ label: "Mode", value: sentenceCase(options.mode) });
  if (Array.isArray(options.targets)) {
    const targets = options.targets.filter((target): target is string => target === "local" || target === "remote");
    chips.push({ label: "Targets", value: targets.length === 2 ? "Local + remote" : targets.length === 1 ? sentenceCase(targets[0] ?? "") : "None" });
  }
  addArrayCountChip(chips, "Local folders", options.sections);
  return chips;
}

function scanScopedDataKeys(options: Record<string, unknown>): Set<string> {
  const keys = new Set<string>();
  if (options.scanSymlinks === true) {
    addKeys(keys, [
      "totalLinks",
      "remoteLinks",
      "localLinks",
      "brokenLinks",
      "actionableRemoteLinks",
      "actionableLocalLinks",
      "assignedRemoteLinks",
      "unassignedRemoteLinks",
      "unassignedLocalLinks",
      "missingLinks"
    ]);
  }
  if (options.scanLocal === true) addKeys(keys, ["localFiles", "missingLocalFiles"]);
  if (options.scanRemote === true) addKeys(keys, ["remoteFiles", "missingRemoteFiles"]);
  if (options.scanSymlinks === true && options.scanLocal === true) addKeys(keys, ["localOrphanFiles"]);
  if (options.scanSymlinks === true && options.scanRemote === true) addKeys(keys, ["remoteOrphanFiles"]);
  return keys;
}

function addKeys(keys: Set<string>, values: string[]): void {
  for (const value of values) keys.add(value);
}

function humanizeKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^./, (letter) => letter.toUpperCase());
}

function sentenceCase(value: string): string {
  const normalized = value.replace(/[_-]+/g, " ");
  return normalized.replace(/^./, (letter) => letter.toUpperCase());
}

function recordFromUnknown(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}
