import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import compress from "@fastify/compress";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import { ZodError } from "zod";
import { AppError, toClientError } from "./errors";
import packageJson from "../../package.json";
import type { AppConfig } from "./config";
import { loadConfig, secretKeyOptions } from "./config";
import { dummyPasswordHash, findActiveSession, hasOwner, type SessionPolicy } from "./auth";
import { LoginThrottle } from "./loginThrottle";
import { pruneSecurityEvents } from "./securityEvents";
import { createSessionAccess, sessionCookieSettings } from "./sessionAccess";
import { SetupTokenGate } from "./setupToken";
import { openDatabase, type DatabaseContext } from "./db/database";
import * as schema from "./db/schema";
import { desc, eq } from "drizzle-orm";
import { isPathConfigurationBlocked, reconcileEnvironmentPaths } from "./lib/pathConfiguration";
import { canAdoptEnvironmentPathsBeforeInitialScan, isOnboardingComplete, reconcileOnboardingState } from "./lib/onboarding";
import { JobRunner } from "./jobs/jobRunner";
import { registerAccountRoutes } from "./routes/accountRoutes";
import { registerAuthRoutes } from "./routes/authRoutes";
import { registerSettingsRoutes } from "./routes/settingsRoutes";
import { registerLibraryRoutes } from "./routes/libraryRoutes";
import { registerAuditRoutes } from "./routes/auditRoutes";
import { registerJobRoutes } from "./routes/jobRoutes";
import { registerActionAuditRoutes } from "./routes/actionAuditRoutes";
import { registerSystemRoutes } from "./routes/systemRoutes";
import { registerPathConfigurationRoutes } from "./routes/pathConfigurationRoutes";
import { registerOnboardingRoutes } from "./routes/onboardingRoutes";
import { registerRadarrRoutes, webhookInstanceId } from "./routes/radarrRoutes";
import { registerDamagedRoutes } from "./routes/damagedRoutes";
import { registerOrphanRoutes } from "./routes/orphanRoutes";
import { registerReRequestRoutes } from "./routes/reRequestRoutes";
import { registerMediaServerRoutes } from "./routes/mediaServerRoutes";
import { registerWatchSyncRoutes } from "./routes/watchSyncRoutes";
import { registerNowPlayingRoutes } from "./routes/nowPlayingRoutes";
import { registerBackupRoutes } from "./routes/backupRoutes";
import { getBackupState } from "./lib/backups";
import { authenticateRadarrWebhook } from "./lib/radarr";
import { authenticateSonarrWebhook } from "./lib/sonarr";
import { registerSonarrRoutes, sonarrWebhookInstanceId } from "./routes/sonarrRoutes";
import { configureOutboundPolicy } from "./lib/outboundPolicy";
import { isRestrictedRequest, loadSensitiveRoots, scrubIpAddresses, scrubText, scrubValue, type RestrictedViewRuntime } from "./lib/restrictedView";
import { loadAndInstallSecretKey } from "./lib/secretBox";
import { applyRouteAccessPolicy, defaultBodyLimitBytes, isDirectLoopbackRequest, isReservedPath, type RouteEntry, type WebhookKind } from "./routeAccess";
import { roleHasPermission } from "../shared/permissions";

export interface AppContext {
  app: FastifyInstance;
  config: AppConfig;
  database: DatabaseContext;
  jobs: JobRunner;
  /** Every route as registered, for audits of the access policy. */
  routes: ReadonlyArray<{ method: string; url: string }>;
}

function formatValidationError(error: ZodError): string {
  return error.issues[0]?.message ?? "Validation failed";
}

const permissionsPolicy = "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()";

function mutationOriginAllowed(requestProtocol: string, requestHost: string | undefined, origin: string, allowedOrigins: string[]): boolean {
  const normalizedOrigin = origin.replace(/\/$/, "");
  if (allowedOrigins.length > 0) return allowedOrigins.includes(normalizedOrigin);
  if (!requestHost) return false;
  try {
    return new URL(normalizedOrigin).origin === new URL(`${requestProtocol}://${requestHost}`).origin;
  } catch {
    return false;
  }
}

