import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { JobRunner } from "../jobs/jobRunner";

export function registerJobRoutes(app: FastifyInstance, jobs: JobRunner): void {
  app.get("/api/jobs", async (request) => {
    const query = z
      .object({
        activeOnly: z.union([z.literal("true"), z.literal("false"), z.boolean()]).optional().transform((value) => value === true || value === "true"),
        completedWithinMinutes: z.coerce.number().int().min(1).max(10080).optional(),
        limit: z.coerce.number().int().min(1).max(1000).default(500)
      })
      .parse(request.query);
    const completedSince = query.completedWithinMinutes ? new Date(Date.now() - query.completedWithinMinutes * 60_000).toISOString() : undefined;
    return jobs.listJobs({ activeOnly: query.activeOnly, completedSince, limit: query.limit });
  });

  app.get("/api/jobs/:id", async (request, reply) => {
    const params = z.object({ id: z.coerce.number() }).parse(request.params);
    const row = await jobs.getJob(params.id);
    if (!row) return reply.code(404).send({ error: "Job not found" });
    return row;
  });

  app.get("/api/jobs/:id/copy-failures", async (request, reply) => {
    const params = z.object({ id: z.coerce.number().int().positive() }).parse(request.params);
    const job = await jobs.getJob(params.id);
    if (!job) return reply.code(404).send({ error: "Copy job not found" });
    if (job.type !== "copy") return reply.code(400).send({ error: "Failed symlinks can only be reviewed for copy jobs" });
    try {
      return await jobs.copyFailures(params.id);
    } catch (error: unknown) {
      return reply.code(409).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/jobs/:id/copy-failures/remove-symlinks", async (request, reply) => {
    const params = z.object({ id: z.coerce.number().int().positive() }).parse(request.params);
    const body = z.object({ mediaLinkIds: z.array(z.number().int().positive()).min(1).max(10_000) }).parse(request.body);
    const job = await jobs.getJob(params.id);
    if (!job) return reply.code(404).send({ error: "Copy job not found" });
    if (job.type !== "copy") return reply.code(400).send({ error: "Failed symlinks can only be removed for copy jobs" });
    try {
      return { jobId: await jobs.startSymlinkCleanup(params.id, body.mediaLinkIds) };
    } catch (error: unknown) {
      return reply.code(409).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get("/api/job-reconciliation", async () => jobs.copyReconciliationState());

  app.post("/api/job-reconciliation/recheck", async () => jobs.recheckCopyReconciliation());

  app.post("/api/jobs/:id/terminate", async (request, reply) => {
    const params = z.object({ id: z.coerce.number() }).parse(request.params);
    if (!(await jobs.terminate(params.id))) return reply.code(409).send({ error: "Job cannot be terminated" });
    return { ok: true, jobId: params.id };
  });

  app.post("/api/jobs/:id/cancel", async (request, reply) => {
    const params = z.object({ id: z.coerce.number() }).parse(request.params);
    if (!(await jobs.terminate(params.id))) return reply.code(409).send({ error: "Job cannot be terminated" });
    return { ok: true, jobId: params.id };
  });

  app.get("/api/jobs/:id/events", async (request) => {
    const params = z.object({ id: z.coerce.number() }).parse(request.params);
    const query = z.object({ afterId: z.coerce.number().int().min(0).default(0), limit: z.coerce.number().int().min(1).max(500).default(100) }).parse(request.query);
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
    return jobs.listEventPage(params.id, query.beforeId, query.limit);
  });
}
