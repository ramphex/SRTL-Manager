import type { OrphanCategory, OrphanLeftoverFolder, OrphanPurgeMode, OrphanReleaseStatus, OrphanReview, OrphanReviewItem, OrphanReviewLabel, StorageRootType } from "../shared/types";

const purgeJobIdLimit = 50_000;
const purgeConfirmationThreshold = 1_000;

export interface PurgeAllPlan {
  fileIds: number[];
  folderIds: number[];
  totalCount: number;
  totalBytes: number;
  byCategory: Array<{ category: OrphanCategory; count: number; sizeBytes: number }>;
  byLabel: Array<{ label: OrphanReviewLabel; count: number; sizeBytes: number }>;
  folderBytes: number;
}

/** Everything the purge-all action may touch: purgeable files, plus leftover folders only when opted in. Protected entries are never included. */
export function planPurgeAll(review: Pick<OrphanReview, "items" | "leftoverFolders">, includeFolders: boolean): PurgeAllPlan {
  const files = review.items.filter((item) => !item.protectedReason);
  const folders: OrphanLeftoverFolder[] = includeFolders ? review.leftoverFolders.filter((folder) => !folder.protectedReason) : [];
  const categories = new Map<OrphanCategory, { count: number; sizeBytes: number }>();
  const labels = new Map<OrphanReviewLabel, { count: number; sizeBytes: number }>();
  for (const item of files) {
    const entry = categories.get(item.category) ?? { count: 0, sizeBytes: 0 };
    entry.count += 1;
    entry.sizeBytes += item.sizeBytes;
    categories.set(item.category, entry);
    const labelEntry = labels.get(item.label) ?? { count: 0, sizeBytes: 0 };
    labelEntry.count += 1;
    labelEntry.sizeBytes += item.sizeBytes;
    labels.set(item.label, labelEntry);
  }
  const folderBytes = folders.reduce((total, folder) => total + folder.totalBytes, 0);
  return {
    fileIds: files.map((item) => item.storageFileId),
    folderIds: folders.map((folder) => folder.folderId),
    totalCount: files.length + folders.length,
    totalBytes: files.reduce((total, item) => total + item.sizeBytes, 0) + folderBytes,
    byCategory: [...categories].map(([category, entry]) => ({ category, ...entry })),
    byLabel: [...labels].map(([label, entry]) => ({ label, ...entry })),
    folderBytes
  };
}

export function purgeConfirmationPhrase(rootType: StorageRootType, count: number): string {
  return `purge ${count} ${rootType} ${count === 1 ? "item" : "items"}`;
}

export function purgeNeedsPhrase(rootType: StorageRootType, mode: OrphanPurgeMode, count: number): boolean {
  return count > purgeConfirmationThreshold || (rootType === "remote" && mode === "delete");
}

/** Split a plan into jobs that respect the server's per-request ID limit; folders ride with the first batch. */
export function purgeBatches(plan: Pick<PurgeAllPlan, "fileIds" | "folderIds">): Array<{ storageFileIds: number[]; folderIds: number[] }> {
  const batches: Array<{ storageFileIds: number[]; folderIds: number[] }> = [];
  for (let offset = 0; offset < plan.fileIds.length; offset += purgeJobIdLimit) {
    batches.push({ storageFileIds: plan.fileIds.slice(offset, offset + purgeJobIdLimit), folderIds: [] });
  }
  if (plan.folderIds.length > 0) {
    if (batches.length === 0) batches.push({ storageFileIds: [], folderIds: [] });
    batches[0]!.folderIds = plan.folderIds.slice(0, purgeJobIdLimit);
  }
  return batches;
}

export type OrphanReleaseFilter = "all" | OrphanReleaseStatus | "extra_linked";
export type OrphanSizeFilter = "all" | "larger" | "not_larger";
export type OrphanSort = "path" | "label" | "release" | "size_desc" | "size_asc" | "linked_difference" | "modified";

export interface OrphanFilters {
  label: OrphanReviewLabel | "all";
  release: OrphanReleaseFilter;
  size: OrphanSizeFilter;
  search: string;
}

export function filterOrphans(items: OrphanReviewItem[], filters: OrphanFilters): OrphanReviewItem[] {
  const needle = filters.search.trim().toLowerCase();
  return items.filter((item) => {
    if (filters.label !== "all" && item.label !== filters.label) return false;
    if (filters.release === "extra_linked" ? !item.extraLinkPath : filters.release !== "all" && item.releaseStatus !== filters.release) return false;
    if (filters.size === "larger" && item.sizeComparison !== "larger") return false;
    if (filters.size === "not_larger" && (item.sizeComparison === null || item.sizeComparison === "larger")) return false;
    return !needle || item.relativePath.toLowerCase().includes(needle);
  });
}

// The server sends path order. Other sorts work on a copy, and ties fall back to the path so a page never reshuffles between renders.
export function sortOrphans(items: OrphanReviewItem[], sort: OrphanSort): OrphanReviewItem[] {
  if (sort === "path") return items;
  const byPath = (left: OrphanReviewItem, right: OrphanReviewItem) => left.relativePath.localeCompare(right.relativePath);
  const difference = (item: OrphanReviewItem) => (item.linkedSizeBytes === null ? -Infinity : item.sizeBytes - item.linkedSizeBytes);
  const compare: Record<Exclude<OrphanSort, "path">, (left: OrphanReviewItem, right: OrphanReviewItem) => number> = {
    label: (left, right) => left.label.localeCompare(right.label),
    // Partly linked first, since those are the releases that need the closest look.
    release: (left, right) => right.releaseLinkedCount - left.releaseLinkedCount || left.releaseName.localeCompare(right.releaseName),
    size_desc: (left, right) => right.sizeBytes - left.sizeBytes,
    size_asc: (left, right) => left.sizeBytes - right.sizeBytes,
    linked_difference: (left, right) => (difference(left) === difference(right) ? 0 : difference(right) > difference(left) ? 1 : -1),
    modified: (left, right) => right.mtimeMs - left.mtimeMs
  };
  return [...items].sort((left, right) => compare[sort](left, right) || byPath(left, right));
}
