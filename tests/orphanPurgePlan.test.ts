import { describe, expect, it } from "vitest";
import type { OrphanLeftoverFolder, OrphanReviewItem } from "../src/shared/types";
import { filterOrphans, planPurgeAll, purgeBatches, sortOrphans } from "../src/client/orphanPurgePlan";

function item(id: number, patch: Partial<OrphanReviewItem> = {}): OrphanReviewItem {
  return { storageFileId: id, rootType: "remote", relativePath: `m/${id}.mkv`, filePath: `/r/m/${id}.mkv`, section: "movies", itemName: "m", sizeBytes: 100, mtimeMs: 0, category: "superseded", protectedReason: null, hollow: false, integrity: "ok", zeroSamples: null, label: patch.category === "unlinked" ? "no_title_match" : (patch.category ?? "superseded"), matchedTitle: null, releaseName: "m", releaseStatus: "none_linked", releaseFileCount: 1, releaseLinkedCount: 0, linkedSizeBytes: null, sizeComparison: null, episodeCoverage: null, extraLinkPath: null, ...patch };
}
function folder(id: number, patch: Partial<OrphanLeftoverFolder> = {}): OrphanLeftoverFolder {
  return { folderId: id, rootType: "remote", relativePath: `f${id}`, dirPath: `/r/f${id}`, fileCount: 2, totalBytes: 50, newestMtimeMs: 0, protectedReason: null, ...patch };
}

describe("planPurgeAll", () => {
  const review = { items: [item(1), item(2, { category: "unlinked", sizeBytes: 300 }), item(3, { protectedReason: "modified recently" })], leftoverFolders: [folder(10), folder(11, { protectedReason: "copy in progress" })] };

  it("excludes protected files and leaves folders out unless opted in", () => {
    const plan = planPurgeAll(review, false);
    expect(plan.fileIds).toEqual([1, 2]);
    expect(plan.folderIds).toEqual([]);
    expect(plan.totalCount).toBe(2);
    expect(plan.totalBytes).toBe(400);
    expect(plan.byCategory).toEqual([{ category: "superseded", count: 1, sizeBytes: 100 }, { category: "unlinked", count: 1, sizeBytes: 300 }]);
    expect(plan.byLabel).toEqual([{ label: "superseded", count: 1, sizeBytes: 100 }, { label: "no_title_match", count: 1, sizeBytes: 300 }]);
  });

  it("includes only unprotected folders when opted in", () => {
    const plan = planPurgeAll(review, true);
    expect(plan.folderIds).toEqual([10]);
    expect(plan.totalCount).toBe(3);
    expect(plan.totalBytes).toBe(450);
  });
});

describe("purgeBatches", () => {
  it("splits at the 50,000 id limit and attaches folders to the first job", () => {
    const fileIds = Array.from({ length: 120_000 }, (_, index) => index + 1);
    const batches = purgeBatches({ fileIds, folderIds: [7] });
    expect(batches.map((batch) => batch.storageFileIds.length)).toEqual([50_000, 50_000, 20_000]);
    expect(batches[0]?.folderIds).toEqual([7]);
    expect(batches[1]?.folderIds).toEqual([]);
  });

  it("makes a folders-only job when there are no files", () => {
    expect(purgeBatches({ fileIds: [], folderIds: [3] })).toEqual([{ storageFileIds: [], folderIds: [3] }]);
  });
});

describe("orphan filters and sorting", () => {
  const items = [
    item(1, { relativePath: "b.mkv", label: "no_title_match", category: "unlinked", releaseStatus: "partly_linked", releaseLinkedCount: 2, releaseName: "B", sizeBytes: 500, mtimeMs: 1 }),
    item(2, { relativePath: "a.mkv", label: "title_in_library", category: "unlinked", matchedTitle: "Alpha (2020)", releaseName: "A", sizeBytes: 100, mtimeMs: 3 }),
    item(3, { relativePath: "d.mkv", sizeBytes: 900, linkedSizeBytes: 400, sizeComparison: "larger", releaseName: "D", mtimeMs: 2 }),
    item(4, { relativePath: "c.mkv", sizeBytes: 100, linkedSizeBytes: 400, sizeComparison: "smaller", releaseName: "C", extraLinkPath: "/other/c.mkv", protectedReason: "Still linked from /other/c.mkv" })
  ];
  const everything = { label: "all", release: "all", size: "all", search: "" } as const;
  const ids = (list: OrphanReviewItem[]) => list.map((entry) => entry.storageFileId);

  it("filters by label, release state, size against the linked file, and search", () => {
    expect(ids(filterOrphans(items, { ...everything, label: "title_in_library" }))).toEqual([2]);
    expect(ids(filterOrphans(items, { ...everything, label: "no_title_match" }))).toEqual([1]);
    expect(ids(filterOrphans(items, { ...everything, release: "partly_linked" }))).toEqual([1]);
    expect(ids(filterOrphans(items, { ...everything, release: "none_linked" }))).toEqual([2, 3, 4]);
    expect(ids(filterOrphans(items, { ...everything, release: "extra_linked" }))).toEqual([4]);
    expect(ids(filterOrphans(items, { ...everything, size: "larger" }))).toEqual([3]);
    // Files with nothing to compare against are neither larger nor not larger.
    expect(ids(filterOrphans(items, { ...everything, size: "not_larger" }))).toEqual([4]);
    expect(ids(filterOrphans(items, { ...everything, search: "D.MKV" }))).toEqual([3]);
  });

  it("sorts without changing the list it was given", () => {
    expect(ids(sortOrphans(items, "path"))).toEqual([1, 2, 3, 4]);
    expect(ids(sortOrphans(items, "size_desc"))).toEqual([3, 1, 2, 4]);
    expect(ids(sortOrphans(items, "size_asc"))).toEqual([2, 4, 1, 3]);
    expect(ids(sortOrphans(items, "modified"))).toEqual([2, 3, 1, 4]);
    expect(ids(sortOrphans(items, "release"))[0]).toBe(1);
    expect(ids(sortOrphans(items, "label"))).toEqual([1, 4, 3, 2]);
    // Larger files first, and files with nothing to compare against last.
    expect(ids(sortOrphans(items, "linked_difference"))).toEqual([3, 4, 2, 1]);
    expect(ids(items)).toEqual([1, 2, 3, 4]);
  });
});
