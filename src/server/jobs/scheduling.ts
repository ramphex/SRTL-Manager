// Serializes queue admission, worker claims, and path-configuration barriers.
// Keep this value stable so every process coordinates on the same advisory lock.
export const schedulerLockKey = 1_672_148_903;
export const workerProcessLockKey = 1_672_148_904;
