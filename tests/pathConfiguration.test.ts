import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { desc, eq } from "drizzle-orm";
import { createApp, type AppContext } from "../src/server/app";
import { first } from "../src/server/db/database";
import * as schema from "../src/server/db/schema";
import { JobWorker } from "../src/server/jobs/jobRunner";
import { markOnboardingCompleteForExistingInstall } from "../src/server/lib/onboarding";
import { planPathMigration, reconcileEnvironmentPaths, runPathMigration } from "../src/server/lib/pathConfiguration";
import type { OnboardingState, PathConfigurationState } from "../src/shared/types";
import { createTestDatabase, type TestDatabaseHandle } from "./testDb";

const silentLogger = { info: () => undefined, warn: () => undefined, error: () => undefined };

describe("managed path configuration", () => {
  let tmpDir: string;
  let testDatabase: TestDatabaseHandle;
  let ctx: AppContext | null;
  let oldSymlinkDir: string;
  let oldLocalDir: string;
  let remoteDir: string;
  let newSymlinkDir: string;
  let newLocalDir: string;

  async function writeEnvironment(symlinkDir: string, localDir: string): Promise<void> {
    await fs.writeFile(
      path.join(tmpDir, ".env"),
      [`SYMLINK_DIR="${symlinkDir}"`, `SRTL_LOCATION_1_PATH="${localDir}"`, `SRTL_LOCATION_2_PATH="${remoteDir}"`].join("\n")
    );
  }

  async function openApp(): Promise<AppContext> {
    ctx = await createApp({ rootDir: tmpDir, dataDir: path.join(tmpDir, "data"), databaseUrl: testDatabase.databaseUrl });
    return ctx;
  }

  async function createAdminSession(app: AppContext, completeOnboarding = true): Promise<string> {
    const response = await app.app.inject({
      method: "POST",
      url: "/api/auth/setup",
      payload: { username: "admin", password: "password123", confirmPassword: "password123" }
    });
    expect(response.statusCode).toBe(200);
    if (completeOnboarding) await markOnboardingCompleteForExistingInstall(app.database.db);
    return String(response.headers["set-cookie"]);
  }

  async function restartWithPaths(symlinkDir: string, localDir: string): Promise<AppContext> {
    if (ctx) await ctx.app.close();
    ctx = null;
    await writeEnvironment(symlinkDir, localDir);
    return openApp();
  }

  async function insertIndexedSymlink(app: AppContext, itemName = "Example Title", fileName = "example.bin", relativeLink = false): Promise<{ linkId: number; linkPath: string; targetPath: string; fileSize: number }> {
    const relativePath = path.join("files", itemName, fileName);
    const targetPath = path.join(oldLocalDir, relativePath);
    const linkPath = path.join(oldSymlinkDir, relativePath);
    const content = `managed path migration fixture for ${itemName}`;
    const timestamp = new Date().toISOString();
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.mkdir(path.dirname(linkPath), { recursive: true });
    await fs.writeFile(targetPath, content);
    await fs.symlink(relativeLink ? path.relative(path.dirname(linkPath), targetPath) : targetPath, linkPath);
    const fileSize = Buffer.byteLength(content);
    const link = await first(
      app.database.db
        .insert(schema.mediaLinks)
        .values({
          section: "files",
          itemName,
          relativePath: path.join(itemName, fileName),
          linkPath,
          targetPath,
          kind: "local",
          targetExists: true,
          isMedia: true,
          storagePolicy: "location_1",
          resolvedStorageFileId: null,
          sizeBytes: fileSize,
          firstSeenAt: timestamp,
          lastSeenAt: timestamp,
          lastChangedAt: timestamp,
          missingSince: null,
          lastSeenJobId: null,
          updatedAt: timestamp
        })
        .returning({ id: schema.mediaLinks.id })
    );
    if (!link) throw new Error("Fixture media link was not inserted");
    const storage = await first(
      app.database.db
        .insert(schema.storageFiles)
        .values({
          rootType: "local",
          rootPath: oldLocalDir,
          section: "files",
          itemName,
          relativePath,
          filePath: targetPath,
          storagePolicy: "location_1",
          sizeBytes: fileSize,
          mtimeMs: Date.now(),
          firstSeenAt: timestamp,
          lastSeenAt: timestamp,
          lastChangedAt: timestamp,
          missingSince: null,
          lastSeenJobId: 1,
          updatedAt: timestamp
        })
        .returning({ id: schema.storageFiles.id })
    );
    if (!storage) throw new Error("Fixture storage file was not inserted");
    await app.database.db.update(schema.mediaLinks).set({ resolvedStorageFileId: storage.id }).where(eq(schema.mediaLinks.id, link.id));
    await app.database.db.insert(schema.copySources).values({ destinationPath: targetPath, sourcePath: path.join(remoteDir, relativePath), linkPath, recordedAt: timestamp });
    return { linkId: link.id, linkPath, targetPath, fileSize };
  }

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "srtl-paths-"));
    testDatabase = await createTestDatabase();
    ctx = null;
    oldSymlinkDir = path.join(tmpDir, "symlinks-old");
    oldLocalDir = path.join(tmpDir, "local-old");
    remoteDir = path.join(tmpDir, "remote");
    newSymlinkDir = path.join(tmpDir, "symlinks-new");
    newLocalDir = path.join(tmpDir, "local-new");
    await fs.mkdir(oldSymlinkDir, { recursive: true });
    await fs.mkdir(oldLocalDir, { recursive: true });
    await fs.mkdir(remoteDir, { recursive: true });
    await writeEnvironment(oldSymlinkDir, oldLocalDir);
  });

  afterEach(async () => {
    if (ctx) await ctx.app.close();
    await testDatabase.cleanup();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("adopts corrected environment paths directly before the initial inventory scan", async () => {
    const firstApp = await openApp();
    const cookie = await createAdminSession(firstApp, false);
    await fs.mkdir(path.join(newSymlinkDir, "movies"), { recursive: true });
    await fs.mkdir(newLocalDir, { recursive: true });

    const secondApp = await restartWithPaths(newSymlinkDir, newLocalDir);
    const pathState = (await secondApp.app.inject({ method: "GET", url: "/api/system/path-migration", headers: { cookie } })).json<PathConfigurationState>();
    expect(pathState).toMatchObject({
      blocking: false,
      status: "ready",
      activePaths: { symlinkDir: newSymlinkDir, localDir: newLocalDir, remoteDir }
    });
    const onboardingState = (await secondApp.app.inject({ method: "GET", url: "/api/onboarding", headers: { cookie } })).json<OnboardingState>();
    expect(onboardingState).toMatchObject({ phase: "configuration_required", detectedSections: ["movies"] });
    expect(await secondApp.database.db.select().from(schema.pathMigrations)).toEqual([]);
  });

  it("rejects managed roots that resolve to the same physical directory", async () => {
    const firstApp = await openApp();
    const cookie = await createAdminSession(firstApp);
    await insertIndexedSymlink(firstApp, "Physical Root Alias", "physical-root.bin");
    await fs.mkdir(newSymlinkDir, { recursive: true });
    await fs.symlink(remoteDir, newLocalDir, "dir");

    const secondApp = await restartWithPaths(newSymlinkDir, newLocalDir);
    const state = (await secondApp.app.inject({
      method: "GET",
      url: "/api/system/path-migration",
      headers: { cookie }
    })).json<PathConfigurationState>();

    expect(state).toMatchObject({ blocking: true, status: "invalid_environment" });
    expect(state.environmentErrors).toEqual([
      expect.stringContaining("resolve to the same or overlapping physical path")
    ]);
    const plan = await secondApp.app.inject({
      method: "POST",
      url: "/api/system/path-migration/plan",
      headers: { cookie },
      payload: { migrationId: state.migration?.id }
    });
    expect(plan.statusCode).toBe(409);
    expect(plan.json()).toMatchObject({ error: expect.stringContaining("same or overlapping physical path") });
  });

  it("accepts a remounted root at the same configured path and refreshes its transient identity", async () => {
    const firstApp = await openApp();
    const cookie = await createAdminSession(firstApp);
    const fixture = await insertIndexedSymlink(firstApp, "Same Path Replacement", "same-path.bin");
    const activeBefore = await first(firstApp.database.db.select().from(schema.pathConfigurations).where(eq(schema.pathConfigurations.status, "active")).limit(1));
    const displacedRoot = path.join(tmpDir, "local-displaced");
    const displacedTarget = path.join(displacedRoot, path.relative(oldLocalDir, fixture.targetPath));
    const replacementContent = await fs.readFile(fixture.targetPath);

    await fs.rename(oldLocalDir, displacedRoot);
    await fs.mkdir(path.dirname(fixture.targetPath), { recursive: true });
    await fs.writeFile(fixture.targetPath, replacementContent);
    expect(displacedTarget).not.toBe(fixture.targetPath);

    const secondApp = await restartWithPaths(oldSymlinkDir, oldLocalDir);
    const state = (await secondApp.app.inject({
      method: "GET",
      url: "/api/system/path-migration",
      headers: { cookie }
    })).json<PathConfigurationState>();
    const localChange = state.changes.find((change) => change.root === "local");
    const activeAfter = await first(secondApp.database.db.select().from(schema.pathConfigurations).where(eq(schema.pathConfigurations.status, "active")).limit(1));
    const refreshedIdentity = JSON.parse(activeAfter?.localIdentity ?? "null") as { device?: string; inode?: string } | null;
    const currentStat = await fs.stat(oldLocalDir, { bigint: true });

    expect(state).toMatchObject({ blocking: false, status: "ready", migration: null });
    expect(localChange).toMatchObject({ changed: false, identityMatch: "same", activePath: oldLocalDir, detectedPath: oldLocalDir });
    expect(activeAfter?.localIdentity).not.toBe(activeBefore?.localIdentity);
    expect(refreshedIdentity).toMatchObject({ device: String(currentStat.dev), inode: String(currentStat.ino) });
    expect(await secondApp.database.db.select().from(schema.pathMigrations)).toEqual([]);
  });

  it("fails closed when a planned target root is replaced before apply", async () => {
    const firstApp = await openApp();
    const cookie = await createAdminSession(firstApp);
    const fixture = await insertIndexedSymlink(firstApp, "Apply Root Replacement", "apply-root.bin");
    await fs.symlink(oldSymlinkDir, newSymlinkDir, "dir");
    await fs.symlink(oldLocalDir, newLocalDir, "dir");
    const secondApp = await restartWithPaths(newSymlinkDir, newLocalDir);
    const state = (await secondApp.app.inject({
      method: "GET",
      url: "/api/system/path-migration",
      headers: { cookie }
    })).json<PathConfigurationState>();
    const migrationId = state.migration?.id ?? 0;
    const plan = await secondApp.app.inject({
      method: "POST",
      url: "/api/system/path-migration/plan",
      headers: { cookie },
      payload: { migrationId }
    });
    expect(plan.statusCode).toBe(200);
    const apply = await secondApp.app.inject({
      method: "POST",
      url: "/api/system/path-migration/apply",
      headers: { cookie },
      payload: { migrationId, confirmSameStorage: true }
    });
    expect(apply.statusCode).toBe(200);
    const migrationJobId = apply.json<{ jobId: number }>().jobId;

    await fs.rm(newLocalDir);
    await fs.mkdir(newLocalDir, { recursive: true });
    const worker = new JobWorker(secondApp.database.db, {
      workerId: "root-replacement-worker",
      pollIntervalMs: 1,
      heartbeatIntervalMs: 10,
      logger: silentLogger
    });
    await expect(worker.runOnce()).resolves.toBe(true);

    await expect(secondApp.jobs.getJob(migrationJobId)).resolves.toMatchObject({ status: "failed" });
    await expect(
      first(secondApp.database.db.select().from(schema.pathMigrations).where(eq(schema.pathMigrations.id, migrationId)).limit(1))
    ).resolves.toMatchObject({
      status: "failed",
      errorMessage: expect.stringContaining("no longer matches the physical directory recorded during migration analysis")
    });
    expect(path.resolve(await fs.readlink(fixture.linkPath))).toBe(path.resolve(fixture.targetPath));
  });

  it("fails closed when an upgraded planned migration has no exact target identity", async () => {
    const firstApp = await openApp();
    const cookie = await createAdminSession(firstApp);
    const fixture = await insertIndexedSymlink(firstApp, "Legacy Planned Identity", "legacy-planned.bin");
    await fs.symlink(oldSymlinkDir, newSymlinkDir, "dir");
    await fs.symlink(oldLocalDir, newLocalDir, "dir");
    const secondApp = await restartWithPaths(newSymlinkDir, newLocalDir);
    const state = (await secondApp.app.inject({
      method: "GET",
      url: "/api/system/path-migration",
      headers: { cookie }
    })).json<PathConfigurationState>();
    const migrationId = state.migration?.id ?? 0;
    const plan = await secondApp.app.inject({
      method: "POST",
      url: "/api/system/path-migration/plan",
      headers: { cookie },
      payload: { migrationId }
    });
    expect(plan.statusCode).toBe(200);
    await secondApp.database.db
      .update(schema.pathMigrationItems)
      .set({ targetIdentity: null })
      .where(eq(schema.pathMigrationItems.migrationId, migrationId));
    const apply = await secondApp.app.inject({
      method: "POST",
      url: "/api/system/path-migration/apply",
      headers: { cookie },
      payload: { migrationId, confirmSameStorage: true }
    });
    expect(apply.statusCode).toBe(200);
    const jobId = apply.json<{ jobId: number }>().jobId;
    const worker = new JobWorker(secondApp.database.db, {
      workerId: "legacy-planned-identity-worker",
      pollIntervalMs: 1,
      heartbeatIntervalMs: 10,
      logger: silentLogger
    });

    await expect(worker.runOnce()).resolves.toBe(true);
    await expect(secondApp.jobs.getJob(jobId)).resolves.toMatchObject({ status: "failed" });
    await expect(
      first(secondApp.database.db.select().from(schema.pathMigrations).where(eq(schema.pathMigrations.id, migrationId)).limit(1))
    ).resolves.toMatchObject({
      status: "failed",
      errorMessage: expect.stringContaining("has no exact file identity")
    });
    expect(path.resolve(await fs.readlink(fixture.linkPath))).toBe(path.resolve(fixture.targetPath));
  });

  it("marks an ambiguous legacy failed copy journal for manual reconciliation", async () => {
    const app = await openApp();
    const fixture = await insertIndexedSymlink(app, "Legacy Failed Copy", "legacy-failed.bin");
    const copyJobId = await app.jobs.startCopy({ direction: "to_remote", linkIds: [fixture.linkId] });
    const originalLink = await first(app.database.db.select().from(schema.mediaLinks).where(eq(schema.mediaLinks.id, fixture.linkId)).limit(1));
    if (!originalLink) throw new Error("Legacy failed copy fixture was not found");
    const destinationPath = path.join(remoteDir, path.relative(oldLocalDir, fixture.targetPath));
    const timestamp = new Date().toISOString();
    await fs.mkdir(path.dirname(destinationPath), { recursive: true });
    await fs.copyFile(fixture.targetPath, destinationPath);
    await fs.rm(fixture.linkPath);
    await fs.symlink(destinationPath, fixture.linkPath);
    await app.database.db.update(schema.jobs).set({ status: "failed", finishedAt: timestamp }).where(eq(schema.jobs.id, copyJobId));
    const operation = await first(
      app.database.db
        .insert(schema.copyOperations)
        .values({
          jobId: copyJobId,
          mediaLinkId: fixture.linkId,
          linkPath: fixture.linkPath,
          sourcePath: fixture.targetPath,
          destinationPath,
          originalTargetPath: fixture.targetPath,
          originalLinkState: JSON.stringify(originalLink),
          previousCopySource: null,
          tempPath: null,
          displacedPath: null,
          tempIdentity: null,
          destinationIdentity: null,
          displacedIdentity: null,
          stage: "failed",
          resultStatus: null,
          localConflictStrategy: null,
          sizeBytes: fixture.fileSize,
          errorMessage: "Legacy worker stopped after repointing",
          createdAt: timestamp,
          updatedAt: timestamp,
          completedAt: timestamp
        })
        .returning({ id: schema.copyOperations.id })
    );
    if (!operation) throw new Error("Legacy failed copy operation was not inserted");

    await reconcileEnvironmentPaths(app.database.db, {
      symlinkDir: oldSymlinkDir,
      localDir: oldLocalDir,
      remoteDir
    });

    await expect(
      first(app.database.db.select().from(schema.copyOperations).where(eq(schema.copyOperations.id, operation.id)).limit(1))
    ).resolves.toMatchObject({
      stage: "reconciliation_required",
      completedAt: null,
      errorMessage: expect.stringContaining("library symlink no longer points to its original target")
    });
  });

  it("fences a legacy failed copy journal when an unowned destination artifact remains", async () => {
    const app = await openApp();
    const fixture = await insertIndexedSymlink(app, "Legacy Destination Artifact", "legacy-destination.bin");
    const copyJobId = await app.jobs.startCopy({ direction: "to_remote", linkIds: [fixture.linkId] });
    const originalLink = await first(app.database.db.select().from(schema.mediaLinks).where(eq(schema.mediaLinks.id, fixture.linkId)).limit(1));
    if (!originalLink) throw new Error("Legacy destination fixture was not found");
    const destinationPath = path.join(remoteDir, path.relative(oldLocalDir, fixture.targetPath));
    const timestamp = new Date().toISOString();
    await fs.mkdir(path.dirname(destinationPath), { recursive: true });
    await fs.copyFile(fixture.targetPath, destinationPath);
    await app.database.db.update(schema.jobs).set({ status: "failed", finishedAt: timestamp }).where(eq(schema.jobs.id, copyJobId));
    const operation = await first(
      app.database.db
        .insert(schema.copyOperations)
        .values({
          jobId: copyJobId,
          mediaLinkId: fixture.linkId,
          linkPath: fixture.linkPath,
          sourcePath: fixture.targetPath,
          destinationPath,
          originalTargetPath: fixture.targetPath,
          originalLinkState: JSON.stringify(originalLink),
          previousCopySource: null,
          tempPath: null,
          displacedPath: null,
          tempIdentity: null,
          destinationIdentity: null,
          displacedIdentity: null,
          stage: "failed",
          resultStatus: null,
          localConflictStrategy: null,
          sizeBytes: fixture.fileSize,
          errorMessage: "Legacy worker could not remove a promoted destination",
          createdAt: timestamp,
          updatedAt: timestamp,
          completedAt: timestamp
        })
        .returning({ id: schema.copyOperations.id })
    );
    if (!operation) throw new Error("Legacy destination copy operation was not inserted");

    await reconcileEnvironmentPaths(app.database.db, {
      symlinkDir: oldSymlinkDir,
      localDir: oldLocalDir,
      remoteDir
    });

    await expect(fs.readlink(fixture.linkPath)).resolves.toBe(fixture.targetPath);
    await expect(fs.readFile(destinationPath)).resolves.toEqual(await fs.readFile(fixture.targetPath));
    await expect(
      first(app.database.db.select().from(schema.copyOperations).where(eq(schema.copyOperations.id, operation.id)).limit(1))
    ).resolves.toMatchObject({
      stage: "reconciliation_required",
      completedAt: null,
      errorMessage: expect.stringContaining("journaled destination exists but its ownership cannot be proven")
    });
  });

  it("blocks normal mutations and safely rebases validated symlinks after a restart", async () => {
    const firstApp = await openApp();
    const cookie = await createAdminSession(firstApp);
    const fixture = await insertIndexedSymlink(firstApp);
    const queuedScanId = await firstApp.jobs.startScan({ scanSymlinks: true, scanLocal: false, scanRemote: false, symlinkSections: [], localSections: [] });

    await fs.symlink(oldSymlinkDir, newSymlinkDir, "dir");
    await fs.symlink(oldLocalDir, newLocalDir, "dir");
    const secondApp = await restartWithPaths(newSymlinkDir, newLocalDir);

    const stateResponse = await secondApp.app.inject({ method: "GET", url: "/api/system/path-migration", headers: { cookie } });
    expect(stateResponse.statusCode).toBe(200);
    const pendingState = stateResponse.json<PathConfigurationState>();
    expect(pendingState).toMatchObject({ blocking: true, status: "change_pending" });
    expect(pendingState.changes.filter((change) => change.changed).map((change) => change.root)).toEqual(["symlink", "local"]);
    expect(pendingState.changes.filter((change) => change.changed).map((change) => change.identityMatch)).toEqual(["same", "same"]);

    const blockedScan = await secondApp.app.inject({
      method: "POST",
      url: "/api/scans",
      headers: { cookie },
      payload: { scanSymlinks: true, scanLocal: false, scanRemote: false }
    });
    expect(blockedScan.statusCode).toBe(423);
    expect(blockedScan.json()).toMatchObject({ error: expect.stringContaining("Complete the required path migration") });

    const oldPaths = await secondApp.app.inject({ method: "GET", url: "/api/settings/paths", headers: { cookie } });
    expect(oldPaths.json()).toMatchObject({ symlinkDir: oldSymlinkDir, localDir: oldLocalDir, remoteDir });

    const plan = await secondApp.app.inject({
      method: "POST",
      url: "/api/system/path-migration/plan",
      headers: { cookie },
      payload: { migrationId: pendingState.migration?.id }
    });
    expect(plan.statusCode).toBe(200);
    expect(plan.json<PathConfigurationState>().migration?.summary).toMatchObject({ affectedLinks: 1, readyLinks: 1, blockedLinks: 0, repointLinks: 1, rebaseLinkPaths: 1 });

    const apply = await secondApp.app.inject({
      method: "POST",
      url: "/api/system/path-migration/apply",
      headers: { cookie },
      payload: { migrationId: pendingState.migration?.id, confirmSameStorage: true }
    });
    expect(apply.statusCode).toBe(200);
    const migrationJobId = apply.json<{ jobId: number }>().jobId;
    const worker = new JobWorker(secondApp.database.db, { workerId: "path-test-worker", pollIntervalMs: 1, heartbeatIntervalMs: 10, logger: silentLogger });
    await expect(worker.runOnce()).resolves.toBe(true);
    const migrationJob = await secondApp.jobs.getJob(migrationJobId);
    expect(migrationJob, JSON.stringify(await secondApp.jobs.listEvents(migrationJobId), null, 2)).toMatchObject({ status: "completed" });
    expect(await secondApp.jobs.getJob(queuedScanId)).toMatchObject({ status: "cancelled" });

    const expectedLinkPath = path.join(newSymlinkDir, path.relative(oldSymlinkDir, fixture.linkPath));
    const expectedTargetPath = path.join(newLocalDir, path.relative(oldLocalDir, fixture.targetPath));
    expect(path.resolve(await fs.readlink(expectedLinkPath))).toBe(path.resolve(expectedTargetPath));
    const mediaLink = await first(secondApp.database.db.select().from(schema.mediaLinks).where(eq(schema.mediaLinks.id, fixture.linkId)).limit(1));
    expect(mediaLink).toMatchObject({ linkPath: expectedLinkPath, targetPath: expectedTargetPath, sizeBytes: fixture.fileSize });
    const storageFile = await first(secondApp.database.db.select().from(schema.storageFiles).limit(1));
    expect(storageFile).toMatchObject({ rootPath: newLocalDir, filePath: expectedTargetPath });
    const copySource = await first(secondApp.database.db.select().from(schema.copySources).limit(1));
    expect(copySource).toMatchObject({ destinationPath: expectedTargetPath, linkPath: expectedLinkPath });

    const completedState = await secondApp.app.inject({ method: "GET", url: "/api/system/path-migration", headers: { cookie } });
    expect(completedState.json<PathConfigurationState>()).toMatchObject({ blocking: false, status: "ready", activePaths: { symlinkDir: newSymlinkDir, localDir: newLocalDir, remoteDir } });

    const recoveredProgress: unknown[] = [];
    await expect(
      runPathMigration(secondApp.database.db, pendingState.migration?.id ?? 0, {
        signal: new AbortController().signal,
        event: async () => undefined,
        setProgress: async (progress) => {
          recoveredProgress.push(progress);
        },
        isCancelled: async () => false,
        assertLease: async () => undefined,
        withLease: (action) => action(),
        withLeaseDb: (action) => action(secondApp.database.db),
        finishCompleted: async (action) => {
          await action(secondApp.database.db);
          return true;
        }
      })
    ).resolves.toBeUndefined();
    expect(recoveredProgress.at(-1)).toMatchObject({ stage: "completed", current: 1, total: 1 });
  });

  it("rolls back when cancellation wins the atomic path-migration completion boundary", async () => {
    const firstApp = await openApp();
    const cookie = await createAdminSession(firstApp);
    const fixture = await insertIndexedSymlink(firstApp, "Cancelled Migration");
    await fs.symlink(oldSymlinkDir, newSymlinkDir, "dir");
    await fs.symlink(oldLocalDir, newLocalDir, "dir");
    const secondApp = await restartWithPaths(newSymlinkDir, newLocalDir);
    const state = (await secondApp.app.inject({ method: "GET", url: "/api/system/path-migration", headers: { cookie } })).json<PathConfigurationState>();
    const migrationId = state.migration?.id ?? 0;
    const plan = await secondApp.app.inject({
      method: "POST",
      url: "/api/system/path-migration/plan",
      headers: { cookie },
      payload: { migrationId }
    });
    expect(plan.statusCode).toBe(200);
    const apply = await secondApp.app.inject({
      method: "POST",
      url: "/api/system/path-migration/apply",
      headers: { cookie },
      payload: { migrationId, confirmSameStorage: true }
    });
    expect(apply.statusCode).toBe(200);
    const { jobId } = apply.json<{ jobId: number }>();
    if (!Number.isSafeInteger(jobId)) throw new Error("Path migration job ID is invalid");
    await secondApp.database.pool.query(`
      CREATE FUNCTION srtl_test_cancel_path_before_finish() RETURNS trigger
      LANGUAGE plpgsql AS $function$
      BEGIN
        IF NEW.id = ${jobId}
          AND NEW.status = 'running'
          AND NEW.progress::jsonb ->> 'stage' = 'repointing'
          AND NEW.progress::jsonb ->> 'current' = NEW.progress::jsonb ->> 'total'
        THEN
          NEW.cancel_requested_at = clock_timestamp()::text;
        END IF;
        RETURN NEW;
      END;
      $function$
    `);
    await secondApp.database.pool.query(`
      CREATE TRIGGER srtl_test_cancel_path_before_finish
      BEFORE UPDATE OF progress ON jobs
      FOR EACH ROW
      EXECUTE FUNCTION srtl_test_cancel_path_before_finish()
    `);

    const worker = new JobWorker(secondApp.database.db, { workerId: "path-cancel-test-worker", pollIntervalMs: 1, heartbeatIntervalMs: 10, logger: silentLogger });
    await expect(worker.runOnce()).resolves.toBe(true);

    await expect(secondApp.jobs.getJob(jobId)).resolves.toMatchObject({ status: "cancelled", finishedAt: expect.any(String) });
    const migratedLinkPath = rebaseFixturePath(fixture.linkPath, oldSymlinkDir, newSymlinkDir);
    expect(path.resolve(await fs.readlink(migratedLinkPath))).toBe(path.resolve(fixture.targetPath));
    await expect(first(secondApp.database.db.select().from(schema.pathMigrations).where(eq(schema.pathMigrations.id, migrationId)).limit(1))).resolves.toMatchObject({
      status: "failed",
      errorMessage: expect.stringContaining("terminated before its final commit")
    });
    await expect(first(secondApp.database.db.select().from(schema.mediaLinks).where(eq(schema.mediaLinks.id, fixture.linkId)).limit(1))).resolves.toMatchObject({
      linkPath: fixture.linkPath,
      targetPath: fixture.targetPath
    });
    expect((await secondApp.app.inject({ method: "GET", url: "/api/system/path-migration", headers: { cookie } })).json<PathConfigurationState>()).toMatchObject({
      blocking: true
    });
  });

  it("serializes path reconciliation behind the final migration commit without deadlocking", async () => {
    const firstApp = await openApp();
    const cookie = await createAdminSession(firstApp);
    await insertIndexedSymlink(firstApp, "Final Commit Lock Order", "lock-order.bin");
    await fs.symlink(oldSymlinkDir, newSymlinkDir, "dir");
    await fs.symlink(oldLocalDir, newLocalDir, "dir");
    const secondApp = await restartWithPaths(newSymlinkDir, newLocalDir);
    const state = (await secondApp.app.inject({ method: "GET", url: "/api/system/path-migration", headers: { cookie } })).json<PathConfigurationState>();
    const migrationId = state.migration?.id ?? 0;
    const plan = await secondApp.app.inject({ method: "POST", url: "/api/system/path-migration/plan", headers: { cookie }, payload: { migrationId } });
    expect(plan.statusCode).toBe(200);
    const apply = await secondApp.app.inject({
      method: "POST",
      url: "/api/system/path-migration/apply",
      headers: { cookie },
      payload: { migrationId, confirmSameStorage: true }
    });
    expect(apply.statusCode).toBe(200);
    const jobId = apply.json<{ jobId: number }>().jobId;

    // Mirrors the private process-wide lock used by pathConfiguration.ts so this test can hold the final-commit boundary open.
    const pathConfigurationAdvisoryLockKey = 781_889_433;
    const gateClient = await secondApp.database.pool.connect();
    let gateHeld = false;
    let workerRun: Promise<boolean> | null = null;
    let reconciliation: Promise<void> | null = null;
    try {
      await gateClient.query("BEGIN");
      await gateClient.query("SELECT pg_advisory_xact_lock($1)", [pathConfigurationAdvisoryLockKey]);
      gateHeld = true;

      const worker = new JobWorker(secondApp.database.db, {
        workerId: "path-final-lock-order-worker",
        pollIntervalMs: 1,
        heartbeatIntervalMs: 10,
        logger: silentLogger
      });
      workerRun = worker.runOnce();
      await expect
        .poll(
          async () => {
            const result = await secondApp.database.pool.query<{ waiting: string }>(`
              SELECT count(*)::text AS waiting
              FROM pg_locks
              WHERE locktype = 'advisory'
                AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
                AND NOT granted
            `);
            return Number(result.rows[0]?.waiting ?? 0);
          },
          { interval: 10, timeout: 2_000 }
        )
        .toBeGreaterThanOrEqual(1);

      reconciliation = reconcileEnvironmentPaths(secondApp.database.db, { symlinkDir: newSymlinkDir, localDir: newLocalDir, remoteDir });
      await expect
        .poll(
          async () => {
            const result = await secondApp.database.pool.query<{ waiting: string }>(`
              SELECT count(*)::text AS waiting
              FROM pg_locks
              WHERE locktype = 'advisory'
                AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
                AND NOT granted
            `);
            return Number(result.rows[0]?.waiting ?? 0);
          },
          { interval: 10, timeout: 2_000 }
        )
        .toBeGreaterThanOrEqual(2);

      await gateClient.query("COMMIT");
      gateHeld = false;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        const [didWork] = await Promise.race([
          Promise.all([workerRun, reconciliation]),
          new Promise<never>((_resolve, reject) => {
            timeout = setTimeout(() => reject(new Error("Path finalization and reconciliation deadlocked")), 3_000);
          })
        ]);
        expect(didWork).toBe(true);
      } finally {
        if (timeout) clearTimeout(timeout);
      }
    } finally {
      if (gateHeld) await gateClient.query("ROLLBACK").catch(() => undefined);
      gateClient.release();
      await Promise.allSettled([...(workerRun ? [workerRun] : []), ...(reconciliation ? [reconciliation] : [])]);
    }

    await expect(secondApp.jobs.getJob(jobId)).resolves.toMatchObject({ status: "completed" });
    await expect(first(secondApp.database.db.select().from(schema.pathMigrations).where(eq(schema.pathMigrations.id, migrationId)).limit(1))).resolves.toMatchObject({
      status: "completed"
    });
    expect((await secondApp.app.inject({ method: "GET", url: "/api/system/path-migration", headers: { cookie } })).json<PathConfigurationState>()).toMatchObject({
      blocking: false,
      status: "ready"
    });
  });

  it("waits for running-job mutation leases before recording a path change", async () => {
    const app = await openApp();
    await fs.symlink(oldSymlinkDir, newSymlinkDir, "dir");
    await fs.symlink(oldLocalDir, newLocalDir, "dir");
    const timestamp = new Date().toISOString();
    const runningJob = await first(
      app.database.db
        .insert(schema.jobs)
        .values({
          type: "copy",
          status: "running",
          createdAt: timestamp,
          startedAt: timestamp,
          finishedAt: null,
          lockedBy: "path-reconcile-mutation-holder",
          lockedAt: timestamp,
          heartbeatAt: timestamp,
          exclusive: false,
          cancelRequestedAt: null,
          progress: "{}"
        })
        .returning({ id: schema.jobs.id })
    );
    if (!runningJob) throw new Error("Running path-reconciliation fixture job was not inserted");

    const gateClient = await app.database.pool.connect();
    let gateHeld = false;
    let reconciliation: Promise<void> | null = null;
    try {
      await gateClient.query("BEGIN");
      await gateClient.query("SELECT id FROM jobs WHERE id = $1 FOR UPDATE", [runningJob.id]);
      gateHeld = true;

      reconciliation = reconcileEnvironmentPaths(app.database.db, {
        symlinkDir: newSymlinkDir,
        localDir: newLocalDir,
        remoteDir
      });
      const boundary = await Promise.race([
        reconciliation.then(() => "completed" as const),
        new Promise<"waiting">((resolve) => setTimeout(() => resolve("waiting"), 100))
      ]);
      expect(boundary).toBe("waiting");
      expect(await app.database.db.select().from(schema.pathMigrations)).toEqual([]);

      await gateClient.query("COMMIT");
      gateHeld = false;
      await reconciliation;
    } finally {
      if (gateHeld) await gateClient.query("ROLLBACK").catch(() => undefined);
      gateClient.release();
      if (reconciliation) await reconciliation.catch(() => undefined);
    }

    await expect(first(app.database.db.select().from(schema.pathMigrations).orderBy(desc(schema.pathMigrations.id)).limit(1))).resolves.toMatchObject({
      status: "pending"
    });
  });

  it("keeps migration blocked when mapped files do not exist", async () => {
    const firstApp = await openApp();
    const cookie = await createAdminSession(firstApp);
    const fixture = await insertIndexedSymlink(firstApp);
    await fs.symlink(oldSymlinkDir, newSymlinkDir, "dir");
    await fs.mkdir(newLocalDir, { recursive: true });
    const secondApp = await restartWithPaths(newSymlinkDir, newLocalDir);
    const state = (await secondApp.app.inject({ method: "GET", url: "/api/system/path-migration", headers: { cookie } })).json<PathConfigurationState>();

    const plan = await secondApp.app.inject({ method: "POST", url: "/api/system/path-migration/plan", headers: { cookie }, payload: { migrationId: state.migration?.id } });
    expect(plan.statusCode).toBe(200);
    expect(plan.json<PathConfigurationState>().migration?.summary).toMatchObject({ affectedLinks: 1, blockedLinks: 1, readyLinks: 0 });
    expect(plan.json<PathConfigurationState>().migration?.issues[0]?.message).toContain("Mapped target could not be validated");

    const apply = await secondApp.app.inject({
      method: "POST",
      url: "/api/system/path-migration/apply",
      headers: { cookie },
      payload: { migrationId: state.migration?.id, confirmSameStorage: true }
    });
    expect(apply.statusCode).toBe(409);
    expect(path.resolve(await fs.readlink(path.join(newSymlinkDir, path.relative(oldSymlinkDir, fixture.linkPath))))).toBe(path.resolve(fixture.targetPath));
  });

  it("allows only one concurrent migration analysis to claim a path change", async () => {
    const firstApp = await openApp();
    const cookie = await createAdminSession(firstApp);
    await insertIndexedSymlink(firstApp);
    await fs.symlink(oldSymlinkDir, newSymlinkDir, "dir");
    await fs.symlink(oldLocalDir, newLocalDir, "dir");
    const secondApp = await restartWithPaths(newSymlinkDir, newLocalDir);
    const state = (await secondApp.app.inject({ method: "GET", url: "/api/system/path-migration", headers: { cookie } })).json<PathConfigurationState>();

    const responses = await Promise.all([
      secondApp.app.inject({ method: "POST", url: "/api/system/path-migration/plan", headers: { cookie }, payload: { migrationId: state.migration?.id } }),
      secondApp.app.inject({ method: "POST", url: "/api/system/path-migration/plan", headers: { cookie }, payload: { migrationId: state.migration?.id } })
    ]);
    expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 409]);
    const plannedState = (await secondApp.app.inject({ method: "GET", url: "/api/system/path-migration", headers: { cookie } })).json<PathConfigurationState>();
    expect(plannedState).toMatchObject({ blocking: true, status: "ready_to_apply" });
  });

  it("preserves unresolved started-migration journals while allowing safe reanalysis", async () => {
    const firstApp = await openApp();
    const cookie = await createAdminSession(firstApp);
    await insertIndexedSymlink(firstApp, "Reanalysis Journal", "journal.bin");
    await fs.symlink(oldSymlinkDir, newSymlinkDir, "dir");
    await fs.symlink(oldLocalDir, newLocalDir, "dir");
    const secondApp = await restartWithPaths(newSymlinkDir, newLocalDir);
    const state = (await secondApp.app.inject({ method: "GET", url: "/api/system/path-migration", headers: { cookie } })).json<PathConfigurationState>();
    const migrationId = state.migration?.id ?? 0;
    const initialPlan = await secondApp.app.inject({
      method: "POST",
      url: "/api/system/path-migration/plan",
      headers: { cookie },
      payload: { migrationId }
    });
    expect(initialPlan.statusCode).toBe(200);

    const timestamp = new Date().toISOString();
    await secondApp.database.db
      .update(schema.pathMigrations)
      .set({ status: "failed", startedAt: null, finishedAt: timestamp, errorMessage: "Analysis failed before migration started" })
      .where(eq(schema.pathMigrations.id, migrationId));
    const beforeStartReplan = await secondApp.app.inject({
      method: "POST",
      url: "/api/system/path-migration/plan",
      headers: { cookie },
      payload: { migrationId }
    });
    expect(beforeStartReplan.statusCode).toBe(200);

    const unresolvedItem = await first(
      secondApp.database.db.select().from(schema.pathMigrationItems).where(eq(schema.pathMigrationItems.migrationId, migrationId)).limit(1)
    );
    if (!unresolvedItem) throw new Error("Reanalysis journal fixture item was not created");
    const manualMessage = "Manual review is required before this symlink can be migrated again.";
    await secondApp.database.db
      .update(schema.pathMigrations)
      .set({ status: "failed", startedAt: timestamp, finishedAt: timestamp, errorMessage: manualMessage })
      .where(eq(schema.pathMigrations.id, migrationId));
    await secondApp.database.db
      .update(schema.pathMigrationItems)
      .set({ validationStatus: "blocked", rolledBackAt: null, message: manualMessage })
      .where(eq(schema.pathMigrationItems.id, unresolvedItem.id));

    const blockedReplan = await secondApp.app.inject({
      method: "POST",
      url: "/api/system/path-migration/plan",
      headers: { cookie },
      payload: { migrationId }
    });
    expect(blockedReplan.statusCode).toBe(409);
    expect(blockedReplan.json()).toMatchObject({ error: expect.stringContaining("manually reconciled") });
    await expect(first(secondApp.database.db.select().from(schema.pathMigrationItems).where(eq(schema.pathMigrationItems.id, unresolvedItem.id)).limit(1))).resolves.toMatchObject({
      validationStatus: "blocked",
      message: manualMessage,
      rolledBackAt: null
    });

    await secondApp.database.db
      .update(schema.pathMigrationItems)
      .set({ validationStatus: "rolled_back", rolledBackAt: timestamp })
      .where(eq(schema.pathMigrationItems.id, unresolvedItem.id));
    const reconciledReplan = await secondApp.app.inject({
      method: "POST",
      url: "/api/system/path-migration/plan",
      headers: { cookie },
      payload: { migrationId }
    });
    expect(reconciledReplan.statusCode).toBe(200);
    await expect(first(secondApp.database.db.select().from(schema.pathMigrationItems).where(eq(schema.pathMigrationItems.migrationId, migrationId)).limit(1))).resolves.toMatchObject({
      validationStatus: "ready"
    });
  });

  it("waits for predecessor rollback and its path job before planning a successor", async () => {
    const firstApp = await openApp();
    const cookie = await createAdminSession(firstApp);
    await insertIndexedSymlink(firstApp, "Successor Barrier", "successor.bin");
    await fs.symlink(oldSymlinkDir, newSymlinkDir, "dir");
    await fs.symlink(oldLocalDir, newLocalDir, "dir");
    const secondApp = await restartWithPaths(newSymlinkDir, newLocalDir);
    const initialState = (await secondApp.app.inject({ method: "GET", url: "/api/system/path-migration", headers: { cookie } })).json<PathConfigurationState>();
    const predecessorId = initialState.migration?.id ?? 0;
    await planPathMigration(secondApp.database.db, predecessorId);
    const predecessorJobId = await secondApp.jobs.startPathMigration(predecessorId);
    const timestamp = new Date().toISOString();
    await secondApp.database.db
      .update(schema.pathMigrations)
      .set({ status: "running", startedAt: timestamp })
      .where(eq(schema.pathMigrations.id, predecessorId));

    const thirdSymlinkDir = path.join(tmpDir, "symlinks-third");
    const thirdLocalDir = path.join(tmpDir, "local-third");
    await fs.symlink(oldSymlinkDir, thirdSymlinkDir, "dir");
    await fs.symlink(oldLocalDir, thirdLocalDir, "dir");
    await reconcileEnvironmentPaths(secondApp.database.db, {
      symlinkDir: thirdSymlinkDir,
      localDir: thirdLocalDir,
      remoteDir
    });

    const migrations = await secondApp.database.db.select().from(schema.pathMigrations).orderBy(desc(schema.pathMigrations.id));
    const successor = migrations[0];
    const predecessor = migrations.find((migration) => migration.id === predecessorId);
    if (!successor || successor.id === predecessorId) throw new Error("Successor path migration was not created");
    expect(predecessor).toMatchObject({ status: "rollback_pending", jobId: predecessorJobId });

    await expect(planPathMigration(secondApp.database.db, successor.id)).rejects.toThrow(`Path migration #${predecessorId} is still being reconciled`);
    await secondApp.database.db.update(schema.pathMigrations).set({ status: "cancelled", finishedAt: timestamp }).where(eq(schema.pathMigrations.id, predecessorId));
    await expect(planPathMigration(secondApp.database.db, successor.id)).rejects.toThrow(`Path migration job #${predecessorJobId} is still active`);

    await secondApp.database.db
      .update(schema.jobs)
      .set({ status: "cancelled", finishedAt: timestamp, cancelRequestedAt: timestamp })
      .where(eq(schema.jobs.id, predecessorJobId));
    await expect(planPathMigration(secondApp.database.db, successor.id)).resolves.toBeUndefined();
    await expect(first(secondApp.database.db.select().from(schema.pathMigrations).where(eq(schema.pathMigrations.id, successor.id)).limit(1))).resolves.toMatchObject({
      status: "planned"
    });
  });

  it("waits for active and manually blocked copy journals before planning or applying paths", async () => {
    const firstApp = await openApp();
    const cookie = await createAdminSession(firstApp);
    const fixture = await insertIndexedSymlink(firstApp, "Copy Recovery Barrier", "copy-recovery.bin");
    const originalLink = await first(firstApp.database.db.select().from(schema.mediaLinks).where(eq(schema.mediaLinks.id, fixture.linkId)).limit(1));
    if (!originalLink) throw new Error("Copy-recovery fixture link was not found");
    const timestamp = new Date().toISOString();
    const copyJob = await first(
      firstApp.database.db
        .insert(schema.jobs)
        .values({
          type: "copy",
          status: "queued",
          createdAt: timestamp,
          startedAt: timestamp,
          finishedAt: null,
          lockedBy: null,
          lockedAt: null,
          heartbeatAt: null,
          exclusive: false,
          cancelRequestedAt: null,
          progress: "{}"
        })
        .returning({ id: schema.jobs.id })
    );
    if (!copyJob) throw new Error("Copy-recovery fixture job was not inserted");
    const copyOperation = await first(
      firstApp.database.db
        .insert(schema.copyOperations)
        .values({
          jobId: copyJob.id,
          mediaLinkId: fixture.linkId,
          linkPath: fixture.linkPath,
          sourcePath: fixture.targetPath,
          destinationPath: path.join(remoteDir, "files", "Copy Recovery Barrier", "copy-recovery.bin"),
          originalTargetPath: fixture.targetPath,
          originalLinkState: JSON.stringify(originalLink),
          previousCopySource: null,
          tempPath: null,
          displacedPath: null,
          stage: "committed",
          resultStatus: "copied",
          localConflictStrategy: null,
          sizeBytes: fixture.fileSize,
          errorMessage: null,
          createdAt: timestamp,
          updatedAt: timestamp,
          completedAt: timestamp
        })
        .returning({ id: schema.copyOperations.id })
    );
    if (!copyOperation) throw new Error("Copy-recovery fixture operation was not inserted");

    await fs.symlink(oldSymlinkDir, newSymlinkDir, "dir");
    await fs.symlink(oldLocalDir, newLocalDir, "dir");
    const secondApp = await restartWithPaths(newSymlinkDir, newLocalDir);
    const state = (await secondApp.app.inject({ method: "GET", url: "/api/system/path-migration", headers: { cookie } })).json<PathConfigurationState>();
    const migrationId = state.migration?.id ?? 0;

    await expect(planPathMigration(secondApp.database.db, migrationId)).rejects.toThrow(`Copy job #${copyJob.id} is still reconciling filesystem changes`);
    await secondApp.database.db.update(schema.pathMigrations).set({ status: "queued" }).where(eq(schema.pathMigrations.id, migrationId));
    await expect(
      runPathMigration(secondApp.database.db, migrationId, {
        signal: new AbortController().signal,
        event: async () => undefined,
        setProgress: async () => undefined,
        isCancelled: async () => false,
        assertLease: async () => undefined,
        withLease: (action) => action(),
        withLeaseDb: (action) => action(secondApp.database.db),
        finishCompleted: async (action) => {
          await action(secondApp.database.db);
          return true;
        }
      })
    ).rejects.toThrow(`Copy job #${copyJob.id} is still reconciling filesystem changes`);
    await expect(secondApp.jobs.getJob(copyJob.id)).resolves.toMatchObject({ status: "queued" });

    await secondApp.database.db.update(schema.pathMigrations).set({ status: "pending" }).where(eq(schema.pathMigrations.id, migrationId));
    await secondApp.database.db
      .update(schema.jobs)
      .set({ status: "failed", finishedAt: timestamp })
      .where(eq(schema.jobs.id, copyJob.id));
    await secondApp.database.db
      .update(schema.copyOperations)
      .set({ stage: "promoted", completedAt: null })
      .where(eq(schema.copyOperations.id, copyOperation.id));
    await expect(planPathMigration(secondApp.database.db, migrationId)).rejects.toThrow(
      `Copy operation #${copyOperation.id} from job #${copyJob.id} has unresolved filesystem changes`
    );
    await secondApp.database.db
      .update(schema.copyOperations)
      .set({ stage: "committed", completedAt: timestamp })
      .where(eq(schema.copyOperations.id, copyOperation.id));
    await expect(planPathMigration(secondApp.database.db, migrationId)).resolves.toBeUndefined();
    const plannedItems = await secondApp.database.db.select().from(schema.pathMigrationItems).where(eq(schema.pathMigrationItems.migrationId, migrationId));

    await secondApp.database.db
      .update(schema.copyOperations)
      .set({ stage: "reconciliation_required", errorMessage: "Manual copy reconciliation is required" })
      .where(eq(schema.copyOperations.id, copyOperation.id));
    await expect(planPathMigration(secondApp.database.db, migrationId)).rejects.toThrow(`Copy operation #${copyOperation.id} requires manual reconciliation`);
    expect(await secondApp.database.db.select().from(schema.pathMigrationItems).where(eq(schema.pathMigrationItems.migrationId, migrationId))).toEqual(plannedItems);

    await secondApp.database.db
      .update(schema.copyOperations)
      .set({ stage: "rolled_back", errorMessage: null })
      .where(eq(schema.copyOperations.id, copyOperation.id));
    await expect(planPathMigration(secondApp.database.db, migrationId)).resolves.toBeUndefined();
  });

  it("waits for a running job to requeue before taking the migration analysis snapshot", async () => {
    const firstApp = await openApp();
    const cookie = await createAdminSession(firstApp);
    const fixture = await insertIndexedSymlink(firstApp, "Snapshot Barrier Title", "snapshot.bin");
    await fs.symlink(oldSymlinkDir, newSymlinkDir, "dir");
    await fs.symlink(oldLocalDir, newLocalDir, "dir");
    const secondApp = await restartWithPaths(newSymlinkDir, newLocalDir);
    const state = (await secondApp.app.inject({ method: "GET", url: "/api/system/path-migration", headers: { cookie } })).json<PathConfigurationState>();
    const migrationId = state.migration?.id ?? 0;
    const timestamp = new Date().toISOString();
    const runningJob = await first(
      secondApp.database.db
        .insert(schema.jobs)
        .values({
          type: "scan",
          status: "running",
          createdAt: timestamp,
          startedAt: timestamp,
          finishedAt: null,
          lockedBy: "snapshot-draining-worker",
          lockedAt: timestamp,
          heartbeatAt: timestamp,
          exclusive: false,
          cancelRequestedAt: null,
          progress: "{}"
        })
        .returning({ id: schema.jobs.id })
    );
    if (!runningJob) throw new Error("Running snapshot-barrier job was not inserted");

    const blockedPlan = await secondApp.app.inject({
      method: "POST",
      url: "/api/system/path-migration/plan",
      headers: { cookie },
      payload: { migrationId }
    });
    expect(blockedPlan.statusCode).toBe(409);
    expect(blockedPlan.json()).toMatchObject({ error: expect.stringContaining("wait for it to pause") });
    await expect(first(secondApp.database.db.select().from(schema.pathMigrations).where(eq(schema.pathMigrations.id, migrationId)).limit(1))).resolves.toMatchObject({
      status: "pending"
    });
    await expect(secondApp.database.db.select().from(schema.pathMigrationItems).where(eq(schema.pathMigrationItems.migrationId, migrationId))).resolves.toEqual([]);

    await secondApp.database.db
      .update(schema.jobs)
      .set({ status: "queued", lockedBy: null, lockedAt: null, heartbeatAt: null })
      .where(eq(schema.jobs.id, runningJob.id));

    const planned = await secondApp.app.inject({
      method: "POST",
      url: "/api/system/path-migration/plan",
      headers: { cookie },
      payload: { migrationId }
    });
    expect(planned.statusCode).toBe(200);
    expect(planned.json<PathConfigurationState>().migration?.summary).toMatchObject({ affectedLinks: 1, readyLinks: 1, blockedLinks: 0 });
    expect(await secondApp.database.db.select().from(schema.pathMigrationItems).where(eq(schema.pathMigrationItems.migrationId, migrationId))).toEqual([
      expect.objectContaining({ mediaLinkId: fixture.linkId, validationStatus: "ready" })
    ]);
    expect(await secondApp.jobs.getJob(runningJob.id)).toMatchObject({ status: "queued", lockedBy: null, heartbeatAt: null });
  });

  it("queues a validated migration while another job drains", async () => {
    const firstApp = await openApp();
    const cookie = await createAdminSession(firstApp);
    await insertIndexedSymlink(firstApp);
    await fs.symlink(oldSymlinkDir, newSymlinkDir, "dir");
    await fs.symlink(oldLocalDir, newLocalDir, "dir");
    const secondApp = await restartWithPaths(newSymlinkDir, newLocalDir);
    const state = (await secondApp.app.inject({ method: "GET", url: "/api/system/path-migration", headers: { cookie } })).json<PathConfigurationState>();
    const plan = await secondApp.app.inject({ method: "POST", url: "/api/system/path-migration/plan", headers: { cookie }, payload: { migrationId: state.migration?.id } });
    expect(plan.statusCode).toBe(200);

    const timestamp = new Date().toISOString();
    const runningJob = await first(
      secondApp.database.db
        .insert(schema.jobs)
        .values({
          type: "scan",
          status: "running",
          createdAt: timestamp,
          startedAt: timestamp,
          finishedAt: null,
          lockedBy: "draining-worker",
          lockedAt: timestamp,
          heartbeatAt: timestamp,
          exclusive: false,
          cancelRequestedAt: null,
          progress: "{}"
        })
        .returning({ id: schema.jobs.id })
    );
    expect(runningJob).toBeTruthy();

    const apply = await secondApp.app.inject({
      method: "POST",
      url: "/api/system/path-migration/apply",
      headers: { cookie },
      payload: { migrationId: state.migration?.id, confirmSameStorage: true }
    });
    expect(apply.statusCode).toBe(200);
    expect(await secondApp.jobs.getJob(apply.json<{ jobId: number }>().jobId)).toMatchObject({ type: "path_migration", status: "queued" });
    expect(await secondApp.jobs.getJob(runningJob?.id ?? 0)).toMatchObject({ type: "scan", status: "running" });
    await expect(
      runPathMigration(secondApp.database.db, state.migration?.id ?? 0, {
        signal: new AbortController().signal,
        event: async () => undefined,
        setProgress: async () => undefined,
        isCancelled: async () => false,
        assertLease: async () => undefined,
        withLease: (action) => action(),
        withLeaseDb: (action) => action(secondApp.database.db),
        finishCompleted: async (action) => {
          await action(secondApp.database.db);
          return true;
        }
      })
    ).rejects.toThrow("Another job is still running");
  });

  it("fails analysis early when a managed root is unavailable", async () => {
    const firstApp = await openApp();
    const cookie = await createAdminSession(firstApp);
    await insertIndexedSymlink(firstApp);
    await fs.symlink(oldSymlinkDir, newSymlinkDir, "dir");
    await fs.symlink(oldLocalDir, newLocalDir, "dir");
    await fs.rm(remoteDir, { recursive: true });
    const secondApp = await restartWithPaths(newSymlinkDir, newLocalDir);
    const state = (await secondApp.app.inject({ method: "GET", url: "/api/system/path-migration", headers: { cookie } })).json<PathConfigurationState>();

    const plan = await secondApp.app.inject({ method: "POST", url: "/api/system/path-migration/plan", headers: { cookie }, payload: { migrationId: state.migration?.id } });
    expect(plan.statusCode).toBe(409);
    expect(plan.json()).toMatchObject({ error: expect.stringContaining("Remote directory is unavailable") });
    const failedState = (await secondApp.app.inject({ method: "GET", url: "/api/system/path-migration", headers: { cookie } })).json<PathConfigurationState>();
    expect(failedState).toMatchObject({ blocking: true, status: "invalid_environment" });
    expect(failedState.migration?.errorMessage).toContain("Remote directory is unavailable");
  });

  it("returns a terminated queued migration to an actionable blocked state", async () => {
    const firstApp = await openApp();
    const cookie = await createAdminSession(firstApp);
    await insertIndexedSymlink(firstApp);
    await fs.symlink(oldSymlinkDir, newSymlinkDir, "dir");
    await fs.symlink(oldLocalDir, newLocalDir, "dir");
    const secondApp = await restartWithPaths(newSymlinkDir, newLocalDir);
    const state = (await secondApp.app.inject({ method: "GET", url: "/api/system/path-migration", headers: { cookie } })).json<PathConfigurationState>();
    await secondApp.app.inject({ method: "POST", url: "/api/system/path-migration/plan", headers: { cookie }, payload: { migrationId: state.migration?.id } });
    const apply = await secondApp.app.inject({
      method: "POST",
      url: "/api/system/path-migration/apply",
      headers: { cookie },
      payload: { migrationId: state.migration?.id, confirmSameStorage: true }
    });
    const jobId = apply.json<{ jobId: number }>().jobId;

    const terminate = await secondApp.app.inject({ method: "POST", url: `/api/jobs/${jobId}/terminate`, headers: { cookie } });
    expect(terminate.statusCode).toBe(200);
    expect(await secondApp.jobs.getJob(jobId)).toMatchObject({ status: "cancelled" });
    const failedState = (await secondApp.app.inject({ method: "GET", url: "/api/system/path-migration", headers: { cookie } })).json<PathConfigurationState>();
    expect(failedState).toMatchObject({ blocking: true, status: "failed" });
    expect(failedState.migration?.errorMessage).toContain("terminated before it started");

    const replan = await secondApp.app.inject({ method: "POST", url: "/api/system/path-migration/plan", headers: { cookie }, payload: { migrationId: state.migration?.id } });
    expect(replan.statusCode).toBe(200);
    expect(replan.json<PathConfigurationState>()).toMatchObject({ blocking: true, status: "ready_to_apply" });
  });

  it("does not reimport stale legacy copy-source paths after migration", async () => {
    const timestamp = "2026-01-01T00:00:00.000Z";
    const relativePath = path.join("files", "Legacy Title", "legacy.bin");
    const oldDestinationPath = path.join(oldLocalDir, relativePath);
    const sourcePath = path.join(remoteDir, relativePath);
    const oldLinkPath = path.join(oldSymlinkDir, relativePath);
    await fs.writeFile(path.join(tmpDir, ".srtl_copy_sources.nul"), Buffer.from([oldDestinationPath, sourcePath, oldLinkPath, timestamp, ""].join("\0")));

    const firstApp = await openApp();
    const cookie = await createAdminSession(firstApp);
    expect(await firstApp.database.db.select().from(schema.copySources)).toEqual([]);

    await fs.symlink(oldSymlinkDir, newSymlinkDir, "dir");
    await fs.symlink(oldLocalDir, newLocalDir, "dir");
    const secondApp = await restartWithPaths(newSymlinkDir, newLocalDir);
    const state = (await secondApp.app.inject({ method: "GET", url: "/api/system/path-migration", headers: { cookie } })).json<PathConfigurationState>();
    await secondApp.app.inject({ method: "POST", url: "/api/system/path-migration/plan", headers: { cookie }, payload: { migrationId: state.migration?.id } });
    const apply = await secondApp.app.inject({
      method: "POST",
      url: "/api/system/path-migration/apply",
      headers: { cookie },
      payload: { migrationId: state.migration?.id, confirmSameStorage: true }
    });
    const worker = new JobWorker(secondApp.database.db, { workerId: "legacy-source-worker", pollIntervalMs: 1, heartbeatIntervalMs: 10, logger: silentLogger });
    await expect(worker.runOnce()).resolves.toBe(true);
    expect(await secondApp.jobs.getJob(apply.json<{ jobId: number }>().jobId)).toMatchObject({ status: "completed" });

    const restartedApp = await restartWithPaths(newSymlinkDir, newLocalDir);
    expect(await restartedApp.database.db.select().from(schema.copySources)).toEqual([]);
  });

  it("clears an unresolved migration when the previous environment paths are restored", async () => {
    const firstApp = await openApp();
    const cookie = await createAdminSession(firstApp);
    await insertIndexedSymlink(firstApp);
    await fs.symlink(oldSymlinkDir, newSymlinkDir, "dir");
    await fs.symlink(oldLocalDir, newLocalDir, "dir");
    const changedApp = await restartWithPaths(newSymlinkDir, newLocalDir);
    const changedState = (await changedApp.app.inject({ method: "GET", url: "/api/system/path-migration", headers: { cookie } })).json<PathConfigurationState>();
    expect(changedState.blocking).toBe(true);

    const restoredApp = await restartWithPaths(oldSymlinkDir, oldLocalDir);
    const restoredState = (await restoredApp.app.inject({ method: "GET", url: "/api/system/path-migration", headers: { cookie } })).json<PathConfigurationState>();
    expect(restoredState).toMatchObject({ blocking: false, status: "ready", activePaths: { symlinkDir: oldSymlinkDir, localDir: oldLocalDir, remoteDir } });
    const migration = await first(restoredApp.database.db.select().from(schema.pathMigrations).orderBy(desc(schema.pathMigrations.id)).limit(1));
    expect(migration?.status).toBe("cancelled");
  });

  it("rolls back symlinks already repointed when a later target is replaced by a same-size file after analysis", async () => {
    const firstApp = await openApp();
    const cookie = await createAdminSession(firstApp);
    const firstFixture = await insertIndexedSymlink(firstApp, "First Title", "first.bin");
    const secondFixture = await insertIndexedSymlink(firstApp, "Second Title", "second.bin");
    await fs.symlink(oldSymlinkDir, newSymlinkDir, "dir");
    await fs.symlink(oldLocalDir, newLocalDir, "dir");
    const secondApp = await restartWithPaths(newSymlinkDir, newLocalDir);
    const state = (await secondApp.app.inject({ method: "GET", url: "/api/system/path-migration", headers: { cookie } })).json<PathConfigurationState>();
    const plan = await secondApp.app.inject({ method: "POST", url: "/api/system/path-migration/plan", headers: { cookie }, payload: { migrationId: state.migration?.id } });
    expect(plan.json<PathConfigurationState>().migration?.summary).toMatchObject({ readyLinks: 2, blockedLinks: 0 });

    const originalTarget = await fs.readFile(secondFixture.targetPath);
    const sameSizeReplacement = `${secondFixture.targetPath}.replacement`;
    await fs.writeFile(sameSizeReplacement, Buffer.alloc(originalTarget.length, 0x7a));
    await fs.rename(sameSizeReplacement, secondFixture.targetPath);
    const apply = await secondApp.app.inject({
      method: "POST",
      url: "/api/system/path-migration/apply",
      headers: { cookie },
      payload: { migrationId: state.migration?.id, confirmSameStorage: true }
    });
    const jobId = apply.json<{ jobId: number }>().jobId;
    const worker = new JobWorker(secondApp.database.db, { workerId: "rollback-test-worker", pollIntervalMs: 1, heartbeatIntervalMs: 10, logger: silentLogger });
    await expect(worker.runOnce()).resolves.toBe(true);
    expect(await secondApp.jobs.getJob(jobId)).toMatchObject({ status: "failed" });

    const firstNewLinkPath = rebaseFixturePath(firstFixture.linkPath, oldSymlinkDir, newSymlinkDir);
    const secondNewLinkPath = rebaseFixturePath(secondFixture.linkPath, oldSymlinkDir, newSymlinkDir);
    expect(path.resolve(await fs.readlink(firstNewLinkPath))).toBe(path.resolve(firstFixture.targetPath));
    expect(path.resolve(await fs.readlink(secondNewLinkPath))).toBe(path.resolve(secondFixture.targetPath));
    const failedState = (await secondApp.app.inject({ method: "GET", url: "/api/system/path-migration", headers: { cookie } })).json<PathConfigurationState>();
    expect(failedState).toMatchObject({ blocking: true, status: "failed" });
    expect(failedState.migration?.errorMessage).toContain("Mapped target changed after analysis");
  });

  it("rolls back an applied symlink when cancellation is requested under the owned lease", async () => {
    const firstApp = await openApp();
    const cookie = await createAdminSession(firstApp);
    const firstFixture = await insertIndexedSymlink(firstApp, "Cancelled Title One", "first.bin");
    const secondFixture = await insertIndexedSymlink(firstApp, "Cancelled Title Two", "second.bin");
    await fs.symlink(oldSymlinkDir, newSymlinkDir, "dir");
    await fs.symlink(oldLocalDir, newLocalDir, "dir");
    const secondApp = await restartWithPaths(newSymlinkDir, newLocalDir);
    const state = (await secondApp.app.inject({ method: "GET", url: "/api/system/path-migration", headers: { cookie } })).json<PathConfigurationState>();
    await secondApp.app.inject({ method: "POST", url: "/api/system/path-migration/plan", headers: { cookie }, payload: { migrationId: state.migration?.id } });
    await secondApp.app.inject({
      method: "POST",
      url: "/api/system/path-migration/apply",
      headers: { cookie },
      payload: { migrationId: state.migration?.id, confirmSameStorage: true }
    });

    const abortController = new AbortController();
    let cancellationChecks = 0;
    let leaseChecks = 0;
    await expect(
      runPathMigration(secondApp.database.db, state.migration?.id ?? 0, {
        signal: abortController.signal,
        event: async () => undefined,
        setProgress: async () => undefined,
        isCancelled: async () => {
          cancellationChecks += 1;
          if (cancellationChecks > 1) abortController.abort();
          return cancellationChecks > 1;
        },
        assertLease: async () => {
          leaseChecks += 1;
        },
        withLease: async (action) => {
          leaseChecks += 1;
          return action();
        },
        withLeaseDb: async (action) => {
          leaseChecks += 1;
          return action(secondApp.database.db);
        },
        finishCompleted: async (action) => {
          await action(secondApp.database.db);
          return true;
        }
      })
    ).rejects.toThrow("Path migration was terminated");

    const firstNewLinkPath = rebaseFixturePath(firstFixture.linkPath, oldSymlinkDir, newSymlinkDir);
    const secondNewLinkPath = rebaseFixturePath(secondFixture.linkPath, oldSymlinkDir, newSymlinkDir);
    expect(path.resolve(await fs.readlink(firstNewLinkPath))).toBe(path.resolve(firstFixture.targetPath));
    expect(path.resolve(await fs.readlink(secondNewLinkPath))).toBe(path.resolve(secondFixture.targetPath));
    expect(leaseChecks).toBeGreaterThanOrEqual(3);
    const firstItem = await first(
      secondApp.database.db.select().from(schema.pathMigrationItems).where(eq(schema.pathMigrationItems.mediaLinkId, firstFixture.linkId)).limit(1)
    );
    expect(firstItem).toMatchObject({ validationStatus: "rolled_back" });
  });

  it("replays a symlink rename after losing its lease before the item state write", async () => {
    const firstApp = await openApp();
    const cookie = await createAdminSession(firstApp);
    const fixture = await insertIndexedSymlink(firstApp, "Lease Lost Title", "lease-lost.bin");
    await fs.symlink(oldSymlinkDir, newSymlinkDir, "dir");
    await fs.symlink(oldLocalDir, newLocalDir, "dir");
    const secondApp = await restartWithPaths(newSymlinkDir, newLocalDir);
    const state = (await secondApp.app.inject({ method: "GET", url: "/api/system/path-migration", headers: { cookie } })).json<PathConfigurationState>();
    await secondApp.app.inject({ method: "POST", url: "/api/system/path-migration/plan", headers: { cookie }, payload: { migrationId: state.migration?.id } });
    await secondApp.app.inject({
      method: "POST",
      url: "/api/system/path-migration/apply",
      headers: { cookie },
      payload: { migrationId: state.migration?.id, confirmSameStorage: true }
    });

    let leaseOwned = true;
    const leaseLostError = () => {
      const error = new Error("Job lease was superseded");
      error.name = "LeaseLostError";
      return error;
    };
    await expect(
      runPathMigration(secondApp.database.db, state.migration?.id ?? 0, {
        signal: new AbortController().signal,
        event: async () => undefined,
        setProgress: async () => undefined,
        isCancelled: async () => false,
        assertLease: async () => {
          if (!leaseOwned) throw leaseLostError();
        },
        withLease: async (action) => {
          if (!leaseOwned) throw leaseLostError();
          const result = await action();
          leaseOwned = false;
          return result;
        },
        withLeaseDb: async (action) => {
          if (!leaseOwned) throw leaseLostError();
          return action(secondApp.database.db);
        },
        finishCompleted: async (action) => {
          if (!leaseOwned) throw leaseLostError();
          await action(secondApp.database.db);
          return true;
        }
      })
    ).rejects.toThrow("Job lease was superseded");

    const newLinkPath = rebaseFixturePath(fixture.linkPath, oldSymlinkDir, newSymlinkDir);
    const newTargetPath = rebaseFixturePath(fixture.targetPath, oldLocalDir, newLocalDir);
    expect(path.resolve(await fs.readlink(newLinkPath))).toBe(path.resolve(newTargetPath));
    const mediaLink = await first(secondApp.database.db.select().from(schema.mediaLinks).where(eq(schema.mediaLinks.id, fixture.linkId)).limit(1));
    expect(mediaLink).toMatchObject({ linkPath: fixture.linkPath, targetPath: fixture.targetPath });
    const migration = await first(secondApp.database.db.select().from(schema.pathMigrations).where(eq(schema.pathMigrations.id, state.migration?.id ?? 0)).limit(1));
    expect(migration).toMatchObject({ status: "running" });
    const item = await first(
      secondApp.database.db.select().from(schema.pathMigrationItems).where(eq(schema.pathMigrationItems.mediaLinkId, fixture.linkId)).limit(1)
    );
    expect(item).toMatchObject({ validationStatus: "ready", rolledBackAt: null });

    await expect(
      runPathMigration(secondApp.database.db, state.migration?.id ?? 0, {
        signal: new AbortController().signal,
        event: async () => undefined,
        setProgress: async () => undefined,
        isCancelled: async () => false,
        assertLease: async () => undefined,
        withLease: (action) => action(),
        withLeaseDb: (action) => action(secondApp.database.db),
        finishCompleted: async (action) => {
          await action(secondApp.database.db);
          return true;
        }
      })
    ).resolves.toBeUndefined();
    const recoveredMediaLink = await first(secondApp.database.db.select().from(schema.mediaLinks).where(eq(schema.mediaLinks.id, fixture.linkId)).limit(1));
    expect(recoveredMediaLink).toMatchObject({ linkPath: newLinkPath, targetPath: newTargetPath });
    const recoveredMigration = await first(
      secondApp.database.db.select().from(schema.pathMigrations).where(eq(schema.pathMigrations.id, state.migration?.id ?? 0)).limit(1)
    );
    expect(recoveredMigration).toMatchObject({ status: "completed" });
    const recoveredItem = await first(
      secondApp.database.db.select().from(schema.pathMigrationItems).where(eq(schema.pathMigrationItems.mediaLinkId, fixture.linkId)).limit(1)
    );
    expect(recoveredItem).toMatchObject({ validationStatus: "applied", rolledBackAt: null });
  });

  it("preserves a symlink changed while migration waits for its mutation lease", async () => {
    const firstApp = await openApp();
    const cookie = await createAdminSession(firstApp);
    const fixture = await insertIndexedSymlink(firstApp, "Lease Wait Mutation", "lease-wait.bin");
    await fs.symlink(oldSymlinkDir, newSymlinkDir, "dir");
    await fs.symlink(oldLocalDir, newLocalDir, "dir");
    const secondApp = await restartWithPaths(newSymlinkDir, newLocalDir);
    const state = (await secondApp.app.inject({ method: "GET", url: "/api/system/path-migration", headers: { cookie } })).json<PathConfigurationState>();
    const migrationId = state.migration?.id ?? 0;
    const plan = await secondApp.app.inject({ method: "POST", url: "/api/system/path-migration/plan", headers: { cookie }, payload: { migrationId } });
    expect(plan.statusCode).toBe(200);
    const apply = await secondApp.app.inject({
      method: "POST",
      url: "/api/system/path-migration/apply",
      headers: { cookie },
      payload: { migrationId, confirmSameStorage: true }
    });
    expect(apply.statusCode).toBe(200);

    const migratedLinkPath = rebaseFixturePath(fixture.linkPath, oldSymlinkDir, newSymlinkDir);
    const externalTarget = path.join(tmpDir, "lease-wait-external-target.bin");
    await fs.writeFile(externalTarget, "external target installed while waiting for lease");
    let changedWhileWaiting = false;

    await expect(
      runPathMigration(secondApp.database.db, migrationId, {
        signal: new AbortController().signal,
        event: async () => undefined,
        setProgress: async () => undefined,
        isCancelled: async () => false,
        assertLease: async () => undefined,
        withLease: async (action) => {
          if (!changedWhileWaiting) {
            changedWhileWaiting = true;
            await fs.rm(migratedLinkPath);
            await fs.symlink(externalTarget, migratedLinkPath);
          }
          return action();
        },
        withLeaseDb: (action) => action(secondApp.database.db),
        finishCompleted: async (action) => {
          await action(secondApp.database.db);
          return true;
        }
      })
    ).rejects.toThrow("Symlink changed while path migration waited for its lease");

    expect(changedWhileWaiting).toBe(true);
    expect(path.resolve(await fs.readlink(migratedLinkPath))).toBe(path.resolve(externalTarget));
    await expect(first(secondApp.database.db.select().from(schema.pathMigrationItems).where(eq(schema.pathMigrationItems.mediaLinkId, fixture.linkId)).limit(1))).resolves.toMatchObject({
      validationStatus: "blocked",
      rolledBackAt: null,
      message: expect.stringContaining("Manual review is required")
    });
    await expect(first(secondApp.database.db.select().from(schema.pathMigrations).where(eq(schema.pathMigrations.id, migrationId)).limit(1))).resolves.toMatchObject({
      status: "failed",
      errorMessage: expect.stringContaining("Rollback also failed for 1 symlink(s)")
    });
  });

  it("revalidates an unchanged target while waiting to record the migration step", async () => {
    const firstApp = await openApp();
    const cookie = await createAdminSession(firstApp);
    const fixture = await insertIndexedSymlink(firstApp, "Unchanged Target Lease Wait", "unchanged-target.bin");
    await fs.symlink(oldSymlinkDir, newSymlinkDir, "dir");
    const secondApp = await restartWithPaths(newSymlinkDir, oldLocalDir);
    const state = (await secondApp.app.inject({ method: "GET", url: "/api/system/path-migration", headers: { cookie } })).json<PathConfigurationState>();
    const migrationId = state.migration?.id ?? 0;
    const plan = await secondApp.app.inject({ method: "POST", url: "/api/system/path-migration/plan", headers: { cookie }, payload: { migrationId } });
    expect(plan.statusCode).toBe(200);
    await expect(
      first(secondApp.database.db.select().from(schema.pathMigrationItems).where(eq(schema.pathMigrationItems.mediaLinkId, fixture.linkId)).limit(1))
    ).resolves.toMatchObject({ targetChanged: false, validationStatus: "ready" });
    const apply = await secondApp.app.inject({
      method: "POST",
      url: "/api/system/path-migration/apply",
      headers: { cookie },
      payload: { migrationId, confirmSameStorage: true }
    });
    expect(apply.statusCode).toBe(200);

    const migratedLinkPath = rebaseFixturePath(fixture.linkPath, oldSymlinkDir, newSymlinkDir);
    const externalTarget = path.join(tmpDir, "unchanged-target-external.bin");
    await fs.writeFile(externalTarget, "external target installed before migration state was recorded");
    let leaseDbCalls = 0;

    await expect(
      runPathMigration(secondApp.database.db, migrationId, {
        signal: new AbortController().signal,
        event: async () => undefined,
        setProgress: async () => undefined,
        isCancelled: async () => false,
        assertLease: async () => undefined,
        withLease: (action) => action(),
        withLeaseDb: async (action) => {
          leaseDbCalls += 1;
          if (leaseDbCalls === 2) {
            await fs.rm(migratedLinkPath);
            await fs.symlink(externalTarget, migratedLinkPath);
          }
          return action(secondApp.database.db);
        },
        finishCompleted: async (action) => {
          await action(secondApp.database.db);
          return true;
        }
      })
    ).rejects.toThrow("Symlink changed after analysis");

    expect(leaseDbCalls).toBeGreaterThanOrEqual(4);
    expect(path.resolve(await fs.readlink(migratedLinkPath))).toBe(path.resolve(externalTarget));
    await expect(first(secondApp.database.db.select().from(schema.pathMigrationItems).where(eq(schema.pathMigrationItems.mediaLinkId, fixture.linkId)).limit(1))).resolves.toMatchObject({
      validationStatus: "rolled_back",
      message: "Migration step remained at its original target."
    });
    await expect(first(secondApp.database.db.select().from(schema.pathMigrations).where(eq(schema.pathMigrations.id, migrationId)).limit(1))).resolves.toMatchObject({
      status: "failed",
      errorMessage: expect.stringContaining("Symlink changed after analysis")
    });
  });

  it("reapplies an applied item after lease loss between rollback rename and state write", async () => {
    const firstApp = await openApp();
    const cookie = await createAdminSession(firstApp);
    const fixture = await insertIndexedSymlink(firstApp, "Rollback Lease Lost", "rollback-lease-lost.bin");
    await fs.symlink(oldSymlinkDir, newSymlinkDir, "dir");
    await fs.symlink(oldLocalDir, newLocalDir, "dir");
    const secondApp = await restartWithPaths(newSymlinkDir, newLocalDir);
    const state = (await secondApp.app.inject({ method: "GET", url: "/api/system/path-migration", headers: { cookie } })).json<PathConfigurationState>();
    await secondApp.app.inject({ method: "POST", url: "/api/system/path-migration/plan", headers: { cookie }, payload: { migrationId: state.migration?.id } });
    const apply = await secondApp.app.inject({
      method: "POST",
      url: "/api/system/path-migration/apply",
      headers: { cookie },
      payload: { migrationId: state.migration?.id, confirmSameStorage: true }
    });
    expect(apply.statusCode).toBe(200);

    let leaseOwned = true;
    let filesystemMutations = 0;
    const leaseLostError = () => {
      const error = new Error("Job lease was superseded during rollback");
      error.name = "LeaseLostError";
      return error;
    };
    await expect(
      runPathMigration(secondApp.database.db, state.migration?.id ?? 0, {
        signal: new AbortController().signal,
        event: async () => undefined,
        setProgress: async () => undefined,
        isCancelled: async () => false,
        assertLease: async () => {
          if (!leaseOwned) throw leaseLostError();
        },
        withLease: async (action) => {
          if (!leaseOwned) throw leaseLostError();
          const result = await action();
          filesystemMutations += 1;
          if (filesystemMutations === 2) leaseOwned = false;
          return result;
        },
        withLeaseDb: async (action) => {
          if (!leaseOwned) throw leaseLostError();
          return action(secondApp.database.db);
        },
        finishCompleted: async () => {
          throw new Error("Injected final commit failure");
        }
      })
    ).rejects.toThrow("Job lease was superseded during rollback");

    const newLinkPath = rebaseFixturePath(fixture.linkPath, oldSymlinkDir, newSymlinkDir);
    const newTargetPath = rebaseFixturePath(fixture.targetPath, oldLocalDir, newLocalDir);
    expect(path.resolve(await fs.readlink(newLinkPath))).toBe(path.resolve(fixture.targetPath));
    await expect(
      first(secondApp.database.db.select().from(schema.pathMigrationItems).where(eq(schema.pathMigrationItems.mediaLinkId, fixture.linkId)).limit(1))
    ).resolves.toMatchObject({ validationStatus: "applied", rolledBackAt: null });

    await expect(
      runPathMigration(secondApp.database.db, state.migration?.id ?? 0, {
        signal: new AbortController().signal,
        event: async () => undefined,
        setProgress: async () => undefined,
        isCancelled: async () => false,
        assertLease: async () => undefined,
        withLease: (action) => action(),
        withLeaseDb: (action) => action(secondApp.database.db),
        finishCompleted: async (action) => {
          await action(secondApp.database.db);
          return true;
        }
      })
    ).resolves.toBeUndefined();

    expect(path.resolve(await fs.readlink(newLinkPath))).toBe(path.resolve(newTargetPath));
    await expect(first(secondApp.database.db.select().from(schema.mediaLinks).where(eq(schema.mediaLinks.id, fixture.linkId)).limit(1))).resolves.toMatchObject({
      linkPath: newLinkPath,
      targetPath: newTargetPath
    });
    await expect(first(secondApp.database.db.select().from(schema.pathMigrations).where(eq(schema.pathMigrations.id, state.migration?.id ?? 0)).limit(1))).resolves.toMatchObject({
      status: "completed"
    });
  });

  it("restores a renamed symlink when the durable item state write fails", async () => {
    const firstApp = await openApp();
    const cookie = await createAdminSession(firstApp);
    const fixture = await insertIndexedSymlink(firstApp, "State Write Failure", "state-write-failure.bin");
    await fs.symlink(oldSymlinkDir, newSymlinkDir, "dir");
    await fs.symlink(oldLocalDir, newLocalDir, "dir");
    const secondApp = await restartWithPaths(newSymlinkDir, newLocalDir);
    const state = (await secondApp.app.inject({ method: "GET", url: "/api/system/path-migration", headers: { cookie } })).json<PathConfigurationState>();
    await secondApp.app.inject({ method: "POST", url: "/api/system/path-migration/plan", headers: { cookie }, payload: { migrationId: state.migration?.id } });
    const apply = await secondApp.app.inject({
      method: "POST",
      url: "/api/system/path-migration/apply",
      headers: { cookie },
      payload: { migrationId: state.migration?.id, confirmSameStorage: true }
    });
    expect(apply.statusCode).toBe(200);

    let leaseDbCalls = 0;
    const injectedError = "Injected item state write failure";
    await expect(
      runPathMigration(secondApp.database.db, state.migration?.id ?? 0, {
        signal: new AbortController().signal,
        event: async () => undefined,
        setProgress: async () => undefined,
        isCancelled: async () => false,
        assertLease: async () => undefined,
        withLease: (action) => action(),
        withLeaseDb: async (action) => {
          leaseDbCalls += 1;
          if (leaseDbCalls === 2) throw new Error(injectedError);
          return action(secondApp.database.db);
        },
        finishCompleted: async (action) => {
          await action(secondApp.database.db);
          return true;
        }
      })
    ).rejects.toThrow(injectedError);

    const newLinkPath = rebaseFixturePath(fixture.linkPath, oldSymlinkDir, newSymlinkDir);
    expect(path.resolve(await fs.readlink(newLinkPath))).toBe(path.resolve(fixture.targetPath));
    const migration = await first(secondApp.database.db.select().from(schema.pathMigrations).where(eq(schema.pathMigrations.id, state.migration?.id ?? 0)).limit(1));
    expect(migration).toMatchObject({ status: "failed", errorMessage: expect.stringContaining(injectedError) });
    const item = await first(
      secondApp.database.db.select().from(schema.pathMigrationItems).where(eq(schema.pathMigrationItems.mediaLinkId, fixture.linkId)).limit(1)
    );
    expect(item).toMatchObject({ validationStatus: "rolled_back", appliedAt: null });
    expect(leaseDbCalls).toBeGreaterThanOrEqual(4);
  });

  it("blocks rollback when an applied symlink changes again during recovery", async () => {
    const firstApp = await openApp();
    const cookie = await createAdminSession(firstApp);
    const firstFixture = await insertIndexedSymlink(firstApp, "Externally Changed Title", "first.bin");
    const secondFixture = await insertIndexedSymlink(firstApp, "Later Failure Title", "second.bin");
    await fs.symlink(oldSymlinkDir, newSymlinkDir, "dir");
    await fs.symlink(oldLocalDir, newLocalDir, "dir");
    const secondApp = await restartWithPaths(newSymlinkDir, newLocalDir);
    const state = (await secondApp.app.inject({ method: "GET", url: "/api/system/path-migration", headers: { cookie } })).json<PathConfigurationState>();
    await secondApp.app.inject({ method: "POST", url: "/api/system/path-migration/plan", headers: { cookie }, payload: { migrationId: state.migration?.id } });
    await fs.writeFile(secondFixture.targetPath, "changed after migration analysis");
    await secondApp.app.inject({
      method: "POST",
      url: "/api/system/path-migration/apply",
      headers: { cookie },
      payload: { migrationId: state.migration?.id, confirmSameStorage: true }
    });

    const migrationId = state.migration?.id ?? 0;
    const firstNewLinkPath = rebaseFixturePath(firstFixture.linkPath, oldSymlinkDir, newSymlinkDir);
    const externalTarget = path.join(tmpDir, "external-target.bin");
    await fs.writeFile(externalTarget, "external target");
    let cancellationChecks = 0;

    await expect(
      runPathMigration(secondApp.database.db, migrationId, {
        signal: new AbortController().signal,
        event: async () => undefined,
        setProgress: async () => undefined,
        isCancelled: async () => {
          cancellationChecks += 1;
          if (cancellationChecks === 2) {
            await fs.rm(firstNewLinkPath);
            await fs.symlink(externalTarget, firstNewLinkPath);
          }
          return false;
        },
        assertLease: async () => undefined,
        withLease: (action) => action(),
        withLeaseDb: (action) => action(secondApp.database.db),
        finishCompleted: async (action) => {
          await action(secondApp.database.db);
          return true;
        }
      })
    ).rejects.toThrow("Rollback also failed for 1 symlink(s)");

    expect(path.resolve(await fs.readlink(firstNewLinkPath))).toBe(path.resolve(externalTarget));
    const blockedItem = await first(
      secondApp.database.db.select().from(schema.pathMigrationItems).where(eq(schema.pathMigrationItems.mediaLinkId, firstFixture.linkId)).limit(1)
    );
    expect(blockedItem).toMatchObject({ validationStatus: "blocked", rolledBackAt: null });
    expect(blockedItem?.message).toContain("Manual review is required");
    const failedState = (await secondApp.app.inject({ method: "GET", url: "/api/system/path-migration", headers: { cookie } })).json<PathConfigurationState>();
    expect(failedState).toMatchObject({ blocking: true, status: "failed" });
    expect(failedState.migration?.summary.blockedLinks).toBe(1);
    expect(failedState.migration?.errorMessage).toContain("Rollback also failed for 1 symlink(s)");
  });

  it("rolls back and does not resurrect a migration when environment paths are restored while it runs", async () => {
    const firstApp = await openApp();
    const cookie = await createAdminSession(firstApp);
    const firstFixture = await insertIndexedSymlink(firstApp, "Restore While Running One", "first.bin");
    const secondFixture = await insertIndexedSymlink(firstApp, "Restore While Running Two", "second.bin");
    await fs.symlink(oldSymlinkDir, newSymlinkDir, "dir");
    await fs.symlink(oldLocalDir, newLocalDir, "dir");
    const secondApp = await restartWithPaths(newSymlinkDir, newLocalDir);
    const state = (await secondApp.app.inject({ method: "GET", url: "/api/system/path-migration", headers: { cookie } })).json<PathConfigurationState>();
    await secondApp.app.inject({ method: "POST", url: "/api/system/path-migration/plan", headers: { cookie }, payload: { migrationId: state.migration?.id } });
    const migrationId = state.migration?.id ?? 0;
    await secondApp.database.db.update(schema.pathMigrations).set({ status: "queued" }).where(eq(schema.pathMigrations.id, migrationId));
    let cancellationChecks = 0;

    await expect(
      runPathMigration(secondApp.database.db, migrationId, {
        signal: new AbortController().signal,
        event: async () => undefined,
        setProgress: async () => undefined,
        isCancelled: async () => {
          cancellationChecks += 1;
          if (cancellationChecks === 2) {
            await reconcileEnvironmentPaths(secondApp.database.db, { symlinkDir: oldSymlinkDir, localDir: oldLocalDir, remoteDir });
          }
          return false;
        },
        assertLease: async () => undefined,
        withLease: (action) => action(),
        withLeaseDb: (action) => action(secondApp.database.db),
        finishCompleted: async (action) => {
          await action(secondApp.database.db);
          return true;
        }
      })
    ).rejects.toThrow("Detected paths changed again");

    const firstNewLinkPath = rebaseFixturePath(firstFixture.linkPath, oldSymlinkDir, newSymlinkDir);
    const secondNewLinkPath = rebaseFixturePath(secondFixture.linkPath, oldSymlinkDir, newSymlinkDir);
    expect(path.resolve(await fs.readlink(firstNewLinkPath))).toBe(path.resolve(firstFixture.targetPath));
    expect(path.resolve(await fs.readlink(secondNewLinkPath))).toBe(path.resolve(secondFixture.targetPath));
    expect(await first(secondApp.database.db.select().from(schema.pathMigrations).where(eq(schema.pathMigrations.id, migrationId)).limit(1))).toMatchObject({
      status: "rollback_pending"
    });
    const recoveryWorker = new JobWorker(secondApp.database.db, { workerId: "restore-rollback-worker", pollIntervalMs: 1, heartbeatIntervalMs: 10, logger: silentLogger });
    await expect(recoveryWorker.runOnce()).resolves.toBe(true);
    const migration = await first(secondApp.database.db.select().from(schema.pathMigrations).where(eq(schema.pathMigrations.id, migrationId)).limit(1));
    expect(migration?.status).toBe("cancelled");
  });

  it("preserves the indexed target when moving a relative symlink tree to a different depth", async () => {
    const firstApp = await openApp();
    const cookie = await createAdminSession(firstApp);
    const fixture = await insertIndexedSymlink(firstApp, "Relative Title", "relative.bin", true);
    newSymlinkDir = path.join(tmpDir, "nested", "mount", "symlinks-new");
    await fs.mkdir(path.dirname(newSymlinkDir), { recursive: true });
    await fs.symlink(oldSymlinkDir, newSymlinkDir, "dir");
    const secondApp = await restartWithPaths(newSymlinkDir, oldLocalDir);
    const state = (await secondApp.app.inject({ method: "GET", url: "/api/system/path-migration", headers: { cookie } })).json<PathConfigurationState>();
    const plan = await secondApp.app.inject({ method: "POST", url: "/api/system/path-migration/plan", headers: { cookie }, payload: { migrationId: state.migration?.id } });
    expect(plan.json<PathConfigurationState>().migration?.summary).toMatchObject({ affectedLinks: 1, readyLinks: 1, blockedLinks: 0, repointLinks: 1 });
    const apply = await secondApp.app.inject({
      method: "POST",
      url: "/api/system/path-migration/apply",
      headers: { cookie },
      payload: { migrationId: state.migration?.id, confirmSameStorage: true }
    });
    const worker = new JobWorker(secondApp.database.db, { workerId: "relative-link-worker", pollIntervalMs: 1, heartbeatIntervalMs: 10, logger: silentLogger });
    await expect(worker.runOnce()).resolves.toBe(true);
    expect(await secondApp.jobs.getJob(apply.json<{ jobId: number }>().jobId)).toMatchObject({ status: "completed" });
    const migratedLinkPath = rebaseFixturePath(fixture.linkPath, oldSymlinkDir, newSymlinkDir);
    expect(path.resolve(await fs.readlink(migratedLinkPath))).toBe(path.resolve(fixture.targetPath));
  });
});

function rebaseFixturePath(value: string, oldRoot: string, newRoot: string): string {
  return path.join(newRoot, path.relative(oldRoot, value));
}