export interface CreateAppOptions {
  /** Where request and error logs are written. Defaults to standard output; tests pass a stream to read them. */
  logStream?: NodeJS.WritableStream;
  /** Access entries for routes a test adds to the app. The server itself never passes any. */
  extraRouteEntries?: readonly RouteEntry[];
}

export async function createApp(overrides: Partial<AppConfig> = {}, options: CreateAppOptions = {}): Promise<AppContext> {
  const config = loadConfig(overrides);
  const secretKey = loadAndInstallSecretKey(secretKeyOptions(config.rootDir, config.dataDir));
  configureOutboundPolicy(config.outboundPolicy);
  const database = await openDatabase({ databaseUrl: config.databaseUrl, migrate: config.autoMigrate, discardUnreadableCredentials: config.discardUnreadableCredentials });
  await reconcileOnboardingState(database.db);
  await reconcileEnvironmentPaths(database.db, config.paths, {
    allowDirectAdoptionBeforeInventory: await canAdoptEnvironmentPathsBeforeInitialScan(database.db)
  });
  const jobs = new JobRunner(database.db);

  // Each request gets a short random ID. It is logged with every line for the request and sent back to the
  // client, so a user can quote it and the matching server log entry can be found.
  const app = fastify({ logger: options.logStream ? { stream: options.logStream } : true, trustProxy: config.trustProxy, bodyLimit: defaultBodyLimitBytes, genReqId: () => randomBytes(5).toString("hex") });
  if (secretKey.source === "generated") {
    app.log.warn(`Created the secret key for stored credentials at ${secretKey.path}. Back it up separately from database backups: without it, saved tokens and API keys cannot be read.`);
  }
  app.decorateRequest("adminSession", null);
  app.decorateRequest("adminUser", null);
  const sessionPolicy: SessionPolicy = {
    idleTimeoutMs: config.sessionIdleTimeoutHours * 60 * 60 * 1_000,
    maxAgeMs: config.sessionMaxAgeDays * 24 * 60 * 60 * 1_000
  };
  const trustedOrigins = config.publicOrigin && !config.allowedOrigins.includes(config.publicOrigin) ? [...config.allowedOrigins, config.publicOrigin] : config.allowedOrigins;
  const sessions = createSessionAccess(database.db, sessionCookieSettings(config.sessionCookieName, config.sessionCookieSecure, trustedOrigins), sessionPolicy);
  const setupTokens = new SetupTokenGate({
    dataDir: config.dataDir,
    configuredToken: config.setupToken,
    log: { warn: (message) => app.log.warn(message), info: (message) => app.log.info(message) }
  });
  // Computed once up front so the first sign-in with an unknown username takes no longer than later ones.
  void dummyPasswordHash().catch((error: unknown) => app.log.error({ err: error }, "Could not prepare the password check"));
  // Every route gets its access policy stamped on before anything can register one.
  const routes: Array<{ method: string; url: string }> = [];
  app.addHook("onRoute", (route) => {
    for (const method of [route.method].flat()) routes.push({ method: String(method), url: route.url });
    applyRouteAccessPolicy(route, options.extraRouteEntries);
  });
  // The only place an error becomes a response. Clients get a safe message, a code and the request ID;
  // the full error (stack, SQL, paths, upstream detail) goes to the server log only.
  app.setErrorHandler((error, request, reply) => {
    const requestId = String(request.id);
    if (error instanceof ZodError) {
      return reply.code(400).send({ error: formatValidationError(error), code: "validation_failed", requestId, issues: error.issues.map((issue) => ({ path: issue.path, message: issue.message })) });
    }
    if (error instanceof Error && (error as { statusCode?: unknown }).statusCode === 403 && request.routeOptions.url === "/*") {
      // The static file server refuses non-canonical paths; answer like any other unknown path.
      return reply.code(404).send({ error: "Not found" });
    }
    const clientError = toClientError(error);
    const detail = error instanceof AppError ? error.detail : undefined;
    if (clientError.expected) request.log.warn({ err: error, ...(detail ? { detail } : {}) }, "Request rejected");
    else request.log.error({ err: error }, "Request failed");
    return reply.code(clientError.statusCode).send({ error: clientError.message, code: clientError.code, requestId });
  });

  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:"],
        connectSrc: ["'self'"],
        frameAncestors: ["'none'"],
        upgradeInsecureRequests: null
      }
    },
    frameguard: { action: "deny" },
    strictTransportSecurity: { maxAge: 31_536_000, includeSubDomains: false }
  });
  app.addHook("onRequest", async (request, reply) => {
    reply.header("Permissions-Policy", permissionsPolicy);
    reply.header("X-Request-Id", request.id);
  });
  await app.register(rateLimit, { global: false });
  const anonymousRateLimit = app.createRateLimit({ max: config.anonymousRequestsPerMinute, timeWindow: 60_000 });
  await app.register(compress, {
    encodings: ["br", "gzip"],
    globalDecompression: false,
    threshold: 1024
  });
  if (config.allowedOrigins.length > 0) {
    await app.register(cors, { origin: config.allowedOrigins, credentials: true });
  }
  await app.register(cookie);

  app.addHook("onRequest", async (request, reply) => {
    if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return;
    if (request.headers["sec-fetch-site"] === "cross-site") {
      await reply.code(403).send({ error: "Cross-site requests are not allowed" });
      return;
    }
    const origin = request.headers.origin;
    if (origin && !mutationOriginAllowed(request.protocol, request.headers.host, origin, trustedOrigins)) {
      await reply.code(403).send({ error: "Request origin is not allowed" });
    }
  });

  const webhookAuthenticators: Record<WebhookKind, (request: FastifyRequest) => Promise<boolean>> = {
    radarr: async (request) => {
      const token = request.headers["x-srtl-webhook-secret"];
      const instanceId = (() => { try { return webhookInstanceId(request); } catch { return undefined; } })();
      return instanceId !== undefined && (await authenticateRadarrWebhook(database.db, instanceId, typeof token === "string" ? token : undefined));
    },
    sonarr: async (request) => {
      const token = request.headers["x-srtl-webhook-secret"];
      const instanceId = (() => { try { return sonarrWebhookInstanceId(request); } catch { return undefined; } })();
      return instanceId !== undefined && (await authenticateSonarrWebhook(database.db, instanceId, typeof token === "string" ? token : undefined));
    }
  };

  // Counts a request made without a session. Returns true once it has answered 429.
  const rejectOverAnonymousLimit = async (request: FastifyRequest, reply: FastifyReply): Promise<boolean> => {
    const limit = await anonymousRateLimit(request);
    if (limit.isAllowed || !limit.isExceeded) return false;
    reply.header("Retry-After", String(limit.ttlInSeconds));
    await reply.code(429).send({ error: "Too many requests" });
    return true;
  };

  // Default-deny guard. It runs before the body is read and decides only from
  // the matched route's config, which applyRouteAccessPolicy stamps on every route
  // from the route table. A route with no table entry has no permission and refuses
  // every session.
  app.addHook("onRequest", async (request, reply) => {
    if (reply.sent) return;
    if (request.is404) {
      await rejectOverAnonymousLimit(request, reply);
      return;
    }
    const routeConfig = request.routeOptions.config;
    const access = routeConfig.auth ?? "session";
    if (access === "public") {
      await rejectOverAnonymousLimit(request, reply);
      return;
    }
    if (access === "internal" && isDirectLoopbackRequest(request)) return;
    if (access === "webhook") {
      const authenticate = routeConfig.webhook ? webhookAuthenticators[routeConfig.webhook] : undefined;
      if (!authenticate || !(await authenticate(request))) {
        if (!(await rejectOverAnonymousLimit(request, reply))) await reply.code(401).send({ error: "Invalid webhook credentials" });
        return;
      }
    } else {
      const session = await sessions.resolve(request, reply);
      if (!session) {
        if (!(await rejectOverAnonymousLimit(request, reply))) await reply.code(401).send({ error: "Authentication required" });
        return;
      }
      request.adminUser = { userId: session.userId, username: session.username };
      if (session.mustChangePassword && !routeConfig.duringPasswordChange) {
        await reply.code(403).send({ error: "Change your temporary password to continue.", code: "password_change_required" });
        return;
      }
      if (!routeConfig.permission || !roleHasPermission(session.role, routeConfig.permission)) {
        if (!routeConfig.permission) request.log.error({ route: request.routeOptions.url }, "Route has no entry in the access table");
        await reply.code(403).send({ error: "You do not have permission to do that.", code: "forbidden" });
        return;
      }
    }
    if (request.method === "GET" || request.method === "HEAD" || request.method === "OPTIONS") return;
    const libraryLock = routeConfig.libraryLock ?? "enforced";
    if (libraryLock === "exempt") return;
    if (await isPathConfigurationBlocked(database.db)) {
      await reply.code(423).send({ error: "Managed storage paths changed. Complete the required path migration before modifying the library." });
      return;
    }
    if (libraryLock === "pathMigrationOnly") return;
    if (!(await isOnboardingComplete(database.db))) {
      await reply.code(423).send({ error: "Complete initial setup before modifying the library." });
    }
  });

  // A body can take a long time to arrive, and the account can change in the meantime. Decide again before the handler runs.
  app.addHook("preHandler", async (request, reply) => {
    const session = request.adminSession;
    const routeConfig = request.routeOptions.config;
    if (!session || routeConfig.auth !== "session" || request.method === "GET" || request.method === "HEAD") return;
    const current = await findActiveSession(database.db, session.tokenHash);
    if (!current) {
      await reply.code(401).send({ error: "Authentication required" });
      return;
    }
    request.adminSession = current;
    request.adminUser = { userId: current.userId, username: current.username };
    if (current.mustChangePassword && !routeConfig.duringPasswordChange) {
      await reply.code(403).send({ error: "Change your temporary password to continue.", code: "password_change_required" });
    } else if (!routeConfig.permission || !roleHasPermission(current.role, routeConfig.permission)) {
      await reply.code(403).send({ error: "You do not have permission to do that.", code: "forbidden" });
    }
  });

  // The last step of every response to an account without `settings.manage`, wherever the response came from.
  const restrictedViewRuntime: RestrictedViewRuntime = { paths: config.paths, backupDir: config.backupDir, dataDir: config.dataDir };
  const scrubbed = new WeakSet<FastifyRequest>();
  app.addHook("preSerialization", async (request, _reply, payload) => {
    if (!isRestrictedRequest(request)) return payload;
    scrubbed.add(request);
    if (request.routeOptions.config?.publicData) return scrubIpAddresses(payload);
    return scrubValue(payload, await loadSensitiveRoots(database.db, restrictedViewRuntime));
  });
  app.addHook("onSend", async (request, _reply, payload) => {
    if (typeof payload !== "string" || scrubbed.has(request) || !isRestrictedRequest(request)) return payload;
    if (request.routeOptions.config?.publicData) return scrubIpAddresses(payload) as string;
    return scrubText(payload, await loadSensitiveRoots(database.db, restrictedViewRuntime));
  });

  if (config.apiDocsEnabled) {
    await app.register(swagger, {
      openapi: {
        info: {
          title: "SRTL Manager API",
          version: packageJson.version
        }
      }
    });
    await app.register(swaggerUi, { routePrefix: "/documentation" });
  }

  const workerHealth = async () => {
    await database.pool.query("select 1");
    const workers = await database.db
      .select()
      .from(schema.workerHeartbeats)
      .where(eq(schema.workerHeartbeats.status, "running"))
      .orderBy(desc(schema.workerHeartbeats.heartbeatAt));
    const latestWorker = workers[0] ?? null;
    const now = Date.now();
    const readyWorkerCount = workers.reduce((capacity, worker) => {
      const heartbeatAt = Date.parse(worker.heartbeatAt);
      return Number.isFinite(heartbeatAt) && Math.max(0, now - heartbeatAt) <= 30_000 ? capacity + worker.capacity : capacity;
    }, 0);
    const staleWorkerCount = workers.reduce((capacity, worker) => {
      const heartbeatAt = Date.parse(worker.heartbeatAt);
      return !Number.isFinite(heartbeatAt) || Math.max(0, now - heartbeatAt) > 30_000 ? capacity + worker.capacity : capacity;
    }, 0);
    const expectedWorkerCount = config.jobConcurrency.maxRunningJobs;
    const ready = readyWorkerCount >= expectedWorkerCount;
    // Only the kind of problem: this answer goes to local health checks, which have no business seeing paths.
    const backupState = await getBackupState(database.db, { defaultLocation: config.backupDir, paths: config.paths }).catch(() => null);
    return {
      ok: ready,
      database: "ready",
      backups: backupState ? backupState.alert?.kind ?? (backupState.settings.enabled ? "ok" : "disabled") : "unknown",
      worker: ready ? "ready" : workers.length > 0 ? "stale" : "not_started",
      workerHeartbeatAt: latestWorker?.heartbeatAt ?? null,
      expectedWorkerCount,
      readyWorkerCount,
      staleWorkerCount
    };
  };
  app.get("/api/health/live", async () => ({ ok: true, service: "running" }));
  app.get("/api/health/ready", { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } }, async (_request, reply) => {
    const health = await workerHealth();
    return health.ok ? health : reply.code(503).send(health);
  });
  app.get("/api/health", { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } }, async () => ({ ...(await workerHealth()), ok: true }));
  const throttle = new LoginThrottle();
  registerAuthRoutes(app, database.db, {
    sessions,
    setupTokens,
    throttle,
    securityEventRetentionDays: config.jobHistoryRetentionDays
  });

  registerAccountRoutes(app, database.db, { throttle });
  registerOnboardingRoutes(app, database.db);
  registerSettingsRoutes(app, database.db);
  registerRadarrRoutes(app, database.db);
  registerSonarrRoutes(app, database.db);
  registerMediaServerRoutes(app, database.db);
  registerWatchSyncRoutes(app, database.db, jobs);
  registerNowPlayingRoutes(app, database.db, { limits: config.nowPlayingStreams, restrictedView: restrictedViewRuntime });
  registerLibraryRoutes(app, database.db, jobs);
  registerAuditRoutes(app, database.db, jobs);
  registerOrphanRoutes(app, database.db, jobs);
  registerDamagedRoutes(app, database.db, jobs);
  registerReRequestRoutes(app, database.db);
  registerJobRoutes(app, jobs, database.db);
  registerActionAuditRoutes(app, database.db);
  registerBackupRoutes(app, database.db, jobs, { defaultLocation: config.backupDir, paths: config.paths });
  registerSystemRoutes(app);
  registerPathConfigurationRoutes(app, database.db, jobs, config.paths);

  const indexPath = path.join(config.webRoot, "index.html");
  if (fs.existsSync(indexPath)) {
    await app.register(fastifyStatic, {
      root: config.webRoot,
      prefix: "/",
      cacheControl: false,
      maxAge: 0,
      immutable: false,
      setHeaders(reply, filePath) {
        const relativePath = path.relative(config.webRoot, filePath);
        const isHashedAsset = relativePath.startsWith(`assets${path.sep}`);
        reply.header("Cache-Control", isHashedAsset ? "public, max-age=31536000, immutable" : "no-cache");
        if (relativePath === "service-worker.js") reply.header("Service-Worker-Allowed", "/");
      }
    });
    // Unknown paths get the app shell only for page loads outside the API, docs and asset prefixes.
    app.setNotFoundHandler(async (request, reply) => {
      if ((request.method !== "GET" && request.method !== "HEAD") || isReservedPath(request.url)) {
        return reply.code(404).send({ error: "Not found" });
      }
      return reply.type("text/html").sendFile("index.html", { maxAge: 0, immutable: false });
    });
  } else {
    app.setNotFoundHandler(async (_request, reply) => reply.code(404).send({ error: "Not found" }));
  }

  const pruneEvents = () =>
    pruneSecurityEvents(database.db, config.jobHistoryRetentionDays).catch((error: unknown) => app.log.error({ err: error }, "Could not prune security events"));
  await pruneEvents();
  const pruneTimer = setInterval(() => void pruneEvents(), 60 * 60 * 1_000);
  pruneTimer.unref();

  app.addHook("onClose", async () => {
    clearInterval(pruneTimer);
    await database.close();
  });

  if (await hasOwner(database.db)) setupTokens.complete();
  else setupTokens.prepare();

  return { app, config, database, jobs, routes };
}
