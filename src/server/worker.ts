import { randomUUID } from "node:crypto";
import os from "node:os";
import { loadConfig, secretKeyOptions } from "./config";
import { getJsonSetting, nowIso, openDatabase } from "./db/database";
import type { PathsSettings } from "../shared/types";
import { CopyTransferLimiter } from "./jobs/copyLimiter";
import { JobRunner, JobWorker } from "./jobs/jobRunner";
import { startScheduledInventoryScan } from "./jobs/scheduledScans";
import { refreshBackupStatusIfDue, startScheduledBackup } from "./jobs/scheduledBackups";
import { workerProcessLockKey } from "./jobs/scheduling";
import { reconcileEnvironmentPaths } from "./lib/pathConfiguration";
import { pruneExpiredSessions, pruneTerminalJobHistory } from "./lib/historyRetention";
import { pruneWorkerHeartbeatHistory, recordWorkerHeartbeat } from "./lib/workerHeartbeats";
import { queueCopiedTitleMonitorUpdates, radarrMediaExpectation, startRadarrWork } from "./lib/radarr";
import { queueCopiedSonarrEpisodes, sonarrMediaExpectation, startSonarrWork } from "./lib/sonarr";
import { refreshBackupStatus } from "./lib/backups";
import { reRequestPassMs, startReRequestWork } from "./lib/reRequests";
import { expireHeldOrphans } from "./jobs/orphanPurge";
import { runWatchSyncWork } from "./lib/watchSyncEngine";
import { configureExtraSymlinkFolders } from "./lib/extraSymlinkFolders";
import { configureOutboundPolicy } from "./lib/outboundPolicy";
import { loadAndInstallSecretKey } from "./lib/secretBox";

// Media outputs must remain readable by services running under a different account.
process.umask(0o022);

const config = loadConfig();
const secretKey = loadAndInstallSecretKey(secretKeyOptions(config.rootDir, config.dataDir));
if (secretKey.source === "generated") console.warn(`Created the secret key for stored credentials at ${secretKey.path}. Back it up separately from database backups.`);
configureOutboundPolicy(config.outboundPolicy);
configureExtraSymlinkFolders(config.extraSymlinkFolders);
const database = await openDatabase({ databaseUrl: config.databaseUrl, migrate: config.autoMigrate, discardUnreadableCredentials: config.discardUnreadableCredentials });
const workerProcessLock = await database.pool.connect();
let workerProcessLockAcquired = false;
async function runDataMaintenance(): Promise<void> {
  await pruneWorkerHeartbeatHistory(database.db);
  await pruneExpiredSessions(database.db);
  await pruneTerminalJobHistory(database.db, config.jobHistoryRetentionDays);
  const expired = await expireHeldOrphans(database.db, await getJsonSetting<PathsSettings>(database.db, "paths", config.paths), Date.now(), (error, operationId) => {
    console.error(`Held orphan #${operationId} was not deleted at the end of its holding period: ${error instanceof Error ? error.message : String(error)}`);
  });
  if (expired > 0) console.warn(`Permanently deleted ${expired} purged orphan file(s) whose holding period ended.`);
}
try {
  const workerLockResult = await workerProcessLock.query<{ acquired: boolean }>("select pg_try_advisory_lock($1) as acquired", [workerProcessLockKey]);
  workerProcessLockAcquired = workerLockResult.rows[0]?.acquired === true;
  if (!workerProcessLockAcquired) {
    throw new Error("Another SRTL worker process is already active. Scale safe job slots with SRTL_WORKER_COUNT inside one worker container; do not scale the worker service.");
  }
  await runDataMaintenance();
  await reconcileEnvironmentPaths(database.db, config.paths);
} catch (error) {
  if (workerProcessLockAcquired) {
    await workerProcessLock.query("select pg_advisory_unlock($1)", [workerProcessLockKey]).catch(() => undefined);
  }
  workerProcessLock.release();
  await database.close();
  throw error;
}

