import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import type { PathsSettings } from "../shared/types";
import { mergeEnvSettings, readEnvFile, readProcessEnvSettings } from "./lib/env";
import { isValidSetupToken } from "./setupToken";
import { parseOutboundPolicy, type OutboundPolicy } from "./lib/outboundPolicy";
import type { SecretKeyOptions } from "./lib/secretBox";

/** Anonymous requests allowed per client address per minute. */
export const defaultAnonymousRequestsPerMinute = 600;

export interface AppConfig {
  rootDir: string;
  dataDir: string;
  databaseUrl: string;
  host: string;
  port: number;
  /** Base session cookie name. With Secure cookies it is sent with the `__Host-` prefix. */
  sessionCookieName: string;
  sessionCookieSecure: boolean;
  /** A session ends after this many hours without a request. */
  sessionIdleTimeoutHours: number;
  /** A session ends this many days after sign-in. */
  sessionMaxAgeDays: number;
  /** Fixed first-run setup token from SRTL_SETUP_TOKEN; otherwise one is generated. */
  setupToken: string | null;
  allowedOrigins: string[];
  publicOrigin: string | null;
  apiDocsEnabled: boolean;
  autoMigrate: boolean;
  trustProxy: TrustProxySetting;
  anonymousRequestsPerMinute: number;
  webRoot: string;
  jobHistoryRetentionDays: number;
  jobConcurrency: JobConcurrencySettings;
  paths: PathsSettings;
  /** Addresses SRTL may call for Plex, Jellyfin, Radarr and Sonarr (SRTL_OUTBOUND_ALLOW_CIDRS). */
  outboundPolicy: OutboundPolicy;
  /** SRTL_DISCARD_UNREADABLE_CREDENTIALS: start without the credentials a lost secret key sealed. */
  discardUnreadableCredentials: boolean;
  nowPlayingStreams: NowPlayingStreamLimits;
}

export interface NowPlayingStreamLimits {
  /** Open Now Playing streams one signed-in session may hold. */
  perSession: number;
  /** Open Now Playing streams across all sessions. */
  total: number;
  /** How often an open stream re-checks that its session is still signed in. */
  revalidateMs: number;
}

export const defaultNowPlayingStreamLimits: NowPlayingStreamLimits = { perSession: 4, total: 32, revalidateMs: 20_000 };

/**
 * Reverse proxies whose forwarding headers are trusted: `false`, or a list of
 * addresses, CIDR ranges and the proxy-addr names `loopback`, `linklocal` and
 * `uniquelocal`. There is no "trust everyone" setting.
 */
export type TrustProxySetting = false | string[];

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

function parseOrigin(origin: string, label: string): string {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    throw new Error(`Invalid ${label}: ${origin}`);
  }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error(`Invalid ${label}: ${origin}`);
  }
  return parsed.origin;
}

function originSettings(value: string | undefined): string[] {
  if (!value) return [];
  return [
    ...new Set(
      value
        .split(",")
        .map((origin) => origin.trim().replace(/\/$/, ""))
        .filter(Boolean)
        .map((origin) => parseOrigin(origin, "allowed origin"))
    )
  ];
}

function publicOriginSetting(value: string | undefined): string | null {
  const trimmed = value?.trim().replace(/\/$/, "");
  return trimmed ? parseOrigin(trimmed, "SRTL_PUBLIC_ORIGIN") : null;
}

const trustProxyKeywords = new Set(["loopback", "linklocal", "uniquelocal"]);

function trustProxyEntry(entry: string): string {
  const normalized = entry.toLowerCase();
  if (trustProxyKeywords.has(normalized)) return normalized;
  const [address, prefix, ...rest] = normalized.split("/");
  const family = net.isIP(address ?? "");
  if (family === 0 || rest.length > 0) throw new Error(`Invalid SRTL_TRUST_PROXY entry: ${entry}. Use an IP address, a CIDR range or loopback.`);
  if (prefix === undefined) return normalized;
  const bits = /^\d{1,3}$/.test(prefix) ? Number(prefix) : Number.NaN;
  const maxBits = family === 4 ? 32 : 128;
  if (!Number.isInteger(bits) || bits < 1 || bits > maxBits) {
    throw new Error(`Invalid SRTL_TRUST_PROXY entry: ${entry}. The prefix length must be between 1 and ${maxBits}.`);
  }
  return normalized;
}

