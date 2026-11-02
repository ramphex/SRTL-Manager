// Instance settings shared by the Radarr and Sonarr integrations: stored connections, folder ownership,
// automatic mapping, and webhook authentication. Each integration keeps its own setting key and lock.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { arrInstanceLimit, type ArrCopyDefaults, type ArrPathMapping, type ArrRootConflict, type ArrSettings, type ArrSettingsInput } from "../../shared/arr";
import type { PathsSettings, SectionContentType, StoragePolicyKind } from "../../shared/types";
import { first, getJsonSetting, getSectionSettings, setSetting, type Db } from "../db/database";
import * as schema from "../db/schema";
import { withFilesystemTimeout } from "./filesystemSafety";
import { isMediaFile } from "./media";
import { canonicalTitleKey } from "./storagePolicies";

export const arrWebhookSecretSchema = z.string().min(24).max(256).regex(/^[A-Za-z0-9_-]+$/, "Webhook secret must use letters, numbers, hyphens, or underscores.");
const policyTagSchema = z.string().trim().regex(/^(?:[a-z0-9][a-z0-9-]{0,99})?$/, "Use a lowercase tag with letters, numbers, or hyphens.");
export const arrAbsolutePath = z.string().trim().min(1).max(4096).refine((value) => value.startsWith("/") && !/[\\\0]/.test(value) && path.posix.normalize(value) === value, "Use an absolute path without parent-directory segments.");

export interface ArrStoredSettings extends Omit<ArrSettingsInput, "apiKey" | "webhookSecret"> {
  id: string;
  name: string;
  apiKey: string;
  webhookSecretHash: string;
  lastRefreshAt: string | null;
  lastError: string | null;
  // Copy jobs up to this id predate the instance and never change its monitoring.
  copyJobFloor: number;
}

export interface ArrStoredInstances {
  instances: ArrStoredSettings[];
  legacyWebhookInstanceId: string | null;
}

export interface ArrStoreDefinition {
  name: string;
  settingKey: string;
  lock: number;
  sectionType: SectionContentType;
  sectionTypeLabel: string;
  error: (message: string) => Error;
  notFound: () => Error;
  normalizeUrl: (input: string) => string;
}

const defaultSettings: Omit<ArrStoredSettings, "id" | "name" | "copyJobFloor"> = { revision: 0, baseUrl: "", apiKey: "", webhookSecretHash: "", enabled: false, localTag: "", remoteTag: "", monitorOnCopy: false, mappingMode: "auto", mappings: [], lastRefreshAt: null, lastError: null };

export function arrDigest(value: string): string { return createHash("sha256").update(value).digest("hex"); }

export function sameArrMappings(left: ArrPathMapping[], right: ArrPathMapping[]): boolean {
  return left.length === right.length && left.every((mapping) => right.some((other) => mapping.rootPath === other.rootPath && mapping.section === other.section));
}

export function arrTagPolicy(tags: string[], config: Pick<ArrStoredSettings, "localTag" | "remoteTag">): StoragePolicyKind | "conflict" {
  const local = Boolean(config.localTag) && tags.includes(config.localTag);
  const remote = Boolean(config.remoteTag) && tags.includes(config.remoteTag);
  return local && remote ? "conflict" : local ? "location_1" : remote ? "location_2" : "unassigned";
}

export function arrPolicyTag(policy: StoragePolicyKind, config: Pick<ArrStoredSettings, "localTag" | "remoteTag">): string | null {
  return policy === "location_1" ? config.localTag : policy === "location_2" ? config.remoteTag : null;
}

export async function arrPolicyLookup(db: Db): Promise<Map<string, StoragePolicyKind>> {
  const policies = await db.select().from(schema.storagePolicies);
  const result = new Map<string, StoragePolicyKind>();
  for (const row of policies) {
    if (row.policy === "location_1" || row.policy === "location_2") result.set(canonicalTitleKey(row.title), row.policy);
  }
  return result;
}

