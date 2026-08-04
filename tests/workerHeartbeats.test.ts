import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { asc, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createApp, type AppContext } from "../src/server/app";
import { openDatabase } from "../src/server/db/database";
import * as schema from "../src/server/db/schema";
import { pruneWorkerHeartbeatHistory, recordWorkerHeartbeat, workerHeartbeatRetentionMs } from "../src/server/lib/workerHeartbeats";
import { createTestDatabase } from "./testDb";

describe("worker heartbeat history", () => {
  it("prunes stopped workers and running workers older than the retention window", async () => {
    const testDatabase = await createTestDatabase();
    const database = await openDatabase(testDatabase.databaseUrl);
    const nowMs = Date.parse("2026-07-29T18:00:00.000Z");
    const recentHeartbeat = new Date(nowMs - 5 * 60_000).toISOString();
    const oldHeartbeat = new Date(nowMs - workerHeartbeatRetentionMs - 1).toISOString();
    try {
      await database.db.insert(schema.workerHeartbeats).values([
        { workerId: "recent-running", startedAt: recentHeartbeat, heartbeatAt: recentHeartbeat, status: "running" },
        { workerId: "old-running", startedAt: oldHeartbeat, heartbeatAt: oldHeartbeat, status: "running" },
        { workerId: "recent-stopped", startedAt: recentHeartbeat, heartbeatAt: recentHeartbeat, status: "stopped" },
        { workerId: "old-stopped", startedAt: oldHeartbeat, heartbeatAt: oldHeartbeat, status: "stopped" }
      ]);

      await pruneWorkerHeartbeatHistory(database.db, nowMs);

      expect(await database.db.select().from(schema.workerHeartbeats).orderBy(asc(schema.workerHeartbeats.workerId))).toEqual([
        { workerId: "recent-running", startedAt: recentHeartbeat, heartbeatAt: recentHeartbeat, status: "running", capacity: 1 }
      ]);
    } finally {
      await database.close();
      await testDatabase.cleanup();
    }
  });

  it("upserts one process heartbeat with its advertised capacity", async () => {
    const testDatabase = await createTestDatabase();
    const database = await openDatabase(testDatabase.databaseUrl);
    const startedAt = "2026-07-29T18:00:00.000Z";
    try {
      await recordWorkerHeartbeat(database.db, {
        workerId: "worker-process:boot-id",
        startedAt,
        heartbeatAt: "2026-07-29T18:00:01.000Z",
        status: "running",
        capacity: 128
      });
      await recordWorkerHeartbeat(database.db, {
        workerId: "worker-process:boot-id",
        startedAt,
        heartbeatAt: "2026-07-29T18:00:02.000Z",
        status: "stopped",
        capacity: 128
      });

      expect(await database.db.select().from(schema.workerHeartbeats)).toEqual([
        {
          workerId: "worker-process:boot-id",
          startedAt,
          heartbeatAt: "2026-07-29T18:00:02.000Z",
          status: "stopped",
          capacity: 128
        }
      ]);
    } finally {
      await database.close();
      await testDatabase.cleanup();
    }
  });

  it("retains a stopped worker heartbeat while a running job still owns its lease", async () => {
    const testDatabase = await createTestDatabase();
    const database = await openDatabase(testDatabase.databaseUrl);
    const timestamp = "2026-07-29T18:00:00.000Z";
    try {
      await database.db.insert(schema.workerHeartbeats).values({
        workerId: "stopped-lease-owner",
        startedAt: timestamp,
        heartbeatAt: timestamp,
        status: "stopped",
        capacity: 2
      });
      await database.db.insert(schema.jobs).values({
        type: "copy",
        status: "running",
        createdAt: timestamp,
        startedAt: timestamp,
        finishedAt: null,
        lockedBy: "stopped-lease-owner",
        lockedAt: timestamp,
        heartbeatAt: timestamp,
        leaseVersion: 1,
        exclusive: false,
        cancelRequestedAt: null,
        progress: "{}"
      });

      await pruneWorkerHeartbeatHistory(database.db, Date.parse(timestamp) + 60_000);

      expect(await database.db.select().from(schema.workerHeartbeats)).toEqual([
        {
          workerId: "stopped-lease-owner",
          startedAt: timestamp,
          heartbeatAt: timestamp,
          status: "stopped",
          capacity: 2
        }
      ]);
    } finally {
      await database.close();
      await testDatabase.cleanup();
    }
  });

  it("reports not_started when heartbeat history contains only stopped workers", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "srtl-worker-health-"));
    const testDatabase = await createTestDatabase();
    let app: AppContext | null = null;
    const symlinkDir = path.join(tmpDir, "symlinks");
    const localDir = path.join(tmpDir, "local");
    const remoteDir = path.join(tmpDir, "remote");
    try {
      await Promise.all([fs.mkdir(symlinkDir), fs.mkdir(localDir), fs.mkdir(remoteDir)]);
      app = await createApp({
        rootDir: tmpDir,
        dataDir: path.join(tmpDir, "data"),
        databaseUrl: testDatabase.databaseUrl,
        apiDocsEnabled: false,
        autoMigrate: true,
        paths: { symlinkDir, localDir, remoteDir },
        jobConcurrency: {
          workerCount: 1,
          maxRunningJobs: 1,
          maxRunningScans: 1,
          maxRunningAudits: 1,
          maxRunningCopies: 1,
          copyFileConcurrency: 1,
          maxActiveCopyFiles: 1
        }
      });
      const heartbeatAt = new Date().toISOString();
      await app.database.db.insert(schema.workerHeartbeats).values({ workerId: "historical-worker", startedAt: heartbeatAt, heartbeatAt, status: "stopped" });

      const response = await app.app.inject({ method: "GET", url: "/api/health" });
      const readiness = await app.app.inject({ method: "GET", url: "/api/health/ready" });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        worker: "not_started",
        workerHeartbeatAt: null,
        expectedWorkerCount: 1,
        readyWorkerCount: 0,
        staleWorkerCount: 0
      });
      expect(readiness.statusCode).toBe(503);
      expect(readiness.json()).toMatchObject({ ok: false, worker: "not_started" });
    } finally {
      if (app) await app.app.close();
      await testDatabase.cleanup();
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("sums fresh and stale process capacity for worker health", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "srtl-worker-capacity-health-"));
    const testDatabase = await createTestDatabase();
    let app: AppContext | null = null;
    const symlinkDir = path.join(tmpDir, "symlinks");
    const localDir = path.join(tmpDir, "local");
    const remoteDir = path.join(tmpDir, "remote");
    try {
      await Promise.all([fs.mkdir(symlinkDir), fs.mkdir(localDir), fs.mkdir(remoteDir)]);
      app = await createApp({
        rootDir: tmpDir,
        dataDir: path.join(tmpDir, "data"),
        databaseUrl: testDatabase.databaseUrl,
        apiDocsEnabled: false,
        autoMigrate: true,
        paths: { symlinkDir, localDir, remoteDir },
        jobConcurrency: {
          workerCount: 8,
          maxRunningJobs: 5,
          maxRunningScans: 5,
          maxRunningAudits: 5,
          maxRunningCopies: 5,
          copyFileConcurrency: 1,
          maxActiveCopyFiles: 5
        }
      });
      const freshHeartbeatAt = new Date().toISOString();
      const staleHeartbeatAt = new Date(Date.now() - 31_000).toISOString();
      await app.database.db.insert(schema.workerHeartbeats).values([
        { workerId: "fresh-a", startedAt: freshHeartbeatAt, heartbeatAt: freshHeartbeatAt, status: "running", capacity: 2 },
        { workerId: "fresh-b", startedAt: freshHeartbeatAt, heartbeatAt: freshHeartbeatAt, status: "running", capacity: 3 },
        { workerId: "stale", startedAt: staleHeartbeatAt, heartbeatAt: staleHeartbeatAt, status: "running", capacity: 7 },
        { workerId: "stopped", startedAt: freshHeartbeatAt, heartbeatAt: freshHeartbeatAt, status: "stopped", capacity: 99 }
      ]);

      const readyResponse = await app.app.inject({ method: "GET", url: "/api/health" });
      const readyReadiness = await app.app.inject({ method: "GET", url: "/api/health/ready" });
      expect(readyResponse.statusCode).toBe(200);
      expect(readyResponse.json()).toMatchObject({
        worker: "ready",
        workerHeartbeatAt: freshHeartbeatAt,
        expectedWorkerCount: 5,
        readyWorkerCount: 5,
        staleWorkerCount: 7
      });
      expect(readyReadiness.statusCode).toBe(200);
      expect(readyReadiness.json()).toMatchObject({ ok: true, worker: "ready" });

      await app.database.db.update(schema.workerHeartbeats).set({ status: "stopped" }).where(eq(schema.workerHeartbeats.workerId, "fresh-b"));
      const partialResponse = await app.app.inject({ method: "GET", url: "/api/health" });
      const partialReadiness = await app.app.inject({ method: "GET", url: "/api/health/ready" });
      expect(partialResponse.json()).toMatchObject({
        worker: "stale",
        expectedWorkerCount: 5,
        readyWorkerCount: 2,
        staleWorkerCount: 7
      });
      expect(partialReadiness.statusCode).toBe(503);
      expect(partialReadiness.json()).toMatchObject({ ok: false, worker: "stale" });
    } finally {
      if (app) await app.app.close();
      await testDatabase.cleanup();
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
