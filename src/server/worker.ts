import { randomUUID } from "node:crypto";
import os from "node:os";
import { loadConfig } from "./config";
import { getJsonSetting, nowIso, openDatabase } from "./db/database";
import type { PathsSettings } from "../shared/types";
import { CopyTransferLimiter } from "./jobs/copyLimiter";
import { JobRunner, JobWorker } from "./jobs/jobRunner";
import { startScheduledInventoryScan } from "./jobs/scheduledScans";
import { workerProcessLockKey } from "./jobs/scheduling";
import { reconcileEnvironmentPaths } from "./lib/pathConfiguration";
import { pruneExpiredSessions, pruneTerminalJobHistory } from "./lib/historyRetention";
import { pruneWorkerHeartbeatHistory, recordWorkerHeartbeat } from "./lib/workerHeartbeats";
import { radarrMediaExpectation, startRadarrWork } from "./lib/radarr";
import { expireHeldOrphans } from "./jobs/orphanPurge";

// Media outputs must remain readable by services running under a different account.
process.umask(0o022);

const config = loadConfig();
const database = await openDatabase({ databaseUrl: config.databaseUrl, migrate: config.autoMigrate });
const workerProcessLock = await database.pool.connect();
let workerProcessLockAcquired = false;
async function runDataMaintenance(): Promise<void> {
  await pruneWorkerHeartbeatHistory(database.db);
  await pruneExpiredSessions(database.db);
  await pruneTerminalJobHistory(database.db, config.jobHistoryRetentionDays);
  const expired = await expireHeldOrphans(database.db, await getJsonSetting<PathsSettings>(database.db, "paths", config.paths));
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
const worker = new JobWorker(database.db, {
  workerId,
  concurrency: config.jobConcurrency,
  copyTransferLimiter,
  dispatchConcurrency: config.jobConcurrency.maxRunningJobs,
  mediaExpectations: (link) => radarrMediaExpectation(database.db, link)
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
let scheduledScanTimer: NodeJS.Timeout | null = null;
let scheduledScanRun: Promise<void> | null = null;
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
  if (scheduledScanTimer) clearInterval(scheduledScanTimer);
  if (workerRun) await Promise.allSettled([workerRun]);
  await heartbeatRun;
  await maintenanceRun;
  await radarrRun;
  await Promise.allSettled([...radarrInstanceRuns.values()]);
  await scheduledScanRun;
  await recordHeartbeat("stopped").catch((error: unknown) => {
    console.error("Unable to record stopped worker status", error);
  });
  await workerProcessLock.query("select pg_advisory_unlock($1)", [workerProcessLockKey]).catch(() => undefined);
  workerProcessLock.release();
  await database.close();
}
