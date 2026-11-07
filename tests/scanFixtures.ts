import type { Db } from "../src/server/db/database";
import * as schema from "../src/server/db/schema";

/** Records a finished symlink scan, of every configured section unless some are named. Purges refuse without a recent one. */
export async function recordSymlinkScan(db: Db, options: { sections?: string[]; startedAt?: Date; finishedAt?: Date; status?: string; titleScopes?: Array<{ section: string; itemName: string }>; scanSymlinks?: boolean } = {}): Promise<void> {
  const startedAt = (options.startedAt ?? new Date()).toISOString();
  const finishedAt = (options.finishedAt ?? options.startedAt ?? new Date()).toISOString();
  const [job] = await db.insert(schema.jobs).values({ type: "scan", status: "completed", createdAt: startedAt, finishedAt, progress: "{}", options: "{}" }).returning();
  const totals = { totalLinks: 0, remoteLinks: 0, localLinks: 0, brokenLinks: 0, otherLinks: 0, nonMediaLinks: 0, actionableRemoteLinks: 0, assignedRemoteLinks: 0 };
  const scanOptions = {
    scanSymlinks: options.scanSymlinks ?? true,
    scanLocal: false,
    scanRemote: false,
    ...(options.sections ? { symlinkSections: options.sections } : {}),
    ...(options.titleScopes ? { titleScopes: options.titleScopes } : {})
  };
  await db.insert(schema.scanRuns).values({ jobId: job!.id, status: options.status ?? "completed", options: JSON.stringify(scanOptions), startedAt, finishedAt, ...totals });
}
