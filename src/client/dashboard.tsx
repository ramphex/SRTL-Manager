import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeftRight, CheckCircle2, DatabaseBackup, Film, HardDrive, HardDriveDownload, Link2, ListChecks, Music, RefreshCw, SlidersHorizontal, Square, TriangleAlert, Tv, X } from "lucide-react";
import type { AuditOptions, AuditSettings, JobRecord, ScanOptions, StorageRootType } from "../shared/types";
import type { NowPlayingStream } from "../shared/nowPlaying";
import type { WatchSyncState } from "../shared/watchSync";
import { api, request } from "./api";
import { useAccess } from "./access";
import { TerminateJobDialog } from "./App";
import {
  canTerminateJob,
  formatNumber,
  inventoryCopyToLocalCount,
  inventoryCopyToRemoteCount,
  oldestScanAgeLabel,
  scanAgeLabel,
  sectionDisplayTitle,
  storageLocationName,
  useModalLifecycle,
  useStorageLocations,
  useTerminateJobMutation,
  useUserPreferences,
  type AuditPrompt,
  type ScanBatchStatusPrompt,
  type ScanStatusPrompt
} from "./appShared";
import { useDamagedFiles } from "./damagedFilesQuery";
import {
  accountsStatus,
  agoLabel,
  arrStatus,
  backupStatus,
  dashboardAllClearLabel,
  failedJobStatuses,
  jobLineLabel,
  jobPercent,
  jobsStatus,
  mediaServerStatus,
  reRequestStatus,
  securityStatus,
  sortDashboardStatusRows,
  systemStatus,
  watchSyncStatus,
  type DashboardStatusRow
} from "./dashboardModel";
import { AuditDialog, CopyRetryAction, FolderScopePicker, ScanBatchStatusDialog, ScanScopeBlock, ScanStatusDialog } from "./jobPresentation";
import { formatAuditScope, formatScanScope } from "./jobPresentationUtils";
import { isActiveQueueJob, normalizeAuditTargets, scanOptionsFromJob } from "./jobScopeLocks";
import { useNowPlayingEvents } from "./nowPlaying";
import { formatKbps, playMethodLabel, streamTitle } from "./nowPlayingPresentation";
import { inventoryPolicyNeededCount } from "./sectionSummaryDisplay";

const watchSyncKey = ["watch-sync"];
const fetchWatchSync = () => request<WatchSyncState>("/api/settings/watch-sync");
const startWatchSync = () => request<{ jobId: number | null }>("/api/settings/watch-sync/reconcile", { method: "POST" });

type DashboardNote = { text: string; error: boolean } | null;

export function DashboardPage() {
  const [note, setNoteState] = useState<{ id: number; text: string; error: boolean } | null>(null);
  // Every note gets a new id, so the same message shows again after it was dismissed.
  const setNote = useCallback((next: DashboardNote) => setNoteState((current) => (next ? { ...next, id: (current?.id ?? 0) + 1 } : null)), []);
  // One live connection feeds both the Status list and the Now Playing lines.
  const nowPlaying = useNowPlayingFeed();
  return (
    <div className="dash">
      <header className="dash-head">
        <div>
          <h1>Dashboard</h1>
          <p>Summary and quick actions across SRTL.</p>
        </div>
        <DashboardActions onNote={setNote} />
      </header>
      <LibraryLine />
      <StatusBox nowPlaying={nowPlaying} />
      <NowPlayingBox nowPlaying={nowPlaying} />
      <JobsBox />
      {note ? <ActionToast key={note.id} message={note.text} tone={note.error ? "error" : "success"} /> : null}
    </div>
  );
}

function Box({ title, sub, link, className, children }: { title: string; sub?: string | null; link?: ReactNode; className: string; children: ReactNode }) {
  return (
    <section className={`dash-box ${className}`} aria-label={title}>
      <div className="dash-box-head">
        <h2>{title}</h2>
        {sub ? <span className="dash-box-sub">{sub}</span> : null}
        {link}
      </div>
      {children}
    </section>
  );
}

/** A fixed notification, so a queued task never shifts the page. */
function ActionToast({ message, tone }: { message: string; tone: "success" | "error" }) {
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    const timeout = window.setTimeout(() => setVisible(false), tone === "error" ? 10_000 : 6_000);
    return () => window.clearTimeout(timeout);
  }, [tone]);
  if (!visible || typeof document === "undefined") return null;
  const Icon = tone === "error" ? TriangleAlert : CheckCircle2;
  return createPortal(
    <div className={`action-toast action-toast-${tone}`} role={tone === "error" ? "alert" : "status"} aria-live={tone === "error" ? "assertive" : "polite"} aria-atomic="true">
      <Icon className="action-toast-icon" size={20} />
      <div className="action-toast-content">
        <strong>{tone === "error" ? "Action failed" : "Task queued"}</strong>
        <span>{message}</span>
      </div>
      <button type="button" className="action-toast-dismiss" aria-label="Dismiss notification" onClick={() => setVisible(false)}>
        <X size={16} />
      </button>
    </div>,
    document.body
  );
}

