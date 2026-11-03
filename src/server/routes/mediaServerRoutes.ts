import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Db } from "../db/database";
import { recordActionAudit } from "../lib/actionAudit";
import {
  addMediaServer,
  checkPlexSignIn,
  listMediaServers,
  mediaServerCreateSchema,
  mediaServerIdSchema,
  mediaServerInputSchema,
  removeMediaServer,
  startPlexSignIn,
  testMediaServer,
  updateMediaServer
} from "../lib/mediaServers";
import { discoverWatchSyncUsers } from "../lib/watchSync";

const serverParams = z.object({ serverId: mediaServerIdSchema });
const pinParams = serverParams.extend({ pinId: z.coerce.number().int().positive() });
const remoteRateLimit = { rateLimit: { max: 20, timeWindow: "1 minute" } };

// Plex and Jellyfin connections shared by watch sync and every other feature that reads media servers.
export function registerMediaServerRoutes(app: FastifyInstance, db: Db): void {
  const serverId = (request: FastifyRequest) => serverParams.parse(request.params).serverId;
  const base = "/api/media-servers";
  const list = async () => listMediaServers(db);

  app.get(base, async (_request, reply) => {
    reply.header("Cache-Control", "no-store");
    return list();
  });
  app.post(base, async (request) => {
    const body = mediaServerCreateSchema.parse(request.body);
    await addMediaServer(db, body.kind, body);
    return list();
  });
  app.put(`${base}/:serverId`, async (request) => {
    await updateMediaServer(db, serverId(request), mediaServerInputSchema.parse(request.body));
    return list();
  });
  app.delete(`${base}/:serverId`, async (request) => {
    const id = serverId(request);
    const removed = (await list()).servers.find((server) => server.id === id);
    await removeMediaServer(db, id);
    await recordActionAudit(db, request, {
      action: "media_server.remove",
      summary: `Removed media server${removed ? ` "${removed.name}"` : ""}`,
      targets: { serverId: id, ...(removed ? { name: removed.name, kind: removed.kind } : {}) }
    });
    return list();
  });
  app.post(`${base}/:serverId/test`, { config: remoteRateLimit }, async (request) => {
    await testMediaServer(db, serverId(request));
    return list();
  });
  app.post(`${base}/:serverId/plex-pin`, { config: remoteRateLimit }, async (request) => startPlexSignIn(db, serverId(request)));
  // Polled every few seconds while the admin approves the sign-in at plex.tv. Once signed in, watch sync refreshes the
  // server's users so their access tokens follow the new sign-in.
  app.post(`${base}/:serverId/plex-pin/:pinId`, { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, async (request) => {
    const params = pinParams.parse(request.params);
    return checkPlexSignIn(db, params.serverId, params.pinId, (id) => discoverWatchSyncUsers(db, id));
  });
}
