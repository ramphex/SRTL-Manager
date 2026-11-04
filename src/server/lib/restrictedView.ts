import type { FastifyRequest } from "fastify";
import type { Db } from "../db/database";
import { getJsonSetting } from "../db/database";
import { backupSettingsKey } from "./backups";
import { roleHasPermission } from "../../shared/permissions";
import type { BackupSettings } from "../../shared/backups";
import type { JobEventPage, JobEventRecord, JobRecord, JobType, PathsSettings } from "../../shared/types";

/**
 * What an account without `settings.manage` is allowed to read. Routes that
 * exist for settings are refused outright by the route table; this covers
 * everything else such a person can open, so a path root, address or credential
 * cannot reach them through a job log, an error message or a new field somebody
 * adds later. Every response to them passes through `scrubValue`.
 */

export interface SensitiveRoot {
  path: string;
  label: string;
}

export interface RestrictedViewRuntime {
  paths: PathsSettings;
  backupDir: string;
  dataDir: string;
}

const sensitiveKey = /password|passwd|passphrase|secret|token|api[-_]?key|authorization|credential|cookie|private[-_]?key/i;
const pathKey = /(path|dir|directory|root)$/i;
const addressPattern = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi;
const hostPortPattern = /(?:\b\d{1,3}(?:\.\d{1,3}){3}|\[[0-9a-f:]+\]|\blocalhost|\b[a-z0-9-]+(?:\.[a-z0-9-]+)+):\d{2,5}\b/gi;
// `>` is left out of what may come before a path, so that `<remote>/Movies` stays as it is.
const absolutePathPattern = /(^|[\s"'`(=,:{[])(\/(?!api\/(?!\.\.))[^\s"'`<>,;:)\]]+(?:\/[^\s"'`<>,;:)\]]+)+)/g;

function baseName(value: string): string {
  return value.split(/[?#]/, 1)[0]!.replace(/\/+$/, "").split("/").pop() ?? "";
}

function replaceRoot(text: string, root: SensitiveRoot): string {
  let result = "";
  let cursor = 0;
  for (let at = text.indexOf(root.path); at !== -1; at = text.indexOf(root.path, cursor)) {
    const end = at + root.path.length;
    const next = text[end];
    // Only a whole path: `/mnt/media` must not match inside `/mnt/media2`.
    const whole = next === undefined || !/[\w.-]/.test(next);
    result += text.slice(cursor, at) + (whole ? root.label : root.path);
    cursor = end;
  }
  return result + text.slice(cursor);
}

/** Removes configured roots, addresses and any other absolute path from text, keeping the library part people need to read. */
export function scrubText(text: string, roots: readonly SensitiveRoot[]): string {
  if (!text.includes("/") && !text.includes(":")) return text;
  let result = text;
  for (const root of roots) result = replaceRoot(result, root);
  return result
    .replace(addressPattern, "<address>")
    .replace(hostPortPattern, "<address>")
    .replace(absolutePathPattern, (_match, before: string, found: string) => `${before}…/${baseName(found)}`);
}

export function scrubValue(value: unknown, roots: readonly SensitiveRoot[], key = ""): unknown {
  if (typeof value === "string") {
    // A field that holds nothing but a path outside the known roots, where spaces cannot end the match early.
    if (pathKey.test(key) && value.startsWith("/") && !roots.some((root) => value === root.path || value.startsWith(`${root.path}/`))) return `…/${baseName(value)}`;
    return scrubText(value, roots);
  }
  if (Array.isArray(value)) return value.map((entry) => scrubValue(entry, roots, key));
  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [entryKey, entry] of Object.entries(value)) {
      // A flag such as `mustChangePassword` says nothing secret.
      if (!sensitiveKey.test(entryKey) || typeof entry === "boolean") output[scrubText(entryKey, roots)] = scrubValue(entry, roots, entryKey);
    }
    return output;
  }
  return value;
}

export async function loadSensitiveRoots(db: Db, runtime: RestrictedViewRuntime): Promise<SensitiveRoot[]> {
  const [paths, backups] = await Promise.all([
    getJsonSetting<Partial<PathsSettings>>(db, "paths", {}),
    getJsonSetting<Partial<BackupSettings>>(db, backupSettingsKey, {})
  ]);
  const candidates: Array<[string | null | undefined, string]> = [
    [paths.symlinkDir, "<symlinks>"],
    [paths.localDir, "<local>"],
    [paths.remoteDir, "<remote>"],
    [runtime.paths.symlinkDir, "<symlinks>"],
    [runtime.paths.localDir, "<local>"],
    [runtime.paths.remoteDir, "<remote>"],
    [backups.location, "<backups>"],
    [runtime.backupDir, "<backups>"],
    [runtime.dataDir, "<data>"]
  ];
  const roots = new Map<string, string>();
  for (const [root, label] of candidates) {
    const trimmed = root?.replace(/(?<=.)\/+$/, "");
    if (trimmed && trimmed !== "/" && !roots.has(trimmed)) roots.set(trimmed, label);
  }
  // Longest first, so a root nested in another is replaced as itself.
  return [...roots].map(([path, label]) => ({ path, label })).sort((left, right) => right.path.length - left.path.length);
}

/** True when this request's account may not receive path, connection or backup details. */
export function isRestrictedRequest(request: FastifyRequest): boolean {
  const session = request.adminSession;
  return session !== null && !roleHasPermission(session.role, "settings.manage");
}

// Their logs are about backup folders, path moves and media server connections, which have nothing else to show.
const settingsJobTypes: ReadonlySet<JobType> = new Set(["backup", "path_migration", "watch_sync"]);

export function jobDetailsHidden(type: JobType): boolean {
  return settingsJobTypes.has(type);
}

/** Keeps a settings job's type, status and times, which are all a restricted account needs to see that it ran. */
export function restrictedJob<T extends Pick<JobRecord, "type" | "options" | "progress" | "lockedBy">>(job: T): T {
  // A worker's name can be its host's name.
  const shown = { ...job, lockedBy: null };
  return jobDetailsHidden(job.type) ? { ...shown, options: {}, progress: {}, selection: undefined } : shown;
}

export const emptyEventPage: JobEventPage = { events: [] as JobEventRecord[], total: 0, hasOlder: false };

export const emptyPaths: PathsSettings = { symlinkDir: "", localDir: "", remoteDir: "" };
