import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { Db } from "../db/database";
import { listActionAudit } from "../lib/actionAudit";

export function registerActionAuditRoutes(app: FastifyInstance, db: Db): void {
  // Who started a copy or purge, discarded a partial copy, removed a server or instance, or stopped a stream.
  app.get("/api/system/action-audit", async (request, reply) => {
    const query = z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) }).parse(request.query);
    reply.header("Cache-Control", "no-store");
    return listActionAudit(db, query.limit);
  });
}
