import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { normalizeAdvancedSettings } from "../../shared/advancedSettings";
import type { PathsSettings } from "../../shared/types";
import { getJsonSetting, type Db } from "../db/database";
import type { JobRunner } from "../jobs/jobRunner";
import { listHeldOrphans, listOrphanReview, restoreHeldOrphans } from "../jobs/orphanPurge";

const rootTypeSchema = z.enum(["local", "remote"]);

export function registerOrphanRoutes(app: FastifyInstance, db: Db, jobs: JobRunner): void {
  app.get("/api/orphans", async (request) => {
    const query = z.object({ rootType: rootTypeSchema }).parse(request.query);
    const settings = normalizeAdvancedSettings(await getJsonSetting<unknown>(db, "advancedSettings", {}));
    return listOrphanReview(db, query.rootType, settings.cleanup.holdDays);
  });

  app.post("/api/orphans/purge", { bodyLimit: 4 * 1024 * 1024 }, async (request, reply) => {
    const body = z
      .object({
        rootType: rootTypeSchema,
        storageFileIds: z.array(z.number().int().positive()).max(50_000).default([]),
        folderIds: z.array(z.number().int().positive()).max(50_000).default([]),
        mode: z.enum(["hold", "delete"])
      })
      .refine((value) => value.storageFileIds.length + value.folderIds.length > 0, { message: "Choose at least one orphan file or folder to purge" })
      .parse(request.body);
    try {
      return { jobId: await jobs.startOrphanPurge(body.rootType, body.storageFileIds, body.mode, body.folderIds) };
    } catch (error: unknown) {
      request.log.warn({ err: error }, "Orphan purge admission rejected");
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get("/api/orphans/held", async () => listHeldOrphans(db));

  app.post("/api/orphans/held/restore", async (request) => {
    const body = z.object({ operationIds: z.array(z.number().int().positive()).min(1).max(5_000) }).parse(request.body);
    const paths = await getJsonSetting<PathsSettings>(db, "paths", { symlinkDir: "", localDir: "", remoteDir: "" });
    return restoreHeldOrphans(db, paths, [...new Set(body.operationIds)]);
  });
}
