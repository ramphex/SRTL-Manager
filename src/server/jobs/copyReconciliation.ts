import fs from "node:fs/promises";
import path from "node:path";
import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import { nowIso, type Db } from "../db/database";
import * as schema from "../db/schema";
import { withFilesystemTimeout } from "../lib/filesystemSafety";
import { copyFileIdentitiesMatch, parseCopyFileIdentity, readCopyFileIdentity } from "../lib/copier";
import type { CopyReconciliationRecord, CopyReconciliationState } from "../../shared/types";
import { schedulerLockKey } from "./scheduling";

export function unresolvedCopyReconciliation(): SQL {
  return sql`
    ${schema.copyOperations.stage} = 'reconciliation_required'
    AND NOT EXISTS (
      SELECT 1
      FROM copy_operations AS superseding_operation
      WHERE superseding_operation.id > ${schema.copyOperations.id}
        AND superseding_operation.media_link_id = ${schema.copyOperations.mediaLinkId}
        AND superseding_operation.link_path = ${schema.copyOperations.linkPath}
        AND superseding_operation.stage = 'committed'
        AND superseding_operation.result_status IN ('copied', 'repointed')
    )
  `;
}

type CopyOperation = typeof schema.copyOperations.$inferSelect;
type PathPresence = "exists" | "missing" | "unknown";
type LinkState = { kind: "symlink"; target: string } | { kind: "missing" | "other" | "unknown" };

async function pathPresence(filePath: string | null, label: string): Promise<PathPresence> {
  if (!filePath) return "missing";
  try {
    await withFilesystemTimeout(fs.lstat(filePath), label);
    return "exists";
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return "missing";
    return "unknown";
  }
}

async function linkState(linkPath: string): Promise<LinkState> {
  try {
    const stat = await withFilesystemTimeout(fs.lstat(linkPath), `Copy reconciliation link inspection for ${linkPath}`);
    if (!stat.isSymbolicLink()) return { kind: "other" };
    const target = await withFilesystemTimeout(fs.readlink(linkPath), `Copy reconciliation target inspection for ${linkPath}`);
    return { kind: "symlink", target: path.resolve(path.dirname(linkPath), target) };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return { kind: "missing" };
    return { kind: "unknown" };
  }
}

async function destinationMatchesJournal(operation: CopyOperation): Promise<boolean> {
  if (!operation.destinationIdentity) return false;
  try {
    const expected = parseCopyFileIdentity(operation.destinationIdentity);
    const actual = await withFilesystemTimeout(
      readCopyFileIdentity(operation.destinationPath),
      `Copy reconciliation destination identity inspection for ${operation.destinationPath}`
    );
    return copyFileIdentitiesMatch(actual, expected);
  } catch {
    return false;
  }
}

type ProvenResolution = { stage: "committed" | "rolled_back" | "failed"; resultStatus?: "copied" | "repointed"; message?: string };

async function provableResolution(operation: CopyOperation): Promise<ProvenResolution | null> {
  const [link, destination, temporary, displaced] = await Promise.all([
    linkState(operation.linkPath),
    pathPresence(operation.destinationPath, `Copy reconciliation destination inspection for ${operation.destinationPath}`),
    pathPresence(operation.tempPath, `Copy reconciliation temporary-file inspection for operation #${operation.id}`),
    pathPresence(operation.displacedPath, `Copy reconciliation displaced-file inspection for operation #${operation.id}`)
  ]);
  if (link.kind === "unknown" || destination === "unknown" || temporary === "unknown" || displaced === "unknown") return null;
  if (temporary === "exists" || displaced === "exists" || link.kind === "other") return null;

  if (link.kind === "symlink") {
    if (link.target === path.resolve(operation.originalTargetPath)) {
      if (destination === "missing") return { stage: "rolled_back" };
      return {
        stage: "failed",
        message: "Automatically closed after recheck: the original symlink is intact and no temporary or displaced journal artifacts remain; the existing destination was left untouched for normal conflict handling."
      };
    }
    if (link.target === path.resolve(operation.destinationPath) && destination === "exists") {
      if (!(await destinationMatchesJournal(operation))) return null;
      return {
        stage: "committed",
        resultStatus: operation.resultStatus === "repointed" || operation.sourcePath === operation.destinationPath ? "repointed" : "copied"
      };
    }
    if (destination === "missing") {
      return { stage: "failed", message: "Automatically closed after recheck: the symlink moved elsewhere and no journaled copy artifacts remain." };
    }
    return null;
  }

  if (link.kind === "missing" && destination === "missing") return { stage: "rolled_back" };
  return null;
}

function serializeOperation(operation: CopyOperation): CopyReconciliationRecord {
  return {
    id: operation.id,
    jobId: operation.jobId,
    mediaLinkId: operation.mediaLinkId,
    linkPath: operation.linkPath,
    errorMessage: operation.errorMessage,
    updatedAt: operation.updatedAt
  };
}

export async function listCopyReconciliation(db: Db): Promise<CopyReconciliationRecord[]> {
  const rows = await db.select().from(schema.copyOperations).where(unresolvedCopyReconciliation()).orderBy(schema.copyOperations.id);
  return rows.map(serializeOperation);
}

export async function reconcileProvablySettledCopyOperations(db: Db): Promise<CopyReconciliationState> {
  const operations = await db.select().from(schema.copyOperations).where(unresolvedCopyReconciliation()).orderBy(schema.copyOperations.id);
  if (operations.length === 0) return { unresolved: [], unresolvedCount: 0, resolvedNow: 0 };
  const jobIds = [...new Set(operations.map((operation) => operation.jobId))];
  const jobs = await db.select({ id: schema.jobs.id, status: schema.jobs.status }).from(schema.jobs).where(inArray(schema.jobs.id, jobIds));
  const terminalJobIds = new Set(jobs.filter((job) => !["queued", "running"].includes(job.status)).map((job) => job.id));
  const candidates = operations.filter((operation) => terminalJobIds.has(operation.jobId));
  const resolutions = new Map<number, ProvenResolution>();
  let nextIndex = 0;
  await Promise.all(
    Array.from({ length: Math.min(8, candidates.length) }, async () => {
      while (nextIndex < candidates.length) {
        const operation = candidates[nextIndex];
        nextIndex += 1;
        if (!operation) continue;
        const resolution = await provableResolution(operation);
        if (resolution) resolutions.set(operation.id, resolution);
      }
    })
  );

  if (resolutions.size > 0) {
    await db.transaction(async (transaction) => {
      await transaction.execute(sql`select pg_advisory_xact_lock(${schedulerLockKey})`);
      const timestamp = nowIso();
      for (const [operationId, resolution] of resolutions) {
        await transaction
          .update(schema.copyOperations)
          .set({
            stage: resolution.stage,
            ...(resolution.resultStatus ? { resultStatus: resolution.resultStatus } : {}),
            tempPath: null,
            displacedPath: null,
            tempIdentity: null,
            displacedIdentity: null,
            errorMessage: resolution.message ?? null,
            reconciliationResolvedAt: timestamp,
            updatedAt: timestamp,
            completedAt: timestamp
          })
          .where(and(eq(schema.copyOperations.id, operationId), eq(schema.copyOperations.stage, "reconciliation_required")));
      }
    });
  }
  const unresolved = await listCopyReconciliation(db);
  return { unresolved, unresolvedCount: unresolved.length, resolvedNow: operations.length - unresolved.length };
}