/* ---------- Status ---------- */

const statusLinks: Record<DashboardStatusRow["key"], { to: string; label: string }> = {
  jobs: { to: "/logs", label: "Activity" },
  arr: { to: "/settings/integrations", label: "Open" },
  reRequests: { to: "/library", label: "Open" },
  mediaServers: { to: "/now-playing", label: "Open" },
  watchSync: { to: "/settings/integrations", label: "Open" },
  backups: { to: "/settings/backups", label: "Open" },
  accounts: { to: "/settings/accounts", label: "Open" },
  security: { to: "/settings/user", label: "Open" },
  system: { to: "/logs", label: "Logs" }
};

type NowPlayingFeed = ReturnType<typeof useNowPlayingFeed>;

function StatusBox({ nowPlaying }: { nowPlaying: NowPlayingFeed }) {
  const { can } = useAccess();
  const queryClient = useQueryClient();
  const activeJobs = useQuery({ queryKey: ["jobs", "active"], queryFn: () => api.jobs({ activeOnly: true }), refetchInterval: 3000 });
  const recentJobs = useRecentJobs();
  const radarr = useQuery({ queryKey: ["dashboard", "radarr"], queryFn: api.getRadarrOverview, enabled: can("settings.manage"), refetchInterval: 60_000 });
  const sonarr = useQuery({ queryKey: ["dashboard", "sonarr"], queryFn: api.getSonarrOverview, enabled: can("settings.manage"), refetchInterval: 60_000 });
  const reRequests = useQuery({ queryKey: ["re-requests"], queryFn: api.reRequests, enabled: can("library.delete"), refetchInterval: 30_000 });
  const watchSync = useQuery({ queryKey: watchSyncKey, queryFn: fetchWatchSync, enabled: can("settings.manage"), refetchInterval: 60_000 });
  const backups = useQuery({ queryKey: ["backups"], queryFn: api.backups, enabled: can("settings.manage"), refetchInterval: 60_000, retry: false });
  const accounts = useQuery({ queryKey: ["dashboard", "accounts"], queryFn: api.accounts, enabled: can("moderators.manage"), refetchInterval: 300_000 });
  const security = useQuery({ queryKey: ["dashboard", "security-events"], queryFn: () => api.securityEvents(), enabled: can("activity.view"), refetchInterval: 300_000 });
  const health = useQuery({ queryKey: ["dashboard", "health"], queryFn: api.health, refetchInterval: 30_000, retry: false });
  const retryReRequests = useMutation({
    mutationFn: () => api.retryReRequests("all_failed"),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["re-requests"] })
  });

  const rows = sortDashboardStatusRows(
    [
      jobsStatus(activeJobs.data ?? [], recentJobs.data ?? []),
      can("settings.manage") ? arrStatus(radarr.data, sonarr.data) : null,
      can("library.delete") ? reRequestStatus(reRequests.data) : null,
      mediaServerStatus(nowPlaying.snapshot?.servers),
      can("settings.manage") ? watchSyncStatus(watchSync.data) : null,
      can("settings.manage") ? backupStatus(backups.data) : null,
      can("moderators.manage") ? accountsStatus(accounts.data) : null,
      can("activity.view") ? securityStatus(security.data) : null,
      systemStatus(health.data, nowPlaying.host.samples.at(-1))
    ].filter((row): row is DashboardStatusRow => row !== null)
  );
  const allClear = dashboardAllClearLabel(rows);

  return (
    <Box title="Status" className="dash-status">
      {rows.map((row) => (
        <div key={row.key} className={`dash-row is-${row.tone}`} data-status={row.key}>
          <span className="dash-dot" aria-hidden="true" />
          <span className="dash-row-label">{row.label}</span>
          <span className="dash-row-text">
            <b>{row.value}</b>
            {row.detail ? ` · ${row.detail}` : null}
          </span>
          {row.key === "reRequests" && row.tone === "bad" ? (
            <button type="button" className="dash-link-button" disabled={retryReRequests.isPending} onClick={() => retryReRequests.mutate()}>
              {retryReRequests.isPending ? "Retrying" : "Retry"}
            </button>
          ) : (
            <Link to={row.key === "mediaServers" && can("settings.manage") ? "/settings/media-servers" : statusLinks[row.key].to} className="dash-link">
              {row.key === "arr" && row.tone === "warn" ? "Review" : statusLinks[row.key].label}
            </Link>
          )}
        </div>
      ))}
      {allClear ? (
        <p className="dash-all-clear">
          <CheckCircle2 size={14} aria-hidden="true" />
          <span>{allClear}</span>
        </p>
      ) : null}
    </Box>
  );
}

