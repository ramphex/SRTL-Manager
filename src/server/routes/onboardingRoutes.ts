import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Db } from "../db/database";
import { getOnboardingState, OnboardingConflictError, OnboardingInputError, startOnboarding } from "../lib/onboarding";
import { parseSectionSettings, sectionSettingsSchema } from "../lib/sectionSettings";
import { storageLocationNamesUpdateSchema } from "../lib/storageLocations";

const startOnboardingSchema = z.object({
  storageLocations: storageLocationNamesUpdateSchema,
  sections: sectionSettingsSchema,
  policyMode: z.enum(["match_current_locations", "leave_unassigned"])
}).strict();

export function registerOnboardingRoutes(app: FastifyInstance, db: Db): void {
  app.get("/api/onboarding", async () => getOnboardingState(db));

  app.post("/api/onboarding/start", async (request, reply) => {
    const body = startOnboardingSchema.parse(request.body);
    try {
      const jobId = await startOnboarding(db, {
        storageLocations: body.storageLocations,
        sections: parseSectionSettings(body.sections),
        policyMode: body.policyMode
      });
      return { jobId, state: await getOnboardingState(db) };
    } catch (error: unknown) {
      if (error instanceof OnboardingInputError) return reply.code(400).send({ error: error.message });
      if (error instanceof OnboardingConflictError) return reply.code(409).send({ error: error.message });
      throw error;
    }
  });
}
