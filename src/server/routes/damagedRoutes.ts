import type { FastifyInstance } from "fastify";
import type { Db } from "../db/database";
import { damagedFilesCsv, listDamagedFiles } from "../lib/damagedFiles";

export function registerDamagedRoutes(app: FastifyInstance, db: Db): void {
  app.get("/api/damaged-files", async () => listDamagedFiles(db));

  app.get("/api/damaged-files.csv", async (_request, reply) => {
    const csv = damagedFilesCsv(await listDamagedFiles(db));
    return reply
      .header("content-type", "text/csv; charset=utf-8")
      .header("content-disposition", `attachment; filename="srtl-damaged-files-${new Date().toISOString().slice(0, 10)}.csv"`)
      .send(csv);
  });
}
