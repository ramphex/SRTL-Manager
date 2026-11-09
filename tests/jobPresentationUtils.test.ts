import { describe, expect, it } from "vitest";
import { copyCompletedItemSummaries, copyFailedItemSummaries, copyWorkTotalFromJob, orphanPurgeCurrentFile, orphanPurgeHoldingAreaView, orphanPurgeProgressFromJob, orphanPurgeProgressPercent, orphanPurgeRateLabel, orphanPurgeRemainingLabel, orphanPurgeScopeText, orphanPurgeStageLabel, orphanPurgeStatusPromptFromJob, selectedLinkTitleSummaries, singleSelectedLinkTitle } from "../src/client/jobPresentationUtils";
import type { JobEventRecord, JobRecord, MediaLinkRow } from "../src/shared/types";

function event(id: number, message: string, data: unknown, level: JobEventRecord["level"] = "error"): JobEventRecord {
  return { id, jobId: 42, timestamp: "2026-07-17T12:00:00.000Z", level, message, data };
}

function mediaLink(id: number, section: string, itemName: string): MediaLinkRow {
  const timestamp = "2026-07-17T12:00:00.000Z";
  return {
    id,
    section,
    itemName,
    relativePath: `${itemName}/item-${id}.mkv`,
    linkPath: `/links/${itemName}/item-${id}.mkv`,
    targetPath: `/remote/${itemName}/item-${id}.mkv`,
    kind: "remote",
    targetExists: true,
    isMedia: true,
    storagePolicy: "location_1",
    resolvedStorageFileId: null,
    sizeBytes: null,
    firstSeenAt: timestamp,
    lastSeenAt: timestamp,
    lastChangedAt: timestamp,
    missingSince: null,
    updatedAt: timestamp
  };
}

describe("selected link title display", () => {
  it("returns a title when every selected link resolves to the same section and title", () => {
    const rows = new Map([
      [1, mediaLink(1, "shows", "Single Series (2026)")],
      [2, mediaLink(2, "shows", "Single Series (2026)")]
    ]);

    expect(singleSelectedLinkTitle([1], rows)).toBe("Single Series (2026)");
    expect(singleSelectedLinkTitle([1, 2], rows)).toBe("Single Series (2026)");
  });

  it("falls back when titles differ, sections differ, or inventory rows are incomplete", () => {
    const rows = new Map([
      [1, mediaLink(1, "movies", "Shared Title (2026)")],
      [2, mediaLink(2, "movies", "Another Title (2026)")],
      [3, mediaLink(3, "movies4k", "Shared Title (2026)")]
    ]);

    expect(singleSelectedLinkTitle([1, 2], rows)).toBeNull();
    expect(singleSelectedLinkTitle([1, 3], rows)).toBeNull();
    expect(singleSelectedLinkTitle([1, 4], rows)).toBeNull();
    expect(singleSelectedLinkTitle([], rows)).toBeNull();
  });

  it("keeps a single title concise when several selected links share it", () => {
    const rows = new Map([
      [1, mediaLink(1, "shows", "Single Series (2026)")],
      [2, mediaLink(2, "shows", "Single Series (2026)")]
    ]);

    expect(selectedLinkTitleSummaries([1, 2], rows)).toEqual(["Single Series (2026)"]);
  });
});

