import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Db } from "../db/database";
import { recordActionAudit } from "../lib/actionAudit";
import { listReRequests, previewReRequests, retryReRequests } from "../lib/reRequests";

export function registerReRequestRoutes(app: FastifyInstance, db: Db): void {
  app.get("/api/re-requests", async () => listReRequests(db));

  app.post("/api/re-requests/preview", { bodyLimit: 4 * 1024 * 1024 }, async (request) => {
    const body = z.object({ storageFileIds: z.array(z.number().int().positive()).min(1).max(50_000) }).parse(request.body);
    return previewReRequests(db, [...new Set(body.storageFileIds)]);
  });

  app.post("/api/re-requests/retry", async (request) => {
    const body = z.object({ ids: z.union([z.array(z.number().int().positive()).min(1).max(1_000), z.literal("all_failed")]) }).parse(request.body);
    const retried = await retryReRequests(db, body.ids);
    await recordActionAudit(db, request, { action: "re_request.retry", summary: `Retried ${retried} failed re-request(s)`, targets: { ids: body.ids, retried } });
    return { retried };
  });
}
