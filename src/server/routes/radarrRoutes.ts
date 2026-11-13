import type { FastifyInstance, FastifyRequest } from "fastify";
import { clientBucket } from "../clientAddress";
import { z, ZodError } from "zod";
import type { Db } from "../db/database";
import { recordActionAudit } from "../lib/actionAudit";
import { createRadarrInstance, getRadarrCopyDefaults, getRadarrOverview, getRadarrState, radarrInstanceIdSchema, radarrInstanceNameSchema, radarrSettingsSchema, receiveRadarrWebhook, reconcileRadarrMovies, refreshRadarr, removeRadarrInstance, renameRadarrInstance, saveRadarrSettings, testRadarrConnection } from "../lib/radarr";

// The original single-instance URL keeps serving the instance migrated from it.
export const radarrWebhookPath = "/api/integrations/radarr/webhook";
export const radarrInstanceWebhookPath = "/api/integrations/radarr/:instanceId/webhook";

const instanceParams = z.object({ instanceId: radarrInstanceIdSchema });
const nameBody = z.object({ name: radarrInstanceNameSchema });

export function webhookInstanceId(request: FastifyRequest): string | null {
  return request.routeOptions.url === radarrInstanceWebhookPath ? instanceParams.parse(request.params).instanceId : null;
}

// Radarr instances often share one host, so the limit is counted per instance as well as per address.
const webhookRateLimit = { max: 120, timeWindow: "1 minute", keyGenerator: (request: FastifyRequest) => `${clientBucket(request.ip)}\0${(request.params as { instanceId?: unknown }).instanceId ?? "legacy"}` };

export function registerRadarrRoutes(app: FastifyInstance, db: Db): void {
  const instanceId = (request: FastifyRequest) => instanceParams.parse(request.params).instanceId;
  app.get("/api/settings/radarr", async (_request, reply) => {
    reply.header("Cache-Control", "no-store");
    return getRadarrOverview(db);
  });
  app.get("/api/settings/radarr/copy-defaults", async () => getRadarrCopyDefaults(db));
  app.post("/api/settings/radarr/instances", async (request) => createRadarrInstance(db, nameBody.parse(request.body).name));
  app.get("/api/settings/radarr/instances/:instanceId", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    return getRadarrState(db, instanceId(request));
  });
  app.put("/api/settings/radarr/instances/:instanceId", async (request) => saveRadarrSettings(db, instanceId(request), radarrSettingsSchema.parse(request.body)));
  app.delete("/api/settings/radarr/instances/:instanceId", async (request) => {
    const id = instanceId(request);
    const name = (await getRadarrOverview(db)).instances.find((instance) => instance.settings.id === id)?.settings.name;
    const overview = await removeRadarrInstance(db, id);
    await recordActionAudit(db, request, {
      action: "radarr_instance.remove",
      summary: `Removed Radarr instance${name ? ` "${name}"` : ""}`,
      targets: { instanceId: id, ...(name ? { name } : {}) }
    });
    return overview;
  });
  app.post("/api/settings/radarr/instances/:instanceId/rename", async (request) => renameRadarrInstance(db, instanceId(request), nameBody.parse(request.body).name));
  app.post("/api/settings/radarr/instances/:instanceId/test", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (request) => testRadarrConnection(db, instanceId(request), radarrSettingsSchema.parse(request.body)));
  app.post("/api/settings/radarr/instances/:instanceId/refresh", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (request) => refreshRadarr(db, instanceId(request)));
  app.post("/api/settings/radarr/instances/:instanceId/reconcile", async (request) => {
    const input = z.object({ movieIds: z.array(z.number().int().positive()).min(1).max(1000), action: z.enum(["use_srtl", "import_tags"]) }).parse(request.body);
    return reconcileRadarrMovies(db, instanceId(request), [...new Set(input.movieIds)], input.action);
  });
  for (const url of [radarrWebhookPath, radarrInstanceWebhookPath]) {
    app.post(url, { bodyLimit: 65536, config: { rateLimit: webhookRateLimit } }, async (request, reply) => {
      try {
        const result = await receiveRadarrWebhook(db, webhookInstanceId(request), request.body);
        return reply.code(202).send(result);
      } catch (error) {
        // A rejected delivery only shows up in Radarr otherwise. Field names and messages only; values can hold paths.
        if (error instanceof ZodError) request.log.warn({ issues: error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })) }, "Radarr webhook rejected");
        throw error;
      }
    });
  }
}
