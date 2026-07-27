import { describe, expect, it } from "vitest";
import { copyCompletedItemSummaries, copyFailedItemSummaries, singleSelectedLinkTitle } from "../src/client/jobPresentationUtils";
import type { JobEventRecord, MediaLinkRow } from "../src/shared/types";

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
