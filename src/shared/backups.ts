/** Scheduled database backups: the settings, schedule and alert rules shared by the API, the worker and the web app. */

export type BackupTrigger = "scheduled" | "manual";

export interface BackupSettings {
  enabled: boolean;
  /** Daily start in server-local time, as HH:MM. */
  time: string;
  keep: number;
  /** Null follows the deployment default (SRTL_BACKUP_DIR). */
  location: string | null;
}

export const defaultBackupSettings: BackupSettings = { enabled: true, time: "03:30", keep: 7, location: null };
/** Never fewer verified backups than this, whatever the keep setting says. */
export const minimumVerifiedBackups = 2;
export const maximumKeptBackups = 365;
/** Backups go in this folder inside the location, so SRTL never changes the permissions of a folder it did not create. */
export const backupFolderName = "srtl-manager-backups";
/** How long after its start time a scheduled backup may be missing before it counts as overdue. */
export const backupOverdueGraceMs = 2 * 60 * 60 * 1_000;

export interface BackupEntry {
  name: string;
  createdAt: string;
  sizeBytes: number;
  verified: boolean;
  /** Why this backup does not count as verified. */
  problem: string | null;
  appVersion: string | null;
  migration: number | null;
  databaseSizeBytes: number | null;
}

/** What the worker last found at the backup location. Only the worker touches that folder. */
export interface BackupLocationStatus {
  location: string;
  directory: string;
  checkedAt: string;
  /** False when a backup could not run right now: the location or the PostgreSQL tools are not usable. */
  ready: boolean;
  /** Why backups cannot run, in words for the admin. */
  problem: string | null;
  /** The location works, but cannot keep backups private. */
  permissionsWarning: string | null;
  freeBytes: number | null;
  backups: BackupEntry[];
}

export interface BackupRunSummary {
  jobId: number;
  status: "completed" | "partially_failed" | "failed" | "cancelled";
  trigger: BackupTrigger;
  startedAt: string | null;
  finishedAt: string | null;
  message: string;
}

export type BackupAlertKind = "failed" | "unavailable" | "overdue";

export interface BackupAlert {
  kind: BackupAlertKind;
  message: string;
}

export interface BackupState {
  settings: BackupSettings;
  /** The location in effect: the saved one, or the deployment default. */
  location: string;
  defaultLocation: string;
  /** Set when the saved location is refused, before the worker ever tries it. */
  locationRefusal: string | null;
  /** The worker's last look at this location; null until it has checked. */
  status: BackupLocationStatus | null;
  lastRun: BackupRunSummary | null;
  activeJobId: number | null;
  nextRunAt: string | null;
  timeZone: string;
  alert: BackupAlert | null;
}

const timePattern = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function isBackupTime(value: string): boolean {
  return timePattern.test(value);
}

/** Older or hand-edited values fall back to the defaults field by field. */
export function normalizeBackupSettings(value: unknown): BackupSettings {
  const input = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  return {
    enabled: typeof input.enabled === "boolean" ? input.enabled : defaultBackupSettings.enabled,
    time: typeof input.time === "string" && isBackupTime(input.time) ? input.time : defaultBackupSettings.time,
    keep: typeof input.keep === "number" && Number.isInteger(input.keep) && input.keep >= 1 ? Math.min(input.keep, maximumKeptBackups) : defaultBackupSettings.keep,
    location: typeof input.location === "string" && input.location.trim() ? input.location : null
  };
}

function slotOnDay(time: string, year: number, month: number, day: number): Date {
  const match = timePattern.exec(time);
  if (!match) throw new Error(`Invalid backup time: ${time}`);
  return new Date(year, month, day, Number(match[1]), Number(match[2]), 0, 0);
}

/** The latest scheduled start at or before `now`, in server-local time. */
export function previousBackupSlot(time: string, now: Date): Date {
  const today = slotOnDay(time, now.getFullYear(), now.getMonth(), now.getDate());
  return today.getTime() <= now.getTime() ? today : slotOnDay(time, now.getFullYear(), now.getMonth(), now.getDate() - 1);
}

/** The first scheduled start after `now`, in server-local time. */
export function nextBackupSlot(time: string, now: Date): Date {
  const today = slotOnDay(time, now.getFullYear(), now.getMonth(), now.getDate());
  return today.getTime() > now.getTime() ? today : slotOnDay(time, now.getFullYear(), now.getMonth(), now.getDate() + 1);
}

export interface BackupScheduleMarks {
  /** Slots at or before this never run: set on the first check and whenever the schedule changes. */
  anchorAt: string | null;
  /** The newest slot already handled. */
  lastSlotAt: string | null;
}

/**
 * The scheduled start that should run now, or null. A start missed while the
 * worker was down runs once when it returns, and a schedule change never fires
 * a start that was already in the past when the change was made.
 */
export function dueBackupSlot(settings: Pick<BackupSettings, "enabled" | "time">, marks: BackupScheduleMarks, now: Date): Date | null {
  if (!settings.enabled || !marks.anchorAt) return null;
  const slot = previousBackupSlot(settings.time, now);
  const floor = Math.max(Date.parse(marks.anchorAt), marks.lastSlotAt ? Date.parse(marks.lastSlotAt) : Number.NEGATIVE_INFINITY);
  return slot.getTime() > floor ? slot : null;
}

export interface BackupAlertInput {
  settings: Pick<BackupSettings, "enabled" | "time">;
  anchorAt: string | null;
  locationRefusal: string | null;
  status: Pick<BackupLocationStatus, "ready" | "problem" | "backups"> | null;
  lastRun: Pick<BackupRunSummary, "status" | "finishedAt" | "message"> | null;
  activeJobId: number | null;
  now: Date;
}

export function newestVerifiedBackup(backups: readonly BackupEntry[]): BackupEntry | null {
  return backups.filter((backup) => backup.verified).sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))[0] ?? null;
}

/** The problem an admin needs to hear about, if any. A verified backup newer than a failure clears that failure. */
export function backupAlert(input: BackupAlertInput): BackupAlert | null {
  const newest = input.status ? newestVerifiedBackup(input.status.backups) : null;
  const newestAt = newest ? Date.parse(newest.createdAt) : Number.NEGATIVE_INFINITY;
  if (input.lastRun?.status === "failed" && Date.parse(input.lastRun.finishedAt ?? "") > newestAt) {
    return { kind: "failed", message: `The last database backup failed: ${input.lastRun.message}` };
  }
  if (!input.settings.enabled) return null;
  if (input.locationRefusal) return { kind: "unavailable", message: input.locationRefusal };
  if (input.status && !input.status.ready) return { kind: "unavailable", message: input.status.problem ?? "Backups cannot run at this location." };
  if (input.activeJobId != null || !input.anchorAt) return null;
  const slot = previousBackupSlot(input.settings.time, input.now);
  if (slot.getTime() <= Date.parse(input.anchorAt) || input.now.getTime() - slot.getTime() <= backupOverdueGraceMs || newestAt >= slot.getTime()) return null;
  return { kind: "overdue", message: `The database backup scheduled for ${input.settings.time} did not finish.` };
}
