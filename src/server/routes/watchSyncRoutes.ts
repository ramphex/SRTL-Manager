import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Db } from "../db/database";
import type { JobRunner } from "../jobs/jobRunner";
import {
  approveWatchSyncPair,
  createWatchSyncPair,
  discoverWatchSyncUsers,
  exportWatchSyncBackup,
  getWatchSyncState,
  listWatchSyncActivity,
  removeWatchSyncPair,
  saveWatchSyncSettings,
  setWatchSyncPaused,
  updateWatchSyncPair,
  watchSyncBackupSchema,
  watchSyncPairExists,
  watchSyncServerIdSchema,
  watchSyncSettingsSchema,
  writeCursor
} from "../lib/watchSync";

const serverParams = z.object({ serverId: watchSyncServerIdSchema });
const pairParams = z.object({ pairId: z.coerce.number().int().positive() });
const remoteRateLimit = { rateLimit: { max: 20, timeWindow: "1 minute" } };

export function registerWatchSyncRoutes(app: FastifyInstance, db: Db, jobs: JobRunner): void {
  const serverId = (request: FastifyRequest) => serverParams.parse(request.params).serverId;
  const pairId = (request: FastifyRequest) => pairParams.parse(request.params).pairId;
  const base = "/api/settings/watch-sync";

  app.get(base, async (_request, reply) => {
    reply.header("Cache-Control", "no-store");
    return getWatchSyncState(db);
  });
  app.put(base, async (request) => saveWatchSyncSettings(db, watchSyncSettingsSchema.parse(request.body)));
  app.post(`${base}/pause`, async (request) => setWatchSyncPaused(db, z.object({ paused: z.boolean() }).parse(request.body).paused));
  app.post(`${base}/reconcile`, async () => {
    const state = await getWatchSyncState(db);
    const pairIds = state.pairs.filter((pair) => pair.approvedAt && pair.enabled && !pair.paused).map((pair) => pair.id);
    if (!pairIds.length) return { jobId: null };
    return { jobId: await jobs.startWatchSync({ mode: "reconcile", pairIds }) };
  });
  app.get(`${base}/activity`, async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    const query = z.object({ pairId: z.coerce.number().int().positive().optional(), limit: z.coerce.number().int().min(1).max(1000).optional() }).parse(request.query);
    return { entries: await listWatchSyncActivity(db, query.pairId ?? null, query.limit) };
  });

  // Connections live in Settings > Media servers (/api/media-servers); watch sync only reads each server's users.
  app.post(`${base}/servers/:serverId/discover`, { config: remoteRateLimit }, async (request) => discoverWatchSyncUsers(db, serverId(request)));

  app.post(`${base}/pairs`, async (request) => createWatchSyncPair(db, request.body as never));
  app.put(`${base}/pairs/:pairId`, async (request) => updateWatchSyncPair(db, pairId(request), request.body as never));
  app.delete(`${base}/pairs/:pairId`, async (request) => removeWatchSyncPair(db, pairId(request)));
  app.post(`${base}/pairs/:pairId/preview`, async (request) => {
    const id = pairId(request);
    await watchSyncPairExists(db, id);
    return { jobId: await jobs.startWatchSync({ mode: "preview", pairIds: [id] }) };
  });
  app.post(`${base}/pairs/:pairId/approve`, async (request) => {
    const pair = await approveWatchSyncPair(db, pairId(request));
    return { jobId: await jobs.startWatchSync({ mode: "reconcile", pairIds: [pair.id] }) };
  });
  app.post(`${base}/pairs/:pairId/sync`, async (request) => {
    const id = pairId(request);
    await watchSyncPairExists(db, id);
    return { jobId: await jobs.startWatchSync({ mode: "reconcile", pairIds: [id] }) };
  });
  app.get(`${base}/pairs/:pairId/backup`, async (request, reply) => {
    const backup = await exportWatchSyncBackup(db, pairId(request));
    reply.header("Cache-Control", "no-store");
    reply.header("Content-Disposition", `attachment; filename="srtl-watch-state-${pairId(request)}.json"`);
    return backup;
  });
  app.post(`${base}/pairs/:pairId/restore`, { bodyLimit: 64 * 1024 * 1024 }, async (request) => {
    const id = pairId(request);
    await watchSyncPairExists(db, id);
    const body = z.object({ side: z.enum(["plex", "jellyfin"]), backup: watchSyncBackupSchema }).parse(request.body);
    const backupKey = `restore:${randomUUID()}`;
    await writeCursor(db, backupKey, JSON.stringify(body.backup));
    return { jobId: await jobs.startWatchSync({ mode: "restore", pairIds: [id], restore: { side: body.side, backupKey } }) };
  });
}