/**
 * Parses SRTL_TRUST_PROXY. `true` used to trust forwarding headers from any
 * client, which let anyone choose their own address for rate limits and logs,
 * so it is refused with a message naming the replacement.
 */
export function trustProxySetting(value: string | undefined): TrustProxySetting {
  const trimmed = value?.trim() ?? "";
  if (trimmed === "") return false;
  const lowered = trimmed.toLowerCase();
  if (["0", "false", "no", "off"].includes(lowered)) return false;
  if (["1", "true", "yes", "on", "*", "all"].includes(lowered)) {
    throw new Error(
      "SRTL_TRUST_PROXY no longer accepts true. List the reverse proxy addresses or CIDR ranges instead, for example SRTL_TRUST_PROXY=192.168.1.10 or SRTL_TRUST_PROXY=172.18.0.0/16, or use loopback when the proxy runs on the same host."
    );
  }
  const entries = trimmed.split(/[\s,]+/).filter(Boolean).map(trustProxyEntry);
  return [...new Set(entries)];
}

function boundedIntegerSetting(value: number | string | undefined, fallback: number, name: string, minimum: number, maximum: number): number {
  if (value == null || (typeof value === "string" && value.trim() === "")) return fallback;
  const normalized = typeof value === "string" ? value.trim() : value;
  const parsed = typeof normalized === "number" ? normalized : /^\d+$/.test(normalized) ? Number(normalized) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) throw new Error(`${name} must be a whole number from ${minimum} to ${maximum}`);
  return parsed;
}

function setupTokenSetting(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) return null;
  if (!isValidSetupToken(trimmed)) throw new Error("SRTL_SETUP_TOKEN must be 24 to 256 letters, digits, '-' or '_'. Remove it to have a token generated.");
  return trimmed;
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

function dataDirSetting(rootDir: string, envFile: ReturnType<typeof readEnvFile>, override?: string): string {
  return override ?? process.env.SRTL_DATA_DIR ?? envFile.SRTL_DATA_DIR ?? path.join(rootDir, "data");
}

/**
 * Where the key for stored credentials comes from: SRTL_SECRET_KEY, SRTL_SECRET_KEY_FILE, or `secret.key` in the
 * data directory. Kept out of AppConfig so the key never travels with the rest of the configuration.
 */
export function secretKeyOptions(rootDir = process.cwd(), dataDir?: string): SecretKeyOptions {
  const envFile = readEnvFile(path.join(rootDir, ".env"));
  return {
    key: process.env.SRTL_SECRET_KEY ?? envFile.SRTL_SECRET_KEY ?? null,
    keyFile: process.env.SRTL_SECRET_KEY_FILE ?? envFile.SRTL_SECRET_KEY_FILE ?? null,
    dataDir: dataDirSetting(rootDir, envFile, dataDir)
  };
}

export function discardUnreadableCredentialsSetting(rootDir = process.cwd()): boolean {
  const envFile = readEnvFile(path.join(rootDir, ".env"));
  return booleanSetting(process.env.SRTL_DISCARD_UNREADABLE_CREDENTIALS ?? envFile.SRTL_DISCARD_UNREADABLE_CREDENTIALS, false);
}

