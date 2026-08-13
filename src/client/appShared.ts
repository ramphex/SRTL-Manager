import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useInfiniteQuery, useMutation, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { FolderCog, Gauge, ListChecks, Monitor, Moon, Search, Sun, UserCog } from "lucide-react";
import { api } from "./api";
import { scanOptionsFromJob } from "./jobScopeLocks";
import { mergeJobEventPages } from "./jobEvents";
import { defaultRecentJobsCompletedWindowMinutes } from "./recentJobs";
import { inferSectionContentType } from "../shared/sections";
import { type AuditMode, type AuditOptions, type AppReleaseInfo, type AppVersionInfo, type CopyConflictPreview, type InventorySummary, type JobRecord, type JobStatus, type CopyMediaValidationMode, type CopyOptions, type CopyVerificationProfile, type MediaLinkTreeKindFilter, type PathMigrationStatus, type ScanOptions, type SectionContentType, type SectionSettings, type SectionSummary, type StoragePolicyCategory, type StoragePolicyKind, type StorageLocationsSettings, type StorageRootType, type TimeFormatPreference, type UserPreferences } from "../shared/types";

export type ThemePreference = "light" | "dark" | "system";

export type SymlinkKindFilter = Exclude<MediaLinkTreeKindFilter, "other" | "non_media"> | "all";

export type SettingsView = "library" | "advanced" | "user";

export type SidebarGroup = "history" | "settings";

export type AuditPrompt = {
  title: string;
  description: string;
  options: Omit<AuditOptions, "mode">;
};

export type CopyPrompt = {
  key: string;
  title: string;
  description: string;
  options?: CopyOptions;
  jobId?: number;
  autoStart?: boolean;
  conflicts?: CopyConflictPreview;
};

export type ScanStatusPrompt = {
  key: string;
  title: string;
  description: string;
  jobId: number;
};

export type ScanBatchStatusPrompt = {
  key: string;
  title: string;
  description: string;
  jobIds: number[];
};

export type AuditStatusPrompt = {
  key: string;
  title: string;
  description: string;
  jobId: number;
  auditRunId?: number;
};

export type SectionDraft = {
  id: string;
  name: string;
  title: string;
  type: SectionContentType;
  titleTouched: boolean;
  typeTouched: boolean;
};

export const themeStorageKey = "srtl-theme";

export const themeMediaQuery = "(prefers-color-scheme: dark)";

export const versionCheckIntervalMs = 24 * 60 * 60 * 1000;

export const storagePolicyCategoryLabels: Record<StoragePolicyCategory, string> = {
  movies: "Movies",
  shows: "Shows",
  mixed: "Movies + Shows",
  other: "Other",
  unmatched: "Unmatched"
};

export function storagePolicyLabel(policy: StoragePolicyKind, settings: StorageLocationsSettings): string {
  if (policy === "location_1") return storageLocationName(settings, "local");
  if (policy === "location_2") return storageLocationName(settings, "remote");
  return "Unassigned";
}

export function storagePolicyActionText(policy: StoragePolicyKind, settings: StorageLocationsSettings): string {
  if (policy === "location_1") return storageLocationName(settings, "local");
  if (policy === "location_2") return storageLocationName(settings, "remote");
  return "unassigned";
}

export function storageStatusDisplayLabel(value: string, settings: StorageLocationsSettings): string {
  const localName = storageLocationName(settings, "local");
  const remoteName = storageLocationName(settings, "remote");
  if (value === "Local") return localName;
  if (value === "Remote") return remoteName;
  if (value === "Copy To Local") return `Copy To ${localName}`;
  if (value === "Copy To Remote") return `Copy To ${remoteName}`;
  if (value === "Location 2") return remoteName;
  return value;
}

export const themeOptions = [
  { value: "system" as const, label: "System", icon: Monitor },
  { value: "dark" as const, label: "Dark", icon: Moon },
  { value: "light" as const, label: "Light", icon: Sun }
];

export const sectionTypeOptions: Array<{ value: SectionContentType; label: string }> = [
  { value: "shows", label: "Shows" },
  { value: "movies", label: "Movies" },
  { value: "other", label: "Other" }
];

