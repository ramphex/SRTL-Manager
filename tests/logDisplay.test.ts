import { describe, expect, it } from "vitest";
import { eventDataChips, formatJobType, jobProgressChips, matchesEventFilters, matchesJobFilters } from "../src/client/logDisplay";
import type { JobEventRecord, JobRecord } from "../src/shared/types";

function job(overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    id: 42,
    type: "scan",
    status: "completed",
    createdAt: "2026-07-01T12:00:00.000Z",
    startedAt: "2026-07-01T12:00:01.000Z",
    finishedAt: "2026-07-01T12:01:01.000Z",
    progress: {
      options: {
        scanSymlinks: true,
        scanLocal: false,
        scanRemote: true,
        symlinkSections: ["shows", "movies"],
        localSections: []
      },
      totalLinks: 120,
      remoteFiles: 44
    },
    ...overrides
  };
}

function event(overrides: Partial<JobEventRecord> = {}): JobEventRecord {
  return {
    id: 9,
    jobId: 42,
    timestamp: "2026-07-01T12:00:10.000Z",
    level: "warn",
    message: "Remote storage directory remained unreadable after retry",
    data: {
      targetPath: "/mnt/remote/example",
      attempts: 2,
      sections: ["shows", "movies", "anime", "documentaries"]
    },
    ...overrides
  };
}

describe("log display helpers", () => {
  it("uses friendlier names for job types", () => {
    expect(formatJobType("scan")).toBe("Inventory scan");
    expect(formatJobType("audit")).toBe("Audit");
    expect(formatJobType("path_migration")).toBe("Path migration");
  });

  it("matches jobs by friendly text and structured progress", () => {
    expect(matchesJobFilters(job(), { search: "inventory", status: "all", type: "all" })).toBe(true);
    expect(matchesJobFilters(job(), { search: "remote", status: "completed", type: "scan" })).toBe(true);
    expect(matchesJobFilters(job(), { search: "remote", status: "failed", type: "scan" })).toBe(false);
    expect(matchesJobFilters(job({ status: "partially_failed" }), { search: "remote", status: "partially_failed", type: "scan" })).toBe(true);
  });

  it("summarizes scan progress without dumping raw JSON", () => {
    expect(jobProgressChips(job(), 4)).toEqual([
      { label: "Scan scope", value: "Symlinks, Remote files" },
      { label: "Symlink folders", value: "2" },
      { label: "Total links", value: "120" },
      { label: "Remote files", value: "44" }
    ]);
  });

  it("identifies title rescans by title instead of presenting them as full-folder scans", () => {
    expect(
      jobProgressChips(
        job({
          progress: {
            options: {
              scanSymlinks: true,
              scanLocal: false,
              scanRemote: false,
              symlinkSections: ["shows"],
              titleScopes: [{ section: "shows", itemName: "Example Title" }]
            },
            totalLinks: 10
          }
        }),
        4
      )
    ).toEqual([
      { label: "Scan scope", value: "Symlinks" },
      { label: "Title", value: "Example Title" },
      { label: "Total links", value: "10" }
    ]);
  });

  it("keeps scan event chips limited to selected scan scopes", () => {
    expect(
      eventDataChips(
        {
          options: {
            scanSymlinks: true,
            scanLocal: false,
            scanRemote: false,
            symlinkSections: ["shows", "movies"],
            localSections: []
          },
          totalLinks: 120,
          remoteLinks: 20,
          localLinks: 100,
          localFiles: 300,
          remoteFiles: 400,
          localOrphanFiles: 12,
          remoteOrphanFiles: 14
        },
        8
      )
    ).toEqual([
      { label: "Scan scope", value: "Symlinks" },
      { label: "Symlink folders", value: "2" },
      { label: "Total links", value: "120" },
      { label: "Remote links", value: "20" },
      { label: "Local links", value: "100" }
    ]);
  });

  it("uses fallback scan options to scope older scan event payloads", () => {
    expect(
      eventDataChips(
        {
          totalLinks: 120,
          remoteLinks: 20,
          localFiles: 300,
          remoteFiles: 400,
          localOrphanFiles: 12,
          remoteOrphanFiles: 14
        },
        8,
        {
          scanSymlinks: true,
          scanLocal: false,
          scanRemote: false,
          symlinkSections: ["shows"],
          localSections: []
        }
      )
    ).toEqual([
      { label: "Scan scope", value: "Symlinks" },
      { label: "Symlink folders", value: "1" },
      { label: "Total links", value: "120" },
      { label: "Remote links", value: "20" }
    ]);
  });

  it("labels previously indexed paths that were not found in the scanned scope", () => {
    expect(
      eventDataChips(
        {
          options: {
            scanSymlinks: false,
            scanLocal: true,
            scanRemote: false,
            localSections: ["shows"]
          },
          localFiles: 300,
          missingLocalFiles: 4,
          remoteFiles: 400,
          missingRemoteFiles: 5
        },
        6
      )
    ).toEqual([
      { label: "Scan scope", value: "Local files" },
      { label: "Local folders", value: "1" },
      { label: "Local files", value: "300" },
      { label: "No longer found local files", value: "4" }
    ]);
  });

  it("summarizes scoped audit jobs", () => {
    expect(
      jobProgressChips(
        job({
          type: "audit",
          progress: {
            options: {
              mode: "fast",
              section: "shows",
              itemName: "Example Show",
              relativePathPrefix: "Example Show/Season 01"
            },
            checked: 3,
            failed: 1
          }
        }),
        6
      )
    ).toEqual([
      { label: "Mode", value: "Fast" },
      { label: "Folder", value: "shows" },
      { label: "Title", value: "Example Show" },
      { label: "Path scope", value: "Example Show/Season 01" },
      { label: "Checked", value: "3" },
      { label: "Failed", value: "1" }
    ]);
  });

  it("does not show policy filtering chips for audit jobs", () => {
    expect(
      jobProgressChips(
        job({
          type: "audit",
          progress: {
            options: {
              mode: "deep",
              sections: ["shows"]
            },
            checked: 12
          }
        }),
        4
      )
    ).toEqual([
      { label: "Mode", value: "Deep" },
      { label: "Local folders", value: "1" },
      { label: "Checked", value: "12" }
    ]);
  });

  it("matches and summarizes event details", () => {
    expect(matchesEventFilters(event(), { search: "unreadable", level: "all" })).toBe(true);
    expect(matchesEventFilters(event(), { search: "/mnt/remote", level: "warn" })).toBe(true);
    expect(matchesEventFilters(event(), { search: "unreadable", level: "error" })).toBe(false);
    expect(eventDataChips(event().data, 3)).toEqual([
      { label: "Folders", value: "shows, movies, anime +1" },
      { label: "Target", value: "/mnt/remote/example" },
      { label: "Attempts", value: "2" }
    ]);
  });
});
