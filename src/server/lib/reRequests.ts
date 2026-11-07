import path from "node:path";
import { and, asc, count, desc, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import { normalizeAdvancedSettings } from "../../shared/advancedSettings";
import type { ReRequestList, ReRequestPreview, ReRequestRecord, ReRequestService, ReRequestStatus } from "../../shared/reRequests";
import { getJsonSetting, nowIso, type Db } from "../db/database";
import * as schema from "../db/schema";
import { publicErrorMessage } from "../errors";
import type { ArrStoredSettings } from "./arrInstances";
import { parseEpisodeNumbers } from "./episodeNumbers";
import { isOnboardingComplete } from "./onboarding";
import { isPathConfigurationBlocked } from "./pathConfiguration";
import { mapRadarrMovie, radarrClient, radarrStoredInstances } from "./radarr";
import { mapSonarrSeries, sonarrClient, sonarrEpisodeLabel, sonarrStoredInstances } from "./sonarr";
import type { SonarrEpisode, SonarrEpisodeFile } from "./sonarrClient";

export { parseEpisodeNumbers };

// The worker runs this pass every five seconds, so a pass may send one twelfth of a minute's allowance.
export const reRequestPassMs = 5000;
const listLimit = 200;
const resolveBatchSize = 500;
const previewExampleLimit = 10;
const cancelledUnmonitorMessage = "Skipped: the file was deleted and re-requested.";

type ReRequestRow = typeof schema.reRequests.$inferSelect;
type Outcome = { status: ReRequestStatus; message: string | null; previousMonitored?: boolean | null; episodes?: string | null };

interface FileToMatch {
  section: string;
  itemName: string;
  fileNames: string[];
  wasLinked: boolean;
  displayName: string;
}

type Match =
  | { matched: true; service: ReRequestService; config: ArrStoredSettings; arrItemId: number; title: string }
  | { matched: false; reason: string; retryable: boolean };

// How many searches an instance may be sent right now: within the rolling minute's allowance, spread over the minute.
export function reRequestAllowance(perMinute: number, sentInLastMinute: number): number {
  return Math.max(0, Math.min(Math.ceil(perMinute * reRequestPassMs / 60_000), perMinute - sentInLastMinute));
}

function parseNames(raw: string): string[] {
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    return [];
  }
}

function episodeKeysOf(fileNames: string[]): string[] {
  for (const name of fileNames) {
    const parsed = parseEpisodeNumbers(name);
    if (parsed) return parsed.episodes.map((episode) => `${parsed.season}x${episode}`);
  }
  return [];
}

const sameFile = (recordPath: string, name: string) => path.posix.basename(recordPath) === path.posix.basename(name);

// Exact paths first; a name alone only counts when it points at one record, since seasons can repeat a name.
function matchingRecords(records: SonarrEpisodeFile[], names: string[]): SonarrEpisodeFile[] {
  const exact = records.filter((record) => names.includes(record.relativePath));
  if (exact.length) return exact;
  const byName = records.filter((record) => names.some((name) => sameFile(record.relativePath, name)));
  return byName.length === 1 ? byName : [];
}

async function liveMediaLinks(db: Db, section: string, itemName: string) {
  return db.select({ relativePath: schema.mediaLinks.relativePath }).from(schema.mediaLinks)
    .where(and(eq(schema.mediaLinks.section, section), eq(schema.mediaLinks.itemName, itemName), eq(schema.mediaLinks.isMedia, true), isNull(schema.mediaLinks.missingSince)));
}

