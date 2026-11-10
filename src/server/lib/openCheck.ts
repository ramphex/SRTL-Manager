import { openFileWithTimeout } from "./filesystemSafety";

/**
 * Some remote mounts keep listing files that are no longer there: a listing names them, and a lookup made just after
 * the listing may even find them, but they cannot be opened. Opening a file without reading it tells the two apart
 * cheaply: on a FUSE remote mount it took about a quarter of a millisecond per file.
 */
export type OpenCheck = (filePath: string) => Promise<void>;

export const openAndClose: OpenCheck = async (filePath) => {
  const handle = await openFileWithTimeout(filePath, `Opening ${filePath}`);
  await handle.close();
};

export function openErrorCode(error: unknown): string | null {
  return error !== null && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : null;
}

/** How the remote scan confirms files. Tests swap the check and shorten the wait. */
export const remoteOpenConfirmation = {
  open: openAndClose as OpenCheck,
  concurrency: 8,
  // A file that is not really there fails with ENOENT when opened on its own, but can fail with another error, such as
  // EIO, when opened right after its folder was listed. Those are tried once more after this wait, all together.
  retryDelayMs: 1500
};

export type OpenConfirmation = "readable" | "missing" | "unknown";

export interface OpenConfirmationResult<T> {
  readable: T[];
  // Not there: opening it said it does not exist.
  missing: Array<{ item: T; message: string }>;
  // Opening it kept failing for another reason, so whether it is there is not known.
  unknown: Array<{ item: T; message: string }>;
}

function describe(error: unknown): string {
  return openErrorCode(error) ?? (error instanceof Error ? error.message : String(error));
}

async function runPool<T>(items: T[], concurrency: number, work: (item: T) => Promise<void>, shouldStop?: () => Promise<boolean>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next]!;
      next += 1;
      if (next % 200 === 0 && (await shouldStop?.())) throw new Error("Job terminated");
      await work(item);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, () => worker()));
}

/**
 * Opens every file once, a few at a time. ENOENT means the file is not there. Any other failure is retried once,
 * for all such files together, after a short wait; a second ENOENT means not there, and a second other failure
 * leaves it unknown, so a passing mount error never hides a real file.
 */
export async function confirmOpenable<T>(items: T[], pathOf: (item: T) => string, shouldStop?: () => Promise<boolean>): Promise<OpenConfirmationResult<T>> {
  const { open, concurrency, retryDelayMs } = remoteOpenConfirmation;
  const readable: T[] = [];
  const missing: OpenConfirmationResult<T>["missing"] = [];
  const unknown: OpenConfirmationResult<T>["unknown"] = [];
  const retry: T[] = [];
  await runPool(
    items,
    concurrency,
    async (item) => {
      try {
        await open(pathOf(item));
        readable.push(item);
      } catch (error) {
        if (openErrorCode(error) === "ENOENT") missing.push({ item, message: "ENOENT" });
        else retry.push(item);
      }
    },
    shouldStop
  );
  if (retry.length > 0) {
    if (retryDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    await runPool(
      retry,
      concurrency,
      async (item) => {
        try {
          await open(pathOf(item));
          readable.push(item);
        } catch (error) {
          if (openErrorCode(error) === "ENOENT") missing.push({ item, message: "ENOENT" });
          else unknown.push({ item, message: describe(error) });
        }
      },
      shouldStop
    );
  }
  return { readable, missing, unknown };
}
