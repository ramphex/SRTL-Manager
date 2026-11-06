import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants, createReadStream, type Stats } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import packageJson from "../../../package.json";
import {
  backupAlert,
  backupFolderName,
  minimumVerifiedBackups,
  newestVerifiedBackup,
  nextBackupSlot,
  normalizeBackupSettings,
  type BackupAlert,
  type BackupEntry,
  type BackupLocationStatus,
  type BackupRunSummary,
  type BackupSettings,
  type BackupState,
  type BackupTrigger
} from "../../shared/backups";
import type { PathsSettings } from "../../shared/types";
import { dbGet, first, getJsonSetting, nowIso, setSetting, type Db } from "../db/database";
import * as schema from "../db/schema";
import type { JobContext } from "../jobs/jobRunner";
import { withFilesystemTimeout } from "./filesystemSafety";
import { isPathInside } from "./media";
import { isOnboardingComplete } from "./onboarding";
import { appendBoundedOutput, commandTimeoutMs, terminateChildProcess } from "./processSafety";

export const backupSettingsKey = "backupSettings";
export const backupStatusKey = "backupStatus";
export const backupScheduleAnchorKey = "backupScheduleAnchor";
export const backupLastSlotKey = "backupLastSlot";

export const backupManifestFormat = "srtl-manager-database-backup";
const namePattern = /^srtl-manager-backup-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z-j\d+$/;
const dumpSuffix = ".dump";
const checksumSuffix = ".dump.sha256";
const manifestSuffix = ".manifest.json";
const temporarySuffix = ".tmp";
const maxManifestBytes = 64 * 1024;
const listOutputLimitBytes = 4 * 1024 * 1024;
const statusListLimit = 100;
const locationCheckTimeoutMs = 30_000;
/** Dumps are compressed, so half the database size plus a margin covers a first backup; later ones use the last dump as the guide. */
const freeSpaceMarginBytes = 64 * 1024 * 1024;
const minimumPgDumpMajor = 17;
const backgroundPriority = 10;

export interface BackupCommand {
  file: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  /** Sends the command's standard output straight to this open file. */
  stdoutFd?: number;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Lets the rest of the server keep its share of the CPU. */
  background?: boolean;
}

export interface BackupCommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export type BackupCommandRunner = (command: BackupCommand) => Promise<BackupCommandResult>;

export interface BackupRuntime {
  databaseUrl: string;
  defaultLocation: string;
  pgBinDir: string | null;
  /** Environment-configured media roots; the database's saved paths are checked as well. */
  paths: PathsSettings;
  runCommand?: BackupCommandRunner;
  freeBytes?: (directory: string) => Promise<number>;
}

export type BackupJobContext = Pick<JobContext, "jobId" | "signal" | "event" | "setProgress" | "assertLease">;

/** A backup could not run or did not verify. The message is written for the admin and appears in job history. */
export class BackupFailure extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "BackupFailure";
  }
}

export const defaultBackupCommandRunner: BackupCommandRunner = (command) =>
  new Promise((resolve, reject) => {
    if (command.signal?.aborted) {
      reject(new Error("Job terminated"));
      return;
    }
    // detached is off: the job's abort signal stops this one process.
    const child = spawn(command.file, command.args, {
      env: command.env,
      stdio: ["ignore", command.stdoutFd ?? "pipe", "pipe"]
    });
    if (command.background && child.pid) {
      try {
        os.setPriority(child.pid, backgroundPriority);
      } catch {
        // Lower priority is a courtesy; the backup still runs without it.
      }
    }
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let killTimer: ReturnType<typeof setTimeout> | null = null;
    const stop = () => {
      killTimer ??= terminateChildProcess(child);
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      stop();
    }, command.timeoutMs ?? commandTimeoutMs());
    command.signal?.addEventListener("abort", stop, { once: true });
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout = appendBoundedOutput(stdout, chunk, listOutputLimitBytes);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = appendBoundedOutput(stderr, chunk);
    });
    const finish = () => {
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      command.signal?.removeEventListener("abort", stop);
    };
    child.once("error", (error) => {
      finish();
      reject(error);
    });
    child.once("close", (exitCode) => {
      finish();
      if (command.signal?.aborted) reject(new Error("Job terminated"));
      else if (timedOut) reject(new BackupFailure(`${path.basename(command.file)} did not finish in time and was stopped.`));
      else resolve({ exitCode, stdout, stderr });
    });
  });

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : undefined;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  return `${Math.ceil(bytes / 1024 ** 2)} MB`;
}

