import os from "node:os";
import { loadConfig } from "./config";
import { nowIso, openDatabase } from "./db/database";
import * as schema from "./db/schema";
import { JobWorker } from "./jobs/jobRunner";
import { reconcileEnvironmentPaths } from "./lib/pathConfiguration";

// Media outputs must remain readable by services running under a different account.
process.umask(0o022);

const config = loadConfig();
const database = await openDatabase({ databaseUrl: config.databaseUrl, migrate: config.autoMigrate });
await reconcileEnvironmentPaths(database.db, config.paths);

const workerId = process.env.SRTL_WORKER_ID ?? `${os.hostname()}-${process.pid}`;
const startedAt = nowIso();

async function recordHeartbeat(status: "running" | "stopped"): Promise<void> {
  const heartbeatAt = nowIso();
  await database.db
    .insert(schema.workerHeartbeats)
    .values({ workerId, startedAt, heartbeatAt, status })
    .onConflictDoUpdate({
      target: schema.workerHeartbeats.workerId,
      set: { heartbeatAt, status }
    });
}

await recordHeartbeat("running");
const heartbeatTimer = setInterval(() => {
  void recordHeartbeat("running").catch((error: unknown) => {
    console.error("Worker heartbeat failed", error);
  });
}, 5_000);
heartbeatTimer.unref();

const worker = new JobWorker(database.db, {
  workerId,
  concurrency: config.jobConcurrency
});

let shuttingDown = false;
function shutdown(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  worker.stop();
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

try {
  await worker.start();
} finally {
  clearInterval(heartbeatTimer);
  await recordHeartbeat("stopped").catch(() => undefined);
  await database.close();
}