describe("copy work total display", () => {
  function copyJob(progress: Record<string, unknown>): JobRecord {
    const timestamp = "2026-08-01T08:00:00.000Z";
    return {
      id: 386,
      type: "copy",
      status: "completed",
      createdAt: timestamp,
      startedAt: timestamp,
      finishedAt: timestamp,
      progress
    };
  }

  it("removes legacy pre-existing title links from the displayed work total", () => {
    expect(copyWorkTotalFromJob(copyJob({
      options: { direction: "to_local", section: "shows", itemName: "Example Show", linkIds: Array.from({ length: 540 }, (_, index) => index + 1) },
      total: 540,
      copied: 3,
      repointed: 0,
      skipped: 537,
      alreadyCompleted: 537,
      conflicts: 0,
      failed: 0
    }), 540)).toBe(3);
  });

  it("preserves the original total for an explicitly selected resumed job", () => {
    expect(copyWorkTotalFromJob(copyJob({
      options: { direction: "to_local", linkIds: [1, 2, 3] },
      total: 3,
      copied: 3,
      repointed: 0,
      skipped: 0,
      alreadyCompleted: 1,
      conflicts: 0,
      failed: 0
    }), 3)).toBe(3);
  });

  it("uses the immutable selection total instead of unrelated legacy progress totals", () => {
    const job = copyJob({
      options: { direction: "to_local", section: "shows", itemName: "Example Show" },
      total: 540,
      copied: 3,
      repointed: 0,
      skipped: 0,
      alreadyCompleted: 0,
      conflicts: 0,
      failed: 0
    });
    job.selection = {
      total: 3,
      titles: [{ section: "shows", itemName: "Example Show", count: 3 }],
      unavailable: 0
    };

    expect(copyWorkTotalFromJob(job, 540)).toBe(3);
  });

  it("excludes unavailable migrated links from the immutable copy work total", () => {
    const job = copyJob({
      options: { direction: "to_local", section: "shows", itemName: "Example Show", linkIds: Array.from({ length: 540 }, (_, index) => index + 1) },
      total: 540,
      copied: 3,
      repointed: 0,
      skipped: 537,
      alreadyCompleted: 537,
      conflicts: 0,
      failed: 0
    });
    job.selection = {
      total: 540,
      titles: [{ section: "shows", itemName: "Example Show", count: 3 }],
      unavailable: 537
    };

    expect(copyWorkTotalFromJob(job, 540)).toBe(3);
  });
});

describe("copy failure summaries", () => {
  it("collects identifiable item failures, deduplicates retries, and sorts titles", () => {
    const summaries = copyFailedItemSummaries([
      event(1, "ffmpeg fast validation failed: Invalid data found when processing input", {
        itemName: "Zulu Title (2020)",
        linkPath: "/links/Zulu Title (2020)/zulu.mkv",
        sourcePath: "/remote/zulu.mkv"
      }),
      event(2, "Copy job partially failed processing media", { failed: 2 }),
      event(3, "ffmpeg fast validation failed: moov atom not found", {
        itemName: "Alpha Title (1995)",
        linkPath: "/links/Alpha Title (1995)/alpha.mkv",
        sourcePath: "/remote/alpha.mkv"
      }),
      event(4, "ffmpeg fast validation failed: Invalid data found when processing input", {
        itemName: "Alpha Title (1995)",
        linkPath: "/links/Alpha Title (1995)/alpha.mkv",
        sourcePath: "/remote/alpha-retry.mkv"
      }),
      event(5, "Informational event", { itemName: "Ignored Title" }, "info"),
      event(6, "ffmpeg deep validation failed", { itemName: "No Path Title (2026)" })
    ]);

    expect(summaries).toEqual([
      {
        key: "/links/Alpha Title (1995)/alpha.mkv",
        title: "Alpha Title (1995)",
        fileName: "alpha-retry.mkv",
        reason: "Media validation failed: invalid media data"
      },
      {
        key: "No Path Title (2026):",
        title: "No Path Title (2026)",
        fileName: null,
        reason: "Deep media validation failed"
      },
      {
        key: "/links/Zulu Title (2020)/zulu.mkv",
        title: "Zulu Title (2020)",
        fileName: "zulu.mkv",
        reason: "Media validation failed: invalid media data"
      }
    ]);
  });

  it("bounds an unrecognized failure reason", () => {
    const summaries = copyFailedItemSummaries([
      event(1, `Unexpected transfer failure ${"x".repeat(200)}`, {
        itemName: "Example Title",
        sourcePath: "/remote/example.mkv"
      })
    ]);

    expect(summaries[0]?.reason).toHaveLength(160);
    expect(summaries[0]?.reason.endsWith("...")).toBe(true);
  });
});