// Re-assigning a policy refreshes its timestamp, so the marker also changes when the same policy is chosen again.
export async function arrPolicyMarkers(db: Db): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  for (const row of await db.select().from(schema.storagePolicies)) {
    if (row.policy === "location_1" || row.policy === "location_2") result.set(canonicalTitleKey(row.title), `${row.policy}@${row.updatedAt}`);
  }
  return result;
}

export function arrCurrentPolicy(row: { itemName: string | null }, policies: Map<string, StoragePolicyKind>): StoragePolicyKind {
  return row.itemName ? policies.get(canonicalTitleKey(row.itemName)) ?? "unassigned" : "unassigned";
}

export function arrRetryAt(attempts: number): string { return new Date(Date.now() + Math.min(300_000, 5000 * 2 ** Math.min(attempts, 6))).toISOString(); }

// A title's webhook events wait until it has been quiet for this long, but never longer than the maximum
// wait counted from its first pending event, so a long stream still gets scanned.
export const arrEventQuietMs = 10_000;
export const arrEventMaxWaitMs = 60_000;

// Groups the pending events by title and returns the groups ready to process: at least one event is due for
// an attempt and the title is either quiet or has waited the maximum time. Oldest groups come first.
export function arrReadyEventGroups<T extends { id: number; receivedAt: string; nextAttemptAt: string | null }>(events: readonly T[], titleOf: (event: T) => number, now = Date.now()): T[][] {
  const groups = new Map<number, T[]>();
  for (const event of events) groups.set(titleOf(event), [...(groups.get(titleOf(event)) ?? []), event]);
  const ready: T[][] = [];
  for (const group of groups.values()) {
    const received = group.map((event) => Date.parse(event.receivedAt));
    const due = group.some((event) => !event.nextAttemptAt || Date.parse(event.nextAttemptAt) <= now);
    if (due && (now - Math.max(...received) >= arrEventQuietMs || now - Math.min(...received) >= arrEventMaxWaitMs)) ready.push(group.sort((a, b) => a.id - b.id));
  }
  return ready.sort((a, b) => a[0]!.id - b[0]!.id);
}

// "Title refresh requested by Sonarr (10 events)" for a shared scan, the plain sentence for a single event.
export function arrRefreshMessage(instanceName: string, eventCount: number): string {
  return `Title refresh requested by ${instanceName}${eventCount > 1 ? ` (${eventCount} events)` : ""}`;
}

// Whether the title folder already holds media symlinks, so an "added" event for it is worth a rescan.
export async function arrTitleHasMediaSymlinks(symlinkDir: string, scope: { section: string; itemName: string }): Promise<boolean> {
  const walk = async (directory: string, depth: number): Promise<boolean> => {
    const entries = await withFilesystemTimeout(fs.readdir(directory, { withFileTypes: true }), "Title folder check").catch(() => []);
    if (entries.some((entry) => entry.isSymbolicLink() && isMediaFile(entry.name))) return true;
    if (depth >= 3) return false;
    for (const entry of entries) if (entry.isDirectory() && await walk(path.join(directory, entry.name), depth + 1)) return true;
    return false;
  };
  return symlinkDir ? walk(path.join(symlinkDir, scope.section, scope.itemName), 0) : false;
}

export async function arrMapLimit<T, R>(items: readonly T[], limit: number, action: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await action(items[index]!);
    }
  }));
  return results;
}

