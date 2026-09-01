import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, inArray, sql } from "drizzle-orm";
import { createApp, type AppContext } from "../src/server/app";
import { first, getJsonSetting, setSetting } from "../src/server/db/database";
import * as schema from "../src/server/db/schema";
import { CopyTransferLimiter } from "../src/server/jobs/copyLimiter";
import { JobWorker } from "../src/server/jobs/jobRunner";
import type { AuditCommandRunner } from "../src/server/lib/auditor";
import { readCopyFileIdentity, serializeCopyFileIdentity, type CopyCommandRunner, type CopyFileProgressReporter } from "../src/server/lib/copier";
import { reconcileEnvironmentPaths } from "../src/server/lib/pathConfiguration";
import { markOnboardingCompleteForExistingInstall } from "../src/server/lib/onboarding";
import { getInventorySummary } from "../src/server/lib/scanner";
import { bootstrapLocalStoragePolicies, normalizeTitle } from "../src/server/lib/storagePolicies";
import type { AuditMode, SectionContentType, StoragePolicyKind } from "../src/shared/types";
import { createTestDatabase, type TestDatabaseHandle } from "./testDb";

let tmpDir: string;
let ctx: AppContext;
let testDatabase: TestDatabaseHandle;
let copyFfmpegModes: AuditMode[] = [];
let copyCmpCalls = 0;

const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined
};

async function createAdminSession(): Promise<string> {
  const setup = await ctx.app.inject({
    method: "POST",
    url: "/api/auth/setup",
    payload: { username: "admin", password: "password123", confirmPassword: "password123" }
  });
  expect(setup.statusCode).toBe(200);
  await markOnboardingCompleteForExistingInstall(ctx.database.db);
  return String(setup.headers["set-cookie"]);
}

async function insertMediaLink(
  itemName: string,
  kind = "remote",
  section = "movies",
  relativePath?: string,
  storagePolicy: StoragePolicyKind = "unassigned",
  resolvedStorageFileId: number | null = null
): Promise<number> {
  const timestamp = new Date().toISOString();
  const slug = itemName.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const linkRelativePath = relativePath ?? path.join(itemName, `${slug}.mkv`);
  const row = await first(ctx.database.db
    .insert(schema.mediaLinks)
    .values({
      section,
      itemName,
      relativePath: linkRelativePath,
      linkPath: path.join(tmpDir, "plex", section, linkRelativePath),
      targetPath: path.join(tmpDir, kind === "local" ? "local" : "remote", linkRelativePath),
      kind,
      targetExists: true,
      isMedia: true,
      storagePolicy,
      resolvedStorageFileId,
      sizeBytes: null,
      firstSeenAt: timestamp,
      lastSeenAt: timestamp,
      lastChangedAt: timestamp,
      missingSince: null,
      lastSeenJobId: 1,
      updatedAt: timestamp
    })
    .returning({ id: schema.mediaLinks.id }));
  if (!row) throw new Error("Media link was not inserted");
  return row.id;
}

async function insertStorageFile(rootType: "local" | "remote", relativePath: string, sizeBytes = 1024): Promise<number> {
  const timestamp = new Date().toISOString();
  const rootPath = path.join(tmpDir, rootType);
  const filePath = path.join(rootPath, relativePath);
  const parts = relativePath.replace(/\\/g, "/").split("/").filter(Boolean);
  const itemName = parts.length > 1 ? parts[1] : path.basename(parts[0] ?? relativePath, path.extname(parts[0] ?? relativePath));
  await ctx.database.db
    .insert(schema.storageFiles)
    .values({
      rootType,
      rootPath,
      section: parts.length > 1 ? parts[0] : "",
      itemName,
      relativePath,
      filePath,
      storagePolicy: "unassigned",
      sizeBytes,
      mtimeMs: Date.parse(timestamp),
      firstSeenAt: timestamp,
      lastSeenAt: timestamp,
      lastChangedAt: timestamp,
      missingSince: null,
      lastSeenJobId: 1,
      updatedAt: timestamp
    });
  const row = await first(ctx.database.db.select({ id: schema.storageFiles.id }).from(schema.storageFiles).where(eq(schema.storageFiles.filePath, filePath)).limit(1));
  if (!row) throw new Error(`Storage file was not inserted: ${filePath}`);
  return row.id;
}

async function ensureSection(name: string, displayName: string | null = null, contentType: SectionContentType | null = null): Promise<void> {
  const timestamp = new Date().toISOString();
  await ctx.database.db
    .insert(schema.sections)
    .values({ name, displayName, contentType, createdAt: timestamp, updatedAt: timestamp })
    .onConflictDoNothing();
}

async function insertRunningJob(startedAt: string, type: "scan" | "audit" = "scan"): Promise<number> {
  const row = await first(ctx.database.db
    .insert(schema.jobs)
    .values({ type, status: "running", createdAt: startedAt, startedAt, finishedAt: null, progress: "{}" })
    .returning({ id: schema.jobs.id }));
  if (!row) throw new Error("Running job was not inserted");
  await ctx.database.db.insert(schema.jobEvents).values({ jobId: row.id, timestamp: startedAt, level: "info", message: "Started", data: "{}" });
  return row.id;
}

async function insertRunningScanRun(jobId: number, startedAt: string): Promise<void> {
  await ctx.database.db
    .insert(schema.scanRuns)
    .values({
      jobId,
      status: "running",
      startedAt,
      finishedAt: null,
      errorMessage: null,
      totalLinks: 0,
      remoteLinks: 0,
      localLinks: 0,
      brokenLinks: 0,
      otherLinks: 0,
      nonMediaLinks: 0,
      actionableRemoteLinks: 0,
      actionableLocalLinks: 0,
      assignedRemoteLinks: 0,
      unassignedRemoteLinks: 0,
      unassignedLocalLinks: 0,
      localFiles: 0,
      remoteFiles: 0,
      actionableRemoteFiles: 0,
      actionableLocalFiles: 0,
      assignedRemoteFiles: 0,
      unassignedRemoteFiles: 0,
      unassignedLocalFiles: 0,
      localOrphanFiles: 0,
      remoteOrphanFiles: 0,
      missingLinks: 0,
      missingLocalFiles: 0,
      missingRemoteFiles: 0
    });
}

async function waitForTerminalJob(jobId: number) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const job = await ctx.jobs.getJob(jobId);
    if (job && ["completed", "partially_failed", "failed", "cancelled"].includes(job.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for job #${jobId}`);
}

async function runQueuedJob(jobId: number, options: { copyRunner?: CopyCommandRunner; auditRunner?: AuditCommandRunner } = {}) {
  const worker = new JobWorker(ctx.database.db, {
    workerId: "test-worker",
    pollIntervalMs: 1,
    heartbeatIntervalMs: 10,
    logger: silentLogger,
    copyRunner: options.copyRunner,
    auditRunner: options.auditRunner
  });
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const current = await ctx.jobs.getJob(jobId);
    if (current && ["completed", "partially_failed", "failed", "cancelled"].includes(current.status)) return current;
    expect(await worker.runOnce()).toBe(true);
  }
  return waitForTerminalJob(jobId);
}

const testCopyRunner: CopyCommandRunner = {
  async copyFile(sourcePath, tempPath, reportProgress?: CopyFileProgressReporter) {
    const source = await fs.readFile(sourcePath);
    await reportProgress?.({ bytesCopied: 0, bytesProcessed: 0, totalBytes: source.length, bytesPerSecond: 0, remainingSeconds: null });
    await fs.writeFile(tempPath, source);
    await reportProgress?.({ bytesCopied: source.length, bytesProcessed: source.length, totalBytes: source.length, bytesPerSecond: source.length, remainingSeconds: 0 });
  },
  async runCmp(sourcePath, targetPath, reportProgress?: CopyFileProgressReporter) {
    copyCmpCalls += 1;
    try {
      const [source, target] = await Promise.all([fs.readFile(sourcePath), fs.readFile(targetPath)]);
      await reportProgress?.({ bytesProcessed: 0, totalBytes: source.length, bytesPerSecond: 0, remainingSeconds: null });
      await reportProgress?.({ bytesProcessed: source.length, totalBytes: source.length, bytesPerSecond: source.length, remainingSeconds: 0 });
      return { status: source.equals(target) ? "pass" : "fail", output: source.equals(target) ? "" : "test byte mismatch" };
    } catch (error) {
      return { status: "fail", output: error instanceof Error ? error.message : String(error) };
    }
  },
  async runFfmpeg(_mode, _targetPath, reportProgress?: CopyFileProgressReporter) {
    copyFfmpegModes.push(_mode);
    await reportProgress?.({ bytesProcessed: 0, totalBytes: 1, bytesPerSecond: 0, remainingSeconds: null });
    await reportProgress?.({ bytesProcessed: 1, totalBytes: 1, bytesPerSecond: 1, remainingSeconds: 0 });
    return { status: "pass", output: "" };
  }
};

async function insertCopySymlink({
  itemName,
  kind,
  storagePolicy,
  section = "movies",
  relativePath: customRelativePath,
  sourceRelativePath: customSourceRelativePath,
  content = "media content",
  writeSource = true
}: {
  itemName: string;
  kind: "local" | "remote";
  storagePolicy: StoragePolicyKind;
  section?: string;
  relativePath?: string;
  sourceRelativePath?: string;
  content?: string;
  writeSource?: boolean;
}): Promise<{ id: number; sourcePath: string; destinationPath: string; linkPath: string; relativePath: string }> {
  const timestamp = new Date().toISOString();
  const relativePath = customRelativePath ?? path.join(itemName, `${itemName.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.mkv`);
  const sourceRelativePath = customSourceRelativePath ?? relativePath;
  const sourceRoot = path.join(tmpDir, kind);
  const destinationRoot = path.join(tmpDir, kind === "local" ? "remote" : "local");
  const sourcePath = path.join(sourceRoot, section, sourceRelativePath);
  const destinationPath = path.join(destinationRoot, section, relativePath);
  const linkPath = path.join(tmpDir, "plex", section, relativePath);

  await fs.mkdir(path.dirname(sourcePath), { recursive: true });
  await fs.mkdir(path.dirname(linkPath), { recursive: true });
  if (writeSource) await fs.writeFile(sourcePath, content);
  await fs.symlink(sourcePath, linkPath);

  const row = await first(ctx.database.db
    .insert(schema.mediaLinks)
    .values({
      section,
      itemName,
      relativePath,
      linkPath,
      targetPath: sourcePath,
      kind,
      targetExists: writeSource,
      isMedia: true,
      storagePolicy,
      resolvedStorageFileId: null,
      sizeBytes: Buffer.byteLength(content),
      firstSeenAt: timestamp,
      lastSeenAt: timestamp,
      lastChangedAt: timestamp,
      missingSince: null,
      lastSeenJobId: 1,
      updatedAt: timestamp
    })
    .returning({ id: schema.mediaLinks.id }));
  if (!row) throw new Error("Copy symlink was not inserted");

  return { id: row.id, sourcePath, destinationPath, linkPath, relativePath };
}

async function markCopyFixtureInstalled(jobId: number, fixture: Awaited<ReturnType<typeof insertCopySymlink>>, timestamp: string): Promise<void> {
  await fs.mkdir(path.dirname(fixture.destinationPath), { recursive: true });
  await fs.copyFile(fixture.sourcePath, fixture.destinationPath);
  await fs.rm(fixture.linkPath, { force: true });
  await fs.symlink(fixture.destinationPath, fixture.linkPath);
  const stat = await fs.stat(fixture.destinationPath);
  await ctx.database.db
    .update(schema.mediaLinks)
    .set({
      targetPath: fixture.destinationPath,
      kind: "local",
      targetExists: true,
      sizeBytes: stat.size,
      lastChangedAt: timestamp,
      updatedAt: timestamp
    })
    .where(eq(schema.mediaLinks.id, fixture.id));
  await ctx.database.db.insert(schema.copySources).values({
    destinationPath: fixture.destinationPath,
    sourcePath: fixture.sourcePath,
    linkPath: fixture.linkPath,
    recordedAt: timestamp
  });
  await ctx.database.db.insert(schema.jobEvents).values({
    jobId,
    timestamp,
    level: "info",
    message: "Verified copy installed",
    data: JSON.stringify({
      status: "copied",
      message: "Copied and verified media",
      direction: "to_local",
      sourceRootType: "remote",
      destinationRootType: "local",
      sourcePath: fixture.sourcePath,
      destinationPath: fixture.destinationPath,
      linkPath: fixture.linkPath,
      sizeBytes: stat.size
    })
  });
}

async function insertCopyOperationFixture({
  jobId,
  fixture,
  stage,
  resultStatus = null,
  errorMessage = null
}: {
  jobId: number;
  fixture: Awaited<ReturnType<typeof insertCopySymlink>>;
  stage: "committed" | "reconciliation_required";
  resultStatus?: "copied" | "repointed" | null;
  errorMessage?: string | null;
}): Promise<number> {
  const mediaLink = await first(ctx.database.db.select().from(schema.mediaLinks).where(eq(schema.mediaLinks.id, fixture.id)).limit(1));
  if (!mediaLink) throw new Error("Copy operation fixture media link was not found");
  const timestamp = new Date().toISOString();
  const operation = await first(
    ctx.database.db
      .insert(schema.copyOperations)
      .values({
        jobId,
        mediaLinkId: fixture.id,
        linkPath: fixture.linkPath,
        sourcePath: fixture.sourcePath,
        destinationPath: fixture.destinationPath,
        originalTargetPath: fixture.sourcePath,
        originalLinkState: JSON.stringify(mediaLink),
        previousCopySource: null,
        tempPath: null,
        displacedPath: null,
        tempIdentity: null,
        destinationIdentity: null,
        displacedIdentity: null,
        stage,
        resultStatus,
        localConflictStrategy: null,
        sizeBytes: mediaLink.sizeBytes,
        errorMessage,
        createdAt: timestamp,
        updatedAt: timestamp,
        completedAt: stage === "committed" ? timestamp : null
      })
      .returning({ id: schema.copyOperations.id })
  );
  if (!operation) throw new Error("Copy operation fixture was not inserted");
  return operation.id;
}

