import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { isBackupTime, maximumKeptBackups, minimumVerifiedBackups, type BackupSettings } from "../../shared/backups";
import { setSetting, type Db } from "../db/database";
import { AdmissionError } from "../errors";
import type { JobRunner } from "../jobs/jobRunner";
import { recordActionAudit } from "../lib/actionAudit";
import { backupLocationRefusal, backupMediaRoots, backupScheduleAnchorKey, backupSettingsKey, getBackupSettings, getBackupState, type BackupRuntime } from "../lib/backups";

const backupSettingsSchema = z.object({
  enabled: z.boolean(),
  time: z.string().refine(isBackupTime, "Enter the backup time as HH:MM, for example 03:30."),
  keep: z.number().int().min(minimumVerifiedBackups, `Keep at least ${minimumVerifiedBackups} backups.`).max(maximumKeptBackups, `Keep at most ${maximumKeptBackups} backups.`),
  // Not normalized here: a path with ".." in it is refused rather than quietly rewritten.
  location: z.string().trim().max(1024).nullable().transform((value) => (value ? value.replace(/(?<=.)\/+$/, "") : null))
});

export function registerBackupRoutes(app: FastifyInstance, db: Db, jobs: JobRunner, runtime: Pick<BackupRuntime, "defaultLocation" | "paths">): void {
  app.get("/api/backups", async (_request, reply) => {
    reply.header("Cache-Control", "no-store");
    return getBackupState(db, runtime);
  });

  app.put("/api/backups/settings", async (request) => {
    const body: BackupSettings = backupSettingsSchema.parse(request.body ?? {});
    const refusal = await backupLocationRefusal(body.location ?? runtime.defaultLocation, await backupMediaRoots(db, runtime));
    // The deployment default stays readable as a state to fix; choosing a refused folder is simply not accepted.
    if (refusal && body.location) throw new AdmissionError(refusal);
    const previous = await getBackupSettings(db);
    await setSetting(db, backupSettingsKey, body);
    if (previous.time !== body.time || previous.enabled !== body.enabled) {
      // A start time already in the past when this was saved does not run.
      await setSetting(db, backupScheduleAnchorKey, new Date().toISOString());
    }
    const changed = (Object.keys(body) as Array<keyof BackupSettings>).filter((key) => previous[key] !== body[key]);
    if (changed.length > 0) {
      await recordActionAudit(db, request, {
        action: "backup.settings_change",
        summary: `Changed database backup settings: ${changed.join(", ")}`,
        targets: Object.fromEntries(changed.map((key) => [key, { from: previous[key], to: body[key] }]))
      });
    }
    return getBackupState(db, runtime);
  });

  app.post("/api/backups/run", async (request) => {
    const settings = await getBackupSettings(db);
    const refusal = await backupLocationRefusal(settings.location ?? runtime.defaultLocation, await backupMediaRoots(db, runtime));
    if (refusal) throw new AdmissionError(refusal);
    const jobId = await jobs.startBackup("manual");
    await recordActionAudit(db, request, { action: "backup.run", summary: "Started a database backup", targets: { jobId }, jobId });
    return { jobId };
  });
}
