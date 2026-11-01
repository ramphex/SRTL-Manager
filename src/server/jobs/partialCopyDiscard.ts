import fs from "node:fs/promises";
import path from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { first, getJsonSetting, nowIso, type Db } from "../db/database";
import * as schema from "../db/schema";
import { copyFileIdentitiesMatch, parseCopyFileIdentity, readCopyFileIdentity, type CopyFileIdentity } from "../lib/copier";
import { assertExistingPathInside, withFilesystemTimeout } from "../lib/filesystemSafety";
import { isPathInside } from "../lib/media";
import { isPathConfigurationBlocked } from "../lib/pathConfiguration";
import type { PartialCopyDiscardPreview, PartialCopyDiscardRequest, PartialCopyDiscardResult, PathsSettings } from "../../shared/types";
import { linkState, listCopyReconciliation, pathPresence, unresolvedCopyReconciliation, type CopyOperation } from "./copyReconciliation";
import { schedulerLockKey } from "./scheduling";

export class PartialCopyDiscardError extends Error {
  constructor(message: string, readonly statusCode: 404 | 409) {
    super(message);
    this.name = "PartialCopyDiscardError";
  }
}

interface DiscardInspection {
  preview: PartialCopyDiscardPreview;
  tempIdentity: CopyFileIdentity | null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function journaledTempNameMatches(destinationPath: string, tempPath: string): boolean {
  const pattern = new RegExp(`^\\.${escapeRegExp(path.basename(destinationPath))}\\.srtl-copy-\\d+-\\d+-[0-9a-f]+$`);
  return path.dirname(path.resolve(tempPath)) === path.dirname(path.resolve(destinationPath)) && pattern.test(path.basename(tempPath));
}

function destinationRootFor(paths: PathsSettings, destinationPath: string): string | null {
  if (paths.localDir && isPathInside(paths.localDir, destinationPath)) return paths.localDir;
  if (paths.remoteDir && isPathInside(paths.remoteDir, destinationPath)) return paths.remoteDir;
  return null;
}

async function readTempIdentity(tempPath: string): Promise<{ identity: CopyFileIdentity | null; problem: string | null }> {
  try {
    const identity = await withFilesystemTimeout(readCopyFileIdentity(tempPath), `Partial copy inspection for ${tempPath}`);
    return { identity, problem: identity ? null : "The temporary file is already gone. Use Recheck filesystem state to close this journal." };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { identity: null, problem: `The temporary file is not a regular file or could not be inspected (${reason}).` };
  }
}

async function activeConflict(db: Db, operation: CopyOperation): Promise<{ jobId: number; type: string; status: string } | null> {
  const paths = [operation.linkPath, operation.sourcePath, operation.destinationPath, operation.originalTargetPath, operation.tempPath, operation.displacedPath]
    .filter((value): value is string => Boolean(value))
    .flatMap((value) => [value, path.resolve(value)]);
  const row = (
    await db.execute<{ jobId: number; type: string; status: string }>(sql`
      select jobs.id as "jobId", jobs.type, jobs.status
      from jobs
      where jobs.status in ('queued', 'running')
        and (
          jobs.id = ${operation.jobId}
          or jobs.exclusive = true
          or exists (
            select 1
            from job_resource_claims as claim
            where claim.job_id = jobs.id
              and (
                (claim.resource_type = 'media' and claim.resource_key = ${String(operation.mediaLinkId)})
                or (claim.resource_type = 'path' and claim.resource_key in (select jsonb_array_elements_text(${JSON.stringify(paths)}::jsonb)))
              )
          )
        )
      order by jobs.id
      limit 1
    `)
  ).rows[0];
  return row ?? null;
}

async function inspectOperation(db: Db, operation: CopyOperation): Promise<DiscardInspection> {
  const blockers: string[] = [];
  const paths = await getJsonSetting<PathsSettings>(db, "paths", { symlinkDir: "", localDir: "", remoteDir: "" });
  const [link, destination, displaced, conflict, pathsBlocked] = await Promise.all([
    linkState(operation.linkPath),
    pathPresence(operation.destinationPath, `Partial copy destination inspection for ${operation.destinationPath}`),
    pathPresence(operation.displacedPath, `Partial copy displaced-file inspection for operation #${operation.id}`),
    activeConflict(db, operation),
    isPathConfigurationBlocked(db)
  ]);

  if (pathsBlocked) blockers.push("Managed storage paths changed. Resolve the path migration before discarding copy data.");
  if (conflict) {
    blockers.push(
      conflict.jobId === operation.jobId
        ? `Copy job #${conflict.jobId} is still ${conflict.status}. Wait for it to stop before discarding its partial copy.`
        : `${conflict.type} job #${conflict.jobId} is ${conflict.status} and may touch this media item. Wait for it to finish first.`
    );
  }

  const root = destinationRootFor(paths, operation.destinationPath);
  if (!root) blockers.push("The journaled destination is outside the configured storage roots.");

  let tempIdentity: CopyFileIdentity | null = null;
  let tempSizeBytes: number | null = null;
  const tempPath = operation.tempPath;
  if (!tempPath) {
    blockers.push("The copy journal does not record a temporary file to discard.");
  } else if (root && !isPathInside(root, tempPath)) {
    blockers.push("The journaled temporary file is outside the configured destination root.");
  } else if (!journaledTempNameMatches(operation.destinationPath, tempPath)) {
    blockers.push("The journaled temporary file does not match SRTL's copy naming pattern next to the destination.");
  } else if (root) {
    const temp = await readTempIdentity(tempPath);
    if (temp.problem) {
      blockers.push(temp.problem);
    } else {
      try {
        await withFilesystemTimeout(assertExistingPathInside(root, tempPath, "Temporary file"), `Partial copy root check for ${tempPath}`);
        tempIdentity = temp.identity;
        tempSizeBytes = Number(temp.identity!.size);
      } catch (error) {
        blockers.push(`The temporary file is not safely inside the destination root (${error instanceof Error ? error.message : String(error)}).`);
      }
      if (tempIdentity && operation.tempIdentity) {
        let journaled: CopyFileIdentity | null = null;
        try {
          journaled = parseCopyFileIdentity(operation.tempIdentity);
        } catch {
          blockers.push("The journaled temporary-file identity is unreadable.");
        }
        if (journaled && !copyFileIdentitiesMatch(tempIdentity, journaled)) {
          blockers.push("The temporary file changed after its identity was journaled.");
        }
      }
    }
  }

  const originalTarget = path.resolve(operation.originalTargetPath);
  if (link.kind === "symlink") {
    if (link.target !== originalTarget) blockers.push("The library symlink no longer points at the copy's original target.");
  } else if (link.kind === "missing") {
    blockers.push("The library symlink is missing.");
  } else if (link.kind === "other") {
    blockers.push("The library path is no longer a symlink.");
  } else {
    blockers.push("The library symlink could not be inspected.");
  }

  if (displaced === "exists") blockers.push("A displaced destination file from this copy still exists and needs manual handling.");
  if (displaced === "unknown") blockers.push("The displaced destination path could not be inspected.");

  return {
    tempIdentity,
    preview: {
      operationId: operation.id,
      jobId: operation.jobId,
      mediaLinkId: operation.mediaLinkId,
      linkPath: operation.linkPath,
      originalTargetPath: operation.originalTargetPath,
      currentLinkTarget: link.kind === "symlink" ? link.target : null,
      destinationPath: operation.destinationPath,
      destinationExists: destination === "unknown" ? null : destination === "exists",
      tempPath,
      tempSizeBytes,
      displacedPath: operation.displacedPath,
      eligible: blockers.length === 0,
      blockers
    }
  };
}

async function unresolvedOperation(db: Db, operationId: number, lock: boolean): Promise<CopyOperation> {
  const query = db
    .select()
    .from(schema.copyOperations)
    .where(and(eq(schema.copyOperations.id, operationId), unresolvedCopyReconciliation()))
    .limit(1);
  const operation = await first(lock ? query.for("update") : query);
  if (operation) return operation;
  const exists = await first(db.select({ id: schema.copyOperations.id }).from(schema.copyOperations).where(eq(schema.copyOperations.id, operationId)).limit(1));
  if (!exists) throw new PartialCopyDiscardError(`Copy operation #${operationId} was not found`, 404);
  throw new PartialCopyDiscardError(`Copy operation #${operationId} no longer requires manual reconciliation`, 409);
}

export async function previewPartialCopyDiscard(db: Db, operationId: number): Promise<PartialCopyDiscardPreview> {
  return (await inspectOperation(db, await unresolvedOperation(db, operationId, false))).preview;
}

export async function discardPartialCopy(db: Db, operationId: number, request: PartialCopyDiscardRequest): Promise<PartialCopyDiscardResult> {
  const result = await db.transaction(async (transaction) => {
    await transaction.execute(sql`select pg_advisory_xact_lock(${schedulerLockKey})`);
    const operation = await unresolvedOperation(transaction, operationId, true);
    const { preview, tempIdentity } = await inspectOperation(transaction, operation);
    if (!preview.eligible || !preview.tempPath || !tempIdentity) {
      throw new PartialCopyDiscardError(`Partial copy for operation #${operationId} was not discarded: ${preview.blockers.join(" ")} Leave it for manual handling.`, 409);
    }
    if (path.resolve(request.tempPath) !== path.resolve(preview.tempPath) || request.tempSizeBytes !== preview.tempSizeBytes) {
      throw new PartialCopyDiscardError(
        `Partial copy for operation #${operationId} was not discarded: the temporary file changed since it was reviewed. Review it again before discarding.`,
        409
      );
    }

    const currentIdentity = await withFilesystemTimeout(readCopyFileIdentity(preview.tempPath), `Partial copy identity check for ${preview.tempPath}`);
    if (!copyFileIdentitiesMatch(currentIdentity, tempIdentity)) {
      throw new PartialCopyDiscardError(`Partial copy for operation #${operationId} was not discarded: the temporary file changed during validation.`, 409);
    }
    await withFilesystemTimeout(fs.unlink(preview.tempPath), `Partial copy removal for ${preview.tempPath}`);

    const timestamp = nowIso();
    const message = `Partial copy discarded from the reconciliation screen: removed temporary file ${preview.tempPath}; the library symlink still points at ${operation.originalTargetPath}.`;
    await transaction
      .update(schema.copyOperations)
      .set({
        stage: "failed",
        tempPath: null,
        tempIdentity: null,
        displacedPath: null,
        displacedIdentity: null,
        errorMessage: message,
        reconciliationResolvedAt: timestamp,
        updatedAt: timestamp,
        completedAt: timestamp
      })
      .where(and(eq(schema.copyOperations.id, operation.id), eq(schema.copyOperations.stage, "reconciliation_required")));
    await transaction.insert(schema.jobEvents).values({
      jobId: operation.jobId,
      timestamp,
      level: "warn",
      message: "Partial copy discarded during manual reconciliation",
      data: JSON.stringify({
        operationId: operation.id,
        mediaLinkId: operation.mediaLinkId,
        linkPath: operation.linkPath,
        linkTarget: preview.currentLinkTarget,
        destinationPath: operation.destinationPath,
        removedTempPath: preview.tempPath,
        removedBytes: preview.tempSizeBytes
      })
    });
    return { operationId: operation.id, jobId: operation.jobId, removedTempPath: preview.tempPath, removedBytes: preview.tempSizeBytes ?? 0 };
  });
  const unresolved = await listCopyReconciliation(db);
  return { ...result, state: { unresolved, unresolvedCount: unresolved.length, resolvedNow: 1 } };
}
