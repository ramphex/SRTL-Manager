import { and, eq, gte, inArray } from "drizzle-orm";
import { normalizeAdvancedSettings } from "../../shared/advancedSettings";
import type { CopyDirection, CopyLocalConflictStrategy, CopyRetryPlan, CopyRetrySkip, CopyRetrySkipReason, MediaLinkRow } from "../../shared/types";
import { getJsonSetting, type Db } from "../db/database";
import * as schema from "../db/schema";
import { listMediaLinksByIds } from "../lib/scanner";
import { unresolvedCopyReconciliation } from "./copyReconciliation";
import { copyFailureCandidates, parseRecord } from "./symlinkCleanup";

/** The one rule for whether a link can be the source of a copy in this direction. */
export function isCopySourceLink(link: Pick<MediaLinkRow, "kind" | "storagePolicy" | "isMedia" | "missingSince">, direction: CopyDirection): boolean {
  const sourceKind = direction === "to_local" ? "remote" : "local";
  const storagePolicy = direction === "to_local" ? "location_1" : "location_2";
  return link.kind === sourceKind && link.storagePolicy === storagePolicy && link.isMedia && !link.missingSince;
}

export interface CopyRetryOriginalOptions {
  direction: CopyDirection;
  localConflictStrategy?: CopyLocalConflictStrategy;
  allowSourceTitleMismatch?: boolean;
  radarrMonitoring?: boolean;
  sonarrMonitoring?: boolean;
}

export interface CopyRetryPlanning {
  plan: CopyRetryPlan;
  /** In the original job's selection order. */
  linkIds: number[];
  original: CopyRetryOriginalOptions;
}

export interface CopyRetryResult {
  jobId: number;
  linkIds: number[];
  plan: CopyRetryPlan;
  direction: CopyDirection;
  localConflictStrategy?: CopyLocalConflictStrategy;
  deleteRemoteSources: boolean;
}

const skipLabels: Record<CopyRetrySkipReason, string> = {
  already_copied: "already copied",
  link_gone: "with a link that is gone or missing",
  no_longer_eligible: "whose link or storage policy has changed",
  needs_reconciliation: "waiting for reconciliation",
  already_queued: "already queued",
  unidentified: "not identified in the job's records"
};

function skipDescription(skip: CopyRetrySkip): string {
  const where = skip.jobIds?.length ? ` in job ${skip.jobIds.map((id) => `#${id}`).join(", ")}` : "";
  return `${skip.count} ${skipLabels[skip.reason]}${where}`;
}

function planSummary(plan: Pick<CopyRetryPlan, "totalFailed" | "retryCount" | "skipped" | "skippedCount" | "notReachedCount">): string {
  const skips = plan.skipped.map(skipDescription).join(", ");
  const notReached =
    plan.notReachedCount > 0
      ? ` ${plan.notReachedCount} other item${plan.notReachedCount === 1 ? " was" : "s were"} not attempted because the job stopped early, so start ${plan.notReachedCount === 1 ? "it" : "them"} from the library.`
      : "";
  if (plan.totalFailed === 0) return `This job has no failed items to retry.${notReached}`;
  if (plan.retryCount === 0) return `Nothing to retry: ${skips}.${notReached}`;
  return plan.skippedCount > 0 ? `Skipping ${plan.skippedCount}: ${skips}.${notReached}` : notReached.trim();
}

function originalOptions(raw: { options: string; progress: string }): CopyRetryOriginalOptions | null {
  const options = parseRecord(raw.options);
  const progress = parseRecord(raw.progress);
  const nested = progress?.options !== null && typeof progress?.options === "object" ? (progress.options as Record<string, unknown>) : null;
  const source = options && Object.keys(options).length > 0 ? options : nested;
  if (source?.direction !== "to_local" && source?.direction !== "to_remote") return null;
  return {
    direction: source.direction,
    ...(source.localConflictStrategy === "keep_both" || source.localConflictStrategy === "replace" ? { localConflictStrategy: source.localConflictStrategy } : {}),
    ...(source.allowSourceTitleMismatch === true ? { allowSourceTitleMismatch: true } : {}),
    ...(source.radarrMonitoring === true ? { radarrMonitoring: true } : {}),
    ...(source.sonarrMonitoring === true ? { sonarrMonitoring: true } : {})
  };
}