// Location checks

/** Never a backup location, and nothing inside them either. */
const refusedTrees = ["/bin", "/boot", "/dev", "/etc", "/lib", "/lib32", "/lib64", "/libx32", "/private/etc", "/private/tmp", "/private/var/tmp", "/proc", "/run", "/sbin", "/sys", "/tmp", "/usr", "/var/cache", "/var/lib/docker", "/var/lib/postgresql", "/var/log", "/var/run", "/var/tmp"];
/** Fine to go inside, too broad to be the location itself. */
const refusedExact = ["/", "/data", "/home", "/media", "/mnt", "/opt", "/root", "/srv", "/var", "/var/lib"];

function refusalForResolvedPath(candidate: string, mediaRoots: readonly string[]): string | null {
  if (refusedExact.includes(candidate) || refusedTrees.some((tree) => isPathInside(tree, candidate))) {
    return "That backup location is a system folder or a temporary one. Choose a dedicated folder for backups.";
  }
  if (mediaRoots.some((root) => isPathInside(root, candidate) || isPathInside(candidate, root))) {
    return "That backup location overlaps a media or symlink root. Choose a folder outside your library.";
  }
  return null;
}

async function nearestRealPath(candidate: string): Promise<string> {
  let existing = candidate;
  const missing: string[] = [];
  while (true) {
    try {
      return path.join(await fs.realpath(existing), ...missing);
    } catch (error) {
      const parent = path.dirname(existing);
      if (parent === existing || !["ENOENT", "ENOTDIR"].includes(errorCode(error) ?? "")) return candidate;
      missing.unshift(path.basename(existing));
      existing = parent;
    }
  }
}

/**
 * Why a location may not hold backups, or null when it may. The check follows
 * symbolic links, so a link cannot lead back into a system folder or the library.
 */
export async function backupLocationRefusal(location: string, mediaRoots: readonly string[]): Promise<string | null> {
  if (!path.isAbsolute(location)) return "The backup location must be an absolute path.";
  if (location.includes("\0") || location.split("/").includes("..")) return "The backup location must be a plain path without '..'.";
  const roots = mediaRoots.filter(Boolean).map((root) => path.resolve(root));
  const lexical = refusalForResolvedPath(path.resolve(location), roots);
  if (lexical) return lexical;
  const realRoots = await Promise.all(roots.map((root) => nearestRealPath(root)));
  return refusalForResolvedPath(await nearestRealPath(path.resolve(location)), [...roots, ...realRoots]);
}

export async function backupMediaRoots(db: Db, runtime: Pick<BackupRuntime, "paths">): Promise<string[]> {
  const saved = await getJsonSetting<PathsSettings>(db, "paths", { symlinkDir: "", localDir: "", remoteDir: "" });
  return [...new Set([saved.symlinkDir, saved.localDir, saved.remoteDir, runtime.paths.symlinkDir, runtime.paths.localDir, runtime.paths.remoteDir].filter(Boolean))];
}

function locationProblem(location: string, error: unknown): string {
  const code = errorCode(error);
  const help = "In Docker, mount a folder there that SRTL_UID can write to. Otherwise give the app's user write access.";
  if (code === "EROFS") return `The backup location ${location} is read-only. ${help}`;
  if (code === "EACCES" || code === "EPERM") return `SRTL Manager does not have permission to write to the backup location ${location}. ${help}`;
  if (code === "ENOSPC") return `The backup location ${location} has no free space.`;
  if (code === "ENOTDIR" || code === "EEXIST") return `The backup location ${location} is not a folder.`;
  return `The backup location ${location} cannot be written: ${errorText(error)}`;
}

