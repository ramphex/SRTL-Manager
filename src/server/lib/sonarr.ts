import fs from "node:fs/promises";
import path from "node:path";
import { and, asc, desc, eq, inArray, isNull, lte, sql } from "drizzle-orm";
import { z } from "zod";
import { sonarrInstanceLimit, type SonarrConnectionTest, type SonarrCopyDefaults, type SonarrOverview, type SonarrSeriesStatus, type SonarrSettingsInput, type SonarrState } from "../../shared/sonarr";
import type { CopyOptions, JobStatus, MediaLinkRow, PathsSettings, ScanTitleScope, StoragePolicyKind, StoragePolicyTarget } from "../../shared/types";
import { dbAll, first, getJsonSetting, nowIso, type Db } from "../db/database";
import * as schema from "../db/schema";
import { JobRunner } from "../jobs/jobRunner";
import { storagePolicyMutationResources, withResourceMutationGuard } from "../jobs/resourceMutationGuard";
import { arrAbsolutePath, arrCurrentPolicy, arrDigest, arrMapLimit, arrPolicyLookup, arrPolicyMarkers, arrPolicyTag, arrReadyEventGroups, arrRefreshMessage, arrRetryAt, arrTitleHasMediaSymlinks, arrTagPolicy, createArrInstanceStore, sameArrMappings, type ArrStoredSettings } from "./arrInstances";
import { assertPathParentInside, withFilesystemTimeout } from "./filesystemSafety";
import type { MediaExpectation } from "./mediaIntegrity";
import { isOnboardingComplete } from "./onboarding";
import { isPathConfigurationBlocked } from "./pathConfiguration";
import { SonarrClient, SonarrError, normalizeSonarrUrl, type SonarrEpisode, type SonarrEpisodeFile, type SonarrSeries } from "./sonarrClient";
import { setStoragePolicies, storagePolicyKey } from "./storagePolicies";
import { secretPurposes } from "./secretBox";

const tagSyncBatchSize = 50;
// Episodes changed per pass, and per Sonarr request.
const monitorBatchSize = 500;
const monitorRequestSize = 200;
const resolveSeriesBatchSize = 20;
const resolveFileBatchSize = 2000;
// Series handled per pass; each takes all of its pending events at once.
const eventBatchSize = 10;
const pendingEventLimit = 2000;
const catalogRefreshIntervalMs = 30 * 60_000;
const historyRetentionMs = 30 * 86400_000;
const expectationCacheMs = 60_000;
const tagsSchema = z.array(z.string());

type StoredSettings = ArrStoredSettings;
type SeriesRow = typeof schema.sonarrSeries.$inferSelect;

interface Catalog {
  series: SonarrSeries[];
  tags: Array<{ id: number; label: string }>;
}

class SonarrInstanceNotFound extends SonarrError {
  override readonly statusCode = 404;
  constructor() { super("This Sonarr instance no longer exists. Reload the integration settings."); }
}

const store = createArrInstanceStore({ name: "Sonarr", settingKey: "sonarrInstances", lock: 781_889_452, sectionType: "shows", sectionTypeLabel: "Shows", error: (message) => new SonarrError(message), notFound: () => new SonarrInstanceNotFound(), normalizeUrl: normalizeSonarrUrl, apiKeyPurpose: secretPurposes.sonarrApiKey });
export const sonarrStoredInstances = store.storedInstances;
const { storedInstances, settings, writeSettings, locked, commitCurrent, candidateSettings, automaticMappings, assertSectionsAvailable, publicSettings, sectionOwner, webhookInstance } = store;
export const sonarrInstanceIdSchema = store.instanceIdSchema;
export const sonarrInstanceNameSchema = store.instanceNameSchema;
export const sonarrSettingsSchema = store.settingsSchema;
export const sonarrTagPolicy = arrTagPolicy;

const forInstance = (config: Pick<StoredSettings, "id">) => eq(schema.sonarrSeries.instanceId, config.id);

function seriesIdsIn(config: Pick<StoredSettings, "id">, seriesIds: number[]) {
  return and(forInstance(config), inArray(schema.sonarrSeries.seriesId, seriesIds));
}

export function sonarrClient(config: StoredSettings): SonarrClient {
  if (!config.apiKey || !config.baseUrl) throw new SonarrError("Save a Sonarr connection first.");
  return new SonarrClient(config.baseUrl, config.apiKey);
}

function parseTags(value: string): string[] { return tagsSchema.parse(JSON.parse(value)); }
function seriesTitle(series: Pick<SonarrSeries, "title" | "year">): string { return series.year ? `${series.title} (${series.year})` : series.title; }
export function sonarrEpisodeLabel(episode: Pick<SonarrEpisode, "seasonNumber" | "episodeNumber">): string {
  return `S${String(episode.seasonNumber).padStart(2, "0")}E${String(episode.episodeNumber).padStart(2, "0")}`;
}
const normalizedRelative = (value: string) => value.replace(/\\/g, "/").split("/").filter(Boolean).join("/");

// SRTL link paths start with the title folder; Sonarr's episode file paths are relative to the series folder.
function seriesRelativePath(link: Pick<MediaLinkRow, "itemName" | "relativePath">): string | null {
  const parts = normalizedRelative(link.relativePath).split("/");
  return parts.length > 1 && parts[0] === link.itemName ? parts.slice(1).join("/") : null;
}

async function inspectConnection(db: Db, config: StoredSettings): Promise<SonarrConnectionTest> {
  const connection = await sonarrClient(config).test();
  const { mappings, conflicts } = await automaticMappings(db, config.id, connection.rootFolders);
  const matched = new Set([...mappings, ...conflicts].map((mapping) => mapping.rootPath));
  return { ...connection, automaticMappings: mappings, unmatchedRootFolders: connection.rootFolders.filter((root) => !matched.has(root)), conflictingRootFolders: conflicts };
}

export async function testSonarrConnection(db: Db, instanceId: string, input: SonarrSettingsInput): Promise<SonarrConnectionTest> {
  return inspectConnection(db, await candidateSettings(db, await settings(db, instanceId), input));
}

// A series belongs to SRTL only when its folder sits directly under a mapped root.
export function mapSonarrSeries(series: Pick<SonarrSeries, "path" | "tvdbId">, config: Pick<StoredSettings, "mappings">): ScanTitleScope | null {
  if (!arrAbsolutePath.safeParse(series.path).success) return null;
  const mapping = config.mappings.find((entry) => path.posix.dirname(series.path) === entry.rootPath);
  const itemName = path.posix.basename(series.path);
  if (!mapping || !itemName || itemName === "." || itemName === "..") return null;
  const tvdb = itemName.match(/\{tvdb-(\d+)\}/i);
  if (tvdb && Number(tvdb[1]) !== series.tvdbId) return null;
  return { section: mapping.section, itemName };
}

