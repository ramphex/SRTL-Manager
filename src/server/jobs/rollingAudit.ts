import { and, eq, isNull, sql } from "drizzle-orm";
import { dbAll, dbGet, type Db, type DbExecutor } from "../db/database";
import * as schema from "../db/schema";
import type { AuditLinkResult } from "../lib/auditor";
import type { AuditMode, RollingAuditCoverage, RollingAuditSettings, StorageRootType } from "../../shared/types";
import { auditThroughput } from "../../shared/auditEstimate";
import { unfinishedCopyCondition } from "./orphanPurge";

export interface AuditStorageFile {
  id: number;
  rootType: StorageRootType;
  section: string;
  itemName: string;
  relativePath: string;
  filePath: string;
  sizeBytes: number;
  // A current symlink that points at the file, shown in results; the file path stands in for orphans.
  linkPath: string | null;
}

type RawAuditStorageFile = Omit<AuditStorageFile, "sizeBytes" | "rootType"> & { rootType: string; sizeBytes: number | string };

function idArray(ids: number[]): string {
  return `{${ids.map((id) => Math.trunc(id)).join(",")}}`;
}

function toAuditStorageFile(row: RawAuditStorageFile): AuditStorageFile {
  return { ...row, rootType: row.rootType === "remote" ? "remote" : "local", sizeBytes: Number(row.sizeBytes) };
}

const auditStorageFileColumns = sql`
  sf.id,
  sf.root_type as "rootType",
  sf.section,
  sf.item_name as "itemName",
  sf.relative_path as "relativePath",
  sf.file_path as "filePath",
  sf.size_bytes as "sizeBytes",
  (select ml.link_path from media_links ml where ml.missing_since is null and ml.resolved_storage_file_id = sf.id order by ml.id limit 1) as "linkPath"`;

/** Current storage files for the given ids, in id order; ids that are missing or gone are left out. */
export async function currentStorageFilesById(db: DbExecutor, ids: number[]): Promise<AuditStorageFile[]> {
  if (ids.length === 0) return [];
  const rows = await dbAll<RawAuditStorageFile>(db as Db, sql`
    select ${auditStorageFileColumns}
    from storage_files sf
    where sf.id = any(${idArray(ids)}::integer[]) and sf.missing_since is null
    order by sf.id
  `);
  return rows.map(toAuditStorageFile);
}

export async function storageFileSizes(db: DbExecutor, ids: number[]): Promise<Map<number, number>> {
  if (ids.length === 0) return new Map();
  const rows = await dbAll<{ id: number; sizeBytes: number | string }>(db as Db, sql`
    select id, size_bytes as "sizeBytes" from storage_files where id = any(${idArray([...new Set(ids)])}::integer[])
  `);
  return new Map(rows.map((row) => [row.id, Number(row.sizeBytes)]));
}

/** Records the result on the storage file it read. A file that changed since is cleared again by the next scan. */
export async function recordStorageFileAudit(db: DbExecutor, target: { storageFileId?: number | null; targetPath: string }, result: AuditLinkResult, mode: AuditMode, checkedAt: string): Promise<void> {
  const values = { auditCheckedAt: checkedAt, auditStatus: result.status, auditMode: mode, auditMessage: result.message };
  if (target.storageFileId != null) {
    await db.update(schema.storageFiles).set(values).where(eq(schema.storageFiles.id, target.storageFileId));
    return;
  }
  await db.update(schema.storageFiles).set(values).where(and(eq(schema.storageFiles.filePath, target.targetPath), isNull(schema.storageFiles.missingSince)));
}

// Local files the nightly audit still has to read this window: never audited first, then the oldest checked.
// Files that are part of an unfinished copy are left for another night.
function rollingAuditDueCondition(windowStart: string, skipped: number[]) {
  return sql`sf.root_type = 'local' and sf.missing_since is null
    and (sf.audit_checked_at is null or sf.audit_checked_at < ${windowStart})
    ${skipped.length > 0 ? sql`and not (sf.id = any(${idArray(skipped)}::integer[]))` : sql``}
    and not exists (
      select 1 from copy_operations
      where ${unfinishedCopyCondition}
        and sf.file_path in (copy_operations.source_path, copy_operations.destination_path, coalesce(copy_operations.temp_path, ''), coalesce(copy_operations.displaced_path, ''))
    )`;
}

export async function nextRollingAuditBatch(db: DbExecutor, windowStart: string, skipped: number[], limit = 25): Promise<AuditStorageFile[]> {
  const rows = await dbAll<RawAuditStorageFile>(db as Db, sql`
    select ${auditStorageFileColumns}
    from storage_files sf
    where ${rollingAuditDueCondition(windowStart, skipped)}
    order by sf.audit_checked_at asc nulls first, sf.id asc
    limit ${limit}
  `);
  return rows.map(toAuditStorageFile);
}

