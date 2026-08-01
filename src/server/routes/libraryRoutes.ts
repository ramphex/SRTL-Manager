import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { desc, eq, inArray } from "drizzle-orm";
import { first, type Db } from "../db/database";
import * as schema from "../db/schema";
import type { JobRunner } from "../jobs/jobRunner";
import { storagePolicyMutationResources, withResourceMutationGuard } from "../jobs/resourceMutationGuard";
import {
  findStoragePolicyCandidateTitle,
  findStoragePolicyCandidateTitles,
  listStoragePolicyCandidates,
  listStoragePolicyTitles,
  removeStoragePolicyTitle,
  setStoragePolicyTitle,
  setStoragePolicyTitles
} from "../lib/storagePolicies";
import { getInventoryScanTimestamps, getInventorySummary, listMediaLinks, listMediaLinksByIds, listMediaLinksPage, listMediaLinkTree, listSectionSummaries, listStorageFileTree, listStorageFiles } from "../lib/scanner";
import type { InventorySummary, JobStatus, LinkKind, MediaLinkTreeKindFilter, ScanOptions, ScanRunRecord, StoragePolicyKind, StorageRootType } from "../../shared/types";

const scanOptionsSchema = z
  .object({
    scanSymlinks: z.boolean().default(true),
    scanLocal: z.boolean().default(false),
    scanRemote: z.boolean().default(false),
    symlinkSections: z.array(z.string().trim().min(1).max(200)).optional(),
    localSections: z.array(z.string().trim().min(1).max(200)).optional(),
    titleScopes: z
      .array(
        z.object({
          section: z.string().trim().min(1).max(200),
          itemName: z.string().trim().min(1).max(500)
        })
      )
      .max(100)
      .optional(),
    sections: z.array(z.string().trim().min(1).max(200)).optional()
  })
  .default({ scanSymlinks: true, scanLocal: false, scanRemote: false })
  .refine((value) => value.scanSymlinks || value.scanLocal || value.scanRemote, { message: "Select at least one scan scope" })
  .refine((value) => !value.titleScopes?.length || (value.scanSymlinks && !value.scanLocal && !value.scanRemote), {
    message: "Title rescans can only scan symlinks"
  });

const storagePolicySchema = z.enum(["unassigned", "location_1", "location_2"]);

const storagePolicyInputSchema = z.object({
  title: z.string().trim().min(1, "Title is required").max(500, "Title is too long"),
  policy: storagePolicySchema
});

const storagePolicyBulkInputSchema = z.object({
  titles: z.array(z.string().trim().min(1, "Title is required").max(500, "Title is too long")).min(1, "Select at least one title").max(1000),
  policy: storagePolicySchema
});

const mediaLinkLookupInputSchema = z.object({
  ids: z.array(z.coerce.number().int().positive()).max(1000)
});

class StoragePolicyRequestError extends Error {
  constructor(
    readonly statusCode: number,
    message: string
  ) {
    super(message);
    this.name = "StoragePolicyRequestError";
  }
}

function mediaLinkIdsFromMutationResources(resources: Array<{ resourceType: string; resourceKey: string }>): number[] {
  return resources
    .filter((resource) => resource.resourceType === "media")
    .map((resource) => Number(resource.resourceKey))
    .filter((id) => Number.isSafeInteger(id) && id > 0);
}

const copyInputSchema = z
  .object({
    direction: z.enum(["to_local", "to_remote"]),
    linkIds: z.array(z.coerce.number().int().positive()).max(1000).optional(),
    section: z.string().trim().min(1).max(200).optional(),
    itemName: z.string().trim().min(1).max(500).optional(),
    relativePathPrefix: z.string().trim().min(1).max(2000).optional(),
    localConflictStrategy: z.enum(["keep_both", "replace"]).optional()
  })
  .refine((value) => Boolean(value.linkIds?.length || value.section || value.itemName), { message: "Copy requires link IDs, a folder scope, or a title" });

function emptyScanTotals(): InventorySummary {
  return {
    totalLinks: 0,
    remoteLinks: 0,
    localLinks: 0,
    brokenLinks: 0,
    otherLinks: 0,
    nonMediaLinks: 0,
    actionableRemoteLinks: 0,
    actionableLocalLinks: 0,
    assignedRemoteLinks: 0,
    unassignedRemoteLinks: 0,
    unassignedLocalLinks: 0,
    localFiles: 0,
    remoteFiles: 0,
    actionableRemoteFiles: 0,
    actionableLocalFiles: 0,
    assignedRemoteFiles: 0,
    unassignedRemoteFiles: 0,
    unassignedLocalFiles: 0,
    localOrphanFiles: 0,
    remoteOrphanFiles: 0,
    missingLinks: 0,
    missingLocalFiles: 0,
    missingRemoteFiles: 0
  };
}