async function storeSeries(db: Db, list: SonarrSeries[], tags: Catalog["tags"], config: StoredSettings): Promise<void> {
  const tagLabels = new Map(tags.map((tag) => [tag.id, tag.label]));
  const paths = new Map<string, number>();
  for (const series of list) paths.set(series.path, (paths.get(series.path) ?? 0) + 1);
  const sameIdentity = sql`sonarr_series.tvdb_id = excluded.tvdb_id AND sonarr_series.section IS NOT DISTINCT FROM excluded.section AND sonarr_series.item_name IS NOT DISTINCT FROM excluded.item_name`;
  for (let offset = 0; offset < list.length; offset += 100) {
    const values = list.slice(offset, offset + 100).map((series) => {
      const scope = paths.get(series.path) === 1 ? mapSonarrSeries(series, config) : null;
      return { instanceId: config.id, seriesId: series.id, tvdbId: series.tvdbId, title: seriesTitle(series), folderPath: series.path, section: scope?.section ?? null, itemName: scope?.itemName ?? null, tags: JSON.stringify(series.tags.map((id) => tagLabels.get(id)).filter((label): label is string => Boolean(label))), monitored: series.monitored ?? null };
    });
    await db.insert(schema.sonarrSeries).values(values).onConflictDoUpdate({ target: [schema.sonarrSeries.instanceId, schema.sonarrSeries.seriesId], set: {
      title: sql`excluded.title`, folderPath: sql`excluded.folder_path`, section: sql`excluded.section`, itemName: sql`excluded.item_name`, tags: sql`excluded.tags`, tvdbId: sql`excluded.tvdb_id`, monitored: sql`excluded.monitored`,
      managed: sql`sonarr_series.managed AND ${sameIdentity}`,
      observedPolicyMarker: sql`CASE WHEN ${sameIdentity} THEN sonarr_series.observed_policy_marker ELSE NULL END`,
      syncedPolicy: sql`CASE WHEN sonarr_series.tags = excluded.tags AND sonarr_series.tvdb_id = excluded.tvdb_id AND sonarr_series.folder_path = excluded.folder_path THEN sonarr_series.synced_policy ELSE NULL END`
    } });
  }
}

async function fetchCatalog(config: StoredSettings): Promise<Catalog> {
  const connection = sonarrClient(config);
  const series = await connection.series();
  return { series, tags: await connection.tags() };
}

async function applyCatalog(db: Db, catalog: Catalog, config: StoredSettings): Promise<void> {
  await storeSeries(db, catalog.series, catalog.tags, config);
  const ids = catalog.series.map((series) => series.id);
  await db.delete(schema.sonarrSeries).where(and(forInstance(config), ids.length ? sql`series_id NOT IN (SELECT jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb)::integer)` : sql`true`));
}

async function refreshCatalog(db: Db, config: StoredSettings, resetRetries: boolean): Promise<void> {
  let catalog: Catalog;
  try {
    catalog = await fetchCatalog(config);
  } catch (error) {
    if (!(error instanceof SonarrError)) throw error;
    await commitCurrent(db, config, (transaction, current) => writeSettings(transaction, { ...current, lastError: error.message }));
    return;
  }
  await commitCurrent(db, config, async (transaction, current) => {
    await applyCatalog(transaction, catalog, current);
    if (resetRetries) await transaction.update(schema.sonarrSeries).set({ nextAttemptAt: null, attempts: 0 }).where(forInstance(current));
    await writeSettings(transaction, { ...current, lastRefreshAt: nowIso(), lastError: null });
  });
}

export async function getSonarrOverview(db: Db): Promise<SonarrOverview> {
  const stored = await storedInstances(db);
  const counts = await dbAll<{ instance_id: string; series: number; mapped: number; review: number; errors: number }>(db, sql`
    select instance_id, count(*)::int as series,
      count(*) filter (where section is not null and item_name is not null)::int as mapped,
      count(*) filter (where section is not null and item_name is not null and not managed)::int as review,
      count(*) filter (where section is not null and item_name is not null and managed and last_error is not null)::int as errors
    from sonarr_series group by instance_id`);
  return {
    limit: sonarrInstanceLimit,
    instances: stored.instances.map((config) => {
      const count = counts.find((row) => row.instance_id === config.id);
      return { settings: publicSettings(config, stored), series: count?.series ?? 0, mapped: count?.mapped ?? 0, review: count?.review ?? 0, errors: count?.errors ?? 0 };
    })
  };
}

export async function createSonarrInstance(db: Db, name: string): Promise<SonarrState> {
  return getSonarrState(db, await store.createInstance(db, name));
}

export async function renameSonarrInstance(db: Db, instanceId: string, name: string): Promise<SonarrOverview> {
  await store.renameInstance(db, instanceId, name);
  return getSonarrOverview(db);
}

async function forgetInstanceWork(transaction: Db, instanceId: string): Promise<void> {
  await transaction.delete(schema.sonarrEvents).where(eq(schema.sonarrEvents.instanceId, instanceId));
  await transaction.delete(schema.sonarrMonitorUpdates).where(eq(schema.sonarrMonitorUpdates.instanceId, instanceId));
  await transaction.delete(schema.sonarrCopiedFiles).where(eq(schema.sonarrCopiedFiles.instanceId, instanceId));
}

// Removal forgets SRTL's own records only. Tags and monitoring in Sonarr stay as they are.
export async function removeSonarrInstance(db: Db, instanceId: string): Promise<SonarrOverview> {
  await store.removeInstance(db, instanceId, async (transaction) => {
    await transaction.delete(schema.sonarrSeries).where(eq(schema.sonarrSeries.instanceId, instanceId));
    await forgetInstanceWork(transaction, instanceId);
    await transaction.delete(schema.sonarrCopyJobs).where(eq(schema.sonarrCopyJobs.instanceId, instanceId));
  });
  return getSonarrOverview(db);
}

export async function saveSonarrSettings(db: Db, instanceId: string, input: SonarrSettingsInput): Promise<SonarrState> {
  const old = await settings(db, instanceId);
  const next = await candidateSettings(db, old, input);
  const sameConnection = old.baseUrl === next.baseUrl && old.localTag === next.localTag && old.remoteTag === next.remoteTag && old.mappingMode === next.mappingMode && sameArrMappings(old.mappings, next.mappings) && old.apiKey === next.apiKey && old.webhookSecretHash === next.webhookSecretHash;
  // Pausing must still work if Sonarr is offline, without accepting new mappings.
  if (sameConnection && !next.enabled && (old.enabled || next.mappingMode === "manual")) {
    const saved = await commitCurrent(db, next, async (transaction, current) => {
      await writeSettings(transaction, { ...next, name: current.name, revision: next.revision + 1 });
      return true;
    });
    if (!saved) throw new SonarrError("Sonarr settings changed. Reload before saving.");
    return getSonarrState(db, instanceId);
  }
  const connection = await inspectConnection(db, next);
  if (next.mappingMode === "auto") next.mappings = connection.automaticMappings;
  if (next.enabled && !next.mappings.length) throw new SonarrError(next.mappingMode === "auto" ? "No exact folder matches found. Use Manual mapping before enabling Sonarr." : "Add a folder mapping before enabling Sonarr.");
  const catalog = await fetchCatalog(next);
  const saved = await commitCurrent(db, next, async (transaction, current) => {
    // Another instance may have claimed a folder while Sonarr was being read.
    await assertSectionsAvailable(transaction, next);
    const identityChanged = current.baseUrl !== next.baseUrl || current.localTag !== next.localTag || current.remoteTag !== next.remoteTag || !sameArrMappings(current.mappings, next.mappings);
    if (identityChanged) {
      if (current.baseUrl !== next.baseUrl) {
        await transaction.delete(schema.sonarrSeries).where(forInstance(current));
        await forgetInstanceWork(transaction, current.id);
      } else {
        await transaction.update(schema.sonarrSeries).set({ managed: false, syncedPolicy: null, observedPolicyMarker: null }).where(forInstance(current));
      }
    }
    next.revision += 1;
    await applyCatalog(transaction, catalog, next);
    await writeSettings(transaction, { ...next, name: current.name, lastRefreshAt: nowIso(), lastError: null });
    return true;
  });
  if (!saved) throw new SonarrError("Sonarr settings changed. Reload before saving.");
  return getSonarrState(db, instanceId);
}

export async function refreshSonarr(db: Db, instanceId: string): Promise<SonarrState> {
  await refreshCatalog(db, await settings(db, instanceId), true);
  return getSonarrState(db, instanceId);
}

export async function getSonarrCopyDefaults(db: Db): Promise<SonarrCopyDefaults> {
  return store.copyDefaults(db);
}

// Episode files of one series, kept briefly so copying a whole season asks Sonarr once instead of once per file.
const episodeFileCache = new Map<string, { at: number; files: Promise<{ series: SonarrSeries; files: SonarrEpisodeFile[] }> }>();

