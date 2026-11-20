import { describe, expect, it } from "vitest";
import {
  accountsStatus,
  arrStatus,
  backupStatus,
  dashboardActionKeysFor,
  dashboardAllClearLabel,
  dashboardStatusKeysFor,
  jobLineLabel,
  jobsStatus,
  mediaServerStatus,
  reRequestStatus,
  securityStatus,
  sortDashboardStatusRows,
  systemStatus,
  watchSyncStatus,
  type DashboardStatusRow
} from "../src/client/dashboardModel";
import type { BackupState } from "../src/shared/backups";
import type { NowPlayingServerState } from "../src/shared/nowPlaying";
import type { RadarrOverview } from "../src/shared/radarr";
import type { JobRecord } from "../src/shared/types";
import type { WatchSyncState } from "../src/shared/watchSync";

const now = Date.parse("2026-11-20T12:00:00.000Z");
const row = (key: DashboardStatusRow["key"], tone: DashboardStatusRow["tone"], label: string = key): DashboardStatusRow => ({ key, label, tone, value: "", detail: null });
const job = (id: number, status: JobRecord["status"], overrides: Partial<JobRecord> = {}): JobRecord => ({
  id, type: "copy", status, createdAt: "2026-11-20T11:00:00.000Z", startedAt: null, finishedAt: null, progress: null, ...overrides
});

describe("dashboard roles", () => {
  it("shows owners and admins every status row and action", () => {
    for (const role of ["owner", "admin"] as const) {
      expect(dashboardStatusKeysFor(role)).toEqual(["jobs", "arr", "reRequests", "mediaServers", "watchSync", "backups", "accounts", "security", "system"]);
      expect(dashboardActionKeysFor(role)).toEqual(["scan", "audit", "watchSync", "backup"]);
    }
  });

  it("limits moderators to what their API access allows", () => {
    expect(dashboardStatusKeysFor("moderator")).toEqual(["jobs", "mediaServers", "system"]);
    expect(dashboardActionKeysFor("moderator")).toEqual(["scan", "audit"]);
  });
});

describe("dashboard status order", () => {
  it("puts problems first, worst first, and keeps the usual order within a tone", () => {
    const sorted = sortDashboardStatusRows([row("jobs", "ok"), row("arr", "warn"), row("reRequests", "bad"), row("mediaServers", "ok"), row("backups", "bad")]);
    expect(sorted.map((entry) => entry.key)).toEqual(["reRequests", "backups", "arr", "jobs", "mediaServers"]);
  });

  it("names the areas that are fine for the phone's all-clear line", () => {
    expect(dashboardAllClearLabel([row("jobs", "bad", "Jobs"), row("mediaServers", "ok", "Media servers"), row("system", "ok", "System")])).toBe("All clear: Media servers, System");
    expect(dashboardAllClearLabel([row("jobs", "bad", "Jobs")])).toBeNull();
  });
});