describe("api app", () => {
  beforeEach(async () => {
    copyFfmpegModes = [];
    copyCmpCalls = 0;
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "srtl-api-"));
    await fs.mkdir(path.join(tmpDir, "plex", "movies"), { recursive: true });
    await fs.mkdir(path.join(tmpDir, "plex", "shows"), { recursive: true });
    await fs.mkdir(path.join(tmpDir, "local"), { recursive: true });
    await fs.mkdir(path.join(tmpDir, "remote"), { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, ".env"),
      [`SYMLINK_DIR="${path.join(tmpDir, "plex")}"`, `SRTL_LOCATION_1_PATH="${path.join(tmpDir, "local")}"`, `SRTL_LOCATION_2_PATH="${path.join(tmpDir, "remote")}"`].join("\n")
    );
    testDatabase = await createTestDatabase();
    ctx = await createApp({ rootDir: tmpDir, dataDir: path.join(tmpDir, "data"), databaseUrl: testDatabase.databaseUrl });
    await setSetting(ctx.database.db, "sections", { sections: ["movies", "shows"], sectionTitles: {}, sectionTypes: { movies: "movies", shows: "shows" } });
    await ensureSection("movies", null, "movies");
    await ensureSection("shows", null, "shows");
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    if (typeof ctx !== "undefined") await ctx.app.close();
    if (typeof testDatabase !== "undefined") await testDatabase.cleanup();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("compresses static assets and only caches fingerprinted bundles immutably", async () => {
    const webRoot = path.join(tmpDir, "web");
    const assetsRoot = path.join(webRoot, "assets");
    await fs.mkdir(assetsRoot, { recursive: true });
    await fs.writeFile(path.join(webRoot, "index.html"), "<!doctype html><html><body><div id=\"root\"></div></body></html>");
    await fs.writeFile(path.join(webRoot, "theme-init.js"), "document.documentElement.dataset.theme = 'dark';");
    await fs.writeFile(path.join(webRoot, "service-worker.js"), "self.addEventListener('fetch', () => undefined);");
    await fs.writeFile(path.join(assetsRoot, "index-a1b2c3.js"), `const payload = ${JSON.stringify("compressible payload ".repeat(300))};`);

    await ctx.app.close();
    ctx = await createApp({
      rootDir: tmpDir,
      dataDir: path.join(tmpDir, "data"),
      databaseUrl: testDatabase.databaseUrl,
      webRoot
    });

    const asset = await ctx.app.inject({
      method: "GET",
      url: "/assets/index-a1b2c3.js",
      headers: { "accept-encoding": "gzip" }
    });
    expect(asset.statusCode).toBe(200);
    expect(asset.headers["content-encoding"]).toBe("gzip");
    expect(asset.headers.vary).toContain("accept-encoding");
    expect(asset.headers["cache-control"]).toBe("public, max-age=31536000, immutable");

    const entryScript = await ctx.app.inject({ method: "GET", url: "/theme-init.js" });
    expect(entryScript.statusCode).toBe(200);
    expect(entryScript.headers["cache-control"]).toBe("no-cache");

    const missingAsset = await ctx.app.inject({ method: "GET", url: "/assets/missing-bundle.js" });
    expect(missingAsset.statusCode).toBe(404);
    expect(missingAsset.json()).toEqual({ error: "Not found" });

    const serviceWorker = await ctx.app.inject({ method: "GET", url: "/service-worker.js" });
    expect(serviceWorker.statusCode).toBe(200);
    expect(serviceWorker.headers["cache-control"]).toBe("no-cache");
    expect(serviceWorker.headers["service-worker-allowed"]).toBe("/");

    const index = await ctx.app.inject({ method: "GET", url: "/" });
    expect(index.statusCode).toBe(200);
    expect(index.headers["cache-control"]).toBe("no-cache");

    const clientRoute = await ctx.app.inject({ method: "GET", url: "/library" });
    expect(clientRoute.statusCode).toBe(200);
    expect(clientRoute.headers["cache-control"]).toBe("no-cache");
    expect(clientRoute.body).toContain("<div id=\"root\"></div>");
  });

  it("requires setup and protects API routes", async () => {
    const me = await ctx.app.inject({ method: "GET", url: "/api/auth/me" });
    expect(me.json()).toMatchObject({ authenticated: false, setupRequired: true });

    const denied = await ctx.app.inject({ method: "GET", url: "/api/settings/paths" });
    expect(denied.statusCode).toBe(401);

    const shortPassword = await ctx.app.inject({
      method: "POST",
      url: "/api/auth/setup",
      payload: { username: "admin", password: "short", confirmPassword: "short" }
    });
    expect(shortPassword.statusCode).toBe(400);
    expect(shortPassword.json()).toMatchObject({ error: "Password must be at least 8 characters" });

    const mismatch = await ctx.app.inject({
      method: "POST",
      url: "/api/auth/setup",
      payload: { username: "admin", password: "password123", confirmPassword: "password456" }
    });
    expect(mismatch.statusCode).toBe(400);
    expect(mismatch.json()).toMatchObject({ error: "Passwords do not match" });

    const setupCookie = await createAdminSession();

    const authenticatedMe = await ctx.app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie: String(setupCookie) } });
    expect(authenticatedMe.json()).toMatchObject({ authenticated: true, setupRequired: false, user: { username: "admin" } });

    const setupPaths = await ctx.app.inject({ method: "GET", url: "/api/settings/paths", headers: { cookie: String(setupCookie) } });
    expect(setupPaths.statusCode).toBe(200);

    const defaultScanSettings = await ctx.app.inject({ method: "GET", url: "/api/settings/scan", headers: { cookie: String(setupCookie) } });
    expect(defaultScanSettings.statusCode).toBe(200);
    expect(defaultScanSettings.json()).toEqual({ scanSymlinks: true, scanLocal: false, scanRemote: false, symlinkSections: ["movies", "shows"], localSections: ["movies", "shows"] });

    const saveScanSettings = await ctx.app.inject({
      method: "PUT",
      url: "/api/settings/scan",
      headers: { cookie: String(setupCookie) },
      payload: { scanSymlinks: false, scanLocal: true, scanRemote: true, symlinkSections: ["movies"], localSections: ["shows"] }
    });
    expect(saveScanSettings.statusCode).toBe(200);
    expect(saveScanSettings.json()).toEqual({ scanSymlinks: false, scanLocal: true, scanRemote: true, symlinkSections: ["movies"], localSections: ["shows"] });

    const savedScanSettings = await ctx.app.inject({ method: "GET", url: "/api/settings/scan", headers: { cookie: String(setupCookie) } });
    expect(savedScanSettings.statusCode).toBe(200);
    expect(savedScanSettings.json()).toEqual({ scanSymlinks: false, scanLocal: true, scanRemote: true, symlinkSections: ["movies"], localSections: ["shows"] });

    const defaultAuditSettings = await ctx.app.inject({ method: "GET", url: "/api/settings/audit", headers: { cookie: String(setupCookie) } });
    expect(defaultAuditSettings.statusCode).toBe(200);
    expect(defaultAuditSettings.json()).toEqual({ sections: ["movies", "shows"], targets: ["local", "remote"] });

    const saveAuditSettings = await ctx.app.inject({
      method: "PUT",
      url: "/api/settings/audit",
      headers: { cookie: String(setupCookie) },
      payload: { sections: ["shows"], targets: ["remote"] }
    });
    expect(saveAuditSettings.statusCode).toBe(200);
    expect(saveAuditSettings.json()).toEqual({ sections: ["shows"], targets: ["remote"] });

    const savedAuditSettings = await ctx.app.inject({ method: "GET", url: "/api/settings/audit", headers: { cookie: String(setupCookie) } });
    expect(savedAuditSettings.statusCode).toBe(200);
    expect(savedAuditSettings.json()).toEqual({ sections: ["shows"], targets: ["remote"] });

    const clearAuditTargets = await ctx.app.inject({
      method: "PUT",
      url: "/api/settings/audit",
      headers: { cookie: String(setupCookie) },
      payload: { sections: [], targets: [] }
    });
    expect(clearAuditTargets.statusCode).toBe(200);
    expect(clearAuditTargets.json()).toEqual({ sections: [], targets: [] });

    const defaultAdvancedSettings = await ctx.app.inject({ method: "GET", url: "/api/settings/advanced", headers: { cookie: String(setupCookie) } });
    expect(defaultAdvancedSettings.statusCode).toBe(200);
    expect(defaultAdvancedSettings.json()).toEqual({
      scan: { symlinkFolderScheduling: "single_job" },
      copy: { profile: "balanced", byteCompare: true, mediaValidation: "fast" },
      audit: { defaultMode: "fast", byteCompareWhenSourceKnown: true }
    });

    const saveAdvancedSettings = await ctx.app.inject({
      method: "PUT",
      url: "/api/settings/advanced",
      headers: { cookie: String(setupCookie) },
      payload: {
        copy: { profile: "custom", byteCompare: false, mediaValidation: "deep" },
        audit: { defaultMode: "deep", byteCompareWhenSourceKnown: false }
      }
    });
    expect(saveAdvancedSettings.statusCode).toBe(200);
    expect(saveAdvancedSettings.json()).toEqual({
      scan: { symlinkFolderScheduling: "single_job" },
      copy: { profile: "custom", byteCompare: false, mediaValidation: "deep" },
      audit: { defaultMode: "deep", byteCompareWhenSourceKnown: false }
    });

    const disableCopyVerification = await ctx.app.inject({
      method: "PUT",
      url: "/api/settings/advanced",
      headers: { cookie: String(setupCookie) },
      payload: {
        copy: { profile: "off", byteCompare: true, mediaValidation: "deep" },
        audit: { defaultMode: "fast", byteCompareWhenSourceKnown: true }
      }
    });
    expect(disableCopyVerification.statusCode).toBe(200);
    expect(disableCopyVerification.json()).toEqual({
      scan: { symlinkFolderScheduling: "single_job" },
      copy: { profile: "off", byteCompare: false, mediaValidation: "off" },
      audit: { defaultMode: "fast", byteCompareWhenSourceKnown: true }
    });

    const invalidAdvancedSettings = await ctx.app.inject({
      method: "PUT",
      url: "/api/settings/advanced",
      headers: { cookie: String(setupCookie) },
      payload: {
        copy: { profile: "custom", byteCompare: false, mediaValidation: "off" },
        audit: { defaultMode: "fast", byteCompareWhenSourceKnown: true }
      }
    });
    expect(invalidAdvancedSettings.statusCode).toBe(400);
    expect(invalidAdvancedSettings.json()).toMatchObject({ error: "Custom copy verification must keep byte compare or media validation enabled" });

    const scan = await ctx.app.inject({ method: "POST", url: "/api/scans", headers: { cookie: String(setupCookie) } });
    expect(scan.statusCode).toBe(200);
    expect(scan.json()).toEqual({ jobId: expect.any(Number), jobIds: [expect.any(Number)] });
    expect(await ctx.jobs.terminate(scan.json<{ jobId: number }>().jobId)).toBe(true);

    const scopedScan = await ctx.app.inject({
      method: "POST",
      url: "/api/scans",
      headers: { cookie: String(setupCookie) },
      payload: { scanSymlinks: true, scanLocal: false, scanRemote: false, sections: ["movies"] }
    });
    expect(scopedScan.statusCode).toBe(200);
    const jobs = await ctx.app.inject({ method: "GET", url: "/api/jobs", headers: { cookie: String(setupCookie) } });
    expect(jobs.statusCode).toBe(200);
    expect(jobs.json<Array<{ id: number; progress: { options?: unknown } }>>().find((job) => job.id === scopedScan.json<{ jobId: number }>().jobId)).toMatchObject({
      progress: {
        options: { scanSymlinks: true, scanLocal: false, scanRemote: false, sections: ["movies"], symlinkSections: ["movies"], localSections: ["movies"] }
      }
    });

    await fs.mkdir(path.join(tmpDir, "remote", "Release One"), { recursive: true });
    await fs.writeFile(path.join(tmpDir, "remote", "Release One", "remote.mkv"), "remote");
    const remoteOnlyScan = await ctx.app.inject({
      method: "POST",
      url: "/api/scans",
      headers: { cookie: String(setupCookie) },
      payload: { scanSymlinks: false, scanLocal: false, scanRemote: true, symlinkSections: [], localSections: [] }
    });
    expect(remoteOnlyScan.statusCode).toBe(200);
    const remoteOnlyJobId = remoteOnlyScan.json<{ jobId: number }>().jobId;
    expect(await ctx.jobs.getJob(remoteOnlyJobId)).toMatchObject({ status: "queued", startedAt: null });
    const remoteOnlyJob = await runQueuedJob(remoteOnlyJobId);
    expect(remoteOnlyJob).toMatchObject({
      status: "completed",
      progress: {
        options: { scanSymlinks: false, scanLocal: false, scanRemote: true, symlinkSections: [], localSections: [] },
        remoteFiles: 1
      }
    });

    const inventory = await ctx.app.inject({ method: "GET", url: "/api/inventory/summary", headers: { cookie: String(setupCookie) } });
    expect(inventory.statusCode).toBe(200);
    expect(inventory.json()).toMatchObject({ totalLinks: 0, localFiles: 0, remoteFiles: 1 });

    const login = await ctx.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "admin", password: "password123" }
    });
    expect(login.statusCode).toBe(200);
    const cookie = login.headers["set-cookie"];
    expect(cookie).toBeTruthy();

    const paths = await ctx.app.inject({ method: "GET", url: "/api/settings/paths", headers: { cookie: String(cookie) } });
    expect(paths.statusCode).toBe(200);
    expect(paths.json()).toMatchObject({ symlinkDir: path.join(tmpDir, "plex"), localDir: path.join(tmpDir, "local"), remoteDir: path.join(tmpDir, "remote") });

    const sections = await ctx.app.inject({ method: "GET", url: "/api/settings/sections", headers: { cookie: String(cookie) } });
    expect(sections.statusCode).toBe(200);
    expect(sections.json()).toEqual({ sections: ["movies", "shows"], sectionTitles: {}, sectionTypes: { movies: "movies", shows: "shows" } });
  });

  it("matches usernames case-insensitively while preserving their display capitalization", async () => {
    const setup = await ctx.app.inject({
      method: "POST",
      url: "/api/auth/setup",
      payload: { username: "MixedCaseAdmin", password: "password123", confirmPassword: "password123" }
    });
    expect(setup.statusCode).toBe(200);

    const login = await ctx.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "mixedcaseadmin", password: "password123" }
    });
    expect(login.statusCode).toBe(200);

    const me = await ctx.app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { cookie: String(login.headers["set-cookie"]) }
    });
    expect(me.json()).toMatchObject({
      authenticated: true,
      user: { username: "MixedCaseAdmin" }
    });
  });

  it("saves friendly storage location names without exposing path mutation", async () => {
    const denied = await ctx.app.inject({ method: "GET", url: "/api/settings/storage-locations" });
    expect(denied.statusCode).toBe(401);

    const cookie = await createAdminSession();
    const initial = await ctx.app.inject({ method: "GET", url: "/api/settings/storage-locations", headers: { cookie } });
    expect(initial.statusCode).toBe(200);
    expect(initial.json()).toEqual({
      locations: [
        { key: "location_1", rootType: "local", displayName: "Local", path: path.join(tmpDir, "local") },
        { key: "location_2", rootType: "remote", displayName: "Remote", path: path.join(tmpDir, "remote") }
      ]
    });

    const save = await ctx.app.inject({
      method: "PUT",
      url: "/api/settings/storage-locations",
      headers: { cookie },
      payload: {
        locations: [
          { key: "location_1", displayName: "  NAS  " },
          { key: "location_2", displayName: "Archive" }
        ]
      }
    });
    expect(save.statusCode).toBe(200);
    expect(save.json()).toEqual({
      locations: [
        { key: "location_1", rootType: "local", displayName: "NAS", path: path.join(tmpDir, "local") },
        { key: "location_2", rootType: "remote", displayName: "Archive", path: path.join(tmpDir, "remote") }
      ]
    });

    const persisted = await ctx.app.inject({ method: "GET", url: "/api/settings/storage-locations", headers: { cookie } });
    expect(persisted.json()).toEqual(save.json());
    expect(await getJsonSetting(ctx.database.db, "storageLocationNames", null)).toEqual({ location_1: "NAS", location_2: "Archive" });

    const duplicate = await ctx.app.inject({
      method: "PUT",
      url: "/api/settings/storage-locations",
      headers: { cookie },
      payload: {
        locations: [
          { key: "location_1", displayName: "Same" },
          { key: "location_2", displayName: "same" }
        ]
      }
    });
    expect(duplicate.statusCode).toBe(400);
    expect(duplicate.json()).toMatchObject({ error: "Friendly names must be unique" });

    const pathMutation = await ctx.app.inject({
      method: "PUT",
      url: "/api/settings/storage-locations",
      headers: { cookie },
      payload: {
        locations: [
          { key: "location_1", displayName: "NAS", path: "/tmp/replacement" },
          { key: "location_2", displayName: "Archive" }
        ]
      }
    });
    expect(pathMutation.statusCode).toBe(400);

    const paths = await ctx.app.inject({ method: "GET", url: "/api/settings/paths", headers: { cookie } });
    expect(paths.json()).toMatchObject({ localDir: path.join(tmpDir, "local"), remoteDir: path.join(tmpDir, "remote") });
  });

  it("fails loudly when a stored JSON setting is corrupt", async () => {
    await ctx.database.db.insert(schema.appSettings).values({
      key: "corruptSetting",
      value: "{not-json",
      updatedAt: new Date().toISOString()
    });

    await expect(getJsonSetting(ctx.database.db, "corruptSetting", { fallback: true })).rejects.toThrow(
      'Stored setting "corruptSetting" contains invalid JSON'
    );
  });

  it("bounds authentication input sizes before password hashing", async () => {
    const oversizedUsername = await ctx.app.inject({
      method: "POST",
      url: "/api/auth/setup",
      payload: { username: "u".repeat(101), password: "password123", confirmPassword: "password123" }
    });
    expect(oversizedUsername.statusCode).toBe(400);
    expect(oversizedUsername.json()).toMatchObject({ error: "Username must be 100 characters or fewer" });

    const oversizedPassword = "p".repeat(257);
    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/auth/setup",
      payload: { username: "admin", password: oversizedPassword, confirmPassword: oversizedPassword }
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: "Password must be 256 characters or fewer" });
  });

  it("rejects malformed stored password digests without throwing", async () => {
    await createAdminSession();
    await ctx.database.db.update(schema.adminUsers).set({ passwordHash: "scrypt$valid-salt$invalid" });

    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "admin", password: "password123" }
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: "Invalid username or password" });
  });

  it("deletes expired sessions when they are presented", async () => {
    const cookie = await createAdminSession();
    await ctx.database.db.update(schema.sessions).set({ expiresAt: new Date(Date.now() - 1_000).toISOString() });

    const response = await ctx.app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie } });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ authenticated: false, user: null });
    await expect(ctx.database.db.select().from(schema.sessions)).resolves.toHaveLength(0);
  });

  it("serializes concurrent first-admin setup attempts", async () => {
    const payloads = [
      { username: "first-admin", password: "password123", confirmPassword: "password123" },
      { username: "second-admin", password: "password456", confirmPassword: "password456" }
    ];
    const responses = await Promise.all(
      payloads.map((payload) => ctx.app.inject({ method: "POST", url: "/api/auth/setup", payload }))
    );

    expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 409]);
    const users = await ctx.database.db.select().from(schema.adminUsers);
    expect(users).toHaveLength(1);
    expect(["first-admin", "second-admin"]).toContain(users[0]?.username);
  });

  it("rejects cross-origin mutations and exposes database-aware health", async () => {
    const health = await ctx.app.inject({ method: "GET", url: "/api/health" });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({ ok: true, database: "ready", worker: "not_started", workerHeartbeatAt: null });
    expect(health.headers["x-ratelimit-limit"]).toBe("120");
    expect(health.headers["x-content-type-options"]).toBe("nosniff");
    expect(health.headers["content-security-policy"]).toContain("default-src 'self'");
    expect(health.headers["content-security-policy"]).not.toContain("upgrade-insecure-requests");
    const liveHealth = await ctx.app.inject({ method: "GET", url: "/api/health/live" });
    expect(liveHealth.statusCode).toBe(200);
    expect(liveHealth.json()).toEqual({ ok: true, service: "running" });
    const unavailableReadiness = await ctx.app.inject({ method: "GET", url: "/api/health/ready" });
    expect(unavailableReadiness.statusCode).toBe(503);
    expect(unavailableReadiness.json()).toMatchObject({ ok: false, worker: "not_started", readyWorkerCount: 0 });
    expect(unavailableReadiness.headers["x-ratelimit-limit"]).toBe("120");

    const heartbeatAt = new Date().toISOString();
    await ctx.database.db.insert(schema.workerHeartbeats).values({ workerId: "test-worker", startedAt: heartbeatAt, heartbeatAt, status: "running" });
    const workerReadyHealth = await ctx.app.inject({ method: "GET", url: "/api/health" });
    expect(workerReadyHealth.json()).toMatchObject({ worker: "ready", workerHeartbeatAt: heartbeatAt });
    const availableReadiness = await ctx.app.inject({ method: "GET", url: "/api/health/ready" });
    expect(availableReadiness.statusCode).toBe(200);
    expect(availableReadiness.json()).toMatchObject({ ok: true, worker: "ready", workerHeartbeatAt: heartbeatAt });

    const cookie = await createAdminSession();
    const crossSite = await ctx.app.inject({
      method: "PUT",
      url: "/api/settings/user-preferences",
      headers: { cookie, origin: "http://attacker.invalid", "sec-fetch-site": "cross-site" },
      payload: { timeFormat: "24h", autoOpenTaskStatus: false, recentJobsCompletedWindowMinutes: 60 }
    });
    expect(crossSite.statusCode).toBe(403);

    const wrongOrigin = await ctx.app.inject({
      method: "PUT",
      url: "/api/settings/user-preferences",
      headers: { cookie, origin: "http://attacker.invalid" },
      payload: { timeFormat: "24h", autoOpenTaskStatus: false, recentJobsCompletedWindowMinutes: 60 }
    });
    expect(wrongOrigin.statusCode).toBe(403);

    const sameOrigin = await ctx.app.inject({
      method: "PUT",
      url: "/api/settings/user-preferences",
      headers: { cookie, origin: "http://localhost:80" },
      payload: { timeFormat: "24h", autoOpenTaskStatus: false, recentJobsCompletedWindowMinutes: 60 }
    });
    expect(sameOrigin.statusCode).toBe(200);
  });

  it("marks session cookies secure when deployment settings require HTTPS", async () => {
    await ctx.app.close();
    ctx = await createApp({
      rootDir: tmpDir,
      dataDir: path.join(tmpDir, "data"),
      databaseUrl: testDatabase.databaseUrl,
      sessionCookieSecure: true
    });
    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/auth/setup",
      payload: { username: "admin", password: "password123", confirmPassword: "password123" }
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["set-cookie"]).toContain("Secure");
    expect(response.headers["set-cookie"]).toContain("SameSite=Strict");
  });

  it("uses the configured instance-specific session cookie name", async () => {
    await ctx.app.close();
    ctx = await createApp({
      rootDir: tmpDir,
      dataDir: path.join(tmpDir, "data"),
      databaseUrl: testDatabase.databaseUrl,
      sessionCookieName: "srtl_session_5178"
    });
    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/auth/setup",
      payload: { username: "admin", password: "password123", confirmPassword: "password123" }
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["set-cookie"]).toContain("srtl_session_5178=");
  });

  it("paginates complete job event history from newest pages toward the beginning", async () => {
    const cookie = await createAdminSession();
    const timestamp = new Date().toISOString();
    const jobId = await insertRunningJob(timestamp);
    await ctx.database.db.insert(schema.jobEvents).values(
      Array.from({ length: 11 }, (_, index) => ({
        jobId,
        timestamp,
        level: "info",
        message: `Event ${index + 1}`,
        data: "{}"
      }))
    );

    const latest = await ctx.app.inject({ method: "GET", url: `/api/jobs/${jobId}/events/page?limit=5`, headers: { cookie } });
    expect(latest.statusCode).toBe(200);
    expect(latest.json()).toMatchObject({ total: 12, hasOlder: true });
    expect(latest.json().events.map((event: { message: string }) => event.message)).toEqual(["Event 7", "Event 8", "Event 9", "Event 10", "Event 11"]);

    const older = await ctx.app.inject({
      method: "GET",
      url: `/api/jobs/${jobId}/events/page?limit=5&beforeId=${latest.json().events[0].id}`,
      headers: { cookie }
    });
    expect(older.json()).toMatchObject({ total: 12, hasOlder: true });
    expect(older.json().events.map((event: { message: string }) => event.message)).toEqual(["Event 2", "Event 3", "Event 4", "Event 5", "Event 6"]);

    const earliest = await ctx.app.inject({
      method: "GET",
      url: `/api/jobs/${jobId}/events/page?limit=5&beforeId=${older.json().events[0].id}`,
      headers: { cookie }
    });
    expect(earliest.json()).toMatchObject({ total: 12, hasOlder: false });
    expect(earliest.json().events.map((event: { message: string }) => event.message)).toEqual(["Started", "Event 1"]);
  });

  it("returns a version check placeholder when GitHub has no releases", async () => {
    const cookie = await createAdminSession();
    const githubFetch = vi.fn().mockResolvedValue(new Response(JSON.stringify([]), { status: 200 }));
    vi.stubGlobal("fetch", githubFetch);

    const version = await ctx.app.inject({ method: "GET", url: "/api/system/version?refresh=true", headers: { cookie } });

    expect(version.statusCode).toBe(200);
    expect(version.json()).toMatchObject({
      currentVersion: "0.1.3-beta.4",
      currentChannel: "beta",
      currentChannelLabel: "Beta",
      latestVersion: null,
      updateAvailable: false,
      status: "unavailable",
      releaseUrl: null,
      message: "No GitHub releases yet",
      checkedAt: expect.any(String),
      stable: {
        channel: "stable",
        latestVersion: null,
        updateAvailable: false,
        status: "unavailable",
        releaseUrl: null,
        releaseNotes: null,
        message: "No GitHub releases yet"
      },
      beta: {
        channel: "beta",
        latestVersion: null,
        updateAvailable: false,
        status: "unavailable",
        releaseUrl: null,
        releaseNotes: null,
        message: "No GitHub releases yet"
      }
    });
    expect(githubFetch).toHaveBeenCalledWith("https://api.github.com/repos/ramphex/srtl-manager/releases?per_page=20", expect.objectContaining({ headers: expect.any(Object) }));
  });

  it("returns stable and beta version availability with release notes", async () => {
    const cookie = await createAdminSession();
    const githubFetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify([
          {
            tag_name: "v0.1.1",
            html_url: "https://github.com/ramphex/srtl-manager/releases/tag/v0.1.1",
            body: "Stable release notes",
            prerelease: false,
            draft: false
          },
          {
            tag_name: "v0.2.0-beta.1",
            html_url: "https://github.com/ramphex/srtl-manager/releases/tag/v0.2.0-beta.1",
            body: "Beta release notes",
            prerelease: true,
            draft: false
          },
          {
            tag_name: "v9.9.9",
            html_url: "https://github.com/ramphex/srtl-manager/releases/tag/v9.9.9",
            body: "Draft notes",
            prerelease: false,
            draft: true
          }
        ]),
        { status: 200 }
      )
    );
    vi.stubGlobal("fetch", githubFetch);

    const version = await ctx.app.inject({ method: "GET", url: "/api/system/version?refresh=true", headers: { cookie } });

    expect(version.statusCode).toBe(200);
    expect(version.json()).toMatchObject({
      currentVersion: "0.1.3-beta.4",
      currentChannel: "beta",
      currentChannelLabel: "Beta",
      latestVersion: "0.2.0-beta.1",
      updateAvailable: true,
      status: "update_available",
      releaseUrl: "https://github.com/ramphex/srtl-manager/releases/tag/v0.2.0-beta.1",
      message: "Beta v0.2.0-beta.1 available",
      checkedAt: expect.any(String),
      stable: {
        channel: "stable",
        latestVersion: "0.1.1",
        updateAvailable: false,
        status: "up_to_date",
        releaseUrl: "https://github.com/ramphex/srtl-manager/releases/tag/v0.1.1",
        releaseNotes: "Stable release notes",
        message: "Stable is up to date"
      },
      beta: {
        channel: "beta",
        latestVersion: "0.2.0-beta.1",
        updateAvailable: true,
        status: "update_available",
        releaseUrl: "https://github.com/ramphex/srtl-manager/releases/tag/v0.2.0-beta.1",
        releaseNotes: "Beta release notes",
        message: "Beta v0.2.0-beta.1 available"
      }
    });
  });

  it("caches GitHub version checks until manually refreshed", async () => {
    const cookie = await createAdminSession();
    const githubFetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            {
              tag_name: "v0.1.1",
              html_url: "https://github.com/ramphex/srtl-manager/releases/tag/v0.1.1",
              body: "First release notes",
              prerelease: false,
              draft: false
            }
          ]),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            {
              tag_name: "v0.1.2",
              html_url: "https://github.com/ramphex/srtl-manager/releases/tag/v0.1.2",
              body: "Second release notes",
              prerelease: false,
              draft: false
            }
          ]),
          { status: 200 }
        )
      );
    vi.stubGlobal("fetch", githubFetch);

    const first = await ctx.app.inject({ method: "GET", url: "/api/system/version?refresh=true", headers: { cookie } });
    const cached = await ctx.app.inject({ method: "GET", url: "/api/system/version", headers: { cookie } });
    const refreshed = await ctx.app.inject({ method: "GET", url: "/api/system/version?refresh=true", headers: { cookie } });

    expect(first.statusCode).toBe(200);
    expect(cached.statusCode).toBe(200);
    expect(refreshed.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ stable: { latestVersion: "0.1.1", releaseNotes: "First release notes" } });
    expect(cached.json()).toMatchObject({ stable: { latestVersion: "0.1.1", releaseNotes: "First release notes" } });
    expect(refreshed.json()).toMatchObject({ stable: { latestVersion: "0.1.2", releaseNotes: "Second release notes" } });
    expect(githubFetch).toHaveBeenCalledTimes(2);
  });

  it("returns inventory scan timestamps by scope", async () => {
    const cookie = await createAdminSession();
    await insertMediaLink("Timestamp Movie", "remote", "movies");
    await insertStorageFile("local", path.join("movies", "Timestamp Movie", "local.mkv"));
    await insertStorageFile("remote", path.join("remote-root", "remote.mkv"));

    const timestamps = await ctx.app.inject({ method: "GET", url: "/api/inventory/scan-timestamps", headers: { cookie } });

    expect(timestamps.statusCode).toBe(200);
    expect(timestamps.json()).toEqual({
      symlinkSections: { movies: expect.any(String) },
      localSections: { movies: expect.any(String) },
      remoteRoot: expect.any(String)
    });
  });

  it("queues one symlink scan job per selected folder when parallel scheduling is enabled", async () => {
    const cookie = await createAdminSession();
    const advanced = await ctx.app.inject({
      method: "PUT",
      url: "/api/settings/advanced",
      headers: { cookie },
      payload: {
        scan: { symlinkFolderScheduling: "per_folder" },
        copy: { profile: "balanced", byteCompare: true, mediaValidation: "fast" },
        audit: { defaultMode: "fast", byteCompareWhenSourceKnown: true }
      }
    });
    expect(advanced.statusCode).toBe(200);

    const scanPayload = {
      scanSymlinks: true,
      scanLocal: false,
      scanRemote: false,
      symlinkSections: ["movies", "shows"],
      localSections: []
    };
    const scan = await ctx.app.inject({ method: "POST", url: "/api/scans", headers: { cookie }, payload: scanPayload });
    expect(scan.statusCode).toBe(200);
    const { jobId, jobIds } = scan.json<{ jobId: number; jobIds: number[] }>();
    expect(jobIds).toHaveLength(2);
    expect(jobId).toBe(jobIds[0]);

    const jobs = await Promise.all(jobIds.map((id) => ctx.jobs.getJob(id)));
    expect(jobs).toEqual([
      expect.objectContaining({
        status: "queued",
        exclusive: false,
        progress: { options: { scanSymlinks: true, scanLocal: false, scanRemote: false, symlinkSections: ["movies"], localSections: [] } }
      }),
      expect.objectContaining({
        status: "queued",
        exclusive: false,
        progress: { options: { scanSymlinks: true, scanLocal: false, scanRemote: false, symlinkSections: ["shows"], localSections: [] } }
      })
    ]);
    const claims = await ctx.database.db.select().from(schema.jobResourceClaims).where(inArray(schema.jobResourceClaims.jobId, jobIds));
    expect(claims.map((claim) => [claim.resourceKey, claim.access]).sort()).toEqual([
      ["movies", "exclusive"],
      ["shows", "exclusive"]
    ]);

    const duplicate = await ctx.app.inject({ method: "POST", url: "/api/scans", headers: { cookie }, payload: scanPayload });
    expect(duplicate.statusCode).toBe(400);
    expect(duplicate.json()).toMatchObject({ error: expect.stringContaining("already has scan job") });
    expect((await ctx.jobs.listJobs()).filter((job) => job.type === "scan")).toHaveLength(2);
  });

  it("queues every selected symlink folder, local folder, and remote root as an independent scan job", async () => {
    const cookie = await createAdminSession();
    await setSetting(ctx.database.db, "advancedSettings", {
      scan: { symlinkFolderScheduling: "per_folder" },
      copy: { profile: "balanced", byteCompare: true, mediaValidation: "fast" },
      audit: { defaultMode: "fast", byteCompareWhenSourceKnown: true }
    });

    const scan = await ctx.app.inject({
      method: "POST",
      url: "/api/scans",
      headers: { cookie },
      payload: {
        scanSymlinks: true,
        scanLocal: true,
        scanRemote: true,
        symlinkSections: ["movies", "shows"],
        localSections: ["movies", "shows"]
      }
    });
    expect(scan.statusCode).toBe(200);
    const { jobIds } = scan.json<{ jobIds: number[] }>();
    expect(jobIds).toHaveLength(5);

    const jobs = await Promise.all(jobIds.map((id) => ctx.jobs.getJob(id)));
    expect(jobs).toEqual([
      expect.objectContaining({
        status: "queued",
        exclusive: false,
        progress: { options: { scanSymlinks: false, scanLocal: false, scanRemote: true, symlinkSections: [], localSections: [] } }
      }),
      expect.objectContaining({
        status: "queued",
        exclusive: false,
        progress: { options: { scanSymlinks: true, scanLocal: false, scanRemote: false, symlinkSections: ["movies"], localSections: [] } }
      }),
      expect.objectContaining({
        status: "queued",
        exclusive: false,
        progress: { options: { scanSymlinks: false, scanLocal: true, scanRemote: false, symlinkSections: [], localSections: ["movies"] } }
      }),
      expect.objectContaining({
        status: "queued",
        exclusive: false,
        progress: { options: { scanSymlinks: true, scanLocal: false, scanRemote: false, symlinkSections: ["shows"], localSections: [] } }
      }),
      expect.objectContaining({
        status: "queued",
        exclusive: false,
        progress: { options: { scanSymlinks: false, scanLocal: true, scanRemote: false, symlinkSections: [], localSections: ["shows"] } }
      })
    ]);

    const claims = await ctx.database.db.select().from(schema.jobResourceClaims).where(inArray(schema.jobResourceClaims.jobId, jobIds));
    expect(claims.map((claim) => [claim.resourceType, claim.resourceKey, claim.access]).sort()).toEqual([
      ["inventory_scope", JSON.stringify(["local", "movies"]), "exclusive"],
      ["inventory_scope", JSON.stringify(["local", "shows"]), "exclusive"],
      ["inventory_scope", JSON.stringify(["remote", "*"]), "exclusive"],
      ["section", "movies", "exclusive"],
      ["section", "shows", "exclusive"]
    ]);
  });

  it("returns inventory scan timestamps for empty scanned scopes", async () => {
    const cookie = await createAdminSession();
    const scan = await ctx.app.inject({
      method: "POST",
      url: "/api/scans",
      headers: { cookie },
      payload: { scanSymlinks: true, scanLocal: true, scanRemote: true, symlinkSections: ["shows"], localSections: ["shows"] }
    });

    expect(scan.statusCode).toBe(200);
    await expect(runQueuedJob(scan.json<{ jobId: number }>().jobId)).resolves.toMatchObject({ status: "completed" });

    const timestamps = await ctx.app.inject({ method: "GET", url: "/api/inventory/scan-timestamps", headers: { cookie } });

    expect(timestamps.statusCode).toBe(200);
    expect(timestamps.json()).toEqual({
      symlinkSections: { shows: expect.any(String) },
      localSections: { shows: expect.any(String) },
      remoteRoot: expect.any(String)
    });
  });

  it("keeps scan result totals scoped to the selected scan inputs", async () => {
    const cookie = await createAdminSession();
    await insertStorageFile("local", path.join("movies", "Already Local", "local.mkv"));
    await insertStorageFile("remote", path.join("movies", "Already Remote", "remote.mkv"));
    await fs.mkdir(path.join(tmpDir, "plex", "movies", "Scanned Link"), { recursive: true });
    const scannedTarget = path.join(tmpDir, "remote", "movies", "Scanned Link", "scanned-link.mkv");
    await fs.mkdir(path.dirname(scannedTarget), { recursive: true });
    await fs.writeFile(scannedTarget, "remote");
    await fs.symlink(scannedTarget, path.join(tmpDir, "plex", "movies", "Scanned Link", "scanned-link.mkv"));

    const scan = await ctx.app.inject({
      method: "POST",
      url: "/api/scans",
      headers: { cookie },
      payload: { scanSymlinks: true, scanLocal: false, scanRemote: false, symlinkSections: ["movies"], localSections: [] }
    });

    expect(scan.statusCode).toBe(200);
    const { jobId } = scan.json<{ jobId: number }>();
    const job = await runQueuedJob(jobId);
    expect(job).toMatchObject({
      status: "completed",
      progress: expect.objectContaining({
        stage: "completed",
        totalLinks: 1,
        remoteLinks: 1,
        localFiles: 0,
        remoteFiles: 0,
        localOrphanFiles: 0,
        remoteOrphanFiles: 0
      })
    });

    const history = await ctx.app.inject({ method: "GET", url: "/api/scans", headers: { cookie } });
    expect(history.statusCode).toBe(200);
    expect(history.json()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          jobId,
          totalLinks: 1,
          remoteLinks: 1,
          localFiles: 0,
          remoteFiles: 0,
          localOrphanFiles: 0,
          remoteOrphanFiles: 0
        })
      ])
    );

    const events = await ctx.jobs.listEvents(jobId);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: "Manual inventory scan indexed library links and storage files",
          data: expect.objectContaining({
            totalLinks: 1,
            remoteLinks: 1,
            localFiles: 0,
            remoteFiles: 0
          })
        })
      ])
    );

    const inventory = await ctx.app.inject({ method: "GET", url: "/api/inventory/summary", headers: { cookie } });
    expect(inventory.statusCode).toBe(200);
    expect(inventory.json()).toMatchObject({ totalLinks: 1, localFiles: 1, remoteFiles: 1 });
  });

  it("updates the authenticated admin username and password", async () => {
    const denied = await ctx.app.inject({
      method: "PUT",
      url: "/api/auth/user",
      payload: { username: "renamed", currentPassword: "password123" }
    });
    expect(denied.statusCode).toBe(401);

    const cookie = await createAdminSession();
    const secondLogin = await ctx.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "admin", password: "password123" }
    });
    expect(secondLogin.statusCode).toBe(200);
    const secondCookie = String(secondLogin.headers["set-cookie"]);
    const wrongPassword = await ctx.app.inject({
      method: "PUT",
      url: "/api/auth/user",
      headers: { cookie },
      payload: { username: "renamed", currentPassword: "wrong-password" }
    });
    expect(wrongPassword.statusCode).toBe(401);
    expect(wrongPassword.json()).toMatchObject({ error: "Current password is incorrect" });

    const mismatch = await ctx.app.inject({
      method: "PUT",
      url: "/api/auth/user",
      headers: { cookie },
      payload: { username: "renamed", currentPassword: "password123", newPassword: "newpassword123", confirmNewPassword: "different123" }
    });
    expect(mismatch.statusCode).toBe(400);
    expect(mismatch.json()).toMatchObject({ error: "Passwords do not match" });

    const shortPassword = await ctx.app.inject({
      method: "PUT",
      url: "/api/auth/user",
      headers: { cookie },
      payload: { username: "renamed", currentPassword: "password123", newPassword: "short", confirmNewPassword: "short" }
    });
    expect(shortPassword.statusCode).toBe(400);
    expect(shortPassword.json()).toMatchObject({ error: "Password must be at least 8 characters" });

    const update = await ctx.app.inject({
      method: "PUT",
      url: "/api/auth/user",
      headers: { cookie },
      payload: { username: "renamed", currentPassword: "password123", newPassword: "newpassword123", confirmNewPassword: "newpassword123" }
    });
    expect(update.statusCode).toBe(200);
    expect(update.json()).toMatchObject({ user: { username: "renamed" } });
    const rotatedCookie = String(update.headers["set-cookie"]);
    expect(rotatedCookie).toContain("srtl_session=");

    const me = await ctx.app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie: rotatedCookie } });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ authenticated: true, user: { username: "renamed" } });

    const revokedSession = await ctx.app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie: secondCookie } });
    expect(revokedSession.json()).toMatchObject({ authenticated: false, user: null });

    const oldLogin = await ctx.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "admin", password: "password123" }
    });
    expect(oldLogin.statusCode).toBe(401);

    const newLogin = await ctx.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "renamed", password: "newpassword123" }
    });
    expect(newLogin.statusCode).toBe(200);
  });

  it("does not present queued scans as failed scan history", async () => {
    const cookie = await createAdminSession();
    const scan = await ctx.app.inject({
      method: "POST",
      url: "/api/scans",
      headers: { cookie },
      payload: { scanSymlinks: true, scanLocal: false, scanRemote: false, symlinkSections: ["movies"] }
    });
    expect(scan.statusCode).toBe(200);
    const { jobId } = scan.json<{ jobId: number }>();

    const history = await ctx.app.inject({ method: "GET", url: "/api/scans", headers: { cookie } });
    expect(history.statusCode).toBe(200);
    expect(history.json<Array<{ jobId: number }>>()).not.toEqual(expect.arrayContaining([expect.objectContaining({ jobId })]));
  });

  it("returns active jobs and only terminal jobs inside the requested completion window", async () => {
    const cookie = await createAdminSession();
    const activeJobId = await ctx.jobs.createJob("scan");
    const recentJobId = await ctx.jobs.createJob("audit");
    const oldJobId = await ctx.jobs.createJob("copy");
    const now = new Date();
    const recentFinishedAt = new Date(now.getTime() - 5 * 60_000).toISOString();
    const oldFinishedAt = new Date(now.getTime() - 2 * 60 * 60_000).toISOString();
    await ctx.database.db.update(schema.jobs).set({ status: "completed", startedAt: recentFinishedAt, finishedAt: recentFinishedAt }).where(eq(schema.jobs.id, recentJobId));
    await ctx.database.db.update(schema.jobs).set({ status: "failed", startedAt: oldFinishedAt, finishedAt: oldFinishedAt }).where(eq(schema.jobs.id, oldJobId));

    const recent = await ctx.app.inject({ method: "GET", url: "/api/jobs?completedWithinMinutes=60", headers: { cookie } });
    expect(recent.statusCode).toBe(200);
    expect(recent.json<Array<{ id: number }>>()).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: activeJobId }), expect.objectContaining({ id: recentJobId })])
    );
    expect(recent.json<Array<{ id: number }>>()).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: oldJobId })]));

    const activeOnly = await ctx.app.inject({ method: "GET", url: "/api/jobs?activeOnly=true", headers: { cookie } });
    expect(activeOnly.statusCode).toBe(200);
    expect(activeOnly.json<Array<{ id: number }>>()).toEqual([expect.objectContaining({ id: activeJobId })]);
  });

  it("saves authenticated user preferences", async () => {
    const denied = await ctx.app.inject({ method: "GET", url: "/api/settings/user-preferences" });
    expect(denied.statusCode).toBe(401);

    const cookie = await createAdminSession();

    const defaults = await ctx.app.inject({ method: "GET", url: "/api/settings/user-preferences", headers: { cookie } });
    expect(defaults.statusCode).toBe(200);
    expect(defaults.json()).toEqual({ timeFormat: "12h", autoOpenTaskStatus: false, recentJobsCompletedWindowMinutes: 1440 });

    const saved = await ctx.app.inject({
      method: "PUT",
      url: "/api/settings/user-preferences",
      headers: { cookie },
      payload: { timeFormat: "24h", autoOpenTaskStatus: false, recentJobsCompletedWindowMinutes: 60 }
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toEqual({ timeFormat: "24h", autoOpenTaskStatus: false, recentJobsCompletedWindowMinutes: 60 });

    const persisted = await ctx.app.inject({ method: "GET", url: "/api/settings/user-preferences", headers: { cookie } });
    expect(persisted.statusCode).toBe(200);
    expect(persisted.json()).toEqual({ timeFormat: "24h", autoOpenTaskStatus: false, recentJobsCompletedWindowMinutes: 60 });

    const updatedAgain = await ctx.app.inject({
      method: "PUT",
      url: "/api/settings/user-preferences",
      headers: { cookie },
      payload: { timeFormat: "12h", autoOpenTaskStatus: true, recentJobsCompletedWindowMinutes: 360 }
    });
    expect(updatedAgain.statusCode).toBe(200);
    expect(updatedAgain.json()).toEqual({ timeFormat: "12h", autoOpenTaskStatus: true, recentJobsCompletedWindowMinutes: 360 });

    const invalid = await ctx.app.inject({
      method: "PUT",
      url: "/api/settings/user-preferences",
      headers: { cookie },
      payload: { timeFormat: "military" }
    });
    expect(invalid.statusCode).toBe(400);
  });

  it("runs broad audits against selected local folders and the remote root", async () => {
    const cookie = await createAdminSession();
    await insertMediaLink("Local Movie", "local", "movies");
    await insertMediaLink("Remote Movie", "remote", "movies");
    await insertMediaLink("Local Show", "local", "shows");
    await insertMediaLink("Remote Show", "remote", "shows");
    await insertMediaLink("Assigned Remote Local Title", "local", "movies", undefined, "location_2");

    const audit = await ctx.app.inject({
      method: "POST",
      url: "/api/audits",
      headers: { cookie },
      payload: { mode: "fast", sections: ["movies"] }
    });
    expect(audit.statusCode).toBe(200);
    const { jobId } = audit.json<{ jobId: number }>();
    await expect(runQueuedJob(jobId)).resolves.toMatchObject({
      status: "completed",
      progress: {
        options: { mode: "fast", sections: ["movies"], targets: ["local", "remote"] },
        checked: 4,
        total: 4,
        passed: 0,
        failed: 4
      }
    });

    const auditRun = await first(ctx.database.db.select().from(schema.auditRuns).where(eq(schema.auditRuns.jobId, jobId)).limit(1));
    expect(auditRun).toMatchObject({ status: "completed", checked: 4, failed: 4 });

    const results = await ctx.database.db.select().from(schema.auditResults);
    expect(results).toHaveLength(4);
    expect(results).toEqual(expect.arrayContaining([
      expect.objectContaining({
        auditRunId: auditRun?.id,
        linkPath: expect.stringContaining(path.join("plex", "movies")),
        message: "Media target is missing or unreadable"
      }),
      expect.objectContaining({
        auditRunId: auditRun?.id,
        linkPath: expect.stringContaining(path.join("plex", "movies")),
        message: "Media target is missing or unreadable"
      })
    ]));
    expect(results.map((result) => result.targetPath).sort()).toEqual([
      path.join(tmpDir, "local", "Assigned Remote Local Title", "assigned-remote-local-title.mkv"),
      path.join(tmpDir, "local", "Local Movie", "local-movie.mkv"),
      path.join(tmpDir, "remote", "Remote Movie", "remote-movie.mkv"),
      path.join(tmpDir, "remote", "Remote Show", "remote-show.mkv")
    ].sort());

    const firstResultPage = await ctx.app.inject({
      method: "GET",
      url: `/api/audits/${auditRun?.id}/results/page?attentionOnly=true&limit=2&offset=0`,
      headers: { cookie }
    });
    expect(firstResultPage.statusCode).toBe(200);
    expect(firstResultPage.json()).toMatchObject({ total: 4, offset: 0, hasMore: true });
    expect(firstResultPage.json().results).toHaveLength(2);
    const secondResultPage = await ctx.app.inject({
      method: "GET",
      url: `/api/audits/${auditRun?.id}/results/page?attentionOnly=true&limit=2&offset=2`,
      headers: { cookie }
    });
    expect(secondResultPage.json()).toMatchObject({ total: 4, offset: 2, hasMore: false });
    expect(secondResultPage.json().results).toHaveLength(2);

    const unknownFolder = await ctx.app.inject({
      method: "POST",
      url: "/api/audits",
      headers: { cookie },
      payload: { mode: "fast", sections: ["movies", "missing"] }
    });
    expect(unknownFolder.statusCode).toBe(400);
    expect(unknownFolder.json()).toMatchObject({ error: "Unknown audit folder: missing" });
  });

  it("runs broad remote audits without folder scope", async () => {
    const cookie = await createAdminSession();
    await insertMediaLink("Local Movie", "local", "movies");
    await insertMediaLink("Remote Movie", "remote", "movies");
    await insertMediaLink("Remote Show", "remote", "shows");

    const audit = await ctx.app.inject({
      method: "POST",
      url: "/api/audits",
      headers: { cookie },
      payload: { mode: "fast", targets: ["remote"] }
    });
    expect(audit.statusCode).toBe(200);
    const { jobId } = audit.json<{ jobId: number }>();
    await expect(runQueuedJob(jobId)).resolves.toMatchObject({
      status: "completed",
      progress: {
        options: { mode: "fast", targets: ["remote"] },
        checked: 2,
        total: 2,
        passed: 0,
        failed: 2
      }
    });

    const auditRun = await first(ctx.database.db.select().from(schema.auditRuns).where(eq(schema.auditRuns.jobId, jobId)).limit(1));
    expect(auditRun).toMatchObject({ status: "completed", checked: 2, failed: 2 });

    const results = await ctx.database.db.select().from(schema.auditResults);
    expect(results).toHaveLength(2);
    expect(results.map((result) => result.targetPath).sort()).toEqual([
      path.join(tmpDir, "remote", "Remote Movie", "remote-movie.mkv"),
      path.join(tmpDir, "remote", "Remote Show", "remote-show.mkv")
    ].sort());

  });

  it("applies advanced audit defaults to API-created audit jobs", async () => {
    const cookie = await createAdminSession();
    await insertMediaLink("Assigned Remote Local Movie", "local", "movies", undefined, "location_2");
    await insertMediaLink("Regular Local Movie", "local", "movies");

    const settings = await ctx.app.inject({
      method: "PUT",
      url: "/api/settings/advanced",
      headers: { cookie },
      payload: {
        copy: { profile: "balanced", byteCompare: true, mediaValidation: "fast" },
        audit: { defaultMode: "fast", byteCompareWhenSourceKnown: false }
      }
    });
    expect(settings.statusCode).toBe(200);

    const audit = await ctx.app.inject({
      method: "POST",
      url: "/api/audits",
      headers: { cookie },
      payload: { mode: "fast", sections: ["movies"] }
    });
    expect(audit.statusCode).toBe(200);
    const { jobId } = audit.json<{ jobId: number }>();
    await expect(runQueuedJob(jobId)).resolves.toMatchObject({
      status: "completed",
      progress: {
        options: { mode: "fast", sections: ["movies"], targets: ["local", "remote"], byteCompare: false },
        checked: 2,
        total: 2,
        passed: 0,
        failed: 2
      }
    });
  });

  it("retains disabled byte comparison in the audit job and audit history", async () => {
    const cookie = await createAdminSession();
    const fixture = await insertCopySymlink({ itemName: "No Compare Movie", kind: "local", storagePolicy: "unassigned" });
    await ctx.database.db.insert(schema.copySources).values({
      destinationPath: fixture.sourcePath,
      sourcePath: fixture.sourcePath,
      linkPath: fixture.linkPath,
      recordedAt: new Date().toISOString()
    });
    const auditRunner: AuditCommandRunner = {
      runFfmpeg: async () => ({ status: "pass", output: "" }),
      runCmp: async () => {
        throw new Error("byte compare should be disabled");
      }
    };

    const audit = await ctx.app.inject({
      method: "POST",
      url: "/api/audits",
      headers: { cookie },
      payload: { mode: "fast", linkIds: [fixture.id], byteCompare: false }
    });
    expect(audit.statusCode).toBe(200);
    const { jobId } = audit.json<{ jobId: number }>();
    await expect(runQueuedJob(jobId, { auditRunner })).resolves.toMatchObject({
      status: "completed",
      selection: { total: 1, titles: [{ section: "movies", itemName: "No Compare Movie", count: 1 }], unavailable: 0 },
      progress: expect.objectContaining({ options: { mode: "fast", byteCompare: false }, checked: 1, passed: 1 })
    });

    const history = await ctx.app.inject({ method: "GET", url: "/api/audits", headers: { cookie } });
    expect(history.statusCode).toBe(200);
    expect(history.json<Array<{ jobId: number; options: unknown }>>()).toEqual(
      expect.arrayContaining([expect.objectContaining({ jobId, options: { mode: "fast", byteCompare: false } })])
    );
    const directRun = await ctx.app.inject({ method: "GET", url: `/api/audits/job/${jobId}`, headers: { cookie } });
    expect(directRun.statusCode).toBe(200);
    expect(directRun.json()).toMatchObject({ jobId, options: { mode: "fast", byteCompare: false } });
    expect(await ctx.database.db.select().from(schema.auditResults)).toMatchObject([expect.objectContaining({ cmpStatus: "skipped", status: "pass" })]);
  });

  it("marks audit runs failed with an error message when the audit runner aborts", async () => {
    const cookie = await createAdminSession();
    const fixture = await insertCopySymlink({ itemName: "Runner Failure Movie", kind: "local", storagePolicy: "unassigned" });
    const auditRunner: AuditCommandRunner = {
      runFfmpeg: async () => {
        throw new Error("simulated ffmpeg runner failure");
      },
      runCmp: async () => ({ status: "pass", output: "" })
    };

    const audit = await ctx.app.inject({
      method: "POST",
      url: "/api/audits",
      headers: { cookie },
      payload: { mode: "fast", linkIds: [fixture.id] }
    });
    expect(audit.statusCode).toBe(200);
    const { jobId } = audit.json<{ jobId: number }>();
    await expect(runQueuedJob(jobId, { auditRunner })).resolves.toMatchObject({ status: "failed" });

    const auditRun = await first(ctx.database.db.select().from(schema.auditRuns).where(eq(schema.auditRuns.jobId, jobId)).limit(1));
    expect(auditRun).toMatchObject({ status: "failed", checked: 1, errorMessage: "simulated ffmpeg runner failure" });
  });

  it("records target validation failures separately from source comparison results", async () => {
    const cookie = await createAdminSession();
    const fixture = await insertCopySymlink({ itemName: "Validation Failure Movie", kind: "local", storagePolicy: "unassigned" });
    const auditRunner: AuditCommandRunner = {
      runFfmpeg: async () => ({ status: "fail", output: "simulated invalid media" }),
      runCmp: async () => ({ status: "pass", output: "" })
    };

    const audit = await ctx.app.inject({
      method: "POST",
      url: "/api/audits",
      headers: { cookie },
      payload: { mode: "fast", linkIds: [fixture.id] }
    });
    expect(audit.statusCode).toBe(200);
    const { jobId } = audit.json<{ jobId: number }>();
    await expect(runQueuedJob(jobId, { auditRunner })).resolves.toMatchObject({ status: "completed" });

    const auditRun = await first(ctx.database.db.select().from(schema.auditRuns).where(eq(schema.auditRuns.jobId, jobId)).limit(1));
    expect(auditRun).toMatchObject({ status: "completed", checked: 1, failed: 1, targetValidationFailures: 1, byteMismatches: 0 });
  });

  it("runs scoped audits against the selected current media links", async () => {
    const cookie = await createAdminSession();
    await insertMediaLink("Remote Scoped Movie", "remote", "movies");
    await insertMediaLink("Other Local Movie", "local", "movies");

    const remoteLink = await first(ctx.database.db.select().from(schema.mediaLinks).where(eq(schema.mediaLinks.itemName, "Remote Scoped Movie")).limit(1));
    expect(remoteLink).toBeDefined();

    const audit = await ctx.app.inject({
      method: "POST",
      url: "/api/audits",
      headers: { cookie },
      payload: { mode: "fast", linkIds: [remoteLink?.id] }
    });
    expect(audit.statusCode).toBe(200);
    const { jobId } = audit.json<{ jobId: number }>();
    const queuedAuditRow = await first(ctx.database.db.select().from(schema.jobs).where(eq(schema.jobs.id, jobId)).limit(1));
    expect(JSON.parse(queuedAuditRow?.options ?? "{}")).not.toHaveProperty("linkIds");
    expect(JSON.parse(queuedAuditRow?.progress ?? "{}")).not.toHaveProperty("options.linkIds");
    await expect(ctx.database.db.select().from(schema.jobSelectionItems).where(eq(schema.jobSelectionItems.jobId, jobId))).resolves.toMatchObject([
      expect.objectContaining({ mediaLinkId: remoteLink?.id, section: "movies", itemName: "Remote Scoped Movie", selectionOrder: 0 })
    ]);
    await expect(ctx.jobs.getJob(jobId)).resolves.toMatchObject({
      selection: { total: 1, unavailable: 0, titles: [{ section: "movies", itemName: "Remote Scoped Movie", count: 1 }], linkIds: [remoteLink?.id] }
    });
    await expect(runQueuedJob(jobId)).resolves.toMatchObject({
      status: "completed",
      progress: {
        options: { mode: "fast" },
        checked: 1,
        total: 1,
        passed: 0,
        failed: 1
      }
    });

    const auditRun = await first(ctx.database.db.select().from(schema.auditRuns).where(eq(schema.auditRuns.jobId, jobId)).limit(1));
    expect(auditRun).toMatchObject({ status: "completed", checked: 1, failed: 1 });
    expect(await ctx.database.db.select().from(schema.auditResults)).toMatchObject([
      expect.objectContaining({
        auditRunId: auditRun?.id,
        linkPath: remoteLink?.linkPath,
        targetPath: remoteLink?.targetPath,
        message: "Media target is missing or unreadable"
      })
    ]);
  });

  it("runs scoped audits against a title and relative path prefix", async () => {
    const cookie = await createAdminSession();
    await insertMediaLink("Scoped Show", "remote", "shows", path.join("Scoped Show", "Season 01", "episode-1.mkv"));
    await insertMediaLink("Scoped Show", "remote", "shows", path.join("Scoped Show", "Season 02", "episode-2.mkv"));

    const audit = await ctx.app.inject({
      method: "POST",
      url: "/api/audits",
      headers: { cookie },
      payload: { mode: "fast", section: "shows", itemName: "Scoped Show", relativePathPrefix: "Scoped Show/Season 01" }
    });
    expect(audit.statusCode).toBe(200);
    const { jobId } = audit.json<{ jobId: number }>();
    await expect(runQueuedJob(jobId)).resolves.toMatchObject({
      status: "completed",
      progress: {
        options: { mode: "fast", section: "shows", itemName: "Scoped Show", relativePathPrefix: "Scoped Show/Season 01" },
        checked: 1,
        total: 1,
        passed: 0,
        failed: 1
      }
    });

    const results = await ctx.database.db.select().from(schema.auditResults);
    expect(results).toHaveLength(1);
    expect(results[0]?.linkPath).toContain(path.join("Scoped Show", "Season 01", "episode-1.mkv"));
  });

  it("freezes scoped audit media when the job is queued", async () => {
    const firstFixture = await insertCopySymlink({
      itemName: "Frozen Audit Show",
      kind: "remote",
      storagePolicy: "unassigned",
      section: "shows",
      relativePath: path.join("Frozen Audit Show", "Season 01", "episode-1.mkv")
    });
    const jobId = await ctx.jobs.startAudit({ mode: "fast", section: "shows", itemName: "Frozen Audit Show" });
    const secondFixture = await insertCopySymlink({
      itemName: "Frozen Audit Show",
      kind: "remote",
      storagePolicy: "unassigned",
      section: "shows",
      relativePath: path.join("Frozen Audit Show", "Season 01", "episode-2.mkv")
    });
    const auditedPaths: string[] = [];
    const auditRunner: AuditCommandRunner = {
      runFfmpeg: async (_mode, targetPath) => {
        auditedPaths.push(targetPath);
        return { status: "pass", output: "" };
      },
      runCmp: async () => ({ status: "pass", output: "" })
    };

    await expect(runQueuedJob(jobId, { auditRunner })).resolves.toMatchObject({
      status: "completed",
      selection: expect.objectContaining({ total: 1 }),
      progress: expect.objectContaining({ options: expect.not.objectContaining({ linkIds: expect.anything() }), checked: 1, total: 1 })
    });
    expect(auditedPaths).toEqual([firstFixture.sourcePath]);
    expect(auditedPaths).not.toContain(secondFixture.sourcePath);
  });

  it("keeps an empty scoped audit empty when matching inventory appears later", async () => {
    const jobId = await ctx.jobs.startAudit({ mode: "fast", section: "shows", itemName: "Later Audit Show" });
    await insertCopySymlink({
      itemName: "Later Audit Show",
      kind: "remote",
      storagePolicy: "unassigned",
      section: "shows",
      relativePath: path.join("Later Audit Show", "Season 01", "episode-1.mkv")
    });
    let auditCalls = 0;
    const auditRunner: AuditCommandRunner = {
      runFfmpeg: async () => {
        auditCalls += 1;
        return { status: "pass", output: "" };
      },
      runCmp: async () => ({ status: "pass", output: "" })
    };

    await expect(runQueuedJob(jobId, { auditRunner })).resolves.toMatchObject({
      status: "completed",
      selection: { total: 0, titles: [], unavailable: 0 },
      progress: expect.objectContaining({ checked: 0, total: 0 })
    });
    expect(auditCalls).toBe(0);
  });

  it("copies assign-local remote symlinks to local storage with verification", async () => {
    const cookie = await createAdminSession();
    const fixture = await insertCopySymlink({ itemName: "Copy Local Movie", kind: "remote", storagePolicy: "location_1", content: "copy me local" });

    const copy = await ctx.app.inject({
      method: "POST",
      url: "/api/copies",
      headers: { cookie },
      payload: { direction: "to_local", linkIds: [fixture.id] }
    });

    expect(copy.statusCode).toBe(200);
    const { jobId } = copy.json<{ jobId: number }>();
    const job = await runQueuedJob(jobId, { copyRunner: testCopyRunner });
    expect(job).toMatchObject({
      status: "completed",
      progress: expect.objectContaining({
        current: 1,
        total: 1,
        copied: 1,
        repointed: 0,
        conflicts: 0,
        failed: 0,
        stage: "completed",
        currentTitle: null,
        currentFile: null,
        sourcePath: null,
        destinationPath: null,
        linkPath: null,
        sizeBytes: null,
        bytesCopied: null,
        bytesProcessed: null,
        totalBytes: null,
        bytesPerSecond: null,
        remainingSeconds: null,
        message: "Copy job finished"
      })
    });
    const events = await ctx.jobs.listEvents(jobId);
    expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ message: "Copying media", data: expect.objectContaining({ current: 1, total: 1, itemName: "Copy Local Movie" }) })]));
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: "Comparing source and destination bytes",
          data: expect.objectContaining({
            stage: "verifying",
            bytesProcessed: 0,
            totalBytes: Buffer.byteLength("copy me local")
          })
        }),
        expect.objectContaining({
          message: "Fast media validation",
          data: expect.objectContaining({
            stage: "verifying",
            bytesProcessed: 0
          })
        }),
        expect.objectContaining({
          message: "Promoting verified copy and repointing symlink",
          data: expect.objectContaining({
            stage: "symlinking",
            bytesPerSecond: null
          })
        })
      ])
    );

    const verifyProgressEvent = events.find((event) => event.message === "Comparing source and destination bytes");
    expect(verifyProgressEvent?.data).toEqual(
      expect.objectContaining({
        bytesCopied: null,
        bytesProcessed: 0,
        totalBytes: Buffer.byteLength("copy me local"),
        bytesPerSecond: 0
      })
    );

    await expect(fs.readFile(fixture.destinationPath, "utf8")).resolves.toBe("copy me local");
    await expect(fs.readlink(fixture.linkPath)).resolves.toBe(fixture.destinationPath);

    const link = await first(ctx.database.db.select().from(schema.mediaLinks).where(eq(schema.mediaLinks.id, fixture.id)).limit(1));
    expect(link).toMatchObject({ kind: "local", targetPath: fixture.destinationPath, storagePolicy: "location_1" });

    const source = await first(ctx.database.db.select().from(schema.copySources).where(eq(schema.copySources.destinationPath, fixture.destinationPath)).limit(1));
    expect(source).toMatchObject({ sourcePath: fixture.sourcePath, linkPath: fixture.linkPath });
    expect(copyFfmpegModes).toEqual(["fast"]);
  });

  it("reconciles a repointed copy journal after a worker interruption", async () => {
    const cookie = await createAdminSession();
    const fixture = await insertCopySymlink({ itemName: "Interrupted Copy", kind: "remote", storagePolicy: "location_1", content: "durable copy" });
    const copy = await ctx.app.inject({
      method: "POST",
      url: "/api/copies",
      headers: { cookie },
      payload: { direction: "to_local", linkIds: [fixture.id] }
    });
    expect(copy.statusCode).toBe(200);
    const { jobId } = copy.json<{ jobId: number }>();
    const originalLink = await first(ctx.database.db.select().from(schema.mediaLinks).where(eq(schema.mediaLinks.id, fixture.id)).limit(1));
    if (!originalLink) throw new Error("Copy fixture was not found");

    await fs.mkdir(path.dirname(fixture.destinationPath), { recursive: true });
    await fs.copyFile(fixture.sourcePath, fixture.destinationPath);
    await fs.rm(fixture.linkPath);
    await fs.symlink(fixture.destinationPath, fixture.linkPath);
    const sizeBytes = (await fs.stat(fixture.destinationPath)).size;
    const destinationIdentity = await readCopyFileIdentity(fixture.destinationPath);
    if (!destinationIdentity) throw new Error("Interrupted copy destination identity was not readable");
    const timestamp = new Date().toISOString();
    await ctx.database.db.insert(schema.copyOperations).values({
      jobId,
      mediaLinkId: fixture.id,
      linkPath: fixture.linkPath,
      sourcePath: fixture.sourcePath,
      destinationPath: fixture.destinationPath,
      originalTargetPath: fixture.sourcePath,
      originalLinkState: JSON.stringify(originalLink),
      previousCopySource: null,
      tempPath: null,
      displacedPath: null,
      tempIdentity: null,
      destinationIdentity: serializeCopyFileIdentity(destinationIdentity),
      displacedIdentity: null,
      stage: "repointed",
      resultStatus: "copied",
      localConflictStrategy: null,
      sizeBytes,
      errorMessage: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      completedAt: null
    });

    const job = await runQueuedJob(jobId, { copyRunner: testCopyRunner });
    expect(job).toMatchObject({ status: "completed", progress: expect.objectContaining({ copied: 1, total: 1 }) });
    expect(await first(ctx.database.db.select().from(schema.copyOperations).where(eq(schema.copyOperations.jobId, jobId)).limit(1))).toMatchObject({
      stage: "committed",
      resultStatus: "copied",
      completedAt: expect.any(String)
    });
    expect(await first(ctx.database.db.select().from(schema.mediaLinks).where(eq(schema.mediaLinks.id, fixture.id)).limit(1))).toMatchObject({
      kind: "local",
      targetPath: fixture.destinationPath
    });
    expect(await first(ctx.database.db.select().from(schema.copySources).where(eq(schema.copySources.destinationPath, fixture.destinationPath)).limit(1))).toMatchObject({
      sourcePath: fixture.sourcePath,
      linkPath: fixture.linkPath
    });
    expect(await ctx.jobs.listEvents(jobId)).toEqual(
      expect.arrayContaining([expect.objectContaining({ message: "Recovered copy operation after worker interruption" })])
    );
  });

  it("preserves an unowned replacement without locking a newly scanned link from the same title", async () => {
    const cookie = await createAdminSession();
    const fixture = await insertCopySymlink({ itemName: "Interrupted Identity Copy", kind: "remote", storagePolicy: "location_1", content: "durable copy" });
    const relatedFixture = await insertCopySymlink({
      itemName: "Interrupted Identity Copy",
      kind: "remote",
      storagePolicy: "location_1",
      relativePath: path.join("Interrupted Identity Copy", "related.mkv"),
      content: "related durable copy"
    });
    const jobId = await ctx.jobs.startCopy({ direction: "to_local", linkIds: [fixture.id] });
    const originalLink = await first(ctx.database.db.select().from(schema.mediaLinks).where(eq(schema.mediaLinks.id, fixture.id)).limit(1));
    if (!originalLink) throw new Error("Copy fixture was not found");

    await fs.mkdir(path.dirname(fixture.destinationPath), { recursive: true });
    await fs.copyFile(fixture.sourcePath, fixture.destinationPath);
    await fs.rm(fixture.linkPath);
    await fs.symlink(fixture.destinationPath, fixture.linkPath);
    const journaledIdentity = await readCopyFileIdentity(fixture.destinationPath);
    if (!journaledIdentity) throw new Error("Interrupted copy destination identity was not readable");
    const timestamp = new Date().toISOString();
    await ctx.database.db.insert(schema.copyOperations).values({
      jobId,
      mediaLinkId: fixture.id,
      linkPath: fixture.linkPath,
      sourcePath: fixture.sourcePath,
      destinationPath: fixture.destinationPath,
      originalTargetPath: fixture.sourcePath,
      originalLinkState: JSON.stringify(originalLink),
      previousCopySource: null,
      tempPath: null,
      displacedPath: null,
      tempIdentity: null,
      destinationIdentity: serializeCopyFileIdentity(journaledIdentity),
      displacedIdentity: null,
      stage: "repointed",
      resultStatus: "copied",
      localConflictStrategy: null,
      sizeBytes: Buffer.byteLength("durable copy"),
      errorMessage: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      completedAt: null
    });

    const replacementPath = `${fixture.destinationPath}.replacement`;
    await fs.writeFile(replacementPath, "foreign file");
    await fs.rename(replacementPath, fixture.destinationPath);

    await expect(runQueuedJob(jobId, { copyRunner: testCopyRunner })).resolves.toMatchObject({ status: "failed" });
    await expect(fs.readFile(fixture.destinationPath, "utf8")).resolves.toBe("foreign file");
    await expect(fs.readlink(fixture.linkPath)).resolves.toBe(fixture.destinationPath);
    await expect(first(ctx.database.db.select().from(schema.copyOperations).where(eq(schema.copyOperations.jobId, jobId)).limit(1))).resolves.toMatchObject({
      stage: "reconciliation_required",
      errorMessage: expect.stringContaining("changed after its file identity was journaled")
    });
    await expect(ctx.jobs.startCopy({ direction: "to_local", linkIds: [fixture.id] })).rejects.toThrow(
      `Copy data from job #${jobId} requires manual reconciliation`
    );
    await expect(ctx.jobs.startAudit({ mode: "fast", linkIds: [fixture.id], byteCompare: false })).rejects.toThrow(
      `Copy data from job #${jobId} requires manual reconciliation`
    );
    const relatedJobId = await ctx.jobs.startCopy({ direction: "to_local", linkIds: [relatedFixture.id] });
    await expect(ctx.jobs.getJob(relatedJobId)).resolves.toMatchObject({ status: "queued" });
    await expect(ctx.jobs.terminate(relatedJobId)).resolves.toBe(true);
    const policyMutation = await ctx.app.inject({
      method: "POST",
      url: "/api/storage-policies",
      headers: { cookie },
      payload: { title: "Interrupted Identity Copy", policy: "location_2" }
    });
    expect(policyMutation.statusCode).toBe(409);
    expect(policyMutation.json()).toMatchObject({ error: expect.stringContaining(`copy data from job #${jobId} requires manual reconciliation`) });
    const scanResponse = await ctx.app.inject({
      method: "POST",
      url: "/api/scans",
      headers: { cookie },
      payload: { scanSymlinks: true, scanLocal: false, scanRemote: false }
    });
    expect(scanResponse.statusCode).toBe(200);
    const scanJobId = Number(scanResponse.json().jobId);
    await expect(ctx.jobs.getJob(scanJobId)).resolves.toMatchObject({ status: "queued", exclusive: false });
    await expect(ctx.jobs.terminate(scanJobId)).resolves.toBe(true);
    const auditJobId = await ctx.jobs.startAudit("fast");
    await expect(ctx.jobs.getJob(auditJobId)).resolves.toMatchObject({ status: "queued", exclusive: true });
    await expect(ctx.jobs.terminate(auditJobId)).resolves.toBe(true);
  });

  it("requires reconciliation when an already-restored displaced destination has been replaced", async () => {
    const fixture = await insertCopySymlink({
      itemName: "Interrupted Displaced Restore",
      kind: "remote",
      storagePolicy: "location_1",
      content: "copy source payload"
    });
    const jobId = await ctx.jobs.startCopy({ direction: "to_local", linkIds: [fixture.id] });
    const originalLink = await first(ctx.database.db.select().from(schema.mediaLinks).where(eq(schema.mediaLinks.id, fixture.id)).limit(1));
    if (!originalLink) throw new Error("Displaced-restore copy fixture was not found");

    await fs.mkdir(path.dirname(fixture.destinationPath), { recursive: true });
    const displacedContents = "original local data";
    await fs.writeFile(fixture.destinationPath, displacedContents);
    const displacedIdentity = await readCopyFileIdentity(fixture.destinationPath);
    if (!displacedIdentity) throw new Error("Displaced destination identity was not readable");
    const displacedPath = `${fixture.destinationPath}.srtl-displaced`;
    const replacementPath = `${fixture.destinationPath}.replacement`;
    const replacementContents = "foreign local data!";
    expect(Buffer.byteLength(replacementContents)).toBe(Buffer.byteLength(displacedContents));
    await fs.writeFile(replacementPath, replacementContents);
    await fs.rename(replacementPath, fixture.destinationPath);

    const timestamp = new Date().toISOString();
    await ctx.database.db.insert(schema.copyOperations).values({
      jobId,
      mediaLinkId: fixture.id,
      linkPath: fixture.linkPath,
      sourcePath: fixture.sourcePath,
      destinationPath: fixture.destinationPath,
      originalTargetPath: fixture.sourcePath,
      originalLinkState: JSON.stringify(originalLink),
      previousCopySource: null,
      tempPath: null,
      displacedPath,
      tempIdentity: null,
      destinationIdentity: null,
      displacedIdentity: serializeCopyFileIdentity(displacedIdentity),
      stage: "destination_displaced",
      resultStatus: null,
      localConflictStrategy: "replace",
      sizeBytes: Buffer.byteLength("copy source payload"),
      errorMessage: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      completedAt: null
    });

    await expect(runQueuedJob(jobId, { copyRunner: testCopyRunner })).resolves.toMatchObject({ status: "failed" });
    await expect(fs.readFile(fixture.destinationPath, "utf8")).resolves.toBe(replacementContents);
    await expect(fs.readlink(fixture.linkPath)).resolves.toBe(fixture.sourcePath);
    await expect(first(ctx.database.db.select().from(schema.copyOperations).where(eq(schema.copyOperations.jobId, jobId)).limit(1))).resolves.toMatchObject({
      stage: "reconciliation_required",
      errorMessage: expect.stringContaining("Restored displaced destination changed after its file identity was journaled")
    });
  });

  it("auto-closes provably empty legacy reconciliation state without blocking related or retried media", async () => {
    const blockedFixture = await insertCopySymlink({ itemName: "Uncertain Legacy Movie", kind: "remote", storagePolicy: "location_1", content: "uncertain source" });
    const relatedFixture = await insertCopySymlink({ itemName: "Independent Legacy Movie", kind: "remote", storagePolicy: "location_1", content: "independent source" });
    const legacyJobId = await ctx.jobs.startCopy({ direction: "to_local", linkIds: [blockedFixture.id, relatedFixture.id] });
    const timestamp = new Date().toISOString();
    await ctx.database.db.update(schema.jobs).set({ status: "failed", finishedAt: timestamp }).where(eq(schema.jobs.id, legacyJobId));
    await insertCopyOperationFixture({
      jobId: legacyJobId,
      fixture: blockedFixture,
      stage: "reconciliation_required",
      errorMessage: "The first media item has unresolved filesystem state"
    });

    const relatedJobId = await ctx.jobs.startCopy({ direction: "to_local", linkIds: [relatedFixture.id] });
    await expect(ctx.jobs.getJob(relatedJobId)).resolves.toMatchObject({ status: "queued" });
    const retriedJobId = await ctx.jobs.startCopy({ direction: "to_local", linkIds: [blockedFixture.id] });
    await expect(ctx.jobs.getJob(retriedJobId)).resolves.toMatchObject({ status: "queued" });
    await expect(first(ctx.database.db.select().from(schema.copyOperations).where(eq(schema.copyOperations.jobId, legacyJobId)).limit(1))).resolves.toMatchObject({
      stage: "rolled_back",
      errorMessage: null
    });
    await expect(ctx.jobs.terminate(relatedJobId)).resolves.toBe(true);
    await expect(ctx.jobs.terminate(retriedJobId)).resolves.toBe(true);
  });

  it("preserves an unlinked legacy destination and returns it to normal copy conflict handling", async () => {
    const fixture = await insertCopySymlink({ itemName: "Legacy Destination Conflict", kind: "remote", storagePolicy: "location_1", content: "current remote source" });
    const legacyJobId = await ctx.jobs.createJob("copy");
    const timestamp = new Date().toISOString();
    await ctx.database.db.update(schema.jobs).set({ status: "failed", finishedAt: timestamp }).where(eq(schema.jobs.id, legacyJobId));
    await fs.mkdir(path.dirname(fixture.destinationPath), { recursive: true });
    await fs.writeFile(fixture.destinationPath, "preserved unowned destination");
    await insertCopyOperationFixture({
      jobId: legacyJobId,
      fixture,
      stage: "reconciliation_required",
      errorMessage: "Legacy destination ownership cannot be proven"
    });

    const retriedJobId = await ctx.jobs.startCopy({ direction: "to_local", linkIds: [fixture.id] });

    await expect(fs.readlink(fixture.linkPath)).resolves.toBe(fixture.sourcePath);
    await expect(fs.readFile(fixture.destinationPath, "utf8")).resolves.toBe("preserved unowned destination");
    const resolvedOperation = await first(ctx.database.db.select().from(schema.copyOperations).where(eq(schema.copyOperations.jobId, legacyJobId)).limit(1));
    expect(resolvedOperation).toMatchObject({
      stage: "failed",
      completedAt: expect.any(String),
      reconciliationResolvedAt: expect.any(String),
      errorMessage: expect.stringContaining("existing destination was left untouched for normal conflict handling")
    });
    await expect(ctx.jobs.getJob(retriedJobId)).resolves.toMatchObject({ status: "queued" });
    await expect(ctx.jobs.terminate(retriedJobId)).resolves.toBe(true);

    await reconcileEnvironmentPaths(ctx.database.db, {
      symlinkDir: path.join(tmpDir, "plex"),
      localDir: path.join(tmpDir, "local"),
      remoteDir: path.join(tmpDir, "remote")
    });

    await expect(first(ctx.database.db.select().from(schema.copyOperations).where(eq(schema.copyOperations.jobId, legacyJobId)).limit(1))).resolves.toMatchObject({
      stage: "failed",
      reconciliationResolvedAt: resolvedOperation?.reconciliationResolvedAt
    });
    const secondRetryJobId = await ctx.jobs.startCopy({ direction: "to_local", linkIds: [fixture.id] });
    await expect(ctx.jobs.getJob(secondRetryJobId)).resolves.toMatchObject({ status: "queued" });
    await expect(ctx.jobs.terminate(secondRetryJobId)).resolves.toBe(true);
  });

  it("does not let a stale local title item block new actionable copy work", async () => {
    const itemName = "Superseded Title Copy";
    const localFixture = await insertCopySymlink({
      itemName,
      kind: "local",
      storagePolicy: "location_1",
      section: "shows",
      relativePath: path.join(itemName, "Season 01", "episode-09.mkv"),
      content: "existing local episode"
    });
    const remoteFixture = await insertCopySymlink({
      itemName,
      kind: "remote",
      storagePolicy: "location_1",
      section: "shows",
      relativePath: path.join(itemName, "Season 01", "episode-10.mkv"),
      content: "new remote episode"
    });
    const legacyJobId = await ctx.jobs.createJob("copy");
    const timestamp = new Date().toISOString();
    await ctx.database.db.update(schema.jobs).set({ status: "failed", finishedAt: timestamp }).where(eq(schema.jobs.id, legacyJobId));
    await insertCopyOperationFixture({
      jobId: legacyJobId,
      fixture: localFixture,
      stage: "reconciliation_required",
      errorMessage: "Legacy local episode state is uncertain"
    });

    const copyJobId = await ctx.jobs.startCopy({ direction: "to_local", section: "shows", itemName });
    const mediaClaims = await ctx.database.db
      .select({ resourceKey: schema.jobResourceClaims.resourceKey })
      .from(schema.jobResourceClaims)
      .where(and(eq(schema.jobResourceClaims.jobId, copyJobId), eq(schema.jobResourceClaims.resourceType, "media")));
    expect(mediaClaims).toEqual([{ resourceKey: String(remoteFixture.id) }]);
    await expect(runQueuedJob(copyJobId, { copyRunner: testCopyRunner })).resolves.toMatchObject({
      status: "completed",
      progress: expect.objectContaining({ total: 1, copied: 1, skipped: 0, failed: 0 })
    });
    await expect(fs.readlink(localFixture.linkPath)).resolves.toBe(localFixture.sourcePath);
    await expect(fs.readlink(remoteFixture.linkPath)).resolves.toBe(remoteFixture.destinationPath);
  });

  it("ignores legacy reconciliation state superseded by a later committed copy", async () => {
    const cookie = await createAdminSession();
    const fixture = await insertCopySymlink({ itemName: "Later Commit Wins", kind: "remote", storagePolicy: "location_1", content: "later committed copy" });
    const legacyJobId = await ctx.jobs.createJob("copy");
    const legacyTimestamp = new Date().toISOString();
    await ctx.database.db.update(schema.jobs).set({ status: "failed", finishedAt: legacyTimestamp }).where(eq(schema.jobs.id, legacyJobId));
    const legacyOperationId = await insertCopyOperationFixture({
      jobId: legacyJobId,
      fixture,
      stage: "reconciliation_required",
      errorMessage: "Legacy copy ownership cannot be proven"
    });

    const committedJobId = await ctx.jobs.createJob("copy");
    const committedTimestamp = new Date().toISOString();
    await markCopyFixtureInstalled(committedJobId, fixture, committedTimestamp);
    const committedOperationId = await insertCopyOperationFixture({ jobId: committedJobId, fixture, stage: "committed", resultStatus: "copied" });
    await ctx.database.db.update(schema.jobs).set({ status: "completed", finishedAt: committedTimestamp }).where(eq(schema.jobs.id, committedJobId));
    expect(committedOperationId).toBeGreaterThan(legacyOperationId);

    const policyMutation = await ctx.app.inject({
      method: "POST",
      url: "/api/storage-policies",
      headers: { cookie },
      payload: { title: "Later Commit Wins", policy: "location_2" }
    });
    expect(policyMutation.statusCode).toBe(200);
    expect(policyMutation.json()).toMatchObject({ title: "Later Commit Wins", policy: "location_2" });
  });

  it("rejects duplicate copy jobs while matching media is already queued", async () => {
    const cookie = await createAdminSession();
    const fixture = await insertCopySymlink({ itemName: "Duplicate Queue Movie", kind: "remote", storagePolicy: "location_1", content: "copy once" });

    const firstCopy = await ctx.app.inject({
      method: "POST",
      url: "/api/copies",
      headers: { cookie },
      payload: { direction: "to_local", linkIds: [fixture.id] }
    });
    expect(firstCopy.statusCode).toBe(200);

    const duplicateCopy = await ctx.app.inject({
      method: "POST",
      url: "/api/copies",
      headers: { cookie },
      payload: { direction: "to_local", linkIds: [fixture.id] }
    });

    expect(duplicateCopy.statusCode).toBe(400);
    expect(duplicateCopy.json()).toMatchObject({ error: expect.stringContaining("already queued") });
    expect((await ctx.jobs.listJobs()).filter((job) => job.type === "copy")).toHaveLength(1);
  });

  it("serializes concurrent duplicate job admission", async () => {
    const fixture = await insertCopySymlink({ itemName: "Atomic Duplicate Movie", kind: "remote", storagePolicy: "location_1", content: "copy once atomically" });

    const results = await Promise.allSettled([
      ctx.jobs.startCopy({ direction: "to_local", linkIds: [fixture.id] }),
      ctx.jobs.startCopy({ direction: "to_local", linkIds: [fixture.id] })
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    expect(rejected?.reason).toBeInstanceOf(Error);
    expect(rejected?.reason).toMatchObject({ message: expect.stringContaining("already queued") });
    expect((await ctx.jobs.listJobs()).filter((job) => job.type === "copy")).toHaveLength(1);
    expect(await ctx.database.db.select().from(schema.jobResourceClaims)).not.toHaveLength(0);
  });

  it("keeps active copy claims immutable when the inventory row changes", async () => {
    const fixture = await insertCopySymlink({ itemName: "Immutable Claim Movie", kind: "remote", storagePolicy: "location_1", content: "claim snapshot" });
    const jobId = await ctx.jobs.startCopy({ direction: "to_local", linkIds: [fixture.id] });
    await ctx.database.db
      .update(schema.mediaLinks)
      .set({ kind: "local", targetPath: fixture.destinationPath, updatedAt: new Date().toISOString() })
      .where(eq(schema.mediaLinks.id, fixture.id));

    await expect(ctx.jobs.startCopy({ direction: "to_local", linkIds: [fixture.id] })).rejects.toThrow(`Job #${jobId} is already queued`);
    expect((await ctx.jobs.listJobs()).filter((job) => job.type === "copy")).toHaveLength(1);
  });

  it("queues targeted title rescans and blocks overlapping title actions", async () => {
    const cookie = await createAdminSession();
    const fixture = await insertCopySymlink({ itemName: "Targeted Rescan Movie", kind: "remote", storagePolicy: "location_1", content: "rescan me" });
    const payload = {
      scanSymlinks: true,
      scanLocal: false,
      scanRemote: false,
      symlinkSections: ["movies"],
      localSections: [],
      titleScopes: [{ section: "movies", itemName: "Targeted Rescan Movie" }]
    };

    const rescan = await ctx.app.inject({ method: "POST", url: "/api/scans", headers: { cookie }, payload });
    expect(rescan.statusCode).toBe(200);
    const rescanJobId = rescan.json<{ jobId: number }>().jobId;
    expect(await ctx.jobs.getJob(rescanJobId)).toMatchObject({ status: "queued", progress: { options: payload } });

    const duplicateRescan = await ctx.app.inject({ method: "POST", url: "/api/scans", headers: { cookie }, payload });
    expect(duplicateRescan.statusCode).toBe(400);
    expect(duplicateRescan.json()).toMatchObject({ error: expect.stringContaining(`Job #${rescanJobId} is already queued`) });

    const copy = await ctx.app.inject({
      method: "POST",
      url: "/api/copies",
      headers: { cookie },
      payload: { direction: "to_local", linkIds: [fixture.id] }
    });
    expect(copy.statusCode).toBe(400);
    expect(copy.json()).toMatchObject({ error: expect.stringContaining(`Job #${rescanJobId} is already queued`) });
  });

  it("rejects unsafe or mixed title rescan scopes", async () => {
    const cookie = await createAdminSession();

    const unsafeTitle = await ctx.app.inject({
      method: "POST",
      url: "/api/scans",
      headers: { cookie },
      payload: {
        scanSymlinks: true,
        scanLocal: false,
        scanRemote: false,
        titleScopes: [{ section: "movies", itemName: "../outside" }]
      }
    });
    expect(unsafeTitle.statusCode).toBe(400);

    const mixedScope = await ctx.app.inject({
      method: "POST",
      url: "/api/scans",
      headers: { cookie },
      payload: {
        scanSymlinks: true,
        scanLocal: true,
        scanRemote: false,
        titleScopes: [{ section: "movies", itemName: "Targeted Rescan Movie" }]
      }
    });
    expect(mixedScope.statusCode).toBe(400);
    expect(mixedScope.json()).toMatchObject({ error: expect.any(String) });
  });

  it("rejects audits that overlap an active copy job", async () => {
    const cookie = await createAdminSession();
    const fixture = await insertCopySymlink({ itemName: "Copy Audit Lock Movie", kind: "remote", storagePolicy: "location_1", content: "copy then audit" });
    const copyJobId = await ctx.jobs.startCopy({ direction: "to_local", linkIds: [fixture.id] });

    const audit = await ctx.app.inject({
      method: "POST",
      url: "/api/audits",
      headers: { cookie },
      payload: { mode: "fast", linkIds: [fixture.id] }
    });

    expect(audit.statusCode).toBe(400);
    expect(audit.json()).toMatchObject({ error: expect.stringContaining(`Job #${copyJobId} is already queued`) });
    expect((await ctx.jobs.listJobs()).filter((job) => job.type === "audit")).toHaveLength(0);
  });

  it("allows overlapping scoped audits to share read-only claims", async () => {
    const fixture = await insertCopySymlink({ itemName: "Shared Audit Movie", kind: "remote", storagePolicy: "location_1", content: "audit together" });

    const jobIds = await Promise.all([
      ctx.jobs.startAudit({ mode: "fast", linkIds: [fixture.id] }),
      ctx.jobs.startAudit({ mode: "deep", linkIds: [fixture.id] })
    ]);

    expect(jobIds[0]).not.toBe(jobIds[1]);
    const jobs = await Promise.all(jobIds.map((jobId) => ctx.jobs.getJob(jobId)));
    expect(jobs).toEqual([expect.objectContaining({ status: "queued", exclusive: false }), expect.objectContaining({ status: "queued", exclusive: false })]);
    const claims = await ctx.database.db.select().from(schema.jobResourceClaims).where(inArray(schema.jobResourceClaims.jobId, jobIds));
    expect(claims).not.toHaveLength(0);
    expect(claims.every((claim) => claim.access === "shared")).toBe(true);
  });

  it("uses advanced copy verification settings when copying media", async () => {
    const cookie = await createAdminSession();
    const fixture = await insertCopySymlink({ itemName: "Deep Verify Movie", kind: "remote", storagePolicy: "location_1", content: "copy me deeply" });

    const settings = await ctx.app.inject({
      method: "PUT",
      url: "/api/settings/advanced",
      headers: { cookie },
      payload: {
        copy: { profile: "deep", byteCompare: true, mediaValidation: "deep" },
        audit: { defaultMode: "fast", byteCompareWhenSourceKnown: true }
      }
    });
    expect(settings.statusCode).toBe(200);

    const copy = await ctx.app.inject({
      method: "POST",
      url: "/api/copies",
      headers: { cookie },
      payload: { direction: "to_local", linkIds: [fixture.id] }
    });
    expect(copy.statusCode).toBe(200);
    const { jobId } = copy.json<{ jobId: number }>();
    await expect(runQueuedJob(jobId, { copyRunner: testCopyRunner })).resolves.toMatchObject({
      status: "completed",
      progress: expect.objectContaining({ copied: 1, failed: 0 })
    });
    expect(copyFfmpegModes).toEqual(["deep"]);
  });

  it("freezes copy verification settings when a job is queued", async () => {
    const cookie = await createAdminSession();
    const fixture = await insertCopySymlink({ itemName: "Frozen Verify Movie", kind: "remote", storagePolicy: "location_1", content: "copy with queued settings" });
    const jobId = await ctx.jobs.startCopy({ direction: "to_local", linkIds: [fixture.id] });

    const settings = await ctx.app.inject({
      method: "PUT",
      url: "/api/settings/advanced",
      headers: { cookie },
      payload: {
        copy: { profile: "off", byteCompare: false, mediaValidation: "off" },
        audit: { defaultMode: "fast", byteCompareWhenSourceKnown: true }
      }
    });
    expect(settings.statusCode).toBe(200);

    await expect(runQueuedJob(jobId, { copyRunner: testCopyRunner })).resolves.toMatchObject({
      status: "completed",
      options: expect.objectContaining({ behavior: { profile: "balanced", byteCompare: true, mediaValidation: "fast" } }),
      progress: expect.objectContaining({ copied: 1, failed: 0 })
    });
    expect(copyCmpCalls).toBe(1);
    expect(copyFfmpegModes).toEqual(["fast"]);
  });

  it("copies with verification disabled while retaining guarded transfer and promotion", async () => {
    const cookie = await createAdminSession();
    const fixture = await insertCopySymlink({ itemName: "No Verify Movie", kind: "remote", storagePolicy: "location_1", content: "copy without content verification" });

    const settings = await ctx.app.inject({
      method: "PUT",
      url: "/api/settings/advanced",
      headers: { cookie },
      payload: {
        copy: { profile: "off", byteCompare: false, mediaValidation: "off" },
        audit: { defaultMode: "fast", byteCompareWhenSourceKnown: true }
      }
    });
    expect(settings.statusCode).toBe(200);

    const copy = await ctx.app.inject({
      method: "POST",
      url: "/api/copies",
      headers: { cookie },
      payload: { direction: "to_local", linkIds: [fixture.id] }
    });
    expect(copy.statusCode).toBe(200);
    const { jobId } = copy.json<{ jobId: number }>();
    await expect(runQueuedJob(jobId, { copyRunner: testCopyRunner })).resolves.toMatchObject({
      status: "completed",
      progress: expect.objectContaining({ copied: 1, failed: 0 })
    });

    expect(copyCmpCalls).toBe(0);
    expect(copyFfmpegModes).toEqual([]);
    await expect(fs.readFile(fixture.destinationPath, "utf8")).resolves.toBe("copy without content verification");
    await expect(fs.readlink(fixture.linkPath)).resolves.toBe(fixture.destinationPath);
    await expect(ctx.jobs.listEvents(jobId)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: "Copy installed without verification",
          data: expect.objectContaining({ itemName: "No Verify Movie" })
        })
      ])
    );
  });

  it("blocks copy before transfer when the source name does not match the expected title", async () => {
    const cookie = await createAdminSession();
    const fixture = await insertCopySymlink({
      itemName: "Mother Jugs and Speed (1976)",
      kind: "remote",
      storagePolicy: "location_1",
      relativePath: path.join("Mother Jugs and Speed (1976)", "Mother Jugs and Speed (1976).mkv"),
      sourceRelativePath: path.join("[1+7] - Crash.1976.UNCUT.1080p", "[1+7] - Crash.1976.UNCUT.1080p.mkv"),
      content: "wrong but valid media"
    });

    const preview = await ctx.app.inject({
      method: "POST",
      url: "/api/copies/conflicts",
      headers: { cookie },
      payload: { direction: "to_local", linkIds: [fixture.id] }
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toMatchObject({
      totalSourceTitleBlocks: 1,
      sourceTitleRisks: [expect.objectContaining({ linkId: fixture.id, itemName: "Mother Jugs and Speed (1976)" })]
    });

    const copy = await ctx.app.inject({
      method: "POST",
      url: "/api/copies",
      headers: { cookie },
      payload: { direction: "to_local", linkIds: [fixture.id] }
    });

    expect(copy.statusCode).toBe(200);
    const { jobId } = copy.json<{ jobId: number }>();
    await expect(runQueuedJob(jobId, { copyRunner: testCopyRunner })).resolves.toMatchObject({
      status: "completed",
      progress: expect.objectContaining({
        copied: 0,
        repointed: 0,
        conflicts: 1,
        failed: 0,
        stage: "completed",
        message: "Copy job finished"
      })
    });

    await expect(ctx.jobs.listEvents(jobId)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: "warn",
          message: "Source title mismatch blocked copy",
          data: expect.objectContaining({
            itemName: "Mother Jugs and Speed (1976)",
            risk: expect.objectContaining({ severity: "block", sourceName: "[1+7] - Crash.1976.UNCUT.1080p" })
          })
        })
      ])
    );
    await expect(fs.stat(fixture.destinationPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.readlink(fixture.linkPath)).resolves.toBe(fixture.sourcePath);
    expect(copyFfmpegModes).toEqual([]);

    const override = await ctx.app.inject({
      method: "POST",
      url: "/api/copies",
      headers: { cookie },
      payload: { direction: "to_local", linkIds: [fixture.id], allowSourceTitleMismatch: true }
    });
    expect(override.statusCode).toBe(200);
    const overrideJobId = override.json<{ jobId: number }>().jobId;
    await expect(runQueuedJob(overrideJobId, { copyRunner: testCopyRunner })).resolves.toMatchObject({
      status: "completed",
      progress: expect.objectContaining({ copied: 1, conflicts: 0, failed: 0 })
    });
    await expect(ctx.jobs.listEvents(overrideJobId)).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ level: "warn", message: "Source title mismatch override accepted" })])
    );
    await expect(fs.readFile(fixture.destinationPath, "utf8")).resolves.toBe("wrong but valid media");
  });

  it("copies assign-remote local symlinks to remote storage with verification", async () => {
    const cookie = await createAdminSession();
    const fixture = await insertCopySymlink({ itemName: "Copy Remote Movie", kind: "local", storagePolicy: "location_2", content: "copy me remote" });

    const copy = await ctx.app.inject({
      method: "POST",
      url: "/api/copies",
      headers: { cookie },
      payload: { direction: "to_remote", section: "movies", itemName: "Copy Remote Movie" }
    });

    expect(copy.statusCode).toBe(200);
    const { jobId } = copy.json<{ jobId: number }>();
    await expect(runQueuedJob(jobId, { copyRunner: testCopyRunner })).resolves.toMatchObject({
      status: "completed",
      progress: expect.objectContaining({ copied: 1, repointed: 0, conflicts: 0, failed: 0 })
    });

    await expect(fs.readFile(fixture.destinationPath, "utf8")).resolves.toBe("copy me remote");
    await expect(fs.readlink(fixture.linkPath)).resolves.toBe(fixture.destinationPath);

    const link = await first(ctx.database.db.select().from(schema.mediaLinks).where(eq(schema.mediaLinks.id, fixture.id)).limit(1));
    expect(link).toMatchObject({ kind: "remote", targetPath: fixture.destinationPath, storagePolicy: "location_2" });
  });

  it("copies only matching title links inside a relative path prefix", async () => {
    const cookie = await createAdminSession();
    const scoped = await insertCopySymlink({
      itemName: "Scoped Copy Title",
      kind: "remote",
      storagePolicy: "location_1",
      relativePath: path.join("Scoped Copy Title", "Season 01", "episode-1.mkv"),
      content: "copy scoped title"
    });
    const sibling = await insertCopySymlink({
      itemName: "Scoped Copy Title",
      kind: "remote",
      storagePolicy: "location_1",
      relativePath: path.join("Scoped Copy Title", "Season 02", "episode-2.mkv"),
      content: "leave sibling remote"
    });

    const copy = await ctx.app.inject({
      method: "POST",
      url: "/api/copies",
      headers: { cookie },
      payload: { direction: "to_local", section: "movies", itemName: "Scoped Copy Title", relativePathPrefix: path.join("Scoped Copy Title", "Season 01") }
    });

    expect(copy.statusCode).toBe(200);
    const { jobId } = copy.json<{ jobId: number }>();
    await expect(runQueuedJob(jobId, { copyRunner: testCopyRunner })).resolves.toMatchObject({
      status: "completed",
      progress: expect.objectContaining({
        options: expect.objectContaining({ section: "movies", itemName: "Scoped Copy Title", relativePathPrefix: "Scoped Copy Title/Season 01" }),
        copied: 1,
        conflicts: 0,
        failed: 0
      })
    });

    await expect(fs.readFile(scoped.destinationPath, "utf8")).resolves.toBe("copy scoped title");
    await expect(fs.stat(sibling.destinationPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.readlink(scoped.linkPath)).resolves.toBe(scoped.destinationPath);
    await expect(fs.readlink(sibling.linkPath)).resolves.toBe(sibling.sourcePath);

    const rows = await ctx.database.db.select().from(schema.mediaLinks).where(eq(schema.mediaLinks.itemName, "Scoped Copy Title"));
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: scoped.id, kind: "local", targetPath: scoped.destinationPath }),
        expect.objectContaining({ id: sibling.id, kind: "remote", targetPath: sibling.sourcePath })
      ])
    );
  });

  it("copies only links that still require attention inside a scoped title", async () => {
    const cookie = await createAdminSession();
    const needsCopy = await insertCopySymlink({
      itemName: "Scoped Copy Show",
      kind: "remote",
      storagePolicy: "location_1",
      section: "shows",
      relativePath: path.join("Scoped Copy Show", "Season 01", "episode-1.mkv"),
      content: "copy this episode"
    });
    const alreadyLocal = await insertCopySymlink({
      itemName: "Scoped Copy Show",
      kind: "local",
      storagePolicy: "location_1",
      section: "shows",
      relativePath: path.join("Scoped Copy Show", "Season 01", "episode-2.mkv"),
      content: "already local episode"
    });
    const assignedRemote = await insertCopySymlink({
      itemName: "Scoped Copy Show",
      kind: "remote",
      storagePolicy: "location_2",
      section: "shows",
      relativePath: path.join("Scoped Copy Show", "Season 01", "episode-3.mkv"),
      content: "assigned remote episode"
    });
    const unassigned = await insertCopySymlink({
      itemName: "Scoped Copy Show",
      kind: "remote",
      storagePolicy: "unassigned",
      section: "shows",
      relativePath: path.join("Scoped Copy Show", "Season 01", "episode-4.mkv"),
      content: "unassigned episode"
    });

    const copy = await ctx.app.inject({
      method: "POST",
      url: "/api/copies",
      headers: { cookie },
      payload: { direction: "to_local", section: "shows", itemName: "Scoped Copy Show", relativePathPrefix: path.join("Scoped Copy Show", "Season 01") }
    });

    expect(copy.statusCode).toBe(200);
    const { jobId } = copy.json<{ jobId: number }>();
    await expect(runQueuedJob(jobId, { copyRunner: testCopyRunner })).resolves.toMatchObject({
      status: "completed",
      progress: expect.objectContaining({
        options: expect.objectContaining({
          direction: "to_local",
          section: "shows",
          itemName: "Scoped Copy Show",
          relativePathPrefix: "Scoped Copy Show/Season 01"
        }),
        current: 1,
        total: 1,
        copied: 1,
        skipped: 0,
        alreadyCompleted: 0,
        conflicts: 0,
        failed: 0
      })
    });

    await expect(fs.readFile(needsCopy.destinationPath, "utf8")).resolves.toBe("copy this episode");
    await expect(fs.readlink(needsCopy.linkPath)).resolves.toBe(needsCopy.destinationPath);
    await expect(fs.readlink(alreadyLocal.linkPath)).resolves.toBe(alreadyLocal.sourcePath);
    await expect(fs.stat(alreadyLocal.destinationPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.readlink(assignedRemote.linkPath)).resolves.toBe(assignedRemote.sourcePath);
    await expect(fs.stat(assignedRemote.destinationPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.readlink(unassigned.linkPath)).resolves.toBe(unassigned.sourcePath);
    await expect(fs.stat(unassigned.destinationPath)).rejects.toMatchObject({ code: "ENOENT" });

    const rows = await ctx.database.db.select().from(schema.mediaLinks).where(eq(schema.mediaLinks.itemName, "Scoped Copy Show"));
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: needsCopy.id, kind: "local", targetPath: needsCopy.destinationPath }),
        expect.objectContaining({ id: alreadyLocal.id, kind: "local", targetPath: alreadyLocal.sourcePath }),
        expect.objectContaining({ id: assignedRemote.id, kind: "remote", targetPath: assignedRemote.sourcePath, storagePolicy: "location_2" }),
        expect.objectContaining({ id: unassigned.id, kind: "remote", targetPath: unassigned.sourcePath, storagePolicy: "unassigned" })
      ])
    );
  });

  it("keeps an empty scoped copy empty when matching inventory appears later", async () => {
    const jobId = await ctx.jobs.startCopy({ direction: "to_local", section: "movies", itemName: "Later Copy Movie" });
    const laterFixture = await insertCopySymlink({
      itemName: "Later Copy Movie",
      kind: "remote",
      storagePolicy: "location_1",
      content: "must wait for a newly queued copy"
    });

    await expect(runQueuedJob(jobId, { copyRunner: testCopyRunner })).resolves.toMatchObject({
      status: "completed",
      selection: { total: 0, titles: [], unavailable: 0 },
      progress: expect.objectContaining({
        current: 0,
        total: 0,
        copied: 0,
        failed: 0,
        message: "No matching media found"
      })
    });
    await expect(fs.stat(laterFixture.destinationPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.readlink(laterFixture.linkPath)).resolves.toBe(laterFixture.sourcePath);
  });

  it("bounds large immutable-selection metadata without changing the selected total", async () => {
    const timestamp = new Date().toISOString();
    const job = await first(
      ctx.database.db
        .insert(schema.jobs)
        .values({
          type: "copy",
          status: "queued",
          createdAt: timestamp,
          options: JSON.stringify({ direction: "to_local" }),
          selectionFrozen: true,
          progress: "{}"
        })
        .returning({ id: schema.jobs.id })
    );
    if (!job) throw new Error("Large selection job was not inserted");
    await ctx.database.pool.query(
      `
        INSERT INTO job_selection_items (
          job_id, media_link_id, selection_order, section, item_name, relative_path, link_path, created_at
        )
        SELECT $1,
               value,
               value - 1,
               'shows',
               'Large title ' || lpad(value::text, 4, '0'),
               'Large title ' || value || '/episode.mkv',
               '/links/Large title ' || value || '/episode.mkv',
               $2
        FROM generate_series(1, 1001) AS value
      `,
      [job.id, timestamp]
    );

    const record = await ctx.jobs.getJob(job.id);
    expect(record?.selection).toMatchObject({ total: 1001, unavailable: 0, omittedTitles: 901 });
    expect(record?.selection?.titles).toHaveLength(100);
    expect(record?.selection?.linkIds).toBeUndefined();
  });

  it("resumes stale copy jobs without shrinking the original selected total", async () => {
    const fixtures = await Promise.all([
      insertCopySymlink({ itemName: "Resume Copy One", kind: "remote", storagePolicy: "location_1", content: "resume one" }),
      insertCopySymlink({ itemName: "Resume Copy Two", kind: "remote", storagePolicy: "location_1", content: "resume two" }),
      insertCopySymlink({ itemName: "Resume Copy Three", kind: "remote", storagePolicy: "location_1", content: "resume three" })
    ]);
    const linkIds = fixtures.map((fixture) => fixture.id);
    const jobId = await ctx.jobs.startCopy({ direction: "to_local", linkIds });
    await expect(ctx.jobs.getJob(jobId)).resolves.toMatchObject({
      selection: expect.objectContaining({ total: 3, linkIds }),
      progress: expect.objectContaining({ options: expect.objectContaining({ direction: "to_local" }) })
    });

    const staleStartedAt = new Date(Date.now() - 30 * 60_000).toISOString();
    await ctx.database.db
      .update(schema.jobs)
      .set({
        status: "running",
        startedAt: staleStartedAt,
        lockedBy: "dead-copy-worker",
        lockedAt: staleStartedAt,
        heartbeatAt: staleStartedAt,
        progress: JSON.stringify({
          options: { direction: "to_local", linkIds },
          current: 1,
          total: 3,
          copied: 1,
          repointed: 0,
          skipped: 0,
          conflicts: 0,
          failed: 0,
          stage: "copying"
        })
      })
      .where(eq(schema.jobs.id, jobId));
    await ctx.database.db.insert(schema.jobEvents).values({
      jobId,
      timestamp: staleStartedAt,
      level: "info",
      message: "Copy job started",
      data: JSON.stringify({ options: { direction: "to_local", linkIds }, total: 3, remaining: 3 })
    });
    await markCopyFixtureInstalled(jobId, fixtures[0], staleStartedAt);

    const worker = new JobWorker(ctx.database.db, {
      workerId: "resume-copy-worker",
      reclaimStaleAfterMs: 1,
      pollIntervalMs: 1,
      heartbeatIntervalMs: 10,
      logger: silentLogger,
      copyRunner: testCopyRunner
    });
    expect(await worker.runOnce()).toBe(true);

    await expect(ctx.jobs.getJob(jobId)).resolves.toMatchObject({
      status: "completed",
      progress: expect.objectContaining({
        current: 3,
        total: 3,
        copied: 3,
        repointed: 0,
        skipped: 0,
        conflicts: 0,
        failed: 0,
        stage: "completed",
        message: "Copy job finished"
      })
    });

    const events = await ctx.jobs.listEvents(jobId);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ message: "Stale running job lease fenced and requeued" }),
        expect.objectContaining({
          message: "Copy job resumed",
          data: expect.objectContaining({ total: 3, remaining: 2, copied: 1, alreadyCompleted: 1 })
        }),
        expect.objectContaining({
          message: "Copy job finished processing media",
          data: expect.objectContaining({ total: 3, copied: 3, repointed: 0, skipped: 0, conflicts: 0, failed: 0 })
        })
      ])
    );

    const rows = await ctx.database.db.select().from(schema.mediaLinks).where(eq(schema.mediaLinks.storagePolicy, "location_1"));
    expect(rows.filter((row) => linkIds.includes(row.id))).toEqual(
      expect.arrayContaining(fixtures.map((fixture) => expect.objectContaining({ id: fixture.id, kind: "local", targetPath: fixture.destinationPath })))
    );
  });

  it("detects same-episode local conflicts without treating sibling episodes as conflicts", async () => {
    const cookie = await createAdminSession();
    await insertCopySymlink({
      itemName: "Episode Conflict Show",
      kind: "remote",
      storagePolicy: "location_1",
      section: "shows",
      relativePath: path.join("Episode Conflict Show", "Season 01", "Episode.Conflict.Show.S01E02.New.mkv"),
      content: "new episode copy"
    });
    const sameEpisodePath = path.join(tmpDir, "local", "shows", "Episode Conflict Show", "Season 01", "Episode.Conflict.Show.S01E02.Old.mkv");
    const siblingEpisodePath = path.join(tmpDir, "local", "shows", "Episode Conflict Show", "Season 01", "Episode.Conflict.Show.S01E03.Old.mkv");
    await fs.mkdir(path.dirname(sameEpisodePath), { recursive: true });
    await fs.writeFile(sameEpisodePath, "same episode old local file");
    await fs.writeFile(siblingEpisodePath, "different episode local file");

    const conflicts = await ctx.app.inject({
      method: "POST",
      url: "/api/copies/conflicts",
      headers: { cookie },
      payload: { direction: "to_local", section: "shows", itemName: "Episode Conflict Show" }
    });

    expect(conflicts.statusCode).toBe(200);
    expect(conflicts.json()).toMatchObject({
      totalConflicts: 1,
      totalCandidates: 1,
      conflicts: [
        {
          itemName: "Episode Conflict Show",
          candidates: [expect.objectContaining({ filePath: sameEpisodePath })]
        }
      ]
    });
  });

  it("refuses to overwrite a different destination file during copy", async () => {
    const cookie = await createAdminSession();
    const fixture = await insertCopySymlink({ itemName: "Conflict Movie", kind: "remote", storagePolicy: "location_1", content: "source content" });
    await fs.mkdir(path.dirname(fixture.destinationPath), { recursive: true });
    await fs.writeFile(fixture.destinationPath, "existing different content");

    const copy = await ctx.app.inject({
      method: "POST",
      url: "/api/copies",
      headers: { cookie },
      payload: { direction: "to_local", linkIds: [fixture.id] }
    });

    expect(copy.statusCode).toBe(200);
    const { jobId } = copy.json<{ jobId: number }>();
    await expect(runQueuedJob(jobId, { copyRunner: testCopyRunner })).resolves.toMatchObject({
      status: "completed",
      progress: expect.objectContaining({ copied: 0, conflicts: 1, failed: 0 })
    });

    await expect(fs.readFile(fixture.destinationPath, "utf8")).resolves.toBe("existing different content");
    await expect(fs.readlink(fixture.linkPath)).resolves.toBe(fixture.sourcePath);

    const link = await first(ctx.database.db.select().from(schema.mediaLinks).where(eq(schema.mediaLinks.id, fixture.id)).limit(1));
    expect(link).toMatchObject({ kind: "remote", targetPath: fixture.sourcePath });
  });

  it("requires a resolution when copy to local finds an existing local file for the title", async () => {
    const cookie = await createAdminSession();
    const fixture = await insertCopySymlink({ itemName: "Upgrade Movie", kind: "remote", storagePolicy: "location_1", content: "new version" });
    const oldRelativePath = path.join("movies", "Upgrade Movie", "old-version.mkv");
    const oldPath = path.join(tmpDir, "local", oldRelativePath);
    await fs.mkdir(path.dirname(oldPath), { recursive: true });
    await fs.writeFile(oldPath, "old version");
    await insertStorageFile("local", oldRelativePath, Buffer.byteLength("old version"));

    const preview = await ctx.app.inject({
      method: "POST",
      url: "/api/copies/conflicts",
      headers: { cookie },
      payload: { direction: "to_local", linkIds: [fixture.id] }
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toMatchObject({
      totalConflicts: 1,
      totalCandidates: 1,
      conflicts: [
        {
          linkId: fixture.id,
          itemName: "Upgrade Movie",
          candidates: [expect.objectContaining({ filePath: oldPath, relativePath: oldRelativePath.replace(/\\/g, "/"), sizeBytes: Buffer.byteLength("old version") })]
        }
      ]
    });

    const copy = await ctx.app.inject({
      method: "POST",
      url: "/api/copies",
      headers: { cookie },
      payload: { direction: "to_local", linkIds: [fixture.id] }
    });
    expect(copy.statusCode).toBe(200);
    const { jobId } = copy.json<{ jobId: number }>();
    await expect(runQueuedJob(jobId, { copyRunner: testCopyRunner })).resolves.toMatchObject({
      status: "completed",
      progress: expect.objectContaining({ copied: 0, conflicts: 1, failed: 0, stage: "completed" })
    });
    await expect(ctx.jobs.listEvents(jobId)).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ level: "warn", message: "Existing local file requires copy resolution" })]));
    await expect(fs.readFile(oldPath, "utf8")).resolves.toBe("old version");
    await expect(fs.stat(fixture.destinationPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.readlink(fixture.linkPath)).resolves.toBe(fixture.sourcePath);
  });

  it("blocks replacement when a claimed local candidate changes before the worker starts", async () => {
    const fixture = await insertCopySymlink({ itemName: "Changed Candidate Movie", kind: "remote", storagePolicy: "location_1", content: "new candidate version" });
    const oldRelativePath = path.join("movies", "Changed Candidate Movie", "old-version.mkv");
    const oldPath = path.join(tmpDir, "local", oldRelativePath);
    await fs.mkdir(path.dirname(oldPath), { recursive: true });
    await fs.writeFile(oldPath, "old candidate version");
    await insertStorageFile("local", oldRelativePath, Buffer.byteLength("old candidate version"));
    const jobId = await ctx.jobs.startCopy({ direction: "to_local", linkIds: [fixture.id], localConflictStrategy: "replace" });
    await fs.writeFile(oldPath, "externally changed candidate version");

    await expect(runQueuedJob(jobId, { copyRunner: testCopyRunner })).resolves.toMatchObject({
      status: "completed",
      progress: expect.objectContaining({ copied: 0, conflicts: 1, failed: 0 })
    });
    await expect(fs.readFile(oldPath, "utf8")).resolves.toBe("externally changed candidate version");
    await expect(fs.stat(fixture.destinationPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.readlink(fixture.linkPath)).resolves.toBe(fixture.sourcePath);
    await expect(ctx.jobs.listEvents(jobId)).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ message: "Local replacement candidates changed after copy admission" })])
    );
  });

  it("blocks replacement when a new unclaimed local candidate appears after admission", async () => {
    const fixture = await insertCopySymlink({ itemName: "Late Candidate Movie", kind: "remote", storagePolicy: "location_1", content: "new late candidate version" });
    const jobId = await ctx.jobs.startCopy({ direction: "to_local", linkIds: [fixture.id], localConflictStrategy: "replace" });
    const latePath = path.join(tmpDir, "local", "movies", "Late Candidate Movie", "late-version.mkv");
    await fs.mkdir(path.dirname(latePath), { recursive: true });
    await fs.writeFile(latePath, "late external candidate");

    await expect(runQueuedJob(jobId, { copyRunner: testCopyRunner })).resolves.toMatchObject({
      status: "completed",
      progress: expect.objectContaining({ copied: 0, conflicts: 1, failed: 0 })
    });
    await expect(fs.readFile(latePath, "utf8")).resolves.toBe("late external candidate");
    await expect(fs.stat(fixture.destinationPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.readlink(fixture.linkPath)).resolves.toBe(fixture.sourcePath);
  });

  it("keeps another selected destination out of replacement cleanup while replacing the current destination", async () => {
    const first = await insertCopySymlink({
      itemName: "Shared Replacement Movie",
      kind: "remote",
      storagePolicy: "location_1",
      relativePath: path.join("Shared Replacement Movie", "first.mkv"),
      content: "first replacement"
    });
    const second = await insertCopySymlink({
      itemName: "Shared Replacement Movie",
      kind: "remote",
      storagePolicy: "location_1",
      relativePath: path.join("Shared Replacement Movie", "second.mkv"),
      content: "second replacement"
    });
    await fs.mkdir(path.dirname(second.destinationPath), { recursive: true });
    await fs.writeFile(second.destinationPath, "existing second destination");

    await expect(ctx.jobs.previewCopyConflicts({ direction: "to_local", linkIds: [first.id, second.id] })).resolves.toMatchObject({
      totalConflicts: 1,
      totalCandidates: 1,
      conflicts: [
        expect.objectContaining({
          linkId: second.id,
          candidates: [expect.objectContaining({ filePath: second.destinationPath, source: "destination" })]
        })
      ]
    });
    const jobId = await ctx.jobs.startCopy({ direction: "to_local", linkIds: [first.id, second.id], localConflictStrategy: "replace" });

    await expect(runQueuedJob(jobId, { copyRunner: testCopyRunner })).resolves.toMatchObject({
      status: "completed",
      progress: expect.objectContaining({ copied: 2, conflicts: 0, failed: 0 })
    });
    await expect(fs.readFile(first.destinationPath, "utf8")).resolves.toBe("first replacement");
    await expect(fs.readFile(second.destinationPath, "utf8")).resolves.toBe("second replacement");
    await expect(fs.readlink(first.linkPath)).resolves.toBe(first.destinationPath);
    await expect(fs.readlink(second.linkPath)).resolves.toBe(second.destinationPath);
  });

  it("keeps replacement cleanup paths exclusive across queued copy jobs", async () => {
    const cleanupOwner = await insertCopySymlink({
      itemName: "Cleanup Claim Movie",
      kind: "remote",
      storagePolicy: "location_1",
      relativePath: path.join("Cleanup Claim Movie", "new-version.mkv"),
      content: "new cleanup owner"
    });
    const claimedRelativePath = path.join("Cleanup Claim Movie", "old-version.mkv");
    const claimedPath = path.join(tmpDir, "local", "movies", claimedRelativePath);
    await fs.mkdir(path.dirname(claimedPath), { recursive: true });
    await fs.writeFile(claimedPath, "old claimed cleanup");
    await insertStorageFile("local", path.join("movies", claimedRelativePath), Buffer.byteLength("old claimed cleanup"));
    const firstJobId = await ctx.jobs.startCopy({ direction: "to_local", linkIds: [cleanupOwner.id], localConflictStrategy: "replace" });
    const destinationOwner = await insertCopySymlink({
      itemName: "Different Destination Owner",
      kind: "remote",
      storagePolicy: "location_1",
      relativePath: claimedRelativePath,
      sourceRelativePath: path.join("Different Destination Owner", "source.mkv"),
      content: "different destination owner"
    });

    await expect(ctx.jobs.startCopy({ direction: "to_local", linkIds: [destinationOwner.id] })).rejects.toThrow(`Job #${firstJobId} is already queued`);
    await expect(fs.readFile(claimedPath, "utf8")).resolves.toBe("old claimed cleanup");
  });

  it("keeps existing local files when copy to local is started with keep both resolution", async () => {
    const cookie = await createAdminSession();
    const fixture = await insertCopySymlink({ itemName: "Keep Both Movie", kind: "remote", storagePolicy: "location_1", content: "new keep both" });
    const oldRelativePath = path.join("movies", "Keep Both Movie", "old-version.mkv");
    const oldPath = path.join(tmpDir, "local", oldRelativePath);
    await fs.mkdir(path.dirname(oldPath), { recursive: true });
    await fs.writeFile(oldPath, "old keep both");
    await insertStorageFile("local", oldRelativePath, Buffer.byteLength("old keep both"));

    const copy = await ctx.app.inject({
      method: "POST",
      url: "/api/copies",
      headers: { cookie },
      payload: { direction: "to_local", linkIds: [fixture.id], localConflictStrategy: "keep_both" }
    });
    expect(copy.statusCode).toBe(200);
    const { jobId } = copy.json<{ jobId: number }>();
    await expect(runQueuedJob(jobId, { copyRunner: testCopyRunner })).resolves.toMatchObject({
      status: "completed",
      progress: expect.objectContaining({ copied: 1, conflicts: 0, failed: 0 })
    });

    await expect(fs.readFile(fixture.destinationPath, "utf8")).resolves.toBe("new keep both");
    await expect(fs.readFile(oldPath, "utf8")).resolves.toBe("old keep both");
    await expect(fs.readlink(fixture.linkPath)).resolves.toBe(fixture.destinationPath);
  });

  it("preserves an exact destination conflict when keeping both local files", async () => {
    const cookie = await createAdminSession();
    const fixture = await insertCopySymlink({ itemName: "Exact Keep Both Movie", kind: "remote", storagePolicy: "location_1", content: "new exact keep both" });
    await fs.mkdir(path.dirname(fixture.destinationPath), { recursive: true });
    await fs.writeFile(fixture.destinationPath, "old exact keep both");
    await insertStorageFile("local", path.join("movies", fixture.relativePath), Buffer.byteLength("old exact keep both"));

    const preview = await ctx.app.inject({
      method: "POST",
      url: "/api/copies/conflicts",
      headers: { cookie },
      payload: { direction: "to_local", linkIds: [fixture.id] }
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toMatchObject({
      totalConflicts: 1,
      totalCandidates: 1,
      conflicts: [expect.objectContaining({ destinationPath: fixture.destinationPath, candidates: [expect.objectContaining({ filePath: fixture.destinationPath, source: "destination" })] })]
    });

    const copy = await ctx.app.inject({
      method: "POST",
      url: "/api/copies",
      headers: { cookie },
      payload: { direction: "to_local", linkIds: [fixture.id], localConflictStrategy: "keep_both" }
    });
    expect(copy.statusCode).toBe(200);
    const { jobId } = copy.json<{ jobId: number }>();
    await expect(runQueuedJob(jobId, { copyRunner: testCopyRunner })).resolves.toMatchObject({
      status: "completed",
      progress: expect.objectContaining({ copied: 1, conflicts: 0, failed: 0 })
    });

    await expect(fs.readFile(fixture.destinationPath, "utf8")).resolves.toBe("new exact keep both");
    await expect(fs.readlink(fixture.linkPath)).resolves.toBe(fixture.destinationPath);
    const keptFiles = (await fs.readdir(path.dirname(fixture.destinationPath))).filter((file) => file.includes(".srtl-kept-"));
    expect(keptFiles).toHaveLength(1);
    await expect(fs.readFile(path.join(path.dirname(fixture.destinationPath), keptFiles[0]), "utf8")).resolves.toBe("old exact keep both");
  });

  it("rolls back an exact-path replacement when cancellation wins atomic completion", async () => {
    const fixture = await insertCopySymlink({ itemName: "Cancelled Exact Replace", kind: "remote", storagePolicy: "location_1", content: "new cancelled replace" });
    await fs.mkdir(path.dirname(fixture.destinationPath), { recursive: true });
    await fs.writeFile(fixture.destinationPath, "old cancelled replace");
    const storageFileId = await insertStorageFile("local", path.join("movies", fixture.relativePath), Buffer.byteLength("old cancelled replace"));
    const jobId = await ctx.jobs.startCopy({ direction: "to_local", linkIds: [fixture.id], localConflictStrategy: "replace" });
    if (!Number.isSafeInteger(jobId)) throw new Error("Copy job ID is invalid");
    await ctx.database.db.execute(sql.raw(`
      CREATE FUNCTION srtl_test_cancel_copy_before_finish() RETURNS trigger
      LANGUAGE plpgsql AS $function$
      BEGIN
        UPDATE jobs SET cancel_requested_at = clock_timestamp()::text WHERE id = NEW.job_id;
        RETURN NEW;
      END;
      $function$
    `));
    await ctx.database.db.execute(sql.raw(`
      CREATE TRIGGER srtl_test_cancel_copy_before_finish
      AFTER INSERT ON job_events
      FOR EACH ROW
      WHEN (NEW.job_id = ${jobId} AND NEW.message = 'Copy job finished processing media')
      EXECUTE FUNCTION srtl_test_cancel_copy_before_finish()
    `));

    await expect(runQueuedJob(jobId, { copyRunner: testCopyRunner })).resolves.toMatchObject({
      status: "cancelled",
      finishedAt: expect.any(String),
      progress: expect.objectContaining({ stage: "cancelled", copied: 0, repointed: 0, message: "Copy job terminated" })
    });

    await expect(fs.readFile(fixture.destinationPath, "utf8")).resolves.toBe("old cancelled replace");
    await expect(fs.readlink(fixture.linkPath)).resolves.toBe(fixture.sourcePath);
    expect((await fs.readdir(path.dirname(fixture.destinationPath))).filter((file) => file.includes(".srtl-replace-"))).toEqual([]);
    await expect(first(ctx.database.db.select().from(schema.mediaLinks).where(eq(schema.mediaLinks.id, fixture.id)).limit(1))).resolves.toMatchObject({
      kind: "remote",
      targetPath: fixture.sourcePath,
      targetExists: true
    });
    await expect(first(ctx.database.db.select().from(schema.storageFiles).where(eq(schema.storageFiles.id, storageFileId)).limit(1))).resolves.toMatchObject({
      filePath: fixture.destinationPath,
      missingSince: null
    });
    await expect(first(ctx.database.db.select().from(schema.copyOperations).where(eq(schema.copyOperations.jobId, jobId)).limit(1))).resolves.toMatchObject({
      stage: "rolled_back",
      localConflictStrategy: "replace"
    });
    expect(await ctx.database.db.select().from(schema.copySources).where(eq(schema.copySources.destinationPath, fixture.destinationPath))).toEqual([]);
    await expect(ctx.jobs.listEvents(jobId)).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ level: "warn", message: "Copy job terminated; completed copy changes rolled back" })])
    );
  });

  it("finalizes exact-path conflict backups only after successful completion", async () => {
    const replaceFixture = await insertCopySymlink({ itemName: "Successful Exact Replace", kind: "remote", storagePolicy: "location_1", content: "new successful replace" });
    const keepBothFixture = await insertCopySymlink({ itemName: "Successful Exact Keep Both", kind: "remote", storagePolicy: "location_1", content: "new successful keep both" });
    await Promise.all([
      fs.mkdir(path.dirname(replaceFixture.destinationPath), { recursive: true }),
      fs.mkdir(path.dirname(keepBothFixture.destinationPath), { recursive: true })
    ]);
    await Promise.all([
      fs.writeFile(replaceFixture.destinationPath, "old successful replace"),
      fs.writeFile(keepBothFixture.destinationPath, "old successful keep both")
    ]);
    await Promise.all([
      insertStorageFile("local", path.join("movies", replaceFixture.relativePath), Buffer.byteLength("old successful replace")),
      insertStorageFile("local", path.join("movies", keepBothFixture.relativePath), Buffer.byteLength("old successful keep both"))
    ]);
    const replaceJobId = await ctx.jobs.startCopy({ direction: "to_local", linkIds: [replaceFixture.id], localConflictStrategy: "replace" });
    await expect(runQueuedJob(replaceJobId, { copyRunner: testCopyRunner })).resolves.toMatchObject({
      status: "completed",
      finishedAt: expect.any(String),
      progress: expect.objectContaining({ copied: 1, conflicts: 0, failed: 0 })
    });
    const keepBothJobId = await ctx.jobs.startCopy({ direction: "to_local", linkIds: [keepBothFixture.id], localConflictStrategy: "keep_both" });
    await expect(runQueuedJob(keepBothJobId, { copyRunner: testCopyRunner })).resolves.toMatchObject({
      status: "completed",
      finishedAt: expect.any(String),
      progress: expect.objectContaining({ copied: 1, conflicts: 0, failed: 0 })
    });

    await expect(fs.readFile(replaceFixture.destinationPath, "utf8")).resolves.toBe("new successful replace");
    await expect(fs.readFile(keepBothFixture.destinationPath, "utf8")).resolves.toBe("new successful keep both");
    await expect(fs.readlink(replaceFixture.linkPath)).resolves.toBe(replaceFixture.destinationPath);
    await expect(fs.readlink(keepBothFixture.linkPath)).resolves.toBe(keepBothFixture.destinationPath);
    expect((await fs.readdir(path.dirname(replaceFixture.destinationPath))).filter((file) => file.includes(".srtl-replace-"))).toEqual([]);
    const keptFiles = (await fs.readdir(path.dirname(keepBothFixture.destinationPath))).filter((file) => file.includes(".srtl-kept-"));
    expect(keptFiles).toHaveLength(1);
    await expect(fs.readFile(path.join(path.dirname(keepBothFixture.destinationPath), keptFiles[0]), "utf8")).resolves.toBe("old successful keep both");
    const mediaLinks = await ctx.database.db.select().from(schema.mediaLinks).where(inArray(schema.mediaLinks.id, [replaceFixture.id, keepBothFixture.id]));
    expect(mediaLinks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: replaceFixture.id, kind: "local", targetPath: replaceFixture.destinationPath, targetExists: true }),
        expect.objectContaining({ id: keepBothFixture.id, kind: "local", targetPath: keepBothFixture.destinationPath, targetExists: true })
      ])
    );
    const operations = await ctx.database.db.select().from(schema.copyOperations).where(inArray(schema.copyOperations.jobId, [replaceJobId, keepBothJobId]));
    expect(operations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ jobId: replaceJobId, stage: "committed", localConflictStrategy: "replace", displacedPath: null }),
        expect.objectContaining({ jobId: keepBothJobId, stage: "committed", localConflictStrategy: "keep_both", displacedPath: null })
      ])
    );
  });

  it("replaces existing local files only after a verified copy is installed", async () => {
    const cookie = await createAdminSession();
    const fixture = await insertCopySymlink({ itemName: "Replace Movie", kind: "remote", storagePolicy: "location_1", content: "new replace" });
    const oldRelativePath = path.join("movies", "Replace Movie", "old-version.mkv");
    const oldPath = path.join(tmpDir, "local", oldRelativePath);
    await fs.mkdir(path.dirname(oldPath), { recursive: true });
    await fs.writeFile(oldPath, "old replace");
    const oldStorageFileId = await insertStorageFile("local", oldRelativePath, Buffer.byteLength("old replace"));

    const copy = await ctx.app.inject({
      method: "POST",
      url: "/api/copies",
      headers: { cookie },
      payload: { direction: "to_local", linkIds: [fixture.id], localConflictStrategy: "replace" }
    });
    expect(copy.statusCode).toBe(200);
    const { jobId } = copy.json<{ jobId: number }>();
    await expect(runQueuedJob(jobId, { copyRunner: testCopyRunner })).resolves.toMatchObject({
      status: "completed",
      progress: expect.objectContaining({ copied: 1, conflicts: 0, failed: 0 })
    });

    await expect(fs.readFile(fixture.destinationPath, "utf8")).resolves.toBe("new replace");
    await expect(fs.stat(oldPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.readlink(fixture.linkPath)).resolves.toBe(fixture.destinationPath);
    await expect(first(ctx.database.db.select().from(schema.storageFiles).where(eq(schema.storageFiles.id, oldStorageFileId)).limit(1))).resolves.toMatchObject({ missingSince: expect.any(String) });
    await expect(ctx.jobs.listEvents(jobId)).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ level: "info", message: "Replaced previous local files" })]));
  });

  it("leaves symlinks untouched when the copy source is missing", async () => {
    const cookie = await createAdminSession();
    const fixture = await insertCopySymlink({ itemName: "Missing Source Movie", kind: "remote", storagePolicy: "location_1", writeSource: false });

    const copy = await ctx.app.inject({
      method: "POST",
      url: "/api/copies",
      headers: { cookie },
      payload: { direction: "to_local", linkIds: [fixture.id] }
    });

    expect(copy.statusCode).toBe(200);
    const { jobId } = copy.json<{ jobId: number }>();
    await expect(runQueuedJob(jobId, { copyRunner: testCopyRunner })).resolves.toMatchObject({
      status: "failed",
      progress: expect.objectContaining({ copied: 0, conflicts: 0, failed: 1, stage: "failed", message: "Copy job failed: 1 of 1 media item failed" })
    });

    await expect(ctx.jobs.listEvents(jobId)).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ level: "error", message: "Copy job failed processing media" })])
    );
    await expect(fs.readlink(fixture.linkPath)).resolves.toBe(fixture.sourcePath);
    await expect(fs.stat(fixture.destinationPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("marks copy jobs as partially failed when some media copied and some failed", async () => {
    const cookie = await createAdminSession();
    const copiedFixture = await insertCopySymlink({ itemName: "Partial Copy Success", kind: "remote", storagePolicy: "location_1", content: "copied media" });
    const missingFixture = await insertCopySymlink({ itemName: "Partial Copy Missing", kind: "remote", storagePolicy: "location_1", writeSource: false });

    const copy = await ctx.app.inject({
      method: "POST",
      url: "/api/copies",
      headers: { cookie },
      payload: { direction: "to_local", linkIds: [copiedFixture.id, missingFixture.id] }
    });

    expect(copy.statusCode).toBe(200);
    const { jobId } = copy.json<{ jobId: number }>();
    await expect(runQueuedJob(jobId, { copyRunner: testCopyRunner })).resolves.toMatchObject({
      status: "partially_failed",
      progress: expect.objectContaining({
        copied: 1,
        conflicts: 0,
        failed: 1,
        stage: "partially_failed",
        message: "Copy job partially failed: 1 of 2 media items failed"
      })
    });

    await expect(ctx.jobs.listEvents(jobId)).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ level: "warn", message: "Copy job partially failed processing media" })])
    );
    await expect(fs.readlink(copiedFixture.linkPath)).resolves.toBe(copiedFixture.destinationPath);
    await expect(fs.readFile(copiedFixture.destinationPath, "utf8")).resolves.toBe("copied media");
    await expect(fs.readlink(missingFixture.linkPath)).resolves.toBe(missingFixture.sourcePath);
    await expect(fs.stat(missingFixture.destinationPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("queues a guarded job that removes only selected symlinks from failed copy items", async () => {
    const cookie = await createAdminSession();
    const fixture = await insertCopySymlink({ itemName: "Cleanup Failed Copy", kind: "remote", storagePolicy: "location_1", content: "preserve this source" });
    const failedCopyRunner: CopyCommandRunner = {
      ...testCopyRunner,
      async copyFile() {
        throw new Error("simulated transfer failure");
      }
    };
    const copyJobId = await ctx.jobs.startCopy({ direction: "to_local", linkIds: [fixture.id] });
    await expect(runQueuedJob(copyJobId, { copyRunner: failedCopyRunner })).resolves.toMatchObject({ status: "failed" });

    const unauthenticated = await ctx.app.inject({ method: "GET", url: `/api/jobs/${copyJobId}/copy-failures` });
    expect(unauthenticated.statusCode).toBe(401);
    const failures = await ctx.app.inject({ method: "GET", url: `/api/jobs/${copyJobId}/copy-failures`, headers: { cookie } });
    expect(failures.statusCode).toBe(200);
    expect(failures.json()).toMatchObject({
      jobId: copyJobId,
      totalFailures: 1,
      eligibleCount: 1,
      unidentifiedCount: 0,
      items: [
        expect.objectContaining({
          mediaLinkId: fixture.id,
          copyOperationId: expect.any(Number),
          itemName: "Cleanup Failed Copy",
          fileName: path.basename(fixture.sourcePath),
          symlinkStatus: "eligible"
        })
      ]
    });

    const cleanup = await ctx.app.inject({
      method: "POST",
      url: `/api/jobs/${copyJobId}/copy-failures/remove-symlinks`,
      headers: { cookie },
      payload: { mediaLinkIds: [fixture.id] }
    });
    expect(cleanup.statusCode).toBe(200);
    const cleanupJobId = cleanup.json<{ jobId: number }>().jobId;
    await expect(ctx.jobs.getJob(cleanupJobId)).resolves.toMatchObject({ type: "symlink_cleanup", status: "queued", selection: { total: 1 } });
    const claims = await ctx.database.db.select().from(schema.jobResourceClaims).where(eq(schema.jobResourceClaims.jobId, cleanupJobId));
    expect(claims).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ resourceType: "media", resourceKey: String(fixture.id), access: "exclusive" }),
        expect.objectContaining({ resourceType: "section", resourceKey: "movies", access: "shared" }),
        expect.objectContaining({ resourceType: "title", resourceKey: JSON.stringify(["movies", "Cleanup Failed Copy"]), access: "shared" }),
        expect.objectContaining({ resourceType: "path", resourceKey: path.resolve(fixture.linkPath), access: "exclusive" })
      ])
    );

    await expect(ctx.jobs.startAudit({ mode: "fast", linkIds: [fixture.id], byteCompare: false })).rejects.toThrow(
      `Job #${cleanupJobId} is already queued`
    );
    await expect(runQueuedJob(cleanupJobId)).resolves.toMatchObject({
      status: "completed",
      progress: expect.objectContaining({ removed: 1, alreadyMissing: 0, failed: 0, stage: "completed" })
    });

    await expect(fs.lstat(fixture.linkPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.readFile(fixture.sourcePath, "utf8")).resolves.toBe("preserve this source");
    await expect(fs.stat(path.dirname(fixture.linkPath))).resolves.toMatchObject({});
    await expect(fs.stat(fixture.destinationPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(first(ctx.database.db.select().from(schema.mediaLinks).where(eq(schema.mediaLinks.id, fixture.id)).limit(1))).resolves.toMatchObject({
      missingSince: expect.any(String)
    });
    await expect(first(ctx.database.db.select().from(schema.symlinkCleanupOperations).where(eq(schema.symlinkCleanupOperations.jobId, cleanupJobId)).limit(1))).resolves.toMatchObject({
      sourceJobId: copyJobId,
      mediaLinkId: fixture.id,
      stage: "removed",
      errorMessage: null,
      completedAt: expect.any(String)
    });
    const refreshed = await ctx.app.inject({ method: "GET", url: `/api/jobs/${copyJobId}/copy-failures`, headers: { cookie } });
    expect(refreshed.json()).toMatchObject({ eligibleCount: 0, items: [expect.objectContaining({ symlinkStatus: "already_missing" })] });
  });

  it("does not remove an old failed symlink after a later copy succeeds", async () => {
    const cookie = await createAdminSession();
    const fixture = await insertCopySymlink({ itemName: "Superseded Failed Copy", kind: "remote", storagePolicy: "location_1", content: "retry succeeds" });
    const failedCopyRunner: CopyCommandRunner = {
      ...testCopyRunner,
      async copyFile() {
        throw new Error("first attempt failed");
      }
    };
    const failedJobId = await ctx.jobs.startCopy({ direction: "to_local", linkIds: [fixture.id] });
    await expect(runQueuedJob(failedJobId, { copyRunner: failedCopyRunner })).resolves.toMatchObject({ status: "failed" });
    const retryJobId = await ctx.jobs.startCopy({ direction: "to_local", linkIds: [fixture.id] });
    await expect(runQueuedJob(retryJobId, { copyRunner: testCopyRunner })).resolves.toMatchObject({ status: "completed" });

    const failures = await ctx.app.inject({ method: "GET", url: `/api/jobs/${failedJobId}/copy-failures`, headers: { cookie } });
    expect(failures.statusCode).toBe(200);
    expect(failures.json()).toMatchObject({ eligibleCount: 0, items: [expect.objectContaining({ mediaLinkId: fixture.id, symlinkStatus: "superseded" })] });
    const cleanup = await ctx.app.inject({
      method: "POST",
      url: `/api/jobs/${failedJobId}/copy-failures/remove-symlinks`,
      headers: { cookie },
      payload: { mediaLinkIds: [fixture.id] }
    });
    expect(cleanup.statusCode).toBe(409);
    expect(cleanup.json()).toMatchObject({ error: expect.stringContaining("later successful copy") });
    await expect(fs.readlink(fixture.linkPath)).resolves.toBe(fixture.destinationPath);
    await expect(fs.readFile(fixture.destinationPath, "utf8")).resolves.toBe("retry succeeds");
  });

  it("finishes cleanup idempotently when a selected symlink is already absent at execution", async () => {
    const fixture = await insertCopySymlink({ itemName: "Interrupted Cleanup", kind: "remote", storagePolicy: "location_1" });
    const failedCopyRunner: CopyCommandRunner = {
      ...testCopyRunner,
      async copyFile() {
        throw new Error("cleanup recovery fixture");
      }
    };
    const failedJobId = await ctx.jobs.startCopy({ direction: "to_local", linkIds: [fixture.id] });
    await expect(runQueuedJob(failedJobId, { copyRunner: failedCopyRunner })).resolves.toMatchObject({ status: "failed" });
    const cleanupJobId = await ctx.jobs.startSymlinkCleanup(failedJobId, [fixture.id]);
    await fs.unlink(fixture.linkPath);

    await expect(runQueuedJob(cleanupJobId)).resolves.toMatchObject({
      status: "completed",
      progress: expect.objectContaining({ removed: 0, alreadyMissing: 1, failed: 0 })
    });
    await expect(first(ctx.database.db.select().from(schema.symlinkCleanupOperations).where(eq(schema.symlinkCleanupOperations.jobId, cleanupJobId)).limit(1))).resolves.toMatchObject({
      stage: "already_missing"
    });
    await expect(first(ctx.database.db.select().from(schema.mediaLinks).where(eq(schema.mediaLinks.id, fixture.id)).limit(1))).resolves.toMatchObject({
      missingSince: expect.any(String)
    });
  });

  it("blocks failed-symlink cleanup while the same media has unresolved copy reconciliation", async () => {
    const fixture = await insertCopySymlink({ itemName: "Cleanup Reconciliation Block", kind: "remote", storagePolicy: "location_1" });
    const sourceJobId = await ctx.jobs.startCopy({ direction: "to_local", linkIds: [fixture.id] });
    const timestamp = new Date().toISOString();
    await ctx.database.db.update(schema.jobs).set({ status: "failed", startedAt: timestamp, finishedAt: timestamp }).where(eq(schema.jobs.id, sourceJobId));
    const operationId = await insertCopyOperationFixture({
      jobId: sourceJobId,
      fixture,
      stage: "reconciliation_required",
      errorMessage: "simulated uncertain filesystem state"
    });
    const tempPath = `${fixture.destinationPath}.srtl-copy-unresolved`;
    await fs.mkdir(path.dirname(tempPath), { recursive: true });
    await fs.writeFile(tempPath, "unresolved temporary copy");
    await ctx.database.db.update(schema.copyOperations).set({ tempPath }).where(eq(schema.copyOperations.id, operationId));
    await ctx.database.db.insert(schema.jobEvents).values({
      jobId: sourceJobId,
      timestamp,
      level: "error",
      message: "copy promotion state is uncertain",
      data: JSON.stringify({
        mediaLinkId: fixture.id,
        copyOperationId: operationId,
        itemName: "Cleanup Reconciliation Block",
        linkPath: fixture.linkPath,
        sourcePath: fixture.sourcePath
      })
    });

    await expect(ctx.jobs.copyFailures(sourceJobId)).resolves.toMatchObject({
      eligibleCount: 0,
      items: [expect.objectContaining({ mediaLinkId: fixture.id, symlinkStatus: "reconciliation_required" })]
    });
    await expect(ctx.jobs.startSymlinkCleanup(sourceJobId, [fixture.id])).rejects.toThrow("unresolved filesystem state");
    await expect(fs.readlink(fixture.linkPath)).resolves.toBe(fixture.sourcePath);
    await expect(fs.readFile(fixture.sourcePath, "utf8")).resolves.toBe("media content");
  });

  it("fails closed when a selected symlink changes after cleanup admission", async () => {
    const fixture = await insertCopySymlink({ itemName: "Changed Cleanup Link", kind: "remote", storagePolicy: "location_1" });
    const failedCopyRunner: CopyCommandRunner = {
      ...testCopyRunner,
      async copyFile() {
        throw new Error("queue cleanup before link change");
      }
    };
    const sourceJobId = await ctx.jobs.startCopy({ direction: "to_local", linkIds: [fixture.id] });
    await expect(runQueuedJob(sourceJobId, { copyRunner: failedCopyRunner })).resolves.toMatchObject({ status: "failed" });
    const cleanupJobId = await ctx.jobs.startSymlinkCleanup(sourceJobId, [fixture.id]);
    const replacementTarget = path.join(tmpDir, "remote", "movies", "Changed Cleanup Link", "replacement.mkv");
    await fs.writeFile(replacementTarget, "replacement media");
    await fs.unlink(fixture.linkPath);
    await fs.symlink(replacementTarget, fixture.linkPath);

    await expect(runQueuedJob(cleanupJobId)).resolves.toMatchObject({
      status: "failed",
      progress: expect.objectContaining({ removed: 0, alreadyMissing: 0, failed: 1 })
    });
    await expect(fs.readlink(fixture.linkPath)).resolves.toBe(replacementTarget);
    await expect(fs.readFile(replacementTarget, "utf8")).resolves.toBe("replacement media");
    await expect(first(ctx.database.db.select().from(schema.mediaLinks).where(eq(schema.mediaLinks.id, fixture.id)).limit(1))).resolves.toMatchObject({
      missingSince: null
    });
    await expect(first(ctx.database.db.select().from(schema.symlinkCleanupOperations).where(eq(schema.symlinkCleanupOperations.jobId, cleanupJobId)).limit(1))).resolves.toMatchObject({
      stage: "failed",
      errorMessage: expect.stringContaining("target changed")
    });
  });

  it("normalizes legacy mixed failed copy jobs as partially failed", async () => {
    const timestamp = new Date().toISOString();
    const row = await first(ctx.database.db
      .insert(schema.jobs)
      .values({
        type: "copy",
        status: "failed",
        createdAt: timestamp,
        startedAt: timestamp,
        finishedAt: timestamp,
        progress: JSON.stringify({ copied: 10, repointed: 0, skipped: 0, conflicts: 0, failed: 16, stage: "failed", message: "Copy job failed: 16 of 26 media items failed" })
      })
      .returning({ id: schema.jobs.id }));
    if (!row) throw new Error("Legacy mixed failed job was not inserted");

    await expect(ctx.jobs.getJob(row.id)).resolves.toMatchObject({
      status: "partially_failed",
      progress: expect.objectContaining({ stage: "partially_failed", message: "Copy job partially failed: 16 of 26 media items failed" })
    });
  });

  it("terminates queued scan, audit, and copy jobs", async () => {
    const cookie = await createAdminSession();
    const copyFixture = await insertCopySymlink({ itemName: "Queued Terminate Movie", kind: "remote", storagePolicy: "location_1" });
    const auditJobId = await ctx.jobs.startAudit({ mode: "fast", targets: ["local"], sections: ["movies"] });
    const copyJobId = await ctx.jobs.startCopy({ direction: "to_local", linkIds: [copyFixture.id] });
    const scanJobId = await ctx.jobs.startScan({ scanSymlinks: false, scanLocal: false, scanRemote: true, symlinkSections: [], localSections: [] });

    for (const jobId of [scanJobId, auditJobId, copyJobId]) {
      const response = await ctx.app.inject({ method: "POST", url: `/api/jobs/${jobId}/terminate`, headers: { cookie } });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ ok: true, jobId });
      expect(await ctx.jobs.getJob(jobId)).toMatchObject({ status: "cancelled" });
    }
  });

  it("rolls back completed copy changes when a copy job is terminated", async () => {
    const firstFixture = await insertCopySymlink({ itemName: "Terminate Copy One", kind: "remote", storagePolicy: "location_1", content: "first copy" });
    const secondFixture = await insertCopySymlink({ itemName: "Terminate Copy Two", kind: "remote", storagePolicy: "location_1", content: "second copy" });
    const jobId = await ctx.jobs.startCopy({ direction: "to_local", linkIds: [firstFixture.id, secondFixture.id] });
    let copyCalls = 0;
    const terminatingCopyRunner: CopyCommandRunner = {
      ...testCopyRunner,
      async copyFile(sourcePath, tempPath, reportProgress, signal) {
        copyCalls += 1;
        if (copyCalls === 2) {
          await ctx.jobs.terminate(jobId);
          throw new Error("Job terminated");
        }
        return testCopyRunner.copyFile(sourcePath, tempPath, reportProgress, signal);
      }
    };

    await expect(runQueuedJob(jobId, { copyRunner: terminatingCopyRunner })).resolves.toMatchObject({
      status: "cancelled",
      progress: expect.objectContaining({ stage: "cancelled", copied: 0, repointed: 0, message: "Copy job terminated" })
    });

    await expect(fs.stat(firstFixture.destinationPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(secondFixture.destinationPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.readlink(firstFixture.linkPath)).resolves.toBe(firstFixture.sourcePath);
    await expect(fs.readlink(secondFixture.linkPath)).resolves.toBe(secondFixture.sourcePath);

    const firstLink = await first(ctx.database.db.select().from(schema.mediaLinks).where(eq(schema.mediaLinks.id, firstFixture.id)).limit(1));
    const secondLink = await first(ctx.database.db.select().from(schema.mediaLinks).where(eq(schema.mediaLinks.id, secondFixture.id)).limit(1));
    expect(firstLink).toMatchObject({ kind: "remote", targetPath: firstFixture.sourcePath });
    expect(secondLink).toMatchObject({ kind: "remote", targetPath: secondFixture.sourcePath });
    expect(await ctx.database.db.select().from(schema.copySources).where(eq(schema.copySources.destinationPath, firstFixture.destinationPath))).toEqual([]);
    expect(await ctx.jobs.listEvents(jobId)).toEqual(expect.arrayContaining([expect.objectContaining({ message: "Copy job terminated; completed copy changes rolled back" })]));
  });

  it("requeues active copy jobs when the worker stops before completion", async () => {
    const fixture = await insertCopySymlink({ itemName: "Interrupted Copy Movie", kind: "remote", storagePolicy: "location_1", content: "interrupted copy" });
    const jobId = await ctx.jobs.startCopy({ direction: "to_local", linkIds: [fixture.id] });
    let resolveCopyStarted: (() => void) | null = null;
    const copyStarted = new Promise<void>((resolve) => {
      resolveCopyStarted = resolve;
    });
    const interruptedCopyRunner: CopyCommandRunner = {
      ...testCopyRunner,
      async copyFile(_sourcePath, _tempPath, _reportProgress, signal) {
        resolveCopyStarted?.();
        await new Promise<void>((_resolve, reject) => {
          if (signal?.aborted) {
            reject(new Error("copy interrupted"));
            return;
          }
          signal?.addEventListener("abort", () => reject(new Error("copy interrupted")), { once: true });
        });
      }
    };

    const worker = new JobWorker(ctx.database.db, {
      workerId: "interrupt-worker",
      pollIntervalMs: 1,
      heartbeatIntervalMs: 10,
      logger: silentLogger,
      copyRunner: interruptedCopyRunner
    });
    const run = worker.runOnce();
    await copyStarted;
    worker.stop();
    await expect(run).resolves.toBe(true);

    expect(await ctx.jobs.getJob(jobId)).toMatchObject({ status: "queued", lockedBy: null, heartbeatAt: null });
    await expect(fs.readlink(fixture.linkPath)).resolves.toBe(fixture.sourcePath);
    await expect(fs.stat(fixture.destinationPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await ctx.jobs.listEvents(jobId)).toEqual(expect.arrayContaining([expect.objectContaining({ message: "Worker stopped; job requeued for resume" })]));
  });

  it("cancels an active copy after safely rolling it back for a managed path change", async () => {
    const fixture = await insertCopySymlink({ itemName: "Path Change Copy Movie", kind: "remote", storagePolicy: "location_1", content: "path change copy" });
    const jobId = await ctx.jobs.startCopy({ direction: "to_local", linkIds: [fixture.id] });
    let resolveCopyStarted: (() => void) | null = null;
    const copyStarted = new Promise<void>((resolve) => {
      resolveCopyStarted = resolve;
    });
    const pausedCopyRunner: CopyCommandRunner = {
      ...testCopyRunner,
      async copyFile(_sourcePath, _tempPath, _reportProgress, signal) {
        resolveCopyStarted?.();
        await new Promise<void>((_resolve, reject) => {
          if (signal?.aborted) {
            reject(new Error("copy paused"));
            return;
          }
          signal?.addEventListener("abort", () => reject(new Error("copy paused")), { once: true });
        });
      }
    };
    const worker = new JobWorker(ctx.database.db, {
      workerId: "path-pause-worker",
      pollIntervalMs: 1,
      heartbeatIntervalMs: 10,
      logger: silentLogger,
      copyRunner: pausedCopyRunner
    });
    const run = worker.runOnce();
    await copyStarted;
    const detectedSymlinkDir = path.join(tmpDir, "symlinks-detected");
    await fs.symlink(path.join(tmpDir, "plex"), detectedSymlinkDir, "dir");
    await reconcileEnvironmentPaths(ctx.database.db, {
      symlinkDir: detectedSymlinkDir,
      localDir: path.join(tmpDir, "local"),
      remoteDir: path.join(tmpDir, "remote")
    });
    await expect(run).resolves.toBe(true);

    expect(await ctx.jobs.getJob(jobId)).toMatchObject({ status: "cancelled", lockedBy: null, heartbeatAt: null });
    await expect(fs.readlink(fixture.linkPath)).resolves.toBe(fixture.sourcePath);
    await expect(fs.stat(fixture.destinationPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await ctx.jobs.listEvents(jobId)).toEqual(
      expect.arrayContaining([expect.objectContaining({ message: "Copy cancelled after managed-path recovery" })])
    );
  });

  it("records failed scans in scan history with the failure message", async () => {
    const cookie = await createAdminSession();
    const timestamp = new Date().toISOString();
    const legacyJob = await first(ctx.database.db
      .insert(schema.jobs)
      .values({ type: "scan", status: "failed", createdAt: timestamp, startedAt: timestamp, finishedAt: timestamp, progress: "{}" })
      .returning({ id: schema.jobs.id }));
    if (!legacyJob) throw new Error("Legacy job was not inserted");
    await ctx.database.db.insert(schema.jobEvents).values({ jobId: legacyJob.id, timestamp, level: "error", message: "Legacy scan failed before history existed", data: "{}" });

    await setSetting(ctx.database.db, "paths", {
      symlinkDir: path.join(tmpDir, "missing-plex"),
      localDir: path.join(tmpDir, "local"),
      remoteDir: path.join(tmpDir, "remote")
    });

    const scan = await ctx.app.inject({ method: "POST", url: "/api/scans", headers: { cookie } });
    expect(scan.statusCode).toBe(200);
    const { jobId } = scan.json<{ jobId: number }>();
    await expect(runQueuedJob(jobId)).resolves.toMatchObject({ status: "failed" });

    const history = await ctx.app.inject({ method: "GET", url: "/api/scans", headers: { cookie } });
    expect(history.statusCode).toBe(200);
    expect(history.json()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: null,
          jobId: legacyJob.id,
          status: "failed",
          errorMessage: "Legacy scan failed before history existed"
        }),
        expect.objectContaining({
          jobId,
          status: "failed",
          totalLinks: 0,
          remoteLinks: 0,
          localLinks: 0,
          errorMessage: expect.stringContaining('Symlink folder "movies" is unavailable')
        })
      ])
    );
    expect(history.json()).toEqual([
      expect.objectContaining({
        jobId,
        status: "failed",
        totalLinks: 0,
        remoteLinks: 0,
        localLinks: 0,
        errorMessage: expect.stringContaining('Symlink folder "movies" is unavailable')
      }),
      expect.objectContaining({
        id: null,
        jobId: legacyJob.id,
        status: "failed",
        errorMessage: "Legacy scan failed before history existed"
      })
    ]);
  });

  it("keeps queued jobs queued while the single running-job limit is active", async () => {
    const activeStartedAt = new Date().toISOString();
    const activeJobId = await insertRunningJob(activeStartedAt);
    await ctx.database.db
      .update(schema.jobs)
      .set({ lockedBy: "active-worker", heartbeatAt: activeStartedAt })
      .where(eq(schema.jobs.id, activeJobId));

    const queuedJobId = await ctx.jobs.startScan({ scanSymlinks: false, scanLocal: false, scanRemote: true, symlinkSections: [], localSections: [] });
    const worker = new JobWorker(ctx.database.db, { workerId: "blocked-worker", pollIntervalMs: 1, heartbeatIntervalMs: 10, logger: silentLogger });

    expect(await worker.runOnce()).toBe(false);
    expect(await ctx.jobs.getJob(activeJobId)).toMatchObject({ status: "running", lockedBy: "active-worker" });
    expect(await ctx.jobs.getJob(queuedJobId)).toMatchObject({ status: "queued", startedAt: null, lockedBy: null, heartbeatAt: null });
  });

  it("claims unrelated work without waiting on a running job's lease lock", async () => {
    const activeStartedAt = new Date().toISOString();
    const activeJobId = await insertRunningJob(activeStartedAt, "audit");
    await ctx.database.db
      .update(schema.jobs)
      .set({ exclusive: false, lockedBy: "lease-holder", lockedAt: activeStartedAt, heartbeatAt: activeStartedAt })
      .where(eq(schema.jobs.id, activeJobId));
    const queuedJobId = await ctx.jobs.startAudit({ mode: "fast", itemName: "Unrelated Empty Audit" });
    const lockClient = await ctx.database.pool.connect();
    await lockClient.query("BEGIN");
    await lockClient.query("SELECT id FROM jobs WHERE id = $1 FOR UPDATE", [activeJobId]);
    const worker = new JobWorker(ctx.database.db, {
      workerId: "skip-locked-claim-worker",
      pollIntervalMs: 1,
      heartbeatIntervalMs: 10,
      logger: silentLogger,
      concurrency: {
        workerCount: 2,
        maxRunningJobs: 2,
        maxRunningScans: 1,
        maxRunningAudits: 2,
        maxRunningCopies: 1,
        copyFileConcurrency: 1,
        maxActiveCopyFiles: 1
      }
    });

    try {
      await expect(
        Promise.race([
          worker.runOnce(),
          new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("claim blocked on unrelated lease")), 1_000))
        ])
      ).resolves.toBe(true);
    } finally {
      await lockClient.query("ROLLBACK");
      lockClient.release();
    }
    expect(await ctx.jobs.getJob(queuedJobId)).toMatchObject({ status: "completed" });
    expect(await ctx.jobs.getJob(activeJobId)).toMatchObject({ status: "running", lockedBy: "lease-holder" });
  });

  it("claims disjoint copy jobs concurrently up to the configured limits", async () => {
    const fixtures = await Promise.all([
      insertCopySymlink({ itemName: "Parallel Claim One", kind: "remote", storagePolicy: "location_1", content: "parallel one" }),
      insertCopySymlink({ itemName: "Parallel Claim Two", kind: "remote", storagePolicy: "location_1", content: "parallel two" })
    ]);
    const jobIds = await Promise.all(fixtures.map((fixture) => ctx.jobs.startCopy({ direction: "to_local", linkIds: [fixture.id] })));
    let releaseCopy: () => void = () => undefined;
    const copyReleased = new Promise<void>((resolve) => {
      releaseCopy = resolve;
    });
    const blockingRunner: CopyCommandRunner = {
      ...testCopyRunner,
      async copyFile(sourcePath, tempPath, reportProgress, signal) {
        await copyReleased;
        if (signal?.aborted) throw new Error("copy interrupted");
        await testCopyRunner.copyFile(sourcePath, tempPath, reportProgress, signal);
      }
    };
    const concurrency = {
      workerCount: 2,
      maxRunningJobs: 2,
      maxRunningScans: 2,
      maxRunningAudits: 2,
      maxRunningCopies: 2,
      copyFileConcurrency: 1,
      maxActiveCopyFiles: 2
    };
    const workers = ["parallel-worker-1", "parallel-worker-2"].map(
      (workerId) => new JobWorker(ctx.database.db, { workerId, pollIntervalMs: 1, heartbeatIntervalMs: 10, logger: silentLogger, copyRunner: blockingRunner, concurrency })
    );
    const runs = workers.map((worker) => worker.runOnce());

    try {
      let runningIds: number[] = [];
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const jobs = await Promise.all(jobIds.map((jobId) => ctx.jobs.getJob(jobId)));
        runningIds = jobs.filter((job) => job?.status === "running").map((job) => job?.id ?? 0);
        if (runningIds.length === 2) break;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(runningIds.sort((firstId, secondId) => firstId - secondId)).toEqual([...jobIds].sort((firstId, secondId) => firstId - secondId));
    } finally {
      releaseCopy();
      await Promise.allSettled(runs);
    }
    await expect(Promise.all(runs)).resolves.toEqual([true, true]);
  });

  it("completes a symlink-only section scan while a copy in another section is still transferring", async () => {
    const copyFixture = await insertCopySymlink({
      itemName: "Show Copy During Movie Scan",
      kind: "remote",
      storagePolicy: "location_1",
      section: "shows",
      content: "show copy stays active"
    });
    await insertCopySymlink({ itemName: "Movie Scan During Show Copy", kind: "remote", storagePolicy: "location_2", section: "movies", content: "scan independently" });
    const copyJobId = await ctx.jobs.startCopy({ direction: "to_local", linkIds: [copyFixture.id] });
    const scanJobId = await ctx.jobs.startScan({
      scanSymlinks: true,
      scanLocal: false,
      scanRemote: false,
      symlinkSections: ["movies"],
      localSections: []
    });
    let releaseCopy!: () => void;
    let markCopyStarted!: () => void;
    const copyReleased = new Promise<void>((resolve) => {
      releaseCopy = resolve;
    });
    const copyStarted = new Promise<void>((resolve) => {
      markCopyStarted = resolve;
    });
    const blockingRunner: CopyCommandRunner = {
      ...testCopyRunner,
      async copyFile(sourcePath, tempPath, reportProgress, signal) {
        markCopyStarted();
        await copyReleased;
        await testCopyRunner.copyFile(sourcePath, tempPath, reportProgress, signal);
      }
    };
    const concurrency = {
      workerCount: 2,
      maxRunningJobs: 2,
      maxRunningScans: 1,
      maxRunningAudits: 1,
      maxRunningCopies: 1,
      copyFileConcurrency: 1,
      maxActiveCopyFiles: 1
    };
    const workers = ["section-copy-worker", "section-scan-worker"].map(
      (workerId) => new JobWorker(ctx.database.db, { workerId, pollIntervalMs: 1, heartbeatIntervalMs: 10, logger: silentLogger, copyRunner: blockingRunner, concurrency })
    );
    const runs = workers.map((worker) => worker.runOnce());

    try {
      await copyStarted;
      let scanStatus: string | undefined;
      for (let attempt = 0; attempt < 200; attempt += 1) {
        scanStatus = (await ctx.jobs.getJob(scanJobId))?.status;
        if (scanStatus === "completed") break;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(scanStatus).toBe("completed");
      expect(await ctx.jobs.getJob(scanJobId)).toMatchObject({ exclusive: false });
      expect(await ctx.jobs.getJob(copyJobId)).toMatchObject({ status: "running" });
    } finally {
      releaseCopy();
      await Promise.allSettled(runs);
    }
    await expect(Promise.all(runs)).resolves.toEqual([true, true]);
  });

  it("keeps a symlink-only section scan queued behind a copy in the same section", async () => {
    const copyFixture = await insertCopySymlink({ itemName: "Movie Copy Before Movie Scan", kind: "remote", storagePolicy: "location_1", section: "movies", content: "same section" });
    const copyJobId = await ctx.jobs.startCopy({ direction: "to_local", linkIds: [copyFixture.id] });
    const scanJobId = await ctx.jobs.startScan({
      scanSymlinks: true,
      scanLocal: false,
      scanRemote: false,
      symlinkSections: ["movies"],
      localSections: []
    });
    let releaseCopy!: () => void;
    let markCopyStarted!: () => void;
    const copyReleased = new Promise<void>((resolve) => {
      releaseCopy = resolve;
    });
    const copyStarted = new Promise<void>((resolve) => {
      markCopyStarted = resolve;
    });
    const blockingRunner: CopyCommandRunner = {
      ...testCopyRunner,
      async copyFile(sourcePath, tempPath, reportProgress, signal) {
        markCopyStarted();
        await copyReleased;
        await testCopyRunner.copyFile(sourcePath, tempPath, reportProgress, signal);
      }
    };
    const concurrency = {
      workerCount: 2,
      maxRunningJobs: 2,
      maxRunningScans: 1,
      maxRunningAudits: 1,
      maxRunningCopies: 1,
      copyFileConcurrency: 1,
      maxActiveCopyFiles: 1
    };
    const copyWorker = new JobWorker(ctx.database.db, { workerId: "same-section-copy-worker", logger: silentLogger, copyRunner: blockingRunner, concurrency });
    const scanWorker = new JobWorker(ctx.database.db, { workerId: "same-section-scan-worker", logger: silentLogger, copyRunner: blockingRunner, concurrency });
    const copyRun = copyWorker.runOnce();

    try {
      await copyStarted;
      await expect(scanWorker.runOnce()).resolves.toBe(false);
      expect(await ctx.jobs.getJob(copyJobId)).toMatchObject({ status: "running" });
      expect(await ctx.jobs.getJob(scanJobId)).toMatchObject({ status: "queued", exclusive: false, startedAt: null });
    } finally {
      releaseCopy();
      await copyRun;
    }

    const finishingWorker = new JobWorker(ctx.database.db, { workerId: "same-section-finishing-worker", logger: silentLogger, concurrency });
    await expect(finishingWorker.runOnce()).resolves.toBe(true);
    expect(await ctx.jobs.getJob(scanJobId)).toMatchObject({ status: "completed" });
  });

  it("completes a targeted rescan while a disjoint copy is still transferring", async () => {
    const copyFixture = await insertCopySymlink({ itemName: "Copy During Rescan", kind: "remote", storagePolicy: "location_1", content: "copy stays active" });
    await insertCopySymlink({ itemName: "Rescan During Copy", kind: "remote", storagePolicy: "location_1", content: "rescan independently" });
    const copyJobId = await ctx.jobs.startCopy({ direction: "to_local", linkIds: [copyFixture.id] });
    const scanJobId = await ctx.jobs.startScan({
      scanSymlinks: true,
      scanLocal: false,
      scanRemote: false,
      symlinkSections: ["movies"],
      localSections: [],
      titleScopes: [{ section: "movies", itemName: "Rescan During Copy" }]
    });
    let releaseCopy!: () => void;
    let markCopyStarted!: () => void;
    const copyReleased = new Promise<void>((resolve) => {
      releaseCopy = resolve;
    });
    const copyStarted = new Promise<void>((resolve) => {
      markCopyStarted = resolve;
    });
    const blockingRunner: CopyCommandRunner = {
      ...testCopyRunner,
      async copyFile(sourcePath, tempPath, reportProgress, signal) {
        markCopyStarted();
        await copyReleased;
        await testCopyRunner.copyFile(sourcePath, tempPath, reportProgress, signal);
      }
    };
    const concurrency = {
      workerCount: 2,
      maxRunningJobs: 2,
      maxRunningScans: 1,
      maxRunningAudits: 1,
      maxRunningCopies: 1,
      copyFileConcurrency: 1,
      maxActiveCopyFiles: 1
    };
    const workers = ["copy-rescan-worker-1", "copy-rescan-worker-2"].map(
      (workerId) => new JobWorker(ctx.database.db, { workerId, pollIntervalMs: 1, heartbeatIntervalMs: 10, logger: silentLogger, copyRunner: blockingRunner, concurrency })
    );
    const runs = workers.map((worker) => worker.runOnce());

    try {
      await copyStarted;
      let scanStatus: string | undefined;
      for (let attempt = 0; attempt < 200; attempt += 1) {
        scanStatus = (await ctx.jobs.getJob(scanJobId))?.status;
        if (scanStatus === "completed") break;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(scanStatus).toBe("completed");
      expect(await ctx.jobs.getJob(copyJobId)).toMatchObject({ status: "running" });
    } finally {
      releaseCopy();
      await Promise.allSettled(runs);
    }
    await expect(Promise.all(runs)).resolves.toEqual([true, true]);
    expect(await ctx.jobs.getJob(copyJobId)).toMatchObject({ status: "completed" });
  });

  it("copies independent titles concurrently within one copy job", async () => {
    const fixtures = await Promise.all([
      insertCopySymlink({ itemName: "Concurrent Title One", kind: "remote", storagePolicy: "location_1", content: "concurrent title one" }),
      insertCopySymlink({ itemName: "Concurrent Title Two", kind: "remote", storagePolicy: "location_1", content: "concurrent title two" })
    ]);
    const jobId = await ctx.jobs.startCopy({ direction: "to_local", linkIds: fixtures.map((fixture) => fixture.id) });
    let activeTransfers = 0;
    let maximumActiveTransfers = 0;
    const trackingRunner: CopyCommandRunner = {
      ...testCopyRunner,
      async copyFile(sourcePath, tempPath, reportProgress, signal) {
        activeTransfers += 1;
        maximumActiveTransfers = Math.max(maximumActiveTransfers, activeTransfers);
        try {
          await new Promise((resolve) => setTimeout(resolve, 40));
          await testCopyRunner.copyFile(sourcePath, tempPath, reportProgress, signal);
        } finally {
          activeTransfers -= 1;
        }
      }
    };
    const worker = new JobWorker(ctx.database.db, {
      workerId: "within-job-parallel-worker",
      pollIntervalMs: 1,
      heartbeatIntervalMs: 10,
      logger: silentLogger,
      copyRunner: trackingRunner,
      concurrency: {
        workerCount: 1,
        maxRunningJobs: 1,
        maxRunningScans: 1,
        maxRunningAudits: 1,
        maxRunningCopies: 1,
        copyFileConcurrency: 2,
        maxActiveCopyFiles: 2
      }
    });

    expect(await worker.runOnce()).toBe(true);
    expect(maximumActiveTransfers).toBe(2);
    expect(await ctx.jobs.getJob(jobId)).toMatchObject({
      status: "completed",
      progress: expect.objectContaining({
        current: 2,
        total: 2,
        copied: 2,
        failed: 0,
        currentTitle: null,
        currentFile: null,
        sourcePath: null,
        destinationPath: null,
        linkPath: null,
        sizeBytes: null
      })
    });
  });

  it("copies links for the same title concurrently within one copy job", async () => {
    const fixtures = await Promise.all([
      insertCopySymlink({
        itemName: "Serialized Title",
        kind: "local",
        storagePolicy: "location_2",
        relativePath: path.join("Serialized Title", "serialized-title-cd1.mkv"),
        content: "serialized title part one"
      }),
      insertCopySymlink({
        itemName: "Serialized Title",
        kind: "local",
        storagePolicy: "location_2",
        relativePath: path.join("Serialized Title", "serialized-title-cd2.mkv"),
        content: "serialized title part two"
      })
    ]);
    const jobId = await ctx.jobs.startCopy({ direction: "to_remote", linkIds: fixtures.map((fixture) => fixture.id) });
    let activeTransfers = 0;
    let maximumActiveTransfers = 0;
    const trackingRunner: CopyCommandRunner = {
      ...testCopyRunner,
      async copyFile(sourcePath, tempPath, reportProgress, signal) {
        activeTransfers += 1;
        maximumActiveTransfers = Math.max(maximumActiveTransfers, activeTransfers);
        try {
          await new Promise((resolve) => setTimeout(resolve, 40));
          await testCopyRunner.copyFile(sourcePath, tempPath, reportProgress, signal);
        } finally {
          activeTransfers -= 1;
        }
      }
    };
    const worker = new JobWorker(ctx.database.db, {
      workerId: "same-title-parallel-worker",
      pollIntervalMs: 1,
      heartbeatIntervalMs: 10,
      logger: silentLogger,
      copyRunner: trackingRunner,
      concurrency: {
        workerCount: 1,
        maxRunningJobs: 1,
        maxRunningScans: 1,
        maxRunningAudits: 1,
        maxRunningCopies: 1,
        copyFileConcurrency: 2,
        maxActiveCopyFiles: 2
      }
    });

    expect(await worker.runOnce()).toBe(true);
    expect(maximumActiveTransfers).toBe(2);
    expect(await ctx.jobs.getJob(jobId)).toMatchObject({ status: "completed", progress: expect.objectContaining({ copied: 2, failed: 0 }) });
  });

  it("does not treat a same-title sibling destination that appears during replacement copy as a conflict or cleanup candidate", async () => {
    const fixtures = await Promise.all(
      ["first", "second", "third"].map((part) =>
        insertCopySymlink({
          itemName: "Parallel Replacement Title",
          kind: "remote",
          storagePolicy: "location_1",
          relativePath: path.join("Parallel Replacement Title", `${part}.mkv`),
          content: `${part} parallel replacement`
        })
      )
    );
    const jobId = await ctx.jobs.startCopy({
      direction: "to_local",
      linkIds: fixtures.map((fixture) => fixture.id),
      localConflictStrategy: "replace"
    });
    const transferGates = new Map<string, { wait: Promise<void>; release: () => void }>();
    for (const fixture of fixtures) {
      let release: (() => void) | null = null;
      const wait = new Promise<void>((resolve) => {
        release = resolve;
      });
      if (!release) throw new Error(`Transfer gate was not initialized for ${fixture.sourcePath}`);
      transferGates.set(fixture.sourcePath, { wait, release });
    }
    const startedSources: string[] = [];
    let activeTransfers = 0;
    let maximumActiveTransfers = 0;
    const blockingRunner: CopyCommandRunner = {
      ...testCopyRunner,
      async copyFile(sourcePath, tempPath, reportProgress, signal) {
        activeTransfers += 1;
        maximumActiveTransfers = Math.max(maximumActiveTransfers, activeTransfers);
        startedSources.push(sourcePath);
        try {
          const gate = transferGates.get(sourcePath);
          if (!gate) throw new Error(`Missing transfer gate for ${sourcePath}`);
          await gate.wait;
          await testCopyRunner.copyFile(sourcePath, tempPath, reportProgress, signal);
        } finally {
          activeTransfers -= 1;
        }
      }
    };
    const worker = new JobWorker(ctx.database.db, {
      workerId: "same-title-replacement-parallel-worker",
      pollIntervalMs: 1,
      heartbeatIntervalMs: 10,
      logger: silentLogger,
      copyRunner: blockingRunner,
      concurrency: {
        workerCount: 1,
        maxRunningJobs: 1,
        maxRunningScans: 1,
        maxRunningAudits: 1,
        maxRunningCopies: 1,
        copyFileConcurrency: 2,
        maxActiveCopyFiles: 2
      }
    });
    const run = worker.runOnce();

    try {
      await vi.waitFor(() => expect(startedSources).toHaveLength(2));
      const completedSource = startedSources[0]!;
      transferGates.get(completedSource)!.release();
      await vi.waitFor(() => expect(startedSources).toHaveLength(3));
      const completedFixture = fixtures.find((fixture) => fixture.sourcePath === completedSource);
      if (!completedFixture) throw new Error(`Missing completed fixture for ${completedSource}`);
      expect(activeTransfers).toBe(2);
      await expect(fs.readFile(completedFixture.destinationPath, "utf8")).resolves.toBe(
        `${path.basename(completedFixture.sourcePath, ".mkv")} parallel replacement`
      );
      for (const gate of transferGates.values()) gate.release();
      expect(await run).toBe(true);
    } finally {
      for (const gate of transferGates.values()) gate.release();
      await Promise.allSettled([run]);
    }

    expect(maximumActiveTransfers).toBe(2);
    expect(await ctx.jobs.getJob(jobId)).toMatchObject({
      status: "completed",
      progress: expect.objectContaining({ copied: 3, conflicts: 0, failed: 0 })
    });
    for (const fixture of fixtures) {
      await expect(fs.readFile(fixture.destinationPath, "utf8")).resolves.toBe(
        `${path.basename(fixture.sourcePath, ".mkv")} parallel replacement`
      );
      await expect(fs.readlink(fixture.linkPath)).resolves.toBe(fixture.destinationPath);
    }
    const events = await ctx.jobs.listEvents(jobId);
    expect(events.some((event) => event.message === "Local replacement candidates changed after copy admission")).toBe(false);
    expect(events.some((event) => event.message === "Replaced previous local files")).toBe(false);
    expect((await fs.readdir(path.dirname(fixtures[0].destinationPath))).filter((file) => file.includes(".srtl-replace-"))).toEqual([]);
  });

  it("shares the active-copy-file limit across workers in one process", async () => {
    const fixtures = await Promise.all([
      insertCopySymlink({ itemName: "Global Limit One", kind: "remote", storagePolicy: "location_1", content: "global limit one" }),
      insertCopySymlink({ itemName: "Global Limit Two", kind: "remote", storagePolicy: "location_1", content: "global limit two" })
    ]);
    const jobIds = await Promise.all(fixtures.map((fixture) => ctx.jobs.startCopy({ direction: "to_local", linkIds: [fixture.id] })));
    let activeTransfers = 0;
    let maximumActiveTransfers = 0;
    let observedBothJobsRunning = false;
    const trackingRunner: CopyCommandRunner = {
      ...testCopyRunner,
      async copyFile(sourcePath, tempPath, reportProgress, signal) {
        activeTransfers += 1;
        maximumActiveTransfers = Math.max(maximumActiveTransfers, activeTransfers);
        try {
          for (let attempt = 0; attempt < 100; attempt += 1) {
            const jobs = await Promise.all(jobIds.map((jobId) => ctx.jobs.getJob(jobId)));
            if (jobs.every((job) => job?.status === "running")) {
              observedBothJobsRunning = true;
              break;
            }
            await new Promise((resolve) => setTimeout(resolve, 5));
          }
          await testCopyRunner.copyFile(sourcePath, tempPath, reportProgress, signal);
        } finally {
          activeTransfers -= 1;
        }
      }
    };
    const concurrency = {
      workerCount: 2,
      maxRunningJobs: 2,
      maxRunningScans: 2,
      maxRunningAudits: 2,
      maxRunningCopies: 2,
      copyFileConcurrency: 2,
      maxActiveCopyFiles: 1
    };
    const copyTransferLimiter = new CopyTransferLimiter(1);
    const workers = ["global-limit-worker-1", "global-limit-worker-2"].map(
      (workerId) =>
        new JobWorker(ctx.database.db, {
          workerId,
          pollIntervalMs: 1,
          heartbeatIntervalMs: 10,
          logger: silentLogger,
          copyRunner: trackingRunner,
          concurrency,
          copyTransferLimiter
        })
    );

    await expect(Promise.all(workers.map((worker) => worker.runOnce()))).resolves.toEqual([true, true]);
    expect(observedBothJobsRunning).toBe(true);
    expect(maximumActiveTransfers).toBe(1);
    await expect(Promise.all(jobIds.map((jobId) => ctx.jobs.getJob(jobId)))).resolves.toEqual([
      expect.objectContaining({ status: "completed" }),
      expect.objectContaining({ status: "completed" })
    ]);
  });

  it("enforces a per-type limit independently of the global running-job limit", async () => {
    const timestamp = new Date().toISOString();
    const active = await first(
      ctx.database.db
        .insert(schema.jobs)
        .values({
          type: "copy",
          status: "running",
          createdAt: timestamp,
          startedAt: timestamp,
          finishedAt: null,
          lockedBy: "active-copy-worker",
          lockedAt: timestamp,
          heartbeatAt: timestamp,
          leaseVersion: 1,
          exclusive: false,
          progress: "{}"
        })
        .returning({ id: schema.jobs.id })
    );
    if (!active) throw new Error("Active copy job was not inserted");
    const fixture = await insertCopySymlink({ itemName: "Type Limited Copy", kind: "remote", storagePolicy: "location_1", content: "queued by type" });
    const queuedJobId = await ctx.jobs.startCopy({ direction: "to_local", linkIds: [fixture.id] });
    const worker = new JobWorker(ctx.database.db, {
      workerId: "type-limited-worker",
      pollIntervalMs: 1,
      heartbeatIntervalMs: 10,
      logger: silentLogger,
      concurrency: {
        workerCount: 2,
        maxRunningJobs: 2,
        maxRunningScans: 2,
        maxRunningAudits: 2,
        maxRunningCopies: 1,
        copyFileConcurrency: 1,
        maxActiveCopyFiles: 2
      }
    });

    expect(await worker.runOnce()).toBe(false);
    expect(await ctx.jobs.getJob(queuedJobId)).toMatchObject({ status: "queued", startedAt: null, lockedBy: null, leaseVersion: 0 });
  });

  it("does not claim work past a queued exclusive barrier", async () => {
    const fixtures = await Promise.all([
      insertCopySymlink({ itemName: "Before Barrier Copy", kind: "remote", storagePolicy: "location_1", content: "before barrier" }),
      insertCopySymlink({ itemName: "After Barrier Copy", kind: "remote", storagePolicy: "location_1", content: "after barrier" })
    ]);
    const firstCopyId = await ctx.jobs.startCopy({ direction: "to_local", linkIds: [fixtures[0].id] });
    const barrierId = await ctx.jobs.createJob("scan");
    const secondCopyId = await ctx.jobs.startCopy({ direction: "to_local", linkIds: [fixtures[1].id] });
    const concurrency = {
      workerCount: 3,
      maxRunningJobs: 3,
      maxRunningScans: 3,
      maxRunningAudits: 3,
      maxRunningCopies: 3,
      copyFileConcurrency: 1,
      maxActiveCopyFiles: 3
    };
    const firstWorker = new JobWorker(ctx.database.db, { workerId: "barrier-worker-1", logger: silentLogger, concurrency }) as unknown as {
      claimNextJob(): Promise<{ job: { id: number } } | null>;
    };
    const secondWorker = new JobWorker(ctx.database.db, { workerId: "barrier-worker-2", logger: silentLogger, concurrency }) as unknown as {
      claimNextJob(): Promise<{ job: { id: number } } | null>;
    };

    await expect(firstWorker.claimNextJob()).resolves.toMatchObject({ job: { id: firstCopyId } });
    await expect(secondWorker.claimNextJob()).resolves.toBeNull();
    expect(await ctx.jobs.getJob(barrierId)).toMatchObject({ status: "queued", exclusive: true });
    expect(await ctx.jobs.getJob(secondCopyId)).toMatchObject({ status: "queued", exclusive: false });
  });

  it("reclaims stale running scan jobs in the worker process", async () => {
    const staleStartedAt = new Date(Date.now() - 30 * 60_000).toISOString();
    await fs.mkdir(path.join(tmpDir, "remote", "Recovered Release"), { recursive: true });
    await fs.writeFile(path.join(tmpDir, "remote", "Recovered Release", "remote.mkv"), "remote");

    const job = await first(ctx.database.db
      .insert(schema.jobs)
      .values({
        type: "scan",
        status: "running",
        createdAt: staleStartedAt,
        startedAt: staleStartedAt,
        finishedAt: null,
        progress: JSON.stringify({
          options: { scanSymlinks: false, scanLocal: false, scanRemote: true, symlinkSections: [], localSections: [] }
        })
      })
      .returning({ id: schema.jobs.id }));
    if (!job) throw new Error("Stale job was not inserted");
    await insertRunningScanRun(job.id, staleStartedAt);

    const worker = new JobWorker(ctx.database.db, { workerId: "reclaim-worker", reclaimStaleAfterMs: 1, pollIntervalMs: 1, heartbeatIntervalMs: 10, logger: silentLogger });
    expect(await worker.runOnce()).toBe(true);

    expect(await ctx.jobs.getJob(job.id)).toMatchObject({ status: "completed", lockedBy: null, heartbeatAt: null });
    const scanRuns = await ctx.database.db.select().from(schema.scanRuns).where(eq(schema.scanRuns.jobId, job.id));
    expect(scanRuns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: "failed", errorMessage: "Stale running job lease fenced and requeued" }),
        expect.objectContaining({ status: "completed", remoteFiles: 1 })
      ])
    );
  });

  it("reclaims interrupted jobs locked by the same worker before the global stale timeout", async () => {
    const interruptedStartedAt = new Date(Date.now() - 60_000).toISOString();
    await fs.mkdir(path.join(tmpDir, "remote", "Interrupted Release"), { recursive: true });
    await fs.writeFile(path.join(tmpDir, "remote", "Interrupted Release", "remote.mkv"), "remote");

    const job = await first(ctx.database.db
      .insert(schema.jobs)
      .values({
        type: "scan",
        status: "running",
        createdAt: interruptedStartedAt,
        startedAt: interruptedStartedAt,
        finishedAt: null,
        lockedBy: "same-worker",
        lockedAt: interruptedStartedAt,
        heartbeatAt: interruptedStartedAt,
        progress: JSON.stringify({
          options: { scanSymlinks: false, scanLocal: false, scanRemote: true, symlinkSections: [], localSections: [] }
        })
      })
      .returning({ id: schema.jobs.id }));
    if (!job) throw new Error("Interrupted job was not inserted");
    await insertRunningScanRun(job.id, interruptedStartedAt);

    const worker = new JobWorker(ctx.database.db, {
      workerId: "same-worker",
      reclaimStaleAfterMs: 60 * 60_000,
      reclaimOwnInterruptedAfterMs: 1,
      pollIntervalMs: 1,
      heartbeatIntervalMs: 10,
      logger: silentLogger
    });
    expect(await worker.runOnce()).toBe(true);

    expect(await ctx.jobs.getJob(job.id)).toMatchObject({ status: "completed", lockedBy: null, heartbeatAt: null });
    expect(await ctx.jobs.listEvents(job.id)).toEqual(expect.arrayContaining([expect.objectContaining({ message: "Interrupted job lease fenced and requeued" })]));
  });

  it("allows exactly one worker to reclaim a stale lease and increments its version", async () => {
    const staleStartedAt = new Date(Date.now() - 30 * 60_000).toISOString();
    const job = await first(
      ctx.database.db
        .insert(schema.jobs)
        .values({
          type: "scan",
          status: "running",
          createdAt: staleStartedAt,
          startedAt: staleStartedAt,
          finishedAt: null,
          lockedBy: "dead-worker",
          lockedAt: staleStartedAt,
          heartbeatAt: staleStartedAt,
          leaseVersion: 7,
          exclusive: true,
          progress: JSON.stringify({
            options: { scanSymlinks: false, scanLocal: false, scanRemote: true, symlinkSections: [], localSections: [] }
          })
        })
        .returning({ id: schema.jobs.id })
    );
    if (!job) throw new Error("Stale lease job was not inserted");
    await insertRunningScanRun(job.id, staleStartedAt);
    const workers = ["stale-contender-1", "stale-contender-2"].map(
      (workerId) =>
        new JobWorker(ctx.database.db, {
          workerId,
          reclaimStaleAfterMs: 60_000,
          pollIntervalMs: 1,
          heartbeatIntervalMs: 10,
          logger: silentLogger
        })
    );

    const results = await Promise.all(workers.map((worker) => worker.runOnce()));

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await ctx.jobs.getJob(job.id)).toMatchObject({ status: "completed", leaseVersion: 9, lockedBy: null });
    expect((await ctx.jobs.listEvents(job.id)).filter((event) => event.message === "Stale running job lease fenced and requeued")).toHaveLength(1);
  });

  it("rejects progress, finish, and requeue writes from an old lease", async () => {
    const timestamp = new Date().toISOString();
    const inserted = await first(
      ctx.database.db
        .insert(schema.jobs)
        .values({
          type: "copy",
          status: "running",
          createdAt: timestamp,
          startedAt: timestamp,
          finishedAt: null,
          lockedBy: "old-lease-worker",
          lockedAt: timestamp,
          heartbeatAt: timestamp,
          leaseVersion: 3,
          exclusive: false,
          progress: JSON.stringify({ stage: "original" })
        })
        .returning()
    );
    if (!inserted) throw new Error("Old lease job was not inserted");
    const worker = new JobWorker(ctx.database.db, { workerId: "old-lease-worker", logger: silentLogger });
    const fencedWorker = worker as unknown as {
      setLeasedProgress(job: unknown, progress: unknown): Promise<void>;
      addLeasedEvent(job: unknown, level: "info", message: string, data?: unknown): Promise<void>;
      heartbeat(job: unknown): Promise<void>;
      finishJob(job: unknown, status: "completed", level: "info", message: string): Promise<void>;
      requeueInterruptedJob(job: unknown, message?: string): Promise<void>;
    };
    await ctx.database.db
      .update(schema.jobs)
      .set({ lockedBy: "replacement-worker", leaseVersion: 4, heartbeatAt: new Date().toISOString() })
      .where(eq(schema.jobs.id, inserted.id));

    await expect(fencedWorker.setLeasedProgress(inserted, { stage: "stale" })).rejects.toMatchObject({ name: "LeaseLostError" });
    await expect(fencedWorker.addLeasedEvent(inserted, "info", "stale event")).rejects.toMatchObject({ name: "LeaseLostError" });
    await expect(fencedWorker.heartbeat(inserted)).rejects.toMatchObject({ name: "LeaseLostError" });
    await expect(fencedWorker.finishJob(inserted, "completed", "info", "stale finish")).rejects.toMatchObject({ name: "LeaseLostError" });
    await expect(fencedWorker.requeueInterruptedJob(inserted)).rejects.toMatchObject({ name: "LeaseLostError" });
    expect(await ctx.jobs.getJob(inserted.id)).toMatchObject({
      status: "running",
      lockedBy: "replacement-worker",
      leaseVersion: 4,
      progress: { stage: "original" }
    });
    expect(await ctx.jobs.listEvents(inserted.id)).toEqual([]);
  });

  it("saves section display titles and types separately from symlink directory names", async () => {
    const cookie = await createAdminSession();

    const save = await ctx.app.inject({
      method: "PUT",
      url: "/api/settings/sections",
      headers: { cookie },
      payload: {
        sections: ["shows4k", "movies", "anime"],
        sectionTitles: { shows4k: "4K Shows", movies: "", anime: "Anime", unused: "Ignored" },
        sectionTypes: { shows4k: "shows", movies: "movies", anime: "shows", unused: "movies" }
      }
    });
    expect(save.statusCode).toBe(200);
    expect(save.json()).toEqual({
      sections: ["shows4k", "movies", "anime"],
      sectionTitles: { shows4k: "4K Shows", anime: "Anime" },
      sectionTypes: { shows4k: "shows", movies: "movies", anime: "shows" }
    });

    const settings = await ctx.app.inject({ method: "GET", url: "/api/settings/sections", headers: { cookie } });
    expect(settings.statusCode).toBe(200);
    expect(settings.json()).toEqual({
      sections: ["shows4k", "movies", "anime"],
      sectionTitles: { shows4k: "4K Shows", anime: "Anime" },
      sectionTypes: { shows4k: "shows", movies: "movies", anime: "shows" }
    });

    await insertMediaLink("Example Show", "remote", "shows4k", path.join("Example Show", "Season 01", "episode-1.mkv"));
    await insertMediaLink("Example Anime", "remote", "anime", path.join("Example Anime", "Season 01", "episode-1.mkv"));

    const sections = await ctx.app.inject({ method: "GET", url: "/api/sections", headers: { cookie } });
    expect(sections.statusCode).toBe(200);
    expect(sections.json<Array<{ section: string; title: string; type: SectionContentType; seasonCount: number }>>()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ section: "shows4k", title: "4K Shows", type: "shows", seasonCount: 1 }),
        expect.objectContaining({ section: "movies", title: "movies", type: "movies" }),
        expect.objectContaining({ section: "anime", title: "Anime", type: "shows", seasonCount: 1 })
      ])
    );
  });

  it("rejects section configuration changes while queued work could depend on them", async () => {
    const cookie = await createAdminSession();
    const jobId = await ctx.jobs.startScan({ scanSymlinks: true, scanLocal: false, scanRemote: false });

    const response = await ctx.app.inject({
      method: "PUT",
      url: "/api/settings/sections",
      headers: { cookie },
      payload: { sections: ["movies"], sectionTitles: {}, sectionTypes: { movies: "movies" } }
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: expect.stringContaining(`scan job #${jobId} is queued`) });
    await expect(ctx.jobs.terminate(jobId)).resolves.toBe(true);
  });

  it("rejects storage policy changes overlapping a queued copy while allowing a disjoint title", async () => {
    const cookie = await createAdminSession();
    const copyFixture = await insertCopySymlink({
      itemName: "Policy Copy Movie",
      kind: "remote",
      storagePolicy: "location_1",
      content: "copy remains isolated"
    });
    const disjointLinkId = await insertMediaLink("Disjoint Policy Movie");
    const copyJobId = await ctx.jobs.startCopy({ direction: "to_local", linkIds: [copyFixture.id] });

    const overlapping = await ctx.app.inject({
      method: "POST",
      url: "/api/storage-policies",
      headers: { cookie },
      payload: { title: "Policy Copy Movie", policy: "location_2" }
    });
    expect(overlapping.statusCode).toBe(409);
    expect(overlapping.json()).toMatchObject({ error: expect.stringContaining(`copy job #${copyJobId} is queued for the same media`) });
    expect(await first(ctx.database.db.select().from(schema.mediaLinks).where(eq(schema.mediaLinks.id, copyFixture.id)).limit(1))).toMatchObject({
      storagePolicy: "location_1"
    });

    const disjoint = await ctx.app.inject({
      method: "POST",
      url: "/api/storage-policies",
      headers: { cookie },
      payload: { title: "Disjoint Policy Movie", policy: "location_2" }
    });
    expect(disjoint.statusCode).toBe(200);
    expect(disjoint.json()).toMatchObject({ title: "Disjoint Policy Movie", policy: "location_2" });
    expect(await first(ctx.database.db.select().from(schema.mediaLinks).where(eq(schema.mediaLinks.id, disjointLinkId)).limit(1))).toMatchObject({
      storagePolicy: "location_2"
    });
  });

  it("rejects bulk and delete policy mutations overlapping a running audit", async () => {
    const cookie = await createAdminSession();
    const linkId = await insertMediaLink("Policy Audit Movie");
    const assigned = await ctx.app.inject({
      method: "POST",
      url: "/api/storage-policies",
      headers: { cookie },
      payload: { title: "Policy Audit Movie", policy: "location_2" }
    });
    expect(assigned.statusCode).toBe(200);
    const policyId = assigned.json<{ id: number }>().id;

    const auditJobId = await ctx.jobs.startAudit({ mode: "fast", linkIds: [linkId] });
    const timestamp = new Date().toISOString();
    await ctx.database.db
      .update(schema.jobs)
      .set({ status: "running", startedAt: timestamp, lockedBy: "policy-test-worker", lockedAt: timestamp, heartbeatAt: timestamp })
      .where(eq(schema.jobs.id, auditJobId));

    const bulk = await ctx.app.inject({
      method: "POST",
      url: "/api/storage-policies/bulk",
      headers: { cookie },
      payload: { titles: ["Policy Audit Movie"], policy: "location_1" }
    });
    expect(bulk.statusCode).toBe(409);
    expect(bulk.json()).toMatchObject({ error: expect.stringContaining(`audit job #${auditJobId} is running for the same media`) });

    const remove = await ctx.app.inject({ method: "DELETE", url: `/api/storage-policies/${policyId}`, headers: { cookie } });
    expect(remove.statusCode).toBe(409);
    expect(remove.json()).toMatchObject({ error: expect.stringContaining(`audit job #${auditJobId} is running for the same media`) });
    expect(await first(ctx.database.db.select().from(schema.mediaLinks).where(eq(schema.mediaLinks.id, linkId)).limit(1))).toMatchObject({
      storagePolicy: "location_2"
    });
    expect(await first(ctx.database.db.select().from(schema.storagePolicies).where(eq(schema.storagePolicies.id, policyId)).limit(1))).toMatchObject({
      policy: "location_2"
    });
  });

  it("applies canonical-equivalent media policies without assigning unlinked storage files", async () => {
    const cookie = await createAdminSession();
    const ampersandLinkId = await insertMediaLink("Rock & Roll Movie");
    const wordLinkId = await insertMediaLink("Rock and Roll Movie");
    await insertStorageFile("remote", path.join("movies", "Rock & Roll Movie", "ampersand.mkv"));
    await insertStorageFile("remote", path.join("movies", "Rock and Roll Movie", "word.mkv"));

    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/storage-policies",
      headers: { cookie },
      payload: { title: "Rock and Roll Movie", policy: "location_2" }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ policy: "location_2", linkCount: 2, fileCount: 2 });
    const links = await ctx.database.db
      .select({ id: schema.mediaLinks.id, storagePolicy: schema.mediaLinks.storagePolicy })
      .from(schema.mediaLinks)
      .where(inArray(schema.mediaLinks.id, [ampersandLinkId, wordLinkId]));
    expect(links).toHaveLength(2);
    expect(links.every((link) => link.storagePolicy === "location_2")).toBe(true);
    const files = await ctx.database.db
      .select({ itemName: schema.storageFiles.itemName, storagePolicy: schema.storageFiles.storagePolicy })
      .from(schema.storageFiles)
      .where(inArray(schema.storageFiles.itemName, ["Rock & Roll Movie", "Rock and Roll Movie"]));
    expect(files).toHaveLength(2);
    expect(files.every((file) => file.storagePolicy === "unassigned")).toBe(true);
  });

  it("does not treat a completed copy source as storage policy work after its symlink moves local", async () => {
    const cookie = await createAdminSession();
    const itemName = "Completed Source Movie";
    const remoteStorageFileId = await insertStorageFile("remote", path.join("movies", itemName, "remote-source.mkv"));
    const localStorageFileId = await insertStorageFile("local", path.join("movies", itemName, "local-copy.mkv"));
    const linkId = await insertMediaLink(itemName, "remote", "movies", undefined, "location_1", remoteStorageFileId);
    const localStorageFile = await first(ctx.database.db.select().from(schema.storageFiles).where(eq(schema.storageFiles.id, localStorageFileId)).limit(1));
    if (!localStorageFile) throw new Error("Local storage fixture was not found");
    await ctx.database.db
      .update(schema.mediaLinks)
      .set({ kind: "local", targetPath: localStorageFile.filePath, resolvedStorageFileId: localStorageFileId, updatedAt: new Date().toISOString() })
      .where(eq(schema.mediaLinks.id, linkId));
    await ctx.database.db.update(schema.storageFiles).set({ storagePolicy: "location_1" }).where(eq(schema.storageFiles.id, remoteStorageFileId));

    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/storage-policies",
      headers: { cookie },
      payload: { title: itemName, policy: "location_1" }
    });

    expect(response.statusCode).toBe(200);
    expect(await first(ctx.database.db.select().from(schema.storageFiles).where(eq(schema.storageFiles.id, remoteStorageFileId)).limit(1))).toMatchObject({
      storagePolicy: "unassigned"
    });
    expect(await first(ctx.database.db.select().from(schema.storageFiles).where(eq(schema.storageFiles.id, localStorageFileId)).limit(1))).toMatchObject({
      storagePolicy: "location_1"
    });
    await expect(getInventorySummary(ctx.database.db)).resolves.toMatchObject({
      actionableRemoteFiles: 0,
      unassignedRemoteFiles: 1
    });
  });

  it("manages storage policies and bulk assignments", async () => {
    const cookie = await createAdminSession();
    await ensureSection("anime", null, "shows");
    await insertMediaLink("Manual Movie");
    await insertMediaLink("Manual Show", "remote", "shows");
    await insertMediaLink("Anime Series", "remote", "anime", path.join("Anime Series", "Season 01", "episode-1.mkv"));
    await insertMediaLink("Catfish The TV Show (2012)", "remote", "shows");
    await insertStorageFile("remote", path.join("movies", "Manual Movie", "manual-movie.mkv"));
    await insertStorageFile("remote", path.join("shows", "Manual Show", "Season 01", "episode-1.mkv"));
    await insertStorageFile("remote", path.join("movies", "Orphan Only", "orphan.mkv"));

    const unassigned = await ctx.app.inject({ method: "GET", url: "/api/storage-policies?policy=unassigned", headers: { cookie } });
    expect(unassigned.statusCode).toBe(200);
    const unassignedRows = unassigned.json<Array<{ title: string; policy: string }>>();
    expect(unassignedRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ title: "Manual Movie", policy: "unassigned" }),
        expect.objectContaining({ title: "Manual Show", policy: "unassigned" })
      ])
    );
    expect(unassignedRows).not.toEqual(expect.arrayContaining([expect.objectContaining({ title: "Orphan Only" })]));

    const candidates = await ctx.app.inject({ method: "GET", url: "/api/storage-policies/candidates?q=manual", headers: { cookie } });
    expect(candidates.statusCode).toBe(200);
    expect(candidates.json()).toMatchObject([
      { title: "Manual Movie", normalizedTitle: "manual movie", category: "movies", sections: ["movies"], linkCount: 1, remoteLinkCount: 1, sectionCount: 1 },
      { title: "Manual Show", normalizedTitle: "manual show", category: "shows", sections: ["shows"], linkCount: 1, remoteLinkCount: 1, sectionCount: 1 }
    ]);

    const keywordCandidates = await ctx.app.inject({ method: "GET", url: "/api/storage-policies/candidates?q=show%20manual", headers: { cookie } });
    expect(keywordCandidates.statusCode).toBe(200);
    expect(keywordCandidates.json()).toMatchObject([{ title: "Manual Show", category: "shows" }]);

    const animeCandidates = await ctx.app.inject({ method: "GET", url: "/api/storage-policies/candidates?q=anime", headers: { cookie } });
    expect(animeCandidates.statusCode).toBe(200);
    expect(animeCandidates.json()).toMatchObject([{ title: "Anime Series", category: "shows", sections: ["anime"] }]);

    const orphanCandidates = await ctx.app.inject({ method: "GET", url: "/api/storage-policies/candidates?q=orphan", headers: { cookie } });
    expect(orphanCandidates.statusCode).toBe(200);
    expect(orphanCandidates.json()).toEqual([]);

    const invalidAdd = await ctx.app.inject({
      method: "POST",
      url: "/api/storage-policies",
      headers: { cookie },
      payload: { title: "Manual Movie (2024)", policy: "location_2" }
    });
    expect(invalidAdd.statusCode).toBe(400);
    expect(invalidAdd.json()).toMatchObject({ error: "Choose a title from the scanned library." });

    const orphanAdd = await ctx.app.inject({
      method: "POST",
      url: "/api/storage-policies",
      headers: { cookie },
      payload: { title: "Orphan Only", policy: "location_1" }
    });
    expect(orphanAdd.statusCode).toBe(400);
    expect(orphanAdd.json()).toMatchObject({ error: "Choose a title from the scanned library." });

    const legacyPolicyAdd = await ctx.app.inject({
      method: "POST",
      url: "/api/storage-policies",
      headers: { cookie },
      payload: { title: "Manual Movie", policy: "assign_remote" }
    });
    expect(legacyPolicyAdd.statusCode).toBe(400);

    const add = await ctx.app.inject({
      method: "POST",
      url: "/api/storage-policies",
      headers: { cookie },
      payload: { title: "Manual Movie", policy: "location_2" }
    });
    expect(add.statusCode).toBe(200);
    expect(add.json()).toMatchObject({
      title: "Manual Movie",
      normalizedTitle: "manual movie",
      policy: "location_2",
      category: "movies",
      sections: ["movies"],
      linkCount: 1,
      remoteLinkCount: 1,
      source: "manual"
    });

    const assignRemoteAfterAdd = await ctx.app.inject({ method: "GET", url: "/api/storage-policies?policy=location_2", headers: { cookie } });
    expect(assignRemoteAfterAdd.statusCode).toBe(200);
    expect(assignRemoteAfterAdd.json<Array<{ title: string; policy: string; category: string; sections: string[] }>>().find((item) => item.title === "Manual Movie")).toMatchObject({
      policy: "location_2",
      category: "movies",
      sections: ["movies"]
    });

    const candidatesAfterAdd = await ctx.app.inject({ method: "GET", url: "/api/storage-policies/candidates?q=manual", headers: { cookie } });
    expect(candidatesAfterAdd.statusCode).toBe(200);
    expect(candidatesAfterAdd.json()).toMatchObject([{ title: "Manual Show", category: "shows" }]);

    const linksAfterAdd = await ctx.app.inject({ method: "GET", url: "/api/media-links?kind=remote", headers: { cookie } });
    expect(linksAfterAdd.json<Array<{ itemName: string; storagePolicy: string }>>().find((link) => link.itemName === "Manual Movie")).toMatchObject({
      storagePolicy: "location_2"
    });

    const invalidBulkAssign = await ctx.app.inject({
      method: "POST",
      url: "/api/storage-policies/bulk",
      headers: { cookie },
      payload: { titles: ["Manual Movie", "Orphan Only"], policy: "location_2" }
    });
    expect(invalidBulkAssign.statusCode).toBe(400);
    expect(invalidBulkAssign.json()).toMatchObject({ error: "Choose titles from the scanned library: Orphan Only" });

    const bulkAssign = await ctx.app.inject({
      method: "POST",
      url: "/api/storage-policies/bulk",
      headers: { cookie },
      payload: { titles: ["Manual Movie", "Manual Show", "Manual Show"], policy: "location_2" }
    });
    expect(bulkAssign.statusCode).toBe(200);
    expect(bulkAssign.json()).toMatchObject({
      updated: 2,
      policy: "location_2",
      items: expect.arrayContaining([
        expect.objectContaining({ title: "Manual Movie", policy: "location_2" }),
        expect.objectContaining({ title: "Manual Show", policy: "location_2" })
      ])
    });

    const linksAfterBulkAssign = await ctx.app.inject({ method: "GET", url: "/api/media-links?kind=remote&storagePolicy=location_2", headers: { cookie } });
    expect(linksAfterBulkAssign.json<Array<{ itemName: string; storagePolicy: string }>>()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ itemName: "Manual Movie", storagePolicy: "location_2" }),
        expect.objectContaining({ itemName: "Manual Show", storagePolicy: "location_2" })
      ])
    );

    const filesAfterBulkAssign = await ctx.app.inject({ method: "GET", url: "/api/storage-files?rootType=remote", headers: { cookie } });
    expect(filesAfterBulkAssign.json<Array<{ itemName: string; storagePolicy: string }>>()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ itemName: "Manual Movie", storagePolicy: "unassigned" }),
        expect.objectContaining({ itemName: "Manual Show", storagePolicy: "unassigned" })
      ])
    );

    const assignLocal = await ctx.app.inject({
      method: "POST",
      url: "/api/storage-policies",
      headers: { cookie },
      payload: { title: "Manual Movie", policy: "location_1" }
    });
    expect(assignLocal.statusCode).toBe(200);
    expect(assignLocal.json()).toMatchObject({ title: "Manual Movie", policy: "location_1" });

    const linksAfterAssignLocal = await ctx.app.inject({ method: "GET", url: "/api/media-links?kind=remote&storagePolicy=location_1", headers: { cookie } });
    expect(linksAfterAssignLocal.json<Array<{ itemName: string; storagePolicy: string }>>().find((link) => link.itemName === "Manual Movie")).toMatchObject({
      storagePolicy: "location_1"
    });

    const manualId = assignLocal.json<{ id: number }>().id;
    const removeManual = await ctx.app.inject({ method: "DELETE", url: `/api/storage-policies/${manualId}`, headers: { cookie } });
    expect(removeManual.statusCode).toBe(200);

    const linksAfterRemove = await ctx.app.inject({ method: "GET", url: "/api/media-links?kind=remote", headers: { cookie } });
    expect(linksAfterRemove.json<Array<{ itemName: string; storagePolicy: string }>>().find((link) => link.itemName === "Manual Movie")).toMatchObject({
      storagePolicy: "unassigned"
    });

    const bulkUnassign = await ctx.app.inject({
      method: "POST",
      url: "/api/storage-policies/bulk",
      headers: { cookie },
      payload: { titles: ["Manual Show"], policy: "unassigned" }
    });
    expect(bulkUnassign.statusCode).toBe(200);
    expect(bulkUnassign.json()).toMatchObject({ updated: 1, policy: "unassigned" });

    const afterUnassign = await ctx.app.inject({ method: "GET", url: "/api/storage-policies?policy=location_2", headers: { cookie } });
    expect(afterUnassign.statusCode).toBe(200);
    expect(afterUnassign.json<Array<{ title: string }>>().map((item) => item.title)).not.toContain("Manual Show");
  });

  it("can force-transition current local titles to assign local", async () => {
    const timestamp = new Date().toISOString();
    const normalizedTitle = normalizeTitle("Existing Local Title");
    await insertMediaLink("Existing Local Title", "local", "movies", undefined, "location_2");
    await ctx.database.db.insert(schema.storagePolicies).values({ title: "Existing Local Title", normalizedTitle, policy: "location_2", source: "manual", updatedAt: timestamp });

    const result = await bootstrapLocalStoragePolicies(ctx.database.db, { overwriteExisting: true, source: "current-local-backfill" });

    expect(result).toEqual({ foundLocalTitles: 1, assignedLocal: 1, skippedExistingPolicy: 0 });
    expect(await first(ctx.database.db.select().from(schema.storagePolicies).where(eq(schema.storagePolicies.normalizedTitle, normalizedTitle)).limit(1))).toMatchObject({
      title: "Existing Local Title",
      policy: "location_1",
      source: "current-local-backfill"
    });
    expect(await ctx.database.db.select().from(schema.mediaLinks)).toMatchObject([{ itemName: "Existing Local Title", storagePolicy: "location_1" }]);
  });

  it("returns media links through a bounded page endpoint", async () => {
    const cookie = await createAdminSession();
    await insertMediaLink("First Remote Movie");
    await insertMediaLink("Second Remote Movie");
    await insertMediaLink("Local Movie", "local");

    const firstPage = await ctx.app.inject({ method: "GET", url: "/api/media-links/page?kind=remote&limit=1&offset=0", headers: { cookie } });
    expect(firstPage.statusCode).toBe(200);
    expect(firstPage.json()).toMatchObject({
      total: 2,
      limit: 1,
      offset: 0,
      hasMore: true,
      rows: [{ itemName: "Second Remote Movie", kind: "remote" }]
    });

    const secondPage = await ctx.app.inject({ method: "GET", url: "/api/media-links/page?kind=remote&limit=1&offset=1", headers: { cookie } });
    expect(secondPage.statusCode).toBe(200);
    expect(secondPage.json()).toMatchObject({
      total: 2,
      limit: 1,
      offset: 1,
      hasMore: false,
      rows: [{ itemName: "First Remote Movie", kind: "remote" }]
    });
  });

  it("returns selected media links by id in requested order", async () => {
    const cookie = await createAdminSession();
    const firstId = await insertMediaLink("First Selected Title");
    const secondId = await insertMediaLink("Second Selected Title");
    await insertMediaLink("Unselected Title");

    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/media-links/by-ids",
      headers: { cookie },
      payload: { ids: [secondId, firstId, secondId, 999999] }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject([
      { id: secondId, itemName: "Second Selected Title" },
      { id: firstId, itemName: "First Selected Title" }
    ]);
  });

  it("accepts explicit copy and audit selections larger than the old 1000-item preview limit", async () => {
    const cookie = await createAdminSession();
    const linkIds = Array.from({ length: 1_001 }, (_unused, index) => index + 1);

    const copy = await ctx.app.inject({
      method: "POST",
      url: "/api/copies",
      headers: { cookie },
      payload: { direction: "to_local", linkIds }
    });
    expect(copy.statusCode).toBe(200);
    const copyJobId = copy.json<{ jobId: number }>().jobId;
    await expect(ctx.jobs.getJob(copyJobId)).resolves.toMatchObject({ status: "queued", selection: { total: 0, titles: [] } });

    const audit = await ctx.app.inject({
      method: "POST",
      url: "/api/audits",
      headers: { cookie },
      payload: { mode: "fast", linkIds }
    });
    expect(audit.statusCode).toBe(200);
    const auditJobId = audit.json<{ jobId: number }>().jobId;
    await expect(ctx.jobs.getJob(auditJobId)).resolves.toMatchObject({ status: "queued", selection: { total: 0, titles: [] } });

    await expect(ctx.jobs.terminate(copyJobId)).resolves.toBe(true);
    await expect(ctx.jobs.terminate(auditJobId)).resolves.toBe(true);
  });

  it("filters media link pages by section and storage policy", async () => {
    const cookie = await createAdminSession();
    await insertMediaLink("Remote Movie", "remote", "movies");
    await insertMediaLink("Assign Local Show", "remote", "shows", path.join("Assign Local Show", "Season 01", "episode-1.mkv"), "location_1");
    await insertMediaLink("Assign Local Show", "remote", "shows", path.join("Assign Local Show", "Season 02", "episode-2.mkv"), "location_1");
    await insertMediaLink("Assign Remote Show", "remote", "shows", undefined, "location_2");
    await insertMediaLink("Local Show", "local", "shows");

    const assignLocalShows = await ctx.app.inject({
      method: "GET",
      url: "/api/media-links/page?kind=remote&section=shows&storagePolicy=location_1&limit=10&offset=0",
      headers: { cookie }
    });
    expect(assignLocalShows.statusCode).toBe(200);
    expect(assignLocalShows.json()).toMatchObject({
      total: 2,
      rows: [
        { itemName: "Assign Local Show", kind: "remote", section: "shows", storagePolicy: "location_1" },
        { itemName: "Assign Local Show", kind: "remote", section: "shows", storagePolicy: "location_1" }
      ]
    });

    const assignLocalSeason = await ctx.app.inject({
      method: "GET",
      url: `/api/media-links/page?kind=remote&section=shows&storagePolicy=location_1&relativePathPrefix=${encodeURIComponent(path.join("Assign Local Show", "Season 02"))}&limit=10&offset=0`,
      headers: { cookie }
    });
    expect(assignLocalSeason.statusCode).toBe(200);
    expect(assignLocalSeason.json()).toMatchObject({
      total: 1,
      rows: [{ itemName: "Assign Local Show", relativePath: path.join("Assign Local Show", "Season 02", "episode-2.mkv") }]
    });

    const searchedShows = await ctx.app.inject({
      method: "GET",
      url: "/api/media-links/page?section=shows&search=assign-remote&limit=10&offset=0",
      headers: { cookie }
    });
    expect(searchedShows.statusCode).toBe(200);
    expect(searchedShows.json()).toMatchObject({
      total: 1,
      rows: [{ itemName: "Assign Remote Show" }]
    });

    const assignRemoteShows = await ctx.app.inject({
      method: "GET",
      url: "/api/media-links/page?kind=remote&section=shows&storagePolicy=location_2&limit=10&offset=0",
      headers: { cookie }
    });
    expect(assignRemoteShows.statusCode).toBe(200);
    expect(assignRemoteShows.json()).toMatchObject({
      total: 1,
      rows: [{ itemName: "Assign Remote Show", kind: "remote", section: "shows", storagePolicy: "location_2" }]
    });
  });

  it("returns media links as nested section trees", async () => {
    const cookie = await createAdminSession();
    await ensureSection("shows");
    await insertMediaLink("Tree Show", "remote", "shows", path.join("Tree Show", "Season 01", "episode-1.mkv"));
    await insertMediaLink("Tree Show", "local", "shows", path.join("Tree Show", "Season 01", "episode-2.mkv"));
    await insertMediaLink("Other Show", "remote", "shows", path.join("Other Show", "Season 01", "episode-1.mkv"));

    const sections = await ctx.app.inject({ method: "GET", url: "/api/sections", headers: { cookie } });
    expect(sections.statusCode).toBe(200);
    expect(sections.json<Array<{ section: string; title: string; itemCount: number; seasonCount: number; episodeCount: number }>>().find((section) => section.section === "shows")).toMatchObject({
      title: "shows",
      itemCount: 2,
      seasonCount: 2,
      episodeCount: 3
    });

    const root = await ctx.app.inject({ method: "GET", url: "/api/media-links/tree?section=shows", headers: { cookie } });
    expect(root.statusCode).toBe(200);
    expect(root.json()).toMatchObject({
      section: "shows",
      prefix: "",
      nodes: [
        { type: "folder", name: "Other Show", path: "Other Show", totalLinks: 1, childFolderCount: 1, remoteLinks: 1 },
        { type: "folder", name: "Tree Show", path: "Tree Show", totalLinks: 2, childFolderCount: 1, remoteLinks: 1, localLinks: 1 }
      ]
    });

    const mixed = await ctx.app.inject({ method: "GET", url: "/api/media-links/tree?section=shows&kind=mixed", headers: { cookie } });
    expect(mixed.statusCode).toBe(200);
    expect(mixed.json<{ nodes: Array<{ name: string }> }>().nodes.map((node) => node.name)).toEqual(["Tree Show"]);
    expect(mixed.json()).toMatchObject({
      nodes: [{ type: "folder", name: "Tree Show", remoteLinks: 1, localLinks: 1 }]
    });

    const season = await ctx.app.inject({
      method: "GET",
      url: `/api/media-links/tree?section=shows&prefix=${encodeURIComponent(path.join("Tree Show", "Season 01"))}`,
      headers: { cookie }
    });
    expect(season.statusCode).toBe(200);
    expect(season.json()).toMatchObject({
      prefix: "Tree Show/Season 01",
      parentPrefix: "Tree Show",
      nodes: [
        { type: "link", name: "episode-1.mkv", remoteLinks: 1, link: { kind: "remote" } },
        { type: "link", name: "episode-2.mkv", localLinks: 1, link: { kind: "local" } }
      ]
    });

    const remoteOnly = await ctx.app.inject({
      method: "GET",
      url: `/api/media-links/tree?section=shows&prefix=${encodeURIComponent(path.join("Tree Show", "Season 01"))}&kind=remote`,
      headers: { cookie }
    });
    expect(remoteOnly.statusCode).toBe(200);
    expect(remoteOnly.json()).toMatchObject({ nodes: [{ type: "link", name: "episode-1.mkv" }] });
  });

  it("returns storage files as nested folder trees", async () => {
    const cookie = await createAdminSession();
    const linkedStorageId = await insertStorageFile("remote", path.join("Release One", "remote.mkv"), 2048);
    await insertStorageFile("remote", path.join("Release One", "orphan.mkv"), 4096);
    await insertStorageFile("remote", path.join("Other Release", "other.mkv"), 512);
    await insertMediaLink("Release One", "remote", "movies", path.join("Release One", "remote.mkv"), "unassigned", linkedStorageId);

    const root = await ctx.app.inject({ method: "GET", url: "/api/storage-files/tree?rootType=remote", headers: { cookie } });
    expect(root.statusCode).toBe(200);
    expect(root.json()).toMatchObject({
      rootType: "remote",
      prefix: "",
      nodes: [
        { type: "folder", name: "Other Release", path: "Other Release", totalFiles: 1, linkedFiles: 0, orphanFiles: 1 },
        { type: "folder", name: "Release One", path: "Release One", totalFiles: 2, linkedFiles: 1, orphanFiles: 1 }
      ]
    });

    const release = await ctx.app.inject({
      method: "GET",
      url: `/api/storage-files/tree?rootType=remote&prefix=${encodeURIComponent("Release One")}`,
      headers: { cookie }
    });
    expect(release.statusCode).toBe(200);
    expect(release.json()).toMatchObject({
      prefix: "Release One",
      parentPrefix: null,
      nodes: [
        { type: "file", name: "orphan.mkv", totalFiles: 1, linkedFiles: 0, orphanFiles: 1, file: { linked: false, linkCount: 0 } },
        { type: "file", name: "remote.mkv", totalFiles: 1, linkedFiles: 1, orphanFiles: 0, file: { linked: true, linkCount: 1 } }
      ]
    });

    const orphans = await ctx.app.inject({
      method: "GET",
      url: `/api/storage-files/tree?rootType=remote&orphan=true&prefix=${encodeURIComponent("Release One")}`,
      headers: { cookie }
    });
    expect(orphans.statusCode).toBe(200);
    expect(orphans.json<{ nodes: Array<{ name: string }> }>().nodes.map((node) => node.name)).toEqual(["orphan.mkv"]);
  });
});
