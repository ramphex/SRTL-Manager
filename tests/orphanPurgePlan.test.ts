import { describe, expect, it } from "vitest";
import type { OrphanLeftoverFolder, OrphanReviewItem } from "../src/shared/types";
import { planPurgeAll, purgeBatches, purgeConfirmationPhrase, purgeNeedsPhrase } from "../src/client/orphanPurgePlan";

function item(id: number, patch: Partial<OrphanReviewItem> = {}): OrphanReviewItem {
  return { storageFileId: id, rootType: "remote", relativePath: `m/${id}.mkv`, filePath: `/r/m/${id}.mkv`, section: "movies", itemName: "m", sizeBytes: 100, mtimeMs: 0, category: "superseded", protectedReason: null, hollow: false, integrity: "ok", zeroSamples: null, ...patch };
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
  });

  it("includes only unprotected folders when opted in", () => {
    const plan = planPurgeAll(review, true);
    expect(plan.folderIds).toEqual([10]);
    expect(plan.totalCount).toBe(3);
    expect(plan.totalBytes).toBe(450);
  });
});

describe("purge confirmation", () => {
  it("requires the phrase for remote deletes and any purge over 1,000 items", () => {
    expect(purgeNeedsPhrase("remote", "delete", 5)).toBe(true);
    expect(purgeNeedsPhrase("remote", "hold", 1000)).toBe(false);
    expect(purgeNeedsPhrase("remote", "hold", 1001)).toBe(true);
    expect(purgeNeedsPhrase("local", "hold", 5)).toBe(false);
    expect(purgeNeedsPhrase("local", "hold", 1001)).toBe(true);
    expect(purgeConfirmationPhrase("remote", 19854)).toBe("purge 19854 remote items");
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