function cachedEpisodeFiles(config: StoredSettings, seriesId: number) {
  const key = `${config.id}\0${config.revision}\0${seriesId}`;
  const now = Date.now();
  const cached = episodeFileCache.get(key);
  if (cached && now - cached.at < expectationCacheMs) return cached.files;
  for (const [entry, value] of episodeFileCache) if (now - value.at >= expectationCacheMs) episodeFileCache.delete(entry);
  const connection = sonarrClient(config);
  const files = Promise.all([connection.seriesById(seriesId), connection.episodeFiles(seriesId)]).then(([series, list]) => ({ series, files: list }));
  episodeFileCache.set(key, { at: now, files });
  files.catch(() => episodeFileCache.delete(key));
  return files;
}

// Sonarr's recorded size for the exact episode file a link points to, used to reject partial files before copying.
export async function sonarrMediaExpectation(db: Db, link: Pick<MediaLinkRow, "section" | "itemName" | "relativePath">): Promise<MediaExpectation | undefined> {
  const config = sectionOwner(await storedInstances(db), link.section);
  if (!config?.enabled || !config.apiKey) return undefined;
  const relative = seriesRelativePath(link);
  if (!relative) return undefined;
  const row = await first(db.select().from(schema.sonarrSeries).where(and(forInstance(config), eq(schema.sonarrSeries.section, link.section), eq(schema.sonarrSeries.itemName, link.itemName))).limit(1));
  if (!row) return undefined;
  const { series, files } = await cachedEpisodeFiles(config, row.seriesId);
  const scope = mapSonarrSeries(series, config);
  if (series.tvdbId !== row.tvdbId || scope?.section !== link.section || scope.itemName !== link.itemName) return undefined;
  // Extras and samples share the series folder; only files Sonarr imported as episodes have a known size.
  const fileName = path.posix.basename(relative);
  const file = files.find((entry) => normalizedRelative(entry.relativePath) === relative)
    ?? (() => { const named = files.filter((entry) => path.posix.basename(normalizedRelative(entry.relativePath)) === fileName); return named.length === 1 ? named[0] : undefined; })();
  if (!file?.size) return undefined;
  return { source: config.name, sizeBytes: file.size };
}

export async function getSonarrState(db: Db, instanceId: string): Promise<SonarrState> {
  const stored = await storedInstances(db);
  const config = stored.instances.find((instance) => instance.id === instanceId);
  if (!config) throw new SonarrInstanceNotFound();
  const policies = await arrPolicyLookup(db);
  const rows = await db.select().from(schema.sonarrSeries).where(forInstance(config)).orderBy(asc(schema.sonarrSeries.title), asc(schema.sonarrSeries.seriesId));
  const series: SonarrSeriesStatus[] = rows.map((row) => {
    const tags = parseTags(row.tags);
    const policy = arrCurrentPolicy(row, policies);
    const tagPolicy = arrTagPolicy(tags, config);
    const status = !row.section || !row.itemName ? "unmapped" : !row.managed ? "review" : row.lastError ? "error" : row.syncedPolicy === policy && tagPolicy === policy ? "synced" : "pending";
    return { seriesId: row.seriesId, tvdbId: row.tvdbId, title: row.title, folderPath: row.folderPath, section: row.section, itemName: row.itemName, tags, monitored: row.monitored, policy, tagPolicy, managed: row.managed, status, message: row.lastError, syncedAt: row.syncedAt };
  });
  const events = await db.select({ id: schema.sonarrEvents.id, seriesId: schema.sonarrEvents.seriesId, title: schema.sonarrEvents.title, eventType: schema.sonarrEvents.eventType, receivedAt: schema.sonarrEvents.receivedAt, processedAt: schema.sonarrEvents.processedAt, error: schema.sonarrEvents.error, jobId: schema.sonarrEvents.jobId, jobStatus: schema.jobs.status }).from(schema.sonarrEvents).leftJoin(schema.jobs, eq(schema.jobs.id, schema.sonarrEvents.jobId)).where(eq(schema.sonarrEvents.instanceId, config.id)).orderBy(desc(schema.sonarrEvents.id)).limit(100);
  const monitorUpdates = await db.select({ id: schema.sonarrMonitorUpdates.id, seriesId: schema.sonarrMonitorUpdates.seriesId, episodeId: schema.sonarrMonitorUpdates.episodeId, title: schema.sonarrMonitorUpdates.title, monitored: schema.sonarrMonitorUpdates.monitored, copyJobId: schema.sonarrMonitorUpdates.copyJobId, createdAt: schema.sonarrMonitorUpdates.createdAt, processedAt: schema.sonarrMonitorUpdates.processedAt, error: schema.sonarrMonitorUpdates.error }).from(schema.sonarrMonitorUpdates).where(eq(schema.sonarrMonitorUpdates.instanceId, config.id)).orderBy(desc(schema.sonarrMonitorUpdates.id)).limit(200);
  return {
    settings: publicSettings(config, stored),
    series,
    events: events.map((event) => ({ ...event, jobStatus: event.jobStatus as JobStatus | null })),
    monitorUpdates
  };
}

export async function reconcileSonarrSeries(db: Db, instanceId: string, seriesIds: number[], action: "use_srtl" | "import_tags"): Promise<SonarrState> {
  const config = await settings(db, instanceId);
  if (!config.localTag || !config.remoteTag) throw new SonarrError("Choose and save both policy tags before reconciling titles.");
  const rows = await db.select().from(schema.sonarrSeries).where(seriesIdsIn(config, seriesIds));
  if (rows.length !== new Set(seriesIds).size || rows.some((row) => !row.section || !row.itemName)) throw new SonarrError("Select mapped titles before reconciling policies.");
  const connection = sonarrClient(config);
  const tags = await connection.tags();
  // Re-read selected records so a stale preview cannot import an outdated tag or changed series identity.
  const catalog = new Map((await connection.series()).map((series) => [series.id, series]));
  const refreshed: SonarrSeries[] = [];
  for (const row of rows) {
    const series = catalog.get(row.seriesId);
    if (!series) throw new SonarrError("A series was removed from Sonarr. Refresh the preview before continuing.");
    const scope = mapSonarrSeries(series, config);
    if (!scope || series.tvdbId !== row.tvdbId || scope.section !== row.section || scope.itemName !== row.itemName) throw new SonarrError("A series mapping changed. Refresh the preview before continuing.");
    refreshed.push(series);
  }
  const applied = await commitCurrent(db, config, async (transaction) => {
    await storeSeries(transaction, refreshed, tags, config);
    const policies = await arrPolicyLookup(transaction);
    const selected = await transaction.select().from(schema.sonarrSeries).where(seriesIdsIn(config, seriesIds));
    if (action === "import_tags") {
      // Policies are per folder: two copies of a title in different folders may import different tags.
      const groups = new Map<StoragePolicyKind, StoragePolicyTarget[]>();
      const assignments = new Map<string, StoragePolicyKind>();
      for (const row of selected) {
        const tagPolicy = arrTagPolicy(parseTags(row.tags), config);
        const policy = arrCurrentPolicy(row, policies);
        if (tagPolicy === "conflict" || tagPolicy === "unassigned" || (policy !== "unassigned" && policy !== tagPolicy)) throw new SonarrError("Only unassigned or matching titles with one policy tag can be imported. Resolve conflicting assignments in SRTL first.");
        const key = storagePolicyKey(row.section!, row.itemName!);
        if (assignments.has(key) && assignments.get(key) !== tagPolicy) throw new SonarrError("Selected copies of the same title in one folder have conflicting policy tags.");
        assignments.set(key, tagPolicy);
        groups.set(tagPolicy, [...(groups.get(tagPolicy) ?? []), { section: row.section!, title: row.itemName! }]);
      }
      await withResourceMutationGuard(transaction, async (guarded) => {
        const latest = await arrPolicyLookup(guarded);
        for (const row of selected) {
          const existing = arrCurrentPolicy(row, latest);
          if (existing !== "unassigned" && existing !== assignments.get(storagePolicyKey(row.section!, row.itemName!))) {
            throw new SonarrError("SRTL policies changed during review. Refresh before importing tags.");
          }
        }
        return {
          resources: [
            ...await storagePolicyMutationResources(guarded, selected.map((row) => ({ section: row.section!, title: row.itemName! }))),
            ...selected.map((row) => ({ resourceType: "title", resourceKey: JSON.stringify([row.section, row.itemName]) }))
          ],
          mutate: async () => {
            for (const [policy, targets] of groups) await setStoragePolicies(guarded, targets, policy, { source: "sonarr" });
          }
        };
      });
    }
    await transaction.update(schema.sonarrSeries).set({ managed: true, syncedPolicy: null, lastError: null, attempts: 0, nextAttemptAt: null }).where(seriesIdsIn(config, seriesIds));
    return true;
  });
  if (!applied) throw new SonarrError("Sonarr settings changed. Reload before continuing.");
  return getSonarrState(db, instanceId);
}

