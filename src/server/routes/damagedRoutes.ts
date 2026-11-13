import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Db } from "../db/database";
import { recordActionAudit } from "../lib/actionAudit";
import { damagedFilesCsv, listDamagedFiles } from "../lib/damagedFiles";
import type { JobRunner } from "../jobs/jobRunner";

export function registerDamagedRoutes(app: FastifyInstance, db: Db, jobs: JobRunner): void {
  app.get("/api/damaged-files", async () => listDamagedFiles(db));

  app.get("/api/damaged-files.csv", async (_request, reply) => {
    const csv = damagedFilesCsv(await listDamagedFiles(db));
    return reply
      .header("content-type", "text/csv; charset=utf-8")
      .header("content-disposition", `attachment; filename="srtl-damaged-files-${new Date().toISOString().slice(0, 10)}.csv"`)
      .send(csv);
  });

  app.post("/api/damaged-files/delete", { bodyLimit: 4 * 1024 * 1024 }, async (request) => {
    const body = z
      .object({
        storageFileIds: z.array(z.number().int().positive()).min(1, "Choose at least one damaged file to delete").max(50_000),
        mode: z.enum(["hold", "delete"]),
        reRequest: z.boolean().default(false),
        rescan: z.boolean().default(false)
      })
      .parse(request.body);
    const jobId = await jobs.startDamagedFilePurge(body.storageFileIds, body.mode, body.reRequest, body.rescan);
    await recordActionAudit(db, request, {
      action: body.mode === "delete" ? "damaged.delete" : "damaged.hold",
      summary: `${body.mode === "delete" ? "Deleted" : "Held"} ${body.storageFileIds.length} damaged file(s)${body.reRequest ? " and asked to re-request them" : ""}${body.rescan ? " and asked Radarr or Sonarr to rescan" : ""}`,
      jobId,
      targets: { jobId, mode: body.mode, reRequest: body.reRequest, rescan: body.rescan, storageFileIds: body.storageFileIds }
    });
    return { jobId };
  });
}
