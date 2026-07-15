import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { getJsonSetting, getSectionSettings, setSetting, type Db } from "../db/database";
import { parseSectionSettings, persistSectionSettings } from "../lib/sectionSettings";
import {
  getStorageLocationsSettings,
  persistStorageLocationNames,
  storageLocationNamesUpdateSchema
} from "../lib/storageLocations";
import { defaultAuditJobBehaviorSettings, defaultCopyJobBehaviorSettings, normalizeAdvancedSettings } from "../../shared/advancedSettings";
import type {
  AdvancedSettings,
  AuditSettings,
  PathsSettings,
  ScanOptions,
  SectionSettings,
  StorageLocationNamesUpdate,
  UserPreferences
} from "../../shared/types";

const scanSettingsSchema = z.object({
  scanSymlinks: z.boolean().default(true),
  scanLocal: z.boolean().default(false),
  scanRemote: z.boolean().default(false),
  symlinkSections: z.array(z.string().trim().min(1).max(200)).optional(),
  localSections: z.array(z.string().trim().min(1).max(200)).optional(),
  sections: z.array(z.string().trim().min(1).max(200)).optional()
});

const auditSettingsSchema = z.object({
  sections: z.array(z.string().trim().min(1).max(200)).optional(),
  targets: z.array(z.enum(["local", "remote"])).optional()
});

const advancedSettingsSchema = z.object({
  copy: z
    .object({
      profile: z.enum(["off", "fast", "balanced", "deep", "custom"]).default("balanced"),
      byteCompare: z.boolean().default(true),
      mediaValidation: z.enum(["off", "fast", "deep"]).default("fast")
    })
    .default(defaultCopyJobBehaviorSettings)
    .refine((copy) => copy.profile !== "custom" || copy.byteCompare || copy.mediaValidation !== "off", {
      message: "Custom copy verification must keep byte compare or media validation enabled"
    }),
  audit: z
    .object({
      defaultMode: z.enum(["fast", "deep"]).default("fast"),
      byteCompareWhenSourceKnown: z.boolean().default(true)
    })
    .default(defaultAuditJobBehaviorSettings)
});

const userPreferencesSchema = z.object({
  timeFormat: z.enum(["12h", "24h"]).default("12h"),
  autoOpenTaskStatus: z.boolean().default(false),
  recentJobsCompletedWindowMinutes: z.union([z.literal(15), z.literal(60), z.literal(360), z.literal(1440), z.literal(10080)]).default(1440)
});

function normalizeSettingsSections(selectedSections: string[] | undefined, configuredSections: string[]): string[] {
  const configured = new Set(configuredSections);
  const requestedSections = selectedSections ?? configuredSections;
  return [...new Set(requestedSections)].filter((section) => configured.has(section));
}

function normalizeScanSettings(value: unknown, configuredSections: string[]): ScanOptions {
  const parsed = scanSettingsSchema.safeParse(value ?? {});
  const settings = parsed.success ? parsed.data : scanSettingsSchema.parse({});
  const legacySections = settings.sections ? normalizeSettingsSections(settings.sections, configuredSections) : undefined;
  return {
    scanSymlinks: settings.scanSymlinks,
    scanLocal: settings.scanLocal,
    scanRemote: settings.scanRemote,
    symlinkSections: normalizeSettingsSections(settings.symlinkSections ?? legacySections, configuredSections),
    localSections: normalizeSettingsSections(settings.localSections ?? legacySections, configuredSections)
  };
}

function normalizeAuditSettings(value: unknown, configuredSections: string[]): AuditSettings {
  const parsed = auditSettingsSchema.safeParse(value ?? {});
  const settings = parsed.success ? parsed.data : auditSettingsSchema.parse({});
  const targets = [...new Set(settings.targets ?? ["local", "remote"])].filter((target): target is AuditSettings["targets"][number] => target === "local" || target === "remote");
  return {
    sections: normalizeSettingsSections(settings.sections, configuredSections),
    targets
  };
}

function normalizeUserPreferences(value: unknown): UserPreferences {
  const parsed = userPreferencesSchema.safeParse(value ?? {});
  return parsed.success ? parsed.data : userPreferencesSchema.parse({});
}

export function registerSettingsRoutes(app: FastifyInstance, db: Db): void {
  app.get("/api/settings/paths", async () => getJsonSetting<PathsSettings>(db, "paths", { symlinkDir: "", localDir: "", remoteDir: "" }));

  app.get("/api/settings/storage-locations", async () => getStorageLocationsSettings(db));

  app.put("/api/settings/storage-locations", async (request) => {
    const body: StorageLocationNamesUpdate = storageLocationNamesUpdateSchema.parse(request.body ?? {});
    await persistStorageLocationNames(db, body);
    return getStorageLocationsSettings(db);
  });

  app.get("/api/settings/sections", async () => getSectionSettings(db));

  app.put("/api/settings/sections", async (request) => {
    const body: SectionSettings = parseSectionSettings(request.body);
    await persistSectionSettings(db, body);
    return body;
  });

  app.get("/api/settings/scan", async () => {
    const configuredSections = (await getSectionSettings(db)).sections;
    return normalizeScanSettings(await getJsonSetting<unknown>(db, "scanSettings", {}), configuredSections);
  });

  app.put("/api/settings/scan", async (request) => {
    const configuredSections = (await getSectionSettings(db)).sections;
    const body = normalizeScanSettings(scanSettingsSchema.parse(request.body ?? {}), configuredSections);
    await setSetting(db, "scanSettings", body);
    return body;
  });

  app.get("/api/settings/audit", async () => {
    const configuredSections = (await getSectionSettings(db)).sections;
    return normalizeAuditSettings(await getJsonSetting<unknown>(db, "auditSettings", {}), configuredSections);
  });

  app.put("/api/settings/audit", async (request) => {
    const configuredSections = (await getSectionSettings(db)).sections;
    const body = normalizeAuditSettings(auditSettingsSchema.parse(request.body ?? {}), configuredSections);
    await setSetting(db, "auditSettings", body);
    return body;
  });

  app.get("/api/settings/advanced", async () => normalizeAdvancedSettings(await getJsonSetting<unknown>(db, "advancedSettings", {})));

  app.put("/api/settings/advanced", async (request) => {
    const body: AdvancedSettings = normalizeAdvancedSettings(advancedSettingsSchema.parse(request.body ?? {}));
    await setSetting(db, "advancedSettings", body);
    return body;
  });

  app.get("/api/settings/user-preferences", async () => normalizeUserPreferences(await getJsonSetting<unknown>(db, "userPreferences", {})));

  app.put("/api/settings/user-preferences", async (request) => {
    const body = normalizeUserPreferences(userPreferencesSchema.parse(request.body ?? {}));
    await setSetting(db, "userPreferences", body);
    return body;
  });

  app.get("/api/settings/integrations", async () => []);

  app.put("/api/settings/integrations", async (_request, reply) =>
    reply.code(501).send({ error: "External integrations are not available in this release" })
  );
}