export async function authenticateSonarrWebhook(db: Db, instanceId: string, token: string | undefined): Promise<boolean> {
  return store.authenticateWebhook(db, instanceId, token);
}

// Only the events SRTL acts on. Sonarr's other notification types are rejected so the setup stays explicit.
export const sonarrWebhookEvents = ["Test", "Download", "Rename", "SeriesAdd", "SeriesDelete", "EpisodeFileDelete"] as const;
const episodeFileReference = z.object({ id: z.number().int().positive().optional(), relativePath: z.string().max(4096).optional() });
const webhookSchema = z.object({
  eventType: z.enum(sonarrWebhookEvents),
  series: z.object({ id: z.number().int().positive(), title: z.string().max(1000) }).optional(),
  episodes: z.array(z.object({ id: z.number().int().positive().optional(), seasonNumber: z.number().int().optional(), episodeNumber: z.number().int().optional() })).max(1000).optional(),
  episodeFile: episodeFileReference.optional(),
  // Newer Sonarr versions can report a whole import in one notification.
  episodeFiles: z.array(episodeFileReference).max(1000).optional(),
  isUpgrade: z.boolean().optional(),
  deleteReason: z.string().max(200).optional(),
  // SeriesDelete reports whether the files were deleted (a boolean); an upgrade import lists the files it replaced.
  // The listed files are not used: the series rescan records what the folder holds after the upgrade.
  deletedFiles: z.union([z.boolean(), z.array(z.object({ id: z.number().int().optional(), relativePath: z.string().max(4096).optional() })).max(1000)]).optional(),
  renamedEpisodeFiles: z.array(z.object({ previousRelativePath: z.string().max(4096).optional(), relativePath: z.string().max(4096).optional() })).max(1000).optional()
});

// Top-level fields SRTL does not read. They are dropped before the event is stored, so new Sonarr fields never fail a delivery.
export function sonarrWebhookExtraFields(payload: unknown): string[] {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return [];
  return Object.keys(payload).filter((key) => !(key in webhookSchema.shape)).sort();
}

export async function receiveSonarrWebhook(db: Db, instanceId: string, payload: unknown): Promise<{ accepted: boolean; duplicate?: boolean }> {
  const body = webhookSchema.parse(payload);
  if (body.eventType === "Test") return { accepted: true };
  if (!body.series) throw new SonarrError("Webhook is missing its series identifier.");
  const config = await webhookInstance(db, instanceId);
  if (!config) throw new SonarrInstanceNotFound();
  if (!config.enabled) throw new SonarrError("Sonarr integration is paused.");
  const timestamp = nowIso();
  const fingerprint = arrDigest(`${config.baseUrl}:${JSON.stringify(body)}`);
  const cutoff = new Date(Date.now() - 60_000).toISOString();
  // Only the file id is kept: paths in the body are not trusted, and the file is looked up in Sonarr before rescanning.
  const episodeFileId = body.episodeFile?.id ?? body.episodeFiles?.find((file) => file.id)?.id ?? null;
  const inserted = await db.insert(schema.sonarrEvents).values({ instanceId: config.id, fingerprint, seriesId: body.series.id, episodeFileId: body.eventType === "Download" ? episodeFileId : null, title: body.series.title, eventType: body.eventType, receivedAt: timestamp, nextAttemptAt: new Date(Date.now() + 3000).toISOString() }).onConflictDoUpdate({ target: [schema.sonarrEvents.instanceId, schema.sonarrEvents.fingerprint], set: { receivedAt: timestamp, processedAt: null, nextAttemptAt: new Date(Date.now() + 3000).toISOString(), attempts: 0, error: null, jobId: null }, setWhere: and(sql`sonarr_events.received_at < ${cutoff}`, sql`sonarr_events.processed_at IS NOT NULL`) }).returning({ id: schema.sonarrEvents.id });
  return { accepted: true, duplicate: inserted.length === 0 };
}

// A Download notification is acted on once the imported episode's symlink exists in the series folder.
async function assertImportedSymlink(db: Db, connection: SonarrClient, scope: ScanTitleScope, event: typeof schema.sonarrEvents.$inferSelect): Promise<void> {
  if (!event.episodeFileId) throw new SonarrError("Sonarr has not reported a usable imported file yet.");
  let file: SonarrEpisodeFile;
  try {
    file = await connection.episodeFile(event.episodeFileId);
  } catch (error) {
    // The file was replaced or deleted since; the rescan records whatever the folder holds now.
    if (error instanceof SonarrError && error.httpStatus === 404) return;
    throw error;
  }
  if (file.seriesId !== event.seriesId) throw new SonarrError("Sonarr reported an episode file of a different series.");
  const relative = file.relativePath;
  if (!relative || path.posix.isAbsolute(relative) || relative.split(/[\\/]/).some((part) => part === ".." || part === "." || part === "")) throw new SonarrError("Sonarr has not reported a usable imported file yet.");
  const paths = await getJsonSetting<PathsSettings>(db, "paths", { symlinkDir: "", localDir: "", remoteDir: "" });
  const filePath = path.join(paths.symlinkDir, scope.section, scope.itemName, relative);
  try { await assertPathParentInside(paths.symlinkDir, filePath, "Imported symlink"); }
  catch { throw new SonarrError("Mapped series directory is unavailable or resolves outside the symlink root."); }
  const stat = await withFilesystemTimeout(fs.lstat(filePath), "Imported symlink check").catch(() => null);
  if (!stat?.isSymbolicLink()) throw new SonarrError("Imported symlink is not available at the mapped path yet. Waiting to rescan.");
}

// A season pack arrives as one notification per episode; they share one queued rescan of the series folder.
async function queuedRescan(db: Db, config: StoredSettings, seriesId: number, scope: ScanTitleScope): Promise<number | null> {
  const candidates = await db.select({ jobId: schema.jobs.id, options: schema.jobs.options }).from(schema.sonarrEvents)
    .innerJoin(schema.jobs, eq(schema.jobs.id, schema.sonarrEvents.jobId))
    .where(and(eq(schema.sonarrEvents.instanceId, config.id), eq(schema.sonarrEvents.seriesId, seriesId), eq(schema.jobs.status, "queued")))
    .orderBy(desc(schema.jobs.id)).limit(5);
  for (const candidate of candidates) {
    let scopes: unknown;
    try { scopes = (JSON.parse(candidate.options) as { titleScopes?: unknown }).titleScopes; } catch { continue; }
    if (Array.isArray(scopes) && scopes.length === 1 && (scopes[0] as ScanTitleScope).section === scope.section && (scopes[0] as ScanTitleScope).itemName === scope.itemName) return candidate.jobId;
  }
  return null;
}

type SonarrEvent = typeof schema.sonarrEvents.$inferSelect;

const addedOnlyMessage = "Added to the catalog. No rescan queued: the series folder has no media yet.";