async function latestErrorMessages(db: Db, jobIds: Set<number>): Promise<Map<number, string>> {
  const messages = new Map<number, string>();
  if (jobIds.size === 0) return messages;
  for (const event of await db.select().from(schema.jobEvents).where(inArray(schema.jobEvents.jobId, [...jobIds])).orderBy(desc(schema.jobEvents.id))) {
    if (event.level === "error" && !messages.has(event.jobId)) messages.set(event.jobId, event.message);
  }
  return messages;
}

function scanOptionsFromProgress(progressJson: string): ScanOptions | null {
  try {
    const progress = JSON.parse(progressJson) as { options?: unknown };
    const options = progress?.options;
    if (!options || typeof options !== "object" || Array.isArray(options)) return null;
    return scanOptionsSchema.parse(options);
  } catch {
    return null;
  }
}

async function listScanHistory(db: Db): Promise<ScanRunRecord[]> {
  const scanRuns = await db.select().from(schema.scanRuns).orderBy(desc(schema.scanRuns.id)).limit(25);
  const scanJobs = await db.select().from(schema.jobs).where(eq(schema.jobs.type, "scan")).orderBy(desc(schema.jobs.id)).limit(50);
  const jobById = new Map(scanJobs.map((job) => [job.id, job]));
  const recordedJobIds = new Set(scanRuns.map((run) => run.jobId));
  const terminalFailureStatuses = new Set<JobStatus>(["failed", "cancelled", "partially_failed"]);
  const orphanedFailedJobs = scanJobs.filter((job) => terminalFailureStatuses.has(job.status as JobStatus) && !recordedJobIds.has(job.id));
  const errorMessages = await latestErrorMessages(db, new Set(orphanedFailedJobs.map((job) => job.id)));
  const zeroTotals = emptyScanTotals();
  const recordedRuns: ScanRunRecord[] = scanRuns.map((run) => ({ ...run, status: run.status as JobStatus, options: scanOptionsFromProgress(jobById.get(run.jobId)?.progress ?? "") }));
  const legacyRuns: ScanRunRecord[] = orphanedFailedJobs.map((job) => ({
    id: null,
    jobId: job.id,
    status: job.status as JobStatus,
    startedAt: job.startedAt ?? job.createdAt,
    finishedAt: job.finishedAt,
    errorMessage: errorMessages.get(job.id) ?? (job.status === "failed" ? "Scan failed before a history row was created." : null),
    options: scanOptionsFromProgress(job.progress),
    ...zeroTotals
  }));
  return [...recordedRuns, ...legacyRuns].sort((a, b) => b.jobId - a.jobId).slice(0, 25);
}