// Decides from SRTL's own records, so it needs no Radarr or Sonarr connection. Each folder belongs to one instance at most,
// which is how a separate 4K instance gets its own titles. Tables are read once per matcher, since a selection can be very large.
function createMatcher(db: Db): (file: FileToMatch) => Promise<Match> {
  const titleKey = (section: string, itemName: string) => `${section}\0${itemName}`;
  let instances: Promise<Array<{ service: ReRequestService; config: ArrStoredSettings }>> | null = null;
  let catalog: Promise<Map<string, { id: number; title: string }>> | null = null;
  let links: Promise<Map<string, string[]>> | null = null;
  const loadInstances = async () => [
    ...(await radarrStoredInstances(db)).instances.map((config) => ({ service: "radarr" as const, config })),
    ...(await sonarrStoredInstances(db)).instances.map((config) => ({ service: "sonarr" as const, config }))
  ];
  const loadCatalog = async () => {
    const rows = new Map<string, { id: number; title: string }>();
    for (const row of await db.select({ instanceId: schema.radarrMovies.instanceId, id: schema.radarrMovies.movieId, title: schema.radarrMovies.title, section: schema.radarrMovies.section, itemName: schema.radarrMovies.itemName }).from(schema.radarrMovies)) {
      if (row.section && row.itemName) rows.set(`${row.instanceId}\0${titleKey(row.section, row.itemName)}`, row);
    }
    for (const row of await db.select({ instanceId: schema.sonarrSeries.instanceId, id: schema.sonarrSeries.seriesId, title: schema.sonarrSeries.title, section: schema.sonarrSeries.section, itemName: schema.sonarrSeries.itemName }).from(schema.sonarrSeries)) {
      if (row.section && row.itemName) rows.set(`${row.instanceId}\0${titleKey(row.section, row.itemName)}`, row);
    }
    return rows;
  };
  const loadLinks = async () => {
    const rows = new Map<string, string[]>();
    for (const link of await db.select({ section: schema.mediaLinks.section, itemName: schema.mediaLinks.itemName, relativePath: schema.mediaLinks.relativePath }).from(schema.mediaLinks).where(and(eq(schema.mediaLinks.isMedia, true), isNull(schema.mediaLinks.missingSince)))) {
      const key = titleKey(link.section, link.itemName);
      const paths = rows.get(key);
      if (paths) paths.push(link.relativePath);
      else rows.set(key, [link.relativePath]);
    }
    return rows;
  };
  return async (file) => {
    if (/\.srtl-/.test(file.displayName)) return { matched: false, reason: "This is a leftover file SRTL created, not a copy of a title.", retryable: false };
    if (!file.section || !file.itemName) return { matched: false, reason: "SRTL cannot tell which title this file belongs to.", retryable: false };
    const owner = (await (instances ??= loadInstances())).find(({ config }) => config.mappings.some((mapping) => mapping.section === file.section));
    if (!owner) return { matched: false, reason: "No Radarr or Sonarr instance manages this folder.", retryable: false };
    const { service, config } = owner;
    if (!config.enabled) return { matched: false, reason: `${config.name} is paused. Resume it to re-request this.`, retryable: true };
    const row = (await (catalog ??= loadCatalog())).get(`${config.id}\0${titleKey(file.section, file.itemName)}`);
    if (!row) return { matched: false, reason: `This title is not in ${config.name}.`, retryable: false };
    // A spare file of a title that still has a linked copy: the arr has what it wants and a search would find nothing to do.
    if (!file.wasLinked) {
      const linked = (await (links ??= loadLinks())).get(titleKey(file.section, file.itemName)) ?? [];
      const keys = new Set(episodeKeysOf(file.fileNames));
      const covered = service === "radarr" ? linked.length > 0 : linked.some((relativePath) => episodeKeysOf([relativePath]).some((key) => keys.has(key)));
      if (covered) return { matched: false, reason: `Another linked file of this title stays, so ${config.name} has nothing to search for.`, retryable: false };
    }
    return { matched: true, service, config, arrItemId: row.id, title: row.title };
  };
}