export const historySections = [
  { to: "/scans", label: "Scans", icon: Search },
  { to: "/audits", label: "Audits", icon: ListChecks }
] as const;

export const settingsSections = [
  { view: "library", to: "/settings", label: "Library", icon: FolderCog },
  { view: "advanced", to: "/settings/advanced", label: "Advanced", icon: Gauge },
  { view: "user", to: "/settings/user", label: "User settings", icon: UserCog }
] as const;

export const copyProfileOptions: Array<{ value: CopyVerificationProfile; label: string; detail: string }> = [
  { value: "off", label: "Off", detail: "Skip post-transfer byte compare and media validation" },
  { value: "fast", label: "Fast", detail: "Byte compare only" },
  { value: "balanced", label: "Balanced (recommended)", detail: "Byte compare and fast validation" },
  { value: "deep", label: "Deep", detail: "Byte compare and full decode" },
  { value: "custom", label: "Custom", detail: "Choose verification steps" }
];

export const mediaValidationOptions: Array<{ value: CopyMediaValidationMode; label: string; detail: string }> = [
  { value: "off", label: "Off", detail: "Skip media validation" },
  { value: "fast", label: "Fast", detail: "Container stream read" },
  { value: "deep", label: "Deep", detail: "Full decode" }
];

export const auditModeOptions: Array<{ value: AuditMode; label: string; detail: string }> = [
  { value: "fast", label: "Fast", detail: "Container stream read" },
  { value: "deep", label: "Deep", detail: "Full decode" }
];

export const storageRootOrder: StorageRootType[] = ["local", "remote"];

export const copyPipelineLabels: Record<CopyMediaValidationMode, string> = {
  off: "Media validation skipped",
  fast: "Fast media validation",
  deep: "Deep media validation"
};

export const symlinkKindFilterLabels: Record<SymlinkKindFilter, string> = {
  all: "All",
  mixed: "Mixed",
  remote: "Remote",
  local: "Local",
  broken: "Broken"
};

export const defaultUserPreferences: UserPreferences = {
  timeFormat: "12h",
  autoOpenTaskStatus: false,
  recentJobsCompletedWindowMinutes: defaultRecentJobsCompletedWindowMinutes
};

export const defaultStorageLocations: StorageLocationsSettings = {
  locations: [
    { key: "location_1", rootType: "local", displayName: "Local", path: "" },
    { key: "location_2", rootType: "remote", displayName: "Remote", path: "" }
  ]
};

export const timeFormatOptions: Array<{ value: TimeFormatPreference; label: string }> = [
  { value: "12h", label: "12 hour" },
  { value: "24h", label: "24 hour" }
];

export const UserPreferencesContext = createContext<UserPreferences>(defaultUserPreferences);

export const StorageLocationsContext = createContext<StorageLocationsSettings>(defaultStorageLocations);

export function useUserPreferences() {
  return useContext(UserPreferencesContext);
}

export function useStorageLocations() {
  return useContext(StorageLocationsContext);
}

const modalFocusableSelector = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "summary",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])'
].join(",");

export function useModalLifecycle(open: boolean, onClose: () => void) {
  const dialogRef = useRef<HTMLElement>(null);
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) return undefined;
    const dialog = dialogRef.current;
    if (!dialog) return undefined;

    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const isTopmostDialog = () => {
      const dialogs = [...document.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"]')];
      return dialogs.at(-1) === dialog;
    };
    const focusableElements = () => [...dialog.querySelectorAll<HTMLElement>(modalFocusableSelector)].filter((element) => {
      const style = getComputedStyle(element);
      return !element.hidden
        && !element.closest('[aria-hidden="true"], [inert]')
        && style.display !== "none"
        && style.visibility !== "hidden"
        && element.getClientRects().length > 0;
    });
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!isTopmostDialog()) return;
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;

      const focusable = focusableElements();
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    requestAnimationFrame(() => (focusableElements()[0] ?? dialog).focus());
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = previousOverflow;
      requestAnimationFrame(() => {
        if (previouslyFocused?.isConnected) previouslyFocused.focus();
      });
    };
  }, [open]);

  return dialogRef;
}

