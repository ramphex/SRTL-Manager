import path from "node:path";
import type { FastifyRequest, RouteOptions } from "fastify";
import { radarrInstanceWebhookPath, radarrWebhookPath } from "./routes/radarrRoutes";
import { sonarrWebhookPath } from "./routes/sonarrRoutes";
import { roleHasPermission, type Permission } from "../shared/permissions";
import { AppError } from "./errors";

/**
 * How a route authenticates.
 *
 * - `session`: a signed-in account whose role has the route's `permission`.
 * - `public`: anyone. Counted against the anonymous rate limit.
 * - `internal`: a direct loopback request with no forwarding headers, or a session with the route's `permission`.
 * - `webhook`: the per-instance webhook secret header. Machines have no role.
 */
export type RouteAuth = "session" | "public" | "internal" | "webhook";

/**
 * Whether state-changing requests on a route wait for a pending path migration
 * (`423`) or for initial setup to finish (`423`).
 */
export type LibraryLock = "enforced" | "pathMigrationOnly" | "exempt";

export type WebhookKind = "radarr" | "sonarr";

declare module "fastify" {
  interface FastifyContextConfig {
    auth?: RouteAuth;
    /** Missing only on a route with no table entry, which refuses every session. */
    permission?: Permission;
    /** Stays available while the account must replace a temporary password. */
    duringPasswordChange?: boolean;
    /** Holds nothing about this instance, so its response keeps its links and paths in the restricted view. */
    publicData?: boolean;
    libraryLock?: LibraryLock;
    webhook?: WebhookKind;
  }
}

/** Global request body ceiling. Larger limits are set per authenticated route. */
export const defaultBodyLimitBytes = 256 * 1024;
/** Body ceiling for the public sign-in routes. */
export const publicBodyLimitBytes = 16 * 1024;

export type RouteEntry = {
  methods: readonly string[];
  url: string;
  webhook?: WebhookKind;
  duringPasswordChange?: boolean;
  publicData?: boolean;
  libraryLock?: Exclude<LibraryLock, "enforced">;
  bodyLimit?: number;
} & ({ auth: "public" | "webhook"; permission?: undefined } | { auth?: "internal"; permission: Permission });

const accountRoute = { libraryLock: "exempt", bodyLimit: publicBodyLimitBytes } as const;

/**
 * Every route the server answers, and what it takes to call it. This is the
 * single place access is decided, matched by registered pattern and never by the
 * raw request URL. A route missing from it refuses every session, and a test
 * walks the registered routes so a new one cannot ship without an entry.
 */
