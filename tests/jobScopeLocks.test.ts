import { describe, expect, it } from "vitest";
import { activeJobForLink, activeJobNotice, activeJobsForLinks, activeJobsForStoragePolicyTitle } from "../src/client/jobScopeLocks";
import type { JobRecord, JobStatus, JobType, MediaLinkRow, StoragePolicyKind, StoragePolicyTitle } from "../src/shared/types";

function mediaLink(overrides: Partial<MediaLinkRow> = {}): MediaLinkRow {
  return {
    id: 1,
    section: "shows",
    itemName: "Example Title",
    relativePath: "Example Title/Season 01/episode-1.mkv",
    linkPath: "/symlinks/shows/Example Title/Season 01/episode-1.mkv",
    targetPath: "/remote/shows/Example Title/Season 01/episode-1.mkv",
    kind: "remote",
    targetExists: true,
    isMedia: true,
    storagePolicy: "location_1",
    resolvedStorageFileId: null,
    sizeBytes: null,
    firstSeenAt: "2026-01-01T00:00:00.000Z",
    lastSeenAt: "2026-01-01T00:00:00.000Z",
    lastChangedAt: "2026-01-01T00:00:00.000Z",
    missingSince: null,
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides
  };
}

function job(type: JobType, status: JobStatus, progress: unknown, id = 10): JobRecord {
  return {
    id,
    type,
    status,
    createdAt: "2026-01-01T00:00:00.000Z",
    startedAt: null,
    finishedAt: null,
    progress
  };
}

function storagePolicyTitle(overrides: Partial<StoragePolicyTitle> = {}): StoragePolicyTitle {
  return {
    id: 1,
    title: "Example Title",
    normalizedTitle: "example title",
    policy: "location_1",
    category: "movies",
    sections: ["movies"],
    linkCount: 1,
    remoteLinkCount: 1,
    localLinkCount: 0,
    fileCount: 0,
    remoteFileCount: 0,
    localFileCount: 0,
    sectionCount: 1,
    source: "manual",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides
  };
}

