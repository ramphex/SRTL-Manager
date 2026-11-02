import fs from "node:fs/promises";
import path from "node:path";
import { and, asc, desc, eq, inArray, isNull, lte, sql } from "drizzle-orm";
import { z } from "zod";
import { radarrInstanceLimit, type RadarrConnectionTest, type RadarrCopyDefaults, type RadarrMovieStatus, type RadarrOverview, type RadarrSettingsInput, type RadarrState } from "../../shared/radarr";
import type { CopyOptions, JobStatus, MediaLinkRow, PathsSettings, ScanTitleScope, StoragePolicyKind, StorageRootType } from "../../shared/types";
import { dbAll, first, getJsonSetting, nowIso, type Db } from "../db/database";
import * as schema from "../db/schema";
import { JobRunner } from "../jobs/jobRunner";
import { storagePolicyMutationResources, withResourceMutationGuard } from "../jobs/resourceMutationGuard";
import { arrAbsolutePath, arrCurrentPolicy, arrDigest, arrMapLimit, arrPolicyLookup, arrPolicyMarkers, arrPolicyTag, arrReadyEventGroups, arrRefreshMessage, arrRetryAt, arrTitleHasMediaSymlinks, arrTagPolicy, arrWebhookSecretSchema, createArrInstanceStore, sameArrMappings, type ArrStoredSettings } from "./arrInstances";
import { isOnboardingComplete } from "./onboarding";
import { isPathConfigurationBlocked } from "./pathConfiguration";
import { RadarrClient, RadarrError, normalizeRadarrUrl, type RadarrMovie } from "./radarrClient";
import { canonicalTitleKey, setStoragePolicyTitles } from "./storagePolicies";
import { assertPathParentInside, withFilesystemTimeout } from "./filesystemSafety";
import type { MediaExpectation } from "./mediaIntegrity";

const tagSyncBatchSize = 50;
const monitorBatchSize = 50;
// Titles handled per pass; each takes all of its pending events at once.
const eventBatchSize = 10;
const pendingEventLimit = 2000;
const catalogRefreshIntervalMs = 30 * 60_000;
const historyRetentionMs = 30 * 86400_000;
const tagsSchema = z.array(z.string());

type StoredSettings = ArrStoredSettings;

interface Catalog {
  movies: RadarrMovie[];
  tags: Array<{ id: number; label: string }>;
}

class RadarrInstanceNotFound extends RadarrError {
  override readonly statusCode = 404;
  constructor() { super("This Radarr instance no longer exists. Reload the integration settings."); }
}

const store = createArrInstanceStore({ name: "Radarr", settingKey: "radarrInstances", lock: 781_889_451, sectionType: "movies", sectionTypeLabel: "Movies", error: (message) => new RadarrError(message), notFound: () => new RadarrInstanceNotFound(), normalizeUrl: normalizeRadarrUrl });
const { storedInstances, settings, writeSettings, locked, commitCurrent, candidateSettings, automaticMappings, assertSectionsAvailable, publicSettings, sectionOwner, webhookInstance } = store;
export const radarrWebhookSecretSchema = arrWebhookSecretSchema;
export const radarrInstanceIdSchema = store.instanceIdSchema;
export const radarrInstanceNameSchema = store.instanceNameSchema;
export const radarrSettingsSchema = store.settingsSchema;
type MovieRow = typeof schema.radarrMovies.$inferSelect;
const mapLimit = arrMapLimit;
const digest = arrDigest;
const sameMappings = sameArrMappings;
const policyLookup = arrPolicyLookup;
const policyMarkers = arrPolicyMarkers;
const policyTag = arrPolicyTag;
const currentPolicy = arrCurrentPolicy;
const retryAt = arrRetryAt;
export const radarrTagPolicy = arrTagPolicy;

const forInstance = (config: Pick<StoredSettings, "id">) => eq(schema.radarrMovies.instanceId, config.id);

function client(config: StoredSettings): RadarrClient {
  if (!config.apiKey || !config.baseUrl) throw new RadarrError("Save a Radarr connection first.");
  return new RadarrClient(config.baseUrl, config.apiKey);
}

function parseTags(value: string): string[] { return tagsSchema.parse(JSON.parse(value)); }

async function inspectConnection(db: Db, config: StoredSettings): Promise<RadarrConnectionTest> {
  const connection = await client(config).test();
  const { mappings, conflicts } = await automaticMappings(db, config.id, connection.rootFolders);
  const matched = new Set([...mappings, ...conflicts].map((mapping) => mapping.rootPath));
  return { ...connection, automaticMappings: mappings, unmatchedRootFolders: connection.rootFolders.filter((root) => !matched.has(root)), conflictingRootFolders: conflicts };
}

export async function testRadarrConnection(db: Db, instanceId: string, input: RadarrSettingsInput): Promise<RadarrConnectionTest> {
  return inspectConnection(db, await candidateSettings(db, await settings(db, instanceId), input));
}

export function mapRadarrMovie(movie: RadarrMovie, config: Pick<StoredSettings, "mappings">): ScanTitleScope | null {
  if (!arrAbsolutePath.safeParse(movie.path).success) return null;
  const mapping = config.mappings.find((entry) => path.posix.dirname(movie.path) === entry.rootPath);
  const itemName = path.posix.basename(movie.path);
  if (!mapping || !itemName || itemName === "." || itemName === "..") return null;
  const tmdb = itemName.match(/\{tmdb-(\d+)\}/i);
  if (tmdb && Number(tmdb[1]) !== movie.tmdbId) return null;
  return { section: mapping.section, itemName };
}

// Titles whose Radarr tags already carry a policy other than `policy`. A default assignment leaves these for review.
export async function radarrTagConflictTitles(db: Db, itemNames: string[], policy: StoragePolicyKind): Promise<Set<string>> {
  const conflicts = new Set<string>();
  if (!itemNames.length) return conflicts;
  for (const config of (await storedInstances(db)).instances) {
    if (!config.enabled || !config.localTag || !config.remoteTag) continue;
    for (let offset = 0; offset < itemNames.length; offset += 500) {
      const rows = await db.select().from(schema.radarrMovies).where(and(forInstance(config), inArray(schema.radarrMovies.itemName, itemNames.slice(offset, offset + 500))));
      for (const row of rows) {
        const tagPolicy = radarrTagPolicy(parseTags(row.tags), config);
        if (row.itemName && tagPolicy !== "unassigned" && tagPolicy !== policy) conflicts.add(canonicalTitleKey(row.itemName));
      }
    }
  }
  return conflicts;
}

