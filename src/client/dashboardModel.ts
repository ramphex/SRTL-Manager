import type { AccountList, SecurityEventPage } from "../shared/auth";
import type { BackupState } from "../shared/backups";
import type { NowPlayingHostSample, NowPlayingServerState } from "../shared/nowPlaying";
import type { AccountRole, Permission } from "../shared/permissions";
import { roleHasPermission } from "../shared/permissions";
import type { RadarrOverview } from "../shared/radarr";
import type { ReRequestList } from "../shared/reRequests";
import type { SonarrOverview } from "../shared/sonarr";
import type { JobRecord } from "../shared/types";
import type { WatchSyncState } from "../shared/watchSync";
import { scanProgressFromJob, scanStagePercent } from "./appShared";
import { auditProgressFromJob, auditProgressPercent, copyOverallProgressPercent, copyProgressFromJob, scanScopeLabels } from "./jobPresentationUtils";
import { copyOptionsFromJob, scanOptionsFromJob } from "./jobScopeLocks";
import { formatJobType } from "./logDisplay";

export type DashboardTone = "ok" | "warn" | "bad";

/** One line in the dashboard's Status list. `value` is the short headline, `detail` the muted rest. */
export interface DashboardStatusRow {
  key: DashboardStatusKey;
  label: string;
  tone: DashboardTone;
  value: string;
  detail: string | null;
}

export type DashboardStatusKey = "jobs" | "arr" | "reRequests" | "mediaServers" | "watchSync" | "backups" | "accounts" | "security" | "system";
export type DashboardActionKey = "scan" | "audit" | "watchSync" | "backup";

/** The permission each Status row needs. It matches the permission of the endpoint the row reads. */
export const dashboardStatusPermissions: Record<DashboardStatusKey, Permission> = {
  jobs: "library.view",
  arr: "settings.manage",
  reRequests: "library.delete",
  mediaServers: "library.view",
  watchSync: "settings.manage",
  backups: "settings.manage",
  accounts: "moderators.manage",
  security: "activity.view",
  system: "library.view"
};

/** The permission each quick action needs, matching the endpoint it calls. */
export const dashboardActionPermissions: Record<DashboardActionKey, Permission> = {
  scan: "jobs.run",
  audit: "jobs.run",
  watchSync: "settings.manage",
  backup: "settings.manage"
};

const statusOrder: DashboardStatusKey[] = ["jobs", "arr", "reRequests", "mediaServers", "watchSync", "backups", "accounts", "security", "system"];
const actionOrder: DashboardActionKey[] = ["scan", "audit", "watchSync", "backup"];

export function dashboardStatusKeysFor(role: AccountRole): DashboardStatusKey[] {
  return statusOrder.filter((key) => roleHasPermission(role, dashboardStatusPermissions[key]));
}

export function dashboardActionKeysFor(role: AccountRole): DashboardActionKey[] {
  return actionOrder.filter((key) => roleHasPermission(role, dashboardActionPermissions[key]));
}

const toneRank: Record<DashboardTone, number> = { bad: 0, warn: 1, ok: 2 };

/** Problems first, worst first; rows of the same tone keep their usual order. */
export function sortDashboardStatusRows(rows: DashboardStatusRow[]): DashboardStatusRow[] {
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => toneRank[a.row.tone] - toneRank[b.row.tone] || a.index - b.index)
    .map(({ row }) => row);
}

/** The phone list shows problems only, then this line naming everything that is fine. */
export function dashboardAllClearLabel(rows: DashboardStatusRow[]): string | null {
  const clear = rows.filter((row) => row.tone === "ok").map((row) => row.label);
  return clear.length ? `All clear: ${clear.join(", ")}` : null;
}

