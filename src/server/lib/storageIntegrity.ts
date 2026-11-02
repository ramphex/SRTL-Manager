import { withFilesystemTimeout } from "./filesystemSafety";
import { classifyIntegrity, needsZeroSampling, sampleZeroBlocks, type ZeroSampleResult } from "./mediaIntegrity";

// Each sample read is a network round trip on NFS, so only a few files are read at once.
export const integrityConcurrency = 3;
const integrityFileTimeoutMs = 120_000;

export type ZeroSampler = (filePath: string, sizeBytes: number) => Promise<ZeroSampleResult>;

export interface IntegrityState {
  integrity: string | null;
  integrityZeroSamples: number | null;
  integrityCheckedAt: string | null;
}

interface ObservedFile {
  rootType: string;
  filePath: string;
  sizeBytes: number;
  mtimeMs: number;
  allocatedBytes: number | null;
}

type StoredFile = ObservedFile & IntegrityState;

export function integrityStateOf(row: IntegrityState | undefined): IntegrityState {
  return { integrity: row?.integrity ?? null, integrityZeroSamples: row?.integrityZeroSamples ?? null, integrityCheckedAt: row?.integrityCheckedAt ?? null };
}

export function integrityStateEqual(left: IntegrityState, right: IntegrityState): boolean {
  return left.integrity === right.integrity && left.integrityZeroSamples === right.integrityZeroSamples && left.integrityCheckedAt === right.integrityCheckedAt;
}

// Block counts on the remote FUSE mount mean nothing, so only local files are ever classified or read.
// Returns the new integrity state of every local file whose verdict has to change; other files keep what they have.
export async function assessLocalIntegrity(
  files: ObservedFile[],
  existingByPath: Map<string, StoredFile>,
  options: { sampler?: ZeroSampler; concurrency?: number; isCancelled?: () => Promise<boolean>; now: string }
): Promise<Map<string, IntegrityState>> {
  const sampler = options.sampler ?? sampleZeroBlocks;
  const results = new Map<string, IntegrityState>();
  const toSample: ObservedFile[] = [];

  for (const file of files) {
    if (file.rootType !== "local") continue;
    const existing = existingByPath.get(file.filePath);
    if (!needsZeroSampling(file.sizeBytes, file.allocatedBytes)) {
      const verdict = classifyIntegrity(file.sizeBytes, file.allocatedBytes, null);
      // Rows that were never classified stay null until something is actually wrong with them, which avoids rewriting the whole inventory once.
      if (verdict === "ok" && (!existing?.integrity || existing.integrity === "ok")) continue;
      results.set(file.filePath, { integrity: verdict, integrityZeroSamples: null, integrityCheckedAt: options.now });
      continue;
    }
    const unchanged =
      existing &&
      existing.integrityCheckedAt != null &&
      existing.integrity !== "unknown" &&
      existing.sizeBytes === file.sizeBytes &&
      existing.mtimeMs === file.mtimeMs &&
      existing.allocatedBytes === file.allocatedBytes;
    if (!unchanged) toSample.push(file);
  }

  let next = 0;
  const worker = async () => {
    for (;;) {
      if (options.isCancelled && (await options.isCancelled())) throw new Error("Scan indexing was cancelled");
      const file = toSample[next++];
      if (!file) return;
      try {
        const sampled = await withFilesystemTimeout(sampler(file.filePath, file.sizeBytes), `Zero sampling of ${file.filePath}`, integrityFileTimeoutMs);
        results.set(file.filePath, {
          integrity: classifyIntegrity(file.sizeBytes, file.allocatedBytes, sampled),
          integrityZeroSamples: sampled.zeroSamples,
          integrityCheckedAt: options.now
        });
      } catch {
        // A file that cannot be read says nothing about damage; it is looked at again on the next scan.
        results.set(file.filePath, { integrity: "unknown", integrityZeroSamples: null, integrityCheckedAt: options.now });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(options.concurrency ?? integrityConcurrency, 4)) }, worker));
  return results;
}
