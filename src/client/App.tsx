import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { createRootRoute, createRoute, createRouter, lazyRouteComponent, Link, Outlet, RouterProvider, useLocation } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Activity, ArrowDown, ArrowLeft, ArrowRight, ArrowUp, CheckCircle2, ChevronRight, Database, FileText, Gauge, HardDrive, HardDriveDownload, Info, Library, Link2, ListChecks, LogIn, LogOut, OctagonX, Plus, RefreshCw, Search, Settings, Shield, Trash2, TriangleAlert, X, UserCog, UserPlus } from "lucide-react";
import { api } from "./api";
import { formatJobType, jobProgressChips } from "./logDisplay";
import { formatCurrentVersionDisplay } from "./versionDisplay";
import { inventoryJobRefreshKey, isActiveDashboardJob } from "./recentJobs";
import { inferSectionContentType } from "../shared/sections";
import { type AppReleaseInfo, type AppVersionInfo, type JobRecord, type OnboardingPolicyMode, type OnboardingState, type PathConfigurationState, type SectionContentType, type StorageLocationKey } from "../shared/types";
import { SectionDraft, SidebarGroup, StorageLocationsContext, UserPreferencesContext, canTerminateJob, copyElapsedLabel, createEmptySectionDraft, defaultStorageLocations, defaultUserPreferences, formatNumber, historySections, isActivePathMigrationStatus, onboardingScanVisibleStats, parseLogsRouteSearch, pathMigrationProgress, pathMigrationProgressTitle, pathMigrationStatusLabel, scanOptionsFromProgress, scanProgressFromJob, scanStageLabel, scanStagePercent, scanStatusDetail, scanVisibleIndexedItemCount, scanVisibleStats, sectionDraftsToSettings, sectionSettingsToDrafts, sectionTypeOptions, settingsSections, storageLocationName, themeOptions, useLiveTimestamp, useStorageLocations, useTerminateJobMutation, useThemePreference, versionChannelLabel, versionCheckIntervalMs, visibleVersionReleases } from "./appShared";
export function SectionDraftList({ drafts, onChange, disabled = false }: { drafts: SectionDraft[]; onChange: (drafts: SectionDraft[]) => void; disabled?: boolean }) {
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

export function StatCard({ label, value, detail, tone = "neutral" }: { label: string; value: number | string; detail?: string; tone?: "neutral" | "bad" | "warn" }) {
  return (
    <div className={`stat stat-${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
      {detail ? <small>{detail}</small> : null}
    </div>
  );
}

export function InfoTooltip({ label, children }: { label: string; children: ReactNode }) {
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


export function LogChipList({ chips }: { chips: Array<{ label: string; value: string }> }) {
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

export function ScanProgressPanel({
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


export function JobStatusTerminateAction({ job, isTerminating, onTerminate }: { job: JobRecord | null; isTerminating: boolean; onTerminate: (job: JobRecord) => void }) {
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

export function TerminateJobDialog({
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
  return (
    <>
      <InventoryJobDataRefresher />
      <RouterProvider router={router} />
    </>
  );
}

function InventoryJobDataRefresher() {
  const queryClient = useQueryClient();
  const previousRefreshKey = useRef<string | null>(null);
  const jobs = useQuery({
    queryKey: ["jobs", "inventory-refresh"],
    queryFn: () => api.jobs({ completedWithinMinutes: 15 }),
    refetchInterval: (query) => (query.state.data?.some((job) => (job.type === "scan" || job.type === "copy") && isActiveDashboardJob(job)) ? 500 : 3000)
  });
  const refreshKey = inventoryJobRefreshKey(jobs.data ?? []);

  useEffect(() => {
    if (!jobs.isSuccess) return;
    if (previousRefreshKey.current === null) {
      previousRefreshKey.current = refreshKey;
      return;
    }
    if (previousRefreshKey.current === refreshKey) return;
    previousRefreshKey.current = refreshKey;

    for (const queryKey of [
      ["scans"],
      ["inventory-scan-timestamps"],
      ["dashboard-remote-work-links"],
      ["media-links"],
      ["media-links-page"],
      ["media-link-tree"],
      ["storage-files"],
      ["storage-file-tree"],
      ["storage-policies"],
      ["sections"],
      ["inventory-summary"]
    ]) {
      void queryClient.invalidateQueries({ queryKey });
    }
  }, [jobs.isSuccess, queryClient, refreshKey]);

  return null;
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
    refetchInterval: isActivePathMigrationStatus(migration?.status) ? 1000 : false
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
                    {change.identityMatch === "same" ? "Same storage mount" : change.identityMatch === "different" ? "Different storage mount" : "Storage mount unavailable"}
                  </span>
                ) : null}
              </div>
            ))}
          </div>
        </section>

        {migration?.status === "planning" || plan.isPending ? (
          <div className="path-migration-working" role="status"><RefreshCw className="is-spinning" size={18} /> Validating every affected symlink and mapped target...</div>
        ) : null}

        {migration && ["planned", "queued", "running", "rollback_pending", "failed"].includes(migration.status) ? (
          <section className="path-migration-section" aria-labelledby="migration-analysis-title">
            <div className="path-migration-section-heading">
              <div>
                <h2 id="migration-analysis-title">Migration analysis</h2>
                <p>Only path references are migrated. Storage content is never moved by this workflow.</p>
              </div>
              <span className={`status status-${migration.summary.blockedLinks > 0 || migration.status === "failed" ? "failed" : isActivePathMigrationStatus(migration.status) ? "running" : "completed"}`}>
                {pathMigrationStatusLabel(migration.status)}
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

        {migration && isActivePathMigrationStatus(migration.status) ? (
          <section className="path-migration-section path-migration-progress" aria-live="polite">
            <div className="path-migration-progress-heading"><strong>{pathMigrationProgressTitle(migration.status, progress.message)}</strong><span>{formatNumber(progress.current)} / {formatNumber(progress.total)}</span></div>
            <div className="audit-progress-track path-migration-progress-track"><span style={{ width: `${progressPercent}%` }} /></div>
            {migration.status === "rollback_pending" && progress.message !== "Rolling back paths" ? <p>{progress.message}</p> : null}
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

export function Page({ title, subtitle, children, hideHeader = false }: { title: string; subtitle: string; children: ReactNode; hideHeader?: boolean }) {
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

export function Panel({ title, icon, actions, children }: { title: string; icon: ReactNode; actions?: ReactNode; children: ReactNode }) {
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

export function StatusPill({ value, toneValue }: { value: string; toneValue?: string }) {
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


const rootRoute = createRootRoute({ component: RootLayout });
const loadLibraryRoutes = () => import("./libraryRoutes");
const loadOperationsRoutes = () => import("./operationsRoutes");
const DashboardPage = lazyRouteComponent(loadLibraryRoutes, "DashboardPage");
const LibraryPage = lazyRouteComponent(loadLibraryRoutes, "LibraryPage");
const RunsPage = lazyRouteComponent(loadOperationsRoutes, "RunsPage");
const SettingsPage = lazyRouteComponent(loadOperationsRoutes, "SettingsPage");
const LogsPage = lazyRouteComponent(loadOperationsRoutes, "LogsPage");
const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: DashboardPage });
const libraryRoute = createRoute({ getParentRoute: () => rootRoute, path: "/library", component: LibraryPage });
const scansRoute = createRoute({ getParentRoute: () => rootRoute, path: "/scans", component: () => <RunsPage type="scan" /> });
const auditsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/audits", component: () => <RunsPage type="audit" /> });
const settingsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/settings", component: () => <SettingsPage activeView="library" /> });
const settingsSectionsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/settings/sections", component: () => <SettingsPage activeView="library" /> });
const settingsAdvancedRoute = createRoute({ getParentRoute: () => rootRoute, path: "/settings/advanced", component: () => <SettingsPage activeView="advanced" /> });
const settingsUserRoute = createRoute({ getParentRoute: () => rootRoute, path: "/settings/user", component: () => <SettingsPage activeView="user" /> });
const logsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/logs", validateSearch: parseLogsRouteSearch, component: LogsPage });
const routeTree = rootRoute.addChildren([
  indexRoute,
  libraryRoute,
  scansRoute,
  auditsRoute,
  settingsRoute,
  settingsSectionsRoute,
  settingsAdvancedRoute,
  settingsUserRoute,
  logsRoute
]);

function RoutePending() {
  return <div className="page-stack"><p className="panel-message" role="status"><RefreshCw className="is-spinning" size={16} /> Loading view</p></div>;
}

const router = createRouter({
  routeTree,
  defaultPendingComponent: RoutePending,
  defaultPendingMs: 0,
  defaultPreload: "intent"
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

export function App() {
  return <LoginGate />;
}