function progressCount(progress: Record<string, unknown> | null, key: string): number {
  const value = progress?.[key];
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

/**
 * Works out which of a finished copy job's failed items still need a copy. It only reads: the job
 * is started separately, through normal copy admission, which applies every check again.
 * Returns null for a job that is not a copy, or that holds no usable direction.
 */
export async function planCopyRetry(db: Db, jobId: number): Promise<CopyRetryPlanning | null> {
  const job = await db.select().from(schema.jobs).where(eq(schema.jobs.id, jobId)).limit(1).then((rows) => rows[0]);
  if (job?.type !== "copy") return null;
  const original = originalOptions(job);
  if (!original) return null;

  const emptyPlan: CopyRetryPlan = {
    jobId,
    direction: original.direction,
    totalFailed: 0,
    retryCount: 0,
    skippedCount: 0,
    skipped: [],
    notReachedCount: 0,
    replaceOffered: false,
    deleteRemoteSourceOffered: false,
    summary: ""
  };
  if (job.status !== "failed" && job.status !== "partially_failed") {
    return { plan: { ...emptyPlan, summary: planSummary(emptyPlan) }, linkIds: [], original };
  }

  const { identified, unidentified } = await copyFailureCandidates(db, jobId);
  const ownOperations = await db.select().from(schema.copyOperations).where(eq(schema.copyOperations.jobId, jobId));
  const failedIds = new Set(identified.keys());
  // A row settled as rolled back left no copy behind: a job only rolls back outside termination through reconciliation.
  for (const operation of ownOperations) {
    if (operation.stage === "failed" || operation.stage === "reconciliation_required" || operation.stage === "rolled_back") failedIds.add(operation.mediaLinkId);
  }

  const progress = parseRecord(job.progress);
  const selections = await db.select().from(schema.jobSelectionItems).where(eq(schema.jobSelectionItems.jobId, jobId));
  const selectionOrder = new Map(selections.map((selection) => [selection.mediaLinkId, selection.selectionOrder]));
  const operationLinkIds = new Set(ownOperations.map((operation) => operation.mediaLinkId));

  // A selected item that had gone by the time the job ran counts as failed, but leaves no row or event naming it.
  const unnamedIds = selections.map((selection) => selection.mediaLinkId).filter((id) => !failedIds.has(id) && !operationLinkIds.has(id));
  const allIds = [...failedIds, ...unnamedIds];
  const links = new Map((await listMediaLinksByIds(db, allIds)).map((link) => [link.id, link]));
  const destinationKind = original.direction === "to_local" ? "local" : "remote";
  const gone = (link: MediaLinkRow | undefined) => !link || !link.isMedia || Boolean(link.missingSince);
  const unavailableBudget = Math.max(0, progressCount(progress, "failed") - failedIds.size - unidentified.length);
  const stillSelectable = (link: MediaLinkRow) =>
    !gone(link) && (link.kind === destinationKind || isCopySourceLink(link, original.direction));
  for (const id of unnamedIds.filter((id) => !links.has(id) || !stillSelectable(links.get(id)!)).slice(0, unavailableBudget)) failedIds.add(id);

  const ids = [...failedIds];
  const completedIds = new Set(
    ids.length === 0
      ? []
      : (
          await db
            .select({ mediaLinkId: schema.copyOperations.mediaLinkId })
            .from(schema.copyOperations)
            .where(
              and(
                inArray(schema.copyOperations.mediaLinkId, ids),
                gte(schema.copyOperations.jobId, jobId),
                eq(schema.copyOperations.stage, "committed"),
                inArray(schema.copyOperations.resultStatus, ["copied", "repointed"])
              )
            )
        ).map((row) => row.mediaLinkId)
  );
  const unresolvedIds = new Set(
    ids.length === 0
      ? []
      : (
          await db
            .select({ mediaLinkId: schema.copyOperations.mediaLinkId })
            .from(schema.copyOperations)
            .where(and(inArray(schema.copyOperations.mediaLinkId, ids), unresolvedCopyReconciliation()))
        ).map((row) => row.mediaLinkId)
  );
  const queuedJobByLinkId = new Map(
    ids.length === 0
      ? []
      : (
          await db
            .select({ mediaLinkId: schema.jobSelectionItems.mediaLinkId, jobId: schema.jobs.id })
            .from(schema.jobSelectionItems)
            .innerJoin(schema.jobs, eq(schema.jobs.id, schema.jobSelectionItems.jobId))
            .where(and(inArray(schema.jobSelectionItems.mediaLinkId, ids), eq(schema.jobs.type, "copy"), inArray(schema.jobs.status, ["queued", "running"])))
        ).map((row): [number, number] => [row.mediaLinkId, row.jobId])
  );

  const skipCounts = new Map<CopyRetrySkipReason, number>();
  const skip = (reason: CopyRetrySkipReason) => skipCounts.set(reason, (skipCounts.get(reason) ?? 0) + 1);
  const linkIds: number[] = [];
  const queuedJobIds = new Set<number>();
  for (const id of ids) {
    const link = links.get(id);
    if (gone(link)) skip("link_gone");
    else if (completedIds.has(id)) skip("already_copied");
    else if (unresolvedIds.has(id)) skip("needs_reconciliation");
    else if (link!.kind === destinationKind) skip("already_copied");
    else if (queuedJobByLinkId.has(id)) {
      skip("already_queued");
      queuedJobIds.add(queuedJobByLinkId.get(id)!);
    } else if (!isCopySourceLink(link!, original.direction)) skip("no_longer_eligible");
    else linkIds.push(id);
  }

  const totalFailed = Math.max(progressCount(progress, "failed"), ids.length + unidentified.length);
  const unidentifiedCount = totalFailed - ids.length;
  if (unidentifiedCount > 0) skipCounts.set("unidentified", unidentifiedCount);
  linkIds.sort((first, second) => (selectionOrder.get(first) ?? Number.MAX_SAFE_INTEGER) - (selectionOrder.get(second) ?? Number.MAX_SAFE_INTEGER));

  const skipped: CopyRetrySkip[] = [...skipCounts].map(([reason, count]) => ({
    reason,
    count,
    ...(reason === "already_queued" ? { jobIds: [...queuedJobIds].sort((first, second) => first - second) } : {})
  }));
  const settled = ["copied", "repointed", "skipped", "conflicts"].reduce((total, key) => total + progressCount(progress, key), 0);
  const advanced = normalizeAdvancedSettings(await getJsonSetting<unknown>(db, "advancedSettings", {}));
  const originalDeletedSources = parseRecord(job.options)?.deleteRemoteSource === true;
  const plan: CopyRetryPlan = {
    ...emptyPlan,
    totalFailed,
    retryCount: linkIds.length,
    skippedCount: totalFailed - linkIds.length,
    skipped,
    notReachedCount: Math.max(0, progressCount(progress, "total") - settled - totalFailed),
    replaceOffered: original.localConflictStrategy === "replace",
    deleteRemoteSourceOffered: original.direction === "to_local" && originalDeletedSources && advanced.cleanup.deleteRemoteSourceAfterCopy && advanced.copy.byteCompare
  };
  return { plan: { ...plan, summary: planSummary(plan) }, linkIds, original };
}