export function storageLocationName(settings: StorageLocationsSettings, rootType: StorageRootType): string {
  return settings.locations.find((location) => location.rootType === rootType)?.displayName ?? (rootType === "local" ? "Local" : "Remote");
}

export function useJobEventTimeline({
  jobId,
  enabled,
  refetchInterval,
  loadAll = false
}: {
  jobId: number | null | undefined;
  enabled: boolean;
  refetchInterval: number | false;
  loadAll?: boolean;
}) {
  const query = useInfiniteQuery({
    queryKey: ["job-events", jobId],
    queryFn: ({ pageParam }) => api.jobEventPage(jobId!, { beforeId: typeof pageParam === "number" ? pageParam : undefined, limit: 100 }),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (lastPage) => (lastPage.hasOlder ? lastPage.events[0]?.id : undefined),
    enabled: Boolean(enabled && jobId),
    refetchInterval
  });
  const { data, fetchNextPage, hasNextPage, isFetchingNextPage } = query;
  const pageCount = data?.pages.length ?? 0;

  useEffect(() => {
    if (!loadAll || !hasNextPage || isFetchingNextPage) return;
    void fetchNextPage();
  }, [fetchNextPage, hasNextPage, isFetchingNextPage, loadAll, pageCount]);

  const events = useMemo(() => mergeJobEventPages(data?.pages ?? []), [data?.pages]);
  const total = data?.pages[0]?.total ?? events.length;
  return { ...query, events, total };
}

export function invalidateCopyJobData(queryClient: QueryClient) {
  queryClient.invalidateQueries({ queryKey: ["jobs"] });
  queryClient.invalidateQueries({ queryKey: ["job"] });
  queryClient.invalidateQueries({ queryKey: ["dashboard-remote-work-links"] });
  queryClient.invalidateQueries({ queryKey: ["media-links"] });
  queryClient.invalidateQueries({ queryKey: ["media-links-page"] });
  queryClient.invalidateQueries({ queryKey: ["media-link-tree"] });
  queryClient.invalidateQueries({ queryKey: ["storage-policies"] });
  queryClient.invalidateQueries({ queryKey: ["sections"] });
  queryClient.invalidateQueries({ queryKey: ["inventory-summary"] });
}

export function invalidateTerminatedJobData(queryClient: QueryClient) {
  queryClient.invalidateQueries({ queryKey: ["jobs"] });
  queryClient.invalidateQueries({ queryKey: ["job"] });
  queryClient.invalidateQueries({ queryKey: ["job-events"] });
  queryClient.invalidateQueries({ queryKey: ["scans"] });
  queryClient.invalidateQueries({ queryKey: ["audits"] });
  queryClient.invalidateQueries({ queryKey: ["dashboard-remote-work-links"] });
  queryClient.invalidateQueries({ queryKey: ["media-links"] });
  queryClient.invalidateQueries({ queryKey: ["media-links-page"] });
  queryClient.invalidateQueries({ queryKey: ["media-link-tree"] });
  queryClient.invalidateQueries({ queryKey: ["storage-files"] });
  queryClient.invalidateQueries({ queryKey: ["storage-file-tree"] });
  queryClient.invalidateQueries({ queryKey: ["sections"] });
  queryClient.invalidateQueries({ queryKey: ["inventory-summary"] });
  queryClient.invalidateQueries({ queryKey: ["path-configuration"] });
}

export function useStartCopyJob(onQueued?: (result: { jobId: number }) => void) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (copyPrompt: CopyPrompt) => {
      if (!copyPrompt.options) throw new Error("Copy options are missing");
      return api.startCopy(copyPrompt.options);
    },
    onSuccess: (result) => {
      onQueued?.(result);
      invalidateCopyJobData(queryClient);
    }
  });
}

export function useTerminateJobMutation(onTerminated?: () => void) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (jobId: number) => api.terminateJob(jobId),
    onSuccess: () => {
      onTerminated?.();
      invalidateTerminatedJobData(queryClient);
    }
  });
}

export function canTerminateJob(job: JobRecord | null | undefined): job is JobRecord {
  return job?.status === "running" || job?.status === "queued";
}