function movieIdsIn(config: Pick<StoredSettings, "id">, movieIds: number[]) {
  return and(forInstance(config), inArray(schema.radarrMovies.movieId, movieIds));
}

async function storeMovies(db: Db, movies: RadarrMovie[], tags: Catalog["tags"], config: StoredSettings): Promise<void> {
  const tagLabels = new Map(tags.map((tag) => [tag.id, tag.label]));
  const paths = new Map<string, number>();
  for (const movie of movies) paths.set(movie.path, (paths.get(movie.path) ?? 0) + 1);
  const sameIdentity = sql`radarr_movies.tmdb_id = excluded.tmdb_id AND radarr_movies.section IS NOT DISTINCT FROM excluded.section AND radarr_movies.item_name IS NOT DISTINCT FROM excluded.item_name`;
  for (let offset = 0; offset < movies.length; offset += 100) {
    const values = movies.slice(offset, offset + 100).map((movie) => {
      const scope = paths.get(movie.path) === 1 ? mapRadarrMovie(movie, config) : null;
      return { instanceId: config.id, movieId: movie.id, tmdbId: movie.tmdbId, title: `${movie.title} (${movie.year})`, folderPath: movie.path, section: scope?.section ?? null, itemName: scope?.itemName ?? null, tags: JSON.stringify(movie.tags.map((id) => tagLabels.get(id)).filter((label): label is string => Boolean(label))), monitored: movie.monitored ?? null };
    });
    await db.insert(schema.radarrMovies).values(values).onConflictDoUpdate({ target: [schema.radarrMovies.instanceId, schema.radarrMovies.movieId], set: {
      title: sql`excluded.title`, folderPath: sql`excluded.folder_path`, section: sql`excluded.section`, itemName: sql`excluded.item_name`, tags: sql`excluded.tags`, tmdbId: sql`excluded.tmdb_id`, monitored: sql`excluded.monitored`,
      managed: sql`radarr_movies.managed AND ${sameIdentity}`,
      observedPolicyMarker: sql`CASE WHEN ${sameIdentity} THEN radarr_movies.observed_policy_marker ELSE NULL END`,
      syncedPolicy: sql`CASE WHEN radarr_movies.tags = excluded.tags AND radarr_movies.tmdb_id = excluded.tmdb_id AND radarr_movies.folder_path = excluded.folder_path THEN radarr_movies.synced_policy ELSE NULL END`
    } });
  }
}

async function fetchCatalog(config: StoredSettings): Promise<Catalog> {
  const connection = client(config);
  const movies = await connection.movies();
  return { movies, tags: await connection.tags() };
}

async function applyCatalog(db: Db, catalog: Catalog, config: StoredSettings): Promise<void> {
  await storeMovies(db, catalog.movies, catalog.tags, config);
  const ids = catalog.movies.map((movie) => movie.id);
  await db.delete(schema.radarrMovies).where(and(forInstance(config), ids.length ? sql`movie_id NOT IN (SELECT jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb)::integer)` : sql`true`));
}

async function refreshCatalog(db: Db, config: StoredSettings, resetRetries: boolean): Promise<void> {
  let catalog: Catalog;
  try {
    catalog = await fetchCatalog(config);
  } catch (error) {
    if (!(error instanceof RadarrError)) throw error;
    await commitCurrent(db, config, (transaction, current) => writeSettings(transaction, { ...current, lastError: error.message }));
    return;
  }
  await commitCurrent(db, config, async (transaction, current) => {
    await applyCatalog(transaction, catalog, current);
    if (resetRetries) await transaction.update(schema.radarrMovies).set({ nextAttemptAt: null, attempts: 0 }).where(forInstance(current));
    await writeSettings(transaction, { ...current, lastRefreshAt: nowIso(), lastError: null });
  });
}

export async function getRadarrOverview(db: Db): Promise<RadarrOverview> {
  const stored = await storedInstances(db);
  const counts = await dbAll<{ instance_id: string; movies: number; mapped: number; review: number; errors: number }>(db, sql`
    select instance_id, count(*)::int as movies,
      count(*) filter (where section is not null and item_name is not null)::int as mapped,
      count(*) filter (where section is not null and item_name is not null and not managed)::int as review,
      count(*) filter (where section is not null and item_name is not null and managed and last_error is not null)::int as errors
    from radarr_movies group by instance_id`);
  return {
    limit: radarrInstanceLimit,
    instances: stored.instances.map((config) => {
      const count = counts.find((row) => row.instance_id === config.id);
      return { settings: publicSettings(config, stored), movies: count?.movies ?? 0, mapped: count?.mapped ?? 0, review: count?.review ?? 0, errors: count?.errors ?? 0 };
    })
  };
}

export async function createRadarrInstance(db: Db, name: string): Promise<RadarrState> {
  return getRadarrState(db, await store.createInstance(db, name));
}

export async function renameRadarrInstance(db: Db, instanceId: string, name: string): Promise<RadarrOverview> {
  await store.renameInstance(db, instanceId, name);
  return getRadarrOverview(db);
}

// Removal forgets SRTL's own records only. Tags and monitoring in Radarr stay as they are.
export async function removeRadarrInstance(db: Db, instanceId: string): Promise<RadarrOverview> {
  await store.removeInstance(db, instanceId, async (transaction) => {
    await transaction.delete(schema.radarrMovies).where(eq(schema.radarrMovies.instanceId, instanceId));
    await transaction.delete(schema.radarrEvents).where(eq(schema.radarrEvents.instanceId, instanceId));
    await transaction.delete(schema.radarrMonitorUpdates).where(eq(schema.radarrMonitorUpdates.instanceId, instanceId));
    await transaction.delete(schema.radarrCopyJobs).where(eq(schema.radarrCopyJobs.instanceId, instanceId));
  });
  return getRadarrOverview(db);
}