const routeTable: readonly RouteEntry[] = [
  // Static files and the single-page app shell. The not-found handler decides
  // whether an unknown path gets the shell or a plain 404.
  { methods: ["GET"], url: "/*", auth: "public" },
  { methods: ["GET"], url: "/api/health/live", auth: "public" },
  { methods: ["GET"], url: "/api/health", auth: "internal", permission: "library.view" },
  { methods: ["GET"], url: "/api/health/ready", auth: "internal", permission: "library.view" },

  // API documentation, when turned on.
  { methods: ["GET"], url: "/documentation", permission: "settings.manage" },
  { methods: ["HEAD"], url: "/documentation/", permission: "settings.manage" },
  { methods: ["GET"], url: "/documentation/json", permission: "settings.manage" },
  { methods: ["GET"], url: "/documentation/yaml", permission: "settings.manage" },
  { methods: ["GET"], url: "/documentation/static/*", permission: "settings.manage" },
  { methods: ["GET"], url: "/documentation/static/index.html", permission: "settings.manage" },
  { methods: ["GET"], url: "/documentation/static/swagger-initializer.js", permission: "settings.manage" },

  // Signing in and your own account.
  { methods: ["GET"], url: "/api/auth/me", auth: "public" },
  { methods: ["POST"], url: "/api/auth/setup", auth: "public", bodyLimit: publicBodyLimitBytes },
  { methods: ["POST"], url: "/api/auth/login", auth: "public", bodyLimit: publicBodyLimitBytes },
  { methods: ["POST"], url: "/api/auth/logout", auth: "public", bodyLimit: publicBodyLimitBytes },
  { methods: ["PUT"], url: "/api/auth/user", permission: "account.self", duringPasswordChange: true, ...accountRoute },
  { methods: ["GET"], url: "/api/auth/sessions", permission: "account.self" },
  { methods: ["DELETE"], url: "/api/auth/sessions/:id", permission: "account.self", libraryLock: "exempt" },
  { methods: ["POST"], url: "/api/auth/sessions/revoke-others", permission: "account.self", ...accountRoute },
  { methods: ["GET", "PUT"], url: "/api/settings/user-preferences", permission: "account.self" },

  // Other people's accounts. Which accounts a person may touch is checked against the target in `accounts.ts`.
  { methods: ["GET"], url: "/api/accounts", permission: "moderators.manage" },
  { methods: ["POST"], url: "/api/accounts", permission: "moderators.manage", ...accountRoute },
  { methods: ["PUT"], url: "/api/accounts/:id/role", permission: "moderators.manage", ...accountRoute },
  { methods: ["POST"], url: "/api/accounts/:id/disable", permission: "moderators.manage", ...accountRoute },
  { methods: ["POST"], url: "/api/accounts/:id/enable", permission: "moderators.manage", ...accountRoute },
  { methods: ["POST"], url: "/api/accounts/:id/reset-password", permission: "moderators.manage", ...accountRoute },
  { methods: ["DELETE"], url: "/api/accounts/:id", permission: "moderators.manage", libraryLock: "exempt" },
  { methods: ["POST"], url: "/api/accounts/transfer-ownership", permission: "ownership.transfer", ...accountRoute },

  // Logs of who did what.
  { methods: ["GET"], url: "/api/auth/security-events", permission: "activity.view" },
  { methods: ["GET"], url: "/api/system/action-audit", permission: "activity.view" },

  // Machines.
  { methods: ["POST"], url: radarrWebhookPath, auth: "webhook", webhook: "radarr" },
  { methods: ["POST"], url: radarrInstanceWebhookPath, auth: "webhook", webhook: "radarr" },
  { methods: ["POST"], url: sonarrWebhookPath, auth: "webhook", webhook: "sonarr" },

  // State the app needs before showing anything. Both answers are narrowed for restricted accounts by their routes.
  { methods: ["GET"], url: "/api/onboarding", permission: "library.view" },
  { methods: ["POST"], url: "/api/onboarding/start", permission: "settings.manage", libraryLock: "pathMigrationOnly" },
  { methods: ["GET"], url: "/api/system/path-migration", permission: "library.view" },
  { methods: ["POST"], url: "/api/system/path-migration/plan", permission: "settings.manage", libraryLock: "exempt" },
  { methods: ["POST"], url: "/api/system/path-migration/apply", permission: "settings.manage", libraryLock: "exempt" },
  { methods: ["GET"], url: "/api/system/version", permission: "library.view", publicData: true },

  // Library, read.
  { methods: ["GET"], url: "/api/sections", permission: "library.view" },
  { methods: ["GET"], url: "/api/media-links", permission: "library.view" },
  { methods: ["POST"], url: "/api/media-links/by-ids", permission: "library.view" },
  { methods: ["GET"], url: "/api/media-links/page", permission: "library.view" },
  { methods: ["GET"], url: "/api/media-links/tree", permission: "library.view" },
  { methods: ["GET"], url: "/api/storage-files", permission: "library.view" },
  { methods: ["GET"], url: "/api/storage-files/tree", permission: "library.view" },
  { methods: ["GET"], url: "/api/inventory/summary", permission: "library.view" },
  { methods: ["GET"], url: "/api/inventory/scan-timestamps", permission: "library.view" },
  { methods: ["GET"], url: "/api/damaged-files", permission: "library.view" },
  { methods: ["GET"], url: "/api/damaged-files.csv", permission: "library.view" },
  { methods: ["GET"], url: "/api/storage-policies", permission: "library.view" },
  { methods: ["GET"], url: "/api/storage-policies/candidates", permission: "library.view" },
  { methods: ["GET"], url: "/api/storage-policies/default-preview", permission: "library.view" },
  // The parts of settings the library screens read. None holds a path, an address or a credential.
  { methods: ["GET"], url: "/api/settings/storage-locations", permission: "library.view" },
  { methods: ["GET"], url: "/api/settings/sections", permission: "library.view" },
  { methods: ["GET"], url: "/api/settings/scan", permission: "library.view" },
  { methods: ["GET"], url: "/api/settings/audit", permission: "library.view" },
  { methods: ["GET"], url: "/api/settings/advanced", permission: "library.view" },
  { methods: ["GET"], url: "/api/settings/radarr/copy-defaults", permission: "library.view" },
  { methods: ["GET"], url: "/api/settings/sonarr/copy-defaults", permission: "library.view" },

  // Scans, audits and jobs.
  { methods: ["POST"], url: "/api/scans", permission: "jobs.run" },
  { methods: ["GET"], url: "/api/scans", permission: "library.view" },
  { methods: ["GET"], url: "/api/scans/:id", permission: "library.view" },
  { methods: ["POST"], url: "/api/audits", permission: "jobs.run" },
  { methods: ["GET"], url: "/api/audits", permission: "library.view" },
  { methods: ["GET"], url: "/api/audits/job/:jobId", permission: "library.view" },
  { methods: ["GET"], url: "/api/audits/:id", permission: "library.view" },
  { methods: ["GET"], url: "/api/audits/:id/results/page", permission: "library.view" },
  { methods: ["GET"], url: "/api/jobs", permission: "library.view" },
  { methods: ["GET"], url: "/api/jobs/:id", permission: "library.view" },
  { methods: ["GET"], url: "/api/jobs/:id/events", permission: "library.view" },
  { methods: ["GET"], url: "/api/jobs/:id/events/page", permission: "library.view" },
  { methods: ["GET"], url: "/api/jobs/:id/copy-failures", permission: "library.view" },
  { methods: ["POST"], url: "/api/jobs/:id/terminate", permission: "jobs.run", libraryLock: "exempt" },
  { methods: ["POST"], url: "/api/jobs/:id/cancel", permission: "jobs.run", libraryLock: "exempt" },
  { methods: ["GET"], url: "/api/job-reconciliation", permission: "library.view" },
  { methods: ["POST"], url: "/api/job-reconciliation/recheck", permission: "jobs.run" },

  // Copies. The direction and conflict handling are checked against the role by the route.
  { methods: ["POST"], url: "/api/copies", permission: "copies.to_local" },
  { methods: ["POST"], url: "/api/copies/conflicts", permission: "copies.to_local" },

  // Removing things.
  { methods: ["POST"], url: "/api/jobs/:id/copy-failures/remove-symlinks", permission: "library.delete" },
  { methods: ["GET", "POST"], url: "/api/job-reconciliation/:id/discard-partial-copy", permission: "library.delete" },
  { methods: ["GET"], url: "/api/orphans", permission: "library.delete" },
  { methods: ["POST"], url: "/api/orphans/purge", permission: "library.delete" },
  { methods: ["GET"], url: "/api/orphans/held", permission: "library.delete" },
  { methods: ["POST"], url: "/api/orphans/held/restore", permission: "library.delete" },

  // Storage policies. They steer Radarr and Sonarr tags as well as where titles belong.
  { methods: ["POST"], url: "/api/storage-policies", permission: "library.manage" },
  // Up to 1,000 titles of up to 500 characters each.
  { methods: ["POST"], url: "/api/storage-policies/bulk", permission: "library.manage", bodyLimit: 1024 * 1024 },
  { methods: ["POST"], url: "/api/storage-policies/default-apply", permission: "library.manage" },
  { methods: ["DELETE"], url: "/api/storage-policies/:id", permission: "library.manage" },

  // Now Playing. The stream and artwork go through the restricted view like everything else.
  { methods: ["GET"], url: "/api/now-playing/events", permission: "library.view" },
  { methods: ["GET"], url: "/api/now-playing/poster/:key", permission: "library.view" },
  { methods: ["GET"], url: "/api/now-playing/settings", permission: "library.view" },
  { methods: ["PUT"], url: "/api/now-playing/settings", permission: "settings.manage" },
  { methods: ["POST"], url: "/api/now-playing/stop", permission: "streams.stop" },

  // Settings, connections, paths and backups.
  { methods: ["GET"], url: "/api/settings/paths", permission: "settings.manage" },
  { methods: ["PUT"], url: "/api/settings/storage-locations", permission: "settings.manage" },
  { methods: ["PUT"], url: "/api/settings/sections", permission: "settings.manage" },
  { methods: ["PUT"], url: "/api/settings/scan", permission: "settings.manage" },
  { methods: ["PUT"], url: "/api/settings/audit", permission: "settings.manage" },
  { methods: ["PUT"], url: "/api/settings/advanced", permission: "settings.manage" },
  { methods: ["GET"], url: "/api/backups", permission: "settings.manage" },
  { methods: ["PUT"], url: "/api/backups/settings", permission: "settings.manage" },
  { methods: ["POST"], url: "/api/backups/run", permission: "settings.manage" },
  { methods: ["GET", "POST"], url: "/api/media-servers", permission: "settings.manage" },
  { methods: ["PUT", "DELETE"], url: "/api/media-servers/:serverId", permission: "settings.manage" },
  { methods: ["POST"], url: "/api/media-servers/:serverId/test", permission: "settings.manage" },
  { methods: ["POST"], url: "/api/media-servers/:serverId/plex-pin", permission: "settings.manage" },
  { methods: ["POST"], url: "/api/media-servers/:serverId/plex-pin/:pinId", permission: "settings.manage" },
  ...arrSettingsRoutes("radarr"),
  ...arrSettingsRoutes("sonarr"),
  { methods: ["GET", "PUT"], url: "/api/settings/watch-sync", permission: "settings.manage" },
  { methods: ["POST"], url: "/api/settings/watch-sync/pause", permission: "settings.manage" },
  { methods: ["POST"], url: "/api/settings/watch-sync/reconcile", permission: "settings.manage" },
  { methods: ["GET"], url: "/api/settings/watch-sync/activity", permission: "settings.manage" },
  { methods: ["POST"], url: "/api/settings/watch-sync/servers/:serverId/discover", permission: "settings.manage" },
  { methods: ["POST"], url: "/api/settings/watch-sync/pairs", permission: "settings.manage" },
  { methods: ["PUT", "DELETE"], url: "/api/settings/watch-sync/pairs/:pairId", permission: "settings.manage" },
  { methods: ["POST"], url: "/api/settings/watch-sync/pairs/:pairId/preview", permission: "settings.manage" },
  { methods: ["POST"], url: "/api/settings/watch-sync/pairs/:pairId/approve", permission: "settings.manage" },
  { methods: ["POST"], url: "/api/settings/watch-sync/pairs/:pairId/sync", permission: "settings.manage" },
  { methods: ["GET"], url: "/api/settings/watch-sync/pairs/:pairId/backup", permission: "settings.manage" },
  { methods: ["POST"], url: "/api/settings/watch-sync/pairs/:pairId/restore", permission: "settings.manage" }
];