export async function previewReRequests(db: Db, storageFileIds: number[]): Promise<ReRequestPreview> {
  const instances = new Map<string, ReRequestPreview["instances"][number]>();
  const ineligible = new Map<string, ReRequestPreview["ineligible"][number]>();
  let eligibleCount = 0;
  let total = 0;
  const addIneligible = (reason: string, example: string) => {
    const entry = ineligible.get(reason) ?? { reason, count: 0, examples: [] };
    entry.count += 1;
    if (entry.examples.length < previewExampleLimit) entry.examples.push(example);
    ineligible.set(reason, entry);
  };
  const seriesFiles = new Map<string, Promise<SonarrEpisodeFile[]>>();
  const matchFile = createMatcher(db);
  for (let offset = 0; offset < storageFileIds.length; offset += 1000) {
    const batch = storageFileIds.slice(offset, offset + 1000);
    const files = await db.select().from(schema.storageFiles).where(inArray(schema.storageFiles.id, batch));
    const links = await db.select({ resolved: schema.mediaLinks.resolvedStorageFileId, targetPath: schema.mediaLinks.targetPath, relativePath: schema.mediaLinks.relativePath }).from(schema.mediaLinks)
      .where(and(isNull(schema.mediaLinks.missingSince), or(inArray(schema.mediaLinks.resolvedStorageFileId, batch), inArray(schema.mediaLinks.targetPath, files.map((file) => file.filePath)))));
    for (const file of files) {
      total += 1;
      const displayName = path.basename(file.filePath);
      const own = links.filter((link) => link.resolved === file.id || link.targetPath === file.filePath);
      const fileNames = [file.relativePath, ...own.map((link) => link.relativePath)];
      const match = await matchFile({ section: file.section, itemName: file.itemName, fileNames, wasLinked: own.length > 0, displayName });
      if (!match.matched) {
        addIneligible(match.reason, displayName);
        continue;
      }
      // Names without an episode number, such as daily or anime naming, can only be matched through Sonarr's own file list.
      if (match.service === "sonarr" && episodeKeysOf(fileNames).length === 0) {
        const key = `${match.config.id}:${match.arrItemId}`;
        if (!seriesFiles.has(key)) seriesFiles.set(key, Promise.resolve().then(() => sonarrClient(match.config).episodeFiles(match.arrItemId)));
        const records = await seriesFiles.get(key)!.catch(() => null);
        if (!records) {
          addIneligible(`${match.config.name} could not be reached to identify these episodes. SRTL will try again after the delete.`, displayName);
          continue;
        }
        if (!records.some((record) => fileNames.some((name) => sameFile(record.relativePath, name)))) {
          addIneligible(`${match.config.name} has no episode for this file.`, displayName);
          continue;
        }
      }
      eligibleCount += 1;
      const entry = instances.get(match.config.id) ?? { service: match.service, instanceName: match.config.name, count: 0 };
      entry.count += 1;
      instances.set(match.config.id, entry);
    }
  }
  return { total, eligibleCount, instances: [...instances.values()], ineligible: [...ineligible.values()] };
}

async function jobEvent(db: Db, row: ReRequestRow, level: "info" | "warn" | "error", message: string): Promise<void> {
  await db.insert(schema.jobEvents).values({ jobId: row.jobId, timestamp: nowIso(), level, message, data: JSON.stringify({ reRequestId: row.id, service: row.service, instanceName: row.instanceName, title: row.title, episodes: row.episodes }) });
}

// Matches files that were just deleted, so each one either waits for its turn or says now why it will not be requested.
async function resolveQueued(db: Db): Promise<void> {
  const rows = await db.select().from(schema.reRequests).where(eq(schema.reRequests.status, "queued")).orderBy(asc(schema.reRequests.id)).limit(resolveBatchSize);
  const matchFile = createMatcher(db);
  for (const row of rows) {
    const match = await matchFile({ section: row.section, itemName: row.itemName, fileNames: parseNames(row.fileNames), wasLinked: row.wasLinked, displayName: row.displayName });
    const timestamp = nowIso();
    if (match.matched) {
      await db.update(schema.reRequests).set({ status: "pending", service: match.service, instanceId: match.config.id, instanceName: match.config.name, arrItemId: match.arrItemId, title: match.title, message: null, updatedAt: timestamp }).where(and(eq(schema.reRequests.id, row.id), eq(schema.reRequests.status, "queued")));
      continue;
    }
    await db.update(schema.reRequests).set({ status: match.retryable ? "failed" : "unmatched", message: match.reason, updatedAt: timestamp }).where(and(eq(schema.reRequests.id, row.id), eq(schema.reRequests.status, "queued")));
    await jobEvent(db, row, "warn", `Not re-requested: ${row.displayName}. ${match.reason}`);
  }
}

