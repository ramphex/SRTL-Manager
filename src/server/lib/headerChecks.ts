import fs from "node:fs/promises";
import path from "node:path";
import { sql } from "drizzle-orm";
import { normalizeAdvancedSettings } from "../../shared/advancedSettings";
import { describeFileHeader, type FileHeaderState, type FileHeaderStatus } from "../../shared/fileHeaders";
import type { StorageRootType } from "../../shared/types";
import { dbAll, getJsonSetting, nowIso, type Db, type DbExecutor } from "../db/database";
import { withFilesystemTimeout } from "./filesystemSafety";
import { checkFileHeader, checkFileHeaders, headerCheckTimeoutMs, type HeaderBatchOptions, type HeaderCheckOptions, type HeaderCheckResult, type HeaderCheckTarget } from "./fileHeaders";

/**
 * How much header checking happens where. The end of a scan checks new and changed files, at most perScanFiles of
 * them or for perScanMs, whichever comes first; the rest are checked at the end of the next scan. Files that were in
 * the library before the check existed are covered by the background pass, which reads a few per pass so it never
 * competes with playback: local files faster than remote ones, where every read is a download. Tests change these.
 */
export const headerCheckLimits = {
  perScanFiles: 200,
  perScanMs: 60_000,
  scanConcurrency: 4,
  backfillPassMs: 5_000,
  backfillLocalPerMinute: 120,
  backfillRemotePerMinute: 30,
  backfillConcurrency: 2,
  // A file that could not be read is tried again by the background pass after this long.
  retryAfterMs: 60 * 60 * 1000
};

// What a database that never saved the setting gets. The setting is on by default; the test suite turns this off so
// tests written before the check existed, whose media files are a few bytes long, are not stopped by it.
export const headerCheckDefaults = { enabledWhenUnset: true };

export async function fileHeaderChecksEnabled(db: DbExecutor): Promise<boolean> {
  const stored = await getJsonSetting<unknown>(db, "advancedSettings", {});
  const scan = stored && typeof stored === "object" ? (stored as { scan?: { checkFileHeaders?: unknown } }).scan : undefined;
  if (typeof scan?.checkFileHeaders !== "boolean") return headerCheckDefaults.enabledWhenUnset;
  return normalizeAdvancedSettings(stored).scan.checkFileHeaders;
}

export function headerStateOf(row: { headerStatus: string | null; headerReason: string | null; headerCheckedAt: string | null }): FileHeaderState | null {
  if (!row.headerStatus || !row.headerCheckedAt) return null;
  return { status: row.headerStatus as FileHeaderStatus, reason: row.headerReason, checkedAt: row.headerCheckedAt };
}

export interface HeaderTarget extends HeaderCheckTarget {
  rootType: StorageRootType;
}

interface ScanFile {
  rootType: StorageRootType;
  filePath: string;
  sizeBytes: number;
  mtimeMs: number;
}

type StoredHeaderRow = {
  filePath: string;
  rootType: string;
  sizeBytes: number | string;
  mtimeMs: number | string;
  missingSince: string | null;
  headerStatus: string | null;
  headerQueuedAt: string | null;
};

/**
 * A new file is queued only on a root that was scanned before: the very first scan of a storage root finds the whole
 * library at once, and that is the background pass's job, not the end of one scan.
 */
export function headerQueueRoots(existingRows: Array<{ rootType: string }>): Set<StorageRootType> {
  const roots = new Set<StorageRootType>();
  for (const row of existingRows) if (row.rootType === "local" || row.rootType === "remote") roots.add(row.rootType);
  return roots;
}

/** True when a scan should queue this file for a header check: it is new on a known root, or its contents changed. */
export function headerCheckDue(existing: { sizeBytes: number; mtimeMs: number } | undefined, file: ScanFile, queueRoots: Set<StorageRootType>): boolean {
  if (!existing) return queueRoots.has(file.rootType);
  return existing.sizeBytes !== file.sizeBytes || existing.mtimeMs !== file.mtimeMs;
}

/**
 * What the end of a scan checks: files queued by earlier scans first (oldest first, files waiting on a retry last),
 * then the new and changed files this scan found, up to the per-scan cap.
 */