/** Creates the backup folder with mode 700 and proves it can be written. Returns a warning when the filesystem will not keep it private. */
export async function prepareBackupDirectory(location: string): Promise<{ directory: string; permissionsWarning: string | null }> {
  const directory = path.join(location, backupFolderName);
  await fs.mkdir(location, { recursive: true, mode: 0o700 });
  await fs.mkdir(directory, { mode: 0o700 }).catch((error: unknown) => {
    if (errorCode(error) !== "EEXIST") throw error;
  });
  let stat = await fs.lstat(directory);
  if (!stat.isDirectory()) throw Object.assign(new Error(`${directory} is not a folder`), { code: "ENOTDIR" });
  if ((stat.mode & 0o777) !== 0o700) {
    await fs.chmod(directory, 0o700).catch(() => undefined);
    stat = await fs.lstat(directory);
  }
  const probe = path.join(directory, `.write-check-${process.pid}${temporarySuffix}`);
  const handle = await fs.open(probe, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
  let fileMode: number;
  try {
    fileMode = (await handle.stat()).mode & 0o777;
  } finally {
    await handle.close();
    await fs.unlink(probe);
  }
  const permissionsWarning = (stat.mode & 0o777) !== 0o700 || fileMode !== 0o600
    ? "This location does not keep the permissions SRTL Manager sets (folder 700, files 600), which is common on network shares. Restrict access to the share itself, because dumps contain password hashes."
    : null;
  return { directory, permissionsWarning };
}

// Backup files

export function backupName(at: Date, jobId: number): string {
  return `srtl-manager-backup-${at.toISOString().slice(0, 19).replaceAll(/[-:]/g, "")}Z-j${jobId}`;
}

function createdAtFromName(name: string): string {
  const match = namePattern.exec(name);
  if (!match) throw new Error(`Not a backup name: ${name}`);
  return `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}.000Z`;
}

const manifestSchema = z.object({
  format: z.literal(backupManifestFormat),
  formatVersion: z.literal(1),
  name: z.string().regex(namePattern),
  dumpFile: z.string(),
  checksumFile: z.string(),
  createdAt: z.iso.datetime(),
  verifiedAt: z.iso.datetime(),
  appVersion: z.string(),
  migration: z.number().int(),
  databaseSizeBytes: z.number().int().nonnegative(),
  dumpSizeBytes: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  postgresVersion: z.string(),
  pgDumpVersion: z.string(),
  trigger: z.enum(["scheduled", "manual"]),
  jobId: z.number().int(),
  restoreNeeds: z.string()
});

export type BackupManifest = z.infer<typeof manifestSchema>;

/** One backup found at the location. `owned` means its manifest proves this feature made it, the only thing pruning accepts. */
export interface BackupFileSet {
  entry: BackupEntry;
  owned: boolean;
}

async function regularFileStat(filePath: string): Promise<Stats | null> {
  try {
    const stat = await fs.lstat(filePath);
    return stat.isFile() ? stat : null;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
}

async function readManifest(directory: string, name: string): Promise<BackupManifest | null> {
  const filePath = path.join(directory, `${name}${manifestSuffix}`);
  const stat = await regularFileStat(filePath);
  if (!stat || stat.size > maxManifestBytes) return null;
  try {
    const manifest = manifestSchema.parse(JSON.parse(await fs.readFile(filePath, "utf8")));
    return manifest.name === name && manifest.dumpFile === `${name}${dumpSuffix}` && manifest.checksumFile === `${name}${checksumSuffix}` ? manifest : null;
  } catch {
    return null;
  }
}

function checksumLine(sha256: string, name: string): string {
  // The format sha256sum -c reads, so a dump can be checked by hand.
  return `${sha256}  ${name}${dumpSuffix}\n`;
}

async function readChecksumFile(directory: string, name: string): Promise<string | null> {
  const filePath = path.join(directory, `${name}${checksumSuffix}`);
  const stat = await regularFileStat(filePath);
  if (!stat || stat.size > 1024) return null;
  return fs.readFile(filePath, "utf8");
}

/**
 * Everything at the location that carries this feature's naming. A file set
 * counts as verified only with a valid manifest, whose presence says the full
 * verification passed, and a dump and checksum file that still agree with it.
 */
export async function listBackups(directory: string): Promise<BackupFileSet[]> {
  let names: string[];
  try {
    names = (await fs.readdir(directory, { withFileTypes: true })).filter((entry) => entry.isFile()).map((entry) => entry.name);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return [];
    throw error;
  }
  const backupNames = new Set(
    names
      .filter((file) => file.endsWith(dumpSuffix) || file.endsWith(manifestSuffix))
      .map((file) => file.slice(0, -(file.endsWith(dumpSuffix) ? dumpSuffix : manifestSuffix).length))
      .filter((name) => namePattern.test(name))
  );
  const sets: BackupFileSet[] = [];
  for (const name of backupNames) {
    const manifest = await readManifest(directory, name);
    const dump = await regularFileStat(path.join(directory, `${name}${dumpSuffix}`));
    let problem: string | null = null;
    if (!manifest) problem = "No valid manifest";
    else if (!dump) problem = "The dump file is missing";
    else if (dump.size !== manifest.dumpSizeBytes) problem = "The dump file changed size";
    else if ((await readChecksumFile(directory, name)) !== checksumLine(manifest.sha256, name)) problem = "The checksum file is missing or does not match";
    sets.push({
      owned: manifest !== null,
      entry: {
        name,
        createdAt: manifest?.createdAt ?? createdAtFromName(name),
        sizeBytes: dump?.size ?? 0,
        verified: problem === null,
        problem,
        appVersion: manifest?.appVersion ?? null,
        migration: manifest?.migration ?? null,
        databaseSizeBytes: manifest?.databaseSizeBytes ?? null
      }
    });
  }
  return sets.sort((left, right) => Date.parse(right.entry.createdAt) - Date.parse(left.entry.createdAt) || right.entry.name.localeCompare(left.entry.name));
}

/**
 * Which backups pruning removes. The newest verified backups up to the keep
 * setting stay, and never fewer than the minimum. Files without this feature's
 * manifest are never candidates, and a damaged backup goes only once the
 * verified ones it is older than are enough on their own.
 */
export function planBackupPrune(sets: readonly BackupFileSet[], keep: number): string[] {
  const owned = sets.filter((set) => set.owned);
  const verified = owned.filter((set) => set.entry.verified).sort((left, right) => Date.parse(right.entry.createdAt) - Date.parse(left.entry.createdAt));
  const kept = verified.slice(0, Math.max(keep, minimumVerifiedBackups));
  if (kept.length < minimumVerifiedBackups) return [];
  const oldestKept = Date.parse(kept.at(-1)!.entry.createdAt);
  return [
    ...verified.slice(kept.length),
    ...owned.filter((set) => !set.entry.verified && Date.parse(set.entry.createdAt) < oldestKept)
  ].map((set) => set.entry.name);
}

async function removeRegularFile(filePath: string): Promise<void> {
  // lstat first: a symbolic link wearing one of our names is not ours to touch.
  if (await regularFileStat(filePath)) await fs.unlink(filePath);
}

/** Removes what the plan names, re-reading the location first so only currently provable backups can go. Returns the names removed. */
export async function pruneBackups(directory: string, keep: number): Promise<string[]> {
  const plan = planBackupPrune(await listBackups(directory), keep);
  for (const name of plan) {
    await removeRegularFile(path.join(directory, `${name}${dumpSuffix}`));
    await removeRegularFile(path.join(directory, `${name}${checksumSuffix}`));
    await removeRegularFile(path.join(directory, `${name}${manifestSuffix}`));
  }
  return plan;
}

const temporaryFilePattern = /^srtl-manager-backup-\d{8}T\d{6}Z-j\d+(\.dump|\.dump\.sha256|\.manifest\.json)\.tmp$/;

/** Clears what an interrupted run left: only this feature's temporary names, and only files this user owns. */
async function removeInterruptedFiles(directory: string): Promise<void> {
  const uid = process.getuid?.();
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !temporaryFilePattern.test(entry.name)) continue;
    const filePath = path.join(directory, entry.name);
    const stat = await regularFileStat(filePath);
    if (stat && (uid === undefined || stat.uid === uid)) await fs.unlink(filePath);
  }
}