/** Every table entry, so a test can check that none has outlived its route. */
export const routeTableEntries: readonly RouteEntry[] = routeTable;

function arrSettingsRoutes(service: "radarr" | "sonarr"): RouteEntry[] {
  const base = `/api/settings/${service}`;
  return [
    { methods: ["GET"], url: base, permission: "settings.manage" },
    { methods: ["POST"], url: `${base}/instances`, permission: "settings.manage" },
    { methods: ["GET", "PUT", "DELETE"], url: `${base}/instances/:instanceId`, permission: "settings.manage" },
    { methods: ["POST"], url: `${base}/instances/:instanceId/rename`, permission: "settings.manage" },
    { methods: ["POST"], url: `${base}/instances/:instanceId/test`, permission: "settings.manage" },
    { methods: ["POST"], url: `${base}/instances/:instanceId/refresh`, permission: "settings.manage" },
    { methods: ["POST"], url: `${base}/instances/:instanceId/reconcile`, permission: "settings.manage" }
  ];
}

function routeMethods(route: Pick<RouteOptions, "method">): string[] {
  return (Array.isArray(route.method) ? route.method : [route.method]).map((method) => String(method).toUpperCase());
}

function entryCovers(entry: RouteEntry, method: string): boolean {
  // Fastify adds a HEAD twin for every GET route.
  return entry.methods.includes(method) || (method === "HEAD" && entry.methods.includes("GET"));
}

