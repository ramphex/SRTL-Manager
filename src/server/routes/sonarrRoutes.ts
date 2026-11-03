import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Db } from "../db/database";
import { recordActionAudit } from "../lib/actionAudit";
import { createSonarrInstance, getSonarrCopyDefaults, getSonarrOverview, getSonarrState, reconcileSonarrSeries, receiveSonarrWebhook, refreshSonarr, removeSonarrInstance, renameSonarrInstance, saveSonarrSettings, sonarrInstanceIdSchema, sonarrInstanceNameSchema, sonarrSettingsSchema, testSonarrConnection } from "../lib/sonarr";

export const sonarrWebhookPath = "/api/integrations/sonarr/:instanceId/webhook";

const instanceParams = z.object({ instanceId: sonarrInstanceIdSchema });
const nameBody = z.object({ name: sonarrInstanceNameSchema });

export function sonarrWebhookInstanceId(request: FastifyRequest): string {
  return instanceParams.parse(request.params).instanceId;
}

// Sonarr instances often share one host, so the limit is counted per instance as well as per address.
const webhookRateLimit = { max: 120, timeWindow: "1 minute", keyGenerator: (request: FastifyRequest) => `${request.ip}\0sonarr\0${String((request.params as { instanceId?: unknown }).instanceId)}` };

export function registerSonarrRoutes(app: FastifyInstance, db: Db): void {
  const instanceId = (request: FastifyRequest) => instanceParams.parse(request.params).instanceId;
  app.get("/api/settings/sonarr", async (_request, reply) => {
    reply.header("Cache-Control", "no-store");
    return getSonarrOverview(db);
  });
  app.get("/api/settings/sonarr/copy-defaults", async () => getSonarrCopyDefaults(db));
  app.post("/api/settings/sonarr/instances", async (request) => createSonarrInstance(db, nameBody.parse(request.body).name));
  app.get("/api/settings/sonarr/instances/:instanceId", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    return getSonarrState(db, instanceId(request));
  });
  app.put("/api/settings/sonarr/instances/:instanceId", async (request) => saveSonarrSettings(db, instanceId(request), sonarrSettingsSchema.parse(request.body)));
  app.delete("/api/settings/sonarr/instances/:instanceId", async (request) => {
    const id = instanceId(request);
    const name = (await getSonarrOverview(db)).instances.find((instance) => instance.settings.id === id)?.settings.name;
    const overview = await removeSonarrInstance(db, id);
    await recordActionAudit(db, request, {
      action: "sonarr_instance.remove",
      summary: `Removed Sonarr instance${name ? ` "${name}"` : ""}`,
      targets: { instanceId: id, ...(name ? { name } : {}) }
    });
    return overview;
  });
  app.post("/api/settings/sonarr/instances/:instanceId/rename", async (request) => renameSonarrInstance(db, instanceId(request), nameBody.parse(request.body).name));
  app.post("/api/settings/sonarr/instances/:instanceId/test", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (request) => testSonarrConnection(db, instanceId(request), sonarrSettingsSchema.parse(request.body)));
  app.post("/api/settings/sonarr/instances/:instanceId/refresh", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (request) => refreshSonarr(db, instanceId(request)));
  app.post("/api/settings/sonarr/instances/:instanceId/reconcile", async (request) => {
    const input = z.object({ seriesIds: z.array(z.number().int().positive()).min(1).max(1000), action: z.enum(["use_srtl", "import_tags"]) }).parse(request.body);
    return reconcileSonarrSeries(db, instanceId(request), [...new Set(input.seriesIds)], input.action);
  });
  app.post(sonarrWebhookPath, { bodyLimit: 262144, config: { rateLimit: webhookRateLimit } }, async (request, reply) => {
    const result = await receiveSonarrWebhook(db, sonarrWebhookInstanceId(request), request.body);
    return reply.code(202).send(result);
  });
}
