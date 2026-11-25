import fs from "node:fs/promises";
import path from "node:path";
import { and, asc, desc, eq, inArray, isNotNull, isNull, notInArray, or } from "drizzle-orm";
import type { ArrDiskCheckInstance, ArrDiskCheckState, ArrDiskMismatch, BrokenLinkRescanResult, PathsSettings } from "../../shared/types";
import { getJsonSetting, getSectionSettings, nowIso, type Db } from "../db/database";
import * as schema from "../db/schema";
import { publicErrorMessage } from "../errors";
import type { ArrStoredSettings } from "./arrInstances";
import { brokenLinkMountChecks, mountWarning } from "./brokenLinks";
import { withFilesystemTimeout } from "./filesystemSafety";
import { mapRadarrMovie, radarrClient, radarrStoredInstances } from "./radarr";
import { queueRescansForJob, queueSearchesForRemovedLinks } from "./reRequests";
import { sonarrClient, sonarrEpisodeLabel, sonarrStoredInstances } from "./sonarr";

// Compares what Sonarr and Radarr have on record with the library. Sonarr only looks at the disk when a series is rescanned,
// so a file the remote mount removed together with its library link stays "present" there. Read-only on both sides: the
// library inventory answers first, and the disk is only asked about paths the inventory has no current link for.

interface CheckContext {
  event(level: "info" | "warn" | "error", message: string, data?: unknown): Promise<void>;
  setProgress(progress: unknown): Promise<void>;
  isCancelled(): Promise<boolean>;
}

interface Found {
  service: "radarr" | "sonarr";
  instanceId: string;
  instanceName: string;
  arrItemId: number;
  arrFileId: number;
  title: string;
  section: string;
  itemName: string;
  relativePath: string;
  arrPath: string;
  episodes: string | null;
}

const listLimit = 5_000;
const normalized = (value: string) => value.replace(/\\/g, "/").split("/").filter(Boolean).join("/");
const errorCode = (error: unknown) => (error !== null && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : null);

/** Whether a title-relative arr file has anything in the library: a current inventory link first, the disk only when there is none. */
function libraryLookup(db: Db, symlinkDir: string) {
  let inventory: Promise<Set<string>> | null = null;
  const load = async () => {
    const rows = await db.select({ section: schema.mediaLinks.section, relativePath: schema.mediaLinks.relativePath }).from(schema.mediaLinks).where(isNull(schema.mediaLinks.missingSince));
    return new Set(rows.map((row) => `${row.section}\0${normalized(row.relativePath)}`));
  };
  return async (section: string, itemName: string, fileRelative: string): Promise<"present" | "missing" | "unknown"> => {
    const relative = normalized(`${itemName}/${fileRelative}`);
    if ((await (inventory ??= load())).has(`${section}\0${relative}`)) return "present";
    // Not in the inventory, perhaps because it arrived after the last scan.
    const libraryPath = path.join(symlinkDir, section, relative);
    if (!libraryPath.startsWith(path.join(symlinkDir, section) + path.sep)) return "unknown";
    try {
      await withFilesystemTimeout(fs.lstat(libraryPath), `Library check for ${libraryPath}`);
      return "present";
    } catch (error) {
      return ["ENOENT", "ENOTDIR"].includes(errorCode(error) ?? "") ? "missing" : "unknown";
    }
  };
}

async function checkRadarr(db: Db, config: ArrStoredSettings, lookup: ReturnType<typeof libraryLookup>, result: ArrDiskCheckInstance): Promise<Found[]> {
  const found: Found[] = [];
  // One request for every movie with its file record.
  for (const movie of await radarrClient(config).movies()) {
    const file = movie.movieFile;
    if (!file?.id || !file.relativePath) continue;
    const scope = mapRadarrMovie(movie, config);
    if (!scope) continue;
    result.titles += 1;
    result.files += 1;
    if ((await lookup(scope.section, scope.itemName, file.relativePath)) !== "missing") continue;
    found.push({ service: "radarr", instanceId: config.id, instanceName: config.name, arrItemId: movie.id, arrFileId: file.id, title: `${movie.title} (${movie.year})`, section: scope.section, itemName: scope.itemName, relativePath: normalized(file.relativePath), arrPath: `${movie.path}/${normalized(file.relativePath)}`, episodes: null });
  }
  return found;
}