export async function saveRadarrSettings(db: Db, instanceId: string, input: RadarrSettingsInput): Promise<RadarrState> {
  const old = await settings(db, instanceId);
  const next = await candidateSettings(db, old, input);
  const sameConnection = old.baseUrl === next.baseUrl && old.localTag === next.localTag && old.remoteTag === next.remoteTag && old.mappingMode === next.mappingMode && sameMappings(old.mappings, next.mappings) && old.apiKey === next.apiKey && old.webhookSecretHash === next.webhookSecretHash;
  // Pausing must still work if Radarr is offline, without accepting new mappings.
  if (sameConnection && !next.enabled && (old.enabled || next.mappingMode === "manual")) {
    const saved = await commitCurrent(db, next, async (transaction, current) => {
      await writeSettings(transaction, { ...next, name: current.name, revision: next.revision + 1 });
      return true;
    });
    if (!saved) throw new RadarrError("Radarr settings changed. Reload before saving.");
    return getRadarrState(db, instanceId);
  }
  const connection = await inspectConnection(db, next);
  if (next.mappingMode === "auto") next.mappings = connection.automaticMappings;
  if (next.enabled && !next.mappings.length) throw new RadarrError(next.mappingMode === "auto" ? "No exact folder matches found. Use Manual mapping before enabling Radarr." : "Add a folder mapping before enabling Radarr.");
  const catalog = await fetchCatalog(next);
  const saved = await commitCurrent(db, next, async (transaction, current) => {
    // Another instance may have claimed a folder while Radarr was being read.
    await assertSectionsAvailable(transaction, next);
    const identityChanged = current.baseUrl !== next.baseUrl || current.localTag !== next.localTag || current.remoteTag !== next.remoteTag || !sameMappings(current.mappings, next.mappings);
    if (identityChanged) {
      if (current.baseUrl !== next.baseUrl) {
        await transaction.delete(schema.radarrMovies).where(forInstance(current));
        await transaction.delete(schema.radarrEvents).where(eq(schema.radarrEvents.instanceId, current.id));
        await transaction.delete(schema.radarrMonitorUpdates).where(eq(schema.radarrMonitorUpdates.instanceId, current.id));
      } else {
        await transaction.update(schema.radarrMovies).set({ managed: false, syncedPolicy: null, observedPolicyMarker: null }).where(forInstance(current));
      }
    }
    next.revision += 1;
    await applyCatalog(transaction, catalog, next);
    await writeSettings(transaction, { ...next, name: current.name, lastRefreshAt: nowIso(), lastError: null });
    return true;
  });
  if (!saved) throw new RadarrError("Radarr settings changed. Reload before saving.");
  return getRadarrState(db, instanceId);
}

export async function refreshRadarr(db: Db, instanceId: string): Promise<RadarrState> {
  await refreshCatalog(db, await settings(db, instanceId), true);
  return getRadarrState(db, instanceId);
}

export async function getRadarrCopyDefaults(db: Db): Promise<RadarrCopyDefaults> {
  return store.copyDefaults(db);
}

// Radarr's recorded size and runtime for the exact file a link points to, used to reject partial or sample files before copying.
export async function radarrMediaExpectation(db: Db, link: Pick<MediaLinkRow, "section" | "itemName" | "relativePath">): Promise<MediaExpectation | undefined> {
  const config = sectionOwner(await storedInstances(db), link.section);
  if (!config?.enabled || !config.apiKey) return undefined;
  const row = await first(db.select().from(schema.radarrMovies).where(and(forInstance(config), eq(schema.radarrMovies.section, link.section), eq(schema.radarrMovies.itemName, link.itemName))).limit(1));
  if (!row) return undefined;
  const movie = await client(config).movie(row.movieId);
  const scope = mapRadarrMovie(movie, config);
  if (movie.tmdbId !== row.tmdbId || scope?.section !== link.section || scope.itemName !== link.itemName) return undefined;
  // Extras and samples share the title folder; only Radarr's own movie file has a known size and runtime.
  if (!movie.movieFile || path.posix.basename(movie.movieFile.relativePath) !== path.posix.basename(link.relativePath)) return undefined;
  return {
    source: config.name,
    ...(movie.movieFile.size ? { sizeBytes: movie.movieFile.size } : {}),
    ...(movie.runtime ? { runtimeSeconds: movie.runtime * 60 } : {})
  };
}

export async function getRadarrState(db: Db, instanceId: string): Promise<RadarrState> {
  const stored = await storedInstances(db);
  const config = stored.instances.find((instance) => instance.id === instanceId);
  if (!config) throw new RadarrInstanceNotFound();
  const policies = await policyLookup(db);
  const rows = await db.select().from(schema.radarrMovies).where(forInstance(config)).orderBy(asc(schema.radarrMovies.title), asc(schema.radarrMovies.movieId));
  const movies: RadarrMovieStatus[] = rows.map((row) => {
    const tags = parseTags(row.tags);
    const policy = currentPolicy(row, policies);
    const tagPolicy = radarrTagPolicy(tags, config);
    const status = !row.section || !row.itemName ? "unmapped" : !row.managed ? "review" : row.lastError ? "error" : row.syncedPolicy === policy && tagPolicy === policy ? "synced" : "pending";
    return { movieId: row.movieId, tmdbId: row.tmdbId, title: row.title, folderPath: row.folderPath, section: row.section, itemName: row.itemName, tags, monitored: row.monitored, policy, tagPolicy, managed: row.managed, status, message: row.lastError, syncedAt: row.syncedAt };
  });
  const events = await db.select({ id: schema.radarrEvents.id, movieId: schema.radarrEvents.movieId, title: schema.radarrEvents.title, eventType: schema.radarrEvents.eventType, receivedAt: schema.radarrEvents.receivedAt, processedAt: schema.radarrEvents.processedAt, error: schema.radarrEvents.error, jobId: schema.radarrEvents.jobId, jobStatus: schema.jobs.status }).from(schema.radarrEvents).leftJoin(schema.jobs, eq(schema.jobs.id, schema.radarrEvents.jobId)).where(eq(schema.radarrEvents.instanceId, config.id)).orderBy(desc(schema.radarrEvents.id)).limit(100);
  const monitorUpdates = await db.select({ id: schema.radarrMonitorUpdates.id, movieId: schema.radarrMonitorUpdates.movieId, title: schema.radarrMonitorUpdates.title, monitored: schema.radarrMonitorUpdates.monitored, copyJobId: schema.radarrMonitorUpdates.copyJobId, createdAt: schema.radarrMonitorUpdates.createdAt, processedAt: schema.radarrMonitorUpdates.processedAt, error: schema.radarrMonitorUpdates.error }).from(schema.radarrMonitorUpdates).where(eq(schema.radarrMonitorUpdates.instanceId, config.id)).orderBy(desc(schema.radarrMonitorUpdates.id)).limit(100);
  return {
    settings: publicSettings(config, stored),
    movies,
    events: events.map((event) => ({ ...event, jobStatus: event.jobStatus as JobStatus | null })),
    monitorUpdates
  };
}

