import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { normalizeAdvancedSettings } from "../../shared/advancedSettings";
import type { PathsSettings } from "../../shared/types";
import { getJsonSetting, type Db } from "../db/database";
import { recordActionAudit } from "../lib/actionAudit";
import type { JobRunner } from "../jobs/jobRunner";
import { listHeldOrphans, listOrphanReview, restoreHeldOrphans } from "../jobs/orphanPurge";

const rootTypeSchema = z.enum(["local", "remote"]);

export function registerOrphanRoutes(app: FastifyInstance, db: Db, jobs: JobRunner): void {
  app.get("/api/orphans", async (request) => {
    const query = z.object({ rootType: rootTypeSchema }).parse(request.query);
    const settings = normalizeAdvancedSettings(await getJsonSetting<unknown>(db, "advancedSettings", {}));
    return listOrphanReview(db, query.rootType, settings.cleanup.holdDays);
  });

  app.post("/api/orphans/purge", { bodyLimit: 4 * 1024 * 1024 }, async (request) => {
    const body = z
      .object({
        rootType: rootTypeSchema,
        storageFileIds: z.array(z.number().int().positive()).max(50_000).default([]),
        folderIds: z.array(z.number().int().positive()).max(50_000).default([]),
        mode: z.enum(["hold", "delete"]),
        reRequest: z.boolean().default(false)
      })
      .refine((value) => value.storageFileIds.length + value.folderIds.length > 0, { message: "Choose at least one orphan file or folder to purge" })
      .parse(request.body);
    const jobId = await jobs.startOrphanPurge(body.rootType, body.storageFileIds, body.mode, body.folderIds, body.reRequest);
    await recordActionAudit(db, request, {
      action: body.mode === "delete" ? "orphan.purge_delete" : "orphan.purge_hold",
      summary: `${body.mode === "delete" ? "Deleted" : "Held"} ${body.storageFileIds.length} orphan file(s) and ${body.folderIds.length} folder(s) on ${body.rootType} storage${body.reRequest ? " and asked to re-request them" : ""}`,
      jobId,
      targets: { jobId, rootType: body.rootType, mode: body.mode, reRequest: body.reRequest, storageFileIds: body.storageFileIds, folderIds: body.folderIds }
    });
    return { jobId };
  });

  app.get("/api/orphans/held", async () => listHeldOrphans(db));

  app.post("/api/orphans/held/restore", async (request) => {
    const body = z.object({ operationIds: z.array(z.number().int().positive()).min(1).max(5_000) }).parse(request.body);
    const paths = await getJsonSetting<PathsSettings>(db, "paths", { symlinkDir: "", localDir: "", remoteDir: "" });
    return restoreHeldOrphans(db, paths, [...new Set(body.operationIds)], (error, operationId) => request.log.warn({ err: error, operationId }, "Held file restore failed"));
  });
}