/* ---------- Now Playing ---------- */

function useNowPlayingFeed() {
  const feed = useNowPlayingEvents();
  const { nowPlayingHiddenServers } = useUserPreferences();
  const hidden = useMemo(() => new Set(nowPlayingHiddenServers ?? []), [nowPlayingHiddenServers]);
  const streams = useMemo(() => (feed.snapshot?.streams ?? []).filter((stream) => !hidden.has(stream.serverId)), [feed.snapshot, hidden]);
  return { ...feed, streams };
}

function StreamIcon({ type }: { type: NowPlayingStream["mediaType"] }) {
  if (type === "episode") return <Tv size={14} aria-hidden="true" />;
  if (type === "track") return <Music size={14} aria-hidden="true" />;
  return <Film size={14} aria-hidden="true" />;
}

function NowPlayingBox({ nowPlaying }: { nowPlaying: NowPlayingFeed }) {
  const { snapshot, streams } = nowPlaying;
  const transcoding = streams.filter((stream) => stream.playMethod === "transcode").length;
  const kbps = streams.filter((stream) => stream.state !== "paused").reduce((sum, stream) => sum + (stream.bandwidth?.kbps ?? 0), 0);
  const sub = streams.length ? [`${streams.length} stream${streams.length === 1 ? "" : "s"}`, transcoding ? `${transcoding} transcoding` : null, kbps ? formatKbps(kbps) : null].filter(Boolean).join(" · ") : null;
  const shown = streams.slice(0, 3);
  return (
    <Box title="Now Playing" sub={sub} className="dash-np" link={<Link to="/now-playing" className="dash-link">Open</Link>}>
      {snapshot === null ? (
        <p className="dash-empty">Connecting to your media servers</p>
      ) : snapshot.servers.length === 0 ? (
        <p className="dash-empty">No media servers connected</p>
      ) : shown.length === 0 ? (
        <p className="dash-empty">Nothing is playing right now</p>
      ) : (
        <ul className="dash-list">
          {shown.map((stream) => {
            const title = streamTitle(stream);
            const name = title.secondary && stream.mediaType === "episode" && stream.episodeLabel ? `${title.primary} · ${stream.episodeLabel}` : title.primary;
            return (
              <li key={stream.id}>
                <StreamIcon type={stream.mediaType} />
                <span className="dash-grow" title={[title.primary, title.secondary].filter(Boolean).join(" · ")}>{name}</span>
                <span className="dash-muted">{stream.user.name}</span>
                <span className="dash-muted">{playMethodLabel(stream)}{stream.state === "paused" ? " · paused" : ""}</span>
              </li>
            );
          })}
          {streams.length > shown.length ? (
            <li className="dash-more"><Link to="/now-playing" className="dash-link">{streams.length - shown.length} more on Now Playing</Link></li>
          ) : null}
        </ul>
      )}
    </Box>
  );
}

/* ---------- Jobs ---------- */

function useRecentJobs() {
  return useQuery({ queryKey: ["jobs", "dash-recent"], queryFn: () => api.jobs({ completedWithinMinutes: 24 * 60 }), refetchInterval: 15_000 });
}

