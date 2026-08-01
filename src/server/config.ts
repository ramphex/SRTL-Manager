import fs from "node:fs";
import path from "node:path";
import type { PathsSettings } from "../shared/types";
import { mergeEnvSettings, readEnvFile, readProcessEnvSettings } from "./lib/env";

export interface AppConfig {
  rootDir: string;
  dataDir: string;
  databaseUrl: string;
  host: string;
  port: number;
  sessionCookieName: string;
  sessionCookieSecure: boolean;
  allowedOrigins: string[];
  apiDocsEnabled: boolean;
  autoMigrate: boolean;
  trustProxy: boolean;
  webRoot: string;
  jobConcurrency: JobConcurrencySettings;
  paths: PathsSettings;
}

export interface JobConcurrencySettings {
  workerCount: number;
  maxRunningJobs: number;
  maxRunningScans: number;
  maxRunningAudits: number;
  maxRunningCopies: number;
  copyFileConcurrency: number;
  maxActiveCopyFiles: number;
}

const exampleDatabasePassword = "replace-with-your-password";

function booleanSetting(value: string | undefined, fallback: boolean): boolean {
  if (value == null || value.trim() === "") return fallback;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw new Error(`Invalid boolean setting: ${value}`);
}

function originSettings(value: string | undefined): string[] {
  if (!value) return [];
  return [
    ...new Set(
      value
        .split(",")
        .map((origin) => origin.trim().replace(/\/$/, ""))
        .filter(Boolean)
        .map((origin) => {
          const parsed = new URL(origin);
          if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
            throw new Error(`Invalid allowed origin: ${origin}`);
          }
          return parsed.origin;
        })
    )
  ];
}

function portSetting(value: number | string | undefined, fallback: number): number {
  const parsed = value == null || value === "" ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) throw new Error(`Invalid port setting: ${String(value)}`);
  return parsed;
}

function databaseUrlSetting(value: string): string {
  const parsed = new URL(value);
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") throw new Error("SRTL_DATABASE_URL must use postgres:// or postgresql://");
  if (!parsed.hostname || !parsed.pathname || parsed.pathname === "/") throw new Error("SRTL_DATABASE_URL must include a host and database name");
  return value;
}

function requiredDatabaseSetting(value: string | undefined, name: string, fallback: string): string {
  const resolved = value?.trim() || fallback;
  if (!resolved) throw new Error(`${name} must not be empty`);
  return resolved;
}

export function resolveDatabaseUrl(envFile: ReturnType<typeof readEnvFile> = {}): string {
  const explicitUrl = process.env.SRTL_DATABASE_URL ?? envFile.SRTL_DATABASE_URL;
  if (explicitUrl) return databaseUrlSetting(explicitUrl);

  const host = requiredDatabaseSetting(process.env.SRTL_POSTGRES_HOST ?? envFile.SRTL_POSTGRES_HOST, "SRTL_POSTGRES_HOST", "127.0.0.1");
  const port = portSetting(process.env.SRTL_POSTGRES_PORT ?? envFile.SRTL_POSTGRES_PORT, 5432);
  const database = requiredDatabaseSetting(process.env.SRTL_POSTGRES_DB ?? envFile.SRTL_POSTGRES_DB, "SRTL_POSTGRES_DB", "srtl_manager");
  const user = requiredDatabaseSetting(process.env.SRTL_POSTGRES_USER ?? envFile.SRTL_POSTGRES_USER, "SRTL_POSTGRES_USER", "srtl");
  const password = process.env.SRTL_POSTGRES_PASSWORD ?? envFile.SRTL_POSTGRES_PASSWORD ?? (process.env.NODE_ENV === "production" ? "" : "srtl");
  if (!password) throw new Error("SRTL_POSTGRES_PASSWORD must not be empty");
  if (process.env.NODE_ENV === "production" && password.trim().toLowerCase() === exampleDatabasePassword) {
    throw new Error("SRTL_POSTGRES_PASSWORD still uses the .env.example placeholder");
  }

  const url = new URL("postgresql://localhost");
  url.hostname = host;
  url.port = String(port);
  url.username = user;
  url.password = password;
  url.pathname = `/${database}`;
  return databaseUrlSetting(url.toString());
}

function integerSetting(value: number | string | undefined, fallback: number, name: string, minimum: 0 | 1): number {
  if (value == null) return fallback;
  const normalized = typeof value === "string" ? value.trim() : value;
  if (typeof normalized === "string" && !/^(0|[1-9]\d*)$/.test(normalized)) {
    throw new Error(`${name} must be a ${minimum === 0 ? "non-negative" : "positive"} safe integer`);
  }
  const parsed = typeof normalized === "number" ? normalized : Number(normalized);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    throw new Error(`${name} must be a ${minimum === 0 ? "non-negative" : "positive"} safe integer`);
  }
  return parsed;
}