export function agoLabel(value: string | null | undefined, now = Date.now()): string | null {
  if (!value) return null;
  const elapsed = now - Date.parse(value);
  if (!Number.isFinite(elapsed)) return null;
  const minutes = Math.max(0, Math.floor(elapsed / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} days ago`;
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
const join = (parts: Array<string | null | false | undefined>) => parts.filter(Boolean).join(" · ") || null;

export const failedJobStatuses = new Set<JobRecord["status"]>(["failed", "partially_failed"]);

export function jobsStatus(active: JobRecord[], recent: JobRecord[]): DashboardStatusRow {
  const running = active.filter((job) => job.status === "running").length;
  const queued = active.filter((job) => job.status === "queued").length;
  const failed = recent.filter((job) => failedJobStatuses.has(job.status)).length;
  return {
    key: "jobs",
    label: "Jobs",
    tone: failed > 0 ? "bad" : "ok",
    value: failed > 0 ? `${failed} failed` : running > 0 ? `${running} running` : "Idle",
    detail: join([failed > 0 && running > 0 ? `${running} running` : null, queued > 0 ? `${queued} queued` : null, failed > 0 ? "last 24 h" : null])
  };
}

/** Null when no Radarr or Sonarr instance is set up, so the row stays away. */
export function arrStatus(radarr: RadarrOverview | undefined, sonarr: SonarrOverview | undefined): DashboardStatusRow | null {
  const instances = [...(radarr?.instances ?? []), ...(sonarr?.instances ?? [])];
  if (instances.length === 0) return null;
  const review = instances.reduce((sum, instance) => sum + instance.review, 0);
  const errors = instances.reduce((sum, instance) => sum + instance.errors, 0);
  const failing = instances.filter((instance) => instance.settings.lastError).length;
  const problems = errors + failing;
  return {
    key: "arr",
    label: "Radarr & Sonarr",
    tone: problems > 0 ? "bad" : review > 0 ? "warn" : "ok",
    value: failing > 0 ? `${plural(failing, "instance")} failing` : errors > 0 ? plural(errors, "error") : review > 0 ? `${review} to review` : "Connected",
    detail: join([problems > 0 && review > 0 ? `${review} to review` : null, plural(instances.length, "instance")])
  };
}

export function reRequestStatus(list: ReRequestList | undefined): DashboardStatusRow | null {
  if (!list?.counts) return null;
  const failed = list.counts.failed ?? 0;
  const waiting = (list.counts.queued ?? 0) + (list.counts.pending ?? 0);
  return {
    key: "reRequests",
    label: "Re-requests",
    tone: failed > 0 ? "bad" : "ok",
    value: failed > 0 ? `${failed} failed` : waiting > 0 ? `${waiting} queued` : "Nothing waiting",
    detail: failed > 0 && waiting > 0 ? `${waiting} queued` : null
  };
}

const liveServerStatuses = new Set<NowPlayingServerState["status"]>(["live", "polling"]);

export function mediaServerStatus(servers: NowPlayingServerState[] | undefined): DashboardStatusRow | null {
  if (!servers?.length) return null;
  const up = servers.filter((server) => liveServerStatuses.has(server.status)).length;
  const connecting = servers.filter((server) => server.status === "connecting").length;
  const down = servers.length - up - connecting;
  return {
    key: "mediaServers",
    label: "Media servers",
    tone: down > 0 ? "bad" : "ok",
    value: `${up} of ${servers.length} live`,
    detail: down > 0 ? `${down} not reachable` : connecting > 0 ? `${connecting} connecting` : null
  };
}

/** Null until at least one Plex and Jellyfin pair is set up. */
export function watchSyncStatus(state: WatchSyncState | undefined, now = Date.now()): DashboardStatusRow | null {
  if (!state?.pairs?.length || !state.settings) return null;
  const syncing = state.pairs.filter((pair) => pair.enabled && !pair.paused && pair.approvedAt);
  const failing = state.pairs.filter((pair) => pair.enabled && pair.lastError).length;
  const lastSync = state.pairs.map((pair) => pair.lastSyncAt).filter((value): value is string => Boolean(value)).sort().at(-1) ?? state.settings.lastReconcileAt;
  return {
    key: "watchSync",
    label: "Watch sync",
    tone: failing > 0 ? "bad" : state.settings.paused ? "warn" : "ok",
    value: failing > 0 ? `${plural(failing, "pair")} failing` : state.settings.paused ? "Paused" : "Active",
    detail: join([plural(syncing.length, "pair"), agoLabel(lastSync, now)])
  };
}

const backupAlertLabels = { failed: "Last backup failed", unavailable: "Cannot run", overdue: "Overdue" } as const;

export function backupStatus(state: BackupState | undefined, now = Date.now()): DashboardStatusRow | null {
  if (!state?.settings) return null;
  if (state.alert) {
    return { key: "backups", label: "Backups", tone: "bad", value: backupAlertLabels[state.alert.kind], detail: state.alert.message };
  }
  if (!state.settings.enabled) return { key: "backups", label: "Backups", tone: "warn", value: "Turned off", detail: null };
  const last = state.lastRun?.status === "completed" ? agoLabel(state.lastRun.finishedAt, now) : null;
  const next = state.nextRunAt ? `next ${new Date(state.nextRunAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : null;
  return {
    key: "backups",
    label: "Backups",
    tone: "ok",
    value: state.activeJobId ? "Running" : last ? `Done ${last}` : "Scheduled",
    detail: next
  };
}

export function accountsStatus(list: AccountList | undefined): DashboardStatusRow | null {
  if (!list?.accounts) return null;
  const active = list.accounts.filter((account) => !account.disabledAt);
  const mustChange = active.filter((account) => account.mustChangePassword).length;
  return {
    key: "accounts",
    label: "Accounts",
    tone: "ok",
    value: plural(active.length, "account"),
    detail: mustChange > 0 ? `${mustChange} must change password` : null
  };
}

const failedSignInEvents = new Set(["login_failed", "login_locked", "reauthentication_failed"]);

export function securityStatus(page: SecurityEventPage | undefined, now = Date.now()): DashboardStatusRow | null {
  if (!page?.events) return null;
  const recent = page.events.filter((event) => now - Date.parse(event.createdAt) <= 86_400_000);
  const failed = recent.filter((event) => failedSignInEvents.has(event.event)).length;
  const locked = recent.filter((event) => event.event === "login_locked").length;
  return {
    key: "security",
    label: "Security",
    tone: locked > 0 ? "bad" : failed > 0 ? "warn" : "ok",
    value: locked > 0 ? `${plural(locked, "sign-in lock")}` : plural(failed, "failed sign-in"),
    detail: "last 24 h"
  };
}

export interface DashboardHealth {
  worker: "ready" | "stale" | "not_started" | string;
  expectedWorkerCount: number;
  readyWorkerCount: number;
}

export function systemStatus(health: DashboardHealth | undefined, sample: NowPlayingHostSample | undefined): DashboardStatusRow | null {
  if (!health?.worker) return null;
  const ready = health.worker === "ready";
  const memory = sample?.memoryTotalBytes ? Math.round(((sample.memoryUsedBytes ?? 0) / sample.memoryTotalBytes) * 100) : null;
  return {
    key: "system",
    label: "System",
    tone: ready ? "ok" : "bad",
    value: ready ? "Healthy" : health.worker === "stale" ? "Worker not responding" : "Worker not started",
    detail: join([
      `workers ${health.readyWorkerCount}/${health.expectedWorkerCount}`,
      sample?.cpuPercent !== null && sample?.cpuPercent !== undefined ? `CPU ${Math.round(sample.cpuPercent)}%` : null,
      memory !== null ? `RAM ${memory}%` : null
    ])
  };
}

export function jobPercent(job: JobRecord): number | null {
  if (job.type === "copy") return copyOverallProgressPercent(job, copyProgressFromJob(job));
  if (job.type === "scan") return scanStagePercent(job, scanProgressFromJob(job));
  if (job.type === "audit") return auditProgressPercent(job, auditProgressFromJob(job));
  const progress = job.progress as { current?: unknown; total?: unknown } | null | undefined;
  const current = Number(progress?.current);
  const total = Number(progress?.total);
  return Number.isFinite(current) && Number.isFinite(total) && total > 0 ? Math.min(100, Math.round((current / total) * 100)) : null;
}

export function jobLineLabel(job: JobRecord, names: { local: string; remote: string }): string {
  if (job.type === "copy") {
    const direction = copyOptionsFromJob(job)?.direction;
    const titles = job.selection?.titles.length ?? 0;
    const target = direction === "to_remote" ? names.remote : names.local;
    return [`Copy to ${target}`, titles ? `${titles} title${titles === 1 ? "" : "s"}` : null].filter(Boolean).join(" · ");
  }
  if (job.type === "scan") {
    const options = scanOptionsFromJob(job);
    if (options?.titleScopes?.length) return "Title rescan";
    const scopes = options ? scanScopeLabels(options) : [];
    return ["Inventory scan", scopes.join(", ") || null].filter(Boolean).join(" · ");
  }
  return formatJobType(job.type);
}
