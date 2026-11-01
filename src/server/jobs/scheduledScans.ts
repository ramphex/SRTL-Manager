import { and, eq, inArray } from "drizzle-orm";
import { normalizeAdvancedSettings } from "../../shared/advancedSettings";
import type { PathsSettings } from "../../shared/types";
import { first, getJsonSetting, getSectionSettings, setSetting, type Db } from "../db/database";
import * as schema from "../db/schema";
import { isOnboardingComplete } from "../lib/onboarding";
import { ScanAdmissionConflictError, type JobRunner } from "./jobRunner";

export const scheduledInventoryLastRunKey = "scheduledInventoryLastRunDate";

function localDateKey(now: Date): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

// Queues the daily full inventory scan once the configured server-local hour has passed. Returns the queued job ids, or null when nothing was queued.
export async function startScheduledInventoryScan(db: Db, jobs: Pick<JobRunner, "startScanJobs">, now = new Date()): Promise<number[] | null> {
  const settings = normalizeAdvancedSettings(await getJsonSetting<unknown>(db, "advancedSettings", {}));
  const schedule = settings.scan.scheduledInventory;
  if (!schedule.enabled || now.getHours() < schedule.hour) return null;
  const today = localDateKey(now);
  const lastRun = await getJsonSetting<string | null>(db, scheduledInventoryLastRunKey, null);
  if (lastRun === today) return null;
  // The first check after an install or upgrade starts the schedule tomorrow instead of scanning right away.
  if (!lastRun) {
    await setSetting(db, scheduledInventoryLastRunKey, today);
    return null;
  }
  if (!(await isOnboardingComplete(db))) return null;
  const paths = await getJsonSetting<PathsSettings>(db, "paths", { symlinkDir: "", localDir: "", remoteDir: "" });
  const sections = (await getSectionSettings(db)).sections;
  if (!paths.symlinkDir || !paths.localDir || !paths.remoteDir || sections.length === 0) return null;
  // The full scan covers every scope, so any queued or running scan overlaps it; try again on the next check.
  const activeScan = await first(
    db.select({ id: schema.jobs.id }).from(schema.jobs).where(and(eq(schema.jobs.type, "scan"), inArray(schema.jobs.status, ["queued", "running"]))).limit(1)
  );
  if (activeScan) return null;

  let jobIds: number[];
  try {
    jobIds = await jobs.startScanJobs(
      { scanSymlinks: true, scanLocal: true, scanRemote: true, symlinkSections: sections, localSections: sections },
      settings.scan.symlinkFolderScheduling
    );
  } catch (error) {
    if (error instanceof ScanAdmissionConflictError) return null;
    throw error;
  }
  await setSetting(db, scheduledInventoryLastRunKey, today);
  return jobIds;
}