export async function reconcileRadarrMovies(db: Db, instanceId: string, movieIds: number[], action: "use_srtl" | "import_tags"): Promise<RadarrState> {
  const config = await settings(db, instanceId);
  if (!config.localTag || !config.remoteTag) throw new RadarrError("Choose and save both policy tags before reconciling titles.");
  const rows = await db.select().from(schema.radarrMovies).where(movieIdsIn(config, movieIds));
  if (rows.length !== new Set(movieIds).size || rows.some((row) => !row.section || !row.itemName)) throw new RadarrError("Select mapped titles before reconciling policies.");
  const connection = client(config);
  const tags = await connection.tags();
  // Re-read selected records so a stale preview cannot import an outdated tag or changed movie identity.
  const catalog = new Map((await connection.movies()).map((movie) => [movie.id, movie]));
  const refreshed: RadarrMovie[] = [];
  for (const row of rows) {
    const movie = catalog.get(row.movieId);
    if (!movie) throw new RadarrError("A movie was removed from Radarr. Refresh the preview before continuing.");
    const scope = mapRadarrMovie(movie, config);
    if (!scope || movie.tmdbId !== row.tmdbId || scope.section !== row.section || scope.itemName !== row.itemName) throw new RadarrError("A movie mapping changed. Refresh the preview before continuing.");
    refreshed.push(movie);
  }
  const applied = await commitCurrent(db, config, async (transaction) => {
    await storeMovies(transaction, refreshed, tags, config);
    const policies = await policyLookup(transaction);
    const selected = await transaction.select().from(schema.radarrMovies).where(movieIdsIn(config, movieIds));
    if (action === "import_tags") {
      const groups = new Map<StoragePolicyKind, string[]>();
      const assignments = new Map<string, StoragePolicyKind>();
      for (const row of selected) {
        const tagPolicy = radarrTagPolicy(parseTags(row.tags), config);
        const policy = currentPolicy(row, policies);
        if (tagPolicy === "conflict" || tagPolicy === "unassigned" || (policy !== "unassigned" && policy !== tagPolicy)) throw new RadarrError("Only unassigned or matching titles with one policy tag can be imported. Resolve conflicting assignments in SRTL first.");
        const key = canonicalTitleKey(row.itemName!);
        if (assignments.has(key) && assignments.get(key) !== tagPolicy) throw new RadarrError("Selected copies of the same title have conflicting policy tags.");
        assignments.set(key, tagPolicy);
        groups.set(tagPolicy, [...(groups.get(tagPolicy) ?? []), row.itemName!]);
      }
      await withResourceMutationGuard(transaction, async (guarded) => {
        const latest = await policyLookup(guarded);
        for (const row of selected) {
          const existing = currentPolicy(row, latest);
          if (existing !== "unassigned" && existing !== assignments.get(canonicalTitleKey(row.itemName!))) {
            throw new RadarrError("SRTL policies changed during review. Refresh before importing tags.");
          }
        }
        return {
          resources: [
            ...await storagePolicyMutationResources(guarded, selected.map((row) => row.itemName!)),
            ...selected.map((row) => ({ resourceType: "title", resourceKey: JSON.stringify([row.section, row.itemName]) }))
          ],
          mutate: async () => {
            for (const [policy, titles] of groups) await setStoragePolicyTitles(guarded, titles, policy, { source: "radarr" });
          }
        };
      });
    }
    await transaction.update(schema.radarrMovies).set({ managed: true, syncedPolicy: null, lastError: null, attempts: 0, nextAttemptAt: null }).where(movieIdsIn(config, movieIds));
    return true;
  });
  if (!applied) throw new RadarrError("Radarr settings changed. Reload before continuing.");
  return getRadarrState(db, instanceId);
}

export async function authenticateRadarrWebhook(db: Db, instanceId: string | null, token: string | undefined): Promise<boolean> {
  return store.authenticateWebhook(db, instanceId, token);
}

const webhookSchema = z.object({
  eventType: z.enum(["Test", "Download", "Rename", "MovieDelete", "MovieFileDelete", "MovieAdded"]),
  movie: z.object({ id: z.number().int().positive(), title: z.string().max(1000) }).optional(),
  movieFile: z.object({ id: z.number().int().positive().optional(), relativePath: z.string().max(4096).optional() }).optional(),
  isUpgrade: z.boolean().optional(),
  deleteReason: z.string().max(200).optional(),
  renamedMovieFiles: z.array(z.object({ previousRelativePath: z.string().max(4096).optional(), relativePath: z.string().max(4096).optional() })).max(100).optional()
});