async function finish(db: Db, row: ReRequestRow, outcome: Outcome, commandId: number | null = null): Promise<void> {
  const timestamp = nowIso();
  const requested = outcome.status === "requested";
  await db.update(schema.reRequests).set({
    status: outcome.status,
    message: outcome.message,
    attempts: row.attempts + 1,
    updatedAt: timestamp,
    commandId,
    ...(outcome.episodes !== undefined ? { episodes: outcome.episodes } : {}),
    ...(outcome.previousMonitored !== undefined ? { previousMonitored: outcome.previousMonitored } : {}),
    ...(requested ? { requestedAt: timestamp } : {})
  }).where(and(eq(schema.reRequests.id, row.id), eq(schema.reRequests.status, "pending")));
  const name = `${row.title ?? row.displayName}${outcome.episodes ? ` ${outcome.episodes}` : ""}`;
  if (requested) await jobEvent(db, row, "info", `Search sent to ${row.instanceName}: ${name}${outcome.message ? `. ${outcome.message}` : ""}`);
  else if (outcome.status === "failed") await jobEvent(db, row, "error", `Re-request failed: ${name}. ${outcome.message}`);
  else await jobEvent(db, row, "warn", `Not re-requested: ${name}. ${outcome.message}`);
}

const failure = (error: unknown): Outcome => ({ status: "failed", message: publicErrorMessage(error, "The re-request could not be sent.") });

// Removes the file record, then monitors the movie. That order matters: Radarr can be set to unmonitor a movie when its file goes.
async function prepareMovie(db: Db, config: ArrStoredSettings, row: ReRequestRow): Promise<Outcome | { ready: true; previousMonitored: boolean | null }> {
  const movieId = row.arrItemId!;
  const catalog = (await db.select().from(schema.radarrMovies).where(and(eq(schema.radarrMovies.instanceId, config.id), eq(schema.radarrMovies.movieId, movieId))).limit(1))[0];
  if (!catalog) return { status: "failed", message: `This movie is no longer in ${config.name}.` };
  const connection = radarrClient(config);
  const movie = await connection.movie(movieId);
  const scope = mapRadarrMovie(movie, config);
  if (movie.tmdbId !== catalog.tmdbId || scope?.section !== catalog.section || scope?.itemName !== catalog.itemName) return { status: "failed", message: "Radarr movie identity or path changed. Refresh and review its mapping." };
  const file = movie.movieFile;
  if (file) {
    if (!parseNames(row.fileNames).some((name) => sameFile(file.relativePath, name))) return { status: "skipped", message: `${config.name} already has a different file for this movie, so no search was sent.`, previousMonitored: movie.monitored ?? null };
    // A live symlink of the same name means a new copy arrived since the delete; its record is not the one to remove.
    if ((await liveMediaLinks(db, row.section, row.itemName)).some((link) => sameFile(link.relativePath, file.relativePath))) return { status: "skipped", message: "A new copy is already linked, so no search was sent.", previousMonitored: movie.monitored ?? null };
    if (!file.id) return { status: "failed", message: `${config.name} did not report an identifier for this movie's file.` };
    await connection.deleteMovieFile(file.id);
  }
  const previousMonitored = movie.monitored ?? catalog.monitored;
  const timestamp = nowIso();
  // A change still waiting from an earlier copy to local must not undo this one.
  await db.update(schema.radarrMonitorUpdates).set({ processedAt: timestamp, error: cancelledUnmonitorMessage }).where(and(eq(schema.radarrMonitorUpdates.instanceId, config.id), eq(schema.radarrMonitorUpdates.movieId, movieId), eq(schema.radarrMonitorUpdates.monitored, false), isNull(schema.radarrMonitorUpdates.processedAt)));
  await connection.setMonitored([movieId], true);
  await db.update(schema.radarrMovies).set({ monitored: true }).where(and(eq(schema.radarrMovies.instanceId, config.id), eq(schema.radarrMovies.movieId, movieId)));
  if (previousMonitored === false) await db.insert(schema.radarrMonitorUpdates).values({ instanceId: config.id, movieId, title: catalog.title, monitored: true, previousMonitored, createdAt: timestamp, processedAt: timestamp, nextAttemptAt: timestamp });
  return { ready: true, previousMonitored };
}