export function nonShowSectionMetricLabel(type: SectionContentType): string {
  return type === "movies" ? "Movies" : "Titles";
}

export function sectionContentType(section: { section: string; type?: SectionContentType | null }): SectionContentType {
  return section.type ?? inferSectionContentType(section.section);
}

export function sectionDisplayTitle(section: { section: string; title?: string | null }): string {
  return section.title?.trim() || section.section;
}

export function sectionPolicyNeededCount(section: Pick<SectionSummary, "unassignedRemoteLinks" | "unassignedLocalLinks">): number {
  return section.unassignedRemoteLinks + section.unassignedLocalLinks;
}

export function inventoryCopyToLocalCount(summary: Pick<InventorySummary, "actionableRemoteLinks">): number {
  return summary.actionableRemoteLinks;
}

export function inventoryCopyToRemoteCount(summary: Pick<InventorySummary, "actionableLocalLinks">): number {
  return summary.actionableLocalLinks;
}

export function inventoryAssignedRemoteCount(summary: Pick<InventorySummary, "assignedRemoteLinks" | "assignedRemoteFiles">): number {
  return summary.assignedRemoteLinks + summary.assignedRemoteFiles;
}

export function createEmptySectionDraft(id: string): SectionDraft {
  return { id, name: "", title: "", type: "other", titleTouched: false, typeTouched: false };
}

export function sectionSettingsToDrafts(settings: SectionSettings): SectionDraft[] {
  if (settings.sections.length === 0) return [createEmptySectionDraft("section-new-0")];
  return settings.sections.map((section, index) => ({
    id: `section-${index}-${section}`,
    name: section,
    title: settings.sectionTitles?.[section] ?? section,
    type: settings.sectionTypes?.[section] ?? inferSectionContentType(section),
    titleTouched: Boolean(settings.sectionTitles?.[section]),
    typeTouched: Boolean(settings.sectionTypes?.[section])
  }));
}

export function sectionDraftsToSettings(drafts: SectionDraft[]): SectionSettings {
  const sections: string[] = [];
  const sectionTitles: Record<string, string> = {};
  const sectionTypes: Record<string, SectionContentType> = {};
  const seen = new Set<string>();

  for (const draft of drafts) {
    const name = draft.name.trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    sections.push(name);

    const title = draft.title.trim();
    if (title && title !== name) sectionTitles[name] = title;
    sectionTypes[name] = draft.type;
  }

  return { sections, sectionTitles, sectionTypes };
}

export function isThemePreference(value: string | null): value is ThemePreference {
  return value === "light" || value === "dark" || value === "system";
}

export function readThemePreference(): ThemePreference {
  if (typeof window === "undefined") return "system";
  try {
    const stored = window.localStorage.getItem(themeStorageKey);
    return isThemePreference(stored) ? stored : "system";
  } catch {
    return "system";
  }
}

export function systemPrefersDark(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(themeMediaQuery).matches;
}

export function resolveTheme(preference: ThemePreference): "light" | "dark" {
  if (preference === "system") {
    return systemPrefersDark() ? "dark" : "light";
  }
  return preference;
}

export function applyThemePreference(preference: ThemePreference): void {
  if (typeof document === "undefined") return;
  const theme = resolveTheme(preference);
  document.documentElement.dataset.theme = theme;
  document.documentElement.dataset.themePreference = preference;
  document.querySelector("#srtl-theme-color")?.setAttribute("content", theme === "dark" ? "#070b11" : "#c0c8d3");
}

export function useThemePreference() {
  const [preference, setPreference] = useState<ThemePreference>(() => readThemePreference());

  useEffect(() => {
    try {
      window.localStorage.setItem(themeStorageKey, preference);
    } catch {
      // Theme selection still applies for the current session when storage is restricted.
    }
    applyThemePreference(preference);
  }, [preference]);

  useEffect(() => {
    if (preference !== "system" || typeof window.matchMedia !== "function") return undefined;
    const media = window.matchMedia(themeMediaQuery);
    const handleChange = () => applyThemePreference("system");
    media.addEventListener("change", handleChange);
    return () => media.removeEventListener("change", handleChange);
  }, [preference]);

  return [preference, setPreference] as const;
}