export async function receiveRadarrWebhook(db: Db, instanceId: string | null, payload: unknown): Promise<{ accepted: boolean; duplicate?: boolean }> {
  const body = webhookSchema.parse(payload);
  if (body.eventType === "Test") return { accepted: true };
  if (!body.movie) throw new RadarrError("Webhook is missing its movie identifier.");
  const config = await webhookInstance(db, instanceId);
  if (!config) throw new RadarrInstanceNotFound();
  if (!config.enabled) throw new RadarrError("Radarr integration is paused.");
  const timestamp = nowIso();
  const fingerprint = digest(`${config.baseUrl}:${JSON.stringify(body)}`);
  const cutoff = new Date(Date.now() - 60_000).toISOString();
  const inserted = await db.insert(schema.radarrEvents).values({ instanceId: config.id, fingerprint, movieId: body.movie.id, title: body.movie.title, eventType: body.eventType, receivedAt: timestamp, nextAttemptAt: new Date(Date.now() + 3000).toISOString() }).onConflictDoUpdate({ target: [schema.radarrEvents.instanceId, schema.radarrEvents.fingerprint], set: { receivedAt: timestamp, processedAt: null, nextAttemptAt: new Date(Date.now() + 3000).toISOString(), attempts: 0, error: null, jobId: null }, setWhere: and(sql`radarr_events.received_at < ${cutoff}`, sql`radarr_events.processed_at IS NOT NULL`) }).returning({ id: schema.radarrEvents.id });
  return { accepted: true, duplicate: inserted.length === 0 };
}

type RadarrEvent = typeof schema.radarrEvents.$inferSelect;

const addedOnlyMessage = "Added to the catalog. No rescan queued: the title folder has no media yet.";

// All pending events of one movie are handled together, so a burst becomes one rescan of the title.
async function processMovieEvents(db: Db, config: StoredSettings, events: RadarrEvent[]): Promise<void> {
  const movieId = events[0]!.movieId;
  const eventIds = events.map((event) => event.id);
  const markProcessed = (transaction: Db, error: string | null, jobId: number | null = null) => transaction.update(schema.radarrEvents).set({ processedAt: nowIso(), error, jobId }).where(inArray(schema.radarrEvents.id, eventIds));
  const old = await first(db.select().from(schema.radarrMovies).where(movieIdsIn(config, [movieId])).limit(1));
  const scopes: ScanTitleScope[] = [];
  if (old?.section && old.itemName) scopes.push({ section: old.section, itemName: old.itemName });
  // Radarr no longer knows a deleted movie, so its stored folder is the only scope left.
  const deleted = events[events.length - 1]!.eventType === "MovieDelete";
  let fetched: { movie: RadarrMovie; tags: Catalog["tags"] } | null = null;
  if (!deleted) {
    const connection = client(config);
    const movie = await connection.movie(movieId);
    const scope = mapRadarrMovie(movie, config);
    if (!scope) {
      await commitCurrent(db, config, (transaction) => markProcessed(transaction, "Ignored: movie is outside the configured folder mappings."));
      return;
    }
    if (old && old.tmdbId !== movie.tmdbId) throw new RadarrError("Movie identifier changed. Refresh and review its mapping.");
    const paths = await getJsonSetting<PathsSettings>(db, "paths", { symlinkDir: "", localDir: "", remoteDir: "" });
    if (events.some((event) => event.eventType === "Download")) {
      const relative = movie.movieFile?.relativePath;
      if (!relative || path.posix.isAbsolute(relative) || relative.split(/[\\/]/).some((part) => part === ".." || part === "." || part === "")) throw new RadarrError("Radarr has not reported a usable imported file yet.");
      const filePath = path.join(paths.symlinkDir, scope.section, scope.itemName, relative);
      try { await assertPathParentInside(paths.symlinkDir, filePath, "Imported symlink"); }
      catch { throw new RadarrError("Mapped title directory is unavailable or resolves outside the symlink root."); }
      const stat = await withFilesystemTimeout(fs.lstat(filePath), "Imported symlink check").catch(() => null);
      if (!stat?.isSymbolicLink()) throw new RadarrError("Imported symlink is not available at the mapped path yet. Waiting to rescan.");
    }
    fetched = { movie, tags: await connection.tags() };
    // A movie added without a file has nothing to scan; its Download event does the real rescan.
    if (events.every((event) => event.eventType === "MovieAdded") && !await arrTitleHasMediaSymlinks(paths.symlinkDir, scope)) {
      await commitCurrent(db, config, async (transaction) => {
        await storeMovies(transaction, [movie], fetched!.tags, config);
        await markProcessed(transaction, addedOnlyMessage);
      });
      return;
    }
    if (!scopes.some((entry) => entry.section === scope.section && entry.itemName === scope.itemName)) scopes.push(scope);
  }
  await commitCurrent(db, config, async (transaction) => {
    if (fetched) await storeMovies(transaction, [fetched.movie], fetched.tags, config);
    if (!scopes.length) {
      await markProcessed(transaction, "Ignored: no confirmed SRTL mapping is available for this event.");
      return;
    }
    const jobId = await new JobRunner(transaction).startExternalTitleScan(scopes);
    await transaction.insert(schema.jobEvents).values({ jobId, timestamp: nowIso(), level: "info", message: arrRefreshMessage(config.name, events.length), data: JSON.stringify({ instanceId: config.id, movieId, eventTypes: [...new Set(events.map((event) => event.eventType))], events: events.length }) });
    await markProcessed(transaction, null, jobId);
    if (deleted) await transaction.delete(schema.radarrMovies).where(movieIdsIn(config, [movieId]));
  });
}

async function processEvents(db: Db, config: StoredSettings): Promise<void> {
  const pending = await db.select().from(schema.radarrEvents).where(and(eq(schema.radarrEvents.instanceId, config.id), isNull(schema.radarrEvents.processedAt))).orderBy(asc(schema.radarrEvents.id)).limit(pendingEventLimit);
  for (const events of arrReadyEventGroups(pending, (event) => event.movieId).slice(0, eventBatchSize)) {
    try { await processMovieEvents(db, config, events); }
    catch (error) {
      const message = error instanceof RadarrError ? error.message : "Title refresh could not be queued. It will retry after active work or storage maintenance finishes.";
      for (const event of events) await db.update(schema.radarrEvents).set({ error: message, attempts: event.attempts + 1, nextAttemptAt: retryAt(event.attempts) }).where(eq(schema.radarrEvents.id, event.id));
    }
  }
}

