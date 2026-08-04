import { sql } from "drizzle-orm";
import type { Db } from "../db/database";
import * as schema from "../db/schema";
import { canonicalTitleKey } from "../lib/storagePolicies";
import { reconcileProvablySettledCopyOperations, unresolvedCopyReconciliation } from "./copyReconciliation";
import { schedulerLockKey } from "./scheduling";

export interface MutationResource {
  resourceType: string;
  resourceKey: string;
}

interface ActiveJobConflict extends Record<string, unknown> {
  jobId: number;
  type: string;
  status: string;
}

interface PreparedResourceMutation<T> {
  resources: MutationResource[];
  mutate(): Promise<T>;
}

export class ActiveJobResourceConflictError extends Error {
  readonly statusCode = 409;

  constructor(conflict: ActiveJobConflict, global: boolean) {
    const scope = global ? "the library" : "the same media";
    if (conflict.status === "reconciliation_required") {
      super(`Storage policy cannot be changed because copy data from job #${conflict.jobId} requires manual reconciliation for ${scope}.`);
      this.name = "ActiveJobResourceConflictError";
      return;
    }
    super(
      `Storage policy cannot be changed while ${conflict.type} job #${conflict.jobId} is ${conflict.status} for ${scope}. Wait for it to finish or terminate it before changing this policy.`
    );
    this.name = "ActiveJobResourceConflictError";
  }
}

export class ActiveJobConfigurationConflictError extends Error {
  readonly statusCode = 409;

  constructor(job: ActiveJobConflict) {
    super(`Library folders cannot be changed while ${job.type} job #${job.jobId} is ${job.status}. Wait for it to finish or terminate it first.`);
    this.name = "ActiveJobConfigurationConflictError";
  }
}

function normalizeResources(resources: MutationResource[]): MutationResource[] {
  const unique = new Map<string, MutationResource>();
  for (const resource of resources) unique.set(`${resource.resourceType}\0${resource.resourceKey}`, resource);
  return [...unique.values()];
}

export async function storagePolicyMutationResources(db: Db, titles: string[]): Promise<MutationResource[]> {
  const titleKeys = new Set(titles.map(canonicalTitleKey).filter(Boolean));
  if (titleKeys.size === 0) return [];

  const links = await db
    .select({ id: schema.mediaLinks.id, section: schema.mediaLinks.section, itemName: schema.mediaLinks.itemName })
    .from(schema.mediaLinks);

  return normalizeResources(
    links
      .filter((link) => titleKeys.has(canonicalTitleKey(link.itemName)))
      .flatMap((link) => [
        { resourceType: "media", resourceKey: String(link.id) },
        { resourceType: "title", resourceKey: JSON.stringify([link.section, link.itemName]) }
      ])
  );
}

export async function withResourceMutationGuard<T>(
  db: Db,
  prepare: (transaction: Db) => Promise<PreparedResourceMutation<T>>
): Promise<T> {
  await reconcileProvablySettledCopyOperations(db);
  return db.transaction(async (transaction) => {
    await transaction.execute(sql`select pg_advisory_xact_lock(${schedulerLockKey})`);
    const prepared = await prepare(transaction);
    const resources = normalizeResources(prepared.resources);

    const globalConflict = (
      await transaction.execute<ActiveJobConflict>(sql`
        select id as "jobId", type, status
        from jobs
        where status in ('queued', 'running')
          and exclusive = true
        order by id
        limit 1
      `)
    ).rows[0];
    if (globalConflict) throw new ActiveJobResourceConflictError(globalConflict, true);

    if (resources.length > 0) {
      const queryResources = resources.map((resource) => ({ resource_type: resource.resourceType, resource_key: resource.resourceKey }));
      const conflict = (
        await transaction.execute<ActiveJobConflict>(sql`
          with requested_resources as (
            select resource_type, resource_key
            from jsonb_to_recordset(${JSON.stringify(queryResources)}::jsonb)
              as requested(resource_type text, resource_key text)
          ), blocking_claims as (
            select active.job_id, active.resource_type, active.resource_key, jobs.type, jobs.status
            from job_resource_claims as active
            join jobs on jobs.id = active.job_id
            where jobs.status in ('queued', 'running')
            union
            select copy_operations.job_id, 'media'::text, copy_operations.media_link_id::text, 'copy'::text as type, 'reconciliation_required'::text as status
            from copy_operations
            where ${unresolvedCopyReconciliation()}
          )
          select active.job_id as "jobId", active.type, active.status
          from requested_resources as requested
          join blocking_claims as active
            on active.resource_type = requested.resource_type
           and active.resource_key = requested.resource_key
          order by active.job_id
          limit 1
        `)
      ).rows[0];
      if (conflict) throw new ActiveJobResourceConflictError(conflict, false);
    }

    return prepared.mutate();
  });
}

export async function withQueueConfigurationGuard<T>(db: Db, mutate: (transaction: Db) => Promise<T>): Promise<T> {
  return db.transaction(async (transaction) => {
    await transaction.execute(sql`select pg_advisory_xact_lock(${schedulerLockKey})`);
    const activeJob = (
      await transaction.execute<ActiveJobConflict>(sql`
        select id as "jobId", type, status
        from jobs
        where status in ('queued', 'running')
        order by id
        limit 1
      `)
    ).rows[0];
    if (activeJob) throw new ActiveJobConfigurationConflictError(activeJob);
    return mutate(transaction);
  });
}