export async function planScanHeaderChecks(db: DbExecutor, scannedFiles: ScanFile[], limit = headerCheckLimits.perScanFiles): Promise<{ targets: HeaderTarget[]; due: number }> {
  const rows = await dbAll<StoredHeaderRow>(db as Db, sql`
    select file_path as "filePath", root_type as "rootType", size_bytes as "sizeBytes", mtime_ms as "mtimeMs", missing_since as "missingSince",
      header_status as "headerStatus", header_queued_at as "headerQueuedAt"
    from storage_files
  `);
  const byPath = new Map(rows.map((row) => [row.filePath, { ...row, sizeBytes: Number(row.sizeBytes), mtimeMs: Number(row.mtimeMs) }]));
  const queueRoots = headerQueueRoots(rows);
  const scannedByPath = new Map(scannedFiles.map((file) => [file.filePath, file]));
  const carried = rows
    .filter((row) => row.headerQueuedAt && !row.missingSince)
    .map((row) => byPath.get(row.filePath)!)
    // A queued file this scan saw with new contents is checked as the scan sees it, below.
    .filter((row) => {
      const scanned = scannedByPath.get(row.filePath);
      return !scanned || (scanned.sizeBytes === row.sizeBytes && scanned.mtimeMs === row.mtimeMs);
    })
    .sort((left, right) => Number(left.headerStatus === "retry") - Number(right.headerStatus === "retry") || left.headerQueuedAt!.localeCompare(right.headerQueuedAt!))
    .map((row): HeaderTarget => ({ rootType: row.rootType as StorageRootType, filePath: row.filePath, sizeBytes: row.sizeBytes, mtimeMs: row.mtimeMs }));
  const carriedPaths = new Set(carried.map((target) => target.filePath));
  const fresh = scannedFiles
    .filter((file) => !carriedPaths.has(file.filePath) && headerCheckDue(byPath.get(file.filePath), file, queueRoots))
    .map((file): HeaderTarget => ({ rootType: file.rootType, filePath: file.filePath, sizeBytes: file.sizeBytes, mtimeMs: file.mtimeMs }));
  const all = [...carried, ...fresh];
  return { targets: all.slice(0, Math.max(0, limit)), due: all.length };
}

/**
 * Stores verdicts. A verdict only lands while the file still has the size and modification time it was checked at,
 * so a scan that saw new contents in the meantime is never overwritten with an old answer. A file that could not be
 * checked stays queued if it was, so the next scan tries it again.
 */
export async function recordHeaderResults(db: DbExecutor, results: Array<{ filePath: string; result: HeaderCheckResult }>, timestamp = nowIso()): Promise<number> {
  let recorded = 0;
  for (let offset = 0; offset < results.length; offset += 500) {
    const batch = results.slice(offset, offset + 500).map(({ filePath, result }) => ({
      file_path: filePath,
      status: result.status,
      reason: result.reason,
      size: result.checkedSizeBytes,
      mtime: result.checkedMtimeMs
    }));
    const updated = await dbAll<{ id: number }>(db as Db, sql`
      update storage_files sf set
        header_status = v.status,
        header_reason = v.reason,
        header_checked_at = ${timestamp},
        header_checked_size_bytes = v.size,
        header_checked_mtime_ms = v.mtime,
        header_queued_at = case when v.status = 'retry' then sf.header_queued_at else null end
      from jsonb_to_recordset(${JSON.stringify(batch)}::jsonb) as v(file_path text, status text, reason text, size bigint, mtime bigint)
      where sf.file_path = v.file_path and sf.size_bytes = v.size and sf.mtime_ms = v.mtime
      returning sf.id
    `);
    recorded += updated.length;
  }
  return recorded;
}

export interface ScanHeaderCheckSummary {
  due: number;
  checked: number;
  passed: number;
  failed: number;
  retry: number;
  skipped: number;
  // Due files left for the end of the next scan.
  left: number;
  failedPaths: string[];
}

function summarize(due: number, results: Array<{ result: HeaderCheckResult; target: HeaderTarget }>): ScanHeaderCheckSummary {
  const count = (status: FileHeaderStatus) => results.filter(({ result }) => result.status === status).length;
  return {
    due,
    checked: results.length,
    passed: count("pass"),
    failed: count("fail"),
    retry: count("retry"),
    skipped: count("skipped"),
    left: Math.max(0, due - results.length + count("retry")),
    failedPaths: results.filter(({ result }) => result.status === "fail").map(({ target }) => target.filePath)
  };
}

export interface ScanHeaderRun {
  results: Array<{ filePath: string; result: HeaderCheckResult }>;
  summary: ScanHeaderCheckSummary;
}

/** The end-of-scan step: reads the planned files within the per-scan budget. The scan's own write stores the verdicts. */
export async function runScanHeaderChecks(db: DbExecutor, scannedFiles: ScanFile[], options: HeaderBatchOptions = {}): Promise<ScanHeaderRun> {
  const plan = await planScanHeaderChecks(db, scannedFiles);
  const checked = await checkFileHeaders(plan.targets, {
    concurrency: headerCheckLimits.scanConcurrency,
    deadlineMs: headerCheckLimits.perScanMs,
    ...options
  });
  return { results: checked.map(({ target, result }) => ({ filePath: target.filePath, result })), summary: summarize(plan.due, checked) };
}

export function headerBackfillPerPass(perMinute: number): number {
  return Math.max(1, Math.ceil((perMinute * headerCheckLimits.backfillPassMs) / 60_000));
}

type PendingRow = { id: number; filePath: string; rootType: StorageRootType; sizeBytes: number | string; mtimeMs: number | string };

async function pendingBackfillRows(db: Db, rootType: StorageRootType, limit: number, retryBefore: string): Promise<HeaderTarget[]> {
  const rows = await dbAll<PendingRow>(db, sql`
    select id, file_path as "filePath", root_type as "rootType", size_bytes as "sizeBytes", mtime_ms as "mtimeMs"
    from storage_files
    where root_type = ${rootType} and missing_since is null and header_queued_at is null
      and (header_status is null or (header_status = 'retry' and header_checked_at < ${retryBefore}))
    order by id
    limit ${limit}
  `);
  return rows.map((row) => ({ rootType: row.rootType, filePath: row.filePath, sizeBytes: Number(row.sizeBytes), mtimeMs: Number(row.mtimeMs) }));
}