describe("dashboard status rows", () => {
  it("marks jobs bad only when something failed in the window", () => {
    expect(jobsStatus([job(1, "running")], [])).toMatchObject({ tone: "ok", value: "1 running" });
    expect(jobsStatus([job(1, "running")], [job(2, "partially_failed")])).toMatchObject({ tone: "bad", value: "1 failed", detail: "1 running · last 24 h" });
    expect(jobsStatus([], [job(3, "completed")])).toMatchObject({ tone: "ok", value: "Idle" });
  });

  it("hides rows for services that are not set up", () => {
    expect(arrStatus({ instances: [], limit: 5 }, undefined)).toBeNull();
    expect(mediaServerStatus([])).toBeNull();
    expect(watchSyncStatus({ pairs: [] } as unknown as WatchSyncState, now)).toBeNull();
  });

  it("warns about titles to review and fails on instance errors", () => {
    const instance = (review: number, errors: number, lastError: string | null = null) => ({ settings: { lastError }, movies: 10, mapped: 10, review, errors }) as unknown as RadarrOverview["instances"][number];
    expect(arrStatus({ instances: [instance(4, 0), instance(0, 0)], limit: 5 }, undefined)).toMatchObject({ tone: "warn", value: "4 to review", detail: "2 instances" });
    expect(arrStatus({ instances: [instance(0, 0, "Unauthorized")], limit: 5 }, undefined)).toMatchObject({ tone: "bad", value: "1 instance failing" });
  });

  it("flags failed re-requests and unreachable media servers", () => {
    expect(reRequestStatus({ items: [], counts: { queued: 2, pending: 0, requested: 5, failed: 1, unmatched: 0, skipped: 0 }, perMinute: 6 })).toMatchObject({ tone: "bad", value: "1 failed", detail: "2 queued" });
    const server = (status: NowPlayingServerState["status"]) => ({ status }) as NowPlayingServerState;
    expect(mediaServerStatus([server("live"), server("polling")])).toMatchObject({ tone: "ok", value: "2 of 2 live" });
    expect(mediaServerStatus([server("live"), server("unreachable")])).toMatchObject({ tone: "bad", value: "1 of 2 live", detail: "1 not reachable" });
  });

  it("reports watch sync pauses and backup alerts", () => {
    const state = { settings: { paused: true, lastReconcileAt: "2026-11-20T11:48:00.000Z" }, pairs: [{ enabled: true, paused: false, approvedAt: "x", lastSyncAt: null, lastError: null }] } as unknown as WatchSyncState;
    expect(watchSyncStatus(state, now)).toMatchObject({ tone: "warn", value: "Paused", detail: "1 pair · 12 min ago" });
    const backups = { alert: { kind: "overdue", message: "No backup in 2 days" }, settings: { enabled: true } } as unknown as BackupState;
    expect(backupStatus(backups, now)).toMatchObject({ tone: "bad", value: "Overdue", detail: "No backup in 2 days" });
  });

  it("counts recent failed sign-ins and active accounts", () => {
    const event = (kind: string, createdAt: string) => ({ id: 1, createdAt, event: kind, username: null, ip: null, device: null, details: {} });
    const page = { events: [event("login_failed", "2026-11-20T10:00:00.000Z"), event("login_failed", "2026-11-18T10:00:00.000Z"), event("login_succeeded", "2026-11-20T10:00:00.000Z")], hasMore: false, retentionDays: 30 };
    expect(securityStatus(page, now)).toMatchObject({ tone: "warn", value: "1 failed sign-in" });
    const account = (disabledAt: string | null, mustChangePassword: boolean) => ({ disabledAt, mustChangePassword }) as never;
    expect(accountsStatus({ accounts: [account(null, true), account(null, false), account("x", false)], activity: [] })).toMatchObject({ value: "2 accounts", detail: "1 must change password" });
  });

  it("reports the worker and host load on the System line", () => {
    expect(systemStatus({ worker: "ready", expectedWorkerCount: 4, readyWorkerCount: 4 }, { cpuPercent: 23.4, memoryUsedBytes: 41, memoryTotalBytes: 100 } as never)).toMatchObject({ tone: "ok", value: "Healthy", detail: "workers 4/4 · CPU 23% · RAM 41%" });
    expect(systemStatus({ worker: "stale", expectedWorkerCount: 4, readyWorkerCount: 0 }, undefined)).toMatchObject({ tone: "bad", value: "Worker not responding" });
  });
});

describe("dashboard job lines", () => {
  it("names copy direction and title count", () => {
    const copy = job(5, "running", { options: { direction: "to_local" }, selection: { total: 2, unavailable: 0, titles: [{ section: "a", itemName: "One", count: 1 }, { section: "a", itemName: "Two", count: 1 }] } } as Partial<JobRecord>);
    expect(jobLineLabel(copy, { local: "Local", remote: "Remote" })).toBe("Copy to Local · 2 titles");
  });
});
