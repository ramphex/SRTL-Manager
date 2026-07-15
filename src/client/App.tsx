import { createContext, useContext, useEffect, useId, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { createRootRoute, createRoute, createRouter, Link, Outlet, RouterProvider, useLocation } from "@tanstack/react-router";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import {
  Activity,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Blocks,
  CheckCircle2,
  ChevronRight,
  Copy,
  Database,
  File,
  FileText,
  Folder,
  FolderCog,
  Gauge,
  HardDrive,
  HardDriveDownload,
  Info,
  Library,
  Link2,
  ListChecks,
  LogIn,
  LogOut,
  Monitor,
  Moon,
  OctagonX,
  Play,
  Plus,
  Radar,
  RefreshCw,
  Search,
  ServerCog,
  Settings,
  Shield,
  Sun,
  Trash2,
  TriangleAlert,
  Unlink,
  X,
  UserCog,
  UserPlus
} from "lucide-react";
import { api } from "./api";
import { copyBehaviorForProfile, defaultAdvancedSettings, normalizeAdvancedSettings } from "../shared/advancedSettings";
import { evaluateSourceTitleRisk, type SourceTitleRiskResult } from "../shared/sourceTitleRisk";
import {
  eventDataChips,
  formatEventLevel,
  formatJobType,
  formatLogData,
  hasLogData,
  jobProgressChips,
  matchesEventFilters,
  matchesJobFilters,
  type EventLevelFilter,
  type JobStatusFilter,
  type JobTypeFilter
} from "./logDisplay";
import {
  activeJobForLink,
  activeJobNotice,
  activeJobsForLinks,
  activeJobsForStoragePolicyTitle,
  auditOptionsFromJob,
  copyOptionsFromJob,
  isActiveQueueJob,
  normalizeAuditTargets,
  scanOptionsFromJob
} from "./jobScopeLocks";
import { inventoryPolicyNeededCount, mediaLinkTreeStatusCounts, orderSectionSummaries, sectionActionUnit, sectionCompositionParts, type LinkStatusWorkKind } from "./sectionSummaryDisplay";
import { formatCurrentVersionDisplay } from "./versionDisplay";
import { jobEventCountLabel, mergeJobEventPages } from "./jobEvents";
import {
  defaultRecentJobsCompletedWindowMinutes,
  normalizeRecentJobsCompletedWindowMinutes,
  recentJobsCompletedWindowOptions,
  visibleDashboardJobs
} from "./recentJobs";
import { inferSectionContentType } from "../shared/sections";
import type {
  AuditMode,
  AuditOptions,
  AuditResultRecord,
  AuditRunRecord,
  AuditSettings,
  AdvancedSettings,
  AppReleaseInfo,
  AppVersionInfo,
  CopyConflictPreview,
  InventorySummary,
  JobEventRecord,
  JobRecord,
  JobStatus,
  JobType,
  CopyDirection,
  CopyLocalConflictStrategy,
  CopyMediaValidationMode,
  CopyOptions,
  CopyVerificationProfile,
  MediaLinkRow,
  MediaLinkTree,
  MediaLinkTreeKindFilter,
  MediaLinkTreeNode,
  OnboardingPolicyMode,
  OnboardingState,
  PathConfigurationState,
  PathsSettings,
  ScanOptions,
  ScanRunRecord,
  ScanTitleScope,
  SectionContentType,
  SectionSettings,
  SectionSummary,
  StoragePolicyCategory,
  StoragePolicyKind,
  StoragePolicyTitle,
  StorageFileRow,
  StorageFileTree,
  StorageFileTreeNode,
  StorageLocationKey,
  StorageLocationsSettings,
  StorageRootType,
  TimeFormatPreference,
  UserPreferences
} from "../shared/types";

type ThemePreference = "light" | "dark" | "system";
type SymlinkKindFilter = Exclude<MediaLinkTreeKindFilter, "other" | "non_media"> | "all";
type SettingsView = "library" | "integrations" | "advanced" | "user";
type SidebarGroup = "history" | "settings";
type AuditPrompt = {
  title: string;
  description: string;
  options: Omit<AuditOptions, "mode">;
};
type CopyPrompt = {
  key: string;
  title: string;
  description: string;
  options?: CopyOptions;
  jobId?: number;
  autoStart?: boolean;
  conflicts?: CopyConflictPreview;
};
type ScanStatusPrompt = {
  key: string;
  title: string;
  description: string;
  jobId: number;
};
type AuditStatusPrompt = {
  key: string;
  title: string;
  description: string;
  jobId: number;
  auditRunId?: number;
};
type SectionDraft = {
  id: string;
  name: string;
  title: string;
  type: SectionContentType;
  titleTouched: boolean;
  typeTouched: boolean;
};

const themeStorageKey = "srtl-theme";
const themeMediaQuery = "(prefers-color-scheme: dark)";
const versionCheckIntervalMs = 24 * 60 * 60 * 1000;
const storagePolicyCategoryLabels: Record<StoragePolicyCategory, string> = {
  movies: "Movies",
  shows: "Shows",
  mixed: "Movies + Shows",
  other: "Other",
  unmatched: "Unmatched"
};
function storagePolicyLabel(policy: StoragePolicyKind, settings: StorageLocationsSettings): string {
  if (policy === "location_1") return storageLocationName(settings, "local");
  if (policy === "location_2") return storageLocationName(settings, "remote");
  return "Unassigned";
}

function storagePolicyActionText(policy: StoragePolicyKind, settings: StorageLocationsSettings): string {
  if (policy === "location_1") return storageLocationName(settings, "local");
  if (policy === "location_2") return storageLocationName(settings, "remote");
  return "unassigned";
}

function storageStatusDisplayLabel(value: string, settings: StorageLocationsSettings): string {
  const localName = storageLocationName(settings, "local");
  const remoteName = storageLocationName(settings, "remote");
  if (value === "Local") return localName;
  if (value === "Remote") return remoteName;
  if (value === "Copy To Local") return `Copy To ${localName}`;
  if (value === "Copy To Remote") return `Copy To ${remoteName}`;
  if (value === "Location 2") return remoteName;
  return value;
}

const themeOptions = [
  { value: "system" as const, label: "System", icon: Monitor },
  { value: "dark" as const, label: "Dark", icon: Moon },
  { value: "light" as const, label: "Light", icon: Sun }
];
const sectionTypeOptions: Array<{ value: SectionContentType; label: string }> = [
  { value: "shows", label: "Shows" },
  { value: "movies", label: "Movies" },
  { value: "other", label: "Other" }
];
const historySections = [
  { to: "/scans", label: "Scans", icon: Search },
  { to: "/audits", label: "Audits", icon: ListChecks }
] as const;
const settingsSections = [
  { view: "library", to: "/settings", label: "Library", icon: FolderCog },
  { view: "integrations", to: "/settings/integrations", label: "Integrations", icon: Blocks },
  { view: "advanced", to: "/settings/advanced", label: "Advanced", icon: Gauge },
  { view: "user", to: "/settings/user", label: "User settings", icon: UserCog }
] as const;
const integrationPlaceholders = [
  {
    name: "Metadata integration",
    description: "Future metadata lookup, health checks, and candidate mapping.",
    urlPlaceholder: "Connection URL",
    keyPlaceholder: "Encrypted API key"
  },
  {
    name: "Automation integration",
    description: "Future refresh hooks and event-driven inventory updates.",
    urlPlaceholder: "Connection URL",
    keyPlaceholder: "Encrypted API key"
  }
] as const;
const copyProfileOptions: Array<{ value: CopyVerificationProfile; label: string; detail: string }> = [
  { value: "off", label: "Off", detail: "Skip post-transfer byte compare and media validation" },
  { value: "fast", label: "Fast", detail: "Byte compare only" },
  { value: "balanced", label: "Balanced (recommended)", detail: "Byte compare and fast validation" },
  { value: "deep", label: "Deep", detail: "Byte compare and full decode" },
  { value: "custom", label: "Custom", detail: "Choose verification steps" }
];
const mediaValidationOptions: Array<{ value: CopyMediaValidationMode; label: string; detail: string }> = [
  { value: "off", label: "Off", detail: "Skip media validation" },
  { value: "fast", label: "Fast", detail: "Container stream read" },
  { value: "deep", label: "Deep", detail: "Full decode" }
];
const auditModeOptions: Array<{ value: AuditMode; label: string; detail: string }> = [
  { value: "fast", label: "Fast", detail: "Container stream read" },
  { value: "deep", label: "Deep", detail: "Full decode" }
];
const storageRootOrder: StorageRootType[] = ["local", "remote"];
const copyPipelineLabels: Record<CopyMediaValidationMode, string> = {
  off: "Media validation skipped",
  fast: "Fast media validation",
  deep: "Deep media validation"
};
const symlinkKindFilterLabels: Record<SymlinkKindFilter, string> = {
  all: "All",
  mixed: "Mixed",
  remote: "Remote",
  local: "Local",
  broken: "Broken"
};
const defaultUserPreferences: UserPreferences = {
  timeFormat: "12h",
  autoOpenTaskStatus: false,
  recentJobsCompletedWindowMinutes: defaultRecentJobsCompletedWindowMinutes
};
const defaultStorageLocations: StorageLocationsSettings = {
  locations: [
    { key: "location_1", rootType: "local", displayName: "Local", path: "" },
    { key: "location_2", rootType: "remote", displayName: "Remote", path: "" }
  ]
};
const timeFormatOptions: Array<{ value: TimeFormatPreference; label: string }> = [
  { value: "12h", label: "12 hour" },
  { value: "24h", label: "24 hour" }
];
const UserPreferencesContext = createContext<UserPreferences>(defaultUserPreferences);
const StorageLocationsContext = createContext<StorageLocationsSettings>(defaultStorageLocations);

function useUserPreferences() {
  return useContext(UserPreferencesContext);
}

function useStorageLocations() {
  return useContext(StorageLocationsContext);
}

function storageLocationName(settings: StorageLocationsSettings, rootType: StorageRootType): string {
  return settings.locations.find((location) => location.rootType === rootType)?.displayName ?? (rootType === "local" ? "Local" : "Remote");
}

function useJobEventTimeline({
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

function invalidateCopyJobData(queryClient: QueryClient) {
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

function invalidateTerminatedJobData(queryClient: QueryClient) {
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

function useStartCopyJob(onQueued?: (result: { jobId: number }) => void) {
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

function useTerminateJobMutation(onTerminated?: () => void) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (jobId: number) => api.terminateJob(jobId),
    onSuccess: () => {
      onTerminated?.();
      invalidateTerminatedJobData(queryClient);
    }
  });
}

function canTerminateJob(job: JobRecord | null | undefined): job is JobRecord {
  return job?.status === "running" || job?.status === "queued";
}

function nonShowSectionMetricLabel(type: SectionContentType): string {
  return type === "movies" ? "Movies" : "Titles";
}

function sectionContentType(section: { section: string; type?: SectionContentType | null }): SectionContentType {
  return section.type ?? inferSectionContentType(section.section);
}

function sectionDisplayTitle(section: { section: string; title?: string | null }): string {
  return section.title?.trim() || section.section;
}

function sectionPolicyNeededCount(section: Pick<SectionSummary, "unassignedRemoteLinks" | "unassignedLocalLinks">): number {
  return section.unassignedRemoteLinks + section.unassignedLocalLinks;
}

function inventoryCopyToLocalCount(summary: Pick<InventorySummary, "actionableRemoteLinks" | "actionableRemoteFiles">): number {
  return summary.actionableRemoteLinks + summary.actionableRemoteFiles;
}

function inventoryCopyToRemoteCount(summary: Pick<InventorySummary, "actionableLocalLinks" | "actionableLocalFiles">): number {
  return summary.actionableLocalLinks + summary.actionableLocalFiles;
}

function inventoryAssignedRemoteCount(summary: Pick<InventorySummary, "assignedRemoteLinks" | "assignedRemoteFiles">): number {
  return summary.assignedRemoteLinks + summary.assignedRemoteFiles;
}

function createEmptySectionDraft(id: string): SectionDraft {
  return { id, name: "", title: "", type: "other", titleTouched: false, typeTouched: false };
}

function sectionSettingsToDrafts(settings: SectionSettings): SectionDraft[] {
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

function sectionDraftsToSettings(drafts: SectionDraft[]): SectionSettings {
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

function SectionDraftList({ drafts, onChange, disabled = false }: { drafts: SectionDraft[]; onChange: (drafts: SectionDraft[]) => void; disabled?: boolean }) {
  const updateDraft = (id: string, patch: Partial<SectionDraft>) => {
    onChange(drafts.map((draft) => (draft.id === id ? { ...draft, ...patch } : draft)));
  };
  const updateDirectory = (id: string, name: string) => {
    onChange(
      drafts.map((draft) =>
        draft.id === id
          ? {
              ...draft,
              name,
              title: draft.titleTouched ? draft.title : name,
              type: draft.typeTouched ? draft.type : inferSectionContentType(name)
            }
          : draft
      )
    );
  };
  const removeDraft = (id: string) => {
    const next = drafts.filter((draft) => draft.id !== id);
    onChange(next.length > 0 ? next : [createEmptySectionDraft(`section-new-${Date.now()}`)]);
  };
  const moveDraft = (id: string, direction: -1 | 1) => {
    const index = drafts.findIndex((draft) => draft.id === id);
    const targetIndex = index + direction;
    if (index < 0 || targetIndex < 0 || targetIndex >= drafts.length) return;
    const next = [...drafts];
    const [draft] = next.splice(index, 1);
    next.splice(targetIndex, 0, draft);
    onChange(next);
  };

  return (
    <div className="section-settings-list">
      <div className="section-settings-header" aria-hidden="true">
        <span>Order</span>
        <span>Symlink folder</span>
        <span>Library title</span>
        <span>Type</span>
        <span />
      </div>
      {drafts.map((section, index) => (
        <div className="section-settings-row" key={section.id}>
          <div className="section-order-controls" aria-label={`Section ${index + 1} order controls`}>
            <button type="button" className="secondary icon-only" title="Move up" aria-label={`Move section ${index + 1} up`} onClick={() => moveDraft(section.id, -1)} disabled={disabled || index === 0}>
              <ArrowUp size={15} />
            </button>
            <button
              type="button"
              className="secondary icon-only"
              title="Move down"
              aria-label={`Move section ${index + 1} down`}
              onClick={() => moveDraft(section.id, 1)}
              disabled={disabled || index === drafts.length - 1}
            >
              <ArrowDown size={15} />
            </button>
          </div>
          <label className="section-settings-field">
            <span className="section-settings-field-label">Symlink folder</span>
            <input
              aria-label={`Section ${index + 1} symlink folder`}
              value={section.name}
              onChange={(event) => updateDirectory(section.id, event.target.value)}
              placeholder="folder-name"
              disabled={disabled}
            />
          </label>
          <label className="section-settings-field">
            <span className="section-settings-field-label">Library title</span>
            <input
              aria-label={`Section ${index + 1} library title`}
              value={section.title}
              onChange={(event) => updateDraft(section.id, { title: event.target.value, titleTouched: true })}
              placeholder="Same as folder"
              disabled={disabled}
            />
          </label>
          <label className="section-settings-field">
            <span className="section-settings-field-label">Type</span>
            <select
              aria-label={`Section ${index + 1} type`}
              value={section.type}
              onChange={(event) => updateDraft(section.id, { type: event.target.value as SectionContentType, typeTouched: true })}
              disabled={disabled}
            >
              {sectionTypeOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <button className="secondary icon-only" type="button" aria-label={`Remove section ${index + 1}`} onClick={() => removeDraft(section.id)} disabled={disabled}>
            <Trash2 size={16} />
          </button>
        </div>
      ))}
    </div>
  );
}

function isThemePreference(value: string | null): value is ThemePreference {
  return value === "light" || value === "dark" || value === "system";
}

function readThemePreference(): ThemePreference {
  if (typeof window === "undefined") return "system";
  const stored = window.localStorage.getItem(themeStorageKey);
  return isThemePreference(stored) ? stored : "system";
}

function systemPrefersDark(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(themeMediaQuery).matches;
}

function resolveTheme(preference: ThemePreference): "light" | "dark" {
  if (preference === "system") {
    return systemPrefersDark() ? "dark" : "light";
  }
  return preference;
}

function applyThemePreference(preference: ThemePreference): void {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.theme = resolveTheme(preference);
  document.documentElement.dataset.themePreference = preference;
}

function useThemePreference() {
  const [preference, setPreference] = useState<ThemePreference>(() => readThemePreference());

  useEffect(() => {
    window.localStorage.setItem(themeStorageKey, preference);
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

function ThemeSwitcher() {
  const [preference, setPreference] = useThemePreference();
  return (
    <div className="theme-switcher" role="group" aria-label="Theme preference">
      {themeOptions.map((option) => {
        const Icon = option.icon;
        return (
          <button
            key={option.value}
            type="button"
            className={preference === option.value ? "theme-option selected" : "theme-option"}
            aria-label={`${option.label} theme`}
            aria-pressed={preference === option.value}
            title={`${option.label} theme`}
            onClick={() => setPreference(option.value)}
          >
            <Icon size={16} />
            <span className="sr-only">{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}

function StatCard({ label, value, detail, tone = "neutral" }: { label: string; value: number | string; detail?: string; tone?: "neutral" | "bad" | "warn" }) {
  return (
    <div className={`stat stat-${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
      {detail ? <small>{detail}</small> : null}
    </div>
  );
}

function InfoTooltip({ label, children }: { label: string; children: ReactNode }) {
  return (
    <span className="info-tooltip">
      <button type="button" className="info-tooltip-trigger" aria-label={label}>
        <Info size={14} />
      </button>
      <span className="info-tooltip-panel" role="tooltip">
        {children}
      </span>
    </span>
  );
}

interface ParsedDisplayVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
}

function parseDisplayVersion(value: string | null): ParsedDisplayVersion | null {
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

function compareDisplayPrerelease(left: string[], right: string[]): number {
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

function compareDisplayVersions(leftRaw: string | null, rightRaw: string | null): number {
  const left = parseDisplayVersion(leftRaw);
  const right = parseDisplayVersion(rightRaw);
  if (!left || !right) return 0;
  const coreDifference = left.major - right.major || left.minor - right.minor || left.patch - right.patch;
  if (coreDifference !== 0) return coreDifference;
  return compareDisplayPrerelease(left.prerelease, right.prerelease);
}

function shouldHideBetaRelease(info: AppVersionInfo): boolean {
  return info.currentChannel === "stable" && info.beta.latestVersion != null && compareDisplayVersions(info.currentVersion, info.beta.latestVersion) > 0;
}

function visibleVersionReleases(info?: AppVersionInfo): AppReleaseInfo[] {
  if (!info) return [];
  const releases = [info.stable];
  if (!shouldHideBetaRelease(info)) releases.push(info.beta);
  return releases;
}

function versionChannelLabel(channel: AppReleaseInfo["channel"]): string {
  return channel === "beta" ? "Beta" : "Stable";
}

function VersionReleaseRow({ release }: { release: AppReleaseInfo }) {
  const label = versionChannelLabel(release.channel);
  const tooltipId = `version-${release.channel}-notes`;

  return (
    <div className={`version-channel version-channel-${release.status}`}>
      <span className="version-channel-label">{label}</span>
      <strong className="version-channel-version">{release.latestVersion ? `v${release.latestVersion}` : "-"}</strong>
      <span className="version-release-info">
        <button type="button" className="version-release-info-button" aria-label={`${label} release notes`} aria-describedby={tooltipId}>
          <Info size={12} />
        </button>
        <span id={tooltipId} className="version-release-popover" role="tooltip">
          <span className="version-release-heading">
            <span>
              {label} {release.latestVersion ? `v${release.latestVersion}` : ""}
            </span>
            {release.releaseUrl ? (
              <a href={release.releaseUrl} target="_blank" rel="noreferrer">
                GitHub
              </a>
            ) : null}
          </span>
          <strong>{release.message}</strong>
          <p>{release.releaseNotes ?? "No release notes available."}</p>
        </span>
      </span>
    </div>
  );
}

function VersionStatus({
  info,
  isLoading,
  isError,
  isRefreshing,
  onRefresh
}: {
  info?: AppVersionInfo;
  isLoading: boolean;
  isError: boolean;
  isRefreshing: boolean;
  onRefresh: () => void;
}) {
  const tone = isLoading ? "checking" : isError ? "unavailable" : (info?.status ?? "unavailable");
  const display = info ? formatCurrentVersionDisplay(info) : null;
  const message = isLoading ? "Checking GitHub releases" : isError ? "GitHub check unavailable" : (info?.message ?? "GitHub check unavailable");
  const releases = visibleVersionReleases(info);

  return (
    <div className={`version-status version-status-${tone}`} aria-live="polite">
      <div className="version-status-main">
        <button
          type="button"
          className={`version-refresh-button${isRefreshing ? " is-refreshing" : ""}`}
          aria-label="Check for updates"
          disabled={isRefreshing}
          onClick={onRefresh}
        >
          <RefreshCw size={14} />
        </button>
        {display ? (
          <span className="current-version-label" aria-label={`${display.version} ${display.channel}`}>
            <span className="current-version-number">{display.version}</span>
            <span className="current-version-channel">{display.channel}</span>
          </span>
        ) : (
          <span className="current-version-number">Version check</span>
        )}
      </div>
      <div className="version-status-channels" aria-label="Version availability">
        {releases.length > 0 ? (
          releases.map((release) => <VersionReleaseRow key={release.channel} release={release} />)
        ) : (
          <small>{message}</small>
        )}
      </div>
    </div>
  );
}

function RootLayout() {
  const queryClient = useQueryClient();
  const location = useLocation();
  const me = useQuery({ queryKey: ["me"], queryFn: api.me });
  const userPreferences = useQuery({ queryKey: ["user-preferences"], queryFn: api.getUserPreferences });
  const storageLocations = useQuery({ queryKey: ["storage-locations"], queryFn: api.getStorageLocations });
  const version = useQuery({ queryKey: ["app-version"], queryFn: () => api.appVersion(), retry: false, staleTime: versionCheckIntervalMs, refetchInterval: versionCheckIntervalMs });
  const versionRefresh = useMutation({
    mutationFn: () => api.appVersion(true),
    onSuccess: (data) => queryClient.setQueryData(["app-version"], data)
  });
  const [expandedGroups, setExpandedGroups] = useState<Record<SidebarGroup, boolean>>({ history: false, settings: false });
  const logout = useMutation({
    mutationFn: api.logout,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["me"] })
  });
  const username = me.data?.user?.username ?? "Signed in";
  const pathname = location.pathname;
  const isHistoryActive = pathname === "/scans" || pathname === "/audits";
  const isSettingsActive = pathname === "/settings" || pathname.startsWith("/settings/");

  const nav = [
    { to: "/", label: "Dashboard", icon: Gauge },
    { to: "/library", label: "Library", icon: Library },
    { to: "/integrations", label: "Integrations", icon: Blocks },
    { to: "/logs", label: "Logs", icon: FileText }
  ];
  const toggleGroup = (group: SidebarGroup) => {
    setExpandedGroups((groups) => ({ ...groups, [group]: !groups[group] }));
  };

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <HardDriveDownload size={24} />
          <div>
            <strong>SRTL Manager</strong>
          </div>
        </div>
        <div className="sidebar-account">
          <div className="sidebar-user-chip" title={username} aria-label={`Signed in as ${username}`}>
            <UserCog size={15} />
            <span>{username}</span>
          </div>
          <div className="sidebar-account-actions">
            <ThemeSwitcher />
            <button type="button" className="ghost-button sidebar-sign-out-button" onClick={() => logout.mutate()}>
              <LogOut size={16} />
              <span>Sign out</span>
            </button>
          </div>
        </div>
        <nav>
          {nav.map((item) => (
            <Link key={item.to} to={item.to} className="nav-link" activeProps={{ className: "nav-link active" }}>
              <item.icon size={18} />
              {item.label}
            </Link>
          ))}
          <div className="nav-group">
            <button
              type="button"
              className={`nav-link nav-disclosure${isHistoryActive ? " active" : ""}`}
              aria-expanded={expandedGroups.history}
              aria-controls="history-nav"
              onClick={() => toggleGroup("history")}
            >
              <Activity size={18} />
              History
              <ChevronRight className="nav-disclosure-icon" size={16} />
            </button>
            {expandedGroups.history ? (
              <div id="history-nav" className="nav-sublinks">
                {historySections.map((item) => (
                  <Link key={item.to} to={item.to} className="nav-sublink" activeProps={{ className: "nav-sublink active" }} activeOptions={{ exact: true }}>
                    <item.icon size={15} />
                    {item.label}
                  </Link>
                ))}
              </div>
            ) : null}
          </div>
          <div className="nav-group">
            <button
              type="button"
              className={`nav-link nav-disclosure${isSettingsActive ? " active" : ""}`}
              aria-expanded={expandedGroups.settings}
              aria-controls="settings-nav"
              onClick={() => toggleGroup("settings")}
            >
              <Settings size={18} />
              Settings
              <ChevronRight className="nav-disclosure-icon" size={16} />
            </button>
            {expandedGroups.settings ? (
              <div id="settings-nav" className="nav-sublinks">
                {settingsSections.map((item) => (
                  <Link key={item.view} to={item.to} className="nav-sublink" activeProps={{ className: "nav-sublink active" }} activeOptions={{ exact: true }}>
                    <item.icon size={15} />
                    {item.label}
                  </Link>
                ))}
              </div>
            ) : null}
          </div>
        </nav>
        <div className="sidebar-footer">
          <VersionStatus
            info={version.data}
            isLoading={version.isLoading}
            isError={version.isError}
            isRefreshing={version.isFetching || versionRefresh.isPending}
            onRefresh={() => versionRefresh.mutate()}
          />
        </div>
      </aside>
      <main className="content">
        <StorageLocationsContext.Provider value={storageLocations.data ?? defaultStorageLocations}>
          <UserPreferencesContext.Provider value={userPreferences.data ?? defaultUserPreferences}>
            <Outlet />
          </UserPreferencesContext.Provider>
        </StorageLocationsContext.Provider>
      </main>
    </div>
  );
}

function stripLegacyScanSections(options: ScanOptions): ScanOptions {
  const { sections: _legacySections, ...nextOptions } = options;
  return nextOptions;
}

function titleRescanOptions(titleScopes: ScanTitleScope[]): ScanOptions {
  const uniqueScopes = [...new Map(titleScopes.map((scope) => [`${scope.section}\0${scope.itemName}`, scope])).values()];
  return {
    scanSymlinks: true,
    scanLocal: false,
    scanRemote: false,
    symlinkSections: [...new Set(uniqueScopes.map((scope) => scope.section))],
    localSections: [],
    titleScopes: uniqueScopes
  };
}

function titleScopeIsPending(scopes: ScanTitleScope[] | undefined, section: string, itemName: string): boolean {
  return Boolean(scopes?.some((scope) => scope.section === section && scope.itemName === itemName));
}

function DashboardPage() {
  const queryClient = useQueryClient();
  const { autoOpenTaskStatus, recentJobsCompletedWindowMinutes } = useUserPreferences();
  const storageLocations = useStorageLocations();
  const localName = storageLocationName(storageLocations, "local");
  const remoteName = storageLocationName(storageLocations, "remote");
  const [scanOptions, setScanOptions] = useState<ScanOptions>({ scanSymlinks: true, scanLocal: false, scanRemote: false });
  const [auditSettingsDraft, setAuditSettingsDraft] = useState<AuditSettings>({ sections: [], targets: ["local", "remote"] });
  const [selectedRemoteWork, setSelectedRemoteWork] = useState<SectionWorkSelection | null>(null);
  const [auditPrompt, setAuditPrompt] = useState<AuditPrompt | null>(null);
  const [auditStatusPrompt, setAuditStatusPrompt] = useState<AuditStatusPrompt | null>(null);
  const [copyPrompt, setCopyPrompt] = useState<CopyPrompt | null>(null);
  const [scanStatusPrompt, setScanStatusPrompt] = useState<ScanStatusPrompt | null>(null);
  const sectionSummaries = useQuery({ queryKey: ["sections"], queryFn: api.sections, refetchInterval: 5000 });
  const sectionSettings = useQuery({ queryKey: ["section-settings"], queryFn: api.getSections });
  const paths = useQuery({ queryKey: ["paths"], queryFn: api.getPaths });
  const scanSettings = useQuery({ queryKey: ["scan-settings"], queryFn: api.getScanSettings });
  const auditSettings = useQuery({ queryKey: ["audit-settings"], queryFn: api.getAuditSettings });
  const inventory = useQuery({ queryKey: ["inventory-summary"], queryFn: api.inventorySummary, refetchInterval: 5000 });
  const scanTimestamps = useQuery({ queryKey: ["inventory-scan-timestamps"], queryFn: api.inventoryScanTimestamps, refetchInterval: 60000 });
  const jobs = useQuery({
    queryKey: ["jobs", "recent", recentJobsCompletedWindowMinutes],
    queryFn: () => api.jobs({ completedWithinMinutes: recentJobsCompletedWindowMinutes }),
    refetchInterval: 3000
  });
  const saveScanSettings = useMutation({
    mutationFn: api.saveScanSettings,
    onSuccess: (settings) => queryClient.setQueryData(["scan-settings"], settings)
  });
  const saveAuditSettings = useMutation({
    mutationFn: api.saveAuditSettings,
    onSuccess: (settings) => queryClient.setQueryData(["audit-settings"], settings)
  });
  const startCopySilently = useStartCopyJob();
  const copyConflictCheck = useMutation({
    mutationFn: (prompt: CopyPrompt) => {
      if (!prompt.options) throw new Error("Copy options are missing");
      return api.copyConflicts(prompt.options);
    },
    onSuccess: (conflicts, prompt) => {
      if (conflicts.totalConflicts > 0) {
        setCopyPrompt({ ...prompt, conflicts });
        return;
      }
      if (!autoOpenTaskStatus && prompt.autoStart) {
        startCopySilently.mutate(prompt);
        return;
      }
      setCopyPrompt(prompt);
    }
  });
  const startScan = useMutation({
    mutationFn: (options: ScanOptions) => api.startScan(options),
    onSuccess: async (result, submittedOptions) => {
      queryClient.invalidateQueries({ queryKey: ["scans"] });
      queryClient.invalidateQueries({ queryKey: ["inventory-summary"] });
      queryClient.invalidateQueries({ queryKey: ["inventory-scan-timestamps"] });
      queryClient.invalidateQueries({ queryKey: ["media-links"] });
      queryClient.invalidateQueries({ queryKey: ["media-links-page"] });
      queryClient.invalidateQueries({ queryKey: ["dashboard-remote-work-links"] });
      queryClient.invalidateQueries({ queryKey: ["media-link-tree"] });
      queryClient.invalidateQueries({ queryKey: ["storage-files"] });
      await queryClient.refetchQueries({ queryKey: ["jobs"] });
      if (autoOpenTaskStatus) {
        setScanStatusPrompt({
          key: `scan-job-${result.jobId}`,
          title: "Inventory scan",
          description: formatScanScope(submittedOptions, availableScanSections),
          jobId: result.jobId
        });
      }
    }
  });
  const configuredSectionNames = sectionSettings.data?.sections ?? sectionSummaries.data?.map((section) => section.section) ?? [];
  const availableScanSections = configuredSectionNames.map((section) => ({
    section,
    title: sectionSettings.data?.sectionTitles?.[section] ?? sectionSummaries.data?.find((summary) => summary.section === section)?.title ?? section
  }));
  const availableScanSectionNames = availableScanSections.map((section) => section.section);
  const selectedSymlinkSections = (scanOptions.symlinkSections ?? scanOptions.sections ?? availableScanSectionNames).filter((section) => availableScanSectionNames.includes(section));
  const selectedLocalSections = (scanOptions.localSections ?? scanOptions.sections ?? availableScanSectionNames).filter((section) => availableScanSectionNames.includes(section));
  const selectedSymlinkScanAge =
    selectedSymlinkSections.length === 0 ? "No folders selected" : oldestScanAgeLabel(selectedSymlinkSections.map((section) => scanTimestamps.data?.symlinkSections[section] ?? null));
  const selectedLocalScanAge =
    selectedLocalSections.length === 0 ? "No folders selected" : oldestScanAgeLabel(selectedLocalSections.map((section) => scanTimestamps.data?.localSections[section] ?? null));
  const remoteScanAge = scanAgeLabel(scanTimestamps.data?.remoteRoot ?? null);
  const selectedAuditSections = auditSettingsDraft.sections.filter((section) => availableScanSectionNames.includes(section));
  const selectedAuditTargets = normalizeAuditTargets(auditSettingsDraft.targets);
  const auditLocalSelected = selectedAuditTargets.includes("local");
  const auditRemoteSelected = selectedAuditTargets.includes("remote");
  const selectedInventoryScopeCount = [scanOptions.scanSymlinks, scanOptions.scanLocal, scanOptions.scanRemote].filter(Boolean).length;
  const selectedInventoryFolderCount = selectedSymlinkSections.length + selectedLocalSections.length;
  const totalInventoryFolderCount = availableScanSectionNames.length * 2;
  const selectedAuditScopeCount = selectedAuditTargets.length;
  const allInventorySelected =
    scanOptions.scanSymlinks &&
    scanOptions.scanLocal &&
    scanOptions.scanRemote &&
    selectedSymlinkSections.length === availableScanSectionNames.length &&
    selectedLocalSections.length === availableScanSectionNames.length;
  const noInventorySelected = selectedInventoryScopeCount === 0 && selectedInventoryFolderCount === 0;
  const hasScanScope = scanOptions.scanSymlinks || scanOptions.scanLocal || scanOptions.scanRemote;
  const canRunScan =
    hasScanScope &&
    (!scanOptions.scanSymlinks || selectedSymlinkSections.length > 0) &&
    (!scanOptions.scanLocal || selectedLocalSections.length > 0) &&
    (!scanOptions.scanRemote || Boolean(paths.data?.remoteDir));
  const canRunAudit = auditRemoteSelected || (auditLocalSelected && selectedAuditSections.length > 0);
  const sectionTotals = (sectionSummaries.data ?? []).reduce(
    (acc, section) => ({
      totalLinks: acc.totalLinks + section.totalLinks,
      remoteLinks: acc.remoteLinks + section.remoteLinks,
      localLinks: acc.localLinks + section.localLinks,
      actionableRemoteLinks: acc.actionableRemoteLinks + section.actionableRemoteLinks,
      actionableLocalLinks: acc.actionableLocalLinks + section.actionableLocalLinks,
      assignedRemoteLinks: acc.assignedRemoteLinks + section.assignedRemoteLinks,
      unassignedRemoteLinks: acc.unassignedRemoteLinks + section.unassignedRemoteLinks,
      unassignedLocalLinks: acc.unassignedLocalLinks + section.unassignedLocalLinks,
      brokenLinks: acc.brokenLinks + section.brokenLinks
    }),
    {
      totalLinks: 0,
      remoteLinks: 0,
      localLinks: 0,
      actionableRemoteLinks: 0,
      actionableLocalLinks: 0,
      assignedRemoteLinks: 0,
      unassignedRemoteLinks: 0,
      unassignedLocalLinks: 0,
      brokenLinks: 0
    }
  );
  const totals = inventory.data ?? {
    ...sectionTotals,
    otherLinks: 0,
    nonMediaLinks: 0,
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
  const orderedSectionSummaries = orderSectionSummaries(sectionSummaries.data ?? [], sectionSettings.data?.sections);
  const totalDestinationSymlinks = totals.localLinks + totals.remoteLinks;
  const totalStorageFiles = totals.localFiles + totals.remoteFiles;
  const totalOrphanFiles = totals.localOrphanFiles + totals.remoteOrphanFiles;
  const policyNeededTotal = inventoryPolicyNeededCount(totals);
  const copyToLocalTotal = inventoryCopyToLocalCount(totals);
  const copyToRemoteTotal = inventoryCopyToRemoteCount(totals);
  const actionError =
    startScan.error ?? copyConflictCheck.error ?? startCopySilently.error ?? paths.error ?? sectionSettings.error ?? scanSettings.error ?? auditSettings.error ?? saveScanSettings.error ?? saveAuditSettings.error;
  const actionMessage = startCopySilently.data
    ? `Copy job #${startCopySilently.data.jobId} queued. View progress from Recent Jobs.`
    : startScan.data
      ? `Inventory scan job #${startScan.data.jobId} queued.`
      : null;

  useEffect(() => {
    if (scanSettings.data) setScanOptions(stripLegacyScanSections(scanSettings.data));
  }, [scanSettings.data]);

  useEffect(() => {
    if (auditSettings.data) setAuditSettingsDraft(auditSettings.data);
  }, [auditSettings.data]);

  function updateScanOptions(nextOptions: ScanOptions) {
    const normalizedOptions = stripLegacyScanSections(nextOptions);
    setScanOptions(normalizedOptions);
    saveScanSettings.mutate(normalizedOptions);
  }

  function updateAuditSettings(nextSettings: AuditSettings) {
    setAuditSettingsDraft(nextSettings);
    saveAuditSettings.mutate(nextSettings);
  }

  function toggleScanSection(scope: "symlinkSections" | "localSections", section: string, checked: boolean) {
    const currentSections = scanOptions[scope] ?? scanOptions.sections ?? availableScanSectionNames;
    const nextSectionSet = new Set(checked ? [...currentSections, section] : currentSections.filter((currentSection) => currentSection !== section));
    setScanSections(scope, availableScanSectionNames.filter((currentSection) => nextSectionSet.has(currentSection)));
  }

  function setScanSections(scope: "symlinkSections" | "localSections", sections: string[]) {
    const nextSectionSet = new Set(sections);
    updateScanOptions({ ...scanOptions, [scope]: availableScanSectionNames.filter((currentSection) => nextSectionSet.has(currentSection)) });
  }

  function selectAllInventoryScanOptions() {
    updateScanOptions({
      ...scanOptions,
      scanSymlinks: true,
      scanLocal: true,
      scanRemote: true,
      symlinkSections: availableScanSectionNames,
      localSections: availableScanSectionNames
    });
  }

  function clearAllInventoryScanOptions() {
    updateScanOptions({
      ...scanOptions,
      scanSymlinks: false,
      scanLocal: false,
      scanRemote: false,
      symlinkSections: [],
      localSections: []
    });
  }

  function toggleAuditSection(section: string, checked: boolean) {
    const currentSections = auditSettingsDraft.sections;
    const nextSectionSet = new Set(checked ? [...currentSections, section] : currentSections.filter((currentSection) => currentSection !== section));
    updateAuditSettings({ ...auditSettingsDraft, sections: availableScanSectionNames.filter((currentSection) => nextSectionSet.has(currentSection)) });
  }

  function toggleAuditTarget(target: StorageRootType, checked: boolean) {
    const currentTargets = selectedAuditTargets;
    const nextTargetSet = new Set(checked ? [...currentTargets, target] : currentTargets.filter((currentTarget) => currentTarget !== target));
    updateAuditSettings({ ...auditSettingsDraft, targets: storageRootOrder.filter((currentTarget) => nextTargetSet.has(currentTarget)) });
  }

  function openDashboardAuditPrompt() {
    if (!canRunAudit) return;
    const options: Omit<AuditOptions, "mode"> = {
      targets: selectedAuditTargets,
      ...(auditLocalSelected ? { sections: selectedAuditSections } : {})
    };
    setAuditPrompt({
      title: "Audit selected targets",
      description: formatAuditScope(options, availableScanSections),
      options
    });
  }

  function runInventoryScan() {
    startCopySilently.reset();
    startScan.mutate(stripLegacyScanSections(scanOptions));
  }

  function handleCopyRequest(prompt: CopyPrompt) {
    startScan.reset();
    if (prompt.options?.direction === "to_local" && !prompt.options.localConflictStrategy) {
      copyConflictCheck.mutate(prompt);
      return;
    }
    if (!autoOpenTaskStatus && prompt.autoStart) {
      startCopySilently.mutate(prompt);
      return;
    }
    setCopyPrompt(prompt);
  }

  return (
    <Page title="Dashboard" subtitle="Manual read-only inventory of symlinks, storage files, and orphans." hideHeader>
      <div className="dashboard-actions">
        <section className="action-group action-group-primary" aria-labelledby="inventory-actions-title">
          <div className="action-group-header">
            <RefreshCw size={17} />
            <h2 id="inventory-actions-title">Inventory Scan</h2>
            <InfoTooltip label="About inventory scans">
              Reads the selected symlink folders and optional storage folders, then updates SRTL Manager's inventory database without changing media files.
            </InfoTooltip>
          </div>
          <div className="inventory-scope-toolbar">
            <span>
              {selectedInventoryScopeCount}/3 categories - {selectedInventoryFolderCount}/{totalInventoryFolderCount} folders
            </span>
            <div className="inventory-scope-actions">
              <button type="button" className="secondary inventory-scope-action" onClick={selectAllInventoryScanOptions} disabled={allInventorySelected}>
                Select all
              </button>
              <button type="button" className="secondary inventory-scope-action" onClick={clearAllInventoryScanOptions} disabled={noInventorySelected}>
                Clear all
              </button>
            </div>
          </div>
          <div className="inventory-scope-list" role="group" aria-label="Inventory scan scopes">
            <ScanScopeBlock
              checked={scanOptions.scanSymlinks}
              icon={<Link2 size={15} />}
              title="Symlinks"
              detail={`${selectedSymlinkSections.length}/${availableScanSections.length} folders - ${selectedSymlinkScanAge}`}
              onChange={(checked) => updateScanOptions({ ...scanOptions, scanSymlinks: checked })}
            >
              <FolderScopePicker
                ariaLabel="Symlink folders"
                emptyMessage="No library sections configured."
                sections={availableScanSections}
                lastScannedBySection={scanTimestamps.data?.symlinkSections ?? {}}
                selectedSections={selectedSymlinkSections}
                onToggle={(section, checked) => toggleScanSection("symlinkSections", section, checked)}
              />
            </ScanScopeBlock>
            <ScanScopeBlock
              checked={scanOptions.scanLocal}
              icon={<HardDrive size={15} />}
              title={`${localName} files`}
              detail={`${selectedLocalSections.length}/${availableScanSections.length} folders - ${selectedLocalScanAge}`}
              onChange={(checked) => updateScanOptions({ ...scanOptions, scanLocal: checked })}
            >
              <FolderScopePicker
                ariaLabel={`${localName} file folders`}
                emptyMessage="No library sections configured."
                sections={availableScanSections}
                lastScannedBySection={scanTimestamps.data?.localSections ?? {}}
                selectedSections={selectedLocalSections}
                onToggle={(section, checked) => toggleScanSection("localSections", section, checked)}
              />
            </ScanScopeBlock>
            <ScanScopeBlock
              checked={scanOptions.scanRemote}
              icon={<HardDriveDownload size={15} />}
              title={`${remoteName} files`}
              detail={remoteScanAge}
              onChange={(checked) => updateScanOptions({ ...scanOptions, scanRemote: checked })}
            />
          </div>
          <button className="run-scan-button" onClick={runInventoryScan} disabled={startScan.isPending || !canRunScan}>
            <RefreshCw size={16} />
            Run Inventory Scan
          </button>
        </section>
        <section className="action-group action-group-audits" aria-labelledby="audit-actions-title">
          <div className="action-group-header">
            <Activity size={17} />
            <h2 id="audit-actions-title">Audits</h2>
            <InfoTooltip label="About audits">
              Verifies media in the selected storage locations as a read-only job. Fast audit checks container reads; deep audit fully decodes for heavier validation.
            </InfoTooltip>
          </div>
          <div className="inventory-scope-toolbar">
            <span>
              {selectedAuditScopeCount}/2 categories - {selectedAuditSections.length}/{availableScanSections.length} {localName} folders
            </span>
            <div className="inventory-scope-actions">
              <button type="button" className="secondary inventory-scope-action" onClick={() => {
                updateAuditSettings({ ...auditSettingsDraft, targets: ["local", "remote"], sections: availableScanSectionNames });
              }} disabled={auditLocalSelected && auditRemoteSelected && selectedAuditSections.length === availableScanSections.length}>
                Select all
              </button>
              <button type="button" className="secondary inventory-scope-action" onClick={() => {
                updateAuditSettings({ ...auditSettingsDraft, targets: [], sections: [] });
              }} disabled={selectedAuditScopeCount === 0 && selectedAuditSections.length === 0}>
                Clear all
              </button>
            </div>
          </div>
          <div className="inventory-scope-list" role="group" aria-label="Audit targets">
            <ScanScopeBlock
              checked={auditLocalSelected}
              icon={<HardDrive size={15} />}
              title={`${localName} targets`}
              detail={`${selectedAuditSections.length}/${availableScanSections.length} folders`}
              onChange={(checked) => toggleAuditTarget("local", checked)}
            >
              <FolderScopePicker
                ariaLabel={`${localName} audit folders`}
                emptyMessage="No library sections configured."
                sections={availableScanSections}
                lastScannedBySection={scanTimestamps.data?.symlinkSections ?? {}}
                selectedSections={selectedAuditSections}
                onToggle={toggleAuditSection}
              />
            </ScanScopeBlock>
            <ScanScopeBlock
              checked={auditRemoteSelected}
              icon={<HardDriveDownload size={15} />}
              title={`${remoteName} targets`}
              detail={`${remoteName} root`}
              onChange={(checked) => toggleAuditTarget("remote", checked)}
            />
          </div>
          <button className="run-scan-button" onClick={openDashboardAuditPrompt} disabled={!canRunAudit}>
            <Activity size={16} />
            Run Audit
          </button>
        </section>
      </div>
      {actionError ? <p className="action-message action-error">{actionError.message}</p> : null}
      {!actionError && actionMessage ? <p className="action-message">{actionMessage}</p> : null}
      <div className="dashboard-summary">
        <section className="summary-group summary-group-attention" aria-labelledby="attention-summary-title">
          <div className="summary-group-title">
            <TriangleAlert size={15} />
            <h2 id="attention-summary-title">Needs Attention</h2>
          </div>
          <div className="stats-grid">
            <StatCard label="Unassigned" value={formatNumber(policyNeededTotal)} detail={`${localName} + ${remoteName} media`} tone={policyNeededTotal > 0 ? "warn" : "neutral"} />
            <StatCard label={`Copy to ${localName}`} value={formatNumber(copyToLocalTotal)} detail={`${remoteName} media`} tone={copyToLocalTotal > 0 ? "bad" : "neutral"} />
            <StatCard label={`Copy to ${remoteName}`} value={formatNumber(copyToRemoteTotal)} detail={`${localName} media`} tone={copyToRemoteTotal > 0 ? "bad" : "neutral"} />
            <StatCard label="Broken symlinks" value={formatNumber(totals.brokenLinks)} tone={totals.brokenLinks > 0 ? "bad" : "neutral"} />
          </div>
        </section>
        <section className="summary-group summary-group-separated" aria-labelledby="local-summary-title">
          <div className="summary-group-title">
            <HardDrive size={15} />
            <h2 id="local-summary-title">{localName}</h2>
          </div>
          <div className="stats-grid">
            <StatCard label="Symlinks" value={formatNumber(totals.localLinks)} />
            <StatCard label="Files" value={formatNumber(totals.localFiles)} />
            <StatCard label="Orphan files" value={formatNumber(totals.localOrphanFiles)} />
          </div>
        </section>
        <section className="summary-group summary-group-separated" aria-labelledby="remote-summary-title">
          <div className="summary-group-title">
            <HardDriveDownload size={15} />
            <h2 id="remote-summary-title">{remoteName}</h2>
          </div>
          <div className="stats-grid">
            <StatCard label="Symlinks" value={formatNumber(totals.remoteLinks)} />
            <StatCard label="Files" value={formatNumber(totals.remoteFiles)} />
            <StatCard label="Orphan files" value={formatNumber(totals.remoteOrphanFiles)} />
          </div>
        </section>
        <section className="summary-group summary-group-separated summary-group-totals" aria-labelledby="totals-summary-title">
          <div className="summary-group-title">
            <Database size={15} />
            <h2 id="totals-summary-title">Totals</h2>
          </div>
          <div className="stats-grid">
            <StatCard label="Symlinks" value={formatNumber(totalDestinationSymlinks)} />
            <StatCard label="Files" value={formatNumber(totalStorageFiles)} />
            <StatCard label="Orphan files" value={formatNumber(totalOrphanFiles)} />
          </div>
        </section>
      </div>
      <SectionTable sections={orderedSectionSummaries} selectedRemoteWork={selectedRemoteWork} onRemoteWorkSelect={setSelectedRemoteWork} />
      <RemoteWorkLinksTable
        selection={selectedRemoteWork}
        sections={orderedSectionSummaries}
        pendingTitleScopes={startScan.isPending ? startScan.variables?.titleScopes : undefined}
        onClose={() => setSelectedRemoteWork(null)}
        onAuditRequest={setAuditPrompt}
        onCopyRequest={handleCopyRequest}
        onRescanTitle={(section, itemName) => startScan.mutate(titleRescanOptions([{ section, itemName }]))}
      />
      <JobsTable
        jobs={jobs.data ?? []}
        sections={availableScanSections}
        onScanJobSelect={(job) => setScanStatusPrompt(scanStatusPromptFromJob(job, availableScanSections))}
        onAuditJobSelect={(job) => setAuditStatusPrompt(auditStatusPromptFromJob(job, availableScanSections))}
        onCopyJobSelect={(job) => setCopyPrompt(copyPromptFromJob(job, availableScanSections, storageLocations))}
      />
      <AuditDialog prompt={auditPrompt} onClose={() => setAuditPrompt(null)} />
      <AuditStatusDialog prompt={auditStatusPrompt} onClose={() => setAuditStatusPrompt(null)} />
      <CopyDialog prompt={copyPrompt} onClose={() => setCopyPrompt(null)} />
      <ScanStatusDialog prompt={scanStatusPrompt} onClose={() => setScanStatusPrompt(null)} />
    </Page>
  );
}

function JobEventsHeader({
  label,
  jobId,
  loaded,
  total,
  loading,
  loadingOlder
}: {
  label: string;
  jobId: number | null;
  loaded: number;
  total: number;
  loading: boolean;
  loadingOlder: boolean;
}) {
  return (
    <div className="audit-dialog-section-title">
      <span className="audit-dialog-section-label">
        <FileText size={15} />
        <span>{label}</span>
      </span>
      {jobId ? (
        <span className="job-events-heading-actions">
          <small>{loading ? "Loading events..." : loadingOlder ? `Loading ${jobEventCountLabel(loaded, total)}` : jobEventCountLabel(loaded, total)}</small>
          <Link to="/logs" search={{ job: jobId }} className="secondary job-events-full-link">
            <FileText size={13} />
            See full events
          </Link>
        </span>
      ) : null}
    </div>
  );
}

function AuditDialog({
  prompt,
  onClose
}: {
  prompt: AuditPrompt | null;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const { timeFormat, autoOpenTaskStatus } = useUserPreferences();
  const [jobId, setJobId] = useState<number | null>(null);
  const [selectedMode, setSelectedMode] = useState<AuditMode | null>(null);
  const [terminatePrompt, setTerminatePrompt] = useState<JobRecord | null>(null);
  const terminateJob = useTerminateJobMutation(() => setTerminatePrompt(null));
  const advancedSettings = useQuery({
    queryKey: ["advanced-settings"],
    queryFn: api.getAdvancedSettings,
    enabled: Boolean(prompt)
  });
  const advanced = normalizeAdvancedSettings(advancedSettings.data ?? defaultAdvancedSettings);
  const defaultAuditMode = advanced.audit.defaultMode;
  const jobQuery = useQuery({
    queryKey: ["job", jobId],
    queryFn: () => api.job(jobId!),
    enabled: Boolean(prompt && jobId),
    refetchInterval: 1500
  });
  const currentJob = jobQuery.data ?? null;
  const jobActive = currentJob ? currentJob.status === "queued" || currentJob.status === "running" : Boolean(jobId);
  const events = useJobEventTimeline({ jobId, enabled: Boolean(prompt && jobId), refetchInterval: jobActive ? 1500 : false, loadAll: true });
  const startAudit = useMutation({
    mutationFn: ({ auditPrompt, mode }: { auditPrompt: AuditPrompt; mode: AuditMode }) =>
      api.startAudit({
        mode,
        ...(advanced.audit.byteCompareWhenSourceKnown ? {} : { byteCompare: false }),
        ...auditPrompt.options
      }),
    onSuccess: (result, variables) => {
      queryClient.invalidateQueries({ queryKey: ["jobs"] });
      queryClient.invalidateQueries({ queryKey: ["audits"] });
      if (autoOpenTaskStatus) {
        setJobId(result.jobId);
        setSelectedMode(variables.mode);
      } else {
        onClose();
      }
    }
  });

  useEffect(() => {
    setJobId(null);
    setSelectedMode(null);
  }, [prompt]);

  if (!prompt) return null;

  const displayedEvents = [...events.events].reverse();
  const canStart = !jobId && !startAudit.isPending;
  const highlightedMode = selectedMode ?? (!jobId ? defaultAuditMode : null);

  function queueAudit(mode: AuditMode) {
    if (!canStart || !prompt) return;
    startAudit.mutate({ auditPrompt: prompt, mode });
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="audit-dialog" role="dialog" aria-modal="true" aria-labelledby="audit-dialog-title">
        <div className="audit-dialog-header">
          <div className="audit-dialog-title-block">
            <span className="audit-dialog-eyebrow">Audit</span>
            <h2 id="audit-dialog-title">{prompt.title}</h2>
            <p>{prompt.description}</p>
            <JobStatusTerminateAction job={currentJob} isTerminating={terminateJob.isPending} onTerminate={setTerminatePrompt} />
          </div>
          <JobStatusHeaderActions closeLabel="Close audit window" onClose={onClose} />
        </div>

        <div className="audit-mode-grid" role="group" aria-label="Audit mode">
          <button type="button" className={`audit-mode-card${highlightedMode === "fast" ? " selected" : ""}`} onClick={() => queueAudit("fast")} disabled={!canStart}>
            <Play size={17} />
            <span>
              <strong>Fast Audit</strong>
              <small>Read container streams without a full decode.</small>
              {!jobId && defaultAuditMode === "fast" ? <em>Default</em> : null}
            </span>
          </button>
          <button type="button" className={`audit-mode-card${highlightedMode === "deep" ? " selected" : ""}`} onClick={() => queueAudit("deep")} disabled={!canStart}>
            <Activity size={17} />
            <span>
              <strong>Deep Audit</strong>
              <small>Decode media fully for stricter validation.</small>
              {!jobId && defaultAuditMode === "deep" ? <em>Default</em> : null}
            </span>
          </button>
        </div>

        {startAudit.error ? <p className="panel-message action-error">{startAudit.error.message}</p> : null}
        {advancedSettings.error ? <p className="panel-message action-error">{advancedSettings.error.message}</p> : null}

        <AuditProgressPanel job={currentJob} pendingJobId={jobId} />

        <div className="audit-dialog-events">
          <JobEventsHeader label="Progress events" jobId={jobId} loaded={events.events.length} total={events.total} loading={events.isLoading} loadingOlder={events.isFetchingNextPage} />
          {jobId && events.isLoading ? <p className="panel-message">Loading audit events...</p> : null}
          {events.error ? <p className="panel-message action-error">{events.error.message}</p> : null}
          {jobId && !events.isLoading && !events.error && displayedEvents.length === 0 ? <p className="panel-message">No events yet.</p> : null}
          {!jobId ? <p className="panel-message">Pick a mode to start the audit. Closing this window after start leaves the job running in the background.</p> : null}
          {displayedEvents.length > 0 ? (
            <div className="events audit-dialog-event-list">
              {displayedEvents.map((event) => (
                <LogEventRow key={event.id} event={event} timeFormat={timeFormat} job={currentJob} />
              ))}
            </div>
          ) : null}
        </div>
        <TerminateJobDialog
          job={terminatePrompt}
          error={terminateJob.error?.message}
          isPending={terminateJob.isPending}
          onClose={() => !terminateJob.isPending && setTerminatePrompt(null)}
          onConfirm={(targetJobId) => terminateJob.mutate(targetJobId)}
        />
      </section>
    </div>
  );
}

function CopyDialog({
  prompt,
  onClose
}: {
  prompt: CopyPrompt | null;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const { timeFormat } = useUserPreferences();
  const [jobId, setJobId] = useState<number | null>(prompt?.jobId ?? null);
  const [startedPromptKey, setStartedPromptKey] = useState<string | null>(null);
  const [localConflictStrategy, setLocalConflictStrategy] = useState<CopyLocalConflictStrategy | null>(null);
  const [terminatePrompt, setTerminatePrompt] = useState<JobRecord | null>(null);
  const terminateJob = useTerminateJobMutation(() => setTerminatePrompt(null));
  const jobQuery = useQuery({
    queryKey: ["job", jobId],
    queryFn: () => api.job(jobId!),
    enabled: Boolean(prompt && jobId),
    refetchInterval: 500
  });
  const currentJob = jobQuery.data ?? null;
  const currentJobId = currentJob?.id ?? null;
  const currentJobStatus = currentJob?.status ?? null;
  const jobActive = currentJob ? currentJob.status === "queued" || currentJob.status === "running" : Boolean(jobId);
  const events = useJobEventTimeline({ jobId, enabled: Boolean(prompt && jobId), refetchInterval: jobActive ? 500 : 2500, loadAll: true });
  const startCopy = useStartCopyJob((result) => setJobId(result.jobId));

  useEffect(() => {
    setJobId(prompt?.jobId ?? null);
    setStartedPromptKey(null);
    setLocalConflictStrategy(null);
  }, [prompt?.key, prompt?.jobId]);

  useEffect(() => {
    if (!prompt?.autoStart || !prompt.options || jobId || startedPromptKey === prompt.key || startCopy.isPending) return;
    const requiresLocalResolution = Boolean(prompt.conflicts?.totalConflicts && !prompt.options.localConflictStrategy && !localConflictStrategy);
    if (requiresLocalResolution) return;
    const options = localConflictStrategy ? { ...prompt.options, localConflictStrategy } : prompt.options;
    const resolvedPromptKey = localConflictStrategy ? `${prompt.key}:${localConflictStrategy}` : prompt.key;
    if (startedPromptKey === resolvedPromptKey) return;
    setStartedPromptKey(resolvedPromptKey);
    startCopy.mutate({ ...prompt, key: resolvedPromptKey, options });
  }, [jobId, localConflictStrategy, prompt, startCopy, startedPromptKey]);

  useEffect(() => {
    if (!currentJobId || currentJobStatus === "queued" || currentJobStatus === "running") return;
    invalidateCopyJobData(queryClient);
  }, [currentJobId, currentJobStatus, queryClient]);

  if (!prompt) return null;

  const displayedEvents = [...events.events].reverse();
  const needsLocalConflictResolution = Boolean(prompt.conflicts?.totalConflicts && !prompt.options?.localConflictStrategy && !localConflictStrategy && !jobId);

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="audit-dialog copy-dialog" role="dialog" aria-modal="true" aria-labelledby="copy-dialog-title">
        <div className="audit-dialog-header">
          <div className="audit-dialog-title-block">
            <h2 id="copy-dialog-title">{prompt.title}</h2>
            <p>{jobId ? `Job #${jobId} - ${prompt.description}` : prompt.description}</p>
            <JobStatusTerminateAction job={currentJob} isTerminating={terminateJob.isPending} onTerminate={setTerminatePrompt} />
          </div>
          <JobStatusHeaderActions closeLabel="Close copy window" onClose={onClose} />
        </div>

        {startCopy.error ? <p className="panel-message action-error">{startCopy.error.message}</p> : null}

        {needsLocalConflictResolution && prompt.conflicts ? (
          <CopyConflictResolution conflicts={prompt.conflicts} onKeepBoth={() => setLocalConflictStrategy("keep_both")} onReplace={() => setLocalConflictStrategy("replace")} />
        ) : (
          <CopyProgressPanel job={currentJob} pendingJobId={jobId} isStarting={startCopy.isPending} />
        )}

        <div className="audit-dialog-events">
          <JobEventsHeader label="Copy events" jobId={jobId} loaded={events.events.length} total={events.total} loading={events.isLoading} loadingOlder={events.isFetchingNextPage} />
          {jobId && events.isLoading ? <p className="panel-message">Loading copy events...</p> : null}
          {events.error ? <p className="panel-message action-error">{events.error.message}</p> : null}
          {jobId && !events.isLoading && !events.error && displayedEvents.length === 0 ? <p className="panel-message">No events yet.</p> : null}
          {!jobId && !startCopy.error && !needsLocalConflictResolution ? <p className="panel-message">Starting the copy job. Closing this window after start leaves the job running in the background.</p> : null}
          {needsLocalConflictResolution ? <p className="panel-message">Choose how to handle the existing local file before starting this copy.</p> : null}
          {displayedEvents.length > 0 ? (
            <div className="events audit-dialog-event-list">
              {displayedEvents.map((event) => (
                <CopyLogEventRow key={event.id} event={event} timeFormat={timeFormat} />
              ))}
            </div>
          ) : null}
        </div>
        <TerminateJobDialog
          job={terminatePrompt}
          error={terminateJob.error?.message}
          isPending={terminateJob.isPending}
          onClose={() => !terminateJob.isPending && setTerminatePrompt(null)}
          onConfirm={(targetJobId) => terminateJob.mutate(targetJobId)}
        />
      </section>
    </div>
  );
}

function CopyConflictResolution({
  conflicts,
  onKeepBoth,
  onReplace
}: {
  conflicts: CopyConflictPreview;
  onKeepBoth: () => void;
  onReplace: () => void;
}) {
  return (
    <div className="copy-conflict-panel">
      <div className="copy-conflict-header">
        <TriangleAlert size={18} />
        <span>
          <strong>Existing local files found</strong>
          <small>
            {formatNumber(conflicts.totalCandidates)} local file{conflicts.totalCandidates === 1 ? "" : "s"} across {formatNumber(conflicts.totalConflicts)} copy item
            {conflicts.totalConflicts === 1 ? "" : "s"}
          </small>
        </span>
      </div>
      <div className="copy-conflict-list">
        {conflicts.conflicts.map((conflict) => (
          <div key={`${conflict.linkId}:${conflict.destinationPath}`} className="copy-conflict-item">
            <strong>{conflict.itemName}</strong>
            <small>{conflict.relativePath}</small>
            <ul>
              {conflict.candidates.map((candidate) => (
                <li key={candidate.filePath}>
                  <span>{candidate.relativePath}</span>
                  <small>{formatBytes(candidate.sizeBytes)}</small>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <div className="copy-conflict-actions">
        <button type="button" className="secondary" onClick={onKeepBoth}>
          <Copy size={14} />
          Keep both
        </button>
        <button type="button" className="danger" onClick={onReplace}>
          <Trash2 size={14} />
          Replace old local files
        </button>
      </div>
      <p className="copy-conflict-note">
        Keep both preserves the listed files, but if there is only one active symlink for the item, the previous local file will become an orphan. Replace copies and verifies
        the new file first, repoints the symlink, then removes the listed old local files.
      </p>
    </div>
  );
}

function ScanStatusDialog({
  prompt,
  onClose
}: {
  prompt: ScanStatusPrompt | null;
  onClose: () => void;
}) {
  const { timeFormat } = useUserPreferences();
  const jobId = prompt?.jobId ?? null;
  const [terminatePrompt, setTerminatePrompt] = useState<JobRecord | null>(null);
  const terminateJob = useTerminateJobMutation(() => setTerminatePrompt(null));
  const jobQuery = useQuery({
    queryKey: ["job", jobId],
    queryFn: () => api.job(jobId!),
    enabled: Boolean(prompt),
    refetchInterval: 500
  });
  const currentJob = jobQuery.data ?? null;
  const jobActive = currentJob ? currentJob.status === "queued" || currentJob.status === "running" : Boolean(jobId);
  const events = useJobEventTimeline({ jobId, enabled: Boolean(prompt && jobId), refetchInterval: jobActive ? 500 : 2500, loadAll: true });

  if (!prompt) return null;

  const displayedEvents = [...events.events].reverse();

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="audit-dialog copy-dialog" role="dialog" aria-modal="true" aria-labelledby="scan-status-dialog-title">
        <div className="audit-dialog-header">
          <div className="audit-dialog-title-block">
            <h2 id="scan-status-dialog-title">{prompt.title}</h2>
            <p>{`Job #${prompt.jobId} - ${prompt.description}`}</p>
            <JobStatusTerminateAction job={currentJob} isTerminating={terminateJob.isPending} onTerminate={setTerminatePrompt} />
          </div>
          <JobStatusHeaderActions closeLabel="Close scan status window" onClose={onClose} />
        </div>

        {jobQuery.error ? <p className="panel-message action-error">{jobQuery.error.message}</p> : null}

        <ScanProgressPanel job={currentJob} pendingJobId={jobId} />

        <div className="audit-dialog-events">
          <JobEventsHeader label="Scan events" jobId={jobId} loaded={events.events.length} total={events.total} loading={events.isLoading} loadingOlder={events.isFetchingNextPage} />
          {jobId && events.isLoading ? <p className="panel-message">Loading scan events...</p> : null}
          {events.error ? <p className="panel-message action-error">{events.error.message}</p> : null}
          {jobId && !events.isLoading && !events.error && displayedEvents.length === 0 ? <p className="panel-message">No events yet.</p> : null}
          <p className="panel-message">Closing this window leaves the scan running in the background.</p>
          {displayedEvents.length > 0 ? (
            <div className="events audit-dialog-event-list">
              {displayedEvents.map((event) => (
                <LogEventRow key={event.id} event={event} timeFormat={timeFormat} job={currentJob} />
              ))}
            </div>
          ) : null}
        </div>
        <TerminateJobDialog
          job={terminatePrompt}
          error={terminateJob.error?.message}
          isPending={terminateJob.isPending}
          onClose={() => !terminateJob.isPending && setTerminatePrompt(null)}
          onConfirm={(targetJobId) => terminateJob.mutate(targetJobId)}
        />
      </section>
    </div>
  );
}

function AuditStatusDialog({
  prompt,
  onClose
}: {
  prompt: AuditStatusPrompt | null;
  onClose: () => void;
}) {
  const { timeFormat } = useUserPreferences();
  const jobId = prompt?.jobId ?? null;
  const [terminatePrompt, setTerminatePrompt] = useState<JobRecord | null>(null);
  const terminateJob = useTerminateJobMutation(() => setTerminatePrompt(null));
  const jobQuery = useQuery({
    queryKey: ["job", jobId],
    queryFn: () => api.job(jobId!),
    enabled: Boolean(prompt),
    refetchInterval: 500
  });
  const currentJob = jobQuery.data ?? null;
  const jobActive = currentJob ? currentJob.status === "queued" || currentJob.status === "running" : Boolean(jobId);
  const auditRunQuery = useQuery({
    queryKey: ["audit-run-by-job", jobId],
    queryFn: () => api.auditByJob(jobId!),
    enabled: Boolean(prompt && jobId),
    refetchInterval: jobActive ? 500 : 2500
  });
  const auditRun = auditRunQuery.data ?? null;
  const auditRunId = prompt?.auditRunId ?? auditRun?.id ?? null;
  const auditResults = useQuery({
    queryKey: ["audit-results", auditRunId],
    queryFn: () => api.auditResults(auditRunId!),
    enabled: Boolean(prompt && auditRunId),
    refetchInterval: jobActive ? 1500 : false
  });
  const events = useJobEventTimeline({ jobId, enabled: Boolean(prompt && jobId), refetchInterval: jobActive ? 500 : 2500, loadAll: true });

  if (!prompt) return null;

  const displayedEvents = [...events.events].reverse();

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="audit-dialog copy-dialog" role="dialog" aria-modal="true" aria-labelledby="audit-status-dialog-title">
        <div className="audit-dialog-header">
          <div className="audit-dialog-title-block">
            <h2 id="audit-status-dialog-title">{prompt.title}</h2>
            <p>{`Job #${prompt.jobId} - ${prompt.description}`}</p>
            <JobStatusTerminateAction job={currentJob} isTerminating={terminateJob.isPending} onTerminate={setTerminatePrompt} />
          </div>
          <JobStatusHeaderActions closeLabel="Close audit status window" onClose={onClose} />
        </div>

        {jobQuery.error ? <p className="panel-message action-error">{jobQuery.error.message}</p> : null}
        {auditRunQuery.error ? <p className="panel-message action-error">{auditRunQuery.error.message}</p> : null}
        {auditResults.error ? <p className="panel-message action-error">{auditResults.error.message}</p> : null}

        <AuditProgressPanel job={currentJob} pendingJobId={jobId} auditRun={auditRun} />

        {auditRunId && !auditResults.isLoading && !auditResults.error ? <AuditResultSummary results={auditResults.data ?? []} /> : null}

        <div className="audit-dialog-events">
          <JobEventsHeader label="Audit events" jobId={jobId} loaded={events.events.length} total={events.total} loading={events.isLoading} loadingOlder={events.isFetchingNextPage} />
          {jobId && events.isLoading ? <p className="panel-message">Loading audit events...</p> : null}
          {events.error ? <p className="panel-message action-error">{events.error.message}</p> : null}
          {jobId && !events.isLoading && !events.error && displayedEvents.length === 0 ? <p className="panel-message">No events yet.</p> : null}
          <p className="panel-message">Closing this window leaves the audit running in the background.</p>
          {displayedEvents.length > 0 ? (
            <div className="events audit-dialog-event-list">
              {displayedEvents.map((event) => (
                <LogEventRow key={event.id} event={event} timeFormat={timeFormat} job={currentJob} />
              ))}
            </div>
          ) : null}
        </div>
        <TerminateJobDialog
          job={terminatePrompt}
          error={terminateJob.error?.message}
          isPending={terminateJob.isPending}
          onClose={() => !terminateJob.isPending && setTerminatePrompt(null)}
          onConfirm={(targetJobId) => terminateJob.mutate(targetJobId)}
        />
      </section>
    </div>
  );
}

function AuditResultSummary({ results }: { results: AuditResultRecord[] }) {
  const attentionResults = results.filter((result) => result.status !== "pass");
  if (attentionResults.length === 0) return null;

  return (
    <section className="audit-result-summary" aria-label="Audit findings">
      <div className="audit-dialog-section-title">
        <TriangleAlert size={15} />
        <span>Audit findings</span>
      </div>
      <div className="audit-result-list">
        {attentionResults.map((result) => (
          <article className="audit-result-item" key={result.id}>
            <div>
              <strong>{basenameFromPath(result.targetPath)}</strong>
              <small>{result.message}</small>
            </div>
            <StatusPill value={result.status === "source_issue" ? "Source issue" : "Failed"} />
          </article>
        ))}
      </div>
    </section>
  );
}

function ScanScopeBlock({
  checked,
  children,
  detail,
  icon,
  title,
  onChange
}: {
  checked: boolean;
  children?: ReactNode;
  detail: string;
  icon: ReactNode;
  title: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <section className={checked ? "scan-scope-block selected" : "scan-scope-block"} aria-label={title}>
      <label className="scan-scope-control">
        <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
        {icon}
        <span className="scan-scope-copy">
          <strong>{title}</strong>
          <small>{detail}</small>
        </span>
      </label>
      {checked && children ? <div className="scan-scope-content">{children}</div> : null}
    </section>
  );
}

function FolderScopePicker({
  ariaLabel,
  emptyMessage,
  lastScannedBySection,
  sections,
  selectedSections,
  onToggle
}: {
  ariaLabel: string;
  emptyMessage: string;
  lastScannedBySection: Record<string, string | null>;
  sections: Array<{ section: string; title?: string | null }>;
  selectedSections: string[];
  onToggle: (section: string, checked: boolean) => void;
}) {
  if (sections.length === 0) return <p className="scan-scope-empty">{emptyMessage}</p>;

  return (
    <div className="folder-scope-grid" role="group" aria-label={ariaLabel}>
      {sections.map((section) => (
        <ScopeToggle
          key={section.section}
          checked={selectedSections.includes(section.section)}
          icon={<Folder size={15} />}
          label={sectionDisplayTitle(section)}
          detail={scanAgeLabel(lastScannedBySection[section.section] ?? null)}
          onChange={(checked) => onToggle(section.section, checked)}
        />
      ))}
    </div>
  );
}

function ScopeToggle({
  checked,
  detail,
  icon,
  label,
  onChange
}: {
  checked: boolean;
  detail?: string;
  icon: ReactNode;
  label: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className={checked ? "scope-toggle selected" : "scope-toggle"}>
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      {icon}
      <span className="scope-toggle-copy">
        <span>{label}</span>
        {detail ? <small>{detail}</small> : null}
      </span>
    </label>
  );
}

type SectionWorkKind = LinkStatusWorkKind;

type SectionWorkSelection = {
  section: string;
  kind: SectionWorkKind;
  relativePathPrefix?: string;
  scopeLabel?: string;
};

function SectionTable({
  sections,
  selectedRemoteWork,
  onRemoteWorkSelect
}: {
  sections: SectionSummary[];
  selectedRemoteWork: SectionWorkSelection | null;
  onRemoteWorkSelect: (selection: SectionWorkSelection) => void;
}) {
  const storageLocations = useStorageLocations();
  const localName = storageLocationName(storageLocations, "local");
  const remoteName = storageLocationName(storageLocations, "remote");
  return (
    <Panel title="Library Summary" icon={<Database size={18} />}>
      <table className="responsive-table library-summary-table">
        <thead>
          <tr>
            <th>Section</th>
            <th>
              <span className="summary-table-heading">
                Unassigned
                <small>{localName} + {remoteName} media</small>
              </span>
            </th>
            <th>
              <span className="summary-table-heading">
                Copy To {localName}
                <small>{remoteName} media</small>
              </span>
            </th>
            <th>
              <span className="summary-table-heading">
                Copy To {remoteName}
                <small>{localName} media</small>
              </span>
            </th>
            <th>Broken Symlinks</th>
            <th>{localName} Symlinks</th>
            <th>{remoteName} Symlinks</th>
            <th>Total Symlinks</th>
          </tr>
        </thead>
        <tbody>
          {sections.map((section) => {
            const title = sectionDisplayTitle(section);
            const policyNeeded = sectionPolicyNeededCount(section);
            const copyToLocal = section.actionableRemoteLinks;
            const copyToRemote = section.actionableLocalLinks;
            const policyUnit = sectionActionUnit(section, policyNeeded);
            const copyToLocalUnit = sectionActionUnit(section, copyToLocal);
            const copyToRemoteUnit = sectionActionUnit(section, copyToRemote);
            return (
              <tr key={section.section}>
                <td>
                  <span className="section-name-cell">
                    <strong>{title}</strong>
                    <small>{sectionCompositionParts(section).map(formatSectionCompositionPart).join(" / ")}</small>
                  </span>
                </td>
                <td>
                  {policyNeeded > 0 ? (
                    <button
                      type="button"
                      className={
                        selectedRemoteWork?.section === section.section && selectedRemoteWork.kind === "policy_needed"
                          ? "table-count-button table-count-button-warn selected"
                          : "table-count-button table-count-button-warn"
                      }
                      data-section-needs-assignment={section.section}
                      aria-label={`${title}: ${formatNumber(policyNeeded)} ${policyUnit} need a storage policy`}
                      aria-pressed={selectedRemoteWork?.section === section.section && selectedRemoteWork.kind === "policy_needed"}
                      onClick={() => onRemoteWorkSelect({ section: section.section, kind: "policy_needed" })}
                    >
                      <SummaryCount value={policyNeeded} unit={policyUnit} />
                    </button>
                  ) : (
                    <SummaryCount value={policyNeeded} unit={policyUnit} muted />
                  )}
                </td>
                <td>
                  {copyToLocal > 0 ? (
                    <button
                      type="button"
                      className={selectedRemoteWork?.section === section.section && selectedRemoteWork.kind === "copy_to_local" ? "table-count-button selected" : "table-count-button"}
                      data-section-copy-to-local={section.section}
                      aria-label={`${title}: ${formatNumber(copyToLocal)} ${copyToLocalUnit} need copy to ${localName}`}
                      aria-pressed={selectedRemoteWork?.section === section.section && selectedRemoteWork.kind === "copy_to_local"}
                      onClick={() => onRemoteWorkSelect({ section: section.section, kind: "copy_to_local" })}
                    >
                      <SummaryCount value={copyToLocal} unit={copyToLocalUnit} />
                    </button>
                  ) : (
                    <SummaryCount value={copyToLocal} unit={copyToLocalUnit} muted />
                  )}
                </td>
                <td>
                  {copyToRemote > 0 ? (
                    <button
                      type="button"
                      className={selectedRemoteWork?.section === section.section && selectedRemoteWork.kind === "copy_to_remote" ? "table-count-button selected" : "table-count-button"}
                      data-section-copy-to-remote={section.section}
                      aria-label={`${title}: ${formatNumber(copyToRemote)} ${copyToRemoteUnit} need copy to ${remoteName}`}
                      aria-pressed={selectedRemoteWork?.section === section.section && selectedRemoteWork.kind === "copy_to_remote"}
                      onClick={() => onRemoteWorkSelect({ section: section.section, kind: "copy_to_remote" })}
                    >
                      <SummaryCount value={copyToRemote} unit={copyToRemoteUnit} />
                    </button>
                  ) : (
                    <SummaryCount value={copyToRemote} unit={copyToRemoteUnit} muted />
                  )}
                </td>
                <td>{formatNumber(section.brokenLinks)}</td>
                <td>{formatNumber(section.localLinks)}</td>
                <td>{formatNumber(section.remoteLinks)}</td>
                <td>{formatNumber(section.totalLinks)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </Panel>
  );
}

function SummaryCount({ value, unit, muted = false }: { value: number; unit: string; muted?: boolean }) {
  return (
    <span className={muted ? "summary-count-cell summary-count-cell-muted" : "summary-count-cell"}>
      <strong>{formatNumber(value)}</strong>
      <small>{unit}</small>
    </span>
  );
}

function formatSectionCompositionPart(part: { value: number; unit: string }): string {
  return `${formatNumber(part.value)} ${part.unit}`;
}

const dashboardRemoteWorkLinkLimit = 250;

type ActionableEpisode = {
  episodeName: string;
  link: MediaLinkRow;
};

type ActionableSeasonGroup = {
  seasonName: string;
  episodes: ActionableEpisode[];
};

type ActionableShowGroup = {
  showName: string;
  seasonCount: number;
  episodeCount: number;
  seasons: ActionableSeasonGroup[];
};

const actionableTitleCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

function uniqueMediaTitles(links: MediaLinkRow[]): string[] {
  return [...new Set(links.map((link) => link.itemName).filter(Boolean))];
}

function uniqueTitles(titles: string[]): string[] {
  return [...new Set(titles.map((title) => title.trim()).filter(Boolean))];
}

function sourceTitleRiskForLink(link: MediaLinkRow): SourceTitleRiskResult {
  return evaluateSourceTitleRisk({ expectedTitle: link.itemName, sourcePath: link.targetPath });
}

function worstSourceTitleRisk(links: MediaLinkRow[]): SourceTitleRiskResult | null {
  const risks = links.map(sourceTitleRiskForLink);
  return risks.sort((first, second) => sourceTitleRiskRank(second.severity) - sourceTitleRiskRank(first.severity) || second.score - first.score)[0] ?? null;
}

function sourceTitleRiskRank(severity: SourceTitleRiskResult["severity"]): number {
  if (severity === "block") return 2;
  if (severity === "warn") return 1;
  return 0;
}

function riskySourceTitleCount(links: MediaLinkRow[]): number {
  return links.map(sourceTitleRiskForLink).filter((risk) => risk.severity !== "ok").length;
}

function SourceTitleRiskBadge({ risk, count }: { risk: SourceTitleRiskResult | null; count?: number }) {
  if (!risk || risk.severity === "ok") return null;
  const countLabel = count && count > 1 ? ` (${formatNumber(count)} links)` : "";
  const sourceLabel = risk.sourceParent ? `${risk.sourceParent} / ${risk.sourceName}` : risk.sourceName;

  return (
    <span className={`source-title-risk-badge ${risk.severity}`} title={`${risk.reason}${countLabel}. Expected: ${risk.expectedTitle}. Source: ${sourceLabel}.`}>
      <TriangleAlert size={13} />
      <span className="sr-only">{risk.reason}</span>
    </span>
  );
}

function BulkActionBar({
  selectedCount,
  totalCount,
  allSelected,
  onSelectAll,
  onClear,
  disabled = false,
  children
}: {
  selectedCount: number;
  totalCount: number;
  allSelected: boolean;
  onSelectAll: () => void;
  onClear: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="bulk-action-bar">
      <div className="bulk-selection-summary">
        <strong>{formatNumber(selectedCount)}</strong>
        <span>selected</span>
        <small>of {formatNumber(totalCount)} visible</small>
      </div>
      <div className="bulk-selection-actions">
        <button type="button" className="secondary future-action-button" onClick={onSelectAll} disabled={disabled || totalCount === 0 || allSelected}>
          Select all
        </button>
        <button type="button" className="secondary future-action-button" onClick={onClear} disabled={disabled || selectedCount === 0}>
          Select none
        </button>
      </div>
      <div className="future-actions bulk-primary-actions">{children}</div>
    </div>
  );
}

function RemoteWorkLinksTable({
  selection,
  sections,
  pendingTitleScopes,
  onClose,
  onAuditRequest,
  onCopyRequest,
  onRescanTitle
}: {
  selection: SectionWorkSelection | null;
  sections: SectionSummary[];
  pendingTitleScopes?: ScanTitleScope[];
  onClose: () => void;
  onAuditRequest: (prompt: AuditPrompt) => void;
  onCopyRequest: (prompt: CopyPrompt) => void;
  onRescanTitle: (section: string, itemName: string) => void;
}) {
  const queryClient = useQueryClient();
  const storageLocations = useStorageLocations();
  const localName = storageLocationName(storageLocations, "local");
  const remoteName = storageLocationName(storageLocations, "remote");
  const selectedSection = selection?.section ?? null;
  const selectedPrefix = selection?.relativePathPrefix ?? "";
  const detail = selection ? remoteWorkDetail(selection.kind, storageLocations) : null;
  const copyDirection = selection ? copyDirectionForWorkKind(selection.kind) : null;
  const selectedSummary = sections.find((section) => section.section === selectedSection);
  const selectedContentType = selectedSummary ? sectionContentType(selectedSummary) : selectedSection ? inferSectionContentType(selectedSection) : "other";
  const isShowSection = selectedContentType === "shows";
  const [expandedShows, setExpandedShows] = useState<Record<string, boolean>>({});
  const [selectedLinkIds, setSelectedLinkIds] = useState<number[]>([]);
  const [search, setSearch] = useState("");
  const trimmedSearch = search.trim();
  const remoteWorkLinks = useQuery({
    queryKey: ["dashboard-remote-work-links", selection?.kind, selectedSection, selectedPrefix, trimmedSearch],
    queryFn: () =>
      api.mediaLinksPage({
        kind: detail?.kind,
        section: selectedSection ?? "",
        storagePolicy: detail?.storagePolicy ?? "unassigned",
        relativePathPrefix: selectedPrefix,
        search: trimmedSearch,
        limit: dashboardRemoteWorkLinkLimit,
        offset: 0
    }),
    enabled: Boolean(selectedSection && detail)
  });
  const jobs = useQuery({ queryKey: ["jobs", "active"], queryFn: () => api.jobs({ activeOnly: true }), refetchInterval: 3000 });
  const invalidateWorkData = () => {
    queryClient.invalidateQueries({ queryKey: ["jobs"] });
    queryClient.invalidateQueries({ queryKey: ["audits"] });
    queryClient.invalidateQueries({ queryKey: ["storage-policies"] });
    queryClient.invalidateQueries({ queryKey: ["dashboard-remote-work-links"] });
    queryClient.invalidateQueries({ queryKey: ["media-links"] });
    queryClient.invalidateQueries({ queryKey: ["media-links-page"] });
    queryClient.invalidateQueries({ queryKey: ["media-link-tree"] });
    queryClient.invalidateQueries({ queryKey: ["sections"] });
    queryClient.invalidateQueries({ queryKey: ["inventory-summary"] });
  };
  const updatePolicy = useMutation({
    mutationFn: ({ titles, policy }: { titles: string[]; policy: StoragePolicyKind }) => api.setStoragePolicies({ titles, policy }),
    onSuccess: () => {
      setSelectedLinkIds([]);
      invalidateWorkData();
    }
  });

  useEffect(() => {
    setExpandedShows({});
    setSearch("");
    setSelectedLinkIds([]);
  }, [selection?.kind, selectedSection, selectedPrefix]);

  const rows = (remoteWorkLinks.data?.rows ?? []).filter((row) => row.isMedia && (row.kind === "remote" || row.kind === "local"));
  const activeJobByLinkId = useMemo(() => {
    const activeJobs = (jobs.data ?? []).filter(isActiveQueueJob);
    return new Map(rows.map((row) => [row.id, activeJobForLink(row, activeJobs)] as const).filter((entry): entry is readonly [number, JobRecord] => Boolean(entry[1])));
  }, [jobs.data, rows]);
  const selectableRows = rows.filter((row) => !activeJobByLinkId.has(row.id) && !titleScopeIsPending(pendingTitleScopes, row.section, row.itemName));
  const visibleLinkIds = rows.map((row) => row.id);
  const selectableLinkIds = selectableRows.map((row) => row.id);
  const selectableLinkIdKey = selectableLinkIds.join(",");
  useEffect(() => {
    const selectableIds = new Set(selectableLinkIdKey ? selectableLinkIdKey.split(",").map(Number) : []);
    setSelectedLinkIds((current) => current.filter((id) => selectableIds.has(id)));
  }, [selectableLinkIdKey]);

  if (!selection || !selectedSection || !detail) return null;

  const sectionTitle = selectedSummary ? sectionDisplayTitle(selectedSummary) : selectedSection;
  const title = selection.scopeLabel ? `${sectionTitle} / ${selection.scopeLabel}` : sectionTitle;
  const showGroups = isShowSection ? groupActionableShows(rows) : [];
  const copyLabel = selectedContentType === "movies" ? "Movie" : "Episode";
  const shownTotal = remoteWorkLinks.data?.total ?? rows.length;
  const copyDestinationLabel = copyDirection === "to_remote" ? remoteName : localName;
  const canCopy = Boolean(copyDirection && selectedSection);
  const canChangeRowPolicy = selectedContentType === "movies";
  const policyButtonState = policyButtonsForWorkKind(selection.kind);
  const actionPending = updatePolicy.isPending;
  const pendingPolicy = actionPending ? updatePolicy.variables?.policy ?? null : null;
  const pendingTitleCount = actionPending ? updatePolicy.variables?.titles.length ?? 0 : 0;
  const pendingPolicyText = pendingPolicy ? storagePolicyActionText(pendingPolicy, storageLocations) : "";
  const selectedLinkIdSet = new Set(selectedLinkIds);
  const selectedLinks = selectableRows.filter((row) => selectedLinkIdSet.has(row.id));
  const selectedTitles = uniqueMediaTitles(selectedLinks);
  const allVisibleSelected = selectableLinkIds.length > 0 && selectableLinkIds.every((id) => selectedLinkIdSet.has(id));
  const activeVisibleJobCount = activeJobsForLinks(rows, activeJobByLinkId).length;
  const activeVisibleLinkCount = rows.length - selectableRows.length;

  function queueCopy(title: string, description: string, options: CopyOptions) {
    onCopyRequest({ key: copyPromptKey(options), title, description, options, autoStart: true });
  }

  function queueAudit(title: string, description: string, options: Omit<AuditOptions, "mode">) {
    onAuditRequest({ title, description, options });
  }

  function queuePolicy(title: string, policy: StoragePolicyKind) {
    updatePolicy.mutate({ titles: [title], policy });
  }

  function queueSelectedCopy() {
    if (!copyDirection || selectedLinks.length === 0) return;
    queueCopy(`Copy ${formatNumber(selectedLinks.length)} selected to ${copyDestinationLabel}`, `${title} / selected links`, { direction: copyDirection, linkIds: selectedLinks.map((link) => link.id) });
  }

  function queueSelectedAudit() {
    if (selectedLinks.length === 0) return;
    queueAudit(`Audit ${formatNumber(selectedLinks.length)} selected`, `${title} / selected links`, { linkIds: selectedLinks.map((link) => link.id) });
  }

  function queueSelectedPolicy(policy: StoragePolicyKind) {
    if (selectedTitles.length === 0) return;
    updatePolicy.mutate({ titles: selectedTitles, policy });
  }

  function toggleLinkSelection(id: number, checked: boolean) {
    setSelectedLinkIds((current) => {
      if (checked) return current.includes(id) ? current : [...current, id];
      return current.filter((currentId) => currentId !== id);
    });
  }

  function setLinksSelected(links: MediaLinkRow[], checked: boolean) {
    const ids = links.map((link) => link.id);
    setSelectedLinkIds((current) => {
      const next = new Set(current);
      for (const id of ids) {
        if (checked) next.add(id);
        else next.delete(id);
      }
      return [...next];
    });
  }

  function linksSelected(links: MediaLinkRow[]): boolean {
    return links.length > 0 && links.every((link) => selectedLinkIdSet.has(link.id));
  }

  function showLinks(show: ActionableShowGroup): MediaLinkRow[] {
    return show.seasons.flatMap((season) => season.episodes.map((episode) => episode.link));
  }

  function seasonLinks(season: ActionableSeasonGroup): MediaLinkRow[] {
    return season.episodes.map((episode) => episode.link);
  }

  function queueSectionCopy() {
    if (!copyDirection || !selectedSection) return;
    queueCopy(`Copy ${title} to ${copyDestinationLabel}`, `All matching media in ${title}`, { direction: copyDirection, section: selectedSection, ...(selectedPrefix ? { relativePathPrefix: selectedPrefix } : {}) });
  }

  function queueShowCopy(show: ActionableShowGroup) {
    if (!copyDirection) return;
    const links = showLinks(show);
    if (links.length === 0) return;
    queueCopy(`Copy ${show.showName} to ${copyDestinationLabel}`, `${title} / ${show.showName}`, { direction: copyDirection, linkIds: links.map((link) => link.id) });
  }

  function queueSeasonCopy(showName: string, season: ActionableSeasonGroup) {
    if (!copyDirection) return;
    const links = seasonLinks(season);
    if (links.length === 0) return;
    queueCopy(`Copy ${showName} / ${season.seasonName} to ${copyDestinationLabel}`, `${title} / ${showName} / ${season.seasonName}`, { direction: copyDirection, linkIds: links.map((link) => link.id) });
  }

  function queueLinkCopy(link: MediaLinkRow) {
    if (!copyDirection) return;
    queueCopy(`Copy ${link.itemName} to ${copyDestinationLabel}`, "1 selected link", { direction: copyDirection, linkIds: [link.id] });
  }

  function queueTitleAudit(itemName: string) {
    if (!selectedSection) return;
    queueAudit(`Audit ${itemName}`, `${title} / ${itemName}`, { section: selectedSection, itemName, ...(selectedPrefix ? { relativePathPrefix: selectedPrefix } : {}) });
  }

  function queueSeasonAudit(showName: string, season: ActionableSeasonGroup) {
    if (!selectedSection) return;
    const prefix = seasonRelativePrefix(season);
    queueAudit(`Audit ${showName} / ${season.seasonName}`, `${title} / ${showName} / ${season.seasonName}`, {
      section: selectedSection,
      itemName: showName,
      ...(prefix ? { relativePathPrefix: prefix } : {})
    });
  }

  function queueLinkAudit(link: MediaLinkRow) {
    queueAudit(`Audit ${link.itemName}`, link.relativePath ? `${title} / ${link.relativePath}` : title, { linkIds: [link.id] });
  }

  return (
    <Panel
      title={`${detail.title} - ${title}`}
      icon={<ListChecks size={18} />}
      actions={
        <button type="button" className="icon-button" title="Close list" aria-label="Close work list" onClick={onClose}>
          <X size={16} />
        </button>
      }
    >
      <div className="actionable-panel-body">
        <div className="actionable-panel-meta">
          <span>
            {detail.descriptionPrefix} <strong>{title}</strong>. {detail.descriptionSuffix}
          </span>
          <div className="actionable-panel-tools">
            <label className="work-search">
              <Search size={14} />
              <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search work" />
            </label>
            {remoteWorkLinks.data ? (
              <small>
                {isShowSection
                  ? `Showing ${formatNumber(rows.length)} links across ${formatNumber(showGroups.length)} shows of ${formatNumber(shownTotal)}`
                  : `Showing ${formatNumber(rows.length)} of ${formatNumber(shownTotal)}`}
              </small>
            ) : null}
            {canCopy ? (
              <button type="button" className="secondary future-action-button" onClick={queueSectionCopy} disabled={actionPending || shownTotal === 0 || activeVisibleJobCount > 0}>
                <Copy size={14} />
                Copy all to {copyDestinationLabel}
              </button>
            ) : null}
          </div>
        </div>
        {rows.length > 0 ? (
          <BulkActionBar
            selectedCount={selectedLinks.length}
            totalCount={visibleLinkIds.length}
            allSelected={allVisibleSelected}
            onSelectAll={() => setLinksSelected(selectableRows, true)}
            onClear={() => setSelectedLinkIds([])}
            disabled={actionPending}
          >
            {canCopy ? (
              <button type="button" className="secondary future-action-button" onClick={queueSelectedCopy} disabled={actionPending || selectedLinks.length === 0}>
                <Copy size={14} />
                Copy selected to {copyDestinationLabel}
              </button>
            ) : null}
            {policyButtonState.assignLocal ? (
              <button type="button" className="secondary future-action-button" onClick={() => queueSelectedPolicy("location_1")} disabled={actionPending || selectedTitles.length === 0}>
                <HardDrive size={14} />
                {pendingPolicy === "location_1" ? `Assigning ${formatNumber(pendingTitleCount)} title${pendingTitleCount === 1 ? "" : "s"} to ${localName}...` : `Assign selected titles to ${localName}`}
              </button>
            ) : null}
            {policyButtonState.assignRemote ? (
              <button type="button" className="secondary future-action-button" onClick={() => queueSelectedPolicy("location_2")} disabled={actionPending || selectedTitles.length === 0}>
                <HardDriveDownload size={14} />
                {pendingPolicy === "location_2" ? `Assigning ${formatNumber(pendingTitleCount)} title${pendingTitleCount === 1 ? "" : "s"} to ${remoteName}...` : `Assign selected titles to ${remoteName}`}
              </button>
            ) : null}
            <button type="button" className="secondary future-action-button" onClick={queueSelectedAudit} disabled={actionPending || selectedLinks.length === 0}>
              <Activity size={14} />
              Audit selected
            </button>
          </BulkActionBar>
        ) : null}
        {updatePolicy.isPending && pendingPolicy ? (
          <p className="panel-message action-progress">
            <RefreshCw className="spin-icon" size={14} />
            Assigning {formatNumber(pendingTitleCount)} title{pendingTitleCount === 1 ? "" : "s"} to {pendingPolicyText}. Large libraries can take a moment.
          </p>
        ) : null}
        {activeVisibleLinkCount > 0 ? (
          <p className="panel-message job-lock-panel">
            {formatNumber(activeVisibleLinkCount)} visible item{activeVisibleLinkCount === 1 ? "" : "s"} already {activeVisibleLinkCount === 1 ? "has" : "have"} an active job.
            Wait for completion or terminate the job before issuing more actions.
          </p>
        ) : null}
        {updatePolicy.error ? <p className="panel-message action-error">{updatePolicy.error.message}</p> : null}
        {updatePolicy.data ? <p className="panel-message">{formatNumber(updatePolicy.data.updated)} title{updatePolicy.data.updated === 1 ? "" : "s"} assigned to {storagePolicyLabel(updatePolicy.data.policy, storageLocations)}.</p> : null}
        {remoteWorkLinks.isLoading ? (
          <p className="panel-message">Loading {detail.emptyName} symlinks...</p>
        ) : remoteWorkLinks.error ? (
          <p className="panel-message action-error">{remoteWorkLinks.error.message}</p>
        ) : rows.length === 0 ? (
          <p className="panel-message">No {detail.emptyName} symlinks found for this section.</p>
        ) : isShowSection ? (
          <div className="actionable-show-list">
            {showGroups.map((show) => {
              const expanded = Boolean(expandedShows[show.showName]);
              const links = showLinks(show);
              const showActiveJobs = activeJobsForLinks(links, activeJobByLinkId);
              const rescanPending = titleScopeIsPending(pendingTitleScopes, selectedSection, show.showName);
              const sourceRisk = worstSourceTitleRisk(links);
              const sourceRiskCount = riskySourceTitleCount(links);
              return (
                <article key={show.showName} className="actionable-show-group">
                  <div className="actionable-show-row">
                    <label className="bulk-row-select">
                      <input
                        type="checkbox"
                        checked={linksSelected(links)}
                        onChange={(event) => setLinksSelected(links.filter((link) => !activeJobByLinkId.has(link.id)), event.target.checked)}
                        disabled={actionPending || rescanPending || showActiveJobs.length > 0}
                      />
                      <span className="sr-only">Select all links for {show.showName}</span>
                    </label>
                    <button
                      type="button"
                      className="actionable-show-toggle"
                      aria-expanded={expanded}
                      onClick={() => setExpandedShows((current) => ({ ...current, [show.showName]: !current[show.showName] }))}
                    >
                      <span className="actionable-show-title">
                        <ChevronRight size={16} />
                        <strong>{show.showName}</strong>
                        <SourceTitleRiskBadge risk={sourceRisk} count={sourceRiskCount} />
                      </span>
                    </button>
                    {showActiveJobs.length > 0 ? <JobLockBadge jobs={showActiveJobs} className="actionable-show-lock" /> : null}
                    <span className="actionable-show-counts">
                      <span>
                        <strong>{formatNumber(show.seasonCount)}</strong>
                        <small>Seasons</small>
                      </span>
                      <span>
                        <strong>{formatNumber(show.episodeCount)}</strong>
                        <small>Episodes</small>
                      </span>
                    </span>
                    <FutureTitleActions
                      mode={selection.kind}
                      label="Show"
                      itemName={show.showName}
                      destination={copyDestinationLabel}
                      isPending={actionPending || rescanPending}
                      activeJobs={showActiveJobs}
                      hideNotice
                      onCopy={() => queueShowCopy(show)}
                      onAudit={() => queueTitleAudit(show.showName)}
                      onRescan={() => onRescanTitle(selectedSection, show.showName)}
                      rescanPending={rescanPending}
                      onAssignLocal={policyButtonState.assignLocal ? () => queuePolicy(show.showName, "location_1") : undefined}
                      onAssignRemote={policyButtonState.assignRemote ? () => queuePolicy(show.showName, "location_2") : undefined}
                    />
                  </div>
                  {expanded ? (
                    <div className="actionable-season-list">
                      {show.seasons.map((season) => {
                        const links = seasonLinks(season);
                        const seasonActiveJobs = activeJobsForLinks(links, activeJobByLinkId);
                        return (
                          <section key={season.seasonName} className="actionable-season-group">
                            <div className="actionable-season-header">
                              <label className="bulk-row-select">
                                <input
                                  type="checkbox"
                                  checked={linksSelected(links)}
                                  onChange={(event) => setLinksSelected(links.filter((link) => !activeJobByLinkId.has(link.id)), event.target.checked)}
                                  disabled={actionPending || rescanPending || seasonActiveJobs.length > 0}
                                />
                                <span className="sr-only">Select all links for {show.showName} / {season.seasonName}</span>
                              </label>
                              <span>
                                <strong>{season.seasonName}</strong>
                                <small>{formatNumber(season.episodes.length)} episodes</small>
                              </span>
                              <FutureTitleActions
                                mode={selection.kind}
                                label="Season"
                                destination={copyDestinationLabel}
                                isPending={actionPending}
                                activeJobs={seasonActiveJobs}
                                onCopy={() => queueSeasonCopy(show.showName, season)}
                                onAudit={() => queueSeasonAudit(show.showName, season)}
                              />
                            </div>
                            <div className="actionable-episode-list">
                              {season.episodes.map((episode) => {
                                const sourceRisk = sourceTitleRiskForLink(episode.link);
                                return (
                                  <div key={episode.link.id} className="actionable-episode-row">
                                    <label className="bulk-row-select">
                                      <input
                                        type="checkbox"
                                        checked={selectedLinkIdSet.has(episode.link.id)}
                                        onChange={(event) => toggleLinkSelection(episode.link.id, event.target.checked)}
                                        disabled={actionPending || rescanPending || activeJobByLinkId.has(episode.link.id)}
                                      />
                                      <span className="sr-only">Select {episode.episodeName}</span>
                                    </label>
                                    <span className="actionable-episode-name">
                                      <FileText size={15} />
                                      <span className="actionable-title-text">{episode.episodeName}</span>
                                      <SourceTitleRiskBadge risk={sourceRisk} />
                                    </span>
                                    <FutureActions
                                      link={episode.link}
                                      mode={selection.kind}
                                      copyLabel={copyLabel}
                                      destination={copyDestinationLabel}
                                      isPending={actionPending}
                                      activeJob={activeJobByLinkId.get(episode.link.id) ?? null}
                                      onCopy={() => queueLinkCopy(episode.link)}
                                      onAudit={() => queueLinkAudit(episode.link)}
                                    />
                                  </div>
                                );
                              })}
                            </div>
                          </section>
                        );
                      })}
                    </div>
                  ) : null}
                </article>
              );
            })}
          </div>
        ) : (
          <table className="responsive-table actionable-links-table">
            <thead>
              <tr>
                <th>
                  <span className="sr-only">Select</span>
                </th>
                <th>Title</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((link) => {
                const sourceRisk = sourceTitleRiskForLink(link);
                const rescanPending = titleScopeIsPending(pendingTitleScopes, selectedSection, link.itemName);
                return (
                  <tr key={link.id}>
                    <td>
                      <label className="bulk-row-select">
                        <input
                          type="checkbox"
                          checked={selectedLinkIdSet.has(link.id)}
                          onChange={(event) => toggleLinkSelection(link.id, event.target.checked)}
                          disabled={actionPending || rescanPending || activeJobByLinkId.has(link.id)}
                        />
                        <span className="sr-only">Select {link.itemName}</span>
                      </label>
                    </td>
                    <td>
                      <span className="actionable-title-with-risk">
                        <strong className="actionable-title-text">{link.itemName}</strong>
                        <SourceTitleRiskBadge risk={sourceRisk} />
                      </span>
                    </td>
                    <td>
                      <FutureActions
                        link={link}
                        mode={selection.kind}
                        copyLabel={copyLabel}
                        destination={copyDestinationLabel}
                        isPending={actionPending || rescanPending}
                        activeJob={activeJobByLinkId.get(link.id) ?? null}
                        onCopy={() => queueLinkCopy(link)}
                        onAudit={() => queueLinkAudit(link)}
                        onRescan={() => onRescanTitle(selectedSection, link.itemName)}
                        rescanPending={rescanPending}
                        onAssignLocal={canChangeRowPolicy && policyButtonState.assignLocal ? () => queuePolicy(link.itemName, "location_1") : undefined}
                        onAssignRemote={canChangeRowPolicy && policyButtonState.assignRemote ? () => queuePolicy(link.itemName, "location_2") : undefined}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </Panel>
  );
}

function copyDirectionForWorkKind(kind: SectionWorkKind): CopyDirection | null {
  if (kind === "copy_to_local") return "to_local";
  if (kind === "copy_to_remote") return "to_remote";
  return null;
}

function policyButtonsForWorkKind(kind: SectionWorkKind): { assignLocal: boolean; assignRemote: boolean } {
  if (kind === "copy_to_local") return { assignLocal: false, assignRemote: true };
  if (kind === "copy_to_remote") return { assignLocal: true, assignRemote: false };
  return { assignLocal: true, assignRemote: true };
}

function seasonRelativePrefix(season: ActionableSeasonGroup): string | null {
  const firstLink = season.episodes[0]?.link;
  if (!firstLink) return null;
  const parts = splitMediaRelativePath(firstLink.relativePath);
  if (parts.length < 2) return null;
  return parts.slice(0, 2).join("/");
}

function remoteWorkDetail(kind: SectionWorkKind, storageLocations: StorageLocationsSettings): {
  title: string;
  emptyName: string;
  kind?: MediaLinkRow["kind"];
  storagePolicy: StoragePolicyKind;
  descriptionPrefix: string;
  descriptionSuffix: string;
} {
  const localName = storageLocationName(storageLocations, "local");
  const remoteName = storageLocationName(storageLocations, "remote");
  if (kind === "policy_needed") {
    return {
      title: "Unassigned",
      emptyName: "policy-needed",
      storagePolicy: "unassigned",
      descriptionPrefix: `${localName} and ${remoteName} media items without a storage policy for`,
      descriptionSuffix: `Assign a destination policy from Storage Policies before copying.`
    };
  }

  if (kind === "copy_to_remote") {
    return {
      title: `Copy To ${remoteName}`,
      emptyName: "copy-to-remote",
      kind: "local",
      storagePolicy: "location_2",
      descriptionPrefix: `${localName} media items assigned to ${remoteName} storage for`,
      descriptionSuffix: "Copy actions will verify the file before repointing symlinks."
    };
  }

  return {
    title: `Copy To ${localName}`,
    emptyName: "copy-to-local",
    kind: "remote",
    storagePolicy: "location_1",
    descriptionPrefix: `${remoteName} media items assigned to ${localName} storage for`,
    descriptionSuffix: "Copy actions will verify the file before repointing symlinks."
  };
}

function groupActionableShows(rows: MediaLinkRow[]): ActionableShowGroup[] {
  const showMap = new Map<string, Map<string, ActionableEpisode[]>>();

  for (const row of rows) {
    const parts = splitMediaRelativePath(row.relativePath);
    const showName = row.itemName || parts[0] || "Unknown show";
    const seasonName = parts.length >= 3 ? parts[1] : "No season folder";
    const episodeName = parts.at(-1) ?? row.itemName;
    const seasonMap = showMap.get(showName) ?? new Map<string, ActionableEpisode[]>();
    const episodes = seasonMap.get(seasonName) ?? [];

    episodes.push({ episodeName, link: row });
    seasonMap.set(seasonName, episodes);
    showMap.set(showName, seasonMap);
  }

  return Array.from(showMap.entries())
    .map(([showName, seasonMap]) => {
      const seasons = Array.from(seasonMap.entries())
        .map(([seasonName, episodes]) => ({
          seasonName,
          episodes: episodes.sort((first, second) => actionableTitleCollator.compare(first.episodeName, second.episodeName))
        }))
        .sort((first, second) => actionableTitleCollator.compare(first.seasonName, second.seasonName));
      return {
        showName,
        seasonCount: seasons.length,
        episodeCount: seasons.reduce((total, season) => total + season.episodes.length, 0),
        seasons
      };
    })
    .sort((first, second) => actionableTitleCollator.compare(first.showName, second.showName));
}

function splitMediaRelativePath(relativePath: string): string[] {
  return relativePath.replace(/\\/g, "/").split("/").filter(Boolean);
}

interface TitleRescanTooltipPosition {
  left: number;
  placement: "above" | "below";
  top: number;
}

function titleRescanTooltipPosition(button: HTMLButtonElement): TitleRescanTooltipPosition {
  const rect = button.getBoundingClientRect();
  const viewportPadding = 8;
  const tooltipGap = 7;
  const tooltipWidth = Math.min(260, window.innerWidth - viewportPadding * 2);
  const left = Math.max(viewportPadding, Math.min(rect.right - tooltipWidth, window.innerWidth - tooltipWidth - viewportPadding));
  const placement = rect.top >= 72 ? "above" : "below";
  return {
    left,
    placement,
    top: placement === "above" ? rect.top - tooltipGap : rect.bottom + tooltipGap
  };
}

function RescanTitleButton({ itemName, disabled, pending = false, onClick }: { itemName: string; disabled: boolean; pending?: boolean; onClick: () => void }) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const tooltipId = useId();
  const [tooltipPosition, setTooltipPosition] = useState<TitleRescanTooltipPosition | null>(null);
  const tooltipVisible = tooltipPosition !== null;

  useEffect(() => {
    if (!tooltipVisible) return;
    const updatePosition = () => {
      if (buttonRef.current) setTooltipPosition(titleRescanTooltipPosition(buttonRef.current));
    };
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [tooltipVisible]);

  const showTooltip = () => {
    if (buttonRef.current) setTooltipPosition(titleRescanTooltipPosition(buttonRef.current));
  };

  return (
    <span
      className="title-rescan-tooltip"
      onMouseEnter={showTooltip}
      onMouseLeave={() => {
        if (buttonRef.current !== document.activeElement) setTooltipPosition(null);
      }}
    >
      <button
        ref={buttonRef}
        type="button"
        className="icon-button title-rescan-button"
        aria-describedby={tooltipVisible ? tooltipId : undefined}
        aria-label={`Rescan ${itemName}`}
        disabled={disabled}
        onBlur={() => setTooltipPosition(null)}
        onClick={onClick}
        onFocus={showTooltip}
      >
        <RefreshCw className={pending ? "spin-icon" : undefined} size={15} />
      </button>
      {tooltipPosition
        ? createPortal(
            <span
              id={tooltipId}
              className={`title-rescan-tooltip-panel title-rescan-tooltip-panel-${tooltipPosition.placement}`}
              role="tooltip"
              style={{ left: tooltipPosition.left, top: tooltipPosition.top }}
            >
              Rescan this title's symlinks and reconcile replacements without scanning the full folder.
            </span>,
            document.body
          )
        : null}
    </span>
  );
}

function FutureTitleActions({
  mode,
  label,
  itemName,
  destination,
  isPending,
  activeJobs,
  hideNotice = false,
  onCopy,
  onAudit,
  onRescan,
  rescanPending = false,
  onAssignLocal,
  onAssignRemote
}: {
  mode: SectionWorkKind;
  label: "Show" | "Season";
  itemName?: string;
  destination: string;
  isPending: boolean;
  activeJobs?: JobRecord[];
  hideNotice?: boolean;
  onCopy: () => void;
  onAudit: () => void;
  onRescan?: () => void;
  rescanPending?: boolean;
  onAssignLocal?: () => void;
  onAssignRemote?: () => void;
}) {
  const storageLocations = useStorageLocations();
  const localName = storageLocationName(storageLocations, "local");
  const remoteName = storageLocationName(storageLocations, "remote");
  const activeJobCount = activeJobs?.length ?? 0;
  const disabled = isPending || activeJobCount > 0;
  const notice = activeJobNotice(activeJobs ?? []);
  const showNotice = Boolean(notice && !hideNotice);
  return (
    <div className={`future-actions${showNotice ? " has-job-lock" : ""}`}>
      {showNotice ? <JobLockBadge jobs={activeJobs ?? []} /> : null}
      <span className="future-action-buttons">
        {onRescan ? <RescanTitleButton itemName={itemName ?? label} disabled={disabled} pending={rescanPending} onClick={onRescan} /> : null}
        {mode !== "policy_needed" ? (
          <button type="button" className="secondary future-action-button" onClick={onCopy} disabled={disabled}>
            <Copy size={14} />
            Copy {label} to {destination}
          </button>
        ) : null}
        {onAssignLocal ? (
          <button type="button" className="secondary future-action-button" onClick={onAssignLocal} disabled={disabled}>
            <HardDrive size={14} />
            Assign {localName}
          </button>
        ) : null}
        {onAssignRemote ? (
          <button type="button" className="secondary future-action-button" onClick={onAssignRemote} disabled={disabled}>
            <Shield size={14} />
            Assign {remoteName}
          </button>
        ) : null}
        <button type="button" className="secondary future-action-button" onClick={onAudit} disabled={disabled}>
          <Activity size={14} />
          Audit
        </button>
      </span>
    </div>
  );
}

function FutureActions({
  link,
  mode,
  copyLabel = "Episode",
  destination,
  isPending,
  activeJob,
  onCopy,
  onAudit,
  onRescan,
  rescanPending = false,
  onAssignLocal,
  onAssignRemote
}: {
  link: MediaLinkRow;
  mode: SectionWorkKind;
  copyLabel?: "Episode" | "Movie";
  destination: string;
  isPending: boolean;
  activeJob?: JobRecord | null;
  onCopy: () => void;
  onAudit: () => void;
  onRescan?: () => void;
  rescanPending?: boolean;
  onAssignLocal?: () => void;
  onAssignRemote?: () => void;
}) {
  const storageLocations = useStorageLocations();
  const localName = storageLocationName(storageLocations, "local");
  const remoteName = storageLocationName(storageLocations, "remote");
  const disabled = isPending || Boolean(activeJob);
  const notice = activeJob ? activeJobNotice([activeJob]) : null;
  return (
    <div className={`future-actions${notice ? " has-job-lock" : ""}`} aria-label={`Future actions for ${link.itemName}`}>
      {activeJob ? <JobLockBadge jobs={[activeJob]} /> : null}
      <span className="future-action-buttons">
        {onRescan ? <RescanTitleButton itemName={link.itemName} disabled={disabled} pending={rescanPending} onClick={onRescan} /> : null}
        {mode !== "policy_needed" ? (
          <button type="button" className="secondary future-action-button" onClick={onCopy} disabled={disabled}>
            <Copy size={14} />
            Copy {copyLabel} to {destination}
          </button>
        ) : null}
        {onAssignLocal ? (
          <button type="button" className="secondary future-action-button" onClick={onAssignLocal} disabled={disabled}>
            <HardDrive size={14} />
            Assign {localName}
          </button>
        ) : null}
        {onAssignRemote ? (
          <button type="button" className="secondary future-action-button" onClick={onAssignRemote} disabled={disabled}>
            <Shield size={14} />
            Assign {remoteName}
          </button>
        ) : null}
        <button type="button" className="secondary future-action-button" onClick={onAudit} disabled={disabled}>
          <Activity size={14} />
          Audit
        </button>
      </span>
    </div>
  );
}

function activeJobLockLabel(jobs: JobRecord[]): string | null {
  if (jobs.length === 0) return null;
  if (jobs.length === 1) {
    const job = jobs[0];
    return `Job #${job.id} ${job.status}`;
  }
  return `${jobs.length.toLocaleString()} active jobs`;
}

function JobLockBadge({ jobs, className = "" }: { jobs: JobRecord[]; className?: string }) {
  const detail = activeJobNotice(jobs);
  const label = activeJobLockLabel(jobs);
  if (!detail || !label) return null;
  return (
    <span className={`job-lock-message${className ? ` ${className}` : ""}`} title={detail} aria-label={detail}>
      <TriangleAlert size={13} />
      <span>{label}</span>
    </span>
  );
}

type LibraryView = "overview" | "links" | "local" | "remote" | "local-orphans" | "remote-orphans" | "policies";

function LibraryPage() {
  const queryClient = useQueryClient();
  const { autoOpenTaskStatus } = useUserPreferences();
  const storageLocations = useStorageLocations();
  const localName = storageLocationName(storageLocations, "local");
  const remoteName = storageLocationName(storageLocations, "remote");
  const [view, setView] = useState<LibraryView>("overview");
  const [kind, setKind] = useState<SymlinkKindFilter>("all");
  const [selectedSection, setSelectedSection] = useState<string | null>(null);
  const [selectedLibraryWork, setSelectedLibraryWork] = useState<SectionWorkSelection | null>(null);
  const [auditPrompt, setAuditPrompt] = useState<AuditPrompt | null>(null);
  const [copyPrompt, setCopyPrompt] = useState<CopyPrompt | null>(null);
  const [scanStatusPrompt, setScanStatusPrompt] = useState<ScanStatusPrompt | null>(null);
  const [treePrefix, setTreePrefix] = useState("");
  const [storagePrefix, setStoragePrefix] = useState("");
  const [policySearch, setPolicySearch] = useState("");
  const [policyFilter, setPolicyFilter] = useState<StoragePolicyKind>("unassigned");
  const isStorageView = view === "local" || view === "remote" || view === "local-orphans" || view === "remote-orphans";
  const storageRoot: StorageRootType = view === "local" || view === "local-orphans" ? "local" : "remote";
  const orphanOnly = view === "local-orphans" || view === "remote-orphans";
  const overview = useQuery({ queryKey: ["inventory-summary"], queryFn: api.inventorySummary, enabled: view === "overview" });
  const sectionSummaries = useQuery({ queryKey: ["sections"], queryFn: api.sections, refetchInterval: 5000 });
  const sectionSettings = useQuery({ queryKey: ["section-settings"], queryFn: api.getSections });
  const symlinkTree = useQuery({
    queryKey: ["media-link-tree", selectedSection, treePrefix, kind],
    queryFn: () =>
      api.mediaLinkTree({
        section: selectedSection ?? "",
        prefix: treePrefix,
        kind: kind === "all" ? undefined : kind
    }),
    enabled: view === "links" && Boolean(selectedSection)
  });
  const storageTree = useQuery({
    queryKey: ["storage-file-tree", storageRoot, orphanOnly, storagePrefix],
    queryFn: () => api.storageFileTree({ rootType: storageRoot, orphan: orphanOnly, prefix: storagePrefix }),
    enabled: isStorageView
  });
  const storagePolicies = useQuery({
    queryKey: ["storage-policies", policyFilter],
    queryFn: () => api.storagePolicies(policyFilter),
    enabled: view === "policies"
  });
  const jobs = useQuery({ queryKey: ["jobs", "active"], queryFn: () => api.jobs({ activeOnly: true }), enabled: view === "policies", refetchInterval: 3000 });
  const invalidateInventory = () => {
    queryClient.invalidateQueries({ queryKey: ["storage-policies"] });
    queryClient.invalidateQueries({ queryKey: ["dashboard-remote-work-links"] });
    queryClient.invalidateQueries({ queryKey: ["media-links"] });
    queryClient.invalidateQueries({ queryKey: ["media-links-page"] });
    queryClient.invalidateQueries({ queryKey: ["media-link-tree"] });
    queryClient.invalidateQueries({ queryKey: ["storage-files"] });
    queryClient.invalidateQueries({ queryKey: ["storage-file-tree"] });
    queryClient.invalidateQueries({ queryKey: ["sections"] });
    queryClient.invalidateQueries({ queryKey: ["inventory-summary"] });
  };
  const setPolicy = useMutation({
    mutationFn: ({ titles, policy }: { titles: string[]; policy: StoragePolicyKind }) => api.setStoragePolicies({ titles, policy }),
    onSuccess: invalidateInventory
  });
  const removePolicy = useMutation({
    mutationFn: api.deleteStoragePolicy,
    onSuccess: invalidateInventory
  });
  const orderedSectionSummaries = orderSectionSummaries(sectionSummaries.data ?? [], sectionSettings.data?.sections);
  const availableScanSections = orderedSectionSummaries.map((section) => ({ section: section.section, title: section.title }));
  const startTitleScan = useMutation({
    mutationFn: (options: ScanOptions) => api.startScan(options),
    onSuccess: async (result, options) => {
      invalidateInventory();
      queryClient.invalidateQueries({ queryKey: ["scans"] });
      queryClient.invalidateQueries({ queryKey: ["inventory-scan-timestamps"] });
      await queryClient.refetchQueries({ queryKey: ["jobs"] });
      if (autoOpenTaskStatus) {
        setScanStatusPrompt({
          key: `scan-job-${result.jobId}`,
          title: "Title rescan",
          description: formatScanScope(options, availableScanSections),
          jobId: result.jobId
        });
      }
    }
  });

  const startCopySilently = useStartCopyJob();
  const copyConflictCheck = useMutation({
    mutationFn: (prompt: CopyPrompt) => {
      if (!prompt.options) throw new Error("Copy options are missing");
      return api.copyConflicts(prompt.options);
    },
    onSuccess: (conflicts, prompt) => {
      if (conflicts.totalConflicts > 0) {
        setCopyPrompt({ ...prompt, conflicts });
        return;
      }
      if (!autoOpenTaskStatus && prompt.autoStart) {
        startCopySilently.mutate(prompt);
        return;
      }
      setCopyPrompt(prompt);
    }
  });

  function handleCopyRequest(prompt: CopyPrompt) {
    if (prompt.options?.direction === "to_local" && !prompt.options.localConflictStrategy) {
      copyConflictCheck.mutate(prompt);
      return;
    }
    if (!autoOpenTaskStatus && prompt.autoStart) {
      startCopySilently.mutate(prompt);
      return;
    }
    setCopyPrompt(prompt);
  }

  function handleSymlinkKindChange(nextKind: SymlinkKindFilter) {
    setKind(nextKind);
    setTreePrefix("");
  }

  function handleLibraryViewChange(nextView: LibraryView) {
    if (nextView !== view && (nextView === "local" || nextView === "remote" || nextView === "local-orphans" || nextView === "remote-orphans")) {
      setStoragePrefix("");
    }
    setView(nextView);
  }

  return (
    <Page title="Library" subtitle="Manual inventory from the last scan.">
      <div className="segmented">
        {[
          { value: "overview", label: "Overview", icon: Database },
          { value: "links", label: "Symlinks", icon: Link2 },
          { value: "local", label: `${localName} files`, icon: HardDrive },
          { value: "remote", label: `${remoteName} files`, icon: HardDriveDownload },
          { value: "local-orphans", label: `${localName} orphans`, icon: Unlink },
          { value: "remote-orphans", label: `${remoteName} orphans`, icon: Unlink },
          { value: "policies", label: "Storage Policies", icon: Shield }
        ].map((option) => {
          const Icon = option.icon;
          return (
            <button key={option.value} className={view === option.value ? "selected" : ""} onClick={() => handleLibraryViewChange(option.value as LibraryView)}>
              <Icon size={15} />
              {option.label}
            </button>
          );
        })}
      </div>
      {startCopySilently.error ? <p className="action-message action-error">{startCopySilently.error.message}</p> : null}
      {copyConflictCheck.error ? <p className="action-message action-error">{copyConflictCheck.error.message}</p> : null}
      {startTitleScan.error ? <p className="action-message action-error">{startTitleScan.error.message}</p> : null}
      {!startCopySilently.error && startCopySilently.data ? <p className="action-message">Copy job #{startCopySilently.data.jobId} queued. View progress from the job list.</p> : null}
      {view === "overview" ? (
        <>
          <LibraryOverview summary={overview.data} isLoading={overview.isLoading} error={overview.error?.message} onSelect={handleLibraryViewChange} />
          {sectionSummaries.error ? <p className="panel-message error">{sectionSummaries.error.message}</p> : null}
          <SectionTable sections={orderedSectionSummaries} selectedRemoteWork={selectedLibraryWork} onRemoteWorkSelect={setSelectedLibraryWork} />
          <RemoteWorkLinksTable
            selection={selectedLibraryWork}
            sections={orderedSectionSummaries}
            pendingTitleScopes={startTitleScan.isPending ? startTitleScan.variables?.titleScopes : undefined}
            onClose={() => setSelectedLibraryWork(null)}
            onAuditRequest={setAuditPrompt}
            onCopyRequest={handleCopyRequest}
            onRescanTitle={(section, itemName) => startTitleScan.mutate(titleRescanOptions([{ section, itemName }]))}
          />
        </>
      ) : view === "links" ? (
        <>
          <SymlinkBrowser
            sections={orderedSectionSummaries}
            selectedSection={selectedSection}
            kind={kind}
            tree={symlinkTree.data}
            error={sectionSummaries.error?.message ?? symlinkTree.error?.message}
            isLoadingSections={sectionSummaries.isLoading}
            isLoadingTree={symlinkTree.isLoading || symlinkTree.isFetching}
            onKindChange={handleSymlinkKindChange}
            onPrefixChange={setTreePrefix}
            onSectionSelect={(section) => {
              setSelectedSection(section);
              setTreePrefix("");
            }}
            onWorkSelect={setSelectedLibraryWork}
          />
          <RemoteWorkLinksTable
            selection={selectedLibraryWork}
            sections={orderedSectionSummaries}
            pendingTitleScopes={startTitleScan.isPending ? startTitleScan.variables?.titleScopes : undefined}
            onClose={() => setSelectedLibraryWork(null)}
            onAuditRequest={setAuditPrompt}
            onCopyRequest={handleCopyRequest}
            onRescanTitle={(section, itemName) => startTitleScan.mutate(titleRescanOptions([{ section, itemName }]))}
          />
        </>
      ) : view === "policies" ? (
        <StoragePoliciesPanel
          items={storagePolicies.data ?? []}
          jobs={jobs.data ?? []}
          policy={policyFilter}
          search={policySearch}
          error={storagePolicies.error?.message ?? setPolicy.error?.message ?? removePolicy.error?.message}
          isLoading={storagePolicies.isLoading || storagePolicies.isFetching}
          mutatingTitles={setPolicy.isPending ? setPolicy.variables?.titles ?? [] : []}
          mutatingPolicy={setPolicy.isPending ? setPolicy.variables?.policy ?? null : null}
          copyingTitle={null}
          pendingTitleScopes={startTitleScan.isPending ? startTitleScan.variables?.titleScopes : undefined}
          copyJobId={null}
          removingId={removePolicy.isPending ? removePolicy.variables ?? null : null}
          onPolicyChange={setPolicyFilter}
          onSearchChange={setPolicySearch}
          onAssign={(title, policy) => setPolicy.mutate({ titles: [title], policy })}
          onAssignMany={(titles, policy) => setPolicy.mutate({ titles, policy })}
          onCopy={(title, direction) =>
            handleCopyRequest({
              key: copyPromptKey({ itemName: title, direction }),
              title: `Copy ${title} to ${direction === "to_local" ? localName : remoteName}`,
              description: title,
              options: { itemName: title, direction },
              autoStart: true
            })
          }
          onAudit={(title) => setAuditPrompt({ title: `Audit ${title}`, description: title, options: { itemName: title } })}
          onRescan={(item) => startTitleScan.mutate(titleRescanOptions(item.sections.map((section) => ({ section, itemName: item.title }))))}
          onRemove={(id) => removePolicy.mutate(id)}
        />
      ) : (
        <StorageFileBrowser
          rootType={storageRoot}
          orphanOnly={orphanOnly}
          tree={storageTree.data}
          error={storageTree.error?.message}
          isLoading={storageTree.isLoading || storageTree.isFetching}
          onPrefixChange={setStoragePrefix}
        />
      )}
      <AuditDialog prompt={auditPrompt} onClose={() => setAuditPrompt(null)} />
      <CopyDialog prompt={copyPrompt} onClose={() => setCopyPrompt(null)} />
      <ScanStatusDialog prompt={scanStatusPrompt} onClose={() => setScanStatusPrompt(null)} />
    </Page>
  );
}

function LibraryOverview({
  summary,
  isLoading,
  error,
  onSelect
}: {
  summary: InventorySummary | undefined;
  isLoading: boolean;
  error?: string;
  onSelect: (view: LibraryView) => void;
}) {
  const storageLocations = useStorageLocations();
  const localName = storageLocationName(storageLocations, "local");
  const remoteName = storageLocationName(storageLocations, "remote");
  const cards = [
    {
      value: "links",
      label: "Symlinks",
      icon: Link2,
      count: summary?.totalLinks,
      detail: `${formatNumber(summary?.remoteLinks ?? 0)} ${remoteName} / ${formatNumber(summary?.localLinks ?? 0)} ${localName}`
    },
    {
      value: "local",
      label: `${localName} files`,
      icon: HardDrive,
      count: summary?.localFiles,
      detail: `${formatNumber(summary?.localOrphanFiles ?? 0)} orphan`
    },
    {
      value: "remote",
      label: `${remoteName} files`,
      icon: HardDriveDownload,
      count: summary?.remoteFiles,
      detail: `${formatNumber(summary?.remoteOrphanFiles ?? 0)} orphan`
    },
    {
      value: "local-orphans",
      label: `${localName} orphans`,
      icon: Unlink,
      count: summary?.localOrphanFiles,
      detail: "No symlink target"
    },
    {
      value: "remote-orphans",
      label: `${remoteName} orphans`,
      icon: Unlink,
      count: summary?.remoteOrphanFiles,
      detail: "No symlink target"
    },
    {
      value: "policies",
      label: "Storage Policies",
      icon: Shield,
      count: summary ? inventoryPolicyNeededCount(summary) : 0,
      detail: `${formatNumber(summary ? inventoryCopyToLocalCount(summary) : 0)} copy to ${localName} / ${formatNumber(summary ? inventoryCopyToRemoteCount(summary) : 0)} copy to ${remoteName}`
    }
  ] as const;

  return (
    <>
      {error ? <p className="panel-message error">{error}</p> : null}
      <div className="library-overview">
        {cards.map((item) => {
        const Icon = item.icon;
        return (
          <button key={item.value} className="library-entry" type="button" onClick={() => onSelect(item.value as LibraryView)}>
            <Icon size={18} />
            <span className="library-entry-copy">
              <span>{item.label}</span>
              <strong>{isLoading ? "..." : formatNumber(item.count ?? 0)}</strong>
              <small>{item.detail}</small>
            </span>
          </button>
        );
        })}
      </div>
    </>
  );
}

function SymlinkBrowser({
  sections,
  selectedSection,
  kind,
  tree,
  error,
  isLoadingSections,
  isLoadingTree,
  onKindChange,
  onPrefixChange,
  onSectionSelect,
  onWorkSelect
}: {
  sections: SectionSummary[];
  selectedSection: string | null;
  kind: SymlinkKindFilter;
  tree: MediaLinkTree | undefined;
  error?: string;
  isLoadingSections: boolean;
  isLoadingTree: boolean;
  onKindChange: (kind: SymlinkKindFilter) => void;
  onPrefixChange: (prefix: string) => void;
  onSectionSelect: (section: string) => void;
  onWorkSelect: (selection: SectionWorkSelection) => void;
}) {
  const storageLocations = useStorageLocations();
  const localName = storageLocationName(storageLocations, "local");
  const remoteName = storageLocationName(storageLocations, "remote");
  const [visibleFields, setVisibleFields] = useState({ targetPath: false });
  const [search, setSearch] = useState("");
  const nodes = useMemo(() => tree?.nodes ?? [], [tree?.nodes]);
  const filteredNodes = useMemo(() => filterTreeNodes(nodes, search), [nodes, search]);
  const breadcrumbParts = tree?.prefix ? tree.prefix.split("/").filter(Boolean) : [];
  const canGoBack = Boolean(tree?.prefix);
  const selectedSectionSummary = sections.find((section) => section.section === selectedSection);
  const selectedSectionTitle = selectedSectionSummary ? sectionDisplayTitle(selectedSectionSummary) : selectedSection;
  const selectedSectionType = selectedSectionSummary ? sectionContentType(selectedSectionSummary) : selectedSection ? inferSectionContentType(selectedSection) : "other";
  const isShowSection = selectedSectionType === "shows";
  const showRootSeasonCounts = isShowSection && !tree?.prefix;
  const visibleColumnCount = (isShowSection ? 4 : 3) + (visibleFields.targetPath ? 1 : 0);

  return (
    <>
      <Panel title="Symlink Sections" icon={<Link2 size={18} />}>
        {error ? <p className="panel-message error">{error}</p> : null}
        <div className="section-picker">
          {isLoadingSections ? (
            <p className="panel-message">Loading sections...</p>
          ) : sections.length === 0 ? (
            <p className="panel-message">No symlink sections found.</p>
          ) : (
            sections.map((section) => {
              const title = sectionDisplayTitle(section);
              const type = sectionContentType(section);
              const metrics = type === "shows"
                ? [
                    { label: "Shows", value: section.itemCount },
                    { label: "Seasons", value: section.seasonCount },
                    { label: "Episodes", value: section.episodeCount }
                  ]
                : [
                    { label: nonShowSectionMetricLabel(type), value: section.itemCount },
                    ...(section.episodeCount !== section.itemCount ? [{ label: "Files", value: section.episodeCount }] : [])
                  ];
              return (
                <button
                  key={section.section}
                  type="button"
                  className={selectedSection === section.section ? "section-option selected" : "section-option"}
                  onClick={() => onSectionSelect(section.section)}
                >
                  <span className="section-option-header">
                    <span className="section-option-title">
                      <Folder size={16} />
                      {title}
                    </span>
                  </span>
                  <span className={`section-option-metrics metric-count-${metrics.length}`}>
                    {metrics.map((metric) => (
                      <span key={metric.label} className="section-option-metric">
                        <strong>{formatNumber(metric.value)}</strong>
                        <small>{metric.label}</small>
                      </span>
                    ))}
                  </span>
                  <span className="section-option-detail">
                    <small>{formatNumber(section.remoteLinks)} {remoteName}</small>
                    <small>{formatNumber(section.localLinks)} {localName}</small>
                  </span>
                </button>
              );
            })
          )}
        </div>
      </Panel>

      <Panel title={selectedSectionTitle ? `Symlinks: ${selectedSectionTitle}` : "Symlink Browser"} icon={<Library size={18} />}>
        <div className="table-toolbar symlink-toolbar">
          <div className="breadcrumb">
            <button className="secondary" type="button" onClick={() => onPrefixChange(tree?.parentPrefix ?? "")} disabled={!canGoBack}>
              <ArrowLeft size={14} />
              Back
            </button>
            {selectedSection ? (
              <>
                <button className="breadcrumb-button" type="button" onClick={() => onPrefixChange("")}>
                  {selectedSectionTitle}
                </button>
                {breadcrumbParts.map((part, index) => {
                  const prefix = breadcrumbParts.slice(0, index + 1).join("/");
                  return (
                    <span key={prefix} className="breadcrumb-part">
                      <ChevronRight size={13} />
                      <button className="breadcrumb-button" type="button" onClick={() => onPrefixChange(prefix)}>
                        {part}
                      </button>
                    </span>
                  );
                })}
              </>
            ) : (
              <span>Select a section</span>
            )}
          </div>
          <div className="symlink-controls">
            <label className="tree-search">
              <Search size={14} />
              <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search current folder" />
            </label>
            <div className="segmented compact">
              {(["all", "mixed", "remote", "local", "broken"] as const).map((value) => (
                <button key={value} className={kind === value ? "selected" : ""} type="button" onClick={() => onKindChange(value)}>
                  {value === "local" ? localName : value === "remote" ? remoteName : symlinkKindFilterLabels[value]}
                </button>
              ))}
            </div>
            <div className="field-options" role="group" aria-label="Visible fields">
              <span>
                <Settings size={14} />
                Fields
              </span>
              <label>
                <input
                  type="checkbox"
                  checked={visibleFields.targetPath}
                  onChange={(event) => setVisibleFields((current) => ({ ...current, targetPath: event.target.checked }))}
                />
                Target/path
              </label>
            </div>
          </div>
        </div>
        <table className="responsive-table">
          <thead>
            <tr>
              <th>Name</th>
              {isShowSection ? (
                <>
                  <th>Seasons</th>
                  <th>Episodes</th>
                </>
              ) : (
                <th>Links</th>
              )}
              <th>Status</th>
              {visibleFields.targetPath ? <th>Target / path</th> : null}
            </tr>
          </thead>
          <tbody>
            {!selectedSection ? (
              <tr>
                <td className="empty-state" colSpan={visibleColumnCount}>
                  Select a section.
                </td>
              </tr>
            ) : isLoadingTree && nodes.length === 0 ? (
              <tr>
                <td className="empty-state" colSpan={visibleColumnCount}>
                  Loading symlinks...
                </td>
              </tr>
            ) : filteredNodes.length === 0 ? (
              <tr>
                <td className="empty-state" colSpan={visibleColumnCount}>
                  {search.trim() ? "No symlinks match this search." : "No symlinks found."}
                </td>
              </tr>
            ) : (
              filteredNodes.map((node) => (
                <SymlinkTreeRow
                  key={`${node.type}:${node.path}`}
                  node={node}
                  section={selectedSection}
                  isShowSection={isShowSection}
                  showRootSeasonCounts={showRootSeasonCounts}
                  showTargetPath={visibleFields.targetPath}
                  onOpen={onPrefixChange}
                  onWorkSelect={onWorkSelect}
                />
              ))
            )}
          </tbody>
        </table>
      </Panel>
    </>
  );
}

function filterTreeNodes(nodes: MediaLinkTreeNode[], search: string): MediaLinkTreeNode[] {
  const tokens = search
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  if (tokens.length === 0) return nodes;
  return nodes.filter((node) => {
    const link = node.link;
    const haystack = [node.name, node.path, link?.itemName, link?.relativePath, link?.targetPath].filter(Boolean).join(" ").toLowerCase();
    return tokens.every((token) => haystack.includes(token));
  });
}

function SymlinkTreeRow({
  node,
  section,
  isShowSection,
  showRootSeasonCounts,
  showTargetPath,
  onOpen,
  onWorkSelect
}: {
  node: MediaLinkTreeNode;
  section: string | null;
  isShowSection: boolean;
  showRootSeasonCounts: boolean;
  showTargetPath: boolean;
  onOpen: (prefix: string) => void;
  onWorkSelect: (selection: SectionWorkSelection) => void;
}) {
  const seasonValue = showRootSeasonCounts && node.type === "folder" ? formatNumber(node.childFolderCount) : "-";
  if (node.type === "folder") {
    return (
      <tr className="tree-row tree-folder">
        <td>
          <button className="tree-name-button" type="button" onClick={() => onOpen(node.path)}>
            <Folder size={15} />
            <span>{node.name}</span>
            <ChevronRight size={14} />
          </button>
        </td>
        {isShowSection ? (
          <>
            <td>{seasonValue}</td>
            <td>{formatNumber(node.totalLinks)}</td>
          </>
        ) : (
          <td>{formatNumber(node.totalLinks)}</td>
        )}
        <td>
          <LinkCountPills node={node} section={section} onWorkSelect={onWorkSelect} />
        </td>
        {showTargetPath ? <td className="mono narrow muted-path">{node.path}/</td> : null}
      </tr>
    );
  }

  return (
    <tr className="tree-row">
      <td>
        <span className="tree-file-name">
          <File size={15} />
          {node.name}
        </span>
      </td>
      {isShowSection ? (
        <>
          <td>-</td>
          <td>{formatNumber(node.totalLinks)}</td>
        </>
      ) : (
        <td>{formatNumber(node.totalLinks)}</td>
      )}
      <td>
        <LinkCountPills node={node} section={section} onWorkSelect={onWorkSelect} />
      </td>
      {showTargetPath ? <td className="mono narrow">{node.link?.targetPath ?? node.path}</td> : null}
    </tr>
  );
}

function LinkCountPills({ node, section, onWorkSelect }: { node: MediaLinkTreeNode; section: string | null; onWorkSelect: (selection: SectionWorkSelection) => void }) {
  const storageLocations = useStorageLocations();
  const visibleCounts = mediaLinkTreeStatusCounts(node);
  if (visibleCounts.length === 0) return <span className="muted-path">-</span>;
  return (
    <div className="status-cluster">
      {visibleCounts.map(({ label, count, kind: workKind }) => {
        const displayLabel = storageStatusDisplayLabel(label, storageLocations);
        if (workKind && section) {
          return (
            <button
              key={label}
              type="button"
              className="status-count status-count-button"
              onClick={() => onWorkSelect({ section, kind: workKind, relativePathPrefix: node.path, scopeLabel: node.path })}
            >
              <StatusPill value={displayLabel} toneValue={label} />
              {count > 1 ? <span>{formatNumber(count)}</span> : null}
            </button>
          );
        }

        return (
          <span key={label} className="status-count">
            <StatusPill value={displayLabel} toneValue={label} />
            {count > 1 ? <span>{formatNumber(count)}</span> : null}
          </span>
        );
      })}
    </div>
  );
}

function storageBrowserTitle(rootType: StorageRootType, orphanOnly: boolean, rootLabel: string): string {
  return orphanOnly ? `${rootLabel} orphan files` : `${rootLabel} files`;
}

function formatStorageModified(value: number | null, timeFormat: TimeFormatPreference): string {
  return value == null ? "-" : formatDate(new Date(value).toISOString(), timeFormat);
}

function StorageFileBrowser({
  rootType,
  orphanOnly,
  tree,
  error,
  isLoading,
  onPrefixChange
}: {
  rootType: StorageRootType;
  orphanOnly: boolean;
  tree: StorageFileTree | undefined;
  error?: string;
  isLoading: boolean;
  onPrefixChange: (prefix: string) => void;
}) {
  const storageLocations = useStorageLocations();
  const rootLabel = storageLocationName(storageLocations, rootType);
  const [visibleFields, setVisibleFields] = useState({ fullPath: false });
  const title = storageBrowserTitle(rootType, orphanOnly, rootLabel);
  const Icon = rootType === "remote" ? HardDriveDownload : HardDrive;
  const nodes = tree?.nodes ?? [];
  const breadcrumbParts = tree?.prefix ? tree.prefix.split("/").filter(Boolean) : [];
  const canGoBack = Boolean(tree?.prefix);
  const visibleColumnCount = 6 + (visibleFields.fullPath ? 1 : 0);

  return (
    <Panel title={title} icon={<Icon size={18} />}>
      {error ? <p className="panel-message error">{error}</p> : null}
      <div className="table-toolbar symlink-toolbar">
        <div className="breadcrumb">
          <button className="secondary" type="button" onClick={() => onPrefixChange(tree?.parentPrefix ?? "")} disabled={!canGoBack}>
            <ArrowLeft size={14} />
            Back
          </button>
          <button className="breadcrumb-button" type="button" onClick={() => onPrefixChange("")}>
            {title}
          </button>
          {breadcrumbParts.map((part, index) => {
            const prefix = breadcrumbParts.slice(0, index + 1).join("/");
            return (
              <span key={prefix} className="breadcrumb-part">
                <ChevronRight size={13} />
                <button className="breadcrumb-button" type="button" onClick={() => onPrefixChange(prefix)}>
                  {part}
                </button>
              </span>
            );
          })}
        </div>
        <div className="symlink-controls">
          <div className="field-options" role="group" aria-label="Visible fields">
            <span>
              <Settings size={14} />
              Fields
            </span>
            <label>
              <input
                type="checkbox"
                checked={visibleFields.fullPath}
                onChange={(event) => setVisibleFields((current) => ({ ...current, fullPath: event.target.checked }))}
              />
              Full path
            </label>
          </div>
        </div>
      </div>
      <table className="responsive-table storage-tree-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Files</th>
            <th>Links</th>
            <th>Size</th>
            <th>Modified</th>
            <th>Status</th>
            {visibleFields.fullPath ? <th>Full path</th> : null}
          </tr>
        </thead>
        <tbody>
          {isLoading && nodes.length === 0 ? (
            <tr>
              <td className="empty-state" colSpan={visibleColumnCount}>
                Loading files...
              </td>
            </tr>
          ) : nodes.length === 0 ? (
            <tr>
              <td className="empty-state" colSpan={visibleColumnCount}>
                No files found.
              </td>
            </tr>
          ) : (
            nodes.map((node) => (
              <StorageFileTreeRow key={`${node.type}:${node.path}`} node={node} showFullPath={visibleFields.fullPath} onOpen={onPrefixChange} />
            ))
          )}
        </tbody>
      </table>
    </Panel>
  );
}

function StorageFileTreeRow({ node, showFullPath, onOpen }: { node: StorageFileTreeNode; showFullPath: boolean; onOpen: (prefix: string) => void }) {
  const { timeFormat } = useUserPreferences();
  if (node.type === "folder") {
    return (
      <tr className="tree-row tree-folder">
        <td>
          <button className="tree-name-button" type="button" onClick={() => onOpen(node.path)}>
            <Folder size={15} />
            <span>{node.name}</span>
            <ChevronRight size={14} />
          </button>
          <div className="storage-mobile-status">
            <StorageStatusCounts node={node} />
          </div>
        </td>
        <td>{formatNumber(node.totalFiles)}</td>
        <td>{formatNumber(node.linkedFiles)}</td>
        <td>{formatBytes(node.sizeBytes)}</td>
        <td>{formatStorageModified(node.mtimeMs, timeFormat)}</td>
        <td>
          <StorageStatusCounts node={node} />
        </td>
        {showFullPath ? <td className="mono narrow muted-path">{node.path}/</td> : null}
      </tr>
    );
  }

  const file = node.file;
  const linkCount = file?.linkCount ?? node.linkedFiles;
  return (
    <tr className="tree-row">
      <td>
        <span className="tree-file-name">
          <File size={15} />
          {node.name}
        </span>
        <div className="storage-mobile-status">
          <StorageFileStatus file={file ?? null} fallbackLinked={node.linkedFiles > 0} />
        </div>
      </td>
      <td>{formatNumber(node.totalFiles)}</td>
      <td>{formatNumber(linkCount)}</td>
      <td>{formatBytes(node.sizeBytes)}</td>
      <td>{formatStorageModified(node.mtimeMs, timeFormat)}</td>
      <td>
        <StorageFileStatus file={file ?? null} fallbackLinked={node.linkedFiles > 0} />
      </td>
      {showFullPath ? <td className="mono narrow">{file?.filePath ?? node.path}</td> : null}
    </tr>
  );
}

function StorageStatusCounts({ node }: { node: StorageFileTreeNode }) {
  const storageLocations = useStorageLocations();
  const counts = [
    ["linked", node.linkedFiles],
    ["orphan", node.orphanFiles],
    ["Copy To Local", node.actionableRemoteFiles],
    ["Copy To Remote", node.actionableLocalFiles],
    ["Location 2", node.assignedRemoteFiles]
  ] as const;
  const visibleCounts = counts.filter(([, count]) => count > 0);
  if (visibleCounts.length === 0) return <span className="muted-path">-</span>;
  return (
    <div className="status-cluster">
      {visibleCounts.map(([label, count]) => (
        <span key={label} className="status-count">
          <StatusPill value={storageStatusDisplayLabel(label, storageLocations)} toneValue={label} />
          {count > 1 ? <span>{formatNumber(count)}</span> : null}
        </span>
      ))}
    </div>
  );
}

function StorageFileStatus({ file, fallbackLinked }: { file: StorageFileRow | null; fallbackLinked: boolean }) {
  const storageLocations = useStorageLocations();
  const linked = file?.linked ?? fallbackLinked;
  const policy = file?.storagePolicy ?? "unassigned";
  const rootType = file?.rootType ?? null;
  const policyLabel =
    !linked && rootType === "remote" && policy === "location_1"
      ? "Copy To Local"
      : !linked && rootType === "local" && policy === "location_2"
        ? "Copy To Remote"
        : !linked && rootType === "remote" && policy === "location_2"
          ? "Location 2"
          : null;
  return (
    <div className="status-cluster">
      <span className="status-count">
        <StatusPill value={linked ? "linked" : "orphan"} />
      </span>
      {policyLabel ? (
        <span className="status-count">
          <StatusPill value={storageStatusDisplayLabel(policyLabel, storageLocations)} toneValue={policyLabel} />
        </span>
      ) : null}
    </div>
  );
}

function filterStoragePolicyItems(items: StoragePolicyTitle[], search: string, storageLocations: StorageLocationsSettings): StoragePolicyTitle[] {
  const tokens = search
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  if (tokens.length === 0) return items;
  return items.filter((item) => {
    const haystack = [item.title, item.category, storagePolicyLabel(item.policy, storageLocations), ...item.sections].join(" ").toLowerCase();
    return tokens.every((token) => haystack.includes(token));
  });
}

function StoragePoliciesPanel({
  items,
  jobs,
  policy,
  search,
  error,
  isLoading,
  mutatingTitles,
  mutatingPolicy,
  copyingTitle,
  pendingTitleScopes,
  copyJobId,
  removingId,
  onPolicyChange,
  onSearchChange,
  onAssign,
  onAssignMany,
  onCopy,
  onAudit,
  onRescan,
  onRemove
}: {
  items: StoragePolicyTitle[];
  jobs: JobRecord[];
  policy: StoragePolicyKind;
  search: string;
  error?: string;
  isLoading: boolean;
  mutatingTitles: string[];
  mutatingPolicy: StoragePolicyKind | null;
  copyingTitle: string | null;
  pendingTitleScopes?: ScanTitleScope[];
  copyJobId: number | null;
  removingId: number | null;
  onPolicyChange: (policy: StoragePolicyKind) => void;
  onSearchChange: (title: string) => void;
  onAssign: (title: string, policy: StoragePolicyKind) => void;
  onAssignMany: (titles: string[], policy: StoragePolicyKind) => void;
  onCopy: (title: string, direction: CopyDirection) => void;
  onAudit: (title: string) => void;
  onRescan: (item: StoragePolicyTitle) => void;
  onRemove: (id: number) => void;
}) {
  const { timeFormat } = useUserPreferences();
  const storageLocations = useStorageLocations();
  const localName = storageLocationName(storageLocations, "local");
  const remoteName = storageLocationName(storageLocations, "remote");
  const storagePolicyTabs: Array<{ value: StoragePolicyKind; label: string; detail: string }> = [
    { value: "unassigned", label: "Unassigned", detail: "Titles waiting for a destination policy" },
    { value: "location_1", label: localName, detail: `Content assigned here should reside on ${localName}` },
    { value: "location_2", label: remoteName, detail: `Content assigned here should reside on ${remoteName}` }
  ];
  const [selectedTitleKeys, setSelectedTitleKeys] = useState<string[]>([]);
  const filteredItems = filterStoragePolicyItems(items, search, storageLocations);
  const activeQueueJobs = useMemo(() => jobs.filter(isActiveQueueJob), [jobs]);
  const activeJobsByTitleKey = useMemo(() => {
    return new Map(
      filteredItems
        .map((item) => [item.normalizedTitle, activeJobsForStoragePolicyTitle(item, activeQueueJobs)] as const)
        .filter((entry) => entry[1].length > 0)
    );
  }, [activeQueueJobs, filteredItems]);
  const pendingTitleKeys = new Set(
    filteredItems
      .filter((item) => pendingTitleScopes?.some((scope) => item.sections.includes(scope.section) && scope.itemName === item.title))
      .map((item) => item.normalizedTitle)
  );
  const selectableItems = filteredItems.filter((item) => !activeJobsByTitleKey.has(item.normalizedTitle) && !pendingTitleKeys.has(item.normalizedTitle));
  const selectableTitleKeys = selectableItems.map((item) => item.normalizedTitle);
  const selectableTitleKey = selectableTitleKeys.join("|");
  useEffect(() => {
    const selectableKeys = new Set(selectableTitleKey ? selectableTitleKey.split("|") : []);
    setSelectedTitleKeys((current) => current.filter((key) => selectableKeys.has(key)));
  }, [selectableTitleKey]);
  const selectedTitleKeySet = new Set(selectedTitleKeys);
  const selectedItems = selectableItems.filter((item) => selectedTitleKeySet.has(item.normalizedTitle));
  const selectedTitles = uniqueTitles(selectedItems.map((item) => item.title));
  const allVisibleSelected = selectableTitleKeys.length > 0 && selectableTitleKeys.every((key) => selectedTitleKeySet.has(key));
  const mutatingTitleSet = new Set(mutatingTitles);
  const isMutatingPolicy = mutatingTitles.length > 0 && Boolean(mutatingPolicy);
  const mutatingPolicyText = mutatingPolicy ? storagePolicyActionText(mutatingPolicy, storageLocations) : "";
  const emptyLabel = search.trim()
    ? "No matching titles."
    : policy === "unassigned"
      ? "No titles need a storage policy."
      : `No titles are assigned to ${policy === "location_1" ? localName : remoteName}.`;
  const activeVisibleTitleCount = filteredItems.length - selectableItems.length;

  function toggleTitleSelection(item: StoragePolicyTitle, checked: boolean) {
    if (activeJobsByTitleKey.has(item.normalizedTitle) || pendingTitleKeys.has(item.normalizedTitle)) return;
    setSelectedTitleKeys((current) => {
      if (checked) return current.includes(item.normalizedTitle) ? current : [...current, item.normalizedTitle];
      return current.filter((key) => key !== item.normalizedTitle);
    });
  }

  function selectAllVisibleTitles() {
    setSelectedTitleKeys(selectableTitleKeys);
  }

  return (
    <Panel title={`Storage Policies (${items.length})`} icon={<Shield size={18} />}>
      <div className="policy-toolbar">
        <div className="policy-tabs" role="tablist" aria-label="Storage policy groups">
          {storagePolicyTabs.map((tab) => (
            <button key={tab.value} type="button" className={policy === tab.value ? "selected" : ""} aria-selected={policy === tab.value} onClick={() => onPolicyChange(tab.value)}>
              <strong>{tab.label}</strong>
              <small>{tab.detail}</small>
            </button>
          ))}
        </div>
        <label className="policy-search">
          Search titles
          <input value={search} onChange={(event) => onSearchChange(event.target.value)} placeholder="Filter scanned titles" autoComplete="off" />
        </label>
      </div>
      {filteredItems.length > 0 ? (
        <BulkActionBar selectedCount={selectedItems.length} totalCount={filteredItems.length} allSelected={allVisibleSelected} onSelectAll={selectAllVisibleTitles} onClear={() => setSelectedTitleKeys([])} disabled={isMutatingPolicy}>
          {policy !== "location_1" ? (
            <button type="button" className="secondary future-action-button" onClick={() => onAssignMany(selectedTitles, "location_1")} disabled={selectedTitles.length === 0 || mutatingTitles.length > 0}>
              <HardDrive size={14} />
              {mutatingPolicy === "location_1" ? `Assigning ${formatNumber(mutatingTitles.length)} title${mutatingTitles.length === 1 ? "" : "s"} to ${localName}...` : `Assign selected to ${localName}`}
            </button>
          ) : null}
          {policy !== "location_2" ? (
            <button type="button" className="secondary future-action-button" onClick={() => onAssignMany(selectedTitles, "location_2")} disabled={selectedTitles.length === 0 || mutatingTitles.length > 0}>
              <HardDriveDownload size={14} />
              {mutatingPolicy === "location_2" ? `Assigning ${formatNumber(mutatingTitles.length)} title${mutatingTitles.length === 1 ? "" : "s"} to ${remoteName}...` : `Assign selected to ${remoteName}`}
            </button>
          ) : null}
          {policy !== "unassigned" ? (
            <button type="button" className="secondary future-action-button" onClick={() => onAssignMany(selectedTitles, "unassigned")} disabled={selectedTitles.length === 0 || mutatingTitles.length > 0}>
              <Shield size={14} />
              {mutatingPolicy === "unassigned" ? `Unassigning ${formatNumber(mutatingTitles.length)}...` : "Unassign selected"}
            </button>
          ) : null}
        </BulkActionBar>
      ) : null}
      {isMutatingPolicy ? (
        <p className="panel-message action-progress">
          <RefreshCw className="spin-icon" size={14} />
          Assigning {formatNumber(mutatingTitles.length)} title{mutatingTitles.length === 1 ? "" : "s"} to {mutatingPolicyText}. Large libraries can take a moment.
        </p>
      ) : null}
      {activeVisibleTitleCount > 0 ? (
        <p className="panel-message job-lock-panel">
          {formatNumber(activeVisibleTitleCount)} visible title{activeVisibleTitleCount === 1 ? "" : "s"} already {activeVisibleTitleCount === 1 ? "has" : "have"} an active job.
          Wait for completion or terminate the job before issuing more actions.
        </p>
      ) : null}
      {error ? <p className="panel-message error">{error}</p> : null}
      {copyJobId ? <p className="panel-message">Copy job #{copyJobId} queued.</p> : null}
      <table className="responsive-table">
        <thead>
          <tr>
            <th>
              <span className="sr-only">Select</span>
            </th>
            <th>Title</th>
            <th>Category</th>
            <th>Media</th>
            <th>Policy</th>
            <th>Updated</th>
            <th className="actions-cell">Actions</th>
          </tr>
        </thead>
        <tbody>
          {isLoading ? (
            <tr>
              <td className="empty-state" colSpan={7}>
                Loading storage policies...
              </td>
            </tr>
          ) : filteredItems.length === 0 ? (
            <tr>
              <td className="empty-state" colSpan={7}>
                {emptyLabel}
              </td>
            </tr>
          ) : (
            filteredItems.map((item) => (
              <tr key={`${item.policy}-${item.normalizedTitle}`}>
                <td>
                  <label className="bulk-row-select">
                    <input
                      type="checkbox"
                      checked={selectedTitleKeySet.has(item.normalizedTitle)}
                      onChange={(event) => toggleTitleSelection(item, event.target.checked)}
                      disabled={isMutatingPolicy || activeJobsByTitleKey.has(item.normalizedTitle) || pendingTitleKeys.has(item.normalizedTitle)}
                    />
                    <span className="sr-only">Select {item.title}</span>
                  </label>
                </td>
                <td>{item.title}</td>
                <td>
                  <span className={`category-badge category-${item.category}`}>
                    {storagePolicyCategoryLabels[item.category]}
                  </span>
                </td>
                <td>
                  {formatNumber(item.linkCount)} links / {formatNumber(item.fileCount)} files
                  <small className="table-cell-detail">
                    {formatNumber(item.remoteLinkCount + item.remoteFileCount)} {remoteName} / {formatNumber(item.localLinkCount + item.localFileCount)} {localName}
                  </small>
                </td>
                <td>
                  <StatusPill
                    value={storagePolicyLabel(item.policy, storageLocations)}
                    toneValue={item.policy}
                  />
                </td>
                <td>{formatDate(item.updatedAt, timeFormat)}</td>
                <td className="actions-cell">
                  <PolicyActions
                    item={item}
                    mutatingTitleSet={mutatingTitleSet}
                    copyingTitle={copyingTitle}
                    activeJobs={activeJobsByTitleKey.get(item.normalizedTitle) ?? []}
                    rescanPending={Boolean(pendingTitleScopes?.some((scope) => item.sections.includes(scope.section) && scope.itemName === item.title))}
                    removingId={removingId}
                    onAssign={onAssign}
                    onCopy={onCopy}
                    onAudit={onAudit}
                    onRescan={() => onRescan(item)}
                    onRemove={onRemove}
                  />
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </Panel>
  );
}

function PolicyActions({
  item,
  mutatingTitleSet,
  copyingTitle,
  activeJobs,
  rescanPending,
  removingId,
  onAssign,
  onCopy,
  onAudit,
  onRescan,
  onRemove
}: {
  item: StoragePolicyTitle;
  mutatingTitleSet: Set<string>;
  copyingTitle: string | null;
  activeJobs: JobRecord[];
  rescanPending: boolean;
  removingId: number | null;
  onAssign: (title: string, policy: StoragePolicyKind) => void;
  onCopy: (title: string, direction: CopyDirection) => void;
  onAudit: (title: string) => void;
  onRescan: () => void;
  onRemove: (id: number) => void;
}) {
  const storageLocations = useStorageLocations();
  const localName = storageLocationName(storageLocations, "local");
  const remoteName = storageLocationName(storageLocations, "remote");
  const disabled =
    mutatingTitleSet.has(item.title) ||
    copyingTitle === item.title ||
    rescanPending ||
    (item.id != null && removingId === item.id) ||
    activeJobs.length > 0;
  const notice = activeJobNotice(activeJobs);
  const canAssign = item.linkCount + item.fileCount > 0;
  const canAudit = item.linkCount > 0;
  return (
    <div className={`future-actions policy-actions${notice ? " has-job-lock" : ""}`}>
      {notice ? <JobLockBadge jobs={activeJobs} /> : null}
      <span className="future-action-buttons">
        {canAudit ? <RescanTitleButton itemName={item.title} disabled={disabled} pending={rescanPending} onClick={onRescan} /> : null}
        {item.policy === "location_1" && item.remoteLinkCount > 0 ? (
          <button type="button" className="secondary future-action-button" disabled={disabled} onClick={() => onCopy(item.title, "to_local")}>
            <Copy size={14} />
            Copy to {localName}
          </button>
        ) : null}
        {item.policy === "location_2" && item.localLinkCount > 0 ? (
          <button type="button" className="secondary future-action-button" disabled={disabled} onClick={() => onCopy(item.title, "to_remote")}>
            <Copy size={14} />
            Copy to {remoteName}
          </button>
        ) : null}
        {canAudit ? (
          <button type="button" className="secondary future-action-button" disabled={disabled} onClick={() => onAudit(item.title)}>
            <Activity size={14} />
            Audit
          </button>
        ) : null}
        {canAssign && item.policy !== "location_1" ? (
          <button type="button" className="secondary future-action-button" disabled={disabled} onClick={() => onAssign(item.title, "location_1")}>
            <HardDrive size={14} />
            Assign to {localName}
          </button>
        ) : null}
        {canAssign && item.policy !== "location_2" ? (
          <button type="button" className="secondary future-action-button" disabled={disabled} onClick={() => onAssign(item.title, "location_2")}>
            <HardDriveDownload size={14} />
            Assign to {remoteName}
          </button>
        ) : null}
        {item.id != null ? (
          <button className="icon-button danger" type="button" title={`Unassign ${item.title}`} disabled={disabled} onClick={() => onRemove(item.id!)}>
            <Trash2 size={15} />
            <span className="sr-only">Unassign {item.title}</span>
          </button>
        ) : null}
      </span>
    </div>
  );
}

function RunsPage({ type }: { type: "scan" | "audit" }) {
  return type === "scan" ? <ScanHistoryPage /> : <AuditHistoryPage />;
}

function ScanHistoryPage() {
  const query = useQuery({ queryKey: ["scans"], queryFn: api.scans, refetchInterval: 5000 });
  const sectionSettings = useQuery({ queryKey: ["section-settings"], queryFn: api.getSections });
  const [scanStatusPrompt, setScanStatusPrompt] = useState<ScanStatusPrompt | null>(null);
  const availableSections = (sectionSettings.data?.sections ?? []).map((section) => ({ section, title: sectionSettings.data?.sectionTitles?.[section] ?? section }));
  return (
    <Page title="History > Scans" subtitle="Past inventory scans with scanned scope, resulting inventory counters, and failure details.">
      <ScanRunsList
        runs={query.data ?? []}
        availableSections={availableSections}
        isLoading={query.isLoading}
        error={query.error}
        onScanJobSelect={(run) => setScanStatusPrompt(scanStatusPromptFromRun(run, availableSections))}
      />
      <ScanStatusDialog prompt={scanStatusPrompt} onClose={() => setScanStatusPrompt(null)} />
    </Page>
  );
}

function AuditHistoryPage() {
  const query = useQuery({ queryKey: ["audits"], queryFn: api.audits, refetchInterval: 5000 });
  const sectionSettings = useQuery({ queryKey: ["section-settings"], queryFn: api.getSections });
  const [auditStatusPrompt, setAuditStatusPrompt] = useState<AuditStatusPrompt | null>(null);
  const availableSections = (sectionSettings.data?.sections ?? []).map((section) => ({ section, title: sectionSettings.data?.sectionTitles?.[section] ?? section }));
  return (
    <Page title="History > Audits" subtitle="Past audits with audited scope, validation results, and source comparison details.">
      <AuditRunsList
        runs={query.data ?? []}
        availableSections={availableSections}
        isLoading={query.isLoading}
        error={query.error}
        onAuditJobSelect={(run) => setAuditStatusPrompt(auditStatusPromptFromRun(run, availableSections))}
      />
      <AuditStatusDialog prompt={auditStatusPrompt} onClose={() => setAuditStatusPrompt(null)} />
    </Page>
  );
}

function ScanRunsList({
  runs,
  availableSections,
  isLoading,
  error,
  onScanJobSelect
}: {
  runs: ScanRunRecord[];
  availableSections: Array<{ section: string; title?: string | null }>;
  isLoading: boolean;
  error: Error | null;
  onScanJobSelect: (run: ScanRunRecord) => void;
}) {
  const { timeFormat } = useUserPreferences();
  const storageLocations = useStorageLocations();
  if (isLoading) return <p className="panel-message">Loading scan history...</p>;
  if (error) return <p className="panel-message error">{error.message}</p>;
  if (runs.length === 0) return <p className="panel-message">No scan history yet.</p>;

  return (
    <div className="scan-run-list">
      {runs.map((run) => {
        const options = run.options ?? null;
        const metricGroups = scanHistoryMetricGroups(run, options, storageLocations);
        const scopeItems = scanHistoryScopeItems(options, availableSections, storageLocations);
        return (
          <article className="scan-run-card" key={run.id ?? `job-${run.jobId}`}>
            <div className="scan-run-main">
              <div className="scan-run-title">
                <strong>{run.id == null ? `Scan job #${run.jobId}` : `Scan #${run.id}`}</strong>
                <span>{run.id == null ? "No scan run record was created" : `Job #${run.jobId}`}</span>
              </div>
              <div className="scan-run-actions">
                <StatusPill value={run.status} />
                <button type="button" className="icon-button" title={`View scan status for job #${run.jobId}`} aria-label={`View scan status for job #${run.jobId}`} onClick={() => onScanJobSelect(run)}>
                  <Search size={15} />
                </button>
              </div>
            </div>
            <div className="scan-run-meta">
              <span>Started {formatDate(run.startedAt, timeFormat)}</span>
              <span>Finished {formatDate(run.finishedAt, timeFormat)}</span>
              <span>{formatDuration(run.startedAt, run.finishedAt)}</span>
            </div>
            <div className="scan-run-scope" aria-label="Scanned scope">
              <span className="scan-run-scope-label">Scanned</span>
              <div className="scan-run-scope-list">
                {scopeItems.map((item) => (
                  <span className="scan-run-scope-chip" key={item.label}>
                    <span>{item.label}</span>
                    <strong>{item.value}</strong>
                  </span>
                ))}
              </div>
            </div>
            {run.errorMessage ? (
              <p className="scan-run-error">
                <TriangleAlert size={14} />
                <span>{run.errorMessage}</span>
              </p>
            ) : null}
            <div className="scan-run-groups">
              {metricGroups.map((group) => (
                <MetricGroup key={group.title} title={group.title} description={group.description} metrics={group.metrics} />
              ))}
            </div>
          </article>
        );
      })}
    </div>
  );
}

type MetricDefinition = { label: string; value: number | string };
type MetricGroupDefinition = { title: string; description?: string; metrics: MetricDefinition[] };

function scanHistoryScopeItems(
  options: Partial<ScanOptions> | null,
  availableSections: Array<{ section: string; title?: string | null }>,
  storageLocations: StorageLocationsSettings
): Array<{ label: string; value: string }> {
  if (!options) return [{ label: "Scope", value: "Unavailable" }];
  if (options.titleScopes?.length) {
    return [{ label: options.titleScopes.length === 1 ? "Title" : "Titles", value: formatTitleScanScope(options.titleScopes, availableSections) }];
  }
  const localName = storageLocationName(storageLocations, "local");
  const remoteName = storageLocationName(storageLocations, "remote");
  const items: Array<{ label: string; value: string }> = [];
  if (options.scanSymlinks) items.push({ label: "Symlinks", value: formatFolderScope(options.symlinkSections ?? options.sections, availableSections) });
  if (options.scanLocal) items.push({ label: `${localName} files`, value: formatFolderScope(options.localSections ?? options.sections, availableSections) });
  if (options.scanRemote) items.push({ label: `${remoteName} files`, value: `${remoteName} root` });
  return items.length > 0 ? items : [{ label: "Scope", value: "No categories selected" }];
}

function scanHistoryPolicyMetrics(run: ScanRunRecord, options: Partial<ScanOptions> | null, storageLocations: StorageLocationsSettings): MetricDefinition[] {
  const localName = storageLocationName(storageLocations, "local");
  const remoteName = storageLocationName(storageLocations, "remote");
  if (!options) {
    return [
      { label: "Needs assignment", value: inventoryPolicyNeededCount(run) + run.unassignedRemoteFiles + run.unassignedLocalFiles },
      { label: `Needs ${localName} copy`, value: inventoryCopyToLocalCount(run) },
      { label: `Needs ${remoteName} copy`, value: inventoryCopyToRemoteCount(run) },
      { label: `${remoteName} policy`, value: inventoryAssignedRemoteCount(run) }
    ];
  }

  const needsAssignment =
    (options.scanSymlinks ? run.unassignedRemoteLinks + run.unassignedLocalLinks : 0) +
    (options.scanRemote ? run.unassignedRemoteFiles : 0) +
    (options.scanLocal ? run.unassignedLocalFiles : 0);
  const needsLocalCopy = (options.scanSymlinks ? run.actionableRemoteLinks : 0) + (options.scanRemote ? run.actionableRemoteFiles : 0);
  const needsRemoteCopy = (options.scanSymlinks ? run.actionableLocalLinks : 0) + (options.scanLocal ? run.actionableLocalFiles : 0);
  const assignedRemote = (options.scanSymlinks ? run.assignedRemoteLinks : 0) + (options.scanRemote ? run.assignedRemoteFiles : 0);

  return [
    { label: "Needs assignment", value: needsAssignment },
    { label: `Needs ${localName} copy`, value: needsLocalCopy },
    { label: `Needs ${remoteName} copy`, value: needsRemoteCopy },
    { label: `${remoteName} policy`, value: assignedRemote }
  ];
}

function scanHistoryMissingMetrics(run: ScanRunRecord, options: Partial<ScanOptions> | null): MetricDefinition[] {
  if (!options) {
    return [
      { label: "Symlinks", value: run.missingLinks },
      { label: "Local files", value: run.missingLocalFiles },
      { label: "Remote files", value: run.missingRemoteFiles }
    ];
  }

  const metrics: MetricDefinition[] = [];
  if (options.scanSymlinks) metrics.push({ label: "Symlinks", value: run.missingLinks });
  if (options.scanLocal) metrics.push({ label: "Local files", value: run.missingLocalFiles });
  if (options.scanRemote) metrics.push({ label: "Remote files", value: run.missingRemoteFiles });
  return metrics;
}

function scanHistoryMetricGroups(run: ScanRunRecord, options: Partial<ScanOptions> | null, storageLocations: StorageLocationsSettings): MetricGroupDefinition[] {
  const groups: MetricGroupDefinition[] = [];
  const localName = storageLocationName(storageLocations, "local");
  const remoteName = storageLocationName(storageLocations, "remote");

  if (!options || options.scanSymlinks) {
    const symlinkMetrics: MetricDefinition[] = [
      { label: "Total symlinks", value: run.totalLinks },
      { label: `Pointing to ${remoteName}`, value: run.remoteLinks },
      { label: `Pointing to ${localName}`, value: run.localLinks },
      { label: "Broken symlinks", value: run.brokenLinks }
    ];
    if (run.otherLinks > 0) symlinkMetrics.push({ label: "Other targets", value: run.otherLinks });
    if (run.nonMediaLinks > 0) symlinkMetrics.push({ label: "Non-media links", value: run.nonMediaLinks });
    groups.push({
      title: "Symlink inventory",
      description: options ? "Current symlink inventory after this scan." : "Inventory snapshot after this scan.",
      metrics: symlinkMetrics
    });
  }

  groups.push({
    title: "Policy state",
    description: "Current assignment and copy work inside the scanned scope.",
    metrics: scanHistoryPolicyMetrics(run, options, storageLocations)
  });

  if (!options || options.scanLocal) {
    groups.push({
      title: `${localName} file inventory`,
      description: options ? `Files found in the scanned ${localName} folders.` : `${localName} file inventory snapshot after this scan.`,
      metrics: [
        { label: "Files found", value: run.localFiles },
        { label: "Orphan files", value: run.localOrphanFiles }
      ]
    });
  }

  if (!options || options.scanRemote) {
    groups.push({
      title: `${remoteName} file inventory`,
      description: options ? `Files found under the scanned ${remoteName} root.` : `${remoteName} file inventory snapshot after this scan.`,
      metrics: [
        { label: "Files found", value: run.remoteFiles },
        { label: "Orphan files", value: run.remoteOrphanFiles }
      ]
    });
  }

  const missingMetrics = scanHistoryMissingMetrics(run, options);
  if (missingMetrics.some((metric) => typeof metric.value === "number" && metric.value > 0)) {
    groups.push({
      title: "No longer found",
      description: "Previously indexed paths in the scanned scope that were not seen in this run.",
      metrics: missingMetrics
    });
  }

  return groups;
}

function AuditRunsList({
  runs,
  availableSections,
  isLoading,
  error,
  onAuditJobSelect
}: {
  runs: AuditRunRecord[];
  availableSections: Array<{ section: string; title?: string | null }>;
  isLoading: boolean;
  error: Error | null;
  onAuditJobSelect: (run: AuditRunRecord) => void;
}) {
  const { timeFormat } = useUserPreferences();
  if (isLoading) return <p className="panel-message">Loading audit history...</p>;
  if (error) return <p className="panel-message error">{error.message}</p>;
  if (runs.length === 0) return <p className="panel-message">No audit history yet.</p>;

  return (
    <div className="scan-run-list">
      {runs.map((run) => {
        const options = run.options ?? null;
        const scopeItems = auditHistoryScopeItems(run, options, availableSections);
        const metricGroups = auditHistoryMetricGroups(run, options);
        return (
          <article className="scan-run-card" key={run.id}>
            <div className="scan-run-main">
              <div className="scan-run-title">
                <strong>Audit #{run.id}</strong>
                <span>
                  Job #{run.jobId} / {auditModeLabel(options?.mode ?? run.mode)}
                </span>
              </div>
              <div className="scan-run-actions">
                <StatusPill value={run.status} />
                <button type="button" className="icon-button" title={`View audit status for job #${run.jobId}`} aria-label={`View audit status for job #${run.jobId}`} onClick={() => onAuditJobSelect(run)}>
                  <ListChecks size={15} />
                </button>
              </div>
            </div>
            <div className="scan-run-meta">
              <span>Started {formatDate(run.startedAt, timeFormat)}</span>
              <span>Finished {formatDate(run.finishedAt, timeFormat)}</span>
              <span>{formatDuration(run.startedAt, run.finishedAt)}</span>
            </div>
            <div className="scan-run-scope" aria-label="Audited scope">
              <span className="scan-run-scope-label">Audited</span>
              <div className="scan-run-scope-list">
                {scopeItems.map((item) => (
                  <span className="scan-run-scope-chip" key={item.label}>
                    <span>{item.label}</span>
                    <strong>{item.value}</strong>
                  </span>
                ))}
              </div>
            </div>
            {run.errorMessage ? (
              <p className="scan-run-error">
                <TriangleAlert size={14} />
                <span>{run.errorMessage}</span>
              </p>
            ) : null}
            <div className="scan-run-groups">
              {metricGroups.map((group) => (
                <MetricGroup key={group.title} title={group.title} description={group.description} metrics={group.metrics} />
              ))}
            </div>
          </article>
        );
      })}
    </div>
  );
}

function auditModeLabel(mode: AuditMode | null | undefined): string {
  if (mode === "deep") return "Deep";
  if (mode === "fast") return "Fast";
  return "Unknown";
}

function auditTargetLabel(options: AuditScopeDisplayOptions | null): string {
  if (!options) return "Unavailable";
  const targets = normalizeAuditTargets(options.targets);
  if (targets.length === 0) return "No targets";
  if (targets.includes("local") && targets.includes("remote")) return "Local + remote";
  return targets.includes("local") ? "Local" : "Remote";
}

function auditByteCompareLabel(options: AuditScopeDisplayOptions | null): string {
  if (!options) return "Unknown";
  return options.byteCompare === false ? "Skipped" : "Enabled";
}

function auditHistoryScopeItems(run: AuditRunRecord, options: AuditScopeDisplayOptions | null, availableSections: Array<{ section: string; title?: string | null }>): Array<{ label: string; value: string }> {
  const items: Array<{ label: string; value: string }> = [
    { label: "Mode", value: auditModeLabel(options?.mode ?? run.mode) },
    { label: "Targets", value: auditTargetLabel(options) },
    { label: "Byte compare", value: auditByteCompareLabel(options) }
  ];

  if (!options) {
    items.push({ label: "Scope", value: "Unavailable" });
    return items;
  }

  const targets = normalizeAuditTargets(options.targets);
  const hasScopedSelection = Boolean(options.linkIds?.length || options.section || options.itemName || options.relativePathPrefix);
  if (options.linkIds?.length) items.push({ label: "Selected links", value: `${formatNumber(options.linkIds.length)} selected` });
  if (options.itemName) items.push({ label: "Title", value: options.itemName });
  if (options.section) items.push({ label: "Folder", value: availableSections.find((section) => section.section === options.section)?.title ?? options.section });
  if (options.relativePathPrefix) items.push({ label: "Path scope", value: options.relativePathPrefix });

  if (!hasScopedSelection) {
    if (targets.includes("local")) items.push({ label: "Local folders", value: formatFolderScope(options.sections, availableSections) });
    if (targets.includes("remote")) items.push({ label: "Remote scope", value: "Remote root" });
  }

  return items;
}

function auditHistoryMetricGroups(run: AuditRunRecord, options: AuditScopeDisplayOptions | null): MetricGroupDefinition[] {
  const byteCompareSkipped = options?.byteCompare === false;
  const sourceComparisonMetrics: MetricDefinition[] = byteCompareSkipped
    ? [{ label: "Byte compare", value: "Skipped" }]
    : [
        { label: "No recorded source", value: run.sourceUnknown },
        { label: "Recorded source missing", value: run.sourceMissing },
        { label: "Source compare errors", value: run.sourceCompareErrors },
        { label: "Byte mismatches", value: run.byteMismatches }
      ];

  return [
    {
      title: "Media validation",
      description: `Files checked with the ${auditModeLabel(options?.mode ?? run.mode).toLowerCase()} audit mode. Failed total includes target validation failures, byte mismatches, and source comparison issues.`,
      metrics: [
        { label: "Checked", value: run.checked },
        { label: "Passed", value: run.passed },
        { label: "Failed total", value: run.failed },
        { label: "Target validation failures", value: run.targetValidationFailures }
      ]
    },
    {
      title: "Source comparison",
      description: byteCompareSkipped
        ? "Byte compare was skipped by audit settings; media validation still ran."
        : "Byte compare uses recorded source paths when available. No recorded source means the item was still media-validated, but bytes could not be compared.",
      metrics: sourceComparisonMetrics
    }
  ];
}

function MetricGroup({ title, description, metrics }: { title: string; description?: string; metrics: MetricDefinition[] }) {
  return (
    <section className="metric-group" aria-label={title}>
      <h3>{title}</h3>
      {description ? <p className="metric-group-description">{description}</p> : null}
      <dl>
        {metrics.map((metric) => (
          <div key={metric.label}>
            <dt>{metric.label}</dt>
            <dd>{typeof metric.value === "number" ? formatNumber(metric.value) : metric.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function IntegrationsPage() {
  return (
    <Page title="Integrations" subtitle="Automation hooks and metadata-assisted workflows will land here.">
      <section className="coming-soon-panel">
        <div>
          <Blocks size={24} />
          <h2>Coming soon</h2>
          <p>Integration-driven workflows are not active yet. Connection settings live under Settings &gt; Integrations while this page is being built out.</p>
        </div>
        <Link to="/settings/integrations" className="button-link">
          <ServerCog size={16} />
          Open integration settings
        </Link>
      </section>
    </Page>
  );
}

function IntegrationSettingsPanel() {
  return (
    <>
      <p className="section-settings-help">Integration settings are placeholders until the adapters are built. These fields are intentionally disabled and do not connect, save, sync, or run health checks yet.</p>
      <div className="integration-grid">
        {integrationPlaceholders.map((integration) => (
          <Panel key={integration.name} title={integration.name} icon={<Radar size={18} />}>
            <div className="integration-placeholder-copy">
              <p>{integration.description}</p>
              <span className="pill pill-info">Coming soon</span>
            </div>
            <fieldset className="form-grid integration-placeholder-fields" disabled aria-disabled="true">
              <label>
                Enabled
                <input type="checkbox" checked={false} readOnly />
              </label>
              <label>
                Base URL
                <input value="" readOnly placeholder={integration.urlPlaceholder} />
              </label>
              <label>
                API key
                <input value="" readOnly placeholder={integration.keyPlaceholder} />
              </label>
            </fieldset>
          </Panel>
        ))}
      </div>
      <button type="button" disabled>
        <CheckCircle2 size={16} />
        Save integrations unavailable
      </button>
    </>
  );
}

function SettingsPage({ activeView }: { activeView: SettingsView }) {
  const queryClient = useQueryClient();
  const paths = useQuery({ queryKey: ["paths"], queryFn: api.getPaths, enabled: activeView === "library" });
  const sections = useQuery({ queryKey: ["section-settings"], queryFn: api.getSections, enabled: activeView === "library" });
  const [sectionsDraft, setSectionsDraft] = useState<SectionDraft[]>([createEmptySectionDraft("section-new-0")]);
  useEffect(() => {
    if (sections.data) setSectionsDraft(sectionSettingsToDrafts(sections.data));
  }, [sections.data]);
  const saveSections = useMutation({
    mutationFn: () => api.saveSections(sectionDraftsToSettings(sectionsDraft)),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["section-settings"] });
      queryClient.invalidateQueries({ queryKey: ["sections"] });
      queryClient.invalidateQueries({ queryKey: ["scan-settings"] });
      queryClient.invalidateQueries({ queryKey: ["audit-settings"] });
    }
  });
  const sectionSettingsDraft = sectionDraftsToSettings(sectionsDraft);
  const canSaveSections = sectionSettingsDraft.sections.length > 0 && !saveSections.isPending;
  const addSectionDraft = () => {
    setSectionsDraft((drafts) => [...drafts, createEmptySectionDraft(`section-new-${Date.now()}`)]);
  };
  const subtitle =
    activeView === "library"
      ? "Name storage locations, review mounted paths, and manage library sections."
      : activeView === "integrations"
        ? "Preview planned external connection settings."
      : activeView === "advanced"
        ? "Tune job behavior and verification defaults."
        : "Manage display preferences and account access.";
  const activeTitle = activeView === "library" ? "Library" : activeView === "integrations" ? "Integrations" : activeView === "advanced" ? "Advanced" : "User settings";
  return (
    <Page title={`Settings > ${activeTitle}`} subtitle={subtitle}>
      {activeView === "library" ? (
        <>
          <StorageLocationsPanel paths={paths.data ?? { symlinkDir: "", localDir: "", remoteDir: "" }} isLoadingPaths={paths.isLoading} pathsError={paths.error?.message} />
          <Panel title="Sections" icon={<ServerCog size={18} />}>
            <div className="section-settings">
              <p className="section-settings-help">Symlink folder is the exact folder name inside the symlink directory. Type controls movie/show counting, and Library title is the display name shown in Library.</p>
              <SectionDraftList drafts={sectionsDraft} onChange={setSectionsDraft} />
              <div className="section-settings-actions">
                <button className="secondary" type="button" onClick={addSectionDraft}>
                  <Plus size={16} />
                  Add section
                </button>
                <button type="button" onClick={() => saveSections.mutate()} disabled={!canSaveSections}>
                  <CheckCircle2 size={16} />
                  Save sections
                </button>
              </div>
            </div>
          </Panel>
        </>
      ) : null}
      {activeView === "integrations" ? <IntegrationSettingsPanel /> : null}
      {activeView === "advanced" ? <AdvancedSettingsPanel /> : null}
      {activeView === "user" ? <UserSettingsPanel /> : null}
    </Page>
  );
}

function StorageLocationsPanel({ paths, isLoadingPaths, pathsError }: { paths: PathsSettings; isLoadingPaths: boolean; pathsError?: string }) {
  const queryClient = useQueryClient();
  const settings = useQuery({ queryKey: ["storage-locations"], queryFn: api.getStorageLocations });
  const [draftNames, setDraftNames] = useState<Record<StorageLocationKey, string>>({ location_1: "Local", location_2: "Remote" });
  const [message, setMessage] = useState<string | null>(null);
  const locations = settings.data?.locations ?? defaultStorageLocations.locations;

  useEffect(() => {
    if (!settings.data) return;
    setDraftNames(
      Object.fromEntries(settings.data.locations.map((location) => [location.key, location.displayName])) as Record<StorageLocationKey, string>
    );
  }, [settings.data]);

  const trimmedNames: Record<StorageLocationKey, string> = {
    location_1: draftNames.location_1.trim(),
    location_2: draftNames.location_2.trim()
  };
  const validationError =
    !trimmedNames.location_1 || !trimmedNames.location_2
      ? "Each location needs a friendly name."
      : trimmedNames.location_1.toLowerCase() === trimmedNames.location_2.toLowerCase()
        ? "Friendly names must be unique."
        : null;
  const hasChanges = locations.some((location) => trimmedNames[location.key] !== location.displayName);
  const save = useMutation({
    mutationFn: () =>
      api.saveStorageLocations({
        locations: locations.map((location) => ({ key: location.key, displayName: trimmedNames[location.key] }))
      }),
    onSuccess: (data) => {
      queryClient.setQueryData(["storage-locations"], data);
      setDraftNames(Object.fromEntries(data.locations.map((location) => [location.key, location.displayName])) as Record<StorageLocationKey, string>);
      setMessage("Friendly names saved.");
    }
  });

  function updateName(key: StorageLocationKey, value: string) {
    setMessage(null);
    save.reset();
    setDraftNames((current) => ({ ...current, [key]: value }));
  }

  return (
    <Panel title="Storage Locations" icon={<FolderCog size={18} />}>
      <div className="location-settings">
        <p id="locations-note" className="section-settings-help">
          Friendly names are used in the interface. Mounted paths remain managed through <code>.env</code> and Docker Compose.
        </p>
        {pathsError ? <p className="panel-message action-error">{pathsError}</p> : null}
        {settings.error ? <p className="panel-message action-error">{settings.error.message}</p> : null}
        <div className="location-symlink-path" aria-describedby="locations-note">
          <label className="location-path-field">
            Symlink directory
            <input value={isLoadingPaths ? "Loading..." : paths.symlinkDir} readOnly aria-readonly="true" />
          </label>
        </div>
        <div className="location-settings-list" aria-describedby="locations-note">
          {locations.map((location, index) => {
            const pathValue = location.path || (location.rootType === "local" ? paths.localDir : paths.remoteDir);
            return (
              <div key={location.key} className="location-settings-row">
                <div className="location-settings-identity">
                  <strong>Location {index + 1}</strong>
                  <span>{location.rootType === "local" ? "Local role" : "Remote role"}</span>
                </div>
                <label>
                  Friendly name
                  <input
                    value={draftNames[location.key]}
                    maxLength={40}
                    autoComplete="off"
                    aria-label={`Location ${index + 1} friendly name`}
                    onChange={(event) => updateName(location.key, event.target.value)}
                  />
                </label>
                <label className="location-path-field">
                  Mounted path
                  <input value={settings.isLoading || isLoadingPaths ? "Loading..." : pathValue} readOnly aria-readonly="true" aria-label={`Location ${index + 1} mounted path`} />
                </label>
              </div>
            );
          })}
        </div>
        <div className="location-settings-actions">
          <span aria-live="polite">
            {validationError ? <span className="action-error">{validationError}</span> : save.error ? <span className="action-error">{save.error.message}</span> : message}
          </span>
          <button type="button" onClick={() => save.mutate()} disabled={settings.isLoading || save.isPending || Boolean(validationError) || !hasChanges}>
            <CheckCircle2 size={16} />
            {save.isPending ? "Saving..." : "Save friendly names"}
          </button>
        </div>
      </div>
    </Panel>
  );
}

function AdvancedSettingsPanel() {
  const queryClient = useQueryClient();
  const settings = useQuery({ queryKey: ["advanced-settings"], queryFn: api.getAdvancedSettings });
  const [draft, setDraft] = useState<AdvancedSettings>(defaultAdvancedSettings);
  const [message, setMessage] = useState<string | null>(null);
  const savedAdvancedSettings = normalizeAdvancedSettings(settings.data ?? defaultAdvancedSettings);
  const savedCopyProfileLabel = copyProfileOptions.find((option) => option.value === savedAdvancedSettings.copy.profile)?.label ?? savedAdvancedSettings.copy.profile;
  const savedAuditModeLabel = auditModeOptions.find((option) => option.value === savedAdvancedSettings.audit.defaultMode)?.label ?? savedAdvancedSettings.audit.defaultMode;
  const validationError = draft.copy.profile === "custom" && !draft.copy.byteCompare && draft.copy.mediaValidation === "off"
    ? "Custom copy verification must keep byte compare or media validation enabled."
    : null;
  const save = useMutation({
    mutationFn: () => api.saveAdvancedSettings(draft),
    onSuccess: (data) => {
      const normalized = normalizeAdvancedSettings(data);
      queryClient.setQueryData(["advanced-settings"], normalized);
      setDraft(normalized);
      setMessage("Advanced settings saved.");
    }
  });
  useEffect(() => {
    if (settings.data) setDraft(normalizeAdvancedSettings(settings.data));
  }, [settings.data]);

  function setCopyProfile(profile: CopyVerificationProfile) {
    setMessage(null);
    setDraft((current) => ({
      ...current,
      copy: profile === "custom" ? { ...current.copy, profile } : copyBehaviorForProfile(profile)
    }));
  }

  function updateCustomCopy(patch: Partial<AdvancedSettings["copy"]>) {
    setMessage(null);
    setDraft((current) => ({ ...current, copy: { ...current.copy, ...patch, profile: "custom" } }));
  }

  function updateAuditDefaults(patch: Partial<AdvancedSettings["audit"]>) {
    setMessage(null);
    setDraft((current) => ({ ...current, audit: { ...current.audit, ...patch } }));
  }

  const copyVerificationDisabled = !draft.copy.byteCompare && draft.copy.mediaValidation === "off";
  const effectiveCopyPipeline = copyVerificationDisabled
    ? ["Transfer to temporary destination", "Confirm transferred file size", "Copy verification skipped", "Promote transferred file", "Repoint symlink"]
    : [
        "Transfer to temporary destination",
        ...(draft.copy.byteCompare ? ["Byte compare source and destination"] : ["Byte compare skipped"]),
        copyPipelineLabels[draft.copy.mediaValidation],
        "Promote verified file",
        "Repoint symlink"
      ];
  const isCustomCopyProfile = draft.copy.profile === "custom";
  const selectedMediaValidation = mediaValidationOptions.find((option) => option.value === draft.copy.mediaValidation);

  return (
    <div className="advanced-settings">
      {settings.error ? <p className="panel-message action-error">{settings.error.message}</p> : null}
        <section className="advanced-settings-section">
          <div className="advanced-settings-heading">
            <div>
              <h3>Copy verification</h3>
              <p>Controls the verification work after each transfer before a symlink is repointed.</p>
            </div>
            <span className="pill pill-info">Current: {savedCopyProfileLabel}</span>
          </div>
          <div className="advanced-option-grid">
            {copyProfileOptions.map((option) => (
              <button
                key={option.value}
                type="button"
                className={`advanced-option${draft.copy.profile === option.value ? " selected" : ""}`}
                onClick={() => setCopyProfile(option.value)}
              >
                <strong>{option.label}</strong>
                <small>{option.detail}</small>
              </button>
            ))}
          </div>
          <div className="advanced-settings-grid">
            <label className="advanced-toggle">
              <input
                type="checkbox"
                checked={draft.copy.byteCompare}
                disabled={!isCustomCopyProfile}
                onChange={(event) => updateCustomCopy({ byteCompare: event.target.checked })}
              />
              <span>
                <strong>Byte compare</strong>
                <small>Compare source and destination bytes.</small>
              </span>
            </label>
            {isCustomCopyProfile ? (
              <label className="advanced-field">
                <span>Media validation</span>
                <select value={draft.copy.mediaValidation} onChange={(event) => updateCustomCopy({ mediaValidation: event.target.value as CopyMediaValidationMode })}>
                  {mediaValidationOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label} - {option.detail}
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              <div className="advanced-field" aria-label="Media validation">
                <span>Media validation</span>
                <div className="advanced-readonly-value">
                  <strong>{selectedMediaValidation?.label ?? draft.copy.mediaValidation}</strong>
                  <small>{selectedMediaValidation?.detail ?? "Current preset value"}</small>
                </div>
              </div>
            )}
          </div>
          <div className="effective-pipeline" aria-label="Effective copy pipeline">
            <div>
              <strong>Effective pipeline</strong>
            </div>
            <ol>
              {effectiveCopyPipeline.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
          </div>
          {validationError ? <p className="panel-message action-error">{validationError}</p> : null}
        </section>

        <section className="advanced-settings-section">
          <div className="advanced-settings-heading">
            <div>
              <h3>Audit defaults</h3>
              <p>Controls the default mode used by audit prompts and whether known source files are compared.</p>
            </div>
            <span className="pill pill-info">Current: {savedAuditModeLabel}</span>
          </div>
          <div className="advanced-option-grid two-columns">
            {auditModeOptions.map((option) => (
              <button
                key={option.value}
                type="button"
                className={`advanced-option${draft.audit.defaultMode === option.value ? " selected" : ""}`}
                onClick={() => updateAuditDefaults({ defaultMode: option.value })}
              >
                <strong>{option.label}</strong>
                <small>{option.detail}</small>
              </button>
            ))}
          </div>
          <div className="advanced-settings-grid">
            <label className="advanced-toggle">
              <input
                type="checkbox"
                checked={draft.audit.byteCompareWhenSourceKnown}
                onChange={(event) => updateAuditDefaults({ byteCompareWhenSourceKnown: event.target.checked })}
              />
              <span>
                <strong>Byte compare when source is known</strong>
                <small>Skip this when media validation alone is enough.</small>
              </span>
            </label>
          </div>
        </section>

        <div className="advanced-settings-actions">
          {message ? <span className="success">{message}</span> : null}
          {save.error ? <span className="error">{save.error.message}</span> : null}
          <button type="button" onClick={() => save.mutate()} disabled={Boolean(validationError) || save.isPending || settings.isLoading}>
            <CheckCircle2 size={16} />
            Save advanced settings
          </button>
        </div>
      </div>
  );
}

function UserSettingsPanel() {
  const queryClient = useQueryClient();
  const me = useQuery({ queryKey: ["me"], queryFn: api.me });
  const userPreferences = useQuery({ queryKey: ["user-preferences"], queryFn: api.getUserPreferences });
  const currentPreferences: UserPreferences = { ...defaultUserPreferences, ...userPreferences.data };
  const [username, setUsername] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmNewPassword, setConfirmNewPassword] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [accountMessage, setAccountMessage] = useState<string | null>(null);
  const [displayMessage, setDisplayMessage] = useState<string | null>(null);
  const saveUser = useMutation({
    mutationFn: api.updateUser,
    onSuccess: (data) => {
      queryClient.setQueryData(["me"], { authenticated: true, setupRequired: false, user: data.user });
      setCurrentPassword("");
      setNewPassword("");
      setConfirmNewPassword("");
      setFormError(null);
      setAccountMessage("Account settings saved.");
    }
  });
  const saveDisplayPreferences = useMutation({
    mutationFn: api.saveUserPreferences,
    onSuccess: (preferences) => {
      queryClient.setQueryData(["user-preferences"], preferences);
      setDisplayMessage("Display settings saved.");
    }
  });

  useEffect(() => {
    if (me.data?.user?.username) setUsername(me.data.user.username);
  }, [me.data?.user?.username]);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setAccountMessage(null);
    const trimmedUsername = username.trim();
    if (!trimmedUsername) {
      setFormError("Username is required.");
      return;
    }
    if (!currentPassword) {
      setFormError("Current password is required.");
      return;
    }
    if ((newPassword || confirmNewPassword) && newPassword !== confirmNewPassword) {
      setFormError("Passwords do not match.");
      return;
    }
    if (newPassword && newPassword.length < 8) {
      setFormError("Password must be at least 8 characters.");
      return;
    }
    setFormError(null);
    saveUser.mutate({
      username: trimmedUsername,
      currentPassword,
      newPassword: newPassword || undefined,
      confirmNewPassword: confirmNewPassword || undefined
    });
  }

  const currentTimeFormat = currentPreferences.timeFormat;
  const currentAutoOpenTaskStatus = currentPreferences.autoOpenTaskStatus;
  const error = formError ?? saveUser.error?.message;
  const displayPreferenceError = userPreferences.error?.message ?? saveDisplayPreferences.error?.message;

  return (
    <>
      <Panel title="Interface preferences" icon={<Settings size={18} />}>
        <div className="display-preferences">
          <div className="preference-row">
            <div className="preference-copy">
              <strong>Time format</strong>
              <small>Controls dates and history timestamps.</small>
            </div>
            <div className="segmented compact" role="group" aria-label="Time format">
              {timeFormatOptions.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  className={currentTimeFormat === option.value ? "selected" : ""}
                  aria-pressed={currentTimeFormat === option.value}
                  disabled={userPreferences.isLoading || saveDisplayPreferences.isPending}
                  onClick={() => {
                    setDisplayMessage(null);
                    saveDisplayPreferences.mutate({ ...currentPreferences, timeFormat: option.value });
                  }}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>
          <label className="preference-toggle">
            <input
              type="checkbox"
              checked={currentAutoOpenTaskStatus}
              disabled={userPreferences.isLoading || saveDisplayPreferences.isPending}
              onChange={(event) => {
                setDisplayMessage(null);
                saveDisplayPreferences.mutate({ ...currentPreferences, autoOpenTaskStatus: event.currentTarget.checked });
              }}
            />
            <span>
              <strong>Open task status automatically</strong>
              <small>Show the live status window after starting scans, audits, or copies. Jobs stay available from Recent Jobs either way.</small>
            </span>
          </label>
          {displayMessage ? <p className="success">{displayMessage}</p> : null}
          {displayPreferenceError ? <p className="error">{displayPreferenceError}</p> : null}
        </div>
      </Panel>
      <Panel title="Account access" icon={<UserCog size={18} />}>
        <form className="account-settings-form" onSubmit={handleSubmit}>
          <div className="form-grid">
            <label>
              Username
              <input autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} />
            </label>
            <label>
              Current password
              <input autoComplete="current-password" type="password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} />
            </label>
            <label>
              New password
              <input autoComplete="new-password" type="password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} />
            </label>
            <label>
              Confirm new password
              <input autoComplete="new-password" type="password" value={confirmNewPassword} onChange={(event) => setConfirmNewPassword(event.target.value)} />
            </label>
          </div>
          <div className="form-actions">
            <button type="submit" disabled={saveUser.isPending || me.isLoading}>
              <CheckCircle2 size={16} />
              Save account changes
            </button>
            {accountMessage ? <p className="success">{accountMessage}</p> : null}
            {error ? <p className="error">{error}</p> : null}
          </div>
        </form>
      </Panel>
    </>
  );
}

function LogsPage() {
  const { timeFormat } = useUserPreferences();
  const { job: linkedJobId } = logsRoute.useSearch();
  const jobs = useQuery({ queryKey: ["jobs", "log"], queryFn: () => api.jobs(), refetchInterval: 3000 });
  const linkedJob = useQuery({ queryKey: ["job", linkedJobId], queryFn: () => api.job(linkedJobId!), enabled: Boolean(linkedJobId) });
  const sections = useQuery({ queryKey: ["sections"], queryFn: api.sections, staleTime: 30_000 });
  const [selectedJob, setSelectedJob] = useState<number | null>(linkedJobId ?? null);
  const [jobSearch, setJobSearch] = useState("");
  const [eventSearch, setEventSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<JobStatusFilter>("all");
  const [typeFilter, setTypeFilter] = useState<JobTypeFilter>("all");
  const [levelFilter, setLevelFilter] = useState<EventLevelFilter>("all");
  const jobRows = useMemo(() => {
    const rows = jobs.data ?? [];
    if (!linkedJob.data || rows.some((job) => job.id === linkedJob.data.id)) return rows;
    return [linkedJob.data, ...rows];
  }, [jobs.data, linkedJob.data]);
  const sectionRows = useMemo(() => (sections.data ?? []).map((section) => ({ section: section.section, title: section.title })), [sections.data]);

  useEffect(() => {
    if (linkedJobId) setSelectedJob(linkedJobId);
  }, [linkedJobId]);

  const filteredJobs = useMemo(
    () => jobRows.filter((job) => matchesJobFilters(job, { search: jobSearch, status: statusFilter, type: typeFilter })),
    [jobRows, jobSearch, statusFilter, typeFilter]
  );
  const effectiveJob =
    filteredJobs.find((job) => job.id === selectedJob) ??
    filteredJobs.find((job) => job.status === "running") ??
    filteredJobs.find((job) => job.status === "partially_failed") ??
    filteredJobs.find((job) => job.status === "failed") ??
    filteredJobs[0] ??
    null;
  const selectedJobActive = effectiveJob?.status === "queued" || effectiveJob?.status === "running";
  const events = useJobEventTimeline({ jobId: effectiveJob?.id, enabled: Boolean(effectiveJob), refetchInterval: selectedJobActive ? 500 : false });
  const eventRows = events.events;
  const filteredEvents = useMemo(
    () => eventRows.filter((event) => matchesEventFilters(event, { search: eventSearch, level: levelFilter })),
    [eventRows, eventSearch, levelFilter]
  );

  return (
    <Page title="Logs" subtitle="Job activity, warnings, errors, and details.">
      <div className="logs-summary">
        <LogSummaryCard label="Jobs" value={jobRows.length} />
        <LogSummaryCard label="Running" value={countJobsByStatus(jobRows, "running")} />
        <LogSummaryCard
          label="Partially failed"
          value={countJobsByStatus(jobRows, "partially_failed")}
          tone={countJobsByStatus(jobRows, "partially_failed") > 0 ? "bad" : undefined}
        />
        <LogSummaryCard label="Failed" value={countJobsByStatus(jobRows, "failed")} tone={countJobsByStatus(jobRows, "failed") > 0 ? "bad" : undefined} />
        <LogSummaryCard label="Completed" value={countJobsByStatus(jobRows, "completed")} />
      </div>
      <div className="logs-layout">
        <Panel title="Jobs" icon={<Activity size={18} />}>
          <div className="log-toolbar">
            <label className="log-search">
              <span>Search jobs</span>
              <span className="search-input">
                <Search size={15} />
                <input value={jobSearch} onChange={(event) => setJobSearch(event.target.value)} placeholder="ID, type, folder" />
              </span>
            </label>
            <LogFilterGroup
              label="Status"
              options={logStatusFilters.map((filter) => ({
                ...filter,
                count: filter.value === "all" ? jobRows.length : countJobsByStatus(jobRows, filter.value)
              }))}
              value={statusFilter}
              onChange={setStatusFilter}
            />
            <LogFilterGroup
              label="Type"
              options={logTypeFilters.map((filter) => ({
                ...filter,
                count: filter.value === "all" ? jobRows.length : countJobsByType(jobRows, filter.value)
              }))}
              value={typeFilter}
              onChange={setTypeFilter}
            />
          </div>
          {jobs.isLoading ? <p className="panel-message">Loading jobs...</p> : null}
          {jobs.error ? <p className="panel-message action-error">{jobs.error.message}</p> : null}
          {linkedJob.error ? <p className="panel-message action-error">{linkedJob.error.message}</p> : null}
          {!jobs.isLoading && !jobs.error && filteredJobs.length === 0 ? <p className="panel-message">No jobs match the current filters.</p> : null}
          {filteredJobs.length > 0 ? (
            <div className="log-job-list">
              {filteredJobs.map((job) => (
                <LogJobButton key={job.id} job={job} selected={effectiveJob?.id === job.id} sections={sectionRows} timeFormat={timeFormat} onSelect={() => setSelectedJob(job.id)} />
              ))}
            </div>
          ) : null}
        </Panel>
        <Panel title={effectiveJob ? `Job #${effectiveJob.id} events` : "Events"} icon={<FileText size={18} />}>
          {effectiveJob ? <SelectedLogJobSummary job={effectiveJob} sections={sectionRows} timeFormat={timeFormat} /> : <p className="panel-message">No job selected.</p>}
          {effectiveJob ? (
            <div className="log-toolbar event-toolbar">
              <label className="log-search">
                <span>Search events</span>
                <span className="search-input">
                  <Search size={15} />
                  <input value={eventSearch} onChange={(event) => setEventSearch(event.target.value)} placeholder="Message or path" />
                </span>
              </label>
              <LogFilterGroup
                label="Level"
                options={logLevelFilters.map((filter) => ({
                  ...filter,
                  count: filter.value === "all" ? eventRows.length : countEventsByLevel(eventRows, filter.value)
                }))}
                value={levelFilter}
                onChange={setLevelFilter}
              />
            </div>
          ) : null}
          {effectiveJob ? (
            <div className="log-event-pagination">
              <span>{events.isLoading ? "Loading events..." : jobEventCountLabel(eventRows.length, events.total)}</span>
              {events.hasNextPage ? (
                <button type="button" className="secondary" disabled={events.isFetchingNextPage} onClick={() => void events.fetchNextPage()}>
                  <ArrowUp size={14} />
                  {events.isFetchingNextPage ? "Loading older events..." : "Load older events"}
                </button>
              ) : null}
            </div>
          ) : null}
          {events.isLoading ? <p className="panel-message">Loading events...</p> : null}
          {events.error ? <p className="panel-message action-error">{events.error.message}</p> : null}
          {effectiveJob && !events.isLoading && !events.error && filteredEvents.length === 0 ? <p className="panel-message">No events match the current filters.</p> : null}
          {filteredEvents.length > 0 ? (
            <div className="events">
              {filteredEvents.map((event) => (
                <LogEventRow key={event.id} event={event} timeFormat={timeFormat} job={effectiveJob} />
              ))}
            </div>
          ) : null}
        </Panel>
      </div>
    </Page>
  );
}

const logStatusFilters: Array<{ value: JobStatusFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "running", label: "Running" },
  { value: "partially_failed", label: "Partially failed" },
  { value: "failed", label: "Failed" },
  { value: "completed", label: "Done" },
  { value: "queued", label: "Queued" },
  { value: "cancelled", label: "Cancelled" }
];

const logTypeFilters: Array<{ value: JobTypeFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "scan", label: "Scans" },
  { value: "audit", label: "Audits" },
  { value: "copy", label: "Copies" },
  { value: "path_migration", label: "Path migrations" },
];

const logLevelFilters: Array<{ value: EventLevelFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "error", label: "Errors" },
  { value: "warn", label: "Warnings" },
  { value: "info", label: "Info" }
];

function LogSummaryCard({ label, value, tone }: { label: string; value: number; tone?: "bad" }) {
  return (
    <div className={`log-summary-card${tone ? ` log-summary-card-${tone}` : ""}`}>
      <span>{label}</span>
      <strong>{formatNumber(value)}</strong>
    </div>
  );
}

function LogFilterGroup<T extends string>({
  label,
  options,
  value,
  onChange
}: {
  label: string;
  options: Array<{ value: T; label: string; count: number }>;
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div className="log-filter-group" aria-label={`${label} filter`}>
      <span>{label}</span>
      <div className="segmented compact">
        {options.map((option) => (
          <button key={option.value} type="button" className={value === option.value ? "selected" : ""} onClick={() => onChange(option.value)}>
            {option.label}
            <small>{formatNumber(option.count)}</small>
          </button>
        ))}
      </div>
    </div>
  );
}

function LogJobButton({
  job,
  selected,
  sections,
  timeFormat,
  onSelect
}: {
  job: JobRecord;
  selected: boolean;
  sections: Array<{ section: string; title?: string | null }>;
  timeFormat: TimeFormatPreference;
  onSelect: () => void;
}) {
  return (
    <button type="button" className={`log-job-card${selected ? " selected" : ""}`} onClick={onSelect}>
      <span className="log-job-card-main">
        <span>
          <strong>#{job.id}</strong>
          <span>{formatJobType(job.type)}</span>
        </span>
        <StatusPill value={job.status} />
      </span>
      <span className="log-job-card-meta">
        <span>{formatDate(job.startedAt ?? job.createdAt, timeFormat)}</span>
        <span>{jobDurationLabel(job)}</span>
      </span>
      <JobScope job={job} sections={sections} />
      <LogChipList chips={jobProgressChips(job, 4)} />
    </button>
  );
}

function SelectedLogJobSummary({ job, sections, timeFormat }: { job: JobRecord; sections: Array<{ section: string; title?: string | null }>; timeFormat: TimeFormatPreference }) {
  return (
    <div className="selected-log-job">
      <div className="selected-log-job-main">
        <div>
          <strong>{formatJobType(job.type)}</strong>
          <span>#{job.id}</span>
        </div>
        <StatusPill value={job.status} />
      </div>
      <dl className="selected-log-job-details">
        <div>
          <dt>Started</dt>
          <dd>{formatDate(job.startedAt, timeFormat)}</dd>
        </div>
        <div>
          <dt>Finished</dt>
          <dd>{formatDate(job.finishedAt, timeFormat)}</dd>
        </div>
        <div>
          <dt>Duration</dt>
          <dd>{jobDurationLabel(job)}</dd>
        </div>
      </dl>
      <div className="selected-log-job-scope">
        <JobScope job={job} sections={sections} />
      </div>
      {job.type === "scan" ? <ScanProgressPanel job={job} compact /> : null}
      {job.type === "audit" ? <AuditProgressPanel job={job} compact /> : null}
      {job.type === "copy" ? <CopyProgressPanel job={job} compact /> : null}
      <LogChipList chips={jobProgressChips(job)} />
    </div>
  );
}

type CopyProgressView = {
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

function copyProgressFromJob(job: JobRecord | null): CopyProgressView {
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

function copyCompletedCount(progress: Pick<CopyProgressView, "copied" | "repointed" | "skipped" | "conflicts" | "failed">): number {
  return progress.copied + progress.repointed + progress.skipped + progress.conflicts + progress.failed;
}

function copySymlinkedCount(progress: Pick<CopyProgressView, "copied" | "repointed">): number {
  return progress.copied + progress.repointed;
}

function copyStageFraction(stage: string): number {
  if (stage === "preparing" || stage === "queued") return 0.05;
  if (stage === "copying") return 0.35;
  if (stage === "verifying") return 0.75;
  if (stage === "symlinking") return 0.9;
  if (stage === "done" || stage === "skipped" || stage === "conflict" || stage === "partially_failed" || stage === "failed") return 1;
  if (stage === "completed" || stage === "cancelled") return 1;
  return 0;
}

function copyStageHasByteProgress(stage: string): boolean {
  return stage === "copying" || stage === "verifying";
}

function copyStageBytes(progress: Pick<CopyProgressView, "stage" | "bytesCopied" | "bytesProcessed">): number | null {
  if (progress.stage === "copying") return progress.bytesCopied ?? progress.bytesProcessed;
  if (progress.stage === "verifying") return progress.bytesProcessed ?? progress.bytesCopied;
  return null;
}

function copyStagePercent(job: JobRecord | null, progress: CopyProgressView): number {
  if (job?.status === "completed") return 100;
  if (job?.status === "partially_failed" || job?.status === "failed" || job?.status === "cancelled") return Math.round(copyStageFraction(progress.stage) * 100);
  const stageBytes = copyStageBytes(progress);
  if (copyStageHasByteProgress(progress.stage) && progress.totalBytes && progress.totalBytes > 0 && stageBytes != null) {
    return Math.min(99, Math.max(0, Math.round((stageBytes / progress.totalBytes) * 100)));
  }
  return Math.round(copyStageFraction(progress.stage) * 100);
}

function copyStageLabel(stage: string, direction?: CopyOptions["direction"] | null): string {
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

function copyOverallProgressPercent(job: JobRecord | null, progress: CopyProgressView): number {
  if (progress.total <= 0) return job?.status === "completed" ? 100 : 0;
  const completed = copyCompletedCount(progress);
  if (job?.status === "completed") return 100;
  if (job?.status === "partially_failed" || job?.status === "failed" || job?.status === "cancelled") return Math.min(100, Math.round((completed / progress.total) * 100));
  const activeItemBase = progress.current > completed ? Math.max(0, progress.current - 1) : completed;
  const activeProgress = progress.current > completed ? copyItemFraction(progress) : 0;
  return Math.min(99, Math.round(((activeItemBase + activeProgress) / progress.total) * 100));
}

function copyItemFraction(progress: CopyProgressView): number {
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

function formatDurationMs(elapsedMs: number): string {
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

function useLiveTimestamp(active: boolean, intervalMs = 500): number {
  const [timestamp, setTimestamp] = useState(() => Date.now());

  useEffect(() => {
    setTimestamp(Date.now());
    if (!active) return undefined;
    const interval = window.setInterval(() => setTimestamp(Date.now()), intervalMs);
    return () => window.clearInterval(interval);
  }, [active, intervalMs]);

  return timestamp;
}

function copyElapsedLabel(job: JobRecord | null, currentTime = Date.now()): string {
  const startedAt = Date.parse(job?.startedAt ?? "");
  if (!Number.isFinite(startedAt)) return job?.status === "queued" ? "Queued" : "-";
  const finishedAt = job?.finishedAt ? Date.parse(job.finishedAt) : currentTime;
  return formatDurationMs(finishedAt - startedAt);
}

function copyRemainingLabel(job: JobRecord | null, progress: CopyProgressView, overallPercent: number): string {
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

function copyTransferSpeedLabel(progress: CopyProgressView): string {
  if (!copyStageHasByteProgress(progress.stage)) return "-";
  if (!progress.bytesPerSecond || progress.bytesPerSecond <= 0) return "-";
  return `${formatBytes(Math.round(progress.bytesPerSecond))}/s`;
}

function formatMegabitsPerSecond(bytesPerSecond: number): string {
  const megabitsPerSecond = (bytesPerSecond * 8) / 1_000_000;
  const precision = megabitsPerSecond >= 100 ? 0 : megabitsPerSecond >= 10 ? 1 : 2;
  return `${megabitsPerSecond.toFixed(precision)} Mbps`;
}

function copyTransferSpeedSecondaryLabel(progress: CopyProgressView): string | null {
  if (progress.stage !== "copying") return null;
  if (!progress.bytesPerSecond || progress.bytesPerSecond <= 0) return null;
  return formatMegabitsPerSecond(progress.bytesPerSecond);
}

function copyThroughputLabel(progress: CopyProgressView): string {
  if (progress.stage === "verifying") return "Verify speed";
  if (progress.stage === "copying") return "Transfer speed";
  return "Speed";
}

function basenameFromPath(value: string | null | undefined): string | null {
  const normalized = value?.trim().replace(/\\/g, "/");
  if (!normalized) return null;
  return normalized.split("/").filter(Boolean).pop() ?? normalized;
}

function copyCurrentItem(progress: CopyProgressView, job: JobRecord | null): { title: string; fileName: string | null; detail: string } {
  const fileName = basenameFromPath(progress.currentFile) ?? basenameFromPath(progress.sourcePath) ?? basenameFromPath(progress.destinationPath);
  const title = progress.currentTitle ?? fileName ?? (job ? "Waiting for current item" : "Waiting for copy job");
  return {
    title,
    fileName: fileName && fileName !== title ? fileName : null,
    detail: progress.message ?? "Waiting for worker progress."
  };
}

function CopyProgressPanel({ job, pendingJobId, isStarting = false, compact = false }: { job: JobRecord | null; pendingJobId?: number | null; isStarting?: boolean; compact?: boolean }) {
  const progress = copyProgressFromJob(job);
  const completed = copyCompletedCount(progress);
  const symlinked = copySymlinkedCount(progress);
  const stagePercent = copyStagePercent(job, progress);
  const overallPercent = copyOverallProgressPercent(job, progress);
  const currentIndex = progress.current > 0 ? progress.current : completed;
  const currentItem = copyCurrentItem(progress, job);
  const statusLabel = isStarting ? "Starting" : copyStageLabel(progress.stage, progress.direction);
  const countLabel = progress.total > 0 ? `${formatNumber(Math.min(Math.max(currentIndex, completed), progress.total))} / ${formatNumber(progress.total)}` : "No matching files";
  const transferSpeedSecondary = copyTransferSpeedSecondaryLabel(progress);
  const throughputLabel = copyThroughputLabel(progress);
  return (
    <div className={`audit-progress-panel copy-progress-panel${compact ? " compact" : ""}`}>
      <div className="audit-progress-header copy-progress-header">
        <span>
          <strong>{statusLabel}</strong>
          {job ? <StatusPill value={job.status} /> : null}
          {!job && pendingJobId ? <span className="copy-progress-job-id">Job #{pendingJobId}</span> : null}
        </span>
        <small>{countLabel}</small>
      </div>
      <div className="copy-progress-bars">
        <div className="copy-progress-meter">
          <div className="copy-progress-meter-header">
            <span>{statusLabel}</span>
            <strong>{stagePercent}%</strong>
          </div>
          <div className="audit-progress-track copy-progress-track copy-step-track" aria-label="Current copy step progress">
            <span style={{ width: `${stagePercent}%` }} />
          </div>
        </div>
        <div className="copy-progress-meter">
          <div className="copy-progress-meter-header">
            <span>Overall job</span>
            <strong>{overallPercent}%</strong>
          </div>
          <div className="audit-progress-track copy-progress-track copy-overall-track" aria-label="Overall copy job progress">
            <span style={{ width: `${overallPercent}%` }} />
          </div>
        </div>
      </div>
      <div className="copy-current-file">
        <File size={15} />
        <span>
          <strong>{currentItem.title}</strong>
          {currentItem.fileName ? <small className="copy-current-file-name">{currentItem.fileName}</small> : null}
          <small>{currentItem.detail}</small>
        </span>
      </div>
      <div className="audit-progress-stats copy-progress-stats">
        <span>
          <strong>{formatNumber(progress.copied)}</strong>
          Copied
        </span>
        <span>
          <strong>{formatNumber(symlinked)}</strong>
          Symlinked
        </span>
        <span>
          <strong>{formatNumber(progress.repointed)}</strong>
          Matched existing
        </span>
        <span>
          <strong>{formatNumber(progress.conflicts)}</strong>
          Conflicts
        </span>
        <span className={progress.failed > 0 ? "copy-progress-stat-bad" : undefined}>
          <strong>{formatNumber(progress.failed)}</strong>
          Failed
        </span>
        <span>
          <strong>{copyTransferSpeedLabel(progress)}</strong>
          {transferSpeedSecondary ? <small>{transferSpeedSecondary}</small> : null}
          {throughputLabel}
        </span>
        <span>
          <strong>{copyElapsedLabel(job)}</strong>
          Running
        </span>
        <span>
          <strong>{copyRemainingLabel(job, progress, overallPercent)}</strong>
          Remaining
        </span>
        <span>
          <strong>{progress.sizeBytes == null ? "-" : formatBytes(progress.sizeBytes)}</strong>
          Current size
        </span>
      </div>
    </div>
  );
}

function CopyLogEventRow({ event, timeFormat }: { event: JobEventRecord; timeFormat: TimeFormatPreference }) {
  const record = recordFromUnknown(event.data);
  const fileName = basenameFromPath(typeof record?.currentFile === "string" ? record.currentFile : typeof record?.sourcePath === "string" ? record.sourcePath : null);
  const chips = copyEventChips(record);
  return (
    <article className={`event event-${event.level} copy-event`}>
      <div className="event-header">
        <span>{formatTime(event.timestamp, timeFormat)}</span>
        <StatusPill value={formatEventLevel(event.level)} />
      </div>
      <strong>{event.message}</strong>
      {fileName ? (
        <small className="copy-event-file">
          <File size={13} />
          <span>{fileName}</span>
        </small>
      ) : null}
      <LogChipList chips={chips} />
      {hasLogData(event.data) ? (
        <details className="event-details">
          <summary>Raw details</summary>
          <pre>{formatLogData(event.data)}</pre>
        </details>
      ) : null}
    </article>
  );
}

function copyEventChips(record: Record<string, unknown> | null): Array<{ label: string; value: string }> {
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

function LogEventRow({ event, timeFormat, job }: { event: JobEventRecord; timeFormat: TimeFormatPreference; job?: JobRecord | null }) {
  const chips = eventDataChips(event.data, 7, job?.type === "scan" ? scanOptionsFromJob(job) : job?.type === "audit" ? auditOptionsFromJob(job) : null);
  return (
    <article className={`event event-${event.level}`}>
      <div className="event-header">
        <span>{formatTime(event.timestamp, timeFormat)}</span>
        <StatusPill value={formatEventLevel(event.level)} />
      </div>
      <strong>{event.message}</strong>
      <LogChipList chips={chips} />
      {hasLogData(event.data) ? (
        <details className="event-details">
          <summary>Raw details</summary>
          <pre>{formatLogData(event.data)}</pre>
        </details>
      ) : null}
    </article>
  );
}

function LogChipList({ chips }: { chips: Array<{ label: string; value: string }> }) {
  if (chips.length === 0) return null;
  return (
    <div className="log-chip-list">
      {chips.map((chip) => (
        <span key={`${chip.label}-${chip.value}`} className="log-chip">
          <span>{chip.label}</span>
          <strong>{chip.value}</strong>
        </span>
      ))}
    </div>
  );
}

function countJobsByStatus(jobs: JobRecord[], status: JobStatus): number {
  return jobs.filter((job) => job.status === status).length;
}

function countJobsByType(jobs: JobRecord[], type: JobType): number {
  return jobs.filter((job) => job.type === type).length;
}

function countEventsByLevel(events: JobEventRecord[], level: JobEventRecord["level"]): number {
  return events.filter((event) => event.level === level).length;
}

function jobDurationLabel(job: JobRecord): string {
  if (!job.startedAt) return job.status === "queued" ? "Queued" : "-";
  if (!job.finishedAt) return job.status === "running" ? "Running" : "In progress";
  return formatDuration(job.startedAt, job.finishedAt);
}

function recordFromUnknown(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function finiteNumberFromUnknown(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function finiteNullableNumberFromUnknown(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

type AuditProgressView = {
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

function auditProgressFromJob(job: JobRecord | null, auditRun?: AuditRunRecord | null): AuditProgressView {
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

function auditStageLabel(stage: string, status?: JobStatus | null): string {
  if (status === "completed" || stage === "completed") return "Completed";
  if (status === "failed" || stage === "failed") return "Failed";
  if (status === "cancelled" || stage === "cancelled") return "Cancelled";
  if (stage === "queued") return "Queued";
  if (stage === "auditing" || stage === "running") return "Auditing media";
  return "Waiting";
}

function auditProgressPercent(job: JobRecord | null, progress: AuditProgressView): number {
  if (job?.status === "completed" || progress.stage === "completed") return 100;
  if (job?.status === "failed" || job?.status === "cancelled") return 100;
  if (progress.total > 0) return Math.min(100, Math.round((progress.checked / progress.total) * 100));
  return job?.status === "queued" ? 5 : job?.status === "running" ? 35 : 0;
}

function auditStatusDetail(job: JobRecord | null, progress: AuditProgressView): string {
  if (!job) return "Loading audit job status.";
  if (job.status === "queued") return "Waiting for a worker to start this audit.";
  if (job.status === "running") return progress.message ?? "Reading media and recording validation results.";
  if (job.status === "completed") return "Audit finished and results were indexed.";
  if (job.status === "failed") return progress.message ?? "Audit failed.";
  if (job.status === "cancelled") return "Audit was cancelled.";
  return progress.message ?? "Waiting for audit progress.";
}

function AuditProgressPanel({
  job,
  pendingJobId,
  auditRun,
  compact = false
}: {
  job: JobRecord | null;
  pendingJobId?: number | null;
  auditRun?: AuditRunRecord | null;
  compact?: boolean;
}) {
  const progress = auditProgressFromJob(job, auditRun);
  const statusLabel = auditStageLabel(progress.stage, job?.status);
  const progressPercent = auditProgressPercent(job, progress);
  const countLabel = progress.total > 0 ? `${formatNumber(progress.checked)} / ${formatNumber(progress.total)}` : pendingJobId ? "Waiting for audit progress" : "Not started";
  const currentFile = basenameFromPath(progress.currentFile);
  const detail = progress.currentTitle ?? currentFile ?? auditStatusDetail(job, progress);
  return (
    <div className={`audit-progress-panel copy-progress-panel${compact ? " compact" : ""}`}>
      <div className="audit-progress-header copy-progress-header">
        <span>
          <strong>{statusLabel}</strong>
          {job ? <StatusPill value={job.status} /> : null}
          {!job && pendingJobId ? <span className="copy-progress-job-id">Job #{pendingJobId}</span> : null}
        </span>
        <small>{countLabel}</small>
      </div>
      <div className="copy-progress-bars">
        <div className="copy-progress-meter">
          <div className="copy-progress-meter-header">
            <span>Audit progress</span>
            <strong>{progressPercent}%</strong>
          </div>
          <div className="audit-progress-track copy-progress-track" aria-label="Audit progress">
            <span style={{ width: `${progressPercent}%` }} />
          </div>
        </div>
      </div>
      <div className="copy-current-file scan-current-phase">
        <Activity size={15} />
        <span>
          <strong>{detail}</strong>
          <small>{progress.currentTitle && currentFile ? currentFile : auditStatusDetail(job, progress)}</small>
        </span>
      </div>
      <div className="audit-progress-stats copy-progress-stats">
        <span>
          <strong>{formatNumber(progress.checked)}</strong>
          Checked
        </span>
        <span>
          <strong>{formatNumber(progress.passed)}</strong>
          Passed
        </span>
        <span>
          <strong>{formatNumber(progress.failed)}</strong>
          Failed
        </span>
        <span>
          <strong>{formatNumber(progress.sourceUnknown)}</strong>
          No recorded source
        </span>
        <span>
          <strong>{formatNumber(progress.sourceMissing)}</strong>
          Recorded source missing
        </span>
        <span>
          <strong>{formatNumber(progress.sourceCompareErrors)}</strong>
          Source compare errors
        </span>
        <span>
          <strong>{formatNumber(progress.byteMismatches)}</strong>
          Byte mismatches
        </span>
        <span>
          <strong>{job ? jobDurationLabel(job) : "-"}</strong>
          Duration
        </span>
      </div>
      {job ? <LogChipList chips={jobProgressChips(job, 8)} /> : null}
    </div>
  );
}

type ScanProgressView = InventorySummary & {
  stage: string;
  message: string | null;
  scanActivity: string | null;
  currentSection: string | null;
  discoveredLinks: number;
  checkedLinks: number;
  completedWorkUnits: number;
  totalWorkUnits: number;
};

function scanProgressFromJob(job: JobRecord | null): ScanProgressView {
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

function scanStageLabel(stage: string, status?: JobStatus | null): string {
  if (status === "completed" || stage === "completed") return "Completed";
  if (status === "failed" || stage === "failed") return "Failed";
  if (status === "cancelled" || stage === "cancelled") return "Cancelled";
  if (stage === "queued") return "Queued";
  if (stage === "indexing") return "Writing inventory";
  if (stage === "scanning" || stage === "running") return "Scanning inventory";
  return "Waiting";
}

function scanStagePercent(job: JobRecord | null, progress: ScanProgressView): number {
  if (job?.status === "completed") return 100;
  if (job?.status === "failed" || job?.status === "cancelled") return 100;
  if (progress.stage === "indexing") return 85;
  if (progress.stage === "scanning" || progress.stage === "running") return 45;
  if (progress.stage === "queued") return 5;
  return job?.status === "running" ? 45 : 0;
}

function scanOptionsFromProgress(job: JobRecord | null): Partial<ScanOptions> {
  if (!job || job.type !== "scan") return {};
  return scanOptionsFromJob(job) ?? {};
}

function scanVisiblePolicyNeededCount(progress: ScanProgressView, options: Partial<ScanOptions>): number {
  return (
    (options.scanSymlinks ? progress.unassignedRemoteLinks + progress.unassignedLocalLinks : 0) +
    (options.scanRemote ? progress.unassignedRemoteFiles : 0) +
    (options.scanLocal ? progress.unassignedLocalFiles : 0)
  );
}

function scanPolicyResultStats(
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

function scanVisibleStats(
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

function onboardingScanVisibleStats(
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

function scanVisibleIndexedItemCount(progress: ScanProgressView, options: Partial<ScanOptions>): number {
  return (options.scanSymlinks ? progress.totalLinks : 0) + (options.scanLocal ? progress.localFiles : 0) + (options.scanRemote ? progress.remoteFiles : 0);
}

function scanStatusDetail(job: JobRecord | null, progress: ScanProgressView): string {
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

function ScanProgressPanel({
  job,
  pendingJobId,
  compact = false,
  presentation = "standard",
  locationNames
}: {
  job: JobRecord | null;
  pendingJobId?: number | null;
  compact?: boolean;
  presentation?: "standard" | "onboarding";
  locationNames?: { local: string; remote: string };
}) {
  const storageLocations = useStorageLocations();
  const liveTimestamp = useLiveTimestamp(job?.status === "running");
  const progress = scanProgressFromJob(job);
  const options = scanOptionsFromProgress(job);
  const localName = locationNames?.local ?? storageLocationName(storageLocations, "local");
  const remoteName = locationNames?.remote ?? storageLocationName(storageLocations, "remote");
  const statusLabel = scanStageLabel(progress.stage, job?.status);
  const stagePercent = scanStagePercent(job, progress);
  const indexedItems = scanVisibleIndexedItemCount(progress, options);
  const scanLive = job?.status === "running" && progress.stage === "scanning";
  const inventoryReady = progress.stage === "indexing" || progress.stage === "completed" || job?.status === "completed";
  const includePolicyResults = progress.stage === "completed" || job?.status === "completed";
  const countLabel =
    scanLive && progress.discoveredLinks > 0
      ? `${formatNumber(progress.checkedLinks)} checked / ${formatNumber(progress.discoveredLinks)} found`
      : indexedItems > 0
        ? `${formatNumber(indexedItems)} indexed items`
        : job?.status === "queued"
          ? "Waiting for worker"
          : "Waiting for counts";
  const phaseProgressLabel =
    scanLive && progress.totalWorkUnits > 0
      ? `${formatNumber(progress.completedWorkUnits)} / ${formatNumber(progress.totalWorkUnits)} folders`
      : scanLive
        ? "Live"
        : `${stagePercent}%`;
  const detail = progress.message ?? scanStatusDetail(job, progress);
  const stats =
    presentation === "onboarding"
      ? onboardingScanVisibleStats(progress, options, inventoryReady, includePolicyResults, localName, remoteName)
      : scanVisibleStats(progress, options, includePolicyResults, localName, remoteName);
  return (
    <div className={`audit-progress-panel copy-progress-panel scan-progress-panel${compact ? " compact" : ""}`}>
      <div className="audit-progress-header copy-progress-header">
        <span>
          <strong>{statusLabel}</strong>
          {job ? <StatusPill value={job.status} /> : null}
          {!job && pendingJobId ? <span className="copy-progress-job-id">Job #{pendingJobId}</span> : null}
        </span>
        <small>{countLabel}</small>
      </div>
      <div className="copy-progress-bars">
        <div className="copy-progress-meter">
          <div className="copy-progress-meter-header">
            <span>Current phase</span>
            <strong>{phaseProgressLabel}</strong>
          </div>
          <div className={`audit-progress-track copy-progress-track scan-progress-track${scanLive ? " is-live" : ""}`} aria-label="Current scan phase progress">
            <span style={scanLive ? undefined : { width: `${stagePercent}%` }} />
          </div>
        </div>
      </div>
      <div className="copy-current-file scan-current-phase">
        <Search size={15} />
        <span>
          <strong>{statusLabel}</strong>
          <small>{detail}</small>
        </span>
      </div>
      <div className="audit-progress-stats copy-progress-stats scan-progress-stats">
        {stats.map((stat) => (
          <span key={stat.label}>
            <strong>{formatNumber(stat.value)}</strong>
            {stat.label}
          </span>
        ))}
        <span>
          <strong>{copyElapsedLabel(job, liveTimestamp)}</strong>
          Duration
        </span>
      </div>
      {job && presentation === "standard" ? <LogChipList chips={jobProgressChips(job, 8)} /> : null}
    </div>
  );
}

function selectedAllFolders(sections: string[], availableSections: Array<{ section: string; title?: string | null }>): boolean {
  if (availableSections.length === 0 || sections.length !== availableSections.length) return false;
  const selected = new Set(sections);
  return availableSections.every((section) => selected.has(section.section));
}

function formatFolderScope(sections: string[] | undefined, availableSections: Array<{ section: string; title?: string | null }>): string {
  if (sections == null) return "All folders";
  if (sections.length === 0) return "No folders";
  if (selectedAllFolders(sections, availableSections)) return "All folders";

  const titleBySection = new Map(availableSections.map((section) => [section.section, sectionDisplayTitle(section)]));
  return sections.map((section) => titleBySection.get(section) ?? section).join(", ");
}

function formatScopedFolderParts(parts: Array<{ label: string; folders: string }>): string {
  if (parts.length === 0) return "No folders";
  const uniqueFolderLabels = new Set(parts.map((part) => part.folders));
  if (uniqueFolderLabels.size === 1) return parts[0]?.folders ?? "No folders";
  return parts.map((part) => `${part.label}: ${part.folders}`).join(" / ");
}

function formatTitleScanScope(titleScopes: ScanTitleScope[], availableSections: Array<{ section: string; title?: string | null }>): string {
  const titleBySection = new Map(availableSections.map((section) => [section.section, sectionDisplayTitle(section)]));
  const labels = titleScopes.map((scope) => `${titleBySection.get(scope.section) ?? scope.section} / ${scope.itemName}`);
  if (labels.length <= 2) return labels.join(", ");
  return `${labels.slice(0, 2).join(", ")} +${labels.length - 2}`;
}

function formatTitleScanJobDetail(titleScopes: ScanTitleScope[], availableSections: Array<{ section: string; title?: string | null }>): string {
  const titleBySection = new Map(availableSections.map((section) => [section.section, sectionDisplayTitle(section)]));
  const labels = titleScopes.map((scope) => `${scope.itemName} - ${titleBySection.get(scope.section) ?? scope.section}`);
  if (labels.length <= 2) return labels.join(", ");
  return `${labels.slice(0, 2).join(", ")} +${labels.length - 2}`;
}

function scanScopeLabels(options: Partial<ScanOptions>): string[] {
  return [
    options.scanSymlinks ? "Symlinks" : null,
    options.scanLocal ? "Local files" : null,
    options.scanRemote ? "Remote files" : null
  ].filter((scope): scope is string => Boolean(scope));
}

function scanFolderScopeParts(options: Partial<ScanOptions>, availableSections: Array<{ section: string; title?: string | null }>): Array<{ label: string; folders: string }> {
  return [
    options.scanSymlinks ? { label: "Symlinks", folders: formatFolderScope(options.symlinkSections ?? options.sections, availableSections) } : null,
    options.scanLocal ? { label: "Local", folders: formatFolderScope(options.localSections ?? options.sections, availableSections) } : null,
    options.scanRemote ? { label: "Remote", folders: "All folders" } : null
  ].filter((part): part is { label: string; folders: string } => Boolean(part));
}

function formatScanScope(options: Partial<ScanOptions> | null, availableSections: Array<{ section: string; title?: string | null }>): string {
  if (!options) return "Inventory scan";
  if (options.titleScopes?.length) return `Title rescan - ${formatTitleScanScope(options.titleScopes, availableSections)}`;
  const scopes = scanScopeLabels(options);
  const folderText = formatScopedFolderParts(scanFolderScopeParts(options, availableSections));
  return scopes.length > 0 ? `${scopes.join(", ")} - ${folderText}` : folderText;
}

type AuditScopeDisplayOptions = Omit<Partial<AuditOptions>, "mode"> & { mode?: AuditMode | null };

function formatAuditScope(options: AuditScopeDisplayOptions, availableSections: Array<{ section: string; title?: string | null }>): string {
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

function formatCopyScope(options: CopyOptions | null, availableSections: Array<{ section: string; title?: string | null }>): string {
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

function selectedLinkIdsFromJob(job: JobRecord): number[] {
  if (job.type === "copy") return copyOptionsFromJob(job)?.linkIds ?? [];
  if (job.type === "audit") return auditOptionsFromJob(job).linkIds ?? [];
  return [];
}

function selectedLinkIdsFromJobs(jobs: JobRecord[]): number[] {
  const ids = new Set<number>();
  for (const job of jobs) {
    for (const id of selectedLinkIdsFromJob(job)) ids.add(id);
  }
  return [...ids].sort((first, second) => first - second);
}

function selectedLinkTitleSummaries(linkIds: number[], linkRowsById: Map<number, MediaLinkRow> | undefined): string[] {
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

function copyPromptFromJob(
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

function scanStatusPromptFromJob(job: JobRecord, availableSections: Array<{ section: string; title?: string | null }>): ScanStatusPrompt {
  const options = scanOptionsFromJob(job);
  return {
    key: `scan-job-${job.id}`,
    title: options?.titleScopes?.length ? "Title rescan" : "Inventory scan",
    description: formatScanScope(options, availableSections),
    jobId: job.id
  };
}

function scanStatusPromptFromRun(run: ScanRunRecord, availableSections: Array<{ section: string; title?: string | null }>): ScanStatusPrompt {
  return {
    key: `scan-run-${run.id ?? run.jobId}`,
    title: run.options?.titleScopes?.length ? "Title rescan" : "Inventory scan",
    description: run.options ? formatScanScope(run.options, availableSections) : run.id == null ? "No scan run record was created" : `Scan #${run.id}`,
    jobId: run.jobId
  };
}

function auditStatusPromptFromJob(job: JobRecord, availableSections: Array<{ section: string; title?: string | null }>): AuditStatusPrompt {
  const options = auditOptionsFromJob(job);
  const modeText = options.mode === "deep" ? "Deep audit" : "Fast audit";
  return {
    key: `audit-job-${job.id}`,
    title: modeText,
    description: formatAuditScope(options, availableSections),
    jobId: job.id
  };
}

function auditStatusPromptFromRun(run: AuditRunRecord, availableSections: Array<{ section: string; title?: string | null }>): AuditStatusPrompt {
  return {
    key: `audit-run-${run.id}`,
    title: run.mode === "deep" ? "Deep audit" : "Fast audit",
    description: run.options ? formatAuditScope(run.options, availableSections) : `Audit #${run.id}`,
    jobId: run.jobId,
    auditRunId: run.id
  };
}

function copyPromptKey(options: CopyOptions): string {
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

function JobScope({
  job,
  sections,
  linkRowsById,
  linkRowsLoading,
  linkRowsError
}: {
  job: JobRecord;
  sections: Array<{ section: string; title?: string | null }>;
  linkRowsById?: Map<number, MediaLinkRow>;
  linkRowsLoading?: boolean;
  linkRowsError?: string | null;
}) {
  const storageLocations = useStorageLocations();
  if (job.type === "scan") {
    const options = scanOptionsFromJob(job);
    if (!options) return <span className="muted-cell">-</span>;
    if (options.titleScopes?.length) {
      const detail = formatTitleScanJobDetail(options.titleScopes, sections);
      return (
        <span className="job-scope-cell" title={detail}>
          <span>Title rescan</span>
          <small>{detail}</small>
        </span>
      );
    }
    const scopes = scanScopeLabels(options);
    const sectionText = formatScopedFolderParts(scanFolderScopeParts(options, sections));
    return (
      <span className="job-scope-cell" title={sectionText}>
        <span>{scopes.length > 0 ? scopes.join(", ") : "No scope"}</span>
        <small>{sectionText}</small>
      </span>
    );
  }

  if (job.type === "audit") {
    const options = auditOptionsFromJob(job);
    const sectionText = formatAuditScope(options, sections);
    const modeText = options.mode === "fast" ? "Fast audit" : options.mode === "deep" ? "Deep audit" : "Audit";
    const selectedLinkIds = options.linkIds ?? [];
    return (
      <span className="job-scope-cell" title={selectedLinkIds.length > 0 ? undefined : sectionText}>
        <span>{modeText}</span>
        <JobScopeDetail text={sectionText} selectedLinkIds={selectedLinkIds} linkRowsById={linkRowsById} linkRowsLoading={linkRowsLoading} linkRowsError={linkRowsError} />
      </span>
    );
  }

  if (job.type === "copy") {
    const options = copyOptionsFromJob(job);
    const sectionText = formatCopyScope(options, sections);
    const directionText = `Copy to ${storageLocationName(storageLocations, options?.direction === "to_remote" ? "remote" : "local")}`;
    const selectedLinkIds = options?.linkIds ?? [];
    return (
      <span className="job-scope-cell" title={selectedLinkIds.length > 0 ? undefined : sectionText}>
        <span>{directionText}</span>
        <JobScopeDetail text={sectionText} selectedLinkIds={selectedLinkIds} linkRowsById={linkRowsById} linkRowsLoading={linkRowsLoading} linkRowsError={linkRowsError} />
      </span>
    );
  }

  if (job.type === "path_migration") {
    const progress = recordFromUnknown(job.progress);
    const migrationId = finiteNumberFromUnknown(progress?.migrationId);
    return (
      <span className="job-scope-cell">
        <span>Managed paths</span>
        <small>{migrationId > 0 ? `Migration #${migrationId}` : "Path reconciliation"}</small>
      </span>
    );
  }

  return <span className="muted-cell">-</span>;
}

function JobScopeDetail({
  text,
  selectedLinkIds,
  linkRowsById,
  linkRowsLoading,
  linkRowsError
}: {
  text: string;
  selectedLinkIds: number[];
  linkRowsById?: Map<number, MediaLinkRow>;
  linkRowsLoading?: boolean;
  linkRowsError?: string | null;
}) {
  if (selectedLinkIds.length === 0) return <small>{text}</small>;
  const canShowTitleLookup = Boolean(linkRowsById || linkRowsLoading || linkRowsError);
  return (
    <small className="job-scope-detail-line">
      <span>{text}</span>
      {canShowTitleLookup ? <SelectedLinkTitlesTooltip linkIds={selectedLinkIds} linkRowsById={linkRowsById} isLoading={linkRowsLoading} error={linkRowsError} /> : null}
    </small>
  );
}

function SelectedLinkTitlesTooltip({
  linkIds,
  linkRowsById,
  isLoading,
  error
}: {
  linkIds: number[];
  linkRowsById?: Map<number, MediaLinkRow>;
  isLoading?: boolean;
  error?: string | null;
}) {
  const summaries = selectedLinkTitleSummaries(linkIds, linkRowsById);
  return (
    <span className="job-link-title-tooltip" tabIndex={0} aria-label="View selected titles">
      <Info size={12} />
      <span className="job-link-title-tooltip-panel" role="tooltip">
        <strong>Selected titles</strong>
        {isLoading ? <span>Loading titles...</span> : null}
        {!isLoading && error ? <span>{error}</span> : null}
        {!isLoading && !error && summaries.length === 0 ? <span>No matching titles found in the current inventory.</span> : null}
        {!isLoading && !error && summaries.length > 0 ? (
          <ul>
            {summaries.map((title) => (
              <li key={title}>{title}</li>
            ))}
          </ul>
        ) : null}
      </span>
    </span>
  );
}

function JobsTable({
  jobs,
  sections,
  onScanJobSelect,
  onAuditJobSelect,
  onCopyJobSelect
}: {
  jobs: JobRecord[];
  sections: Array<{ section: string; title?: string | null }>;
  onScanJobSelect?: (job: JobRecord) => void;
  onAuditJobSelect?: (job: JobRecord) => void;
  onCopyJobSelect?: (job: JobRecord) => void;
}) {
  const preferences = useUserPreferences();
  const { timeFormat } = preferences;
  const queryClient = useQueryClient();
  const [terminatePrompt, setTerminatePrompt] = useState<JobRecord | null>(null);
  const terminateJob = useTerminateJobMutation(() => setTerminatePrompt(null));
  const saveRecentJobsFilter = useMutation({
    mutationFn: api.saveUserPreferences,
    onSuccess: (savedPreferences) => {
      queryClient.setQueryData(["user-preferences"], savedPreferences);
    }
  });
  const completedWindowMinutes = normalizeRecentJobsCompletedWindowMinutes(preferences.recentJobsCompletedWindowMinutes);
  const visibleJobs = visibleDashboardJobs(jobs, completedWindowMinutes);
  const selectedJobLinkIds = useMemo(() => selectedLinkIdsFromJobs(visibleJobs), [visibleJobs]);
  const selectedJobLinkRows = useQuery({
    queryKey: ["media-links-by-ids", selectedJobLinkIds],
    queryFn: () => api.mediaLinksByIds(selectedJobLinkIds),
    enabled: selectedJobLinkIds.length > 0,
    staleTime: 5000
  });
  const selectedJobLinkRowsById = useMemo(() => new Map((selectedJobLinkRows.data ?? []).map((link) => [link.id, link])), [selectedJobLinkRows.data]);
  return (
    <Panel
      title="Recent Jobs"
      icon={<Activity size={18} />}
      actions={
        <label className="recent-jobs-filter">
          <span>Finished within</span>
          <select
            value={completedWindowMinutes}
            disabled={saveRecentJobsFilter.isPending}
            onChange={(event) => {
              saveRecentJobsFilter.mutate({
                ...preferences,
                recentJobsCompletedWindowMinutes: normalizeRecentJobsCompletedWindowMinutes(Number(event.currentTarget.value))
              });
            }}
          >
            {recentJobsCompletedWindowOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      }
    >
      {visibleJobs.length === 0 ? <p className="panel-message">No active jobs or finished jobs in the selected window.</p> : null}
      {saveRecentJobsFilter.error ? <p className="panel-message action-error">{saveRecentJobsFilter.error.message}</p> : null}
      {visibleJobs.length > 0 ? (
        <table className="responsive-table">
          <thead>
            <tr>
              <th>ID</th>
              <th>Type</th>
              <th>Scope</th>
              <th>Status</th>
              <th>Started</th>
              <th>Finished</th>
              <th className="actions-cell">Actions</th>
            </tr>
          </thead>
          <tbody>
            {visibleJobs.map((job) => {
              const canViewScanJob = job.type === "scan" && Boolean(onScanJobSelect);
              const canViewAuditJob = job.type === "audit" && Boolean(onAuditJobSelect);
              const canViewCopyJob = job.type === "copy" && Boolean(onCopyJobSelect);
              const canTerminate = canTerminateJob(job);
              const hasActions = canViewScanJob || canViewAuditJob || canViewCopyJob || canTerminate;
              return (
                <tr key={job.id}>
                  <td>#{job.id}</td>
                  <td>{formatJobType(job.type)}</td>
	                  <td>
	                    <JobScope
	                      job={job}
	                      sections={sections}
	                      linkRowsById={selectedJobLinkRowsById}
	                      linkRowsLoading={selectedJobLinkRows.isLoading || selectedJobLinkRows.isFetching}
	                      linkRowsError={selectedJobLinkRows.error?.message ?? null}
	                    />
	                  </td>
                  <td>
                    <StatusPill value={job.status} />
                  </td>
                  <td>{formatDate(job.startedAt, timeFormat)}</td>
                  <td>{formatDate(job.finishedAt, timeFormat)}</td>
                  <td className="actions-cell">
                    <span className="table-action-buttons">
                      {canViewScanJob && onScanJobSelect ? (
                        <button type="button" className="icon-button" title={`View scan status for job #${job.id}`} aria-label={`View scan status for job #${job.id}`} onClick={() => onScanJobSelect(job)}>
                          <Search size={15} />
                        </button>
                      ) : null}
                      {canViewAuditJob && onAuditJobSelect ? (
                        <button type="button" className="icon-button" title={`View audit status for job #${job.id}`} aria-label={`View audit status for job #${job.id}`} onClick={() => onAuditJobSelect(job)}>
                          <ListChecks size={15} />
                        </button>
                      ) : null}
                      {canViewCopyJob && onCopyJobSelect ? (
                        <button type="button" className="icon-button" title={`View copy progress for job #${job.id}`} aria-label={`View copy progress for job #${job.id}`} onClick={() => onCopyJobSelect(job)}>
                          <Activity size={15} />
                        </button>
                      ) : null}
                      {canTerminate ? (
                        <button
                          type="button"
                          className="table-action-button danger terminate"
                          title={`Terminate job #${job.id}`}
                          aria-label={`Terminate job #${job.id}`}
                          disabled={terminateJob.isPending}
                          onClick={() => setTerminatePrompt(job)}
                        >
                          <OctagonX size={15} />
                          <span>Terminate</span>
                        </button>
                      ) : null}
                      {!hasActions ? (
                        <span className="muted-cell">-</span>
                      ) : null}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : null}
      <TerminateJobDialog
        job={terminatePrompt}
        error={terminateJob.error?.message}
        isPending={terminateJob.isPending}
        onClose={() => !terminateJob.isPending && setTerminatePrompt(null)}
        onConfirm={(jobId) => terminateJob.mutate(jobId)}
      />
    </Panel>
  );
}

function JobStatusHeaderActions({
  closeLabel,
  onClose
}: {
  closeLabel: string;
  onClose: () => void;
}) {
  return (
    <div className="audit-dialog-header-actions">
      <button type="button" className="icon-only secondary" aria-label={closeLabel} onClick={onClose}>
        <X size={16} />
      </button>
    </div>
  );
}

function JobStatusTerminateAction({ job, isTerminating, onTerminate }: { job: JobRecord | null; isTerminating: boolean; onTerminate: (job: JobRecord) => void }) {
  if (!canTerminateJob(job)) return null;
  return (
    <div className="status-title-actions">
      <button type="button" className="status-terminate-button danger" onClick={() => onTerminate(job)} disabled={isTerminating}>
        <OctagonX size={15} />
        <span>Terminate job</span>
      </button>
    </div>
  );
}

function TerminateJobDialog({
  job,
  error,
  isPending,
  onClose,
  onConfirm
}: {
  job: JobRecord | null;
  error?: string;
  isPending: boolean;
  onClose: () => void;
  onConfirm: (jobId: number) => void;
}) {
  if (!job) return null;
  const pathMigration = job.type === "path_migration";
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="audit-dialog terminate-dialog" role="dialog" aria-modal="true" aria-labelledby="terminate-job-title">
        <div className="audit-dialog-header">
          <div className="audit-dialog-title-block">
            <span className="audit-dialog-eyebrow">Terminate job</span>
            <h2 id="terminate-job-title">Terminate {formatJobType(job.type).toLowerCase()} job #{job.id}</h2>
            <p>{pathMigration ? "This will ask the worker to stop path reconciliation and roll back any symlinks already repointed by this migration." : "This will ask the worker to stop the job, discard partial scan or audit results, and roll back copy changes made by this job when it is safe to do so."}</p>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close terminate confirmation" disabled={isPending}>
            <X size={18} />
          </button>
        </div>
        <div className="terminate-dialog-warning">
          <TriangleAlert size={18} />
          <div>
            <strong>This cannot be undone.</strong>
            <span>Only use terminate when you want this running or queued job stopped now.</span>
          </div>
        </div>
        {error ? <p className="panel-message action-error">{error}</p> : null}
        <div className="terminate-dialog-actions">
          <button type="button" className="secondary" onClick={onClose} disabled={isPending}>
            Cancel
          </button>
          <button type="button" className="danger-button" onClick={() => onConfirm(job.id)} disabled={isPending}>
            <OctagonX size={16} />
            Terminate job
          </button>
        </div>
      </section>
    </div>
  );
}

function LoginGate() {
  const queryClient = useQueryClient();
  const me = useQuery({ queryKey: ["me"], queryFn: api.me });
  if (me.isLoading) return <AuthShell title="Loading" icon={<Shield size={22} />} />;
  if (me.data?.setupRequired) return <SetupForm onDone={() => queryClient.invalidateQueries({ queryKey: ["me"] })} />;
  if (!me.data?.authenticated) return <LoginForm onDone={() => queryClient.invalidateQueries({ queryKey: ["me"] })} />;
  return <AuthenticatedApp />;
}

function AuthenticatedApp() {
  const pathConfiguration = useQuery({
    queryKey: ["path-configuration"],
    queryFn: api.pathConfiguration,
    refetchInterval: (query) => (query.state.data?.blocking ? 1000 : false)
  });
  const onboarding = useQuery({
    queryKey: ["onboarding"],
    queryFn: api.onboarding,
    enabled: Boolean(pathConfiguration.data && !pathConfiguration.data.blocking),
    refetchInterval: (query) => (query.state.data?.phase === "queued" || query.state.data?.phase === "scanning" ? 1000 : false)
  });
  if (pathConfiguration.isLoading) return <AuthShell title="Checking storage paths" icon={<HardDrive size={22} />} />;
  if (pathConfiguration.error) {
    return (
      <AuthShell title="Storage check failed" icon={<TriangleAlert size={22} />}>
        <p className="error">{pathConfiguration.error.message}</p>
      </AuthShell>
    );
  }
  if (pathConfiguration.data?.blocking) return <PathMigrationGate state={pathConfiguration.data} />;
  if (onboarding.isLoading) return <AuthShell title="Loading setup" icon={<Shield size={22} />} />;
  if (onboarding.error) {
    return (
      <AuthShell title="Setup check failed" icon={<TriangleAlert size={22} />}>
        <p className="error">{onboarding.error.message}</p>
      </AuthShell>
    );
  }
  if (onboarding.data?.required) return <OnboardingGate state={onboarding.data} />;
  return <RouterProvider router={router} />;
}

function OnboardingGate({ state }: { state: OnboardingState }) {
  const queryClient = useQueryClient();
  const initialSectionSettings =
    !state.initialScanJobId && state.detectedSections.length > 0
      ? { sections: state.detectedSections }
      : state.sections.sections.length > 0
        ? state.sections
        : { sections: state.detectedSections };
  const [sectionsDraft, setSectionsDraft] = useState<SectionDraft[]>(() => sectionSettingsToDrafts(initialSectionSettings));
  const [locationNames, setLocationNames] = useState<Record<StorageLocationKey, string>>(() =>
    Object.fromEntries(state.storageLocations.locations.map((location) => [location.key, location.displayName])) as Record<StorageLocationKey, string>
  );
  const [policyMode, setPolicyMode] = useState<OnboardingPolicyMode>(state.policyMode ?? "match_current_locations");
  const [pathsConfirmed, setPathsConfirmed] = useState(false);
  const [step, setStep] = useState(state.phase === "queued" || state.phase === "scanning" || state.phase === "failed" ? 3 : 0);
  const [terminatePrompt, setTerminatePrompt] = useState<JobRecord | null>(null);
  const job = useQuery({
    queryKey: ["job", state.initialScanJobId],
    queryFn: () => api.job(state.initialScanJobId ?? 0),
    enabled: Boolean(state.initialScanJobId),
    refetchInterval: (query) => (query.state.data?.status === "queued" || query.state.data?.status === "running" ? 500 : false)
  });
  const terminateJob = useTerminateJobMutation(() => {
    setTerminatePrompt(null);
    queryClient.invalidateQueries({ queryKey: ["onboarding"] });
  });
  const refreshDetectedSections = useMutation({
    mutationFn: api.onboarding,
    onSuccess: (nextState) => {
      queryClient.setQueryData(["onboarding"], nextState);
      setSectionsDraft(sectionSettingsToDrafts({ sections: nextState.detectedSections }));
    }
  });
  const start = useMutation({
    mutationFn: () =>
      api.startOnboarding({
        storageLocations: {
          locations: state.storageLocations.locations.map((location) => ({ key: location.key, displayName: locationNames[location.key].trim() }))
        },
        sections: sectionDraftsToSettings(sectionsDraft),
        policyMode
      }),
    onSuccess: (result) => {
      setStep(3);
      queryClient.setQueryData(["onboarding"], result.state);
      queryClient.invalidateQueries({ queryKey: ["job", result.jobId] });
    }
  });

  useEffect(() => {
    if (state.phase === "queued" || state.phase === "scanning" || state.phase === "failed") setStep(3);
  }, [state.phase]);

  const sections = sectionDraftsToSettings(sectionsDraft);
  const sectionNames = sectionsDraft.map((draft) => draft.name.trim()).filter(Boolean);
  const sectionsValid = sectionNames.length > 0 && sectionNames.length === sectionsDraft.length && new Set(sectionNames).size === sectionNames.length;
  const pathsReady = state.pathChecks.length === 3 && state.pathChecks.every((check) => check.ready);
  const trimmedLocationNames: Record<StorageLocationKey, string> = {
    location_1: locationNames.location_1.trim(),
    location_2: locationNames.location_2.trim()
  };
  const locationNamesError =
    !trimmedLocationNames.location_1 || !trimmedLocationNames.location_2
      ? "Each storage location needs a friendly name."
      : trimmedLocationNames.location_1.toLocaleLowerCase() === trimmedLocationNames.location_2.toLocaleLowerCase()
        ? "Friendly names must be unique."
        : null;
  const localName = trimmedLocationNames.location_1 || "Location 1";
  const remoteName = trimmedLocationNames.location_2 || "Location 2";
  const scanActive = state.phase === "queued" || state.phase === "scanning";
  const stepLabels = ["Storage", "Library", "Policy", "Initial scan"];

  return (
    <AuthShell title="Initial setup" icon={<Shield size={22} />} wide>
      <div className="onboarding-flow">
        <div className="onboarding-intro">
          <div>
            <h1>Finish configuring SRTL Manager</h1>
            <p>Review the mounted roots, define the folders that make up the library, and choose how the first scan assigns storage policy.</p>
          </div>
          <span className="onboarding-required"><Shield size={14} /> Setup required</span>
        </div>

        <ol className="onboarding-steps" aria-label="Setup progress">
          {stepLabels.map((label, index) => (
            <li key={label} className={`${index === step ? "is-current" : ""}${index < step ? " is-complete" : ""}`} aria-current={index === step ? "step" : undefined}>
              <span>{index < step ? <CheckCircle2 size={15} /> : index + 1}</span>
              <strong>{label}</strong>
            </li>
          ))}
        </ol>

        {step === 0 ? (
          <section className="onboarding-section" aria-labelledby="onboarding-storage-title">
            <div className="onboarding-section-heading">
              <div>
                <h2 id="onboarding-storage-title">Confirm mounted storage</h2>
                <p>Paths come from <code>.env</code> and must be mounted into the container as shown. Set the friendly names used throughout the interface.</p>
              </div>
            </div>
            <div className="onboarding-path-list">
              {state.pathChecks.map((check) => {
                const location = check.root === "symlink" ? null : state.storageLocations.locations.find((item) => item.rootType === check.root);
                const locationIndex = location ? state.storageLocations.locations.findIndex((item) => item.key === location.key) : -1;
                return (
                  <div key={check.root} className={`onboarding-path-row${check.ready ? " is-ready" : " is-error"}`}>
                    {check.root === "symlink" ? <Link2 size={18} /> : <HardDrive size={18} />}
                    <div className="onboarding-path-details">
                      <strong>{location ? `Location ${locationIndex + 1}` : check.label}</strong>
                      {location ? (
                        <label className="onboarding-location-name">
                          <span>Friendly name</span>
                          <input
                            value={locationNames[location.key]}
                            maxLength={40}
                            autoComplete="off"
                            aria-label={`Location ${locationIndex + 1} friendly name`}
                            onChange={(event) => setLocationNames((current) => ({ ...current, [location.key]: event.target.value }))}
                          />
                        </label>
                      ) : null}
                      <code>{check.path || "Not configured"}</code>
                    </div>
                    <small>{check.ready ? <><CheckCircle2 size={14} /> Ready</> : <><TriangleAlert size={14} /> {check.message ?? "Unavailable"}</>}</small>
                  </div>
                );
              })}
            </div>
            {!pathsReady ? (
              <div className="onboarding-alert is-error"><TriangleAlert size={17} /><span>Correct the listed path or mount issue in <code>.env</code>, then restart the app before continuing.</span></div>
            ) : null}
            {locationNamesError ? <div className="onboarding-alert is-error"><TriangleAlert size={17} /><span>{locationNamesError}</span></div> : null}
            <label className="onboarding-confirm">
              <input type="checkbox" checked={pathsConfirmed} onChange={(event) => setPathsConfirmed(event.target.checked)} disabled={!pathsReady || Boolean(locationNamesError)} />
              <span>I confirmed these paths and friendly names.</span>
            </label>
            <div className="onboarding-actions">
              <button type="button" onClick={() => setStep(1)} disabled={!pathsReady || Boolean(locationNamesError) || !pathsConfirmed}>Continue <ArrowRight size={16} /></button>
            </div>
          </section>
        ) : null}

        {step === 1 ? (
          <section className="onboarding-section" aria-labelledby="onboarding-library-title">
            <div className="onboarding-section-heading">
              <div>
                <h2 id="onboarding-library-title">Configure library folders</h2>
                <p>Folders are detected directly from <code>{state.paths.symlinkDir}</code>. Each entry must match a direct folder inside that symlink directory.</p>
              </div>
              <div className="onboarding-heading-actions">
                {state.detectedSections.length > 0 ? <span className="onboarding-detected">{state.detectedSections.length} detected</span> : null}
                <button className="secondary compact" type="button" onClick={() => refreshDetectedSections.mutate()} disabled={refreshDetectedSections.isPending || start.isPending}>
                  <RefreshCw className={refreshDetectedSections.isPending ? "is-spinning" : undefined} size={15} />
                  Rescan symlink root
                </button>
              </div>
            </div>
            {state.detectedSections.length === 0 ? <div className="onboarding-alert"><Info size={17} /><span>No direct folders were detected under the configured symlink directory.</span></div> : null}
            {refreshDetectedSections.error ? <p className="panel-message action-error">{refreshDetectedSections.error.message}</p> : null}
            <SectionDraftList drafts={sectionsDraft} onChange={setSectionsDraft} disabled={start.isPending} />
            <div className="onboarding-actions split">
              <button className="secondary" type="button" onClick={() => setSectionsDraft((drafts) => [...drafts, createEmptySectionDraft(`section-new-${Date.now()}`)])} disabled={start.isPending}>
                <Plus size={16} /> Add section
              </button>
              <span>
                <button className="secondary" type="button" onClick={() => setStep(0)}><ArrowLeft size={16} /> Back</button>
                <button type="button" onClick={() => setStep(2)} disabled={!sectionsValid}>Continue <ArrowRight size={16} /></button>
              </span>
            </div>
          </section>
        ) : null}

        {step === 2 ? (
          <section className="onboarding-section" aria-labelledby="onboarding-policy-title">
            <div className="onboarding-section-heading">
              <div>
                <h2 id="onboarding-policy-title">Choose initial storage policy</h2>
                <p>Policy is assigned by title after the initial symlink scan. You can change any title later from Library.</p>
              </div>
            </div>
            <div className="onboarding-policy-options">
              <button type="button" className={policyMode === "match_current_locations" ? "selected" : ""} aria-pressed={policyMode === "match_current_locations"} onClick={() => setPolicyMode("match_current_locations")}>
                <span><Database size={19} /><strong>Match current locations</strong></span>
                <small>Each title is assigned to {localName} or {remoteName} based on the location its symlinks already use.</small>
                <em>Mixed titles prefer {localName} so files in {remoteName} remain visible as copy work.</em>
              </button>
              <button type="button" className={policyMode === "leave_unassigned" ? "selected" : ""} aria-pressed={policyMode === "leave_unassigned"} onClick={() => setPolicyMode("leave_unassigned")}>
                <span><ListChecks size={19} /><strong>Leave all unassigned</strong></span>
                <small>The scan builds the inventory without assigning policy to any discovered title.</small>
                <em>Assign titles manually from Library after setup.</em>
              </button>
            </div>
            <div className="onboarding-review">
              <span><strong>{localName} / {remoteName}</strong> storage names</span>
              <span><strong>{sections.sections.length}</strong> library folder{sections.sections.length === 1 ? "" : "s"}</span>
              <span><strong>Symlinks only</strong> for the initial scan</span>
              <span><strong>{policyMode === "match_current_locations" ? "Match locations" : "Manual assignment"}</strong> policy strategy</span>
            </div>
            {start.error ? <p className="panel-message action-error">{start.error.message}</p> : null}
            <div className="onboarding-actions split">
              <button className="secondary" type="button" onClick={() => setStep(1)} disabled={start.isPending}><ArrowLeft size={16} /> Back</button>
              <button type="button" onClick={() => start.mutate()} disabled={!sectionsValid || start.isPending} aria-busy={start.isPending}>
                <RefreshCw className={start.isPending ? "is-spinning" : undefined} size={16} /> {start.isPending ? "Queueing scan" : "Save and run initial scan"}
              </button>
            </div>
          </section>
        ) : null}

        {step === 3 ? (
          <section className="onboarding-section onboarding-scan" aria-labelledby="onboarding-scan-title">
            <div className="onboarding-section-heading">
              <div>
                <h2 id="onboarding-scan-title">Initial inventory scan</h2>
                <p>This is a normal background job. It indexes the configured symlink folders, then applies the policy strategy selected above.</p>
              </div>
              {state.initialScanJobId ? <span className="onboarding-detected">Job #{state.initialScanJobId}</span> : null}
            </div>
            <ScanProgressPanel
              job={job.data ?? null}
              pendingJobId={state.initialScanJobId}
              presentation="onboarding"
              locationNames={{ local: localName, remote: remoteName }}
            />
            {state.phase === "failed" ? (
              <div className="onboarding-alert is-error"><TriangleAlert size={17} /><span>{state.errorMessage ?? "The initial scan did not complete."}</span></div>
            ) : null}
            {job.error ? <p className="panel-message action-error">{job.error.message}</p> : null}
            <div className="onboarding-scan-footer">
              <span>{scanActive ? "The scan continues if this browser window is closed." : "Review the failure, adjust setup if needed, and retry."}</span>
              <div>
                {state.phase === "failed" ? <button className="secondary" type="button" onClick={() => setStep(0)}><ArrowLeft size={16} /> Review setup</button> : null}
                {state.phase === "failed" ? <button type="button" onClick={() => start.mutate()} disabled={start.isPending}><RefreshCw size={16} /> Retry initial scan</button> : null}
                <JobStatusTerminateAction job={job.data ?? null} isTerminating={terminateJob.isPending} onTerminate={setTerminatePrompt} />
              </div>
            </div>
            {start.error ? <p className="panel-message action-error">{start.error.message}</p> : null}
          </section>
        ) : null}
      </div>
      <TerminateJobDialog
        job={terminatePrompt}
        error={terminateJob.error?.message}
        isPending={terminateJob.isPending}
        onClose={() => !terminateJob.isPending && setTerminatePrompt(null)}
        onConfirm={(jobId) => terminateJob.mutate(jobId)}
      />
    </AuthShell>
  );
}

function pathMigrationProgress(job: JobRecord | null): { current: number; total: number; message: string } {
  const progress = recordFromUnknown(job?.progress);
  return {
    current: finiteNumberFromUnknown(progress?.current),
    total: finiteNumberFromUnknown(progress?.total),
    message: typeof progress?.message === "string" ? progress.message : "Waiting for the migration worker"
  };
}

function PathMigrationGate({ state }: { state: PathConfigurationState }) {
  const queryClient = useQueryClient();
  const [confirmed, setConfirmed] = useState(false);
  const [terminatePrompt, setTerminatePrompt] = useState<JobRecord | null>(null);
  const migration = state.migration;
  const plan = useMutation({
    mutationFn: () => {
      if (!migration) throw new Error("Path migration is unavailable");
      return api.planPathMigration(migration.id);
    },
    onSuccess: (nextState) => {
      setConfirmed(false);
      queryClient.setQueryData(["path-configuration"], nextState);
    }
  });
  const apply = useMutation({
    mutationFn: () => {
      if (!migration) throw new Error("Path migration is unavailable");
      return api.applyPathMigration(migration.id);
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["path-configuration"] })
  });
  const terminateJob = useTerminateJobMutation(() => setTerminatePrompt(null));
  const job = useQuery({
    queryKey: ["job", migration?.jobId],
    queryFn: () => api.job(migration?.jobId ?? 0),
    enabled: Boolean(migration?.jobId),
    refetchInterval: migration?.status === "queued" || migration?.status === "running" ? 1000 : false
  });
  const progress = pathMigrationProgress(job.data ?? null);
  const progressPercent = progress.total > 0 ? Math.min(100, Math.max(0, (progress.current / progress.total) * 100)) : 0;
  const canAnalyze = Boolean(migration && state.environmentErrors.length === 0 && ["pending", "planned", "failed"].includes(migration.status));
  const canApply = Boolean(migration && migration.status === "planned" && migration.summary.blockedLinks === 0 && confirmed);
  const actionError = plan.error?.message ?? apply.error?.message ?? job.error?.message;

  return (
    <AuthShell title="Storage paths changed" icon={<TriangleAlert size={22} />} wide>
      <div className="path-migration-flow">
        <div className="path-migration-intro">
          <div>
            <h1>Storage paths require attention</h1>
            <p>SRTL Manager detected a difference between <code>.env</code> and the last applied storage configuration. Jobs and library changes are paused until every affected symlink is reconciled.</p>
          </div>
          <span className="path-migration-lock"><Shield size={15} /> Maintenance mode</span>
        </div>

        {state.environmentErrors.length > 0 ? (
          <div className="path-migration-alert path-migration-alert-danger">
            <TriangleAlert size={18} />
            <div>
              <strong>Correct the deployment configuration</strong>
              {state.environmentErrors.map((message) => <span key={message}>{message}</span>)}
            </div>
          </div>
        ) : null}

        <section className="path-migration-section" aria-labelledby="detected-path-changes-title">
          <div className="path-migration-section-heading">
            <div>
              <h2 id="detected-path-changes-title">Detected path changes</h2>
              <p>Paths are read from the current process environment. Unchanged roots are shown for context.</p>
            </div>
          </div>
          <div className="path-change-list">
            {state.changes.map((change) => (
              <div className={`path-change-row${change.changed ? " is-changed" : ""}`} key={change.root}>
                <div className="path-change-label">
                  {change.root === "symlink" ? <Link2 size={17} /> : <HardDrive size={17} />}
                  <strong>{change.label}</strong>
                  <span>{change.changed ? "Changed" : "Unchanged"}</span>
                </div>
                <div className="path-change-values">
                  <code>{change.activePath || "Not previously configured"}</code>
                  <ChevronRight size={17} aria-hidden="true" />
                  <code>{change.detectedPath || "Not configured"}</code>
                </div>
                {change.changed ? (
                  <span className={`path-identity path-identity-${change.identityMatch}`}>
                    {change.identityMatch === "same" ? "Same root detected" : change.identityMatch === "different" ? "Different root identity" : "Root identity unavailable"}
                  </span>
                ) : null}
              </div>
            ))}
          </div>
        </section>

        {migration?.status === "planning" || plan.isPending ? (
          <div className="path-migration-working" role="status"><RefreshCw className="is-spinning" size={18} /> Validating every affected symlink and mapped target...</div>
        ) : null}

        {migration && ["planned", "queued", "running", "failed"].includes(migration.status) ? (
          <section className="path-migration-section" aria-labelledby="migration-analysis-title">
            <div className="path-migration-section-heading">
              <div>
                <h2 id="migration-analysis-title">Migration analysis</h2>
                <p>Only path references are migrated. Storage content is never moved by this workflow.</p>
              </div>
              <span className={`status status-${migration.summary.blockedLinks > 0 || migration.status === "failed" ? "failed" : migration.status === "running" || migration.status === "queued" ? "running" : "completed"}`}>
                {migration.status === "planned" ? "Ready" : migration.status === "queued" ? "Queued" : migration.status === "running" ? "Running" : "Needs attention"}
              </span>
            </div>
            <div className="path-migration-stats">
              <StatCard label="Affected symlinks" value={formatNumber(migration.summary.affectedLinks)} />
              <StatCard label="Targets to repoint" value={formatNumber(migration.summary.repointLinks)} />
              <StatCard label="Link paths to rebase" value={formatNumber(migration.summary.rebaseLinkPaths)} />
              <StatCard label="Blocked" value={formatNumber(migration.summary.blockedLinks)} tone={migration.summary.blockedLinks > 0 ? "bad" : "neutral"} />
            </div>
            {migration.summary.activeJobs > 0 ? (
              <div className="path-migration-alert">
                <Info size={18} />
                <div><strong>{formatNumber(migration.summary.activeJobs)} existing job(s) are paused</strong><span>Queued work will be cancelled when migration starts so it cannot resume with stale paths.</span></div>
              </div>
            ) : null}
            {migration.issues.length > 0 ? (
              <div className="path-migration-issues">
                <div className="path-migration-issues-heading"><TriangleAlert size={17} /><strong>Blocked symlinks</strong><span>Showing {migration.issues.length} of {formatNumber(migration.summary.blockedLinks)}</span></div>
                <div className="path-migration-issue-list">
                  {migration.issues.map((issue) => (
                    <div key={issue.id}><strong>{issue.itemName}</strong><code>{issue.linkPath}</code><span>{issue.message}</span></div>
                  ))}
                </div>
              </div>
            ) : null}
          </section>
        ) : null}

        {migration && (migration.status === "queued" || migration.status === "running") ? (
          <section className="path-migration-section path-migration-progress" aria-live="polite">
            <div className="path-migration-progress-heading"><strong>{progress.message}</strong><span>{formatNumber(progress.current)} / {formatNumber(progress.total)}</span></div>
            <div className="audit-progress-track path-migration-progress-track"><span style={{ width: `${progressPercent}%` }} /></div>
            <p>Do not change mounts or edit symlinks while this migration is running. This page will unlock automatically when reconciliation completes.</p>
            <JobStatusTerminateAction job={job.data ?? null} isTerminating={terminateJob.isPending} onTerminate={setTerminatePrompt} />
          </section>
        ) : null}

        {migration?.status === "failed" && migration.errorMessage ? (
          <div className="path-migration-alert path-migration-alert-danger"><TriangleAlert size={18} /><div><strong>{migration.startedAt ? "Migration stopped and applied repointing was rolled back" : "Path analysis could not complete"}</strong><span>{migration.errorMessage}</span></div></div>
        ) : null}
        {actionError ? <p className="panel-message action-error">{actionError}</p> : null}

        <div className="path-migration-footer">
          <div className="path-migration-revert">
            <strong>These are not the intended paths?</strong>
            <span>Restore the previous values in <code>.env</code> and restart every SRTL Manager service. This screen will clear automatically when the original configuration is detected.</span>
          </div>
          <div className="path-migration-actions">
            {migration?.status === "planned" && migration.summary.blockedLinks === 0 ? (
              <label className="path-migration-confirm">
                <input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />
                <span>I confirm the detected paths expose the same storage content.</span>
              </label>
            ) : null}
            {canAnalyze && migration?.status === "pending" ? (
              <button type="button" className="secondary" onClick={() => plan.mutate()} disabled={plan.isPending || apply.isPending}>
                <RefreshCw size={16} /> Analyze path change
              </button>
            ) : null}
            {migration?.status === "planned" && migration.summary.blockedLinks > 0 ? (
              <button type="button" className="secondary" onClick={() => plan.mutate()} disabled={plan.isPending}><RefreshCw size={16} /> Analyze again</button>
            ) : null}
            {migration?.status === "failed" ? (
              <button type="button" className="secondary" onClick={() => plan.mutate()} disabled={plan.isPending}><RefreshCw size={16} /> Analyze again</button>
            ) : null}
            {migration?.status === "planned" && migration.summary.blockedLinks === 0 ? (
              <button type="button" onClick={() => apply.mutate()} disabled={!canApply || apply.isPending}>
                <ArrowRight size={16} /> Apply validated migration
              </button>
            ) : null}
          </div>
        </div>
      </div>
      <TerminateJobDialog
        job={terminatePrompt}
        error={terminateJob.error?.message}
        isPending={terminateJob.isPending}
        onClose={() => !terminateJob.isPending && setTerminatePrompt(null)}
        onConfirm={(jobId) => terminateJob.mutate(jobId)}
      />
    </AuthShell>
  );
}

function SetupForm({ onDone }: { onDone: () => void }) {
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const mutation = useMutation({ mutationFn: api.setup, onSuccess: onDone });

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (password !== confirmPassword) {
      setFormError("Passwords do not match.");
      return;
    }
    if (password.length < 8) {
      setFormError("Password must be at least 8 characters.");
      return;
    }
    setFormError(null);
    mutation.mutate({ username, password, confirmPassword });
  }

  const error = formError ?? mutation.error?.message;

  return (
    <AuthShell title="Initial setup" icon={<Shield size={22} />}>
      <form className="auth-form" onSubmit={handleSubmit}>
        <label>
          Username
          <input autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} />
        </label>
        <label>
          Password
          <input autoComplete="new-password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} />
        </label>
        <label>
          Confirm password
          <input autoComplete="new-password" type="password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} />
        </label>
        <button className="auth-primary-button" type="submit" disabled={mutation.isPending} aria-busy={mutation.isPending}>
          <UserPlus size={17} />
          Create admin
        </button>
        {error ? <p className="error">{error}</p> : null}
      </form>
    </AuthShell>
  );
}

function LoginForm({ onDone }: { onDone: () => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const mutation = useMutation({ mutationFn: api.login, onSuccess: onDone });
  return (
    <AuthShell title="Sign in" icon={<Shield size={22} />}>
      <form className="auth-form" onSubmit={(event) => {
        event.preventDefault();
        mutation.mutate({ username, password });
      }}>
        <label>
          Username
          <input autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} />
        </label>
        <label>
          Password
          <input autoComplete="current-password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} />
        </label>
        <button className="auth-primary-button" type="submit" disabled={mutation.isPending} aria-busy={mutation.isPending}>
          <LogIn size={17} />
          Sign in
        </button>
        {mutation.error ? <p className="error">{mutation.error.message}</p> : null}
      </form>
    </AuthShell>
  );
}

function AuthShell({ title, icon, children, wide = false }: { title: string; icon: ReactNode; children?: ReactNode; wide?: boolean }) {
  return (
    <div className="auth-page">
      <div className={`auth-panel${wide ? " auth-panel-wide" : ""}`}>
        <div className="auth-header">
          <div className="brand compact">
            {icon}
            <div>
              <strong>SRTL Manager</strong>
              <span>{title}</span>
            </div>
          </div>
          <ThemeSwitcher />
        </div>
        {children}
      </div>
    </div>
  );
}

function Page({ title, subtitle, children, hideHeader = false }: { title: string; subtitle: string; children: ReactNode; hideHeader?: boolean }) {
  return (
    <>
      {hideHeader ? null : (
        <header className="page-header">
          <div>
            <h1>{title}</h1>
            <p>{subtitle}</p>
          </div>
        </header>
      )}
      <div className="page-stack">{children}</div>
    </>
  );
}

function Panel({ title, icon, actions, children }: { title: string; icon: ReactNode; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="panel">
      <div className="panel-title">
        {icon}
        <h2>{title}</h2>
        {actions ? <div className="panel-title-actions">{actions}</div> : null}
      </div>
      {children}
    </section>
  );
}

function StatusPill({ value, toneValue }: { value: string; toneValue?: string }) {
  const normalized = (toneValue ?? value).toLowerCase();
  const className = normalized.replace(/[\s_]+/g, "-");
  const icon =
    normalized.includes("fail") || normalized === "broken" || normalized === "orphan" || normalized.includes("copy to") || normalized === "unassigned" ? (
      <TriangleAlert size={13} />
    ) : normalized.includes("complete") || normalized === "local" || normalized === "location_1" || normalized === "linked" ? (
      <CheckCircle2 size={13} />
    ) : null;
  return (
    <span className={`pill pill-${className}`}>
      {icon}
      {value.replace("_", " ")}
    </span>
  );
}

function dateTimeFormatOptions(timeFormat: TimeFormatPreference): Intl.DateTimeFormatOptions {
  return { year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit", hour12: timeFormat === "12h" };
}

function timeOnlyFormatOptions(timeFormat: TimeFormatPreference): Intl.DateTimeFormatOptions {
  return { hour: "numeric", minute: "2-digit", second: "2-digit", hour12: timeFormat === "12h" };
}

function formatDate(value: string | null, timeFormat: TimeFormatPreference = defaultUserPreferences.timeFormat) {
  return value ? new Date(value).toLocaleString(undefined, dateTimeFormatOptions(timeFormat)) : "-";
}

function formatTime(value: string, timeFormat: TimeFormatPreference = defaultUserPreferences.timeFormat) {
  return new Date(value).toLocaleTimeString(undefined, timeOnlyFormatOptions(timeFormat));
}

function formatDuration(startedAt: string | null, finishedAt: string | null) {
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

function formatBytes(value: number) {
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

function formatNumber(value: number) {
  return new Intl.NumberFormat().format(value);
}

function scanAgeLabel(value: string | null | undefined): string {
  if (!value) return "Never scanned";
  const elapsedMs = Date.now() - Date.parse(value);
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return "Never scanned";
  const elapsedMinutes = Math.floor(elapsedMs / 60000);
  if (elapsedMinutes < 60) return `Last scanned ${elapsedMinutes} min ago`;
  if (elapsedMs >= 86400000) return `Last scanned ${(elapsedMs / 86400000).toFixed(1)} days ago`;
  return `Last scanned ${(elapsedMs / 3600000).toFixed(1)} hrs ago`;
}

function oldestScanAgeLabel(values: Array<string | null | undefined>): string {
  const timestamps = values
    .map((value) => (value ? Date.parse(value) : Number.NaN))
    .filter((timestamp) => Number.isFinite(timestamp));
  if (timestamps.length === 0) return "Never scanned";
  return scanAgeLabel(new Date(Math.min(...timestamps)).toISOString());
}

interface LogsRouteSearch {
  job?: number;
}

function parseLogsRouteSearch(search: Record<string, unknown>): LogsRouteSearch {
  const value = Array.isArray(search.job) ? search.job[0] : search.job;
  const job = Number(value);
  return Number.isInteger(job) && job > 0 ? { job } : {};
}

const rootRoute = createRootRoute({ component: RootLayout });
const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: DashboardPage });
const libraryRoute = createRoute({ getParentRoute: () => rootRoute, path: "/library", component: LibraryPage });
const scansRoute = createRoute({ getParentRoute: () => rootRoute, path: "/scans", component: () => <RunsPage type="scan" /> });
const auditsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/audits", component: () => <RunsPage type="audit" /> });
const integrationsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/integrations", component: IntegrationsPage });
const settingsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/settings", component: () => <SettingsPage activeView="library" /> });
const settingsSectionsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/settings/sections", component: () => <SettingsPage activeView="library" /> });
const settingsIntegrationsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/settings/integrations", component: () => <SettingsPage activeView="integrations" /> });
const settingsAdvancedRoute = createRoute({ getParentRoute: () => rootRoute, path: "/settings/advanced", component: () => <SettingsPage activeView="advanced" /> });
const settingsUserRoute = createRoute({ getParentRoute: () => rootRoute, path: "/settings/user", component: () => <SettingsPage activeView="user" /> });
const logsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/logs", validateSearch: parseLogsRouteSearch, component: LogsPage });
const routeTree = rootRoute.addChildren([
  indexRoute,
  libraryRoute,
  scansRoute,
  auditsRoute,
  integrationsRoute,
  settingsRoute,
  settingsSectionsRoute,
  settingsIntegrationsRoute,
  settingsAdvancedRoute,
  settingsUserRoute,
  logsRoute
]);
const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

export function App() {
  return <LoginGate />;
}