const workerBaseId = process.env.SRTL_WORKER_ID?.trim() || `${os.hostname()}-${process.pid}`;
const bootId = randomUUID();
const workerId = `${workerBaseId}:${bootId}`;
const copyTransferLimiter = new CopyTransferLimiter(config.jobConcurrency.maxActiveCopyFiles);
const startedAt = nowIso();
const backupRuntime = { databaseUrl: config.databaseUrl, defaultLocation: config.backupDir, pgBinDir: config.pgBinDir, paths: config.paths };
const worker = new JobWorker(database.db, {
  workerId,
  backup: backupRuntime,
  concurrency: config.jobConcurrency,
  copyTransferLimiter,
  dispatchConcurrency: config.jobConcurrency.maxRunningJobs,
  // A folder belongs to a Radarr or a Sonarr instance, never both, so at most one of them answers.
  mediaExpectations: async (link) => await radarrMediaExpectation(database.db, link) ?? await sonarrMediaExpectation(database.db, link),
  copiedTitles: async (copy, titles) => {
    const results = await Promise.allSettled([
      copy.radarrMonitoring ? queueCopiedTitleMonitorUpdates(database.db, copy, titles) : undefined,
      copy.sonarrMonitoring ? queueCopiedSonarrEpisodes(database.db, copy, titles) : undefined
    ]);
    const failed = results.find((result) => result.status === "rejected");
    if (failed) throw failed.reason;
  }
});

async function recordHeartbeat(status: "running" | "stopped"): Promise<void> {
  await recordWorkerHeartbeat(database.db, {
    workerId,
    startedAt,
    heartbeatAt: nowIso(),
    status,
    capacity: config.jobConcurrency.maxRunningJobs
  });
}

