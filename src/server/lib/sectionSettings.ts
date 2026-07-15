import { z } from "zod";
import { nowIso, normalizeSectionSettings, setSetting, type Db } from "../db/database";
import * as schema from "../db/schema";
import type { SectionSettings } from "../../shared/types";

export const sectionNameSchema = z
  .string()
  .trim()
  .min(1, "Symlink folder is required")
  .max(200, "Symlink folder must be 200 characters or fewer")
  .refine((value) => value !== "." && value !== ".." && !value.includes("/") && !value.includes("\\") && !value.includes("\0"), {
    message: "Symlink folder must be a direct folder name, not a path"
  });

export const sectionSettingsSchema = z.object({
  sections: z
    .array(sectionNameSchema)
    .min(1, "Add at least one symlink folder")
    .refine((sections) => new Set(sections.map((section) => section.trim())).size === sections.length, { message: "Symlink folders must be unique" }),
  sectionTitles: z.record(z.string(), z.string().trim().max(120, "Library title must be 120 characters or fewer")).optional(),
  sectionTypes: z.record(z.string(), z.enum(["shows", "movies", "other"])).optional()
});

export function parseSectionSettings(value: unknown): SectionSettings {
  return normalizeSectionSettings(sectionSettingsSchema.parse(value));
}

export async function persistSectionSettings(db: Db, settings: SectionSettings): Promise<void> {
  await setSetting(db, "sections", settings);
  const timestamp = nowIso();
  for (const section of settings.sections) {
    const displayName = settings.sectionTitles?.[section] ?? null;
    const contentType = settings.sectionTypes?.[section] ?? "other";
    await db
      .insert(schema.sections)
      .values({ name: section, displayName, contentType, createdAt: timestamp, updatedAt: timestamp })
      .onConflictDoUpdate({ target: schema.sections.name, set: { displayName, contentType, updatedAt: timestamp } });
  }
}
