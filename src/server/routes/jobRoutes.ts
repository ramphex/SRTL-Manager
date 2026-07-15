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

  app.get("/api/jobs/:id/events", async (request, reply) => {
    const params = z.object({ id: z.coerce.number() }).parse(request.params);
    const query = z.object({ afterId: z.coerce.number().int().min(0).default(0), limit: z.coerce.number().int().min(1).max(500).default(100), stream: z.coerce.boolean().default(false) }).parse(request.query);
    if (!query.stream) return jobs.listEvents(params.id, query.afterId, query.limit);

    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive"
    });

    let lastId = query.afterId;
    const sendNewEvents = async () => {
      for (const event of await jobs.listEvents(params.id, lastId, query.limit)) {
        lastId = Math.max(lastId, event.id);
        reply.raw.write(`id: ${event.id}\n`);
        reply.raw.write(`event: ${event.level}\n`);
        reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
      }
    };

    await sendNewEvents();
    const interval = setInterval(() => {
      void sendNewEvents().catch((error: unknown) => {
        reply.raw.write(`event: error\n`);
        reply.raw.write(`data: ${JSON.stringify({ error: error instanceof Error ? error.message : String(error) })}\n\n`);
      });
    }, 1000);
    request.raw.on("close", () => clearInterval(interval));
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
