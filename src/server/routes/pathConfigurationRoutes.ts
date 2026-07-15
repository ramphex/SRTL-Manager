import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { Db } from "../db/database";
import type { JobRunner } from "../jobs/jobRunner";
import { getPathConfigurationState, planPathMigration } from "../lib/pathConfiguration";
import type { PathsSettings } from "../../shared/types";

const migrationInputSchema = z.object({ migrationId: z.coerce.number().int().positive() });
const applyInputSchema = migrationInputSchema.extend({ confirmSameStorage: z.literal(true, { error: "Confirm that the detected paths expose the same storage before continuing" }) });

export function registerPathConfigurationRoutes(app: FastifyInstance, db: Db, jobs: JobRunner, environmentPaths: PathsSettings): void {
  app.get("/api/system/path-migration", async () => getPathConfigurationState(db, environmentPaths));

  app.post("/api/system/path-migration/plan", async (request, reply) => {
    const body = migrationInputSchema.parse(request.body ?? {});
    try {
      await planPathMigration(db, body.migrationId);
      return getPathConfigurationState(db, environmentPaths);
    } catch (error: unknown) {
      return reply.code(409).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/system/path-migration/apply", async (request, reply) => {
    const body = applyInputSchema.parse(request.body ?? {});
    try {
      return { jobId: await jobs.startPathMigration(body.migrationId) };
    } catch (error: unknown) {
      return reply.code(409).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });
}