async function checkSonarr(db: Db, config: ArrStoredSettings, lookup: ReturnType<typeof libraryLookup>, result: ArrDiskCheckInstance, ctx: CheckContext): Promise<Found[]> {
  const found: Found[] = [];
  const series = await db
    .select()
    .from(schema.sonarrSeries)
    .where(and(eq(schema.sonarrSeries.instanceId, config.id), isNotNull(schema.sonarrSeries.section), isNotNull(schema.sonarrSeries.itemName)))
    .orderBy(asc(schema.sonarrSeries.title));
  const connection = sonarrClient(config);
  // One series at a time, so a large library never floods Sonarr.
  for (const entry of series) {
    if (await ctx.isCancelled()) break;
    const files = await connection.episodeFiles(entry.seriesId);
    result.titles += 1;
    result.files += files.length;
    const missing = [];
    for (const file of files) {
      if ((await lookup(entry.section!, entry.itemName!, file.relativePath)) === "missing") missing.push(file);
    }
    if (!missing.length) continue;
    // Episode numbers only for a series with something missing.
    const episodes = await connection.episodes(entry.seriesId);
    for (const file of missing) {
      const labels = episodes.filter((episode) => episode.episodeFileId === file.id).map(sonarrEpisodeLabel);
      found.push({ service: "sonarr", instanceId: config.id, instanceName: config.name, arrItemId: entry.seriesId, arrFileId: file.id, title: entry.title, section: entry.section!, itemName: entry.itemName!, relativePath: normalized(file.relativePath), arrPath: `${entry.folderPath}/${normalized(file.relativePath)}`, episodes: labels.length ? labels.join(", ") : null });
    }
    if (result.titles % 25 === 0) await ctx.setProgress({ stage: "checking", message: `Checked ${result.titles} series in ${config.name}`, instance: config.name });
  }
  return found;
}

/**
 * Runs one check of every Radarr and Sonarr instance against the library. An instance that cannot be reached keeps the
 * list from its last successful check and is reported, without failing the others. Refuses to record anything while a
 * storage location looks down.
 */
export async function runArrDiskCheck(db: Db, jobId: number, ctx: CheckContext): Promise<{ instances: ArrDiskCheckInstance[]; missing: number; summary: string }> {
  const paths = await getJsonSetting<PathsSettings>(db, "paths", { symlinkDir: "", localDir: "", remoteDir: "" });
  if (!paths.symlinkDir) throw new Error("Symlink path setting is incomplete");
  const down = (await brokenLinkMountChecks(paths, ["remote", "local"])).filter((check) => !check.mounted);
  if (down.length) throw new Error(`Radarr and Sonarr were not checked. ${down.map(mountWarning).join(" ")}`);

  const lookup = libraryLookup(db, paths.symlinkDir);
  const configs = [
    ...(await radarrStoredInstances(db)).instances.map((config) => ({ service: "radarr" as const, config })),
    ...(await sonarrStoredInstances(db)).instances.map((config) => ({ service: "sonarr" as const, config }))
  ].filter(({ config }) => config.mappings.length > 0);
  const instances: ArrDiskCheckInstance[] = [];
  const timestamp = nowIso();
  for (const { service, config } of configs) {
    if (await ctx.isCancelled()) break;
    const result: ArrDiskCheckInstance = { service, instanceId: config.id, instanceName: config.name, status: "checked", message: null, titles: 0, files: 0, missing: 0 };
    instances.push(result);
    if (!config.enabled) {
      result.status = "paused";
      result.message = `${config.name} is paused, so it was not checked.`;
      continue;
    }
    await ctx.setProgress({ stage: "checking", message: `Checking ${config.name}`, instance: config.name });
    let found: Found[];
    try {
      found = service === "radarr" ? await checkRadarr(db, config, lookup, result) : await checkSonarr(db, config, lookup, result, ctx);
    } catch (error) {
      result.status = "unreachable";
      result.message = publicErrorMessage(error, `${config.name} could not be checked.`);
      await ctx.event("warn", `${config.name} was not checked: ${result.message} Its list is kept from the last check.`, { instance: config.name });
      continue;
    }
    if (await ctx.isCancelled()) break;
    result.missing = found.length;
    // Replace this instance's list, keeping when each record was first found.
    await db.transaction(async (transaction) => {
      const previous = await transaction.select({ arrFileId: schema.arrDiskMismatches.arrFileId, firstFoundAt: schema.arrDiskMismatches.firstFoundAt, requestedAt: schema.arrDiskMismatches.requestedAt }).from(schema.arrDiskMismatches).where(eq(schema.arrDiskMismatches.instanceId, config.id));
      const earlier = new Map(previous.map((row) => [row.arrFileId, row]));
      await transaction.delete(schema.arrDiskMismatches).where(eq(schema.arrDiskMismatches.instanceId, config.id));
      for (let offset = 0; offset < found.length; offset += 500) {
        await transaction.insert(schema.arrDiskMismatches).values(
          found.slice(offset, offset + 500).map((entry) => ({ ...entry, jobId, firstFoundAt: earlier.get(entry.arrFileId)?.firstFoundAt ?? timestamp, checkedAt: timestamp, requestedAt: earlier.get(entry.arrFileId)?.requestedAt ?? null }))
        ).onConflictDoNothing();
      }
    });
    await ctx.event(found.length ? "warn" : "info", `${config.name}: ${found.length} of ${result.files} file records have nothing in the library`, { instance: config.name, titles: result.titles, files: result.files, missing: found.length });
  }
  // Instances removed from SRTL leave nothing behind.
  const known = configs.map(({ config }) => config.id);
  await db.delete(schema.arrDiskMismatches).where(known.length ? notInArray(schema.arrDiskMismatches.instanceId, known) : undefined);
  const missing = instances.reduce((total, entry) => total + entry.missing, 0);
  const unreachable = instances.filter((entry) => entry.status === "unreachable").length;
  const summary = `${missing} ${missing === 1 ? "record has" : "records have"} nothing on disk${unreachable ? `; ${unreachable} ${unreachable === 1 ? "instance" : "instances"} could not be checked` : ""}`;
  return { instances, missing, summary };
}

