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
import { reconcileEnvironmentPaths, runPathMigration } from "../src/server/lib/pathConfiguration";
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
        isCancelled: async () => false
      })
    ).resolves.toBeUndefined();
    expect(recoveredProgress.at(-1)).toMatchObject({ stage: "completed", current: 1, total: 1 });
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
    expect(failedState).toMatchObject({ blocking: true, status: "failed" });
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

  it("rolls back symlinks already repointed when a later target changes after analysis", async () => {
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

    await fs.writeFile(secondFixture.targetPath, "changed after migration analysis");
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
        }
      })
    ).rejects.toThrow("Detected paths changed again");

    const firstNewLinkPath = rebaseFixturePath(firstFixture.linkPath, oldSymlinkDir, newSymlinkDir);
    const secondNewLinkPath = rebaseFixturePath(secondFixture.linkPath, oldSymlinkDir, newSymlinkDir);
    expect(path.resolve(await fs.readlink(firstNewLinkPath))).toBe(path.resolve(firstFixture.targetPath));
    expect(path.resolve(await fs.readlink(secondNewLinkPath))).toBe(path.resolve(secondFixture.targetPath));
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