export interface ParsedDisplayVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
}

export function parseDisplayVersion(value: string | null): ParsedDisplayVersion | null {
  if (!value) return null;
  const match = value.trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4]?.split(".").filter(Boolean) ?? []
  };
}

export function compareDisplayPrerelease(left: string[], right: string[]): number {
  if (left.length === 0 && right.length === 0) return 0;
  if (left.length === 0) return 1;
  if (right.length === 0) return -1;
  const length = Math.max(left.length, right.length);

  for (let index = 0; index < length; index += 1) {
    const leftPart = left[index];
    const rightPart = right[index];
    if (leftPart == null) return -1;
    if (rightPart == null) return 1;
    const leftNumeric = /^\d+$/.test(leftPart);
    const rightNumeric = /^\d+$/.test(rightPart);
    if (leftNumeric && rightNumeric) {
      const difference = Number(leftPart) - Number(rightPart);
      if (difference !== 0) return difference;
      continue;
    }
    if (leftNumeric) return -1;
    if (rightNumeric) return 1;
    const difference = leftPart.localeCompare(rightPart);
    if (difference !== 0) return difference;
  }

  return 0;
}

export function compareDisplayVersions(leftRaw: string | null, rightRaw: string | null): number {
  const left = parseDisplayVersion(leftRaw);
  const right = parseDisplayVersion(rightRaw);
  if (!left || !right) return 0;
  const coreDifference = left.major - right.major || left.minor - right.minor || left.patch - right.patch;
  if (coreDifference !== 0) return coreDifference;
  return compareDisplayPrerelease(left.prerelease, right.prerelease);
}

export function shouldHideBetaRelease(info: AppVersionInfo): boolean {
  return info.currentChannel === "stable" && info.beta.latestVersion != null && compareDisplayVersions(info.currentVersion, info.beta.latestVersion) > 0;
}

export function visibleVersionReleases(info?: AppVersionInfo): AppReleaseInfo[] {
  if (!info) return [];
  const releases = [info.stable];
  if (!shouldHideBetaRelease(info)) releases.push(info.beta);
  return releases;
}

export function versionChannelLabel(channel: AppReleaseInfo["channel"]): string {
  return channel === "beta" ? "Beta" : "Stable";
}

export function formatDurationMs(elapsedMs: number): string {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return "-";
  const seconds = Math.round(elapsedMs / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) return remainingSeconds ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}

export function useLiveTimestamp(active: boolean, intervalMs = 500): number {
  const [timestamp, setTimestamp] = useState(() => Date.now());

  useEffect(() => {
    setTimestamp(Date.now());
    if (!active) return undefined;
    const interval = window.setInterval(() => setTimestamp(Date.now()), intervalMs);
    return () => window.clearInterval(interval);
  }, [active, intervalMs]);

  return timestamp;
}

export function copyElapsedLabel(job: JobRecord | null, currentTime = Date.now()): string {
  const startedAt = Date.parse(job?.startedAt ?? "");
  if (!Number.isFinite(startedAt)) return job?.status === "queued" ? "Queued" : "-";
  const finishedAt = job?.finishedAt ? Date.parse(job.finishedAt) : currentTime;
  return formatDurationMs(finishedAt - startedAt);
}

