import { z } from "zod";
import { getJsonSetting, setSetting, type Db } from "../db/database";
import type {
  PathsSettings,
  StorageLocationKey,
  StorageLocationNamesUpdate,
  StorageLocationsSettings
} from "../../shared/types";

export const storageLocationDefinitions = [
  { key: "location_1", rootType: "local" },
  { key: "location_2", rootType: "remote" }
] as const;

export const defaultStorageLocationNames: Record<StorageLocationKey, string> = {
  location_1: "Local",
  location_2: "Remote"
};

const storageLocationDisplayNameSchema = z.string().trim().min(1, "Friendly name is required").max(40, "Friendly name must be 40 characters or fewer");

const storedStorageLocationNamesSchema = z
  .object({
    location_1: storageLocationDisplayNameSchema,
    location_2: storageLocationDisplayNameSchema
  })
  .strict()
  .refine((names) => names.location_1.localeCompare(names.location_2, undefined, { sensitivity: "accent" }) !== 0, {
    message: "Friendly names must be unique"
  });

export const storageLocationNamesUpdateSchema = z
  .object({
    locations: z
      .array(
        z
          .object({
            key: z.enum(["location_1", "location_2"]),
            displayName: storageLocationDisplayNameSchema
          })
          .strict()
      )
      .length(storageLocationDefinitions.length, "Every configured location must have a friendly name")
  })
  .strict()
  .superRefine((value, context) => {
    const keys = new Set(value.locations.map((location) => location.key));
    for (const definition of storageLocationDefinitions) {
      if (!keys.has(definition.key)) {
        context.addIssue({ code: "custom", message: `Missing friendly name for ${definition.key}`, path: ["locations"] });
      }
    }
    const normalizedNames = value.locations.map((location) => location.displayName.toLocaleLowerCase());
    if (new Set(normalizedNames).size !== normalizedNames.length) {
      context.addIssue({ code: "custom", message: "Friendly names must be unique", path: ["locations"] });
    }
  });

export function storageLocationNamesFromUpdate(value: StorageLocationNamesUpdate): Record<StorageLocationKey, string> {
  const parsed = storageLocationNamesUpdateSchema.parse(value);
  return storedStorageLocationNamesSchema.parse(
    Object.fromEntries(parsed.locations.map((location) => [location.key, location.displayName]))
  );
}

function normalizeStorageLocationNames(value: unknown): Record<StorageLocationKey, string> {
  const parsed = storedStorageLocationNamesSchema.safeParse(value);
  return parsed.success ? parsed.data : defaultStorageLocationNames;
}

export async function getStorageLocationsSettings(db: Db): Promise<StorageLocationsSettings> {
  const [paths, storedNames] = await Promise.all([
    getJsonSetting<PathsSettings>(db, "paths", { symlinkDir: "", localDir: "", remoteDir: "" }),
    getJsonSetting<unknown>(db, "storageLocationNames", defaultStorageLocationNames)
  ]);
  const names = normalizeStorageLocationNames(storedNames);
  return {
    locations: storageLocationDefinitions.map((definition) => ({
      key: definition.key,
      rootType: definition.rootType,
      displayName: names[definition.key],
      path: definition.rootType === "local" ? paths.localDir : paths.remoteDir
    }))
  };
}

export async function persistStorageLocationNames(db: Db, value: StorageLocationNamesUpdate): Promise<void> {
  await setSetting(db, "storageLocationNames", storageLocationNamesFromUpdate(value));
}