// A policy change made in SRTL always takes over the title's tags. Titles seen for the first time join
// automatically unless Radarr already carries the opposite policy tag, which stays in review.
async function observePolicies(db: Db, config: StoredSettings): Promise<void> {
  await commitCurrent(db, config, async (transaction) => {
    const policies = await policyLookup(transaction);
    const markers = await policyMarkers(transaction);
    const rows = await transaction.select().from(schema.radarrMovies).where(forInstance(config));
    const groups = new Map<string, { marker: string; managed: boolean; movieIds: number[] }>();
    for (const row of rows) {
      if (!row.section || !row.itemName) continue;
      const marker = markers.get(canonicalTitleKey(row.itemName)) ?? "unassigned";
      if (row.observedPolicyMarker === marker) continue;
      const tagPolicy = radarrTagPolicy(parseTags(row.tags), config);
      const managed = row.managed || row.observedPolicyMarker !== null || tagPolicy === "unassigned" || tagPolicy === currentPolicy(row, policies);
      const key = `${marker}\0${managed}`;
      const group = groups.get(key) ?? { marker, managed, movieIds: [] };
      group.movieIds.push(row.movieId);
      groups.set(key, group);
    }
    for (const group of groups.values()) {
      for (let offset = 0; offset < group.movieIds.length; offset += 1000) {
        await transaction.update(schema.radarrMovies).set({ observedPolicyMarker: group.marker, managed: group.managed }).where(movieIdsIn(config, group.movieIds.slice(offset, offset + 1000)));
      }
    }
  });
}

type TagOutcome = { movieId: number; policy: StoragePolicyKind; labels?: string[]; error?: string };

async function pushTags(config: StoredSettings, rows: MovieRow[], policies: Map<string, StoragePolicyKind>): Promise<TagOutcome[]> {
  const connection = client(config);
  const tagList = await connection.tags();
  const tagId = (label: string) => tagList.find((tag) => tag.label === label)?.id;
  const policyTagIds = [tagId(config.localTag), tagId(config.remoteTag)].filter((id): id is number => id !== undefined);
  const outcomes: TagOutcome[] = [];
  const live = await mapLimit(rows, 5, async (row) => {
    const policy = currentPolicy(row, policies);
    try {
      const movie = await connection.movie(row.movieId);
      const scope = mapRadarrMovie(movie, config);
      if (movie.tmdbId !== row.tmdbId || scope?.section !== row.section || scope?.itemName !== row.itemName) throw new RadarrError("Radarr movie identity or path changed. Refresh and review its mapping.");
      return { movie, policy };
    } catch (error) {
      if (!(error instanceof RadarrError)) throw error;
      outcomes.push({ movieId: row.movieId, policy, error: error.message });
      return null;
    }
  });
  const ready = live.filter((entry) => entry !== null);
  const desiredIds = new Map<string, number>();
  for (const label of new Set(ready.map((entry) => policyTag(entry.policy, config)).filter((label) => label !== null))) {
    desiredIds.set(label, tagId(label) ?? await connection.ensureTag(label));
  }
  // Only the two configured policy tags are ever removed; every other tag on the movie is left alone.
  const removals = new Map<number, number[]>();
  const additions = new Map<number, number[]>();
  for (const { movie, policy } of ready) {
    const label = policyTag(policy, config);
    const desiredId = label ? desiredIds.get(label) : undefined;
    for (const id of policyTagIds) if (id !== desiredId && movie.tags.includes(id)) removals.set(id, [...(removals.get(id) ?? []), movie.id]);
    if (desiredId !== undefined && !movie.tags.includes(desiredId)) additions.set(desiredId, [...(additions.get(desiredId) ?? []), movie.id]);
  }
  const changed = new Set<number>();
  for (const [id, movieIds] of removals) { await connection.editTags(movieIds, [id], "remove"); movieIds.forEach((movieId) => changed.add(movieId)); }
  for (const [id, movieIds] of additions) { await connection.editTags(movieIds, [id], "add"); movieIds.forEach((movieId) => changed.add(movieId)); }
  const confirmedTags = changed.size ? await connection.tags() : tagList;
  const confirmed = await mapLimit(ready, 5, async ({ movie, policy }) => {
    try {
      const current = changed.has(movie.id) ? await connection.movie(movie.id) : movie;
      const labels = confirmedTags.filter((tag) => current.tags.includes(tag.id)).map((tag) => tag.label);
      if (radarrTagPolicy(labels, config) !== policy) throw new RadarrError("Radarr tags changed during synchronization. The worker will retry.");
      return { movieId: movie.id, policy, labels };
    } catch (error) {
      if (!(error instanceof RadarrError)) throw error;
      return { movieId: movie.id, policy, error: error.message };
    }
  });
  return [...outcomes, ...confirmed];
}