function JobsBox() {
  const { canStopJob } = useAccess();
  const storageLocations = useStorageLocations();
  const names = { local: storageLocationName(storageLocations, "local"), remote: storageLocationName(storageLocations, "remote") };
  const activeJobs = useQuery({ queryKey: ["jobs", "active"], queryFn: () => api.jobs({ activeOnly: true }), refetchInterval: 3000 });
  const recentJobs = useRecentJobs();
  const [terminating, setTerminating] = useState<JobRecord | null>(null);
  const terminate = useTerminateJobMutation(() => setTerminating(null));
  const active = (activeJobs.data ?? []).filter((job) => job.status === "running" || job.status === "queued");
  const failed = (recentJobs.data ?? []).filter((job) => failedJobStatuses.has(job.status)).slice(0, 3);
  const running = active.filter((job) => job.status === "running").length;
  const sub = [running ? `${running} running` : null, active.length - running ? `${active.length - running} queued` : null, failed.length ? `${failed.length} failed in 24 h` : null].filter(Boolean).join(" · ") || null;
  return (
    <Box title="Jobs" sub={sub} className="dash-jobs" link={<Link to="/logs" className="dash-link">Activity</Link>}>
      {active.length === 0 && failed.length === 0 ? (
        <p className="dash-empty">No jobs running</p>
      ) : (
        <ul className="dash-list">
          {active.slice(0, 5).map((job) => {
            const percent = job.status === "running" ? jobPercent(job) : null;
            return (
              <li key={job.id} className="dash-job">
                <span className="dash-grow">{jobLineLabel(job, names)}</span>
                <span className="dash-muted">{job.status === "queued" ? "Queued" : percent !== null ? `${percent}%` : "Running"}</span>
                <span className="dash-bar" aria-hidden="true"><span style={{ width: `${percent ?? 0}%` }} /></span>
                {canTerminateJob(job) && canStopJob(job) ? (
                  <button type="button" className="dash-icon-button" aria-label={`Stop job #${job.id}`} title="Stop" onClick={() => setTerminating(job)}>
                    <Square size={12} aria-hidden="true" />
                  </button>
                ) : <span />}
              </li>
            );
          })}
          {failed.map((job) => (
            <li key={job.id} className="dash-failed">
              <TriangleAlert size={14} aria-hidden="true" />
              <span className="dash-grow">
                {jobLineLabel(job, names)} <span className="dash-bad">{job.status === "failed" ? "failed" : "partially failed"}</span>
              </span>
              <span className="dash-muted">{agoLabel(job.finishedAt ?? job.createdAt)}</span>
              <CopyRetryAction job={job} compact />
              <Link to="/logs" search={{ job: job.id }} className="dash-link">Details</Link>
            </li>
          ))}
        </ul>
      )}
      <TerminateJobDialog
        job={terminating}
        error={terminate.error?.message}
        isPending={terminate.isPending}
        onClose={() => !terminate.isPending && setTerminating(null)}
        onConfirm={(jobId) => terminate.mutate(jobId)}
      />
    </Box>
  );
}

/* ---------- Library ---------- */

function LibraryLine() {
  const { can } = useAccess();
  const storageLocations = useStorageLocations();
  const localName = storageLocationName(storageLocations, "local");
  const remoteName = storageLocationName(storageLocations, "remote");
  const inventory = useQuery({ queryKey: ["inventory-summary"], queryFn: api.inventorySummary, refetchInterval: 5000 });
  const scanTimestamps = useQuery({ queryKey: ["inventory-scan-timestamps"], queryFn: api.inventoryScanTimestamps, refetchInterval: 60_000 });
  const damaged = useDamagedFiles();
  const totals = inventory.data;
  const lastScan = scanTimestamps.data ? Object.values(scanTimestamps.data.symlinkSections).filter((value): value is string => Boolean(value)).sort().at(-1) : null;
  const number = (value: number | undefined) => (value === undefined ? "…" : formatNumber(value));
  // Orphans open the side that has them, local first.
  const orphanView = totals && totals.localOrphanFiles === 0 && totals.remoteOrphanFiles > 0 ? "remote-orphans" : "local-orphans";
  const items: Array<{ key: string; count: number | undefined; label: string; name: (count: string) => string; view?: "policies" | "links" | "local-orphans" | "remote-orphans" | "damaged"; bad?: boolean; hidden?: boolean }> = [
    { key: "unassigned", count: totals ? inventoryPolicyNeededCount(totals) : undefined, label: "unassigned", name: (count) => `${count} unassigned`, view: "policies" },
    { key: "to-local", count: totals ? inventoryCopyToLocalCount(totals) : undefined, label: `copy to ${localName}`, name: (count) => `${count} to copy to ${localName}` },
    { key: "to-remote", count: totals ? inventoryCopyToRemoteCount(totals) : undefined, label: `copy to ${remoteName}`, name: (count) => `${count} to copy to ${remoteName}` },
    { key: "broken", count: totals?.brokenLinks, label: "broken links", name: (count) => `${count} broken links`, view: "links", bad: true },
    { key: "orphans", count: totals ? totals.localOrphanFiles + totals.remoteOrphanFiles : undefined, label: "orphans", name: (count) => `Review ${count} orphans`, view: orphanView, hidden: !can("library.delete") },
    { key: "damaged", count: damaged.data?.length, label: "damaged", name: (count) => `${count} damaged files`, view: "damaged", bad: true }
  ];
  return (
    <section className="dash-box dash-library" aria-label="Library">
      <h2>Library</h2>
      {items.filter((item) => !item.hidden).map((item) => (
        <Link key={item.key} to="/library" search={item.view ? { view: item.view } : {}} aria-label={item.count === undefined ? undefined : item.name(formatNumber(item.count))} className={`dash-number${item.bad && item.count ? " is-bad" : ""}`}>
          <b>{number(item.count)}</b>
          {item.label}
        </Link>
      ))}
      <span className="dash-sep" aria-hidden="true" />
      <span className="dash-muted">
        {totals ? `${localName} ${formatNumber(totals.localLinks)} · ${remoteName} ${formatNumber(totals.remoteLinks)}` : null}
        {lastScan ? ` · scanned ${agoLabel(lastScan)}` : null}
      </span>
      <Link to="/library" className="dash-link dash-library-open">Open</Link>
    </section>
  );
}

