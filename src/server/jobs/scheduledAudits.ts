import { and, desc, eq, inArray } from "drizzle-orm";
import { normalizeAdvancedSettings } from "../../shared/advancedSettings";
import type { PathsSettings } from "../../shared/types";
import { first, getJsonSetting, getSectionSettings, setSetting, type Db } from "../db/database";
import * as schema from "../db/schema";
import { AdmissionError, ConflictError } from "../errors";
import { isOnboardingComplete } from "../lib/onboarding";
import type { JobRunner } from "./jobRunner";
import { rollingAuditDue, rollingAuditWindow } from "./rollingAudit";

/** The window the nightly audit last ran in, and its job, so one window queues one audit (again only after it yielded). */
export const rollingAuditStateKey = "rollingAuditState";

interface RollingAuditState {
  windowStart: string;
  jobId: number;
}

/**
 * Queues the nightly fast audit of local files while its window is open. Returns the queued job id, or null.
 * One job runs per window. It is queued again in the same window only when it stopped to let other work run, and only
 * once no audit or exclusive job is queued or running, so it never runs beside them.
 */
export async function startScheduledRollingAudit(db: Db, jobs: Pick<JobRunner, "startRollingAudit">, now = new Date()): Promise<number | null> {
  const settings = normalizeAdvancedSettings(await getJsonSetting<unknown>(db, "advancedSettings", {})).audit.rolling;
  if (!settings.enabled) return null;
  const window = rollingAuditWindow(settings, now);
  if (!window.open) return null;
  // Leave time to read at least something; a window about to close waits for the next night.
  if (window.end.getTime() - now.getTime() < 60_000) return null;
  const windowStart = window.start.toISOString();
  const state = await getJsonSetting<RollingAuditState | null>(db, rollingAuditStateKey, null);
  if (state?.windowStart === windowStart) {
    const previous = await first(db.select().from(schema.jobs).where(eq(schema.jobs.id, state.jobId)).limit(1));
    if (previous && (previous.status === "queued" || previous.status === "running")) return null;
    const run = previous ? await first(db.select().from(schema.auditRuns).where(eq(schema.auditRuns.jobId, previous.id)).orderBy(desc(schema.auditRuns.id)).limit(1)) : undefined;
    // A run that finished its work, reached the window end, failed, or was terminated is not queued again tonight.
    if (previous && !(previous.status === "completed" && run?.stopReason === "yielded")) return null;
  }
  if (!(await isOnboardingComplete(db))) return null;
  const paths = await getJsonSetting<PathsSettings>(db, "paths", { symlinkDir: "", localDir: "", remoteDir: "" });
  if (!paths.localDir || (await getSectionSettings(db)).sections.length === 0) return null;
  // Another audit or an exclusive job (such as a full scan) goes first; try again on the next check.
  const busy = await first(
    db
      .select({ id: schema.jobs.id })
      .from(schema.jobs)
      .where(and(inArray(schema.jobs.status, ["queued", "running"]), inArray(schema.jobs.type, ["audit"])))
      .limit(1)
  );
  if (busy) return null;
  const exclusive = await first(
    db.select({ id: schema.jobs.id }).from(schema.jobs).where(and(inArray(schema.jobs.status, ["queued", "running"]), eq(schema.jobs.exclusive, true))).limit(1)
  );
  if (exclusive) return null;
  if ((await rollingAuditDue(db, windowStart)).files === 0) return null;
  let jobId: number;
  try {
    jobId = await jobs.startRollingAudit({ windowStart, windowEnd: window.end.toISOString() });
  } catch (error) {
    // Paths awaiting a migration refuse every job; this is tried again on the next check.
    if (error instanceof AdmissionError || error instanceof ConflictError) return null;
    throw error;
  }
  await setSetting(db, rollingAuditStateKey, { windowStart, jobId } satisfies RollingAuditState);
  return jobId;
}