async function requestMovies(db: Db, config: ArrStoredSettings, rows: ReRequestRow[]): Promise<void> {
  const ready: Array<{ row: ReRequestRow; previousMonitored: boolean | null }> = [];
  for (const row of rows) {
    try {
      const prepared = await prepareMovie(db, config, row);
      if ("ready" in prepared) ready.push({ row, previousMonitored: prepared.previousMonitored });
      else await finish(db, row, prepared);
    } catch (error) {
      await finish(db, row, failure(error));
    }
  }
  if (!ready.length) return;
  try {
    const commandId = await radarrClient(config).searchMovies([...new Set(ready.map(({ row }) => row.arrItemId!))]);
    for (const { row, previousMonitored } of ready) await finish(db, row, { status: "requested", message: null, previousMonitored }, commandId);
  } catch (error) {
    for (const { row, previousMonitored } of ready) await finish(db, row, { ...failure(error), previousMonitored });
  }
}

interface PreparedEpisodes { ready: true; episodeIds: number[]; labels: string; previousMonitored: boolean; note: string | null }

// Which episodes this deleted file held: Sonarr's own record when it still has one, otherwise the numbers in the file name.
async function prepareEpisodes(db: Db, config: ArrStoredSettings, row: ReRequestRow): Promise<Outcome | PreparedEpisodes> {
  const seriesId = row.arrItemId!;
  const catalog = (await db.select().from(schema.sonarrSeries).where(and(eq(schema.sonarrSeries.instanceId, config.id), eq(schema.sonarrSeries.seriesId, seriesId))).limit(1))[0];
  if (!catalog) return { status: "failed", message: `This series is no longer in ${config.name}.` };
  const connection = sonarrClient(config);
  const series = await connection.seriesById(seriesId);
  const scope = mapSonarrSeries(series, config);
  if (series.tvdbId !== catalog.tvdbId || scope?.section !== catalog.section || scope?.itemName !== catalog.itemName) return { status: "failed", message: "Sonarr series identity or path changed. Refresh and review its mapping." };
  const names = parseNames(row.fileNames);
  const [records, episodes] = await Promise.all([connection.episodeFiles(seriesId), connection.episodes(seriesId)]);
  const matched = matchingRecords(records, names);
  const links = await liveMediaLinks(db, row.section, row.itemName);
  // A live symlink of the same name means a new copy arrived since the delete; its record is not the one to remove.
  if (matched.some((record) => links.some((link) => sameFile(link.relativePath, record.relativePath)))) return { status: "skipped", message: "A new copy is already linked, so no search was sent." };
  let targets: SonarrEpisode[];
  if (matched.length) {
    const recordIds = new Set(matched.map((record) => record.id));
    targets = episodes.filter((episode) => episode.episodeFileId !== undefined && recordIds.has(episode.episodeFileId));
  } else {
    const keys = new Set(episodeKeysOf(names));
    const named = episodes.filter((episode) => keys.has(`${episode.seasonNumber}x${episode.episodeNumber}`));
    targets = named.filter((episode) => !episode.episodeFileId);
    if (named.length && !targets.length) return { status: "skipped", message: `${config.name} already has a different file for this episode, so no search was sent.` };
  }
  if (!targets.length) return { status: "unmatched", message: `${config.name} has no episode for this file.` };
  for (const record of matched) await connection.deleteEpisodeFile(record.id);
  const episodeIds = targets.map((episode) => episode.id);
  const timestamp = nowIso();
  // A change still waiting from an earlier copy to local must not undo this one.
  await db.update(schema.sonarrMonitorUpdates).set({ processedAt: timestamp, error: cancelledUnmonitorMessage }).where(and(eq(schema.sonarrMonitorUpdates.instanceId, config.id), inArray(schema.sonarrMonitorUpdates.episodeId, episodeIds), eq(schema.sonarrMonitorUpdates.monitored, false), isNull(schema.sonarrMonitorUpdates.processedAt)));
  // Only these episodes change. Sonarr can be set to unmonitor an episode when its file goes, so this comes after the record is removed.
  await connection.setEpisodesMonitored(episodeIds, true);
  const changed = targets.filter((episode) => !episode.monitored);
  if (changed.length) await db.insert(schema.sonarrMonitorUpdates).values(changed.map((episode) => ({ instanceId: config.id, seriesId, episodeId: episode.id, title: `${catalog.title} ${sonarrEpisodeLabel(episode)}`, monitored: true, previousMonitored: false, createdAt: timestamp, processedAt: timestamp, nextAttemptAt: timestamp })));
  return {
    ready: true,
    episodeIds,
    labels: targets.map(sonarrEpisodeLabel).join(", "),
    previousMonitored: changed.length === 0,
    // SRTL never changes a series' own monitoring. This search still runs, because a person asked for it.
    note: series.monitored === false ? "The series is not monitored in Sonarr, so only this search will look for it." : null
  };
}

