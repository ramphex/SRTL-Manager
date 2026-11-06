import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { Db } from "../db/database";
import type { JobRunner } from "../jobs/jobRunner";
import { getPathConfigurationState, planPathMigration } from "../lib/pathConfiguration";
import { emptyPaths, isRestrictedRequest } from "../lib/restrictedView";
import type { PathsSettings } from "../../shared/types";

const migrationInputSchema = z.object({ migrationId: z.coerce.number().int().positive() });
const applyInputSchema = migrationInputSchema.extend({ confirmSameStorage: z.literal(true, { error: "Confirm that the detected paths expose the same storage before continuing" }) });

export function registerPathConfigurationRoutes(app: FastifyInstance, db: Db, jobs: JobRunner, environmentPaths: PathsSettings): void {
  app.get("/api/system/path-migration", async (request) => {
    const state = await getPathConfigurationState(db, environmentPaths);
    // Whether the app is waiting on a path change, and nothing about the paths.
    return isRestrictedRequest(request) ? { status: state.status, blocking: state.blocking, activePaths: null, detectedPaths: emptyPaths, environmentErrors: [], changes: [], migration: null } : state;
  });

  app.post("/api/system/path-migration/plan", async (request) => {
    const body = migrationInputSchema.parse(request.body ?? {});
    await planPathMigration(db, body.migrationId);
    return getPathConfigurationState(db, environmentPaths);
  });

  app.post("/api/system/path-migration/apply", async (request) => {
    const body = applyInputSchema.parse(request.body ?? {});
    return { jobId: await jobs.startPathMigration(body.migrationId) };
  });
}