export async function rollingAuditDue(db: DbExecutor, windowStart: string): Promise<{ files: number; bytes: number }> {
  const row = await dbGet<{ files: number | string; bytes: number | string | null }>(db as Db, sql`
    select count(*) as files, coalesce(sum(sf.size_bytes), 0) as bytes from storage_files sf where ${rollingAuditDueCondition(windowStart, [])}
  `);
  return { files: Number(row?.files ?? 0), bytes: Number(row?.bytes ?? 0) };
}

/**
 * The nightly window that contains `now`, or the next one to open. A window that starts late in the evening runs past
 * midnight, so the window that opened yesterday may still be open.
 */
export function rollingAuditWindow(settings: Pick<RollingAuditSettings, "startHour" | "windowHours">, now: Date): { start: Date; end: Date; open: boolean } {
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), settings.startHour, 0, 0, 0);
  const yesterdayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, settings.startHour, 0, 0, 0);
  const windowEnd = (start: Date) => new Date(start.getTime() + settings.windowHours * 3_600_000);
  for (const start of [yesterdayStart, todayStart]) {
    const end = windowEnd(start);
    if (now >= start && now < end) return { start, end, open: true };
  }
  const nextStart = now < todayStart ? todayStart : new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, settings.startHour, 0, 0, 0);
  return { start: nextStart, end: windowEnd(nextStart), open: false };
}

/** How much of the local library the audits checked in the last `days` days, and how long a full pass takes. */
export async function rollingAuditCoverage(db: Db, settings: RollingAuditSettings, days = 30, now = new Date()): Promise<RollingAuditCoverage> {
  const since = new Date(now.getTime() - days * 86_400_000).toISOString();
  const totals = await dbGet<{
    localFiles: number | string;
    localBytes: number | string | null;
    checkedFiles: number | string;
    checkedBytes: number | string | null;
    neverCheckedFiles: number | string;
    failedFiles: number | string;
  }>(db, sql`
    select
      count(*) as "localFiles",
      coalesce(sum(size_bytes), 0) as "localBytes",
      count(*) filter (where audit_checked_at >= ${since}) as "checkedFiles",
      coalesce(sum(size_bytes) filter (where audit_checked_at >= ${since}), 0) as "checkedBytes",
      count(*) filter (where audit_checked_at is null) as "neverCheckedFiles",
      count(*) filter (where audit_status = 'fail') as "failedFiles"
    from storage_files
    where root_type = 'local' and missing_since is null
  `);
  // Speed of recent nightly runs: bytes read over the time they ran.
  const rate = await dbGet<{ bytes: number | string | null; seconds: number | string | null }>(db, sql`
    select
      coalesce(sum(checked_bytes), 0) as bytes,
      coalesce(sum(extract(epoch from (finished_at::timestamptz - started_at::timestamptz))), 0) as seconds
    from audit_runs
    where rolling and finished_at is not null and started_at >= ${since} and checked_bytes > 0
  `);
  const lastRun = await dbGet<{ jobId: number; startedAt: string; finishedAt: string | null; checked: number; failed: number; stopReason: string | null }>(db, sql`
    select job_id as "jobId", started_at as "startedAt", finished_at as "finishedAt", checked, failed, stop_reason as "stopReason"
    from audit_runs where rolling order by id desc limit 1
  `);
  const localBytes = Number(totals?.localBytes ?? 0);
  const measuredBytes = Number(rate?.bytes ?? 0);
  const measuredSeconds = Number(rate?.seconds ?? 0);
  const measuredBytesPerSecond = measuredBytes > 0 && measuredSeconds > 60 ? measuredBytes / measuredSeconds : null;
  const bytesPerSecond = measuredBytesPerSecond ?? auditThroughput.fastLocalBytesPerSecond;
  const bytesPerNight = bytesPerSecond * settings.windowHours * 3600;
  return {
    enabled: settings.enabled,
    days,
    localFiles: Number(totals?.localFiles ?? 0),
    localBytes,
    checkedFiles: Number(totals?.checkedFiles ?? 0),
    checkedBytes: Number(totals?.checkedBytes ?? 0),
    neverCheckedFiles: Number(totals?.neverCheckedFiles ?? 0),
    failedFiles: Number(totals?.failedFiles ?? 0),
    measuredBytesPerSecond,
    nightsPerFullPass: bytesPerNight > 0 ? Math.max(1, Math.ceil(localBytes / bytesPerNight)) : null,
    windowHours: settings.windowHours,
    lastRun: lastRun ?? null
  };
}