// All pending events of one series are handled together, so a season pack or a mass delete becomes one rescan.
async function processSeriesEvents(db: Db, config: StoredSettings, events: SonarrEvent[]): Promise<void> {
  const seriesId = events[0]!.seriesId;
  const eventIds = events.map((event) => event.id);
  const markProcessed = (transaction: Db, error: string | null, jobId: number | null = null) => transaction.update(schema.sonarrEvents).set({ processedAt: nowIso(), error, jobId }).where(inArray(schema.sonarrEvents.id, eventIds));
  const old = await first(db.select().from(schema.sonarrSeries).where(seriesIdsIn(config, [seriesId])).limit(1));
  const scopes: ScanTitleScope[] = [];
  if (old?.section && old.itemName) scopes.push({ section: old.section, itemName: old.itemName });
  // Sonarr no longer knows a deleted series, so its stored folder is the only scope left.
  const deleted = events[events.length - 1]!.eventType === "SeriesDelete";
  let fetched: { series: SonarrSeries; tags: Catalog["tags"] } | null = null;
  if (!deleted) {
    const connection = sonarrClient(config);
    const series = await connection.seriesById(seriesId);
    const scope = mapSonarrSeries(series, config);
    if (!scope) {
      await commitCurrent(db, config, (transaction) => markProcessed(transaction, "Ignored: series is outside the configured folder mappings."));
      return;
    }
    if (old && old.tvdbId !== series.tvdbId) throw new SonarrError("Series identifier changed. Refresh and review its mapping.");
    for (const event of events) if (event.eventType === "Download") await assertImportedSymlink(db, connection, scope, event);
    fetched = { series, tags: await connection.tags() };
    // A series added without files has nothing to scan; its Download events do the real rescan.
    if (events.every((event) => event.eventType === "SeriesAdd")) {
      const paths = await getJsonSetting<PathsSettings>(db, "paths", { symlinkDir: "", localDir: "", remoteDir: "" });
      if (!await arrTitleHasMediaSymlinks(paths.symlinkDir, scope)) {
        await commitCurrent(db, config, async (transaction) => {
          await storeSeries(transaction, [series], fetched!.tags, config);
          await markProcessed(transaction, addedOnlyMessage);
        });
        return;
      }
    }
    if (!scopes.some((entry) => entry.section === scope.section && entry.itemName === scope.itemName)) scopes.push(scope);
  }
  await commitCurrent(db, config, async (transaction) => {
    if (fetched) await storeSeries(transaction, [fetched.series], fetched.tags, config);
    if (!scopes.length) {
      await markProcessed(transaction, "Ignored: no confirmed SRTL mapping is available for this event.");
      return;
    }
    // A rescan from an earlier batch that has not started yet already covers this one.
    const pending = scopes.length === 1 ? await queuedRescan(transaction, config, seriesId, scopes[0]!) : null;
    const jobId = pending ?? await new JobRunner(transaction).startExternalTitleScan(scopes);
    if (!pending) await transaction.insert(schema.jobEvents).values({ jobId, timestamp: nowIso(), level: "info", message: arrRefreshMessage(config.name, events.length), data: JSON.stringify({ instanceId: config.id, seriesId, eventTypes: [...new Set(events.map((event) => event.eventType))], events: events.length }) });
    await markProcessed(transaction, null, jobId);
    if (deleted) await transaction.delete(schema.sonarrSeries).where(seriesIdsIn(config, [seriesId]));
  });
}

async function processEvents(db: Db, config: StoredSettings): Promise<void> {
  const pending = await db.select().from(schema.sonarrEvents).where(and(eq(schema.sonarrEvents.instanceId, config.id), isNull(schema.sonarrEvents.processedAt))).orderBy(asc(schema.sonarrEvents.id)).limit(pendingEventLimit);
  for (const events of arrReadyEventGroups(pending, (event) => event.seriesId).slice(0, eventBatchSize)) {
    try { await processSeriesEvents(db, config, events); }
    catch (error) {
      const message = error instanceof SonarrError ? error.message : "Title refresh could not be queued. It will retry after active work or storage maintenance finishes.";
      for (const event of events) await db.update(schema.sonarrEvents).set({ error: message, attempts: event.attempts + 1, nextAttemptAt: arrRetryAt(event.attempts) }).where(eq(schema.sonarrEvents.id, event.id));
    }
  }
}

// A policy change made in SRTL always takes over the series' tags. Series seen for the first time join
// automatically unless Sonarr already carries the opposite policy tag, which stays in review.
async function observePolicies(db: Db, config: StoredSettings): Promise<void> {
  await commitCurrent(db, config, async (transaction) => {
    const policies = await arrPolicyLookup(transaction);
    const markers = await arrPolicyMarkers(transaction);
    const rows = await transaction.select().from(schema.sonarrSeries).where(forInstance(config));
    const groups = new Map<string, { marker: string; managed: boolean; seriesIds: number[] }>();
    for (const row of rows) {
      if (!row.section || !row.itemName) continue;
      const marker = markers.get(storagePolicyKey(row.section, row.itemName)) ?? "unassigned";
      if (row.observedPolicyMarker === marker) continue;
      const tagPolicy = arrTagPolicy(parseTags(row.tags), config);
      const managed = row.managed || row.observedPolicyMarker !== null || tagPolicy === "unassigned" || tagPolicy === arrCurrentPolicy(row, policies);
      const key = `${marker}\0${managed}`;
      const group = groups.get(key) ?? { marker, managed, seriesIds: [] };
      group.seriesIds.push(row.seriesId);
      groups.set(key, group);
    }
    for (const group of groups.values()) {
      for (let offset = 0; offset < group.seriesIds.length; offset += 1000) {
        await transaction.update(schema.sonarrSeries).set({ observedPolicyMarker: group.marker, managed: group.managed }).where(seriesIdsIn(config, group.seriesIds.slice(offset, offset + 1000)));
      }
    }
  });
}

type TagOutcome = { seriesId: number; policy: StoragePolicyKind; labels?: string[]; error?: string };

async function pushTags(config: StoredSettings, rows: SeriesRow[], policies: Map<string, StoragePolicyKind>): Promise<TagOutcome[]> {
  const connection = sonarrClient(config);
  const tagList = await connection.tags();
  const tagId = (label: string) => tagList.find((tag) => tag.label === label)?.id;
  const policyTagIds = [tagId(config.localTag), tagId(config.remoteTag)].filter((id): id is number => id !== undefined);
  const outcomes: TagOutcome[] = [];
  const live = await arrMapLimit(rows, 5, async (row) => {
    const policy = arrCurrentPolicy(row, policies);
    try {
      const series = await connection.seriesById(row.seriesId);
      const scope = mapSonarrSeries(series, config);
      if (series.tvdbId !== row.tvdbId || scope?.section !== row.section || scope?.itemName !== row.itemName) throw new SonarrError("Sonarr series identity or path changed. Refresh and review its mapping.");
      return { series, policy };
    } catch (error) {
      if (!(error instanceof SonarrError)) throw error;
      outcomes.push({ seriesId: row.seriesId, policy, error: error.message });
      return null;
    }
  });
  const ready = live.filter((entry) => entry !== null);
  const desiredIds = new Map<string, number>();
  for (const label of new Set(ready.map((entry) => arrPolicyTag(entry.policy, config)).filter((label) => label !== null))) {
    desiredIds.set(label, tagId(label) ?? await connection.ensureTag(label));
  }
  // Only the two configured policy tags are ever removed; every other tag on the series is left alone.
  const removals = new Map<number, number[]>();
  const additions = new Map<number, number[]>();
  for (const { series, policy } of ready) {
    const label = arrPolicyTag(policy, config);
    const desiredId = label ? desiredIds.get(label) : undefined;
    for (const id of policyTagIds) if (id !== desiredId && series.tags.includes(id)) removals.set(id, [...(removals.get(id) ?? []), series.id]);
    if (desiredId !== undefined && !series.tags.includes(desiredId)) additions.set(desiredId, [...(additions.get(desiredId) ?? []), series.id]);
  }
  const changed = new Set<number>();
  for (const [id, seriesIds] of removals) { await connection.editTags(seriesIds, [id], "remove"); seriesIds.forEach((seriesId) => changed.add(seriesId)); }
  for (const [id, seriesIds] of additions) { await connection.editTags(seriesIds, [id], "add"); seriesIds.forEach((seriesId) => changed.add(seriesId)); }
  const confirmedTags = changed.size ? await connection.tags() : tagList;
  const confirmed = await arrMapLimit(ready, 5, async ({ series, policy }) => {
    try {
      const current = changed.has(series.id) ? await connection.seriesById(series.id) : series;
      const labels = confirmedTags.filter((tag) => current.tags.includes(tag.id)).map((tag) => tag.label);
      if (arrTagPolicy(labels, config) !== policy) throw new SonarrError("Sonarr tags changed during synchronization. The worker will retry.");
      return { seriesId: series.id, policy, labels };
    } catch (error) {
      if (!(error instanceof SonarrError)) throw error;
      return { seriesId: series.id, policy, error: error.message };
    }
  });
  return [...outcomes, ...confirmed];
}

