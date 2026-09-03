import { and, asc, eq, gt, inArray } from "drizzle-orm";
import fs from "node:fs/promises";
import path from "node:path";
import type { CopyFailureItem, CopyFailureList, MediaLinkRow } from "../../shared/types";
import type { DbExecutor } from "../db/database";
import * as schema from "../db/schema";
import { assertPathParentInside, withFilesystemTimeout } from "../lib/filesystemSafety";
import { unresolvedCopyReconciliation } from "./copyReconciliation";

type CopyOperationRow = typeof schema.copyOperations.$inferSelect;
type JobSelectionItemRow = typeof schema.jobSelectionItems.$inferSelect;

export interface ResolvedCopyFailure {
  item: CopyFailureItem;
  link: MediaLinkRow | null;
  linkPath: string | null;
  expectedTargetPath: string | null;
}

export interface ResolvedCopyFailures {
  list: CopyFailureList;
  failures: ResolvedCopyFailure[];
}

function parseRecord(raw: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(raw);
    return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function positiveInteger(value: unknown): number | null {
  return Number.isInteger(value) && Number(value) > 0 ? Number(value) : null;
}

function errorCode(error: unknown): string | null {
  return error !== null && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : null;
}

function boundedFailureReason(message: string): string {
  const normalized = message.replace(/\s+/g, " ").trim();
  return normalized.length > 160 ? `${normalized.slice(0, 157)}...` : normalized;
}

function failureFileName(sourcePath: string | null, linkPath: string | null, relativePath: string | null): string | null {
  const candidate = sourcePath ?? linkPath ?? relativePath;
  return candidate ? path.basename(candidate) || null : null;
}

function currentLinkRow(row: typeof schema.mediaLinks.$inferSelect | undefined): MediaLinkRow | null {
  if (!row) return null;
  return {
    id: row.id,
    section: row.section,
    itemName: row.itemName,
    relativePath: row.relativePath,
    linkPath: row.linkPath,
    targetPath: row.targetPath,
    kind: row.kind as MediaLinkRow["kind"],
    targetExists: row.targetExists,
    isMedia: row.isMedia,
    storagePolicy: row.storagePolicy as MediaLinkRow["storagePolicy"],
    resolvedStorageFileId: row.resolvedStorageFileId,
    sizeBytes: row.sizeBytes,
    firstSeenAt: row.firstSeenAt ?? row.updatedAt,
    lastSeenAt: row.lastSeenAt ?? row.updatedAt,
    lastChangedAt: row.lastChangedAt ?? row.updatedAt,
    missingSince: row.missingSince,
    updatedAt: row.updatedAt
  };
}

async function inspectSymlink(
  link: MediaLinkRow | null,
  linkPath: string | null,
  expectedTargetPath: string | null,
  unresolvedOperation: CopyOperationRow | null,
  supersedingOperation: CopyOperationRow | null
): Promise<Pick<CopyFailureItem, "symlinkStatus" | "symlinkStatusDetail">> {
  if (unresolvedOperation) {
    return {
      symlinkStatus: "reconciliation_required",
      symlinkStatusDetail: "The failed copy has unresolved filesystem state and must be reconciled first."
    };
  }
  if (!link || !linkPath || !expectedTargetPath) {
    return {
      symlinkStatus: "unidentified",
      symlinkStatusDetail: "This historical failure does not have enough stable identity data for automatic removal."
    };
  }
  if (path.resolve(link.linkPath) !== path.resolve(linkPath)) {
    return {
      symlinkStatus: "changed",
      symlinkStatusDetail: "The managed symlink path changed after this copy failed. Rescan before taking action."
    };
  }

  let stat: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    stat = await withFilesystemTimeout(fs.lstat(linkPath), `Inspection of failed-copy symlink ${linkPath}`);
  } catch (error: unknown) {
    if (errorCode(error) === "ENOENT") {
      return { symlinkStatus: "already_missing", symlinkStatusDetail: "The symlink is already absent from the managed library." };
    }
    return {
      symlinkStatus: "unavailable",
      symlinkStatusDetail: "The symlink could not be verified. Check the mounted library and try again."
    };
  }
  if (!stat.isSymbolicLink()) {
    return {
      symlinkStatus: "changed",
      symlinkStatusDetail: "The managed path is no longer a symlink and will not be removed automatically."
    };
  }
  if (link.missingSince) {
    return {
      symlinkStatus: "changed",
      symlinkStatusDetail: "Inventory marks this link as missing, but a path now exists there. Rescan before taking action."
    };
  }

  let actualTargetPath: string;
  try {
    const rawTarget = await withFilesystemTimeout(fs.readlink(linkPath), `Target read for failed-copy symlink ${linkPath}`);
    actualTargetPath = path.isAbsolute(rawTarget) ? rawTarget : path.resolve(path.dirname(linkPath), rawTarget);
  } catch {
    return {
      symlinkStatus: "unavailable",
      symlinkStatusDetail: "The symlink target could not be verified. Check the mounted library and try again."
    };
  }

  const expected = path.resolve(expectedTargetPath);
  const actual = path.resolve(actualTargetPath);
  const inventoryTarget = path.resolve(link.targetPath);
  if (actual !== expected || inventoryTarget !== expected) {
    const superseded = supersedingOperation && path.resolve(supersedingOperation.destinationPath) === actual;
    return superseded
      ? {
          symlinkStatus: "superseded",
          symlinkStatusDetail: "A later successful copy repointed this symlink, so the old failure no longer applies."
        }
      : {
          symlinkStatus: "changed",
          symlinkStatusDetail: "The symlink target changed after this copy failed. Rescan before taking action."
        };
  }
  return {
    symlinkStatus: "eligible",
    symlinkStatusDetail: "The symlink still matches the failed copy and can be removed without deleting its media target."
  };
}

