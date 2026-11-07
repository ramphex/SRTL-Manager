import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertReadableRegularFile, openFileWithTimeout } from "../src/server/lib/filesystemSafety";

const realOpen = fs.open;

// Holds each open back until the test lets it finish, the way a stalled mount does.
function delayOpens() {
  let release = () => {};
  const released = new Promise<void>((resolve) => { release = resolve; });
  const handles: Awaited<ReturnType<typeof fs.open>>[] = [];
  const settled: Promise<unknown>[] = [];
  vi.spyOn(fs, "open").mockImplementation((...args: Parameters<typeof fs.open>) => {
    const opening = released.then(async () => {
      const handle = await realOpen(...args);
      handles.push(handle);
      return handle;
    });
    settled.push(opening.catch(() => undefined));
    return opening;
  });
  return { release, handles, settled };
}

async function tempFile(): Promise<{ filePath: string; remove: () => Promise<void> }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "srtl-filesystem-safety-"));
  const filePath = path.join(dir, "sample.bin");
  await fs.writeFile(filePath, "sample");
  return { filePath, remove: () => fs.rm(dir, { recursive: true, force: true }) };
}

// A handle's fd becomes -1 once it has closed.
async function expectClosed(handle: Awaited<ReturnType<typeof fs.open>>): Promise<void> {
  await vi.waitFor(() => expect(handle.fd).toBe(-1));
}

describe("openFileWithTimeout", () => {
  afterEach(() => vi.restoreAllMocks());

  it("returns a working handle when the open finishes in time", async () => {
    const { filePath, remove } = await tempFile();
    try {
      const handle = await openFileWithTimeout(filePath, "Sample open", 5_000);
      try {
        expect((await handle.stat()).size).toBe(6);
      } finally {
        await handle.close();
      }
    } finally {
      await remove();
    }
  });

  it("closes a handle that opens after the deadline", async () => {
    const { filePath, remove } = await tempFile();
    try {
      const { release, handles, settled } = delayOpens();
      await expect(openFileWithTimeout(filePath, "Sample open", 10)).rejects.toThrow("Sample open timed out");
      release();
      await Promise.all(settled);
      expect(handles).toHaveLength(1);
      await expectClosed(handles[0]!);
    } finally {
      await remove();
    }
  });

  it("stays quiet when an open that timed out later fails", async () => {
    const { filePath, remove } = await tempFile();
    try {
      const { release, handles, settled } = delayOpens();
      await expect(openFileWithTimeout(`${filePath}.missing`, "Sample open", 10)).rejects.toThrow("Sample open timed out");
      release();
      await Promise.all(settled);
      expect(handles).toHaveLength(0);
    } finally {
      await remove();
    }
  });
});

describe("assertReadableRegularFile", () => {
  afterEach(() => vi.restoreAllMocks());

  it("closes a handle that opens after its read check timed out", async () => {
    const { filePath, remove } = await tempFile();
    try {
      const { release, handles, settled } = delayOpens();
      await expect(assertReadableRegularFile(filePath, "Sample", { timeoutMs: 10 })).rejects.toThrow("Sample read check timed out");
      release();
      await Promise.all(settled);
      expect(handles).toHaveLength(1);
      await expectClosed(handles[0]!);
    } finally {
      await remove();
    }
  });
});
