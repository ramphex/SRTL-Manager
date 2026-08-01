import { randomUUID } from "node:crypto";
import os from "node:os";
import { loadConfig } from "./config";
import { nowIso, openDatabase } from "./db/database";
import { CopyTransferLimiter } from "./jobs/copyLimiter";
import { JobWorker } from "./jobs/jobRunner";
import { reconcileEnvironmentPaths } from "./lib/pathConfiguration";
import { pruneWorkerHeartbeatHistory, recordWorkerHeartbeat } from "./lib/workerHeartbeats";

// Media outputs must remain readable by services running under a different account.
process.umask(0o022);

const config = loadConfig();
const database = await openDatabase({ databaseUrl: config.databaseUrl, migrate: config.autoMigrate });
await pruneWorkerHeartbeatHistory(database.db);
await reconcileEnvironmentPaths(database.db, config.paths);

const workerBaseId = process.env.SRTL_WORKER_ID?.trim() || `${os.hostname()}-${process.pid}`;
const bootId = randomUUID();
const workerId = `${workerBaseId}:${bootId}`;
const copyTransferLimiter = new CopyTransferLimiter(config.jobConcurrency.maxActiveCopyFiles);
const startedAt = nowIso();
const worker = new JobWorker(database.db, {
  workerId,
  concurrency: config.jobConcurrency,
  copyTransferLimiter,
  dispatchConcurrency: config.jobConcurrency.maxRunningJobs
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
let workerRun: Promise<void> | null = null;
try {
  await recordHeartbeat("running");
  // A shutdown signal may arrive while the initial database write is in flight.
  // Starting afterward would clear JobWorker's stopped state and resume claims.
  if (!shuttingDown) {
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
    workerRun = worker.start();
    await workerRun;
  }
} finally {
  shutdown();
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  if (workerRun) await Promise.allSettled([workerRun]);
  await heartbeatRun;
  await recordHeartbeat("stopped").catch((error: unknown) => {
    console.error("Unable to record stopped worker status", error);
  });
  await database.close();
}