export async function resolveCopyFailures(db: DbExecutor, jobId: number): Promise<ResolvedCopyFailures> {
  const sourceJob = await db.select().from(schema.jobs).where(eq(schema.jobs.id, jobId)).limit(1).then((rows) => rows[0]);
  if (!sourceJob) throw new Error("Copy job not found");
  if (sourceJob.type !== "copy") throw new Error("Failed symlinks can only be reviewed for copy jobs");
  if (sourceJob.status === "queued" || sourceJob.status === "running") {
    throw new Error("Wait for the copy job to finish before reviewing failed symlinks");
  }

  const eventRows = await db
    .select()
    .from(schema.jobEvents)
    .where(and(eq(schema.jobEvents.jobId, jobId), eq(schema.jobEvents.level, "error")))
    .orderBy(asc(schema.jobEvents.id));
  const selections = await db.select().from(schema.jobSelectionItems).where(eq(schema.jobSelectionItems.jobId, jobId));
  const operations = await db.select().from(schema.copyOperations).where(eq(schema.copyOperations.jobId, jobId));
  const selectionById = new Map(selections.map((selection) => [selection.mediaLinkId, selection]));
  const selectionByPath = new Map(selections.map((selection) => [path.resolve(selection.linkPath), selection]));
  const operationById = new Map(operations.map((operation) => [operation.id, operation]));
  const operationByLinkId = new Map(operations.map((operation) => [operation.mediaLinkId, operation]));
  const operationByPath = new Map(operations.map((operation) => [path.resolve(operation.linkPath), operation]));

  type Candidate = {
    eventId: number;
    message: string;
    data: Record<string, unknown>;
    selection: JobSelectionItemRow | null;
    operation: CopyOperationRow | null;
    mediaLinkId: number | null;
    linkPath: string | null;
    expectedTargetPath: string | null;
  };
  const identified = new Map<number, Candidate>();
  const unidentified: Candidate[] = [];

  for (const event of eventRows) {
    const data = parseRecord(event.data);
    if (!data || typeof data.itemName !== "string" || !data.itemName.trim()) continue;
    const eventLinkPath = typeof data.linkPath === "string" && data.linkPath.trim() ? data.linkPath : null;
    const eventLinkId = positiveInteger(data.mediaLinkId) ?? positiveInteger(data.linkId);
    const eventOperationId = positiveInteger(data.copyOperationId);
    const eventOperation = eventOperationId ? operationById.get(eventOperationId) ?? null : null;
    const selection = (eventLinkId ? selectionById.get(eventLinkId) : null) ?? (eventLinkPath ? selectionByPath.get(path.resolve(eventLinkPath)) : null) ?? null;
    const operation = eventOperation ?? (eventLinkId ? operationByLinkId.get(eventLinkId) : null) ?? (eventLinkPath ? operationByPath.get(path.resolve(eventLinkPath)) : null) ?? null;
    const mediaLinkId = eventLinkId ?? operation?.mediaLinkId ?? selection?.mediaLinkId ?? null;
    const candidate: Candidate = {
      eventId: event.id,
      message: event.message,
      data,
      selection,
      operation,
      mediaLinkId,
      linkPath: eventLinkPath ?? operation?.linkPath ?? selection?.linkPath ?? null,
      expectedTargetPath:
        typeof data.sourcePath === "string" && data.sourcePath.trim() ? data.sourcePath : operation?.sourcePath ?? null
    };
    if (mediaLinkId) identified.set(mediaLinkId, candidate);
    else unidentified.push(candidate);
  }

  const mediaLinkIds = [...identified.keys()];
  const currentRows = mediaLinkIds.length === 0 ? [] : await db.select().from(schema.mediaLinks).where(inArray(schema.mediaLinks.id, mediaLinkIds));
  const currentById = new Map(currentRows.map((row) => [row.id, currentLinkRow(row)]));
  const laterOperations =
    mediaLinkIds.length === 0
      ? []
      : await db
          .select()
          .from(schema.copyOperations)
          .where(and(inArray(schema.copyOperations.mediaLinkId, mediaLinkIds), gt(schema.copyOperations.jobId, jobId), eq(schema.copyOperations.stage, "committed")))
          .orderBy(asc(schema.copyOperations.id));
  const supersedingByLinkId = new Map<number, CopyOperationRow>();
  for (const operation of laterOperations) supersedingByLinkId.set(operation.mediaLinkId, operation);
  const unresolvedOperations =
    mediaLinkIds.length === 0
      ? []
      : await db
          .select()
          .from(schema.copyOperations)
          .where(and(inArray(schema.copyOperations.mediaLinkId, mediaLinkIds), unresolvedCopyReconciliation()));
  const unresolvedByLinkId = new Map(unresolvedOperations.map((operation) => [operation.mediaLinkId, operation]));

  const failures: ResolvedCopyFailure[] = [];
  for (const [mediaLinkId, candidate] of identified) {
    const link = currentById.get(mediaLinkId) ?? null;
    const itemName = candidate.selection?.itemName ?? (typeof candidate.data.itemName === "string" ? candidate.data.itemName.trim() : link?.itemName ?? "Unknown item");
    const relativePath = candidate.selection?.relativePath ?? link?.relativePath ?? null;
    const inspection = await inspectSymlink(
      link,
      candidate.linkPath,
      candidate.expectedTargetPath,
      unresolvedByLinkId.get(mediaLinkId) ?? null,
      supersedingByLinkId.get(mediaLinkId) ?? null
    );
    failures.push({
      item: {
        key: `media:${mediaLinkId}`,
        mediaLinkId,
        copyOperationId: candidate.operation?.id ?? null,
        section: candidate.selection?.section ?? link?.section ?? null,
        itemName,
        relativePath,
        fileName: failureFileName(candidate.expectedTargetPath, candidate.linkPath, relativePath),
        reason: boundedFailureReason(candidate.message),
        ...inspection
      },
      link,
      linkPath: candidate.linkPath,
      expectedTargetPath: candidate.expectedTargetPath
    });
  }
  for (const candidate of unidentified) {
    const itemName = typeof candidate.data.itemName === "string" ? candidate.data.itemName.trim() : "Unknown item";
    failures.push({
      item: {
        key: `event:${candidate.eventId}`,
        mediaLinkId: null,
        copyOperationId: null,
        section: null,
        itemName,
        relativePath: null,
        fileName: failureFileName(candidate.expectedTargetPath, candidate.linkPath, null),
        reason: boundedFailureReason(candidate.message),
        symlinkStatus: "unidentified",
        symlinkStatusDetail: "This historical failure does not have enough stable identity data for automatic removal."
      },
      link: null,
      linkPath: candidate.linkPath,
      expectedTargetPath: candidate.expectedTargetPath
    });
  }
  failures.sort(
    (left, right) =>
      left.item.itemName.localeCompare(right.item.itemName, undefined, { sensitivity: "base" }) ||
      (left.item.fileName ?? "").localeCompare(right.item.fileName ?? "", undefined, { sensitivity: "base" })
  );

  const progress = parseRecord(sourceJob.progress);
  const progressFailed = typeof progress?.failed === "number" && Number.isFinite(progress.failed) ? Math.max(0, Math.trunc(progress.failed)) : 0;
  const totalFailures = Math.max(progressFailed, failures.length);
  const unidentifiedCount = failures.filter((failure) => failure.item.symlinkStatus === "unidentified").length + Math.max(0, totalFailures - failures.length);
  const items = failures.map((failure) => failure.item);
  return {
    failures,
    list: {
      jobId,
      totalFailures,
      eligibleCount: items.filter((item) => item.symlinkStatus === "eligible").length,
      unidentifiedCount,
      items
    }
  };
}