/* ---------- Quick actions ---------- */

function stripLegacyScanSections(options: ScanOptions): ScanOptions {
  const { sections: _legacySections, ...nextOptions } = options;
  return nextOptions;
}

function DashboardActions({ onNote }: { onNote: (note: DashboardNote) => void }) {
  const { can } = useAccess();
  const queryClient = useQueryClient();
  const canManageSettings = can("settings.manage");
  const watchSync = useQuery({ queryKey: watchSyncKey, queryFn: fetchWatchSync, enabled: canManageSettings, refetchInterval: 60_000 });
  const backups = useQuery({ queryKey: ["backups"], queryFn: api.backups, enabled: canManageSettings, refetchInterval: 60_000, retry: false });
  const syncWatch = useMutation({
    mutationFn: startWatchSync,
    onSuccess: (result) => onNote({ text: result.jobId ? `Watch sync job #${result.jobId} queued.` : "No watch sync pairs are ready to sync.", error: false }),
    onError: (error) => onNote({ text: error.message, error: true }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: watchSyncKey })
  });
  const backup = useMutation({
    mutationFn: api.runBackup,
    onSuccess: (result) => onNote({ text: `Backup job #${result.jobId} queued.`, error: false }),
    onError: (error) => onNote({ text: error.message, error: true }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["backups"] })
  });
  const readyPairs = (watchSync.data?.pairs ?? []).filter((pair) => pair.approvedAt && pair.enabled && !pair.paused).length;
  return (
    <div className="dash-actions" role="toolbar" aria-label="Quick actions">
      {can("jobs.run") ? <LibraryMaintenanceActions onNote={onNote} /> : null}
      {canManageSettings && watchSync.data?.pairs?.length ? (
        <button type="button" disabled={syncWatch.isPending || readyPairs === 0 || Boolean(watchSync.data.settings?.paused)} title={watchSync.data.settings?.paused ? "Watch sync is paused" : undefined} onClick={() => syncWatch.mutate()}>
          <ArrowLeftRight size={14} aria-hidden="true" />
          Sync watch state
        </button>
      ) : null}
      {canManageSettings ? (
        <button type="button" disabled={backup.isPending || Boolean(backups.data?.activeJobId)} onClick={() => backup.mutate()}>
          <DatabaseBackup size={14} aria-hidden="true" />
          Back up now
        </button>
      ) : null}
    </div>
  );
}

/**
 * Scan library and Run audit with the saved scope. The scope pickers the dashboard used to show inline now open in a dialog.
 * People who manage settings save their scope as the shared default; everyone else changes it for this visit only.
 */
