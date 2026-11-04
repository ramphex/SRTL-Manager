import { and, eq, inArray } from "drizzle-orm";
import { dueBackupSlot } from "../../shared/backups";
import { first, getJsonSetting, setSetting, type Db } from "../db/database";
import * as schema from "../db/schema";
import { AdmissionError, ConflictError } from "../errors";
import { backupLastSlotKey, backupScheduleAnchorKey, backupStatusKey, getBackupSettings, refreshBackupStatus, type BackupRuntime } from "../lib/backups";
import { isOnboardingComplete } from "../lib/onboarding";
import type { BackupLocationStatus } from "../../shared/backups";
import type { JobRunner } from "./jobRunner";

/** A healthy location is looked at rarely, so a network share can sleep; a broken one is rechecked soon, so a fix shows up quickly. */
const healthyCheckIntervalMs = 15 * 60_000;
const problemCheckIntervalMs = 60_000;

/** Queues the backup whose start time has passed. Returns the job id, or null when nothing was queued. */
export async function startScheduledBackup(db: Db, jobs: Pick<JobRunner, "startBackup">, now = new Date()): Promise<number | null> {
  const settings = await getBackupSettings(db);
  const anchorAt = await getJsonSetting<string | null>(db, backupScheduleAnchorKey, null);
  // The first check after an install or upgrade starts the schedule at the next start time instead of backing up right away.
  if (!anchorAt) {
    await setSetting(db, backupScheduleAnchorKey, now.toISOString());
    return null;
  }
  const lastSlotAt = await getJsonSetting<string | null>(db, backupLastSlotKey, null);
  const slot = dueBackupSlot(settings, { anchorAt, lastSlotAt }, now);
  if (!slot || !(await isOnboardingComplete(db))) return null;
  // One already queued or running, such as a manual run, covers this start.
  const active = await first(
    db.select({ id: schema.jobs.id }).from(schema.jobs).where(and(eq(schema.jobs.type, "backup"), inArray(schema.jobs.status, ["queued", "running"]))).limit(1)
  );
  if (active) {
    await setSetting(db, backupLastSlotKey, slot.toISOString());
    return null;
  }
  let jobId: number;
  try {
    jobId = await jobs.startBackup("scheduled");
  } catch (error) {
    // Paths awaiting a migration refuse every job, and a manual run may have just started; this is tried again on the next check.
    if (error instanceof AdmissionError || error instanceof ConflictError) return null;
    throw error;
  }
  await setSetting(db, backupLastSlotKey, slot.toISOString());
  return jobId;
}

/** Keeps the published location status current. Saving a new location makes it due at once. */
export async function refreshBackupStatusIfDue(db: Db, runtime: BackupRuntime, now = new Date()): Promise<void> {
  const settings = await getBackupSettings(db);
  const status = await getJsonSetting<BackupLocationStatus | null>(db, backupStatusKey, null);
  const location = settings.location ?? runtime.defaultLocation;
  const age = status ? now.getTime() - Date.parse(status.checkedAt) : Number.POSITIVE_INFINITY;
  if (status?.location === location && age < (status.ready ? healthyCheckIntervalMs : problemCheckIntervalMs)) return;
  await refreshBackupStatus(db, runtime);
}

