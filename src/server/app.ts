import fs from "node:fs";
import path from "node:path";
import fastify, { FastifyInstance } from "fastify";
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
import { loadConfig } from "./config";
import { hasAdmin, requireAuth } from "./auth";
import { openDatabase, type DatabaseContext } from "./db/database";
import * as schema from "./db/schema";
import { desc } from "drizzle-orm";
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

export interface AppContext {
  app: FastifyInstance;
  config: AppConfig;
  database: DatabaseContext;
  jobs: JobRunner;
}

function formatValidationError(error: ZodError): string {
  return error.issues[0]?.message ?? "Validation failed";
}

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
  const database = await openDatabase({ databaseUrl: config.databaseUrl, migrate: config.autoMigrate });
  await reconcileOnboardingState(database.db);
  await reconcileEnvironmentPaths(database.db, config.paths, {
    allowDirectAdoptionBeforeInventory: await canAdoptEnvironmentPathsBeforeInitialScan(database.db)
  });
  const jobs = new JobRunner(database.db);

  const app = fastify({ logger: true, trustProxy: config.trustProxy });
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({ error: formatValidationError(error), issues: error.issues });
    }
    const statusCode = error && typeof error === "object" && "statusCode" in error && typeof error.statusCode === "number" ? error.statusCode : 500;
    if (statusCode >= 500) {
      request.log.error({ err: error }, "Request failed");
      return reply.code(500).send({ error: "Internal server error" });
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
        upgradeInsecureRequests: null
      }
    }
  });
  await app.register(rateLimit, { global: false });
  await app.register(compress, {
    encodings: ["br", "gzip"],
    globalDecompression: false,
    threshold: 1024
  });
  if (config.allowedOrigins.length > 0) {
    await app.register(cors, { origin: config.allowedOrigins, credentials: true });
  }
  await app.register(cookie);
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

  app.addHook("onRequest", async (request, reply) => {
    if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return;
    if (request.headers["sec-fetch-site"] === "cross-site") {
      await reply.code(403).send({ error: "Cross-site requests are not allowed" });
      return;
    }
    const origin = request.headers.origin;
    if (origin && !mutationOriginAllowed(request.protocol, request.headers.host, origin, config.allowedOrigins)) {
      await reply.code(403).send({ error: "Request origin is not allowed" });
    }
  });

  app.get("/api/health", async () => {
    await database.pool.query("select 1");
    const worker = (await database.db.select().from(schema.workerHeartbeats).orderBy(desc(schema.workerHeartbeats.heartbeatAt)).limit(1))[0] ?? null;
    const workerAgeMs = worker ? Math.max(0, Date.now() - Date.parse(worker.heartbeatAt)) : null;
    return {
      ok: true,
      database: "ready",
      worker: worker && worker.status === "running" && workerAgeMs != null && workerAgeMs <= 30_000 ? "ready" : worker ? "stale" : "not_started",
      workerHeartbeatAt: worker?.heartbeatAt ?? null
    };
  });
  registerAuthRoutes(app, database.db, {
    cookieName: config.sessionCookieName,
    cookieSecure: config.sessionCookieSecure
  });

  app.addHook("preHandler", async (request, reply) => {
    const documentationRequest = config.apiDocsEnabled && request.url.startsWith("/documentation");
    if (!request.url.startsWith("/api/") && !documentationRequest) return;
    if (request.url.startsWith("/api/auth/") || request.url === "/api/health") return;
    await requireAuth(database.db, config.sessionCookieName)(request, reply);
    if (reply.sent) return;
    if (documentationRequest) return;
    if (request.method === "GET" || request.method === "HEAD" || request.method === "OPTIONS") return;
    if (request.url.startsWith("/api/system/path-migration") || /^\/api\/jobs\/\d+\/(terminate|cancel)(?:\?|$)/.test(request.url)) return;
    if (await isPathConfigurationBlocked(database.db)) {
      await reply.code(423).send({ error: "Managed storage paths changed. Complete the required path migration before modifying the library." });
      return;
    }
    if (request.url.startsWith("/api/onboarding")) return;
    if (!(await isOnboardingComplete(database.db))) {
      await reply.code(423).send({ error: "Complete initial setup before modifying the library." });
    }
  });

  registerOnboardingRoutes(app, database.db);
  registerSettingsRoutes(app, database.db);
  registerLibraryRoutes(app, database.db, jobs);
  registerAuditRoutes(app, database.db, jobs);
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
      setHeaders(response, filePath) {
        const relativePath = path.relative(config.webRoot, filePath);
        const isHashedAsset = relativePath.startsWith(`assets${path.sep}`);
        response.setHeader("Cache-Control", isHashedAsset ? "public, max-age=31536000, immutable" : "no-cache");
      }
    });
    app.setNotFoundHandler(async (request, reply) => {
      if (request.url.startsWith("/api/") || request.url.startsWith("/documentation")) {
        return reply.code(404).send({ error: "Not found" });
      }
      return reply.type("text/html").sendFile("index.html", { maxAge: 0, immutable: false });
    });
  }

  app.addHook("onClose", async () => {
    await database.close();
  });

  if (!(await hasAdmin(database.db))) {
    app.log.warn("SRTL Manager setup required. Open the web UI to create the first admin user.");
  }

  return { app, config, database, jobs };
}