async function syncTags(db: Db, config: StoredSettings): Promise<void> {
  const policies = await policyLookup(db);
  const now = nowIso();
  const rows = await db.select().from(schema.radarrMovies).where(and(forInstance(config), eq(schema.radarrMovies.managed, true))).orderBy(asc(schema.radarrMovies.nextAttemptAt), asc(schema.radarrMovies.movieId));
  const pending = rows.filter((row) => row.section && row.itemName && (row.syncedPolicy !== currentPolicy(row, policies) || row.lastError) && (!row.nextAttemptAt || row.nextAttemptAt <= now));
  if (!pending.length) return;
  // Titles whose catalog tags already express their policy need no Radarr round trip.
  const alreadyTagged = pending.filter((row) => !row.lastError && radarrTagPolicy(parseTags(row.tags), config) === currentPolicy(row, policies));
  const work = pending.filter((row) => !alreadyTagged.includes(row)).slice(0, tagSyncBatchSize);
  let outcomes: TagOutcome[] = [];
  if (work.length) {
    try {
      outcomes = await pushTags(config, work, policies);
    } catch (error) {
      if (!(error instanceof RadarrError)) throw error;
      outcomes = work.map((row) => ({ movieId: row.movieId, policy: currentPolicy(row, policies), error: error.message }));
    }
  }
  const attempts = new Map(work.map((row) => [row.movieId, row.attempts]));
  await commitCurrent(db, config, async (transaction) => {
    const syncedAt = nowIso();
    for (const policy of ["location_1", "location_2", "unassigned"] as const) {
      const movieIds = alreadyTagged.filter((row) => currentPolicy(row, policies) === policy).map((row) => row.movieId);
      for (let offset = 0; offset < movieIds.length; offset += 1000) {
        await transaction.update(schema.radarrMovies).set({ syncedPolicy: policy, syncedAt, lastError: null, nextAttemptAt: null, attempts: 0 }).where(movieIdsIn(config, movieIds.slice(offset, offset + 1000)));
      }
    }
    for (const outcome of outcomes) {
      const update = outcome.labels
        ? { tags: JSON.stringify(outcome.labels), syncedPolicy: outcome.policy, syncedAt, lastError: null, nextAttemptAt: null, attempts: 0 }
        : { lastError: outcome.error ?? "Radarr tag update failed.", attempts: (attempts.get(outcome.movieId) ?? 0) + 1, nextAttemptAt: retryAt(attempts.get(outcome.movieId) ?? 0) };
      await transaction.update(schema.radarrMovies).set(update).where(movieIdsIn(config, [outcome.movieId]));
    }
  });
}

interface CopiedTitle { section: string; itemName: string }
interface CopiedMovie { movie: MovieRow; complete: boolean }

const titleKey = (title: CopiedTitle) => `${title.section}\0${title.itemName}`;
const notCopiedMessage = "Skipped: not every file of this movie finished copying.";
const rolledBackMessage = "Skipped: the copy was terminated and rolled back.";

// The instance's movies among the copied titles, each marked complete when every current file of it is at the destination.
// Each instance handles only the movies in folders it maps, so a copy across folders reaches every owning instance.
async function copiedMovies(db: Db, config: StoredSettings, titles: CopiedTitle[], destination: StorageRootType): Promise<CopiedMovie[]> {
  const keys = new Set(titles.map(titleKey));
  const sections = [...new Set(titles.map((title) => title.section))];
  if (!sections.length) return [];
  // Small selections, such as a single finished title, are looked up by name instead of reading whole sections.
  const itemNames = titles.length <= 500 ? [...new Set(titles.map((title) => title.itemName))] : null;
  const movies = (await db.select().from(schema.radarrMovies).where(and(forInstance(config), inArray(schema.radarrMovies.section, sections), itemNames ? inArray(schema.radarrMovies.itemName, itemNames) : undefined)))
    .filter((movie) => movie.section !== null && movie.itemName !== null && keys.has(titleKey({ section: movie.section, itemName: movie.itemName })));
  if (!movies.length) return [];
  const links = await db.select({ section: schema.mediaLinks.section, itemName: schema.mediaLinks.itemName, kind: schema.mediaLinks.kind }).from(schema.mediaLinks)
    .where(and(inArray(schema.mediaLinks.section, sections), itemNames ? inArray(schema.mediaLinks.itemName, itemNames) : undefined, eq(schema.mediaLinks.isMedia, true), isNull(schema.mediaLinks.missingSince)));
  return movies.map((movie) => {
    const titleLinks = links.filter((link) => link.section === movie.section && link.itemName === movie.itemName);
    return { movie, complete: titleLinks.length > 0 && titleLinks.every((link) => link.kind === destination) };
  });
}

function copyMonitorUpdate(config: StoredSettings, copyJobId: number, movie: MovieRow, monitored: boolean, timestamp: string): typeof schema.radarrMonitorUpdates.$inferInsert {
  return { instanceId: config.id, copyJobId, movieId: movie.movieId, title: movie.title, monitored, previousMonitored: movie.monitored, createdAt: timestamp, nextAttemptAt: timestamp };
}

// The copy worker calls this as soon as a title's files are committed, so a long batch changes each movie's monitoring
// within seconds of it being safe instead of when the whole job ends. Titles not yet complete are left for later calls
// and for the end-of-job pass. Every (job, instance, movie) is queued at most once, so repeated calls are harmless.
export async function queueCopiedTitleMonitorUpdates(db: Db, copy: { jobId: number; direction: CopyOptions["direction"] }, titles: CopiedTitle[]): Promise<void> {
  if (!titles.length) return;
  const monitored = copy.direction === "to_remote";
  await locked(db, async (transaction) => {
    const timestamp = nowIso();
    for (const config of (await storedInstances(transaction)).instances) {
      if (!config.enabled || copy.jobId <= config.copyJobFloor) continue;
      const complete = (await copiedMovies(transaction, config, titles, monitored ? "remote" : "local")).filter((entry) => entry.complete);
      if (complete.length) await transaction.insert(schema.radarrMonitorUpdates).values(complete.map(({ movie }) => copyMonitorUpdate(config, copy.jobId, movie, monitored, timestamp))).onConflictDoNothing();
    }
  });
}