export function createArrInstanceStore(definition: ArrStoreDefinition) {
  const { name: service, settingKey, error } = definition;
  const instanceIdSchema = z.string().regex(/^[a-z0-9]{1,40}$/, `Unknown ${service} instance.`);
  const instanceNameSchema = z.string().trim().min(1, `Enter a name for this ${service} instance.`).max(60, "Use at most 60 characters for the instance name.").refine((value) => [...value].every((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127), "Instance names cannot contain control characters.");
  const settingsSchema = z.object({
    revision: z.number().int().nonnegative(),
    baseUrl: z.string().trim().min(1).max(2000).transform((value) => definition.normalizeUrl(value)),
    apiKey: z.string().trim().max(256).regex(/^[A-Za-z0-9]*$/).optional(),
    webhookSecret: z.union([z.literal(""), arrWebhookSecretSchema]).optional(),
    enabled: z.boolean(),
    localTag: policyTagSchema,
    remoteTag: policyTagSchema,
    monitorOnCopy: z.boolean().default(false),
    mappingMode: z.enum(["auto", "manual"]).default("manual"),
    mappings: z.array(z.object({ rootPath: arrAbsolutePath, section: z.string().min(1).max(200) })).max(50)
  }).refine((value) => !value.localTag || !value.remoteTag || value.localTag !== value.remoteTag, "Local and Remote tags must be different.")
    .refine((value) => !value.enabled || Boolean(value.localTag && value.remoteTag), "Choose both policy tags before enabling synchronization.")
    .refine((value) => new Set(value.mappings.map((mapping) => mapping.rootPath)).size === value.mappings.length && new Set(value.mappings.map((mapping) => mapping.section)).size === value.mappings.length, `Map each ${service} root and SRTL section only once.`);

  async function storedInstances(db: Db): Promise<ArrStoredInstances> {
    const saved = await getJsonSetting<Partial<ArrStoredInstances>>(db, settingKey, {});
    return {
      instances: (saved.instances ?? []).map((instance) => ({ ...instance, mappingMode: instance.mappingMode ?? "manual", monitorOnCopy: instance.monitorOnCopy ?? false, copyJobFloor: instance.copyJobFloor ?? 0 })),
      legacyWebhookInstanceId: saved.legacyWebhookInstanceId ?? null
    };
  }

  async function settings(db: Db, instanceId: string): Promise<ArrStoredSettings> {
    const config = (await storedInstances(db)).instances.find((instance) => instance.id === instanceId);
    if (!config) throw definition.notFound();
    return config;
  }

  // Callers hold the integration lock, so the list cannot change between this read and write.
  async function writeSettings(db: Db, config: ArrStoredSettings): Promise<void> {
    const stored = await storedInstances(db);
    await setSetting(db, settingKey, { ...stored, instances: stored.instances.map((instance) => instance.id === config.id ? config : instance) });
  }

  async function locked<T>(db: Db, action: (transaction: Db) => Promise<T>): Promise<T> {
    return db.transaction(async (transaction) => {
      await transaction.execute(sql`select pg_advisory_xact_lock(${definition.lock})`);
      return action(transaction);
    });
  }

  // Remote requests run outside transactions; results are committed only if the instance's settings did not change meanwhile.
  async function commitCurrent<T>(db: Db, config: Pick<ArrStoredSettings, "id" | "revision">, action: (transaction: Db, config: ArrStoredSettings) => Promise<T>): Promise<T | undefined> {
    return locked(db, async (transaction) => {
      const current = (await storedInstances(transaction)).instances.find((instance) => instance.id === config.id);
      return current?.revision === config.revision ? action(transaction, current) : undefined;
    });
  }

  // Each SRTL folder belongs to at most one instance.
  function sectionOwners(stored: ArrStoredInstances, exceptId: string): Map<string, ArrStoredSettings> {
    const owners = new Map<string, ArrStoredSettings>();
    for (const instance of stored.instances) {
      if (instance.id === exceptId) continue;
      for (const mapping of instance.mappings) owners.set(mapping.section, instance);
    }
    return owners;
  }

  function sectionOwner(stored: ArrStoredInstances, section: string): ArrStoredSettings | undefined {
    return stored.instances.find((config) => config.mappings.some((mapping) => mapping.section === section));
  }

  async function assertSectionsAvailable(db: Db, config: Pick<ArrStoredSettings, "id" | "mappings">): Promise<void> {
    const owners = sectionOwners(await storedInstances(db), config.id);
    const sections = await getSectionSettings(db);
    for (const mapping of config.mappings) {
      const owner = owners.get(mapping.section);
      if (owner) throw error(`The ${sections.sectionTitles?.[mapping.section] ?? mapping.section} folder is already mapped by ${owner.name}. Remove it from that instance first, or map a different folder.`);
    }
  }

  async function candidateSettings(db: Db, current: ArrStoredSettings, input: ArrSettingsInput): Promise<ArrStoredSettings> {
    const draft = settingsSchema.parse(input);
    if (draft.revision !== current.revision) throw error(`${service} settings changed. Reload before saving.`);
    if (draft.baseUrl !== current.baseUrl && !draft.apiKey) throw error(`Enter the API key when changing the ${service} address.`);
    const apiKey = draft.apiKey || current.apiKey;
    if (!apiKey) throw error(`Enter a ${service} API key.`);
    const sections = await getSectionSettings(db);
    if (draft.mappingMode === "manual") {
      for (const mapping of draft.mappings) {
        if (!sections.sections.includes(mapping.section) || sections.sectionTypes?.[mapping.section] !== definition.sectionType) {
          throw error(`${service} roots must map to configured ${definition.sectionTypeLabel} sections.`);
        }
      }
      await assertSectionsAvailable(db, { id: current.id, mappings: draft.mappings });
    }
    const webhookSecretHash = draft.webhookSecret ? arrDigest(draft.webhookSecret) : current.webhookSecretHash;
    return { ...current, baseUrl: draft.baseUrl, apiKey, webhookSecretHash, enabled: draft.enabled, localTag: draft.localTag, remoteTag: draft.remoteTag, monitorOnCopy: draft.monitorOnCopy, mappingMode: draft.mappingMode, mappings: draft.mappings, lastError: null };
  }

  // Matches full roots to sections of this integration's type under the symlink directory. Folders another instance maps are reported, never taken.
  async function automaticMappings(db: Db, instanceId: string, rootFolders: string[]): Promise<{ mappings: ArrPathMapping[]; conflicts: ArrRootConflict[] }> {
    const paths = await getJsonSetting<PathsSettings>(db, "paths", { symlinkDir: "", localDir: "", remoteDir: "" });
    const sections = await getSectionSettings(db);
    if (!arrAbsolutePath.safeParse(paths.symlinkDir).success) return { mappings: [], conflicts: [] };
    const roots = new Set(rootFolders.filter((root) => arrAbsolutePath.safeParse(root).success));
    const owners = sectionOwners(await storedInstances(db), instanceId);
    const matches = sections.sections.filter((section) => sections.sectionTypes?.[section] === definition.sectionType)
      .map((section) => ({ section, rootPath: path.posix.join(paths.symlinkDir, section) }))
      .filter((mapping) => roots.has(mapping.rootPath));
    return {
      mappings: matches.filter((mapping) => !owners.has(mapping.section)),
      conflicts: matches.flatMap((mapping) => {
        const owner = owners.get(mapping.section);
        return owner ? [{ ...mapping, instanceId: owner.id, instanceName: owner.name }] : [];
      })
    };
  }

  // A mapped section changed type or was removed, or automatic matches moved; either way the instance stops until reviewed.
  async function mappingProblem(db: Db, config: ArrStoredSettings): Promise<string | null> {
    const sections = await getSectionSettings(db);
    if (config.mappings.some((mapping) => !sections.sections.includes(mapping.section) || sections.sectionTypes?.[mapping.section] !== definition.sectionType)) {
      return `A mapped ${definition.sectionTypeLabel} section changed. Review the ${service} folder mappings.`;
    }
    if (config.mappingMode === "auto" && !sameArrMappings((await automaticMappings(db, config.id, config.mappings.map((mapping) => mapping.rootPath))).mappings, config.mappings)) {
      return `Automatic folder matches changed. Review and save the ${service} connection again.`;
    }
    return null;
  }

  function publicSettings(config: ArrStoredSettings, stored: ArrStoredInstances): ArrSettings {
    return { id: config.id, name: config.name, legacyWebhook: stored.legacyWebhookInstanceId === config.id, revision: config.revision, baseUrl: config.baseUrl, enabled: config.enabled, localTag: config.localTag, remoteTag: config.remoteTag, monitorOnCopy: config.monitorOnCopy, mappingMode: config.mappingMode, mappings: config.mappings, hasApiKey: Boolean(config.apiKey), hasWebhookSecret: Boolean(config.webhookSecretHash), lastRefreshAt: config.lastRefreshAt, lastError: config.lastError };
  }

  function assertNameAvailable(stored: ArrStoredInstances, name: string, exceptId: string | null): void {
    if (stored.instances.some((instance) => instance.id !== exceptId && instance.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
      throw error(`Another ${service} instance is already named ${name}. Choose a different name.`);
    }
  }

  async function createInstance(db: Db, name: string): Promise<string> {
    const created = await locked(db, async (transaction) => {
      const stored = await storedInstances(transaction);
      if (stored.instances.length >= arrInstanceLimit) throw error(`SRTL supports up to ${arrInstanceLimit} ${service} instances. Remove one before adding another.`);
      assertNameAvailable(stored, name, null);
      let id: string;
      do { id = randomBytes(6).toString("hex"); } while (stored.instances.some((instance) => instance.id === id));
      // Copies finished before the instance existed were never requested from it.
      const floor = await first(transaction.select({ id: sql<number>`coalesce(max(${schema.jobs.id}), 0)::int` }).from(schema.jobs));
      const instance: ArrStoredSettings = { ...defaultSettings, id, name, copyJobFloor: floor?.id ?? 0 };
      await setSetting(transaction, settingKey, { ...stored, instances: [...stored.instances, instance] });
      return instance;
    });
    return created.id;
  }

  async function renameInstance(db: Db, instanceId: string, name: string): Promise<void> {
    await locked(db, async (transaction) => {
      const stored = await storedInstances(transaction);
      const config = stored.instances.find((instance) => instance.id === instanceId);
      if (!config) throw definition.notFound();
      assertNameAvailable(stored, name, instanceId);
      await writeSettings(transaction, { ...config, name });
    });
  }

  // Forgets the instance's settings; the caller removes its rows in the same transaction.
  async function removeInstance(db: Db, instanceId: string, removeRows: (transaction: Db) => Promise<void>): Promise<void> {
    await locked(db, async (transaction) => {
      const stored = await storedInstances(transaction);
      if (!stored.instances.some((instance) => instance.id === instanceId)) throw definition.notFound();
      await removeRows(transaction);
      await setSetting(transaction, settingKey, {
        instances: stored.instances.filter((instance) => instance.id !== instanceId),
        legacyWebhookInstanceId: stored.legacyWebhookInstanceId === instanceId ? null : stored.legacyWebhookInstanceId
      });
    });
  }

  async function copyDefaults(db: Db): Promise<ArrCopyDefaults> {
    const { instances } = await storedInstances(db);
    return { sections: instances.filter((config) => config.enabled).flatMap((config) => config.mappings.map((mapping) => ({ section: mapping.section, instanceId: config.id, instanceName: config.name, monitorOnCopy: config.monitorOnCopy }))) };
  }

  // A null instance id is an original single-instance webhook URL, served by the instance migrated from it.
  async function webhookInstance(db: Db, instanceId: string | null): Promise<ArrStoredSettings | undefined> {
    const stored = await storedInstances(db);
    const id = instanceId ?? stored.legacyWebhookInstanceId;
    return id ? stored.instances.find((instance) => instance.id === id) : undefined;
  }

  async function authenticateWebhook(db: Db, instanceId: string | null, token: string | undefined): Promise<boolean> {
    const config = await webhookInstance(db, instanceId);
    if (!config?.webhookSecretHash || !token || !arrWebhookSecretSchema.safeParse(token).success) return false;
    const actual = Buffer.from(arrDigest(token), "hex");
    const expected = Buffer.from(config.webhookSecretHash, "hex");
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }

  return { instanceIdSchema, instanceNameSchema, settingsSchema, storedInstances, settings, writeSettings, locked, commitCurrent, sectionOwners, sectionOwner, assertSectionsAvailable, candidateSettings, automaticMappings, mappingProblem, publicSettings, createInstance, renameInstance, removeInstance, copyDefaults, webhookInstance, authenticateWebhook };
}
