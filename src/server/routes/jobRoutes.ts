import { z } from "zod";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Db } from "../db/database";
import type { JobRunner } from "../jobs/jobRunner";
import { recordActionAudit } from "../lib/actionAudit";
import { emptyEventPage, isRestrictedRequest, jobDetailsHidden, restrictedJob } from "../lib/restrictedView";
import { requestHasPermission, requirePermission } from "../routeAccess";
import { jobStoppableWithoutDeleting } from "../../shared/permissions";
import type { JobEventRecord } from "../../shared/types";

export function registerJobRoutes(app: FastifyInstance, jobs: JobRunner, db: Db): void {
  // A restricted account sees that a settings job ran, but none of what its log says.
  const hiddenFrom = async (request: FastifyRequest, jobId: number): Promise<boolean> => {
    if (!isRestrictedRequest(request)) return false;
    const job = await jobs.getJob(jobId);
    return job !== null && jobDetailsHidden(job.type);
  };
  const terminateJob = async (request: FastifyRequest, reply: FastifyReply) => {
    const params = z.object({ id: z.coerce.number() }).parse(request.params);
    if (!requestHasPermission(request, "library.delete")) {
      const job = await jobs.getJob(params.id);
      if (job && !jobStoppableWithoutDeleting(job)) requirePermission(request, "library.delete", "You can only stop scans, audits and copies to local.");
    }
    if (!(await jobs.terminate(params.id))) return reply.code(409).send({ error: "Job cannot be terminated" });
    return { ok: true, jobId: params.id };
  };

  app.get("/api/jobs", async (request) => {
    const query = z
      .object({
        activeOnly: z.union([z.literal("true"), z.literal("false"), z.boolean()]).optional().transform((value) => value === true || value === "true"),
        completedWithinMinutes: z.coerce.number().int().min(1).max(10080).optional(),
        limit: z.coerce.number().int().min(1).max(1000).default(500)
      })
      .parse(request.query);
    const completedSince = query.completedWithinMinutes ? new Date(Date.now() - query.completedWithinMinutes * 60_000).toISOString() : undefined;
    const rows = await jobs.listJobs({ activeOnly: query.activeOnly, completedSince, limit: query.limit });
    return isRestrictedRequest(request) ? rows.map(restrictedJob) : rows;
  });

  app.get("/api/jobs/:id", async (request, reply) => {
    const params = z.object({ id: z.coerce.number() }).parse(request.params);
    const row = await jobs.getJob(params.id);
    if (!row) return reply.code(404).send({ error: "Job not found" });
    return isRestrictedRequest(request) ? restrictedJob(row) : row;
  });

  app.get("/api/jobs/:id/copy-failures", async (request, reply) => {
    const params = z.object({ id: z.coerce.number().int().positive() }).parse(request.params);
    const job = await jobs.getJob(params.id);
    if (!job) return reply.code(404).send({ error: "Copy job not found" });
    if (job.type !== "copy") return reply.code(400).send({ error: "Failed symlinks can only be reviewed for copy jobs" });
    return jobs.copyFailures(params.id);
  });

  app.post("/api/jobs/:id/copy-failures/remove-symlinks", async (request, reply) => {
    const params = z.object({ id: z.coerce.number().int().positive() }).parse(request.params);
    const body = z.object({ mediaLinkIds: z.array(z.number().int().positive()).min(1).max(10_000) }).parse(request.body);
    const job = await jobs.getJob(params.id);
    if (!job) return reply.code(404).send({ error: "Copy job not found" });
    if (job.type !== "copy") return reply.code(400).send({ error: "Failed symlinks can only be removed for copy jobs" });
    return { jobId: await jobs.startSymlinkCleanup(params.id, body.mediaLinkIds) };
  });

  app.get("/api/job-reconciliation", async () => jobs.copyReconciliationState());

  app.post("/api/job-reconciliation/recheck", async () => jobs.recheckCopyReconciliation());

  app.get("/api/job-reconciliation/:id/discard-partial-copy", async (request) => {
    const params = z.object({ id: z.coerce.number().int().positive() }).parse(request.params);
    return jobs.previewPartialCopyDiscard(params.id);
  });

  app.post("/api/job-reconciliation/:id/discard-partial-copy", async (request) => {
    const params = z.object({ id: z.coerce.number().int().positive() }).parse(request.params);
    const body = z.object({ tempPath: z.string().min(1), tempSizeBytes: z.number().int().min(0) }).parse(request.body);
    const result = await jobs.discardPartialCopy(params.id, body);
    // The temporary file's path is deliberately not recorded; the operation ID identifies it.
    await recordActionAudit(db, request, {
      action: "copy.discard_partial",
      summary: "Discarded a partial copy left by an interrupted job",
      jobId: result.jobId,
      targets: { operationId: params.id, jobId: result.jobId, tempSizeBytes: body.tempSizeBytes }
    });
    return result;
  });

  app.post("/api/jobs/:id/terminate", terminateJob);

  app.post("/api/jobs/:id/cancel", terminateJob);

  app.get("/api/jobs/:id/events", async (request) => {
    const params = z.object({ id: z.coerce.number() }).parse(request.params);
    const query = z.object({ afterId: z.coerce.number().int().min(0).default(0), limit: z.coerce.number().int().min(1).max(500).default(100) }).parse(request.query);
    if (await hiddenFrom(request, params.id)) return [] as JobEventRecord[];
    return jobs.listEvents(params.id, query.afterId, query.limit);
  });

  app.get("/api/jobs/:id/events/page", async (request) => {
    const params = z.object({ id: z.coerce.number().int().positive() }).parse(request.params);
    const query = z
      .object({
        beforeId: z.coerce.number().int().positive().optional(),
        limit: z.coerce.number().int().min(1).max(500).default(100)
      })
      .parse(request.query);
    if (await hiddenFrom(request, params.id)) return emptyEventPage;
    return jobs.listEventPage(params.id, query.beforeId, query.limit);
  });
}