/** Whether any Radarr or Sonarr instance has folder mappings to check. */
export async function arrDiskCheckConfigured(db: Db): Promise<boolean> {
  return [...(await radarrStoredInstances(db)).instances, ...(await sonarrStoredInstances(db)).instances].some((config) => config.enabled && config.mappings.length > 0);
}

/** The list for the review page, with the newest finished check. Hidden while storage looks down. */
export async function arrDiskCheckState(db: Db): Promise<ArrDiskCheckState> {
  const paths = await getJsonSetting<PathsSettings>(db, "paths", { symlinkDir: "", localDir: "", remoteDir: "" });
  const storageDown = (await brokenLinkMountChecks(paths, ["remote", "local"])).some((check) => !check.mounted);
  const configured = await arrDiskCheckConfigured(db);
  const [active] = await db.select({ id: schema.jobs.id }).from(schema.jobs).where(and(eq(schema.jobs.type, "arr_disk_check"), inArray(schema.jobs.status, ["queued", "running"]))).orderBy(desc(schema.jobs.id)).limit(1);
  const [last] = await db.select().from(schema.jobs).where(and(eq(schema.jobs.type, "arr_disk_check"), or(eq(schema.jobs.status, "completed"), eq(schema.jobs.status, "partially_failed"), eq(schema.jobs.status, "failed")))).orderBy(desc(schema.jobs.id)).limit(1);
  let lastCheck: ArrDiskCheckState["lastCheck"] = null;
  if (last) {
    let progress: Record<string, unknown>;
    try {
      progress = JSON.parse(last.progress) as Record<string, unknown>;
    } catch {
      progress = {};
    }
    lastCheck = { jobId: last.id, finishedAt: last.finishedAt, status: last.status, message: typeof progress.message === "string" ? progress.message : null, instances: Array.isArray(progress.instances) ? (progress.instances as ArrDiskCheckInstance[]) : [] };
  }
  const titles = (await getSectionSettings(db)).sectionTitles ?? {};
  const rows = storageDown ? [] : await db.select().from(schema.arrDiskMismatches).orderBy(asc(schema.arrDiskMismatches.title), asc(schema.arrDiskMismatches.relativePath)).limit(listLimit);
  const items: ArrDiskMismatch[] = rows.map((row) => ({
    id: row.id,
    jobId: row.jobId,
    service: row.service as ArrDiskMismatch["service"],
    instanceName: row.instanceName,
    title: row.title,
    section: row.section,
    sectionTitle: titles[row.section]?.trim() || row.section,
    itemName: row.itemName,
    relativePath: row.relativePath,
    arrPath: row.arrPath,
    episodes: row.episodes,
    firstFoundAt: row.firstFoundAt,
    checkedAt: row.checkedAt,
    requestedAt: row.requestedAt
  }));
  return { items, lastCheck, activeJobId: active?.id ?? null, hiddenBecauseStorageDown: storageDown, configured };
}

/**
 * Asks Radarr or Sonarr to rescan the titles of chosen records, and with `search` also to search for them (the re-request
 * path removes the arr's record of the file first). Requests are recorded on the check job that found each record.
 */
export async function requestRescansForArrMismatches(db: Db, ids: number[], search: boolean): Promise<BrokenLinkRescanResult> {
  const rows = ids.length ? await db.select().from(schema.arrDiskMismatches).where(inArray(schema.arrDiskMismatches.id, [...new Set(ids)])) : [];
  const result: BrokenLinkRescanResult = { titles: 0, asked: 0, searched: 0, notMatched: 0, failed: 0, problems: [], relinked: 0 };
  const byJob = new Map<number, typeof rows>();
  for (const row of rows) {
    const group = byJob.get(row.jobId);
    if (group) group.push(row);
    else byJob.set(row.jobId, [row]);
  }
  const titleKeys = new Set<string>();
  for (const [jobId, group] of byJob) {
    const entries = group.map((row) => ({ section: row.section, itemName: row.itemName, fileNames: [row.relativePath], displayName: path.posix.basename(row.relativePath) }));
    for (const entry of entries) titleKeys.add(`${entry.section}\0${entry.itemName}`);
    const covered = search ? await queueSearchesForRemovedLinks(db, jobId, entries) : new Set<string>();
    if (search) result.searched += entries.length;
    const summary = await queueRescansForJob(db, jobId, entries, covered);
    result.asked += summary.asked;
    result.notMatched += summary.notMatched;
    result.failed += summary.failed;
    for (const problem of summary.problems) if (result.problems.length < 20) result.problems.push(problem);
  }
  if (rows.length) await db.update(schema.arrDiskMismatches).set({ requestedAt: nowIso() }).where(inArray(schema.arrDiskMismatches.id, rows.map((row) => row.id)));
  result.titles = titleKeys.size;
  return result;
}