/** The table entry for a route, or undefined when it has none. */
export function routeTableEntry(route: Pick<RouteOptions, "method" | "url">, extraEntries: readonly RouteEntry[] = []): RouteEntry | undefined {
  const methods = routeMethods(route);
  const matches = [...routeTable, ...extraEntries].filter((entry) => entry.url === route.url && methods.some((method) => entryCovers(entry, method)));
  if (matches.length === 0) return undefined;
  const [entry] = matches;
  if (matches.length > 1 || !methods.every((method) => entryCovers(entry, method))) {
    throw new Error(`Route ${methods.join(",")} ${route.url} matches the access table for only some of its methods`);
  }
  return entry;
}

/** Stamps the route's table entry onto its config. Registered as an `onRoute` hook before any route. */
export function applyRouteAccessPolicy(route: RouteOptions, extraEntries: readonly RouteEntry[] = []): void {
  const entry = routeTableEntry(route, extraEntries);
  const auth: RouteAuth = entry?.auth ?? "session";
  const declared = route.config?.auth;
  if (declared !== undefined && declared !== auth) {
    throw new Error(`Route ${routeMethods(route).join(",")} ${route.url} declares auth "${declared}" outside the route access table`);
  }
  route.config = {
    ...route.config,
    auth,
    libraryLock: entry?.libraryLock ?? "enforced",
    ...(entry?.permission ? { permission: entry.permission } : {}),
    ...(entry?.duringPasswordChange ? { duringPasswordChange: true } : {}),
    ...(entry?.publicData ? { publicData: true } : {}),
    ...(entry?.webhook ? { webhook: entry.webhook } : {})
  };
  if (entry?.bodyLimit !== undefined && route.bodyLimit === undefined) route.bodyLimit = entry.bodyLimit;
}

