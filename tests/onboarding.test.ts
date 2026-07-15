import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { asc, eq } from "drizzle-orm";
import { createApp, type AppContext } from "../src/server/app";
import * as schema from "../src/server/db/schema";
import { JobWorker } from "../src/server/jobs/jobRunner";
import type { OnboardingPolicyMode, OnboardingState } from "../src/shared/types";
import { createTestDatabase, type TestDatabaseHandle } from "./testDb";

const silentLogger = { info: () => undefined, warn: () => undefined, error: () => undefined };

describe("first-run onboarding", () => {
  let app: AppContext | null = null;
  let database: TestDatabaseHandle | null = null;
  let tmpDir: string | null = null;

  afterEach(async () => {
    if (app) await app.app.close();
    if (database) await database.cleanup();
    if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
    app = null;
    database = null;
    tmpDir = null;
  });

  async function createFixture(): Promise<{ cookie: string; section: string }> {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "srtl-onboarding-"));
    const symlinkDir = path.join(tmpDir, "links");
    const localDir = path.join(tmpDir, "local");
    const remoteDir = path.join(tmpDir, "remote");
    const section = "library";
    await Promise.all([
      fs.mkdir(path.join(symlinkDir, section), { recursive: true }),
      fs.mkdir(path.join(localDir, section), { recursive: true }),
      fs.mkdir(path.join(remoteDir, section), { recursive: true }),
      fs.mkdir(path.join(localDir, "not-a-symlink-section"), { recursive: true }),
      fs.mkdir(path.join(remoteDir, "also-not-a-symlink-section"), { recursive: true })
    ]);

    const fixtures = [
      { title: "Local Title (2024)", fileName: "local-title.mkv", root: localDir },
      { title: "Remote Title (2025)", fileName: "remote-title.mkv", root: remoteDir },
      { title: "Mixed Title (2026)", fileName: "mixed-local.mkv", root: localDir },
      { title: "Mixed Title (2026)", fileName: "mixed-remote.mkv", root: remoteDir }
    ];
    for (const fixture of fixtures) {
      const target = path.join(fixture.root, section, fixture.title, fixture.fileName);
      const link = path.join(symlinkDir, section, fixture.title, fixture.fileName);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.mkdir(path.dirname(link), { recursive: true });
      await fs.writeFile(target, fixture.title);
      await fs.symlink(target, link);
    }

    await fs.writeFile(
      path.join(tmpDir, ".env"),
      [`SYMLINK_DIR="${symlinkDir}"`, `SRTL_LOCATION_1_PATH="${localDir}"`, `SRTL_LOCATION_2_PATH="${remoteDir}"`].join("\n")
    );
    database = await createTestDatabase();
    app = await createApp({ rootDir: tmpDir, dataDir: path.join(tmpDir, "data"), databaseUrl: database.databaseUrl });
    const setup = await app.app.inject({
      method: "POST",
      url: "/api/auth/setup",
      payload: { username: "admin", password: "password123", confirmPassword: "password123" }
    });
    expect(setup.statusCode).toBe(200);
    return { cookie: String(setup.headers["set-cookie"]), section };
  }

  async function runInitialScan(policyMode: OnboardingPolicyMode, beforeStart?: () => Promise<void>): Promise<OnboardingState> {
    const { cookie, section } = await createFixture();
    if (!app) throw new Error("App fixture was not created");

    const initial = await app.app.inject({ method: "GET", url: "/api/onboarding", headers: { cookie } });
    expect(initial.statusCode).toBe(200);
    expect(initial.json<OnboardingState>()).toMatchObject({
      required: true,
      phase: "configuration_required",
      detectedSections: [section],
      storageLocations: {
        locations: [
          { key: "location_1", rootType: "local", displayName: "Local" },
          { key: "location_2", rootType: "remote", displayName: "Remote" }
        ]
      },
      pathChecks: [{ ready: true }, { ready: true }, { ready: true }]
    });

    const blockedScan = await app.app.inject({
      method: "POST",
      url: "/api/scans",
      headers: { cookie },
      payload: { scanSymlinks: true, scanLocal: false, scanRemote: false }
    });
    expect(blockedScan.statusCode).toBe(423);
    expect(blockedScan.json()).toMatchObject({ error: "Complete initial setup before modifying the library." });

    await beforeStart?.();

    const started = await app.app.inject({
      method: "POST",
      url: "/api/onboarding/start",
      headers: { cookie },
      payload: {
        storageLocations: {
          locations: [
            { key: "location_1", displayName: "Primary storage" },
            { key: "location_2", displayName: "Archive storage" }
          ]
        },
        sections: { sections: [section], sectionTitles: { [section]: "Primary Library" }, sectionTypes: { [section]: "other" } },
        policyMode
      }
    });
    expect(started.statusCode).toBe(200);
    const jobId = started.json<{ jobId: number }>().jobId;
    expect(jobId).toBeGreaterThan(0);

    const worker = new JobWorker(app.database.db, { workerId: "onboarding-test-worker", pollIntervalMs: 1, heartbeatIntervalMs: 10, logger: silentLogger });
    await expect(worker.runOnce()).resolves.toBe(true);
    await expect(app.jobs.getJob(jobId)).resolves.toMatchObject({ status: "completed" });

    const completed = await app.app.inject({ method: "GET", url: "/api/onboarding", headers: { cookie } });
    expect(completed.statusCode).toBe(200);
    return completed.json<OnboardingState>();
  }

  it("assigns local, remote-only, and mixed titles from the first scan", async () => {
    const state = await runInitialScan("match_current_locations");
    expect(state).toMatchObject({
      required: false,
      phase: "completed",
      policyMode: "match_current_locations",
      storageLocations: {
        locations: [
          { key: "location_1", displayName: "Primary storage" },
          { key: "location_2", displayName: "Archive storage" }
        ]
      },
      policyResult: {
        totalTitles: 3,
        assignedLocalTitles: 2,
        assignedRemoteTitles: 1,
        unassignedTitles: 0,
        mixedTitles: 1,
        localSymlinks: 2,
        remoteSymlinks: 2
      }
    });

    const policies = await app!.database.db.select().from(schema.storagePolicies).orderBy(asc(schema.storagePolicies.title));
    expect(policies.map((policy) => [policy.title, policy.policy, policy.source])).toEqual([
      ["Local Title (2024)", "location_1", "onboarding"],
      ["Mixed Title (2026)", "location_1", "onboarding"],
      ["Remote Title (2025)", "location_2", "onboarding"]
    ]);
    const mixedLinks = await app!.database.db.select().from(schema.mediaLinks).where(eq(schema.mediaLinks.itemName, "Mixed Title (2026)"));
    expect(mixedLinks).toHaveLength(2);
    expect(mixedLinks.every((link) => link.storagePolicy === "location_1")).toBe(true);
  });

  it("leaves every scanned title unassigned when manual assignment is selected", async () => {
    const state = await runInitialScan("leave_unassigned", async () => {
      await app!.database.db.insert(schema.storagePolicies).values({
        title: "Remote Title (2025)!",
        normalizedTitle: "remote title (2025)!",
        policy: "location_2",
        source: "manual",
        updatedAt: new Date().toISOString()
      });
    });
    expect(state).toMatchObject({
      required: false,
      phase: "completed",
      policyMode: "leave_unassigned",
      policyResult: {
        totalTitles: 3,
        assignedLocalTitles: 0,
        assignedRemoteTitles: 0,
        unassignedTitles: 3,
        mixedTitles: 1
      }
    });
    expect(await app!.database.db.select().from(schema.storagePolicies)).toEqual([]);
    const links = await app!.database.db.select().from(schema.mediaLinks);
    expect(links).toHaveLength(4);
    expect(links.every((link) => link.storagePolicy === "unassigned")).toBe(true);
  });

  it("rejects duplicate friendly names before queueing the initial scan", async () => {
    const { cookie, section } = await createFixture();
    if (!app) throw new Error("App fixture was not created");
    const response = await app.app.inject({
      method: "POST",
      url: "/api/onboarding/start",
      headers: { cookie },
      payload: {
        storageLocations: {
          locations: [
            { key: "location_1", displayName: "Storage" },
            { key: "location_2", displayName: "storage" }
          ]
        },
        sections: { sections: [section], sectionTypes: { [section]: "other" } },
        policyMode: "leave_unassigned"
      }
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: "Friendly names must be unique" });
    expect(await app.database.db.select().from(schema.jobs)).toEqual([]);
  });

  it("marks a pre-onboarding installation complete instead of interrupting an existing admin", async () => {
    const { cookie } = await createFixture();
    if (!app || !database || !tmpDir) throw new Error("App fixture was not created");
    await app.database.db.delete(schema.appSettings).where(eq(schema.appSettings.key, "onboarding.v1"));
    await app.app.close();
    app = await createApp({ rootDir: tmpDir, dataDir: path.join(tmpDir, "data"), databaseUrl: database.databaseUrl });

    const response = await app.app.inject({ method: "GET", url: "/api/onboarding", headers: { cookie } });
    expect(response.statusCode).toBe(200);
    expect(response.json<OnboardingState>()).toMatchObject({ required: false, phase: "completed", initialScanJobId: null });
  });
});