async function requestEpisodes(db: Db, config: ArrStoredSettings, rows: ReRequestRow[]): Promise<void> {
  const ready: Array<{ row: ReRequestRow; prepared: PreparedEpisodes }> = [];
  for (const row of rows) {
    try {
      const prepared = await prepareEpisodes(db, config, row);
      if ("ready" in prepared) ready.push({ row, prepared });
      else await finish(db, row, prepared);
    } catch (error) {
      await finish(db, row, failure(error));
    }
  }
  if (!ready.length) return;
  try {
    const commandId = await sonarrClient(config).searchEpisodes([...new Set(ready.flatMap(({ prepared }) => prepared.episodeIds))]);
    for (const { row, prepared } of ready) await finish(db, row, { status: "requested", message: prepared.note, previousMonitored: prepared.previousMonitored, episodes: prepared.labels }, commandId);
  } catch (error) {
    for (const { row, prepared } of ready) await finish(db, row, { ...failure(error), previousMonitored: prepared.previousMonitored, episodes: prepared.labels });
  }
}

async function processInstance(db: Db, service: ReRequestService, instanceId: string, perMinute: number, now: number): Promise<void> {
  const stored = service === "radarr" ? await radarrStoredInstances(db) : await sonarrStoredInstances(db);
  const config = stored.instances.find((instance) => instance.id === instanceId);
  const unavailable = !config ? "This instance was removed from SRTL." : !config.enabled ? `${config.name} is paused. Resume it to re-request this.` : null;
  const pendingHere = and(eq(schema.reRequests.status, "pending"), eq(schema.reRequests.instanceId, instanceId));
  if (unavailable) {
    for (const row of await db.select().from(schema.reRequests).where(pendingHere).limit(resolveBatchSize)) await finish(db, row, { status: "failed", message: unavailable });
    return;
  }
  const minuteAgo = new Date(now - 60_000).toISOString();
  const [sent] = await db.select({ value: count() }).from(schema.reRequests).where(and(eq(schema.reRequests.instanceId, instanceId), gt(schema.reRequests.requestedAt, minuteAgo)));
  const allowance = reRequestAllowance(perMinute, sent?.value ?? 0);
  if (allowance === 0) return;
  const rows = await db.select().from(schema.reRequests).where(pendingHere).orderBy(asc(schema.reRequests.id)).limit(allowance);
  if (service === "radarr") await requestMovies(db, config!, rows);
  else await requestEpisodes(db, config!, rows);
}