function LibraryMaintenanceActions({ onNote }: { onNote: (note: DashboardNote) => void }) {
  const queryClient = useQueryClient();
  const { can } = useAccess();
  const { autoOpenTaskStatus } = useUserPreferences();
  const storageLocations = useStorageLocations();
  const localName = storageLocationName(storageLocations, "local");
  const remoteName = storageLocationName(storageLocations, "remote");
  const canManageSettings = can("settings.manage");
  const [scanOptions, setScanOptions] = useState<ScanOptions>({ scanSymlinks: true, scanLocal: false, scanRemote: false });
  const [auditSettingsDraft, setAuditSettingsDraft] = useState<AuditSettings>({ sections: [], targets: ["local"] });
  const [scopeDialog, setScopeDialog] = useState<"scan" | "audit" | null>(null);
  const [auditPrompt, setAuditPrompt] = useState<AuditPrompt | null>(null);
  const [scanStatusPrompt, setScanStatusPrompt] = useState<ScanStatusPrompt | null>(null);
  const [scanBatchStatusPrompt, setScanBatchStatusPrompt] = useState<ScanBatchStatusPrompt | null>(null);
  const sectionSummaries = useQuery({ queryKey: ["sections"], queryFn: api.sections, refetchInterval: 5000 });
  const sectionSettings = useQuery({ queryKey: ["section-settings"], queryFn: api.getSections });
  const paths = useQuery({ queryKey: ["paths"], queryFn: api.getPaths, enabled: canManageSettings });
  const scanSettings = useQuery({ queryKey: ["scan-settings"], queryFn: api.getScanSettings });
  const auditSettings = useQuery({ queryKey: ["audit-settings"], queryFn: api.getAuditSettings });
  const scanTimestamps = useQuery({ queryKey: ["inventory-scan-timestamps"], queryFn: api.inventoryScanTimestamps, refetchInterval: 60_000 });
  // Running scans lock their folders.
  const jobs = useQuery({ queryKey: ["jobs", "active"], queryFn: () => api.jobs({ activeOnly: true }), refetchInterval: 3000 });
  const saveScanSettings = useMutation({
    mutationFn: api.saveScanSettings,
    onSuccess: (settings) => queryClient.setQueryData(["scan-settings"], settings)
  });
  const saveAuditSettings = useMutation({
    mutationFn: api.saveAuditSettings,
    onSuccess: (settings) => queryClient.setQueryData(["audit-settings"], settings)
  });
  const configuredSectionNames = sectionSettings.data?.sections ?? sectionSummaries.data?.map((section) => section.section) ?? [];
  const availableScanSections = configuredSectionNames.map((section) => ({
    section,
    title: sectionSettings.data?.sectionTitles?.[section] ?? sectionSummaries.data?.find((summary) => summary.section === section)?.title ?? section
  }));
  const availableScanSectionNames = availableScanSections.map((section) => section.section);
  const startScan = useMutation({
    mutationFn: (options: ScanOptions) => api.startScan(options),
    onSuccess: async (result, submittedOptions) => {
      for (const key of ["scans", "inventory-summary", "inventory-scan-timestamps", "media-links", "media-links-page", "dashboard-remote-work-links", "media-link-tree", "storage-files"]) {
        void queryClient.invalidateQueries({ queryKey: [key] });
      }
      await queryClient.refetchQueries({ queryKey: ["jobs"] });
      const jobIds = result.jobIds?.length ? result.jobIds : [result.jobId];
      onNote({ text: jobIds.length > 1 ? `${jobIds.length} inventory scan jobs queued.` : `Inventory scan job #${result.jobId} queued.`, error: false });
      if (!autoOpenTaskStatus) return;
      if (jobIds.length > 1) {
        setScanBatchStatusPrompt({ key: `scan-batch-${jobIds.join("-")}`, title: "Folder scans", description: `${jobIds.length} inventory scan jobs queued`, jobIds });
      } else {
        setScanStatusPrompt({ key: `scan-job-${result.jobId}`, title: "Inventory scan", description: formatScanScope(submittedOptions, availableScanSections), jobId: result.jobId });
      }
    },
    onError: (error) => onNote({ text: error.message, error: true })
  });

  useEffect(() => {
    if (scanSettings.data) setScanOptions(stripLegacyScanSections(scanSettings.data));
  }, [scanSettings.data]);

  useEffect(() => {
    if (auditSettings.data) setAuditSettingsDraft(auditSettings.data);
  }, [auditSettings.data]);

  const activeScanJobs = (jobs.data ?? []).filter((job) => job.type === "scan" && isActiveQueueJob(job));
  const activeSymlinkScanSections = new Set(activeScanJobs.flatMap((job) => scanOptionsFromJob(job)?.symlinkSections ?? []));
  const activeLocalScanSections = new Set(activeScanJobs.flatMap((job) => scanOptionsFromJob(job)?.localSections ?? []));
  const activeRemoteScan = activeScanJobs.some((job) => scanOptionsFromJob(job)?.scanRemote);
  const selectedSymlinkSections = (scanOptions.symlinkSections ?? scanOptions.sections ?? availableScanSectionNames).filter((section) => availableScanSectionNames.includes(section));
  const selectedLocalSections = (scanOptions.localSections ?? scanOptions.sections ?? availableScanSectionNames).filter((section) => availableScanSectionNames.includes(section));
  const selectedAuditSections = auditSettingsDraft.sections.filter((section) => availableScanSectionNames.includes(section));
  // The dashboard audit is library-wide, so it is local only: library-wide remote audits are refused.
  const auditLocalSelected = normalizeAuditTargets(auditSettingsDraft.targets).includes("local");
  const hasScanScope = scanOptions.scanSymlinks || scanOptions.scanLocal || scanOptions.scanRemote;
  const busySections = [
    ...(scanOptions.scanSymlinks ? selectedSymlinkSections.filter((section) => activeSymlinkScanSections.has(section)) : []),
    ...(scanOptions.scanLocal ? selectedLocalSections.filter((section) => activeLocalScanSections.has(section)) : [])
  ];
  const canRunScan =
    hasScanScope &&
    (!scanOptions.scanSymlinks || selectedSymlinkSections.length > 0) &&
    (!scanOptions.scanLocal || selectedLocalSections.length > 0) &&
    (!scanOptions.scanRemote || !canManageSettings || Boolean(paths.data?.remoteDir)) &&
    busySections.length === 0 &&
    (!scanOptions.scanRemote || !activeRemoteScan);
  const canRunAudit = auditLocalSelected && selectedAuditSections.length > 0;
  const scanBlockedReason = !hasScanScope
    ? "Choose what to scan first"
    : busySections.length > 0
      ? `Wait for the active scan in ${[...new Set(busySections)].map((section) => sectionDisplayTitle(availableScanSections.find((item) => item.section === section) ?? { section })).join(", ")}`
      : undefined;

  function updateScanOptions(nextOptions: ScanOptions) {
    const normalizedOptions = stripLegacyScanSections(nextOptions);
    setScanOptions(normalizedOptions);
    // These remembered defaults are shared settings; other people's choices last only for this visit.
    if (canManageSettings) saveScanSettings.mutate(normalizedOptions);
  }

  function updateAuditSettings(nextSettings: AuditSettings) {
    setAuditSettingsDraft(nextSettings);
    if (canManageSettings) saveAuditSettings.mutate(nextSettings);
  }

  function toggleScanSection(scope: "symlinkSections" | "localSections", section: string, checked: boolean) {
    const current = scanOptions[scope] ?? scanOptions.sections ?? availableScanSectionNames;
    const next = new Set(checked ? [...current, section] : current.filter((value) => value !== section));
    updateScanOptions({ ...scanOptions, [scope]: availableScanSectionNames.filter((value) => next.has(value)) });
  }

  function toggleAuditSection(section: string, checked: boolean) {
    const next = new Set(checked ? [...auditSettingsDraft.sections, section] : auditSettingsDraft.sections.filter((value) => value !== section));
    updateAuditSettings({ ...auditSettingsDraft, sections: availableScanSectionNames.filter((value) => next.has(value)) });
  }

  function toggleAuditTarget(target: StorageRootType, checked: boolean) {
    updateAuditSettings({ ...auditSettingsDraft, targets: checked ? ["local"] : normalizeAuditTargets(auditSettingsDraft.targets).filter((value) => value !== target) });
  }

  function openAuditPrompt() {
    if (!canRunAudit) return;
    const options: Omit<AuditOptions, "mode"> = { targets: ["local"], sections: selectedAuditSections };
    setAuditPrompt({ title: "Audit selected targets", description: formatAuditScope(options, availableScanSections), options });
  }

  const allScanSelected =
    scanOptions.scanSymlinks && scanOptions.scanLocal && scanOptions.scanRemote &&
    selectedSymlinkSections.length === availableScanSectionNames.length && selectedLocalSections.length === availableScanSectionNames.length;

  return (
    <>
      <span className="dash-action-pair">
        <button type="button" disabled={startScan.isPending || !canRunScan} title={scanBlockedReason} onClick={() => startScan.mutate(stripLegacyScanSections(scanOptions))}>
          <RefreshCw size={14} aria-hidden="true" />
          Scan library
        </button>
        <button type="button" className="dash-scope-button" aria-label="Choose what to scan" title="Choose what to scan" onClick={() => setScopeDialog("scan")}>
          <SlidersHorizontal size={14} aria-hidden="true" />
        </button>
      </span>
      <span className="dash-action-pair">
        <button type="button" disabled={!canRunAudit} title={canRunAudit ? undefined : "Choose folders to audit first"} onClick={openAuditPrompt}>
          <ListChecks size={14} aria-hidden="true" />
          Run audit
        </button>
        <button type="button" className="dash-scope-button" aria-label="Choose what to audit" title="Choose what to audit" onClick={() => setScopeDialog("audit")}>
          <SlidersHorizontal size={14} aria-hidden="true" />
        </button>
      </span>
      <ScopeDialog open={scopeDialog === "scan"} title="Scan scope" description="What Scan library reads. Scans update SRTL's inventory and never change media files." onClose={() => setScopeDialog(null)}>
        <div className="inventory-scope-toolbar">
          <span>Inventory scope</span>
          <div className="inventory-scope-actions">
            <button type="button" className="secondary inventory-scope-action" disabled={allScanSelected} onClick={() => updateScanOptions({ ...scanOptions, scanSymlinks: true, scanLocal: true, scanRemote: true, symlinkSections: availableScanSectionNames, localSections: availableScanSectionNames })}>
              Select all
            </button>
            <button type="button" className="secondary inventory-scope-action" disabled={!hasScanScope} onClick={() => updateScanOptions({ ...scanOptions, scanSymlinks: false, scanLocal: false, scanRemote: false, symlinkSections: [], localSections: [] })}>
              Clear all
            </button>
          </div>
        </div>
        <div className="inventory-scope-list" role="group" aria-label="Inventory scan scopes">
          <ScanScopeBlock
            checked={scanOptions.scanSymlinks}
            icon={<Link2 size={15} />}
            title="Symlinks"
            detail={`${scanOptions.scanSymlinks ? selectedSymlinkSections.length : 0}/${availableScanSections.length} folders - ${selectedSymlinkSections.length === 0 ? "No folders selected" : oldestScanAgeLabel(selectedSymlinkSections.map((section) => scanTimestamps.data?.symlinkSections[section] ?? null))}`}
            onChange={(checked) => updateScanOptions({ ...scanOptions, scanSymlinks: checked })}
          >
            <FolderScopePicker
              ariaLabel="Symlink folders"
              emptyMessage="No library sections configured."
              sections={availableScanSections}
              lastScannedBySection={scanTimestamps.data?.symlinkSections ?? {}}
              activeSections={activeSymlinkScanSections}
              selectedSections={selectedSymlinkSections}
              onToggle={(section, checked) => toggleScanSection("symlinkSections", section, checked)}
            />
          </ScanScopeBlock>
          <ScanScopeBlock
            checked={scanOptions.scanLocal}
            icon={<HardDrive size={15} />}
            title={`${localName} files`}
            detail={`${scanOptions.scanLocal ? selectedLocalSections.length : 0}/${availableScanSections.length} folders - ${selectedLocalSections.length === 0 ? "No folders selected" : oldestScanAgeLabel(selectedLocalSections.map((section) => scanTimestamps.data?.localSections[section] ?? null))}`}
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
            detail={scanAgeLabel(scanTimestamps.data?.remoteRoot ?? null)}
            onChange={(checked) => updateScanOptions({ ...scanOptions, scanRemote: checked })}
          />
        </div>
      </ScopeDialog>
      <ScopeDialog open={scopeDialog === "audit"} title="Audit scope" description={`What Run audit reads: every byte of each file in the chosen ${localName} folders, as a read-only job.`} onClose={() => setScopeDialog(null)}>
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
        </div>
        <p className="section-settings-help">
          Library-wide {remoteName} audits are turned off: they would read every {remoteName} byte through the remote mount. Audit {remoteName} files from a title in the Library instead.
        </p>
      </ScopeDialog>
      <AuditDialog prompt={auditPrompt} onClose={() => setAuditPrompt(null)} />
      <ScanBatchStatusDialog
        prompt={scanBatchStatusPrompt}
        sections={availableScanSections}
        onClose={() => setScanBatchStatusPrompt(null)}
        onJobSelect={(job) => {
          setScanBatchStatusPrompt(null);
          setScanStatusPrompt({ key: `scan-job-${job.id}`, title: "Inventory scan", description: formatScanScope(scanOptionsFromJob(job), availableScanSections), jobId: job.id });
        }}
      />
      <ScanStatusDialog prompt={scanStatusPrompt} onClose={() => setScanStatusPrompt(null)} />
    </>
  );
}

function ScopeDialog({ open, title, description, onClose, children }: { open: boolean; title: string; description: string; onClose: () => void; children: ReactNode }) {
  const dialogRef = useModalLifecycle(open, onClose);
  if (!open) return null;
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section ref={dialogRef} className="audit-dialog dash-scope-dialog" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1}>
        <div className="audit-dialog-header">
          <div className="audit-dialog-title-block">
            <h2>{title}</h2>
            <p>{description}</p>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </div>
        <div className="dash-scope-body">{children}</div>
        <div className="terminate-dialog-actions">
          <button type="button" onClick={onClose}>Done</button>
        </div>
      </section>
    </div>
  );
}