describe("copy completion summaries", () => {
  it("keeps a warning on the completed item without turning it into a failure", () => {
    const warning = "File is 48 bytes shorter than its header declares; accepted because ffmpeg still read it to the end";
    const events = [
      event(1, "Verified copy installed", { itemName: "Short Tail Title (2026)", linkPath: "/links/short.mkv", sourcePath: "/remote/short.mkv", destinationPath: "/local/short.mkv", warning }, "info"),
      event(2, warning, { itemName: "Short Tail Title (2026)", linkPath: "/links/short.mkv", sourcePath: "/remote/short.mkv", destinationPath: "/local/short.mkv", warning }, "warn")
    ];
    expect(copyCompletedItemSummaries(events)).toEqual([expect.objectContaining({ title: "Short Tail Title (2026)", outcome: "Copied and symlinked", warning })]);
    expect(copyFailedItemSummaries(events)).toEqual([]);
  });

  it("collects copied and matched items, correlates progress titles, deduplicates, and sorts", () => {
    const summaries = copyCompletedItemSummaries([
      event(1, "Promoting verified copy and repointing symlink", {
        currentTitle: "Zulu Title (2020)",
        linkPath: "/links/Zulu Title (2020)/zulu.mkv",
        sourcePath: "/remote/zulu.mkv"
      }, "info"),
      event(2, "Verified copy installed", {
        linkPath: "/links/Zulu Title (2020)/zulu.mkv",
        sourcePath: "/remote/zulu.mkv",
        destinationPath: "/local/Zulu Title (2020)/zulu.mkv"
      }, "info"),
      event(3, "Symlink repointed to existing verified file", {
        itemName: "Alpha Title (1995)",
        linkPath: "/links/Alpha Title (1995)/alpha.mkv",
        destinationPath: "/local/Alpha Title (1995)/alpha.mkv"
      }, "info"),
      event(4, "Verified copy installed", {
        itemName: "Zulu Title (2020)",
        linkPath: "/links/Zulu Title (2020)/zulu.mkv",
        destinationPath: "/local/Zulu Title (2020)/zulu.mkv"
      }, "info"),
      event(5, "Copy skipped", {
        itemName: "Skipped Title",
        linkPath: "/links/Skipped Title/skipped.mkv"
      }, "info"),
      event(6, "ffmpeg fast validation failed", {
        itemName: "Failed Title",
        linkPath: "/links/Failed Title/failed.mkv"
      })
    ]);

    expect(summaries).toEqual([
      {
        key: "/links/Alpha Title (1995)/alpha.mkv",
        title: "Alpha Title (1995)",
        fileName: "alpha.mkv",
        outcome: "Matched existing and symlinked"
      },
      {
        key: "/links/Zulu Title (2020)/zulu.mkv",
        title: "Zulu Title (2020)",
        fileName: "zulu.mkv",
        outcome: "Copied and symlinked"
      }
    ]);
  });
});