// Starts work for every instance with searches waiting and returns without waiting for it, so a slow or offline instance
// never holds back the others. Finished runs remove themselves from `running`.
export async function startReRequestWork(db: Db, running: Map<string, Promise<void>>, onError: (error: unknown) => void, now = Date.now()): Promise<void> {
  const waiting = await db.select({ id: schema.reRequests.id }).from(schema.reRequests).where(inArray(schema.reRequests.status, ["queued", "pending"])).limit(1);
  if (!waiting.length || !(await isOnboardingComplete(db)) || await isPathConfigurationBlocked(db)) return;
  await resolveQueued(db);
  const perMinute = normalizeAdvancedSettings(await getJsonSetting<unknown>(db, "advancedSettings", {})).cleanup.reRequestsPerMinute;
  const instances = await db.selectDistinct({ service: schema.reRequests.service, instanceId: schema.reRequests.instanceId }).from(schema.reRequests).where(eq(schema.reRequests.status, "pending"));
  for (const { service, instanceId } of instances) {
    if (!service || !instanceId) continue;
    const key = `${service}:${instanceId}`;
    if (running.has(key)) continue;
    running.set(key, processInstance(db, service as ReRequestService, instanceId, perMinute, now)
      .catch(onError)
      .finally(() => running.delete(key)));
  }
}

// One pass for every instance, waiting for all of them. Tests use it.
export async function processReRequestWork(db: Db, now = Date.now()): Promise<void> {
  const running = new Map<string, Promise<void>>();
  const errors: unknown[] = [];
  await startReRequestWork(db, running, (error) => errors.push(error), now);
  await Promise.all([...running.values()]);
  if (errors.length) throw errors[0];
}

function toRecord(row: ReRequestRow): ReRequestRecord {
  return { id: row.id, jobId: row.jobId, displayName: row.displayName, service: row.service as ReRequestService | null, instanceName: row.instanceName, title: row.title, episodes: row.episodes, status: row.status as ReRequestStatus, message: row.message, previousMonitored: row.previousMonitored, attempts: row.attempts, createdAt: row.createdAt, requestedAt: row.requestedAt };
}

export async function listReRequests(db: Db): Promise<ReRequestList> {
  const [rows, grouped, settings] = await Promise.all([
    db.select().from(schema.reRequests).orderBy(desc(schema.reRequests.id)).limit(listLimit),
    db.select({ status: schema.reRequests.status, value: count() }).from(schema.reRequests).groupBy(schema.reRequests.status),
    getJsonSetting<unknown>(db, "advancedSettings", {})
  ]);
  const counts: ReRequestList["counts"] = { queued: 0, pending: 0, requested: 0, failed: 0, unmatched: 0, skipped: 0 };
  for (const entry of grouped) counts[entry.status as ReRequestStatus] = entry.value;
  return { items: rows.map(toRecord), counts, perMinute: normalizeAdvancedSettings(settings).cleanup.reRequestsPerMinute };
}

// Puts failed requests back through matching, so a resumed instance or refreshed catalog counts. Everything already sent stays as it is.
export async function retryReRequests(db: Db, ids: number[] | "all_failed"): Promise<number> {
  const timestamp = nowIso();
  const updated = await db.update(schema.reRequests)
    .set({ status: "queued", message: null, updatedAt: timestamp })
    .where(and(eq(schema.reRequests.status, "failed"), ids === "all_failed" ? sql`true` : inArray(schema.reRequests.id, ids)))
    .returning({ id: schema.reRequests.id });
  return updated.length;
}