async function sha256File(filePath: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(filePath, signal ? { signal } : {}), hash);
  return hash.digest("hex");
}

async function syncDirectory(directory: string): Promise<void> {
  // Makes a rename durable. Some network filesystems refuse this, which does not make the backup bad.
  const handle = await fs.open(directory, "r").catch(() => null);
  if (!handle) return;
  await handle.sync().catch(() => undefined);
  await handle.close();
}

async function writeSmallFile(directory: string, fileName: string, content: string): Promise<void> {
  const temporary = path.join(directory, `${fileName}${temporarySuffix}`);
  const handle = await fs.open(temporary, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(temporary, path.join(directory, fileName));
}

// PostgreSQL tools

/** Connection settings for pg_dump and pg_restore. The password travels here, never in arguments. */
export function pgConnectionEnvironment(databaseUrl: string): NodeJS.ProcessEnv {
  const url = new URL(databaseUrl);
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    LC_ALL: "C",
    PGHOST: url.hostname.replace(/^\[|\]$/g, ""),
    PGPORT: url.port || "5432",
    PGDATABASE: decodeURIComponent(url.pathname.replace(/^\//, "")),
    PGAPPNAME: "srtl-manager-backup"
  };
  if (url.username) env.PGUSER = decodeURIComponent(url.username);
  if (url.password) env.PGPASSWORD = decodeURIComponent(url.password);
  for (const [parameter, name] of [["sslmode", "PGSSLMODE"], ["sslrootcert", "PGSSLROOTCERT"], ["sslcert", "PGSSLCERT"], ["sslkey", "PGSSLKEY"]] as const) {
    const value = url.searchParams.get(parameter);
    if (value) env[name] = value;
  }
  return env;
}

function redacted(text: string, env: NodeJS.ProcessEnv): string {
  const password = env.PGPASSWORD;
  return password ? text.replaceAll(password, "[redacted]") : text;
}

function commandFailure(tool: string, result: BackupCommandResult, env: NodeJS.ProcessEnv): string {
  const detail = redacted(result.stderr, env).trim().split("\n").slice(-5).join(" ").slice(0, 1_000);
  return `${tool} exited with code ${result.exitCode ?? "unknown"}${detail ? `: ${detail}` : ""}`;
}

function toolPath(runtime: Pick<BackupRuntime, "pgBinDir">, tool: "pg_dump" | "pg_restore"): string {
  return runtime.pgBinDir ? path.join(runtime.pgBinDir, tool) : tool;
}

function runnerFor(runtime: Pick<BackupRuntime, "runCommand">): BackupCommandRunner {
  return runtime.runCommand ?? defaultBackupCommandRunner;
}

async function toolVersion(runtime: BackupRuntime, tool: "pg_dump" | "pg_restore"): Promise<{ text: string; major: number }> {
  let result: BackupCommandResult;
  try {
    result = await runnerFor(runtime)({ file: toolPath(runtime, tool), args: ["--version"], env: { PATH: process.env.PATH, LC_ALL: "C" }, timeoutMs: 30_000 });
  } catch (error) {
    if (errorCode(error) === "ENOENT" || errorCode(error) === "EACCES") {
      throw new BackupFailure(`${tool} was not found. Install the PostgreSQL ${minimumPgDumpMajor} client tools, or set SRTL_PG_BIN_DIR to the folder that holds them.`, { cause: error });
    }
    throw error;
  }
  const match = /(\d+)(?:\.\d+)?/.exec(result.stdout);
  if (result.exitCode !== 0 || !match) throw new BackupFailure(`${tool} could not report its version. Check the PostgreSQL client installation.`);
  return { text: result.stdout.trim(), major: Number(match[1]) };
}

interface DatabaseFacts {
  serverMajor: number;
  serverVersion: string;
  databaseSizeBytes: number;
  migration: number;
}

async function databaseFacts(db: Db): Promise<DatabaseFacts> {
  const row = await dbGet<{ serverVersionNum: string; serverVersion: string; size: string; migration: number | null }>(db, sql`
    SELECT current_setting('server_version_num') AS "serverVersionNum",
           current_setting('server_version') AS "serverVersion",
           pg_database_size(current_database())::text AS size,
           (SELECT max(version) FROM schema_migrations)::integer AS migration
  `);
  if (!row) throw new Error("The database did not report its version");
  return {
    serverMajor: Math.floor(Number(row.serverVersionNum) / 10_000),
    serverVersion: row.serverVersion,
    databaseSizeBytes: Number(row.size),
    migration: row.migration ?? 0
  };
}

/** Confirms the client tools exist and can read this server: pg_dump refuses a server newer than itself. */
async function checkTools(runtime: BackupRuntime, facts: DatabaseFacts): Promise<string> {
  const pgDump = await toolVersion(runtime, "pg_dump");
  const pgRestore = await toolVersion(runtime, "pg_restore");
  const required = Math.max(minimumPgDumpMajor, facts.serverMajor);
  for (const [tool, version] of [["pg_dump", pgDump], ["pg_restore", pgRestore]] as const) {
    if (version.major < required) {
      throw new BackupFailure(`${tool} is version ${version.major}, but this PostgreSQL ${facts.serverMajor} database needs version ${required} or newer. Install a newer client, or point SRTL_PG_BIN_DIR at it.`);
    }
  }
  return pgDump.text;
}

export function requiredFreeBytes(databaseSizeBytes: number, previousDumpBytes: number | null): number {
  return Math.ceil(Math.max(databaseSizeBytes * 0.5, (previousDumpBytes ?? 0) * 1.5)) + freeSpaceMarginBytes;
}

async function defaultFreeBytes(directory: string): Promise<number> {
  const stat = await fs.statfs(directory);
  return stat.bavail * stat.bsize;
}

/** Re-reads the final dump against its checksum file and asks pg_restore to read the whole archive header. */
export async function verifyBackupFiles(directory: string, name: string, runtime: BackupRuntime, signal?: AbortSignal): Promise<string> {
  const dumpPath = path.join(directory, `${name}${dumpSuffix}`);
  const recorded = /^([0-9a-f]{64}) {2}/.exec((await readChecksumFile(directory, name)) ?? "")?.[1];
  if (!recorded) throw new BackupFailure("Verification failed: the checksum file is missing or unreadable.");
  const actual = await sha256File(dumpPath, signal);
  if (actual !== recorded) throw new BackupFailure("Verification failed: the dump does not match its checksum.");
  const env = pgConnectionEnvironment(runtime.databaseUrl);
  const list = await runnerFor(runtime)({ file: toolPath(runtime, "pg_restore"), args: ["--list", dumpPath], env: { PATH: env.PATH, LC_ALL: "C" }, signal, background: true });
  if (list.exitCode !== 0) throw new BackupFailure(`Verification failed: ${commandFailure("pg_restore --list", list, env)}`);
  if (!/ TABLE public schema_migrations /.test(list.stdout)) throw new BackupFailure("Verification failed: the archive does not contain the SRTL Manager tables.");
  return actual;
}

async function dumpDatabase(temporaryPath: string, runtime: BackupRuntime, signal: AbortSignal): Promise<void> {
  const env = pgConnectionEnvironment(runtime.databaseUrl);
  // Written through this descriptor so the file is private from its first byte.
  const handle = await fs.open(temporaryPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
  try {
    const result = await runnerFor(runtime)({
      file: toolPath(runtime, "pg_dump"),
      // The lock timeout makes the dump give up rather than queue behind a schema change and hold up everything queued behind it.
      args: ["--format=custom", "--no-password", "--lock-wait-timeout=120000"],
      env,
      stdoutFd: handle.fd,
      signal,
      background: true
    });
    if (result.exitCode !== 0) throw new BackupFailure(commandFailure("pg_dump", result, env));
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function removeRunFiles(directory: string, name: string): Promise<void> {
  for (const suffix of [`${dumpSuffix}${temporarySuffix}`, dumpSuffix, `${checksumSuffix}${temporarySuffix}`, checksumSuffix, `${manifestSuffix}${temporarySuffix}`]) {
    await removeRegularFile(path.join(directory, `${name}${suffix}`)).catch(() => undefined);
  }
}

export async function getBackupSettings(db: Db): Promise<BackupSettings> {
  return normalizeBackupSettings(await getJsonSetting<unknown>(db, backupSettingsKey, {}));
}

function pathProblem(error: unknown, location: string): string {
  return error instanceof BackupFailure ? error.message : locationProblem(location, error);
}

/** Looks at the location and publishes what it found for the API, which never touches this folder itself. */
export async function refreshBackupStatus(db: Db, runtime: BackupRuntime): Promise<BackupLocationStatus> {
  const settings = await getBackupSettings(db);
  const location = settings.location ?? runtime.defaultLocation;
  const status: BackupLocationStatus = {
    location,
    directory: path.join(location, backupFolderName),
    checkedAt: nowIso(),
    ready: true,
    problem: null,
    permissionsWarning: null,
    freeBytes: null,
    backups: []
  };
  try {
    const refusal = await backupLocationRefusal(location, await backupMediaRoots(db, runtime));
    if (refusal) throw new BackupFailure(refusal);
    const prepared = await withFilesystemTimeout(prepareBackupDirectory(location), "Backup location check", locationCheckTimeoutMs);
    status.permissionsWarning = prepared.permissionsWarning;
    status.freeBytes = await (runtime.freeBytes ?? defaultFreeBytes)(prepared.directory);
    status.backups = (await listBackups(prepared.directory)).slice(0, statusListLimit).map((set) => set.entry);
    await checkTools(runtime, await databaseFacts(db));
  } catch (error) {
    status.ready = false;
    status.problem = pathProblem(error, location);
  }
  await setSetting(db, backupStatusKey, status);
  return status;
}

/** The job's work. Anything thrown here fails the job with its message, and every failure leaves earlier backups as they were. */
export async function runBackup(db: Db, runtime: BackupRuntime, ctx: BackupJobContext, trigger: BackupTrigger): Promise<void> {
  const settings = await getBackupSettings(db);
  const location = settings.location ?? runtime.defaultLocation;
  const report = async (stage: string, message: string) => {
    await ctx.setProgress({ options: { trigger }, stage, message });
  };
  try {
    await report("checking", "Checking the backup location");
    const refusal = await backupLocationRefusal(location, await backupMediaRoots(db, runtime));
    if (refusal) throw new BackupFailure(refusal);
    const facts = await databaseFacts(db);
    const pgDumpVersion = await checkTools(runtime, facts);
    let directory: string;
    try {
      directory = (await withFilesystemTimeout(prepareBackupDirectory(location), "Backup location check", locationCheckTimeoutMs)).directory;
    } catch (error) {
      throw new BackupFailure(locationProblem(location, error), { cause: error });
    }
    await removeInterruptedFiles(directory);
    const previous = newestVerifiedBackup((await listBackups(directory)).map((set) => set.entry));
    const needed = requiredFreeBytes(facts.databaseSizeBytes, previous?.sizeBytes ?? null);
    const free = await (runtime.freeBytes ?? defaultFreeBytes)(directory);
    if (free < needed) {
      throw new BackupFailure(`Not enough free space at the backup location: ${formatSize(free)} free, about ${formatSize(needed)} needed for a ${formatSize(facts.databaseSizeBytes)} database.`);
    }

    const createdAt = new Date();
    const name = backupName(createdAt, ctx.jobId);
    const dumpPath = path.join(directory, `${name}${dumpSuffix}`);
    try {
      await report("dumping", "Dumping the database");
      const temporaryDump = `${dumpPath}${temporarySuffix}`;
      await dumpDatabase(temporaryDump, runtime, ctx.signal);
      const sha256 = await sha256File(temporaryDump, ctx.signal);
      await fs.rename(temporaryDump, dumpPath);
      await writeSmallFile(directory, `${name}${checksumSuffix}`, checksumLine(sha256, name));

      await report("verifying", "Verifying the backup");
      await verifyBackupFiles(directory, name, runtime, ctx.signal);
      const manifest: BackupManifest = {
        format: backupManifestFormat,
        formatVersion: 1,
        name,
        dumpFile: `${name}${dumpSuffix}`,
        checksumFile: `${name}${checksumSuffix}`,
        createdAt: createdAt.toISOString(),
        verifiedAt: nowIso(),
        appVersion: packageJson.version,
        migration: facts.migration,
        databaseSizeBytes: facts.databaseSizeBytes,
        dumpSizeBytes: (await fs.stat(dumpPath)).size,
        sha256,
        postgresVersion: facts.serverVersion,
        pgDumpVersion,
        trigger,
        jobId: ctx.jobId,
        restoreNeeds: "SRTL_SECRET_KEY, the key this install used when the backup was made, to read saved Plex tokens and API keys"
      };
      // Written last: a manifest is what makes this a verified backup.
      await writeSmallFile(directory, `${name}${manifestSuffix}`, `${JSON.stringify(manifest, null, 2)}\n`);
      await syncDirectory(directory);
    } catch (error) {
      await removeRunFiles(directory, name);
      throw error;
    }

    await ctx.assertLease();
    await report("pruning", "Removing older backups");
    let removed: string[] = [];
    try {
      removed = await pruneBackups(directory, settings.keep);
    } catch (error) {
      // The new backup is good; a prune that failed only means older ones stay until next time.
      await ctx.event("warn", `Older backups could not be removed: ${errorText(error)}`);
    }
    const summary = `Backup ${name} verified${removed.length > 0 ? `, removed ${removed.length} older backup${removed.length === 1 ? "" : "s"}` : ""}`;
    await ctx.event("info", summary, { name, removed });
    await report("completed", summary);
  } finally {
    await refreshBackupStatus(db, runtime).catch((error: unknown) => {
      console.error(`Backup status could not be refreshed: ${errorText(error)}`);
    });
  }
}

// What the API reports

function triggerOf(row: typeof schema.jobs.$inferSelect): BackupTrigger {
  try {
    return (JSON.parse(row.options ?? "{}") as { trigger?: unknown }).trigger === "scheduled" ? "scheduled" : "manual";
  } catch {
    return "manual";
  }
}

async function lastBackupRun(db: Db): Promise<BackupRunSummary | null> {
  const row = await first(
    db.select().from(schema.jobs)
      .where(and(eq(schema.jobs.type, "backup"), inArray(schema.jobs.status, ["completed", "partially_failed", "failed", "cancelled"])))
      .orderBy(desc(schema.jobs.id))
      .limit(1)
  );
  if (!row) return null;
  const status = row.status as BackupRunSummary["status"];
  const events = await db.select({ level: schema.jobEvents.level, message: schema.jobEvents.message }).from(schema.jobEvents)
    .where(eq(schema.jobEvents.jobId, row.id))
    .orderBy(desc(schema.jobEvents.id))
    .limit(10);
  const finalEvent = status === "failed"
    ? events.find((event) => event.level === "error")
    : events.find((event) => event.message.startsWith("Backup "));
  return {
    jobId: row.id,
    status,
    trigger: triggerOf(row),
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    message: finalEvent?.message ?? (status === "cancelled" ? "The backup was cancelled." : status === "failed" ? "The backup failed." : "The backup finished.")
  };
}

export async function getBackupState(db: Db, runtime: Pick<BackupRuntime, "defaultLocation" | "paths">, now = new Date()): Promise<BackupState> {
  const settings = await getBackupSettings(db);
  const location = settings.location ?? runtime.defaultLocation;
  const savedStatus = await getJsonSetting<BackupLocationStatus | null>(db, backupStatusKey, null);
  const status = savedStatus?.location === location ? savedStatus : null;
  const active = await first(
    db.select({ id: schema.jobs.id }).from(schema.jobs)
      .where(and(eq(schema.jobs.type, "backup"), inArray(schema.jobs.status, ["queued", "running"])))
      .orderBy(desc(schema.jobs.id))
      .limit(1)
  );
  const lastRun = await lastBackupRun(db);
  const locationRefusal = await backupLocationRefusal(location, await backupMediaRoots(db, runtime));
  const anchorAt = await getJsonSetting<string | null>(db, backupScheduleAnchorKey, null);
  const alert: BackupAlert | null = (await isOnboardingComplete(db))
    ? backupAlert({ settings, anchorAt, locationRefusal, status, lastRun, activeJobId: active?.id ?? null, now })
    : null;
  return {
    settings,
    location,
    defaultLocation: runtime.defaultLocation,
    locationRefusal,
    status,
    lastRun,
    activeJobId: active?.id ?? null,
    nextRunAt: settings.enabled ? nextBackupSlot(settings.time, now).toISOString() : null,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    alert
  };
}