describe("job scope locks", () => {
  it("locks matching queued copy link IDs but ignores inactive jobs", () => {
    const link = mediaLink({ id: 7 });
    const queued = job("copy", "queued", { options: { direction: "to_local", linkIds: [7] } });
    const completed = job("copy", "completed", { options: { direction: "to_local", linkIds: [7] } }, 11);

    expect(activeJobForLink(link, [queued])?.id).toBe(10);
    expect(activeJobForLink(mediaLink({ id: 8 }), [queued])).toBeNull();
    expect(activeJobForLink(link, [completed])).toBeNull();
  });

  it("advises link and title locks for active failed-symlink cleanup jobs", () => {
    const cleanup = {
      ...job("symlink_cleanup", "queued", { sourceJobId: 4 }),
      selection: {
        total: 1,
        unavailable: 0,
        linkIds: [7],
        titles: [{ section: "movies", itemName: "Example Title", count: 1 }]
      }
    };

    expect(activeJobForLink(mediaLink({ id: 7 }), [cleanup])?.id).toBe(10);
    expect(activeJobForLink(mediaLink({ id: 8 }), [cleanup])).toBeNull();
    expect(activeJobsForStoragePolicyTitle(storagePolicyTitle(), [cleanup]).map((activeJob) => activeJob.id)).toEqual([10]);
  });

  it("locks copy jobs scoped by title and path prefix", () => {
    const link = mediaLink({
      id: 20,
      kind: "local",
      storagePolicy: "location_2",
      section: "shows",
      itemName: "Example Title",
      relativePath: "Example Title/Season 01/episode-1.mkv"
    });
    const scoped = job("copy", "running", {
      options: {
        direction: "to_remote",
        section: "shows",
        itemName: "Example Title",
        relativePathPrefix: "Example Title/Season 01"
      }
    });

    expect(activeJobForLink(link, [scoped])?.id).toBe(10);
    expect(activeJobForLink({ ...link, relativePath: "Example Title/Season 02/episode-1.mkv" }, [scoped])).toBeNull();
    expect(activeJobForLink({ ...link, storagePolicy: "location_1" as StoragePolicyKind }, [scoped])).toBeNull();
  });

  it("locks only the matching title for a targeted symlink rescan", () => {
    const titleScan = job("scan", "queued", {
      options: {
        scanSymlinks: true,
        scanLocal: false,
        scanRemote: false,
        symlinkSections: ["shows"],
        titleScopes: [{ section: "shows", itemName: "Example Title" }]
      }
    });

    expect(activeJobForLink(mediaLink(), [titleScan])?.id).toBe(10);
    expect(activeJobForLink(mediaLink({ itemName: "Other Title", relativePath: "Other Title/Season 01/episode-1.mkv" }), [titleScan])).toBeNull();
    expect(activeJobForLink(mediaLink({ section: "movies" }), [titleScan])).toBeNull();
    expect(activeJobsForStoragePolicyTitle(storagePolicyTitle({ sections: ["shows"] }), [titleScan]).map((activeJob) => activeJob.id)).toEqual([10]);
    expect(activeJobsForStoragePolicyTitle(storagePolicyTitle({ title: "Other Title", normalizedTitle: "other title" }), [titleScan])).toEqual([]);
  });

  it("locks titles covered by a section symlink scan", () => {
    const sectionScan = job("scan", "running", {
      options: { scanSymlinks: true, scanLocal: false, scanRemote: false, symlinkSections: ["shows"] }
    });

    expect(activeJobForLink(mediaLink({ section: "shows" }), [sectionScan])?.id).toBe(10);
    expect(activeJobForLink(mediaLink({ section: "movies" }), [sectionScan])).toBeNull();
    expect(activeJobsForStoragePolicyTitle(storagePolicyTitle({ sections: ["shows"] }), [sectionScan]).map((activeJob) => activeJob.id)).toEqual([10]);
  });

  it("locks links covered by broad audit scope", () => {
    const localShow = mediaLink({ id: 1, kind: "local", storagePolicy: "location_1", section: "shows" });
    const localMovie = mediaLink({ id: 2, kind: "local", storagePolicy: "location_1", section: "movies" });
    const remoteMovie = mediaLink({ id: 3, kind: "remote", storagePolicy: "location_1", section: "movies" });
    const audit = job("audit", "queued", { options: { mode: "fast", targets: ["local"], sections: ["shows"] } });

    expect(activeJobForLink(localShow, [audit])?.id).toBe(10);
    expect(activeJobForLink(localMovie, [audit])).toBeNull();
    expect(activeJobForLink(remoteMovie, [audit])).toBeNull();
  });

  it("deduplicates active jobs for grouped links and reports the lock notice", () => {
    const firstJob = job("copy", "queued", { options: { direction: "to_local", linkIds: [1, 2] } }, 21);
    const secondJob = job("audit", "running", { options: { mode: "fast", linkIds: [3] } }, 22);
    const links = [mediaLink({ id: 1 }), mediaLink({ id: 2 }), mediaLink({ id: 3 })];
    const jobMap = new Map([
      [1, firstJob],
      [2, firstJob],
      [3, secondJob]
    ]);

    expect(activeJobsForLinks(links, jobMap).map((activeJob) => activeJob.id)).toEqual([21, 22]);
    expect(activeJobNotice(activeJobsForLinks(links, jobMap))).toContain("2 jobs are already queued/running");
  });

  it("locks storage policy title actions covered by active copy or audit jobs", () => {
    const item = storagePolicyTitle();
    const copy = job("copy", "queued", { options: { direction: "to_local", itemName: "Example Title" } }, 30);
    const audit = job("audit", "running", { options: { mode: "fast", targets: ["remote"], itemName: "Example Title" } }, 31);
    const completed = job("copy", "completed", { options: { direction: "to_local", itemName: "Example Title" } }, 32);

    expect(activeJobsForStoragePolicyTitle(item, [copy, audit, completed]).map((activeJob) => activeJob.id)).toEqual([30, 31]);
    expect(activeJobsForStoragePolicyTitle(storagePolicyTitle({ title: "Other Title", normalizedTitle: "other title" }), [copy, audit])).toEqual([]);
  });

  it("does not title-lock link-id-only jobs without title context", () => {
    const item = storagePolicyTitle();
    const copy = job("copy", "queued", { options: { direction: "to_local", linkIds: [7] } });

    expect(activeJobsForStoragePolicyTitle(item, [copy])).toEqual([]);
  });
});
