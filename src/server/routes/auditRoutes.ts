import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { and, count, desc, eq, inArray, ne } from "drizzle-orm";
import { first, getSectionSettings, type Db } from "../db/database";
import * as schema from "../db/schema";
import type { JobRunner } from "../jobs/jobRunner";
import type { AuditOptions, AuditResultPage, AuditRunRecord, JobStatus } from "../../shared/types";

const maxBulkSelectionItems = 100_000;
const largeSelectionBodyLimitBytes = 4 * 1024 * 1024;

const auditOptionsSchema = z.object({
  mode: z.enum(["fast", "deep"]),
  sections: z.array(z.string().trim().min(1).max(200)).min(1, "Select at least one audit folder").optional(),
  targets: z.array(z.enum(["local", "remote"])).min(1, "Select at least one audit target").optional(),
  linkIds: z.array(z.coerce.number().int().positive()).max(maxBulkSelectionItems).optional(),
  section: z.string().trim().min(1).max(200).optional(),
  itemName: z.string().trim().min(1).max(500).optional(),
  relativePathPrefix: z.string().trim().min(1).max(2000).optional(),
  byteCompare: z.boolean().optional()
});

function normalizeAuditSections(selectedSections: string[] | undefined, configuredSections: string[]): string[] {
  const configured = new Set(configuredSections);
  const requested = selectedSections ?? configuredSections;
  const normalized = [...new Set(requested.map((section) => section.trim()).filter(Boolean))];
  const invalid = normalized.filter((section) => !configured.has(section));
  if (invalid.length > 0) {
    throw new Error(`Unknown audit folder: ${invalid.join(", ")}`);
  }
  return normalized;
}

function auditOptionsFromJob(progressJson: string, optionsJson = ""): AuditOptions | null {
  try {
    const progress = JSON.parse(progressJson) as { options?: unknown };
    const storedOptions = optionsJson ? (JSON.parse(optionsJson) as unknown) : null;
    const parsed = auditOptionsSchema.safeParse(storedOptions && typeof storedOptions === "object" && !Array.isArray(storedOptions) ? storedOptions : progress?.options);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

async function listAuditHistory(db: Db): Promise<AuditRunRecord[]> {
  const runs = await db.select().from(schema.auditRuns).orderBy(desc(schema.auditRuns.id)).limit(25);
  const jobIds = runs.map((run) => run.jobId);
  const jobs = jobIds.length > 0 ? await db.select().from(schema.jobs).where(inArray(schema.jobs.id, jobIds)) : [];
  const jobById = new Map(jobs.map((job) => [job.id, job]));
  return runs.map((run) => serializeAuditRun(run, jobById));
}

function serializeAuditRun(run: typeof schema.auditRuns.$inferSelect, jobById: Map<number, typeof schema.jobs.$inferSelect>): AuditRunRecord {
  const job = jobById.get(run.jobId);
  return {
    ...run,
    mode: run.mode as AuditRunRecord["mode"],
    status: run.status as JobStatus,
    options: auditOptionsFromJob(job?.progress ?? "", job?.options ?? "")
  };
}

async function findAuditRunByJobId(db: Db, jobId: number): Promise<AuditRunRecord | null> {
  const run = await first(db.select().from(schema.auditRuns).where(eq(schema.auditRuns.jobId, jobId)).orderBy(desc(schema.auditRuns.id)).limit(1));
  if (!run) return null;
  const job = await first(db.select().from(schema.jobs).where(eq(schema.jobs.id, jobId)).limit(1));
  return serializeAuditRun(run, new Map(job ? [[job.id, job]] : []));
}

export function registerAuditRoutes(app: FastifyInstance, db: Db, jobs: JobRunner): void {
  app.post("/api/audits", { bodyLimit: largeSelectionBodyLimitBytes }, async (request, reply) => {
    const body = auditOptionsSchema.parse(request.body);
    const configuredSections = (await getSectionSettings(db)).sections;
    let sections: string[] | undefined;
    try {
      sections = body.sections ? normalizeAuditSections(body.sections, configuredSections) : undefined;
    } catch (error: unknown) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
    const options: AuditOptions = {
      mode: body.mode,
      ...(sections ? { sections } : {}),
      ...(body.targets ? { targets: [...new Set(body.targets)] } : {}),
      ...(body.linkIds ? { linkIds: body.linkIds } : {}),
      ...(body.section ? { section: body.section } : {}),
      ...(body.itemName ? { itemName: body.itemName } : {}),
      ...(body.relativePathPrefix ? { relativePathPrefix: body.relativePathPrefix } : {}),
      ...(body.byteCompare !== undefined ? { byteCompare: body.byteCompare } : {})
    };
    try {
      return { jobId: await jobs.startAudit(options) };
    } catch (error: unknown) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get("/api/audits", async () => listAuditHistory(db));

  app.get("/api/audits/job/:jobId", async (request) => {
    const params = z.object({ jobId: z.coerce.number().int().positive() }).parse(request.params);
    return findAuditRunByJobId(db, params.jobId);
  });

  app.get("/api/audits/:id", async (request, reply) => {
    const params = z.object({ id: z.coerce.number() }).parse(request.params);
    const row = await first(db.select().from(schema.auditRuns).where(eq(schema.auditRuns.id, params.id)).limit(1));
    if (!row) return reply.code(404).send({ error: "Audit run not found" });
    return row;
  });

  app.get("/api/audits/:id/results/page", async (request): Promise<AuditResultPage> => {
    const params = z.object({ id: z.coerce.number().int().positive() }).parse(request.params);
    const query = z
      .object({
        limit: z.coerce.number().int().min(1).max(500).default(100),
        offset: z.coerce.number().int().min(0).default(0),
        attentionOnly: z.string().transform((value) => value === "true").default(false)
      })
      .parse(request.query);
    const where = query.attentionOnly
      ? and(eq(schema.auditResults.auditRunId, params.id), ne(schema.auditResults.status, "pass"))
      : eq(schema.auditResults.auditRunId, params.id);
    const [results, totalRow] = await Promise.all([
      db.select().from(schema.auditResults).where(where).orderBy(desc(schema.auditResults.id)).limit(query.limit).offset(query.offset),
      first(db.select({ value: count() }).from(schema.auditResults).where(where).limit(1))
    ]);
    const total = Number(totalRow?.value ?? 0);
    return {
      results: results as AuditResultPage["results"],
      total,
      offset: query.offset,
      hasMore: query.offset + results.length < total
    };
  });
}