describe("orphan purge job presentation", () => {
  const startedAt = "2026-11-09T02:00:00.000Z";
  function purgeJob(status: JobRecord["status"], progress: Record<string, unknown>, finishedAt: string | null = null): JobRecord {
    return { id: 1932, type: "orphan_purge", status, createdAt: startedAt, startedAt, finishedAt, progress };
  }
  const options = { rootType: "remote", mode: "delete", total: 19_981, reRequest: false };

  it("reads the counts, stage, first error and current file from the job's progress", () => {
    const job = purgeJob("running", {
      options,
      current: 4_000,
      total: 19_981,
      held: 0,
      deleted: 3_990,
      alreadyMissing: 7,
      failed: 3,
      remaining: 15_981,
      stage: "purging",
      message: "Checking Alpha.Bravo.S01E02.mkv",
      firstError: { filePath: "/remote/Alpha.Bravo/Alpha.Bravo.S01E01.mkv", message: "EIO: i/o error" }
    });
    const progress = orphanPurgeProgressFromJob(job);
    expect(progress).toMatchObject({ rootType: "remote", mode: "delete", damaged: false, current: 4_000, total: 19_981, deleted: 3_990, alreadyMissing: 7, failed: 3, remaining: 15_981, stage: "purging" });
    expect(progress.firstError).toEqual({ filePath: "/remote/Alpha.Bravo/Alpha.Bravo.S01E01.mkv", message: "EIO: i/o error" });
    expect(orphanPurgeCurrentFile(progress)).toBe("Alpha.Bravo.S01E02.mkv");
    expect(orphanPurgeStageLabel(progress, job.status)).toBe("Deleting files");
    expect(orphanPurgeProgressPercent(job, progress)).toBe(20);
    expect(orphanPurgeScopeText(job)).toBe(`${(19_981).toLocaleString()} remote orphans, deleted`);
    expect(orphanPurgeStatusPromptFromJob(job)).toMatchObject({ key: "orphan-purge-job-1932", title: "Orphan purge", jobId: 1932 });
  });

  it("works out the rate and time left from the start time, and says when it cannot", () => {
    const progress = { options, current: 600, total: 1_800, held: 0, deleted: 600, alreadyMissing: 0, failed: 0, remaining: 1_200, stage: "purging", message: "600 of 1800 processed" };
    const job = purgeJob("running", progress);
    const tenMinutesIn = Date.parse(startedAt) + 10 * 60_000;
    const view = orphanPurgeProgressFromJob(job);
    expect(orphanPurgeCurrentFile(view)).toBeNull();
    expect(orphanPurgeRateLabel(job, view, tenMinutesIn)).toBe("1 / s");
    expect(orphanPurgeRemainingLabel(job, view, tenMinutesIn)).toBe("20m");
    const slow = orphanPurgeProgressFromJob(purgeJob("running", { ...progress, current: 30, remaining: 1_770 }));
    expect(orphanPurgeRateLabel(job, slow, tenMinutesIn)).toBe("3 / min");
    const notStarted = orphanPurgeProgressFromJob(purgeJob("running", { ...progress, current: 0, remaining: 1_800 }));
    expect(orphanPurgeRateLabel(job, notStarted, tenMinutesIn)).toBe("-");
    expect(orphanPurgeRemainingLabel(job, notStarted, tenMinutesIn)).toBe("Estimating");
    expect(orphanPurgeRemainingLabel(purgeJob("queued", progress), view, tenMinutesIn)).toBe("-");
  });

  it("never shows 100% before the job ends, and labels finished, held and damaged-file jobs", () => {
    const almost = purgeJob("running", { options, current: 19_980, total: 19_981, remaining: 1, stage: "purging", message: "" });
    expect(orphanPurgeProgressPercent(almost, orphanPurgeProgressFromJob(almost))).toBe(99);
    const partial = purgeJob("partially_failed", { options, current: 10, total: 10, deleted: 8, failed: 2, remaining: 0, stage: "partially_failed", message: "Orphan purge partially failed: 2 of 10 files were not purged" }, "2026-11-09T02:05:00.000Z");
    const partialView = orphanPurgeProgressFromJob(partial);
    expect(orphanPurgeStageLabel(partialView, partial.status)).toBe("Partially failed");
    expect(orphanPurgeProgressPercent(partial, partialView)).toBe(100);
    expect(orphanPurgeRemainingLabel(partial, partialView)).toBe("Done");
    expect(orphanPurgeRateLabel(partial, partialView)).toBe("2 / min");

    const held = purgeJob("running", { options: { rootType: "local", mode: "hold", total: 1, reRequest: true, source: "damaged" }, current: 0, total: 1, stage: "preparing", message: "Preparing damaged file delete" });
    const heldView = orphanPurgeProgressFromJob(held);
    expect(orphanPurgeStageLabel(heldView, held.status)).toBe("Preparing");
    expect(orphanPurgeStageLabel({ ...heldView, stage: "purging" }, "running")).toBe("Moving files to the holding area");
    expect(orphanPurgeScopeText(held)).toBe("1 local damaged file, held for restore, re-requested");
    expect(orphanPurgeStatusPromptFromJob(held).title).toBe("Damaged file delete");
    expect(orphanPurgeHoldingAreaView(heldView.rootType)).toBe("local-orphans");
    expect(orphanPurgeHoldingAreaView("remote")).toBe("remote-orphans");
  });

  it("copes with a queued job that has no progress yet", () => {
    const queued: JobRecord = { id: 7, type: "orphan_purge", status: "queued", createdAt: startedAt, startedAt: null, finishedAt: null, options: { ...options, total: 3 }, progress: {} };
    const view = orphanPurgeProgressFromJob(queued);
    expect(view).toMatchObject({ total: 3, current: 0, remaining: 3, firstError: null, message: null });
    expect(orphanPurgeStageLabel(view, queued.status)).toBe("Queued");
    expect(orphanPurgeProgressPercent(queued, view)).toBe(0);
    expect(orphanPurgeRateLabel(queued, view)).toBe("-");
  });
});