async function syncTags(db: Db, config: StoredSettings): Promise<void> {
  const policies = await arrPolicyLookup(db);
  const now = nowIso();
  const rows = await db.select().from(schema.sonarrSeries).where(and(forInstance(config), eq(schema.sonarrSeries.managed, true))).orderBy(asc(schema.sonarrSeries.nextAttemptAt), asc(schema.sonarrSeries.seriesId));
  const pending = rows.filter((row) => row.section && row.itemName && (row.syncedPolicy !== arrCurrentPolicy(row, policies) || row.lastError) && (!row.nextAttemptAt || row.nextAttemptAt <= now));
  if (!pending.length) return;
  // Series whose catalog tags already express their policy need no Sonarr round trip.
  const alreadyTagged = pending.filter((row) => !row.lastError && arrTagPolicy(parseTags(row.tags), config) === arrCurrentPolicy(row, policies));
  const work = pending.filter((row) => !alreadyTagged.includes(row)).slice(0, tagSyncBatchSize);
  let outcomes: TagOutcome[] = [];
  if (work.length) {
    try {
      outcomes = await pushTags(config, work, policies);
    } catch (error) {
      if (!(error instanceof SonarrError)) throw error;
      outcomes = work.map((row) => ({ seriesId: row.seriesId, policy: arrCurrentPolicy(row, policies), error: error.message }));
    }
  }
  const attempts = new Map(work.map((row) => [row.seriesId, row.attempts]));
  await commitCurrent(db, config, async (transaction) => {
    const syncedAt = nowIso();
    for (const policy of ["location_1", "location_2", "unassigned"] as const) {
      const seriesIds = alreadyTagged.filter((row) => arrCurrentPolicy(row, policies) === policy).map((row) => row.seriesId);
      for (let offset = 0; offset < seriesIds.length; offset += 1000) {
        await transaction.update(schema.sonarrSeries).set({ syncedPolicy: policy, syncedAt, lastError: null, nextAttemptAt: null, attempts: 0 }).where(seriesIdsIn(config, seriesIds.slice(offset, offset + 1000)));
      }
    }
    for (const outcome of outcomes) {
      const update = outcome.labels
        ? { tags: JSON.stringify(outcome.labels), syncedPolicy: outcome.policy, syncedAt, lastError: null, nextAttemptAt: null, attempts: 0 }
        : { lastError: outcome.error ?? "Sonarr tag update failed.", attempts: (attempts.get(outcome.seriesId) ?? 0) + 1, nextAttemptAt: arrRetryAt(attempts.get(outcome.seriesId) ?? 0) };
      await transaction.update(schema.sonarrSeries).set(update).where(seriesIdsIn(config, [outcome.seriesId]));
    }
  });
}

interface CopiedTitle { section: string; itemName: string }
interface SelectedEpisodeFile { series: SeriesRow; mediaLinkId: number; relativePath: string; copied: boolean }

const titleKey = (title: CopiedTitle) => `${title.section}\0${title.itemName}`;
const notCopiedMessage = "Skipped: this episode file did not finish copying.";
const rolledBackMessage = "Skipped: the copy was terminated and rolled back.";
const noEpisodeMessage = "Sonarr has no episode for this file.";

// The instance's series among the copied titles. Each instance handles only the series in folders it maps,
// so a copy across folders reaches every owning instance.
async function copiedSeries(db: Db, config: StoredSettings, titles: CopiedTitle[]): Promise<SeriesRow[]> {
  const keys = new Set(titles.map(titleKey));
  const sections = [...new Set(titles.map((title) => title.section))];
  if (!sections.length) return [];
  const itemNames = titles.length <= 500 ? [...new Set(titles.map((title) => title.itemName))] : null;
  return (await db.select().from(schema.sonarrSeries).where(and(forInstance(config), inArray(schema.sonarrSeries.section, sections), itemNames ? inArray(schema.sonarrSeries.itemName, itemNames) : undefined)))
    .filter((series) => series.section !== null && series.itemName !== null && keys.has(titleKey({ section: series.section, itemName: series.itemName })));
}

// The copy's selected media files in those series, each marked copied when it is now at the destination.
async function selectedEpisodeFiles(db: Db, jobId: number, series: SeriesRow[], destination: "local" | "remote"): Promise<SelectedEpisodeFile[]> {
  if (!series.length) return [];
  const bySeries = new Map(series.map((row) => [titleKey({ section: row.section!, itemName: row.itemName! }), row]));
  const sections = [...new Set(series.map((row) => row.section!))];
  const itemNames = [...new Set(series.map((row) => row.itemName!))];
  const links = await db.select({ id: schema.mediaLinks.id, section: schema.mediaLinks.section, itemName: schema.mediaLinks.itemName, relativePath: schema.mediaLinks.relativePath, kind: schema.mediaLinks.kind, missingSince: schema.mediaLinks.missingSince })
    .from(schema.jobSelectionItems).innerJoin(schema.mediaLinks, eq(schema.mediaLinks.id, schema.jobSelectionItems.mediaLinkId))
    .where(and(eq(schema.jobSelectionItems.jobId, jobId), inArray(schema.mediaLinks.section, sections), inArray(schema.mediaLinks.itemName, itemNames), eq(schema.mediaLinks.isMedia, true)));
  return links.flatMap((link) => {
    const owner = bySeries.get(titleKey(link));
    const relativePath = seriesRelativePath(link);
    return owner && relativePath ? [{ series: owner, mediaLinkId: link.id, relativePath, copied: link.kind === destination && link.missingSince === null }] : [];
  });
}

// Large copies record thousands of episode files; inserts stay well under Postgres's parameter limit.
async function inChunks<T>(rows: T[], insert: (chunk: T[]) => Promise<unknown>): Promise<void> {
  for (let offset = 0; offset < rows.length; offset += 500) await insert(rows.slice(offset, offset + 500));
}

function copiedFile(config: StoredSettings, copyJobId: number, file: SelectedEpisodeFile, monitored: boolean, timestamp: string): typeof schema.sonarrCopiedFiles.$inferInsert {
  return { instanceId: config.id, copyJobId, seriesId: file.series.seriesId, mediaLinkId: file.mediaLinkId, relativePath: file.relativePath, monitored, createdAt: timestamp, nextAttemptAt: timestamp };
}