function loadJobConcurrency(envFile: ReturnType<typeof readEnvFile>, overrides: Partial<JobConcurrencySettings> | undefined = {}): JobConcurrencySettings {
  const workerCount = integerSetting(overrides.workerCount ?? process.env.SRTL_WORKER_COUNT ?? envFile.SRTL_WORKER_COUNT, 1, "SRTL_WORKER_COUNT", 1);
  const maxRunningJobs = integerSetting(
    overrides.maxRunningJobs ?? process.env.SRTL_MAX_RUNNING_JOBS ?? envFile.SRTL_MAX_RUNNING_JOBS,
    workerCount,
    "SRTL_MAX_RUNNING_JOBS",
    1
  );
  const settings: JobConcurrencySettings = {
    workerCount,
    maxRunningJobs,
    maxRunningScans: integerSetting(
      overrides.maxRunningScans ?? process.env.SRTL_MAX_RUNNING_SCANS ?? envFile.SRTL_MAX_RUNNING_SCANS,
      maxRunningJobs,
      "SRTL_MAX_RUNNING_SCANS",
      0
    ),
    maxRunningAudits: integerSetting(
      overrides.maxRunningAudits ?? process.env.SRTL_MAX_RUNNING_AUDITS ?? envFile.SRTL_MAX_RUNNING_AUDITS,
      maxRunningJobs,
      "SRTL_MAX_RUNNING_AUDITS",
      0
    ),
    maxRunningCopies: integerSetting(
      overrides.maxRunningCopies ?? process.env.SRTL_MAX_RUNNING_COPIES ?? envFile.SRTL_MAX_RUNNING_COPIES,
      maxRunningJobs,
      "SRTL_MAX_RUNNING_COPIES",
      0
    ),
    copyFileConcurrency: integerSetting(
      overrides.copyFileConcurrency ?? process.env.SRTL_COPY_FILE_CONCURRENCY ?? envFile.SRTL_COPY_FILE_CONCURRENCY,
      1,
      "SRTL_COPY_FILE_CONCURRENCY",
      1
    ),
    maxActiveCopyFiles: integerSetting(
      overrides.maxActiveCopyFiles ?? process.env.SRTL_MAX_ACTIVE_COPY_FILES ?? envFile.SRTL_MAX_ACTIVE_COPY_FILES,
      workerCount,
      "SRTL_MAX_ACTIVE_COPY_FILES",
      1
    )
  };
  if (settings.maxRunningJobs > settings.workerCount) throw new Error("SRTL_MAX_RUNNING_JOBS must not exceed SRTL_WORKER_COUNT");
  for (const [name, value] of [
    ["SRTL_MAX_RUNNING_SCANS", settings.maxRunningScans],
    ["SRTL_MAX_RUNNING_AUDITS", settings.maxRunningAudits],
    ["SRTL_MAX_RUNNING_COPIES", settings.maxRunningCopies]
  ] as const) {
    if (value > settings.maxRunningJobs) throw new Error(`${name} must not exceed SRTL_MAX_RUNNING_JOBS`);
  }
  if (settings.copyFileConcurrency > settings.maxActiveCopyFiles) {
    throw new Error("SRTL_COPY_FILE_CONCURRENCY must not exceed SRTL_MAX_ACTIVE_COPY_FILES");
  }
  return settings;
}

export function loadConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const rootDir = overrides.rootDir ?? process.cwd();
  const envFile = readEnvFile(path.join(rootDir, ".env"));
  const environment = mergeEnvSettings(envFile, readProcessEnvSettings());
  const dataDir = overrides.dataDir ?? process.env.SRTL_DATA_DIR ?? envFile.SRTL_DATA_DIR ?? path.join(rootDir, "data");
  const databaseUrl = overrides.databaseUrl ? databaseUrlSetting(overrides.databaseUrl) : resolveDatabaseUrl(envFile);
  const publicWebPortValue = process.env.SRTL_WEB_PORT ?? envFile.SRTL_WEB_PORT;
  const publicWebPort = publicWebPortValue ? portSetting(publicWebPortValue, 5179) : null;
  if (!path.isAbsolute(dataDir)) throw new Error(`SRTL_DATA_DIR must be an absolute path: ${dataDir}`);
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });

  return {
    rootDir,
    dataDir,
    databaseUrl,
    host: overrides.host ?? process.env.SRTL_HOST ?? envFile.SRTL_HOST ?? "127.0.0.1",
    port: portSetting(overrides.port ?? process.env.SRTL_PORT ?? envFile.SRTL_PORT, 3010),
    sessionCookieName: overrides.sessionCookieName ?? (publicWebPort ? `srtl_session_${publicWebPort}` : "srtl_session"),
    sessionCookieSecure:
      overrides.sessionCookieSecure ?? booleanSetting(process.env.SRTL_COOKIE_SECURE ?? envFile.SRTL_COOKIE_SECURE, false),
    allowedOrigins: overrides.allowedOrigins ?? originSettings(process.env.SRTL_ALLOWED_ORIGINS ?? envFile.SRTL_ALLOWED_ORIGINS),
    apiDocsEnabled:
      overrides.apiDocsEnabled ?? booleanSetting(process.env.SRTL_API_DOCS ?? envFile.SRTL_API_DOCS, process.env.NODE_ENV !== "production"),
    autoMigrate:
      overrides.autoMigrate ?? booleanSetting(process.env.SRTL_AUTO_MIGRATE ?? envFile.SRTL_AUTO_MIGRATE, process.env.NODE_ENV !== "production"),
    trustProxy: overrides.trustProxy ?? booleanSetting(process.env.SRTL_TRUST_PROXY ?? envFile.SRTL_TRUST_PROXY, false),
    webRoot: overrides.webRoot ?? process.env.SRTL_WEB_ROOT ?? envFile.SRTL_WEB_ROOT ?? path.join(rootDir, "dist", "client"),
    jobConcurrency: loadJobConcurrency(envFile, overrides.jobConcurrency),
    paths: overrides.paths ?? {
      symlinkDir: environment.SYMLINK_DIR ?? "",
      // The two-location engine currently maps numbered deployment slots to
      // the Local and Remote interface roles.
      localDir: environment.SRTL_LOCATION_1_PATH ?? "",
      remoteDir: environment.SRTL_LOCATION_2_PATH ?? ""
    }
  };
}
