import type { OrphanCategory, OrphanLeftoverFolder, OrphanPurgeMode, OrphanReview, StorageRootType } from "../shared/types";

const purgeJobIdLimit = 50_000;
const purgeConfirmationThreshold = 1_000;

export interface PurgeAllPlan {
  fileIds: number[];
  folderIds: number[];
  totalCount: number;
  totalBytes: number;
  byCategory: Array<{ category: OrphanCategory; count: number; sizeBytes: number }>;
  folderBytes: number;
}

/** Everything the purge-all action may touch: purgeable files, plus leftover folders only when opted in. Protected entries are never included. */
export function planPurgeAll(review: Pick<OrphanReview, "items" | "leftoverFolders">, includeFolders: boolean): PurgeAllPlan {
  const files = review.items.filter((item) => !item.protectedReason);
  const folders: OrphanLeftoverFolder[] = includeFolders ? review.leftoverFolders.filter((folder) => !folder.protectedReason) : [];
  const categories = new Map<OrphanCategory, { count: number; sizeBytes: number }>();
  for (const item of files) {
    const entry = categories.get(item.category) ?? { count: 0, sizeBytes: 0 };
    entry.count += 1;
    entry.sizeBytes += item.sizeBytes;
    categories.set(item.category, entry);
  }
  const folderBytes = folders.reduce((total, folder) => total + folder.totalBytes, 0);
  return {
    fileIds: files.map((item) => item.storageFileId),
    folderIds: folders.map((folder) => folder.folderId),
    totalCount: files.length + folders.length,
    totalBytes: files.reduce((total, item) => total + item.sizeBytes, 0) + folderBytes,
    byCategory: [...categories].map(([category, entry]) => ({ category, ...entry })),
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