let shuttingDown = false;
function shutdown(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  worker.stop();
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

let heartbeatTimer: NodeJS.Timeout | null = null;
let heartbeatRun: Promise<void> | null = null;
let maintenanceTimer: NodeJS.Timeout | null = null;
let maintenanceRun: Promise<void> | null = null;
let workerRun: Promise<void> | null = null;
let radarrTimer: NodeJS.Timeout | null = null;
let radarrRun: Promise<void> | null = null;
// One entry per Radarr instance with work in flight; each instance runs on its own schedule.
const radarrInstanceRuns = new Map<string, Promise<void>>();
let sonarrTimer: NodeJS.Timeout | null = null;
let sonarrRun: Promise<void> | null = null;
// Sonarr instances run the same way, independently of each other and of Radarr.
const sonarrInstanceRuns = new Map<string, Promise<void>>();
let reRequestTimer: NodeJS.Timeout | null = null;
let reRequestRun: Promise<void> | null = null;
// One entry per Radarr or Sonarr instance with searches being sent.
const reRequestInstanceRuns = new Map<string, Promise<void>>();
let watchSyncTimer: NodeJS.Timeout | null = null;
let watchSyncRun: Promise<void> | null = null;
let scheduledScanTimer: NodeJS.Timeout | null = null;
let scheduledScanRun: Promise<void> | null = null;
let scheduledBackupTimer: NodeJS.Timeout | null = null;
let scheduledBackupRun: Promise<void> | null = null;
let backupStatusCheckedSinceStart = false;
async function runScheduledBackupWork(): Promise<void> {
  const jobId = await startScheduledBackup(database.db, scheduledScanRunner);
  if (jobId) console.warn(`Queued the scheduled database backup as job #${jobId}.`);
  // A restart may have changed what is mounted, so the first check after one always looks.
  if (backupStatusCheckedSinceStart) await refreshBackupStatusIfDue(database.db, backupRuntime);
  else await refreshBackupStatus(database.db, backupRuntime);
  backupStatusCheckedSinceStart = true;
}
const scheduledScanRunner = new JobRunner(database.db);
try {
  await recordHeartbeat("running");
  // A shutdown signal may arrive while the initial database write is in flight.
  // Starting afterward would clear JobWorker's stopped state and resume claims.
  if (!shuttingDown) {
    radarrTimer = setInterval(() => {
      if (shuttingDown || radarrRun) return;
      radarrRun = startRadarrWork(database.db, radarrInstanceRuns, (name) => { console.error(`Radarr synchronization for ${name} could not finish; pending work will be retried.`); })
        .catch(() => { console.error("Radarr synchronization could not start; pending work will be retried."); })
        .finally(() => { radarrRun = null; });
    }, 5000);
    radarrTimer.unref();
    sonarrTimer = setInterval(() => {
      if (shuttingDown || sonarrRun) return;
      sonarrRun = startSonarrWork(database.db, sonarrInstanceRuns, (name) => { console.error(`Sonarr synchronization for ${name} could not finish; pending work will be retried.`); })
        .catch(() => { console.error("Sonarr synchronization could not start; pending work will be retried."); })
        .finally(() => { sonarrRun = null; });
    }, 5000);
    sonarrTimer.unref();
    reRequestTimer = setInterval(() => {
      if (shuttingDown || reRequestRun) return;
      reRequestRun = startReRequestWork(database.db, reRequestInstanceRuns, () => { console.error("A re-request pass could not finish; waiting requests will be retried."); })
        .catch(() => { console.error("A re-request pass could not start; waiting requests will be retried."); })
        .finally(() => { reRequestRun = null; });
    }, reRequestPassMs);
    reRequestTimer.unref();
    // Each pair keeps its own interval; this only checks what is due.
    watchSyncTimer = setInterval(() => {
      if (shuttingDown || watchSyncRun) return;
      watchSyncRun = runWatchSyncWork(database.db, (options) => scheduledScanRunner.startWatchSync(options))
        .catch((error: unknown) => { console.error("Watch sync could not run; it will be retried.", error); })
        .finally(() => { watchSyncRun = null; });
    }, 30_000);
    watchSyncTimer.unref();
    scheduledScanTimer = setInterval(() => {
      if (shuttingDown || scheduledScanRun) return;
      scheduledScanRun = startScheduledInventoryScan(database.db, scheduledScanRunner)
        .then((jobIds) => {
          if (jobIds) console.warn(`Queued the scheduled inventory scan as job${jobIds.length === 1 ? "" : "s"} ${jobIds.map((id) => `#${id}`).join(", ")}.`);
        })
        .catch((error: unknown) => {
          console.error("Scheduled inventory scan could not be queued; it will be retried.", error);
        })
        .finally(() => {
          scheduledScanRun = null;
        });
    }, 5 * 60 * 1_000);
    scheduledScanTimer.unref();
    scheduledBackupRun = runScheduledBackupWork()
      .catch((error: unknown) => { console.error("Scheduled database backup could not be checked; it will be retried.", error); })
      .finally(() => { scheduledBackupRun = null; });
    scheduledBackupTimer = setInterval(() => {
      if (shuttingDown || scheduledBackupRun) return;
      scheduledBackupRun = runScheduledBackupWork()
        .catch((error: unknown) => { console.error("Scheduled database backup could not be checked; it will be retried.", error); })
        .finally(() => { scheduledBackupRun = null; });
    }, 30_000);
    scheduledBackupTimer.unref();
    heartbeatTimer = setInterval(() => {
      if (shuttingDown || heartbeatRun) return;
      heartbeatRun = recordHeartbeat("running")
        .catch((error: unknown) => {
          console.error("Worker heartbeat failed", error);
        })
        .finally(() => {
          heartbeatRun = null;
        });
    }, 5_000);
    heartbeatTimer.unref();
    maintenanceTimer = setInterval(() => {
      if (shuttingDown || maintenanceRun) return;
      maintenanceRun = runDataMaintenance()
        .catch((error: unknown) => {
          console.error("Worker data maintenance failed", error);
        })
        .finally(() => {
          maintenanceRun = null;
        });
    }, 6 * 60 * 60 * 1_000);
    maintenanceTimer.unref();
    workerRun = worker.start();
    await workerRun;
  }
} finally {
  shutdown();
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  if (maintenanceTimer) clearInterval(maintenanceTimer);
  if (radarrTimer) clearInterval(radarrTimer);
  if (sonarrTimer) clearInterval(sonarrTimer);
  if (reRequestTimer) clearInterval(reRequestTimer);
  if (watchSyncTimer) clearInterval(watchSyncTimer);
  if (scheduledScanTimer) clearInterval(scheduledScanTimer);
  if (scheduledBackupTimer) clearInterval(scheduledBackupTimer);
  if (workerRun) await Promise.allSettled([workerRun]);
  await heartbeatRun;
  await maintenanceRun;
  await radarrRun;
  await Promise.allSettled([...radarrInstanceRuns.values()]);
  await sonarrRun;
  await Promise.allSettled([...sonarrInstanceRuns.values()]);
  await reRequestRun;
  await Promise.allSettled([...reRequestInstanceRuns.values()]);
  await scheduledScanRun;
  await scheduledBackupRun;
  await watchSyncRun;
  await recordHeartbeat("stopped").catch((error: unknown) => {
    console.error("Unable to record stopped worker status", error);
  });
  await workerProcessLock.query("select pg_advisory_unlock($1)", [workerProcessLockKey]).catch(() => undefined);
  workerProcessLock.release();
  await database.close();
}
