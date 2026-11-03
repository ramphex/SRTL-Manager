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
import packageJson from "../../package.json";
import type { AppConfig } from "./config";
import { loadConfig, secretKeyOptions } from "./config";
import { getSessionUser, hasAdmin } from "./auth";
import { openDatabase, type DatabaseContext } from "./db/database";
import * as schema from "./db/schema";
import { desc, eq } from "drizzle-orm";
import { isPathConfigurationBlocked, reconcileEnvironmentPaths } from "./lib/pathConfiguration";
import { canAdoptEnvironmentPathsBeforeInitialScan, isOnboardingComplete, reconcileOnboardingState } from "./lib/onboarding";
import { JobRunner } from "./jobs/jobRunner";
import { registerAuthRoutes } from "./routes/authRoutes";
import { registerSettingsRoutes } from "./routes/settingsRoutes";
import { registerLibraryRoutes } from "./routes/libraryRoutes";
import { registerAuditRoutes } from "./routes/auditRoutes";
import { registerJobRoutes } from "./routes/jobRoutes";
import { registerSystemRoutes } from "./routes/systemRoutes";
import { registerPathConfigurationRoutes } from "./routes/pathConfigurationRoutes";
import { registerOnboardingRoutes } from "./routes/onboardingRoutes";
import { registerRadarrRoutes, webhookInstanceId } from "./routes/radarrRoutes";
import { registerDamagedRoutes } from "./routes/damagedRoutes";
import { registerOrphanRoutes } from "./routes/orphanRoutes";
import { registerMediaServerRoutes } from "./routes/mediaServerRoutes";
import { registerWatchSyncRoutes } from "./routes/watchSyncRoutes";
import { registerNowPlayingRoutes } from "./routes/nowPlayingRoutes";
import { authenticateRadarrWebhook } from "./lib/radarr";
import { authenticateSonarrWebhook } from "./lib/sonarr";
import { registerSonarrRoutes, sonarrWebhookInstanceId } from "./routes/sonarrRoutes";
import { configureOutboundPolicy } from "./lib/outboundPolicy";
import { loadAndInstallSecretKey } from "./lib/secretBox";
import { applyRouteAccessPolicy, defaultBodyLimitBytes, isDirectLoopbackRequest, isReservedPath, type WebhookKind } from "./routeAccess";

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

export async function createApp(overrides: Partial<AppConfig> = {}): Promise<AppContext> {
  const config = loadConfig(overrides);
  const secretKey = loadAndInstallSecretKey(secretKeyOptions(config.rootDir, config.dataDir));
  configureOutboundPolicy(config.outboundPolicy);
  const database = await openDatabase({ databaseUrl: config.databaseUrl, migrate: config.autoMigrate, discardUnreadableCredentials: config.discardUnreadableCredentials });
  await reconcileOnboardingState(database.db);
  await reconcileEnvironmentPaths(database.db, config.paths, {
    allowDirectAdoptionBeforeInventory: await canAdoptEnvironmentPathsBeforeInitialScan(database.db)
  });
  const jobs = new JobRunner(database.db);

  const app = fastify({ logger: true, trustProxy: config.trustProxy, bodyLimit: defaultBodyLimitBytes });
  if (secretKey.source === "generated") {
    app.log.warn(`Created the secret key for stored credentials at ${secretKey.path}. Back it up with the database: without it, saved tokens and API keys cannot be read.`);
  }
  // Every route gets its access policy stamped on before anything can register one.
  const routes: Array<{ method: string; url: string }> = [];
  app.addHook("onRoute", (route) => {
    for (const method of [route.method].flat()) routes.push({ method: String(method), url: route.url });
    applyRouteAccessPolicy(route);
  });
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({ error: formatValidationError(error), issues: error.issues });
    }
    const statusCode = error && typeof error === "object" && "statusCode" in error && typeof error.statusCode === "number" ? error.statusCode : 500;
    if (statusCode >= 500) {
      request.log.error({ err: error }, "Request failed");
      return reply.code(500).send({ error: "Internal server error" });
    }
    if (statusCode === 403 && request.routeOptions.url === "/*") {
      // The static file server refuses non-canonical paths; answer like any other unknown path.
      return reply.code(404).send({ error: "Not found" });
    }
    return reply.code(statusCode).send({ error: error instanceof Error ? error.message : "Request failed" });
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
  app.addHook("onRequest", async (_request, reply) => {
    reply.header("Permissions-Policy", permissionsPolicy);
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

  const trustedOrigins = config.publicOrigin && !config.allowedOrigins.includes(config.publicOrigin) ? [...config.allowedOrigins, config.publicOrigin] : config.allowedOrigins;
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

  // Counts a request made without an admin session. Returns true once it has answered 429.
  const rejectOverAnonymousLimit = async (request: FastifyRequest, reply: FastifyReply): Promise<boolean> => {
    const limit = await anonymousRateLimit(request);
    if (limit.isAllowed || !limit.isExceeded) return false;
    reply.header("Retry-After", String(limit.ttlInSeconds));
    await reply.code(429).send({ error: "Too many requests" });
    return true;
  };

  // Default-deny guard. It runs before the body is read and decides only from
  // the matched route's config, which applyRouteAccessPolicy stamps on every route.
  app.addHook("onRequest", async (request, reply) => {
    if (reply.sent) return;
    if (request.is404) {
      await rejectOverAnonymousLimit(request, reply);
      return;
    }
    const routeConfig = request.routeOptions.config;
    const access = routeConfig.auth ?? "admin";
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
    } else if (!(await getSessionUser(database.db, request.cookies[config.sessionCookieName]))) {
      if (!(await rejectOverAnonymousLimit(request, reply))) await reply.code(401).send({ error: "Authentication required" });
      return;
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
    return {
      ok: ready,
      database: "ready",
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
  registerAuthRoutes(app, database.db, {
    cookieName: config.sessionCookieName,
    cookieSecure: config.sessionCookieSecure
  });

  registerOnboardingRoutes(app, database.db);
  registerSettingsRoutes(app, database.db);
  registerRadarrRoutes(app, database.db);
  registerSonarrRoutes(app, database.db);
  registerMediaServerRoutes(app, database.db);
  registerWatchSyncRoutes(app, database.db, jobs);
  registerNowPlayingRoutes(app, database.db, { sessionCookieName: config.sessionCookieName, limits: config.nowPlayingStreams });
  registerLibraryRoutes(app, database.db, jobs);
  registerAuditRoutes(app, database.db, jobs);
  registerOrphanRoutes(app, database.db, jobs);
  registerDamagedRoutes(app, database.db);
  registerJobRoutes(app, jobs);
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

  app.addHook("onClose", async () => {
    await database.close();
  });

  if (!(await hasAdmin(database.db))) {
    app.log.warn("SRTL Manager setup required. Open the web UI to create the first admin user.");
  }

  return { app, config, database, jobs, routes };
}