export function recordFromUnknown(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

export function finiteNumberFromUnknown(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function finiteNullableNumberFromUnknown(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export type ScanProgressView = InventorySummary & {
  stage: string;
  message: string | null;
  scanActivity: string | null;
  currentSection: string | null;
  discoveredLinks: number;
  checkedLinks: number;
  completedWorkUnits: number;
  totalWorkUnits: number;
};

export function scanProgressFromJob(job: JobRecord | null): ScanProgressView {
  const progress = recordFromUnknown(job?.progress);
  const stage = typeof progress?.stage === "string" ? progress.stage : job?.status === "queued" ? "queued" : job?.status === "running" ? "scanning" : job?.status ?? "waiting";
  return {
    totalLinks: finiteNumberFromUnknown(progress?.totalLinks),
    remoteLinks: finiteNumberFromUnknown(progress?.remoteLinks),
    localLinks: finiteNumberFromUnknown(progress?.localLinks),
    brokenLinks: finiteNumberFromUnknown(progress?.brokenLinks),
    otherLinks: finiteNumberFromUnknown(progress?.otherLinks),
    nonMediaLinks: finiteNumberFromUnknown(progress?.nonMediaLinks),
    actionableRemoteLinks: finiteNumberFromUnknown(progress?.actionableRemoteLinks),
    actionableLocalLinks: finiteNumberFromUnknown(progress?.actionableLocalLinks),
    assignedRemoteLinks: finiteNumberFromUnknown(progress?.assignedRemoteLinks),
    unassignedRemoteLinks: finiteNumberFromUnknown(progress?.unassignedRemoteLinks),
    unassignedLocalLinks: finiteNumberFromUnknown(progress?.unassignedLocalLinks),
    localFiles: finiteNumberFromUnknown(progress?.localFiles),
    remoteFiles: finiteNumberFromUnknown(progress?.remoteFiles),
    actionableRemoteFiles: finiteNumberFromUnknown(progress?.actionableRemoteFiles),
    actionableLocalFiles: finiteNumberFromUnknown(progress?.actionableLocalFiles),
    assignedRemoteFiles: finiteNumberFromUnknown(progress?.assignedRemoteFiles),
    unassignedRemoteFiles: finiteNumberFromUnknown(progress?.unassignedRemoteFiles),
    unassignedLocalFiles: finiteNumberFromUnknown(progress?.unassignedLocalFiles),
    localOrphanFiles: finiteNumberFromUnknown(progress?.localOrphanFiles),
    remoteOrphanFiles: finiteNumberFromUnknown(progress?.remoteOrphanFiles),
    missingLinks: finiteNumberFromUnknown(progress?.missingLinks),
    missingLocalFiles: finiteNumberFromUnknown(progress?.missingLocalFiles),
    missingRemoteFiles: finiteNumberFromUnknown(progress?.missingRemoteFiles),
    stage,
    message: typeof progress?.message === "string" ? progress.message : null,
    scanActivity: typeof progress?.scanActivity === "string" ? progress.scanActivity : null,
    currentSection: typeof progress?.currentSection === "string" ? progress.currentSection : null,
    discoveredLinks: finiteNumberFromUnknown(progress?.discoveredLinks),
    checkedLinks: finiteNumberFromUnknown(progress?.checkedLinks),
    completedWorkUnits: finiteNumberFromUnknown(progress?.completedWorkUnits),
    totalWorkUnits: finiteNumberFromUnknown(progress?.totalWorkUnits)
  };
}

export function scanStageLabel(stage: string, status?: JobStatus | null): string {
  if (status === "completed" || stage === "completed") return "Completed";
  if (status === "failed" || stage === "failed") return "Failed";
  if (status === "cancelled" || stage === "cancelled") return "Cancelled";
  if (stage === "queued") return "Queued";
  if (stage === "indexing") return "Writing inventory";
  if (stage === "scanning" || stage === "running") return "Scanning inventory";
  return "Waiting";
}

export function scanStagePercent(job: JobRecord | null, progress: ScanProgressView): number {
  if (job?.status === "completed") return 100;
  if (job?.status === "failed" || job?.status === "cancelled") return 100;
  if (progress.stage === "indexing") return 85;
  if (progress.stage === "scanning" || progress.stage === "running") return 45;
  if (progress.stage === "queued") return 5;
  return job?.status === "running" ? 45 : 0;
}

export function scanOptionsFromProgress(job: JobRecord | null): Partial<ScanOptions> {
  if (!job || job.type !== "scan") return {};
  return scanOptionsFromJob(job) ?? {};
}

export function scanVisiblePolicyNeededCount(progress: ScanProgressView, options: Partial<ScanOptions>): number {
  return (
    (options.scanSymlinks ? progress.unassignedRemoteLinks + progress.unassignedLocalLinks : 0) +
    (options.scanRemote ? progress.unassignedRemoteFiles : 0) +
    (options.scanLocal ? progress.unassignedLocalFiles : 0)
  );
}

export function scanPolicyResultStats(
  progress: ScanProgressView,
  options: Partial<ScanOptions>,
  localName: string,
  remoteName: string
): Array<{ label: string; value: number }> {
  const stats: Array<{ label: string; value: number }> = [];
  const needsAssignment = scanVisiblePolicyNeededCount(progress, options);
  const needsLocalCopy = (options.scanSymlinks ? progress.actionableRemoteLinks : 0) + (options.scanRemote ? progress.actionableRemoteFiles : 0);
  const needsRemoteCopy = (options.scanSymlinks ? progress.actionableLocalLinks : 0) + (options.scanLocal ? progress.actionableLocalFiles : 0);
  if (needsAssignment > 0) stats.push({ label: "Needs assignment", value: needsAssignment });
  if (needsLocalCopy > 0) stats.push({ label: `Needs copy to ${localName}`, value: needsLocalCopy });
  if (needsRemoteCopy > 0) stats.push({ label: `Needs copy to ${remoteName}`, value: needsRemoteCopy });
  return stats;
}

export function scanVisibleStats(
  progress: ScanProgressView,
  options: Partial<ScanOptions>,
  includePolicyResults: boolean,
  localName: string,
  remoteName: string
): Array<{ label: string; value: number }> {
  const stats: Array<{ label: string; value: number }> = [];
  if (options.scanSymlinks) {
    stats.push(
      { label: "Symlinks", value: progress.totalLinks },
      { label: "Remote symlinks", value: progress.remoteLinks },
      { label: "Local symlinks", value: progress.localLinks },
      { label: "Broken symlinks", value: progress.brokenLinks }
    );
    if (progress.missingLinks > 0) stats.push({ label: "Removed since previous scan", value: progress.missingLinks });
  }
  if (options.scanLocal) {
    stats.push({ label: "Local files", value: progress.localFiles });
    if (progress.missingLocalFiles > 0) stats.push({ label: "Local files removed since previous scan", value: progress.missingLocalFiles });
  }
  if (options.scanRemote) {
    stats.push({ label: "Remote files", value: progress.remoteFiles });
    if (progress.missingRemoteFiles > 0) stats.push({ label: "Remote files removed since previous scan", value: progress.missingRemoteFiles });
  }
  if (options.scanSymlinks && options.scanLocal) stats.push({ label: "Local orphan files", value: progress.localOrphanFiles });
  if (options.scanSymlinks && options.scanRemote) stats.push({ label: "Remote orphan files", value: progress.remoteOrphanFiles });
  if (includePolicyResults) stats.push(...scanPolicyResultStats(progress, options, localName, remoteName));
  return stats;
}

export function onboardingScanVisibleStats(
  progress: ScanProgressView,
  options: Partial<ScanOptions>,
  inventoryReady: boolean,
  includePolicyResults: boolean,
  localName: string,
  remoteName: string
): Array<{ label: string; value: number }> {
  if (!inventoryReady || !options.scanSymlinks) return [];
  const stats = [
    { label: "Symlinks", value: progress.totalLinks },
    { label: `Pointing to ${localName}`, value: progress.localLinks },
    { label: `Pointing to ${remoteName}`, value: progress.remoteLinks },
    { label: "Broken symlinks", value: progress.brokenLinks }
  ];
  if (includePolicyResults) stats.push(...scanPolicyResultStats(progress, options, localName, remoteName));
  return stats;
}

export function scanVisibleIndexedItemCount(progress: ScanProgressView, options: Partial<ScanOptions>): number {
  return (options.scanSymlinks ? progress.totalLinks : 0) + (options.scanLocal ? progress.localFiles : 0) + (options.scanRemote ? progress.remoteFiles : 0);
}

export function scanStatusDetail(job: JobRecord | null, progress: ScanProgressView): string {
  if (!job) return "Loading scan job status.";
  if (job.status === "queued") return "Waiting for a worker to start this scan.";
  if (job.status === "running" && progress.stage === "indexing") return "Writing scan results to the inventory database.";
  if (job.status === "running") return "Reading selected folders and collecting inventory data.";
  if (job.status === "completed" && progress.missingLinks + progress.missingLocalFiles + progress.missingRemoteFiles > 0) return "Scan finished. Some previously indexed paths in the scanned scope were not found this time.";
  if (job.status === "completed") return "Scan finished and inventory counters were updated.";
  if (job.status === "failed") return progress.message ?? "Scan failed.";
  if (job.status === "cancelled") return "Scan was cancelled.";
  return progress.message ?? "Waiting for scan progress.";
}

export function pathMigrationProgress(job: JobRecord | null): { current: number; total: number; message: string } {
  const progress = recordFromUnknown(job?.progress);
  return {
    current: finiteNumberFromUnknown(progress?.current),
    total: finiteNumberFromUnknown(progress?.total),
    message: typeof progress?.message === "string" ? progress.message : "Waiting for the migration worker"
  };
}

export function isActivePathMigrationStatus(status: PathMigrationStatus | null | undefined): boolean {
  return status === "queued" || status === "running" || status === "rollback_pending";
}

export function pathMigrationStatusLabel(status: PathMigrationStatus): string {
  if (status === "planned") return "Ready";
  if (status === "queued") return "Queued";
  if (status === "running") return "Running";
  if (status === "rollback_pending") return "Rolling back";
  return "Needs attention";
}

export function pathMigrationProgressTitle(status: PathMigrationStatus, message: string): string {
  return status === "rollback_pending" ? "Rolling back paths" : message;
}

export function dateTimeFormatOptions(timeFormat: TimeFormatPreference): Intl.DateTimeFormatOptions {
  return { year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit", hour12: timeFormat === "12h" };
}

export function timeOnlyFormatOptions(timeFormat: TimeFormatPreference): Intl.DateTimeFormatOptions {
  return { hour: "numeric", minute: "2-digit", second: "2-digit", hour12: timeFormat === "12h" };
}

export function formatDate(value: string | null, timeFormat: TimeFormatPreference = defaultUserPreferences.timeFormat) {
  return value ? new Date(value).toLocaleString(undefined, dateTimeFormatOptions(timeFormat)) : "-";
}

export function formatTime(value: string, timeFormat: TimeFormatPreference = defaultUserPreferences.timeFormat) {
  return new Date(value).toLocaleTimeString(undefined, timeOnlyFormatOptions(timeFormat));
}

export function formatDuration(startedAt: string | null, finishedAt: string | null) {
  if (!startedAt || !finishedAt) return "In progress";
  const elapsedMs = Date.parse(finishedAt) - Date.parse(startedAt);
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return "-";
  const seconds = Math.round(elapsedMs / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) return remainingSeconds ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}

export function formatBytes(value: number) {
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

export function formatNumber(value: number) {
  return new Intl.NumberFormat().format(value);
}

export function scanAgeLabel(value: string | null | undefined): string {
  if (!value) return "Never scanned";
  const elapsedMs = Date.now() - Date.parse(value);
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return "Never scanned";
  const elapsedMinutes = Math.floor(elapsedMs / 60000);
  if (elapsedMinutes < 60) return `Last scanned ${elapsedMinutes} min ago`;
  if (elapsedMs >= 86400000) return `Last scanned ${(elapsedMs / 86400000).toFixed(1)} days ago`;
  return `Last scanned ${(elapsedMs / 3600000).toFixed(1)} hrs ago`;
}

export function oldestScanAgeLabel(values: Array<string | null | undefined>): string {
  const timestamps = values
    .map((value) => (value ? Date.parse(value) : Number.NaN))
    .filter((timestamp) => Number.isFinite(timestamp));
  if (timestamps.length === 0) return "Never scanned";
  return scanAgeLabel(new Date(Math.min(...timestamps)).toISOString());
}

export interface LogsRouteSearch {
  job?: number;
}

export function parseLogsRouteSearch(search: Record<string, unknown>): LogsRouteSearch {
  const value = Array.isArray(search.job) ? search.job[0] : search.job;
  const job = Number(value);
  return Number.isInteger(job) && job > 0 ? { job } : {};
}