export async function removeExpectedSymlink(symlinkRoot: string, linkPath: string, expectedTargetPath: string): Promise<"removed" | "already_missing"> {
  await assertPathParentInside(symlinkRoot, linkPath, "Failed-copy symlink");
  let firstStat: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    firstStat = await withFilesystemTimeout(fs.lstat(linkPath), `Inspection of failed-copy symlink ${linkPath}`);
  } catch (error: unknown) {
    if (errorCode(error) === "ENOENT") return "already_missing";
    throw error;
  }
  if (!firstStat.isSymbolicLink()) throw new Error("Managed library path is no longer a symlink; nothing was removed");
  const rawTarget = await withFilesystemTimeout(fs.readlink(linkPath), `Target read for failed-copy symlink ${linkPath}`);
  const actualTarget = path.isAbsolute(rawTarget) ? rawTarget : path.resolve(path.dirname(linkPath), rawTarget);
  if (path.resolve(actualTarget) !== path.resolve(expectedTargetPath)) {
    throw new Error("Symlink target changed after cleanup was queued; rescan before taking action");
  }

  await assertPathParentInside(symlinkRoot, linkPath, "Failed-copy symlink");
  const finalStat = await withFilesystemTimeout(fs.lstat(linkPath), `Final inspection of failed-copy symlink ${linkPath}`);
  if (!finalStat.isSymbolicLink() || finalStat.dev !== firstStat.dev || finalStat.ino !== firstStat.ino) {
    throw new Error("Symlink changed while cleanup was being prepared; nothing was removed");
  }
  await withFilesystemTimeout(fs.unlink(linkPath), `Removal of failed-copy symlink ${linkPath}`);
  return "removed";
}
