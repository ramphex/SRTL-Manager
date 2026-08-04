import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { first, openDatabase } from "../src/server/db/database";
import * as schema from "../src/server/db/schema";
import { pruneExpiredSessions, pruneTerminalJobHistory } from "../src/server/lib/historyRetention";
import { createTestDatabase } from "./testDb";

describe("job history retention", () => {
  it("removes expired sessions without deleting current sessions", async () => {
    const testDatabase = await createTestDatabase();
    const database = await openDatabase(testDatabase.databaseUrl);
    try {
      const user = await first(
        database.db
          .insert(schema.adminUsers)
          .values({ username: "retention-admin", passwordHash: "unused", createdAt: "2026-01-01T00:00:00.000Z" })
          .returning({ id: schema.adminUsers.id })
      );
      if (!user) throw new Error("Session retention user was not created");
      await database.db.insert(schema.sessions).values([
        { tokenHash: "expired", userId: user.id, expiresAt: "2026-07-31T00:00:00.000Z", createdAt: "2026-07-01T00:00:00.000Z" },
        { tokenHash: "current", userId: user.id, expiresAt: "2026-08-02T00:00:00.000Z", createdAt: "2026-07-31T00:00:00.000Z" }
      ]);

      await expect(pruneExpiredSessions(database.db, "2026-08-01T00:00:00.000Z")).resolves.toBe(1);
      await expect(database.db.select({ tokenHash: schema.sessions.tokenHash }).from(schema.sessions)).resolves.toEqual([{ tokenHash: "current" }]);
    } finally {
      await database.close();
      await testDatabase.cleanup();
    }
  });

  it("removes old terminal history while preserving current, migration, and unresolved recovery jobs", async () => {
    const testDatabase = await createTestDatabase();
    const database = await openDatabase(testDatabase.databaseUrl);
    const nowMs = Date.parse("2026-08-01T12:00:00.000Z");
    const oldTimestamp = "2026-04-01T12:00:00.000Z";
    const recentTimestamp = "2026-07-31T12:00:00.000Z";
    try {
      const [oldAudit, recentJob, pathMigrationJob, recoveryJob, supersededRecoveryJob, laterCommittedJob] = await database.db
        .insert(schema.jobs)
        .values([
          { type: "audit", status: "completed", createdAt: oldTimestamp, finishedAt: oldTimestamp, progress: "{}" },
          { type: "scan", status: "completed", createdAt: recentTimestamp, finishedAt: recentTimestamp, progress: "{}" },
          { type: "path_migration", status: "failed", createdAt: oldTimestamp, finishedAt: oldTimestamp, progress: "{}" },
          { type: "copy", status: "failed", createdAt: oldTimestamp, finishedAt: oldTimestamp, progress: "{}" },
          { type: "copy", status: "failed", createdAt: oldTimestamp, finishedAt: oldTimestamp, progress: "{}" },
          { type: "copy", status: "completed", createdAt: recentTimestamp, finishedAt: recentTimestamp, progress: "{}" }
        ])
        .returning({ id: schema.jobs.id });
      if (!oldAudit || !recentJob || !pathMigrationJob || !recoveryJob || !supersededRecoveryJob || !laterCommittedJob) {
        throw new Error("Retention fixtures were not created");
      }

      await database.db.insert(schema.jobEvents).values({
        jobId: oldAudit.id,
        timestamp: oldTimestamp,
        level: "info",
        message: "old event",
        data: "{}"
      });
      const auditRun = await first(
        database.db
          .insert(schema.auditRuns)
          .values({
            jobId: oldAudit.id,
            mode: "fast",
            status: "completed",
            startedAt: oldTimestamp,
            finishedAt: oldTimestamp,
            checked: 1,
            passed: 1,
            failed: 0,
            sourceUnknown: 0,
            sourceMissing: 0,
            sourceCompareErrors: 0,
            byteMismatches: 0,
            targetValidationFailures: 0,
            errorMessage: null
          })
          .returning({ id: schema.auditRuns.id })
      );
      if (!auditRun) throw new Error("Audit retention fixture was not created");
      await database.db.insert(schema.auditResults).values({
        auditRunId: auditRun.id,
        linkPath: "/links/old.mkv",
        targetPath: "/remote/old.mkv",
        sourcePath: null,
        status: "pass",
        ffmpegStatus: "pass",
        cmpStatus: "skipped",
        message: "ok",
        createdAt: oldTimestamp
      });

      const mediaLink = await first(
        database.db
          .insert(schema.mediaLinks)
          .values({
            section: "movies",
            itemName: "Recovery",
            relativePath: "Recovery/file.mkv",
            linkPath: "/links/Recovery/file.mkv",
            targetPath: "/remote/Recovery/file.mkv",
            kind: "remote",
            targetExists: true,
            isMedia: true,
            storagePolicy: "location_1",
            updatedAt: oldTimestamp
          })
          .returning({ id: schema.mediaLinks.id })
      );
      if (!mediaLink) throw new Error("Media-link retention fixture was not created");
      await database.db.insert(schema.copyOperations).values({
        jobId: recoveryJob.id,
        mediaLinkId: mediaLink.id,
        linkPath: "/links/Recovery/file.mkv",
        sourcePath: "/remote/Recovery/file.mkv",
        destinationPath: "/local/Recovery/file.mkv",
        originalTargetPath: "/remote/Recovery/file.mkv",
        originalLinkState: "{}",
        stage: "reconciliation_required",
        createdAt: oldTimestamp,
        updatedAt: oldTimestamp
      });

      const supersededLink = await first(
        database.db
          .insert(schema.mediaLinks)
          .values({
            section: "movies",
            itemName: "Superseded recovery",
            relativePath: "Superseded/file.mkv",
            linkPath: "/links/Superseded/file.mkv",
            targetPath: "/local/Superseded/file.mkv",
            kind: "local",
            targetExists: true,
            isMedia: true,
            storagePolicy: "location_1",
            updatedAt: recentTimestamp
          })
          .returning({ id: schema.mediaLinks.id })
      );
      if (!supersededLink) throw new Error("Superseded media-link fixture was not created");
      await database.db.insert(schema.copyOperations).values([
        {
          jobId: supersededRecoveryJob.id,
          mediaLinkId: supersededLink.id,
          linkPath: "/links/Superseded/file.mkv",
          sourcePath: "/remote/Superseded/file.mkv",
          destinationPath: "/local/Superseded/file.mkv",
          originalTargetPath: "/remote/Superseded/file.mkv",
          originalLinkState: "{}",
          stage: "reconciliation_required",
          createdAt: oldTimestamp,
          updatedAt: oldTimestamp
        },
        {
          jobId: laterCommittedJob.id,
          mediaLinkId: supersededLink.id,
          linkPath: "/links/Superseded/file.mkv",
          sourcePath: "/remote/Superseded/file.mkv",
          destinationPath: "/local/Superseded/file.mkv",
          originalTargetPath: "/remote/Superseded/file.mkv",
          originalLinkState: "{}",
          stage: "committed",
          resultStatus: "copied",
          createdAt: recentTimestamp,
          updatedAt: recentTimestamp,
          completedAt: recentTimestamp
        }
      ]);

      await expect(pruneTerminalJobHistory(database.db, 90, nowMs)).resolves.toBe(2);
      const remainingJobs = await database.db.select({ id: schema.jobs.id }).from(schema.jobs);
      expect(remainingJobs.map((job) => job.id).sort((left, right) => left - right)).toEqual(
        [recentJob.id, pathMigrationJob.id, recoveryJob.id, laterCommittedJob.id].sort((left, right) => left - right)
      );
      await expect(database.db.select().from(schema.jobEvents).where(eq(schema.jobEvents.jobId, oldAudit.id))).resolves.toHaveLength(0);
      await expect(database.db.select().from(schema.auditRuns).where(eq(schema.auditRuns.id, auditRun.id))).resolves.toHaveLength(0);
      await expect(database.db.select().from(schema.auditResults).where(eq(schema.auditResults.auditRunId, auditRun.id))).resolves.toHaveLength(0);
      await expect(pruneTerminalJobHistory(database.db, 0, nowMs)).resolves.toBe(0);
    } finally {
      await database.close();
      await testDatabase.cleanup();
    }
  });
});