// Once a requested copy ends, this pass queues anything the per-title calls missed and records titles that did not fully copy.
// A terminated copy rolls its files back to the source, so monitoring already changed for them is put back as it was.
async function queueCopyMonitorUpdates(db: Db, config: StoredSettings): Promise<void> {
  const copyJobs = (await db.execute<{ id: number; options: string }>(sql`
    select jobs.id, jobs.options from jobs
    where jobs.type = 'copy' and jobs.status in ('completed', 'partially_failed', 'failed', 'cancelled')
      and jobs.id > ${config.copyJobFloor}
      and jobs.options::jsonb ->> 'radarrMonitoring' = 'true'
      and not exists (select 1 from radarr_copy_jobs handled where handled.job_id = jobs.id and handled.instance_id = ${config.id})
    order by jobs.id limit 20`)).rows;
  for (const job of copyJobs) {
    await commitCurrent(db, config, async (transaction) => {
      const monitored = (JSON.parse(job.options) as { direction?: string }).direction === "to_remote";
      const titles = await transaction.selectDistinct({ section: schema.jobSelectionItems.section, itemName: schema.jobSelectionItems.itemName }).from(schema.jobSelectionItems).where(eq(schema.jobSelectionItems.jobId, job.id));
      const movies = await copiedMovies(transaction, config, titles, monitored ? "remote" : "local");
      const queued = new Map((await transaction.select().from(schema.radarrMonitorUpdates)
        .where(and(eq(schema.radarrMonitorUpdates.instanceId, config.id), eq(schema.radarrMonitorUpdates.copyJobId, job.id), eq(schema.radarrMonitorUpdates.monitored, monitored))))
        .map((update) => [update.movieId, update]));
      const rolledBack = new Set((await transaction.selectDistinct({ section: schema.mediaLinks.section, itemName: schema.mediaLinks.itemName }).from(schema.copyOperations)
        .innerJoin(schema.mediaLinks, eq(schema.mediaLinks.id, schema.copyOperations.mediaLinkId))
        .where(and(eq(schema.copyOperations.jobId, job.id), eq(schema.copyOperations.stage, "rolled_back")))).map(titleKey));
      const timestamp = nowIso();
      const updates: Array<typeof schema.radarrMonitorUpdates.$inferInsert> = [];
      for (const { movie, complete } of movies) {
        const update = queued.get(movie.movieId);
        if (!update) {
          updates.push({ ...copyMonitorUpdate(config, job.id, movie, monitored, timestamp), ...(complete ? {} : { processedAt: timestamp, error: notCopiedMessage }) });
          continue;
        }
        if (complete || update.error?.startsWith("Skipped") || !rolledBack.has(titleKey({ section: movie.section!, itemName: movie.itemName! }))) continue;
        if (!update.processedAt) {
          await transaction.update(schema.radarrMonitorUpdates).set({ processedAt: timestamp, error: rolledBackMessage }).where(eq(schema.radarrMonitorUpdates.id, update.id));
        } else if (update.previousMonitored === !monitored) {
          updates.push(copyMonitorUpdate(config, job.id, movie, !monitored, timestamp));
        }
      }
      if (updates.length) await transaction.insert(schema.radarrMonitorUpdates).values(updates).onConflictDoNothing();
      await transaction.insert(schema.radarrCopyJobs).values({ instanceId: config.id, jobId: job.id, handledAt: timestamp }).onConflictDoNothing();
    });
  }
}

async function applyMonitorUpdates(db: Db, config: StoredSettings): Promise<void> {
  const due = await db.select().from(schema.radarrMonitorUpdates).where(and(eq(schema.radarrMonitorUpdates.instanceId, config.id), isNull(schema.radarrMonitorUpdates.processedAt), lte(schema.radarrMonitorUpdates.nextAttemptAt, nowIso()))).orderBy(asc(schema.radarrMonitorUpdates.id)).limit(monitorBatchSize);
  if (!due.length) return;
  const results = new Map<boolean, string | null>();
  for (const monitored of [false, true]) {
    const movieIds = [...new Set(due.filter((update) => update.monitored === monitored).map((update) => update.movieId))];
    if (!movieIds.length) continue;
    try {
      await client(config).setMonitored(movieIds, monitored);
      results.set(monitored, null);
    } catch (error) {
      if (!(error instanceof RadarrError)) throw error;
      results.set(monitored, error.message);
    }
  }
  await commitCurrent(db, config, async (transaction) => {
    const timestamp = nowIso();
    for (const update of due) {
      const error = results.get(update.monitored);
      if (error) {
        await transaction.update(schema.radarrMonitorUpdates).set({ error, attempts: update.attempts + 1, nextAttemptAt: retryAt(update.attempts) }).where(eq(schema.radarrMonitorUpdates.id, update.id));
        continue;
      }
      await transaction.update(schema.radarrMonitorUpdates).set({ processedAt: timestamp, error: null }).where(eq(schema.radarrMonitorUpdates.id, update.id));
      await transaction.update(schema.radarrMovies).set({ monitored: update.monitored }).where(movieIdsIn(config, [update.movieId]));
      if (update.copyJobId) {
        await transaction.insert(schema.jobEvents).values({ jobId: update.copyJobId, timestamp, level: "info", message: `${update.monitored ? "Monitored" : "Unmonitored"} in ${config.name}: ${update.title}`, data: JSON.stringify({ instanceId: config.id, movieId: update.movieId, monitored: update.monitored }) });
      }
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
  await applyMonitorUpdates(db, config);
  await observePolicies(db, config);
  await syncTags(db, config);
  if (!config.lastRefreshAt || Date.now() - Date.parse(config.lastRefreshAt) > catalogRefreshIntervalMs) await refreshCatalog(db, config, false);
}

// Starts work for every enabled instance that is not already running and returns without waiting for it,
// so a slow or offline Radarr never holds back the others. Finished runs remove themselves from `running`.
export async function startRadarrWork(db: Db, running: Map<string, Promise<void>>, onError: (instanceName: string, error: unknown) => void): Promise<void> {
  const { instances } = await storedInstances(db);
  if (!instances.some((instance) => instance.enabled) || !(await isOnboardingComplete(db)) || await isPathConfigurationBlocked(db)) return;
  for (const instance of instances) {
    if (!instance.enabled || running.has(instance.id)) continue;
    running.set(instance.id, processInstance(db, instance.id)
      .catch((error: unknown) => onError(instance.name, error))
      .finally(() => running.delete(instance.id)));
  }
  const cutoff = new Date(Date.now() - historyRetentionMs).toISOString();
  await db.delete(schema.radarrEvents).where(sql`processed_at < ${cutoff}`);
  await db.delete(schema.radarrMonitorUpdates).where(sql`processed_at < ${cutoff}`);
}

// Runs one pass for every enabled instance and waits for all of them. A failure is reported after the others finish.
export async function processRadarrWork(db: Db): Promise<void> {
  const running = new Map<string, Promise<void>>();
  const errors: unknown[] = [];
  await startRadarrWork(db, running, (_name, error) => errors.push(error));
  await Promise.all([...running.values()]);
  if (errors.length) throw errors[0];
}