export function loadConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const rootDir = overrides.rootDir ?? process.cwd();
  const envFile = readEnvFile(path.join(rootDir, ".env"));
  const environment = mergeEnvSettings(envFile, readProcessEnvSettings());
  const dataDir = dataDirSetting(rootDir, envFile, overrides.dataDir);
  const databaseUrl = overrides.databaseUrl ? databaseUrlSetting(overrides.databaseUrl) : resolveDatabaseUrl(envFile);
  const publicWebPortValue = process.env.SRTL_WEB_PORT ?? envFile.SRTL_WEB_PORT;
  const publicWebPort = publicWebPortValue ? portSetting(publicWebPortValue, 5179) : null;
  if (!path.isAbsolute(dataDir)) throw new Error(`SRTL_DATA_DIR must be an absolute path: ${dataDir}`);
  const publicOrigin = overrides.publicOrigin !== undefined ? overrides.publicOrigin : publicOriginSetting(process.env.SRTL_PUBLIC_ORIGIN ?? envFile.SRTL_PUBLIC_ORIGIN);
  const httpsPublicOrigin = publicOrigin?.startsWith("https:") ?? false;
  const cookieSecureValue = process.env.SRTL_COOKIE_SECURE ?? envFile.SRTL_COOKIE_SECURE;
  const sessionCookieSecure = overrides.sessionCookieSecure ?? booleanSetting(cookieSecureValue, httpsPublicOrigin);
  if (overrides.sessionCookieSecure === undefined && httpsPublicOrigin && !sessionCookieSecure) {
    throw new Error("SRTL_COOKIE_SECURE=false conflicts with an https SRTL_PUBLIC_ORIGIN. Remove SRTL_COOKIE_SECURE or set it to true.");
  }
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });

  return {
    rootDir,
    dataDir,
    databaseUrl,
    host: overrides.host ?? process.env.SRTL_HOST ?? envFile.SRTL_HOST ?? "127.0.0.1",
    port: portSetting(overrides.port ?? process.env.SRTL_PORT ?? envFile.SRTL_PORT, 3010),
    sessionCookieName: overrides.sessionCookieName ?? (publicWebPort ? `srtl_session_${publicWebPort}` : "srtl_session"),
    sessionCookieSecure,
    sessionIdleTimeoutHours: boundedIntegerSetting(
      overrides.sessionIdleTimeoutHours ?? process.env.SRTL_SESSION_IDLE_HOURS ?? envFile.SRTL_SESSION_IDLE_HOURS,
      12,
      "SRTL_SESSION_IDLE_HOURS",
      1,
      24 * 30
    ),
    sessionMaxAgeDays: boundedIntegerSetting(
      overrides.sessionMaxAgeDays ?? process.env.SRTL_SESSION_MAX_AGE_DAYS ?? envFile.SRTL_SESSION_MAX_AGE_DAYS,
      14,
      "SRTL_SESSION_MAX_AGE_DAYS",
      1,
      365
    ),
    setupToken: overrides.setupToken !== undefined ? setupTokenSetting(overrides.setupToken) : setupTokenSetting(process.env.SRTL_SETUP_TOKEN ?? envFile.SRTL_SETUP_TOKEN),
    allowedOrigins: overrides.allowedOrigins ?? originSettings(process.env.SRTL_ALLOWED_ORIGINS ?? envFile.SRTL_ALLOWED_ORIGINS),
    publicOrigin,
    apiDocsEnabled: overrides.apiDocsEnabled ?? booleanSetting(process.env.SRTL_API_DOCS ?? envFile.SRTL_API_DOCS, false),
    autoMigrate:
      overrides.autoMigrate ?? booleanSetting(process.env.SRTL_AUTO_MIGRATE ?? envFile.SRTL_AUTO_MIGRATE, process.env.NODE_ENV !== "production"),
    trustProxy: overrides.trustProxy ?? trustProxySetting(process.env.SRTL_TRUST_PROXY ?? envFile.SRTL_TRUST_PROXY),
    anonymousRequestsPerMinute: overrides.anonymousRequestsPerMinute ?? defaultAnonymousRequestsPerMinute,
    webRoot: overrides.webRoot ?? process.env.SRTL_WEB_ROOT ?? envFile.SRTL_WEB_ROOT ?? path.join(rootDir, "dist", "client"),
    jobHistoryRetentionDays: integerSetting(
      overrides.jobHistoryRetentionDays ?? process.env.SRTL_JOB_HISTORY_RETENTION_DAYS ?? envFile.SRTL_JOB_HISTORY_RETENTION_DAYS,
      90,
      "SRTL_JOB_HISTORY_RETENTION_DAYS",
      0
    ),
    jobConcurrency: loadJobConcurrency(envFile, overrides.jobConcurrency),
    outboundPolicy: overrides.outboundPolicy ?? parseOutboundPolicy(process.env.SRTL_OUTBOUND_ALLOW_CIDRS ?? envFile.SRTL_OUTBOUND_ALLOW_CIDRS),
    discardUnreadableCredentials: overrides.discardUnreadableCredentials ?? discardUnreadableCredentialsSetting(rootDir),
    nowPlayingStreams: { ...defaultNowPlayingStreamLimits, ...overrides.nowPlayingStreams },
    paths: overrides.paths ?? {
      symlinkDir: environment.SYMLINK_DIR ?? "",
      // The two-location engine currently maps numbered deployment slots to
      // the Local and Remote interface roles.
      localDir: environment.SRTL_LOCATION_1_PATH ?? "",
      remoteDir: environment.SRTL_LOCATION_2_PATH ?? ""
    }
  };
}