// The copy worker calls this as soon as a title's files are committed, so a long batch changes each episode's monitoring
// shortly after it is safe instead of when the whole job ends. Only files now at the destination are recorded; the rest
// wait for later calls and for the end-of-job pass. Every (job, instance, file) is recorded at most once.
export async function queueCopiedSonarrEpisodes(db: Db, copy: { jobId: number; direction: CopyOptions["direction"] }, titles: CopiedTitle[]): Promise<void> {
  if (!titles.length) return;
  const monitored = copy.direction === "to_remote";
  await locked(db, async (transaction) => {
    const timestamp = nowIso();
    for (const config of (await storedInstances(transaction)).instances) {
      if (!config.enabled || copy.jobId <= config.copyJobFloor) continue;
      const files = (await selectedEpisodeFiles(transaction, copy.jobId, await copiedSeries(transaction, config, titles), monitored ? "remote" : "local")).filter((file) => file.copied);
      await inChunks(files.map((file) => copiedFile(config, copy.jobId, file, monitored, timestamp)), (chunk) => transaction.insert(schema.sonarrCopiedFiles).values(chunk).onConflictDoNothing());
    }
  });
}

// Once a requested copy ends, this pass records anything the per-title calls missed, including files that did not copy,
// which are kept only to show them as skipped. A terminated copy rolls its files back to the source, so episodes whose
// monitoring already changed are put back as they were.
async function queueCopyMonitorUpdates(db: Db, config: StoredSettings): Promise<void> {
  const copyJobs = (await db.execute<{ id: number; options: string }>(sql`
    select jobs.id, jobs.options from jobs
    where jobs.type = 'copy' and jobs.status in ('completed', 'partially_failed', 'failed', 'cancelled')
      and jobs.id > ${config.copyJobFloor}
      and jobs.options::jsonb ->> 'sonarrMonitoring' = 'true'
      and not exists (select 1 from sonarr_copy_jobs handled where handled.job_id = jobs.id and handled.instance_id = ${config.id})
    order by jobs.id limit 20`)).rows;
  for (const job of copyJobs) {
    await commitCurrent(db, config, async (transaction) => {
      const monitored = (JSON.parse(job.options) as { direction?: string }).direction === "to_remote";
      const titles = await transaction.selectDistinct({ section: schema.jobSelectionItems.section, itemName: schema.jobSelectionItems.itemName }).from(schema.jobSelectionItems).where(eq(schema.jobSelectionItems.jobId, job.id));
      const files = await selectedEpisodeFiles(transaction, job.id, await copiedSeries(transaction, config, titles), monitored ? "remote" : "local");
      const staged = new Map((await transaction.select().from(schema.sonarrCopiedFiles).where(and(eq(schema.sonarrCopiedFiles.instanceId, config.id), eq(schema.sonarrCopiedFiles.copyJobId, job.id)))).map((row) => [row.mediaLinkId, row]));
      const rolledBack = new Set((await transaction.select({ mediaLinkId: schema.copyOperations.mediaLinkId }).from(schema.copyOperations)
        .where(and(eq(schema.copyOperations.jobId, job.id), eq(schema.copyOperations.stage, "rolled_back")))).map((row) => row.mediaLinkId));
      const timestamp = nowIso();
      const inserts: Array<typeof schema.sonarrCopiedFiles.$inferInsert> = [];
      const reversals: Array<typeof schema.sonarrMonitorUpdates.$inferInsert> = [];
      for (const file of files) {
        const row = staged.get(file.mediaLinkId);
        if (!row) {
          inserts.push({ ...copiedFile(config, job.id, file, monitored, timestamp), ...(file.copied ? {} : { skipReason: notCopiedMessage }) });
          continue;
        }
        if (file.copied || row.skipReason || !rolledBack.has(file.mediaLinkId)) continue;
        if (!row.resolvedAt) {
          await transaction.update(schema.sonarrCopiedFiles).set({ skipReason: rolledBackMessage }).where(eq(schema.sonarrCopiedFiles.id, row.id));
          continue;
        }
        const updates = await transaction.select().from(schema.sonarrMonitorUpdates).where(and(eq(schema.sonarrMonitorUpdates.instanceId, config.id), eq(schema.sonarrMonitorUpdates.copyJobId, job.id), eq(schema.sonarrMonitorUpdates.mediaLinkId, file.mediaLinkId), eq(schema.sonarrMonitorUpdates.monitored, monitored)));
        for (const update of updates) {
          if (update.error?.startsWith("Skipped")) continue;
          if (!update.processedAt) {
            await transaction.update(schema.sonarrMonitorUpdates).set({ processedAt: timestamp, error: rolledBackMessage }).where(eq(schema.sonarrMonitorUpdates.id, update.id));
          } else if (update.previousMonitored === !monitored) {
            reversals.push({ instanceId: config.id, copyJobId: job.id, seriesId: update.seriesId, episodeId: update.episodeId, mediaLinkId: update.mediaLinkId, title: update.title, monitored: !monitored, previousMonitored: monitored, createdAt: timestamp, nextAttemptAt: timestamp });
          }
        }
      }
      await inChunks(inserts, (chunk) => transaction.insert(schema.sonarrCopiedFiles).values(chunk).onConflictDoNothing());
      await inChunks(reversals, (chunk) => transaction.insert(schema.sonarrMonitorUpdates).values(chunk).onConflictDoNothing());
      await transaction.insert(schema.sonarrCopyJobs).values({ instanceId: config.id, jobId: job.id, handledAt: timestamp }).onConflictDoNothing();
    });
  }
}

type SeriesEpisodes = { seriesId: number; files: SonarrEpisodeFile[]; episodes: SonarrEpisode[] } | { seriesId: number; error: string };

// Matches recorded files to Sonarr episode ids through Sonarr's episode file paths. A multi-episode file changes each of its episodes.
async function resolveCopiedFiles(db: Db, config: StoredSettings): Promise<void> {
  const due = await db.select({ id: schema.sonarrCopiedFiles.id, seriesId: schema.sonarrCopiedFiles.seriesId }).from(schema.sonarrCopiedFiles)
    .where(and(eq(schema.sonarrCopiedFiles.instanceId, config.id), isNull(schema.sonarrCopiedFiles.resolvedAt), lte(schema.sonarrCopiedFiles.nextAttemptAt, nowIso())))
    .orderBy(asc(schema.sonarrCopiedFiles.id)).limit(resolveFileBatchSize);
  const seriesIds = [...new Set(due.map((row) => row.seriesId))].slice(0, resolveSeriesBatchSize);
  if (!seriesIds.length) return;
  const connection = sonarrClient(config);
  const results = await arrMapLimit(seriesIds, 3, async (seriesId): Promise<SeriesEpisodes> => {
    try {
      const [files, episodes] = await Promise.all([connection.episodeFiles(seriesId), connection.episodes(seriesId)]);
      return { seriesId, files, episodes };
    } catch (error) {
      if (!(error instanceof SonarrError)) throw error;
      return { seriesId, error: error.message };
    }
  });
  const ids = due.filter((row) => seriesIds.includes(row.seriesId)).map((row) => row.id);
  await commitCurrent(db, config, async (transaction) => {
    const timestamp = nowIso();
    // Rows are re-read under the lock: the end-of-job pass may have marked some rolled back meanwhile.
    const rows = await transaction.select().from(schema.sonarrCopiedFiles).where(and(inArray(schema.sonarrCopiedFiles.id, ids), isNull(schema.sonarrCopiedFiles.resolvedAt)));
    const titles = new Map((await transaction.select({ seriesId: schema.sonarrSeries.seriesId, title: schema.sonarrSeries.title }).from(schema.sonarrSeries).where(seriesIdsIn(config, seriesIds))).map((row) => [row.seriesId, row.title]));
    const updates: Array<typeof schema.sonarrMonitorUpdates.$inferInsert> = [];
    const unmatched = new Map<string, { jobId: number; seriesId: number; files: string[] }>();
    for (const result of results) {
      const seriesRows = rows.filter((row) => row.seriesId === result.seriesId);
      if ("error" in result) {
        for (const row of seriesRows) await transaction.update(schema.sonarrCopiedFiles).set({ error: result.error, attempts: row.attempts + 1, nextAttemptAt: arrRetryAt(row.attempts) }).where(eq(schema.sonarrCopiedFiles.id, row.id));
        continue;
      }
      const fileByPath = new Map(result.files.map((file) => [normalizedRelative(file.relativePath), file]));
      const episodesByFile = new Map<number, SonarrEpisode[]>();
      for (const episode of result.episodes) if (episode.episodeFileId) episodesByFile.set(episode.episodeFileId, [...(episodesByFile.get(episode.episodeFileId) ?? []), episode]);
      const title = titles.get(result.seriesId) ?? `Series ${result.seriesId}`;
      for (const row of seriesRows) {
        const file = fileByPath.get(normalizedRelative(row.relativePath));
        const episodes = file ? episodesByFile.get(file.id) ?? [] : [];
        await transaction.update(schema.sonarrCopiedFiles).set({ resolvedAt: timestamp, error: episodes.length ? null : noEpisodeMessage }).where(eq(schema.sonarrCopiedFiles.id, row.id));
        if (!episodes.length) {
          const key = `${row.copyJobId}\0${row.seriesId}`;
          const entry = unmatched.get(key) ?? { jobId: row.copyJobId, seriesId: row.seriesId, files: [] };
          entry.files.push(row.relativePath);
          unmatched.set(key, entry);
          continue;
        }
        for (const episode of episodes) {
          updates.push({ instanceId: config.id, copyJobId: row.copyJobId, seriesId: row.seriesId, episodeId: episode.id, mediaLinkId: row.mediaLinkId, title: `${title} ${sonarrEpisodeLabel(episode)}`, monitored: row.monitored, previousMonitored: episode.monitored, createdAt: timestamp, nextAttemptAt: timestamp, ...(row.skipReason ? { processedAt: timestamp, error: row.skipReason } : {}) });
        }
      }
    }
    await inChunks(updates, (chunk) => transaction.insert(schema.sonarrMonitorUpdates).values(chunk).onConflictDoNothing());
    for (const entry of unmatched.values()) {
      await transaction.insert(schema.jobEvents).values({ jobId: entry.jobId, timestamp, level: "warn", message: `${config.name} has no episode for ${entry.files.length === 1 ? "a copied file" : `${entry.files.length} copied files`} of ${titles.get(entry.seriesId) ?? `series ${entry.seriesId}`}; their monitoring was not changed`, data: JSON.stringify({ instanceId: config.id, seriesId: entry.seriesId, files: entry.files.slice(0, 20) }) });
    }
  });
}