async function scanRunning(db: Db): Promise<boolean> {
  const rows = await dbAll<{ id: number }>(db, sql`select id from jobs where type = 'scan' and status = 'running' limit 1`);
  return rows.length > 0;
}

export interface HeaderBackfillPass {
  ran: boolean;
  checked: number;
  failed: number;
}

/**
 * One pass of the background check of files nobody has checked yet. It resumes from the database each time, so a
 * restart loses nothing, and it skips its turn while the setting is off or a scan is running, so scans keep their speed.
 */
export async function runHeaderBackfillPass(db: Db, options: HeaderCheckOptions & { now?: () => number } = {}): Promise<HeaderBackfillPass> {
  if (!(await fileHeaderChecksEnabled(db)) || (await scanRunning(db))) return { ran: false, checked: 0, failed: 0 };
  const now = options.now ?? Date.now;
  const retryBefore = new Date(now() - headerCheckLimits.retryAfterMs).toISOString();
  const targets = [
    ...(await pendingBackfillRows(db, "local", headerBackfillPerPass(headerCheckLimits.backfillLocalPerMinute), retryBefore)),
    ...(await pendingBackfillRows(db, "remote", headerBackfillPerPass(headerCheckLimits.backfillRemotePerMinute), retryBefore))
  ];
  if (targets.length === 0) return { ran: true, checked: 0, failed: 0 };
  const checked = await checkFileHeaders(targets, { ...options, concurrency: headerCheckLimits.backfillConcurrency, deadlineMs: headerCheckLimits.backfillPassMs * 4 });
  // The setting may have been turned off while the files were read; nothing is stored then.
  if (!(await fileHeaderChecksEnabled(db))) return { ran: true, checked: 0, failed: 0 };
  await recordHeaderResults(db, checked.map(({ target, result }) => ({ filePath: target.filePath, result })));
  return { ran: true, checked: checked.length, failed: checked.filter(({ result }) => result.status === "fail").length };
}

type GateRow = {
  id: number;
  filePath: string;
  sizeBytes: number | string;
  mtimeMs: number | string;
  headerStatus: string | null;
  headerReason: string | null;
  headerCheckedAt: string | null;
};

export interface CopyHeaderGate {
  // Null when the copy may go ahead.
  blocked: string | null;
  header: FileHeaderState | null;
}

/**
 * Admits a copy to local storage only if the source file's header check has not failed. A source that was never
 * checked, or is waiting on a retry, is checked now and the verdict stored. While the setting is off nothing blocks.
 */
export async function copyHeaderGate(db: Db, link: { resolvedStorageFileId: number | null; targetPath: string }, options: HeaderCheckOptions = {}): Promise<CopyHeaderGate> {
  if (!(await fileHeaderChecksEnabled(db))) return { blocked: null, header: null };
  const targetPath = path.resolve(link.targetPath);
  const rows = await dbAll<GateRow>(db, sql`
    select id, file_path as "filePath", size_bytes as "sizeBytes", mtime_ms as "mtimeMs",
      header_status as "headerStatus", header_reason as "headerReason", header_checked_at as "headerCheckedAt"
    from storage_files
    where missing_since is null and (id = ${link.resolvedStorageFileId ?? -1} or file_path = ${targetPath})
    order by (id = ${link.resolvedStorageFileId ?? -1}) desc
    limit 1
  `);
  const row = rows[0];
  let header = row ? headerStateOf(row) : null;
  if (!header || header.status === "retry") {
    const target = row
      ? { filePath: row.filePath, sizeBytes: Number(row.sizeBytes), mtimeMs: Number(row.mtimeMs) }
      : await (async () => {
          try {
            const found = await withFilesystemTimeout(fs.stat(targetPath), `Checking ${targetPath}`, headerCheckTimeoutMs);
            return { filePath: targetPath, sizeBytes: found.size, mtimeMs: Math.trunc(found.mtimeMs) };
          } catch {
            return { filePath: targetPath, sizeBytes: -1, mtimeMs: 0 };
          }
        })();
    if (target.sizeBytes < 0) return { blocked: null, header: null };
    const result = await checkFileHeader(target, options);
    const checkedAt = nowIso();
    if (row) await recordHeaderResults(db, [{ filePath: row.filePath, result }], checkedAt);
    header = { status: result.status, reason: result.reason, checkedAt };
  }
  if (header.status === "fail") return { blocked: `Not copied: ${describeFileHeader(header).replace(/^Header check failed: /, "the file header check failed: ")}. The file is listed on Damaged files.`, header };
  if (header.status === "retry") return { blocked: `Not copied: the file header could not be checked${header.reason ? ` (${header.reason})` : ""}. Try the copy again later.`, header };
  return { blocked: null, header };
}