export function registerLibraryRoutes(app: FastifyInstance, db: Db, jobs: JobRunner): void {
  app.post("/api/scans", async (request, reply) => {
    const options = scanOptionsSchema.parse(request.body ?? undefined);
    try {
      return { jobId: await jobs.startScan(options) };
    } catch (error: unknown) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get("/api/scans", async () => listScanHistory(db));

  app.get("/api/scans/:id", async (request, reply) => {
    const params = z.object({ id: z.coerce.number() }).parse(request.params);
    const row = await first(db.select().from(schema.scanRuns).where(eq(schema.scanRuns.id, params.id)).limit(1));
    if (!row) return reply.code(404).send({ error: "Scan run not found" });
    return row;
  });

  app.get("/api/sections", async () => listSectionSummaries(db));

  app.get("/api/media-links", async (request) => {
    const query = z
      .object({
        kind: z.enum(["remote", "local", "broken", "other", "non_media"]).optional(),
        section: z.string().trim().min(1).max(200).optional(),
        storagePolicy: storagePolicySchema.optional(),
        status: z.enum(["current", "missing", "all"]).default("current")
      })
      .parse(request.query);
    return listMediaLinks(db, query.kind as LinkKind | undefined, query.status, { section: query.section, storagePolicy: query.storagePolicy as StoragePolicyKind | undefined });
  });

  app.post("/api/media-links/by-ids", async (request) => {
    const body = mediaLinkLookupInputSchema.parse(request.body ?? {});
    return listMediaLinksByIds(db, body.ids);
  });

  app.get("/api/media-links/page", async (request) => {
    const query = z
      .object({
        kind: z.enum(["remote", "local", "broken", "other", "non_media"]).optional(),
        section: z.string().trim().min(1).max(200).optional(),
        storagePolicy: storagePolicySchema.optional(),
        relativePathPrefix: z.string().trim().max(2000).optional(),
        search: z.string().trim().max(500).optional(),
        status: z.enum(["current", "missing", "all"]).default("current"),
        limit: z.coerce.number().int().min(1).max(250).default(100),
        offset: z.coerce.number().int().min(0).default(0)
      })
      .parse(request.query);
    return listMediaLinksPage(db, {
      kind: query.kind as LinkKind | undefined,
      section: query.section,
      storagePolicy: query.storagePolicy as StoragePolicyKind | undefined,
      relativePathPrefix: query.relativePathPrefix,
      search: query.search,
      status: query.status,
      limit: query.limit,
      offset: query.offset
    });
  });

  app.get("/api/media-links/tree", async (request) => {
    const query = z
      .object({
        section: z.string().trim().min(1).max(200),
        prefix: z.string().trim().max(2000).optional(),
        kind: z.enum(["remote", "local", "broken", "other", "non_media", "mixed"]).optional(),
        status: z.enum(["current", "missing", "all"]).default("current")
      })
      .parse(request.query);
    return listMediaLinkTree(db, {
      section: query.section,
      prefix: query.prefix,
      kind: query.kind as MediaLinkTreeKindFilter | undefined,
      status: query.status
    });
  });

  app.get("/api/storage-files", async (request) => {
    const query = z
      .object({
        rootType: z.enum(["local", "remote"]).optional(),
        orphan: z
          .union([z.literal("true"), z.literal("false"), z.boolean()])
          .optional()
          .transform((value) => value === true || value === "true"),
        status: z.enum(["current", "missing", "all"]).default("current")
      })
      .parse(request.query);
    return listStorageFiles(db, query.rootType as StorageRootType | undefined, query.orphan, query.status);
  });

  app.get("/api/storage-files/tree", async (request) => {
    const query = z
      .object({
        rootType: z.enum(["local", "remote"]),
        prefix: z.string().trim().max(2000).optional(),
        orphan: z
          .union([z.literal("true"), z.literal("false"), z.boolean()])
          .optional()
          .transform((value) => value === true || value === "true"),
        status: z.enum(["current", "missing", "all"]).default("current")
      })
      .parse(request.query);
    return listStorageFileTree(db, {
      rootType: query.rootType as StorageRootType,
      prefix: query.prefix,
      orphanOnly: query.orphan,
      status: query.status
    });
  });

  app.get("/api/inventory/summary", async () => getInventorySummary(db));

  app.get("/api/inventory/scan-timestamps", async () => getInventoryScanTimestamps(db));

  app.post("/api/copies", async (request, reply) => {
    const body = copyInputSchema.parse(request.body);
    try {
      return { jobId: await jobs.startCopy(body) };
    } catch (error: unknown) {
      request.log.warn({ err: error }, "Copy admission rejected");
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/copies/conflicts", async (request) => {
    const body = copyInputSchema.parse(request.body);
    return jobs.previewCopyConflicts(body);
  });

  app.get("/api/storage-policies", async (request) => {
    const query = z.object({ policy: storagePolicySchema.optional() }).parse(request.query);
    return listStoragePolicyTitles(db, query.policy as StoragePolicyKind | undefined);
  });

  app.get("/api/storage-policies/candidates", async (request) => {
    const query = z
      .object({
        q: z.string().trim().max(200).default(""),
        limit: z.coerce.number().int().min(1).max(100).default(50)
      })
      .parse(request.query);
    return listStoragePolicyCandidates(db, query.q, query.limit);
  });

  app.post("/api/storage-policies", async (request) => {
    const body = storagePolicyInputSchema.parse(request.body);
    return withResourceMutationGuard(db, async (transaction) => {
      const candidateTitle = await findStoragePolicyCandidateTitle(transaction, body.title);
      if (!candidateTitle) throw new StoragePolicyRequestError(400, "Choose a title from the scanned library.");
      const resources = await storagePolicyMutationResources(transaction, [candidateTitle]);
      return {
        resources,
        mutate: () =>
          setStoragePolicyTitle(transaction, candidateTitle, body.policy as StoragePolicyKind, {
            mediaLinkIds: mediaLinkIdsFromMutationResources(resources)
          })
      };
    });
  });

  app.post("/api/storage-policies/bulk", async (request) => {
    const body = storagePolicyBulkInputSchema.parse(request.body);
    return withResourceMutationGuard(db, async (transaction) => {
      const { candidateTitles, invalidTitles } = await findStoragePolicyCandidateTitles(transaction, body.titles);
      if (invalidTitles.length > 0) {
        throw new StoragePolicyRequestError(400, `Choose titles from the scanned library: ${invalidTitles.join(", ")}`);
      }
      const resources = await storagePolicyMutationResources(transaction, candidateTitles);
      return {
        resources,
        mutate: () =>
          setStoragePolicyTitles(transaction, candidateTitles, body.policy as StoragePolicyKind, {
            mediaLinkIds: mediaLinkIdsFromMutationResources(resources)
          })
      };
    });
  });

  app.delete("/api/storage-policies/:id", async (request) => {
    const params = z.object({ id: z.coerce.number().int().positive() }).parse(request.params);
    return withResourceMutationGuard(db, async (transaction) => {
      const existing = await first(transaction.select().from(schema.storagePolicies).where(eq(schema.storagePolicies.id, params.id)).limit(1));
      if (!existing) throw new StoragePolicyRequestError(404, "Storage policy item not found");
      return {
        resources: await storagePolicyMutationResources(transaction, [existing.normalizedTitle]),
        mutate: async () => {
          const row = await removeStoragePolicyTitle(transaction, params.id);
          if (!row) throw new StoragePolicyRequestError(404, "Storage policy item not found");
          return row;
        }
      };
    });
  });

}