async function applyMonitorUpdates(db: Db, config: StoredSettings): Promise<void> {
  const due = await db.select().from(schema.sonarrMonitorUpdates).where(and(eq(schema.sonarrMonitorUpdates.instanceId, config.id), isNull(schema.sonarrMonitorUpdates.processedAt), lte(schema.sonarrMonitorUpdates.nextAttemptAt, nowIso()))).orderBy(asc(schema.sonarrMonitorUpdates.id)).limit(monitorBatchSize);
  // Two pending changes to one episode, such as a copy and its rollback, are applied in order across passes.
  const seen = new Set<number>();
  const batch = due.filter((update) => !seen.has(update.episodeId) && Boolean(seen.add(update.episodeId)));
  if (!batch.length) return;
  const results = new Map<boolean, string | null>();
  for (const monitored of [false, true]) {
    const episodeIds = batch.filter((update) => update.monitored === monitored).map((update) => update.episodeId);
    if (!episodeIds.length) continue;
    try {
      for (let offset = 0; offset < episodeIds.length; offset += monitorRequestSize) await sonarrClient(config).setEpisodesMonitored(episodeIds.slice(offset, offset + monitorRequestSize), monitored);
      results.set(monitored, null);
    } catch (error) {
      if (!(error instanceof SonarrError)) throw error;
      results.set(monitored, error.message);
    }
  }
  await commitCurrent(db, config, async (transaction) => {
    const timestamp = nowIso();
    const applied = new Map<string, { jobId: number; seriesId: number; monitored: boolean; episodes: number; title: string }>();
    for (const update of batch) {
      const error = results.get(update.monitored);
      if (error) {
        await transaction.update(schema.sonarrMonitorUpdates).set({ error, attempts: update.attempts + 1, nextAttemptAt: arrRetryAt(update.attempts) }).where(eq(schema.sonarrMonitorUpdates.id, update.id));
        continue;
      }
      await transaction.update(schema.sonarrMonitorUpdates).set({ processedAt: timestamp, error: null }).where(eq(schema.sonarrMonitorUpdates.id, update.id));
      if (!update.copyJobId) continue;
      const key = `${update.copyJobId}\0${update.seriesId}\0${update.monitored}`;
      const entry = applied.get(key) ?? { jobId: update.copyJobId, seriesId: update.seriesId, monitored: update.monitored, episodes: 0, title: update.title.replace(/ S\d+E\d+$/, "") };
      entry.episodes += 1;
      applied.set(key, entry);
    }
    // One job event per series keeps a season's worth of episodes readable in the copy job's log.
    for (const entry of applied.values()) {
      await transaction.insert(schema.jobEvents).values({ jobId: entry.jobId, timestamp, level: "info", message: `${entry.monitored ? "Monitored" : "Unmonitored"} ${entry.episodes === 1 ? "1 episode" : `${entry.episodes} episodes`} in ${config.name}: ${entry.title}`, data: JSON.stringify({ instanceId: config.id, seriesId: entry.seriesId, monitored: entry.monitored, episodes: entry.episodes }) });
    }
  });
}

async function processInstance(db: Db, instanceId: string): Promise<void> {
  const config = (await storedInstances(db)).instances.find((instance) => instance.id === instanceId);
  if (!config?.enabled) return;
  const problem = await store.mappingProblem(db, config);
  if (problem) {
    await commitCurrent(db, config, (transaction, current) => writeSettings(transaction, { ...current, lastError: problem }));
    return;
  }
  await processEvents(db, config);
  await queueCopyMonitorUpdates(db, config);
  await resolveCopiedFiles(db, config);
  await applyMonitorUpdates(db, config);
  await observePolicies(db, config);
  await syncTags(db, config);
  if (!config.lastRefreshAt || Date.now() - Date.parse(config.lastRefreshAt) > catalogRefreshIntervalMs) await refreshCatalog(db, config, false);
}

// Starts work for every enabled instance that is not already running and returns without waiting for it,
// so a slow or offline Sonarr never holds back the others. Finished runs remove themselves from `running`.
export async function startSonarrWork(db: Db, running: Map<string, Promise<void>>, onError: (instanceName: string, error: unknown) => void): Promise<void> {
  const { instances } = await storedInstances(db);
  if (!instances.some((instance) => instance.enabled) || !(await isOnboardingComplete(db)) || await isPathConfigurationBlocked(db)) return;
  for (const instance of instances) {
    if (!instance.enabled || running.has(instance.id)) continue;
    running.set(instance.id, processInstance(db, instance.id)
      .catch((error: unknown) => onError(instance.name, error))
      .finally(() => running.delete(instance.id)));
  }
  const cutoff = new Date(Date.now() - historyRetentionMs).toISOString();
  await db.delete(schema.sonarrEvents).where(sql`processed_at < ${cutoff}`);
  await db.delete(schema.sonarrMonitorUpdates).where(sql`processed_at < ${cutoff}`);
  await db.delete(schema.sonarrCopiedFiles).where(sql`resolved_at < ${cutoff}`);
}

// Runs one pass for every enabled instance and waits for all of them. A failure is reported after the others finish.
export async function processSonarrWork(db: Db): Promise<void> {
  const running = new Map<string, Promise<void>>();
  const errors: unknown[] = [];
  await startSonarrWork(db, running, (_name, error) => errors.push(error));
  await Promise.all([...running.values()]);
  if (errors.length) throw errors[0];
}
