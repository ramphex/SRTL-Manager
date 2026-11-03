import path from "node:path";
import type { FastifyRequest, RouteOptions } from "fastify";
import { radarrInstanceWebhookPath, radarrWebhookPath } from "./routes/radarrRoutes";
import { sonarrWebhookPath } from "./routes/sonarrRoutes";

/**
 * Who may call a route. Every route requires a signed-in admin unless the
 * access policy below names it explicitly.
 *
 * - `admin`: a valid session cookie.
 * - `public`: anyone. Counted against the anonymous rate limit.
 * - `internal`: a direct loopback request with no forwarding headers, or a valid session.
 * - `webhook`: the per-instance webhook secret header.
 */
export type RouteAuth = "admin" | "public" | "internal" | "webhook";

/**
 * Whether state-changing requests on a route wait for a pending path migration
 * (`423`) or for initial setup to finish (`423`).
 */
export type LibraryLock = "enforced" | "pathMigrationOnly" | "exempt";

export type WebhookKind = "radarr" | "sonarr";

declare module "fastify" {
  interface FastifyContextConfig {
    auth?: RouteAuth;
    libraryLock?: LibraryLock;
    webhook?: WebhookKind;
  }
}

/** Global request body ceiling. Larger limits are set per authenticated route. */
export const defaultBodyLimitBytes = 256 * 1024;
/** Body ceiling for the public sign-in routes. */
export const publicBodyLimitBytes = 16 * 1024;

interface RoutePolicy {
  methods: readonly string[];
  url: string;
  auth?: Exclude<RouteAuth, "admin">;
  webhook?: WebhookKind;
  libraryLock?: Exclude<LibraryLock, "enforced">;
  bodyLimit?: number;
}

/**
 * The single list of routes that differ from the default (admin session,
 * library locks enforced, global body limit). Routes are matched by their
 * registered pattern, never by the raw request URL.
 */
const routePolicies: readonly RoutePolicy[] = [
  // Static files and the single-page app shell. The not-found handler decides
  // whether an unknown path gets the shell or a plain 404.
  { methods: ["GET"], url: "/*", auth: "public" },
  { methods: ["GET"], url: "/api/health/live", auth: "public" },
  { methods: ["GET"], url: "/api/health", auth: "internal" },
  { methods: ["GET"], url: "/api/health/ready", auth: "internal" },
  { methods: ["GET"], url: "/api/auth/me", auth: "public" },
  { methods: ["POST"], url: "/api/auth/setup", auth: "public", bodyLimit: publicBodyLimitBytes },
  { methods: ["POST"], url: "/api/auth/login", auth: "public", bodyLimit: publicBodyLimitBytes },
  { methods: ["POST"], url: "/api/auth/logout", auth: "public", bodyLimit: publicBodyLimitBytes },
  { methods: ["PUT"], url: "/api/auth/user", libraryLock: "exempt", bodyLimit: publicBodyLimitBytes },
  { methods: ["POST"], url: radarrWebhookPath, auth: "webhook", webhook: "radarr" },
  { methods: ["POST"], url: radarrInstanceWebhookPath, auth: "webhook", webhook: "radarr" },
  { methods: ["POST"], url: sonarrWebhookPath, auth: "webhook", webhook: "sonarr" },
  { methods: ["POST"], url: "/api/onboarding/start", libraryLock: "pathMigrationOnly" },
  { methods: ["POST"], url: "/api/system/path-migration/plan", libraryLock: "exempt" },
  { methods: ["POST"], url: "/api/system/path-migration/apply", libraryLock: "exempt" },
  { methods: ["POST"], url: "/api/jobs/:id/terminate", libraryLock: "exempt" },
  { methods: ["POST"], url: "/api/jobs/:id/cancel", libraryLock: "exempt" },
  // Up to 1,000 titles of up to 500 characters each.
  { methods: ["POST"], url: "/api/storage-policies/bulk", bodyLimit: 1024 * 1024 }
];

function routeMethods(route: Pick<RouteOptions, "method">): string[] {
  return (Array.isArray(route.method) ? route.method : [route.method]).map((method) => String(method).toUpperCase());
}

function policyCovers(policy: RoutePolicy, method: string): boolean {
  // Fastify adds a HEAD twin for every GET route.
  return policy.methods.includes(method) || (method === "HEAD" && policy.methods.includes("GET"));
}

function policyFor(route: Pick<RouteOptions, "method" | "url">): RoutePolicy | undefined {
  const methods = routeMethods(route);
  const matches = routePolicies.filter((policy) => policy.url === route.url && methods.some((method) => policyCovers(policy, method)));
  if (matches.length === 0) return undefined;
  const [policy] = matches;
  if (matches.length > 1 || !methods.every((method) => policyCovers(policy, method))) {
    throw new Error(`Route ${methods.join(",")} ${route.url} matches the access policy for only some of its methods`);
  }
  return policy;
}

/** Stamps the access policy onto a route's config. Registered as an `onRoute` hook before any route. */
export function applyRouteAccessPolicy(route: RouteOptions): void {
  const policy = policyFor(route);
  const auth: RouteAuth = policy?.auth ?? "admin";
  const declared = route.config?.auth;
  if (declared !== undefined && declared !== auth) {
    throw new Error(`Route ${routeMethods(route).join(",")} ${route.url} declares auth "${declared}" outside the route access policy`);
  }
  route.config = {
    ...route.config,
    auth,
    libraryLock: policy?.libraryLock ?? "enforced",
    ...(policy?.webhook ? { webhook: policy.webhook } : {})
  };
  if (policy?.bodyLimit !== undefined && route.bodyLimit === undefined) route.bodyLimit = policy.bodyLimit;
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
