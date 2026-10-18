import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Db } from "../db/database";
import { getRadarrCopyDefaults, getRadarrState, radarrSettingsSchema, receiveRadarrWebhook, reconcileRadarrMovies, refreshRadarr, saveRadarrSettings, testRadarrConnection } from "../lib/radarr";

export const radarrWebhookPath = "/api/integrations/radarr/webhook";

export function registerRadarrRoutes(app: FastifyInstance, db: Db): void {
  app.get("/api/settings/radarr", async (_request, reply) => {
    reply.header("Cache-Control", "no-store");
    return getRadarrState(db);
  });
  app.get("/api/settings/radarr/copy-defaults", async () => getRadarrCopyDefaults(db));
  app.put("/api/settings/radarr", async (request) => saveRadarrSettings(db, radarrSettingsSchema.parse(request.body)));
  app.post("/api/settings/radarr/test", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (request) => testRadarrConnection(db, radarrSettingsSchema.parse(request.body)));
  app.post("/api/settings/radarr/refresh", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async () => refreshRadarr(db));
  app.post("/api/settings/radarr/reconcile", async (request) => {
    const input = z.object({ movieIds: z.array(z.number().int().positive()).min(1).max(1000), action: z.enum(["use_srtl", "import_tags"]) }).parse(request.body);
    return reconcileRadarrMovies(db, [...new Set(input.movieIds)], input.action);
  });
  app.post(radarrWebhookPath, { bodyLimit: 65536, config: { rateLimit: { max: 120, timeWindow: "1 minute" } } }, async (request, reply) => {
    const result = await receiveRadarrWebhook(db, request.body);
    return reply.code(202).send(result);
  });
}