/** For the few rules a route's method and pattern cannot express, such as a copy's direction. */
export function requirePermission(request: FastifyRequest, permission: Permission, message = "You do not have permission to do that."): void {
  const session = request.adminSession;
  if (!session || !roleHasPermission(session.role, permission)) throw new AppError(message, 403, { code: "forbidden" });
}

export function requestHasPermission(request: FastifyRequest, permission: Permission): boolean {
  const session = request.adminSession;
  return session !== null && roleHasPermission(session.role, permission);
}

const loopbackAddresses = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/** True only for a request made on this host without passing through a proxy. */
export function isDirectLoopbackRequest(request: FastifyRequest): boolean {
  const address = request.socket?.remoteAddress ?? "";
  if (!loopbackAddresses.has(address) && !address.startsWith("127.")) return false;
  return request.headers["x-forwarded-for"] === undefined && request.headers.forwarded === undefined && request.headers["x-real-ip"] === undefined;
}

const reservedPrefixes = ["/api", "/documentation", "/assets"];

/**
 * Normalises a raw request path the way a lenient proxy or file server might:
 * repeated percent-decoding, case folding, path parameters, duplicate slashes
 * and dot segments. Used only to keep unknown API-like paths from receiving
 * the app shell; it never grants access.
 */
export function normalizedRequestPath(rawUrl: string): string | null {
  let pathname = rawUrl.split(/[?#]/, 1)[0] ?? "";
  for (let round = 0; round < 4; round += 1) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      return null;
    }
    if (decoded === pathname) break;
    pathname = decoded;
  }
  const segments = pathname
    .replace(/\\/g, "/")
    .toLowerCase()
    .split("/")
    .map((segment) => segment.split(";", 1)[0]?.trim() ?? "");
  return path.posix.normalize(`/${segments.join("/")}`);
}

/** Unknown paths under the API, docs or asset prefixes get a plain 404, never the app shell. */
export function isReservedPath(rawUrl: string): boolean {
  const normalized = normalizedRequestPath(rawUrl);
  if (normalized === null) return true;
  return reservedPrefixes.some((prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`));
}
