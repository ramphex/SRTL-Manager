import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CopyReconciliationRequiredError, copyMediaLink, defaultCopyRunner, type CopyFileProgress, type CopyOperationUpdate } from "../src/server/lib/copier";
import type { MediaLinkRow } from "../src/shared/types";

// These tests exercise filesystem safety with placeholder bytes, so the media content preflight is left out.
const fileRunner = { copyFile: defaultCopyRunner.copyFile, runCmp: defaultCopyRunner.runCmp, runFfmpeg: defaultCopyRunner.runFfmpeg };

function remoteCopyLink(itemName: string, relativePath: string, linkPath: string, sourcePath: string, sizeBytes: number): MediaLinkRow {
  const timestamp = new Date().toISOString();
  return {
    id: 1,
    section: "items",
    itemName,
    relativePath,
    linkPath,
    targetPath: sourcePath,
    kind: "remote",
    targetExists: true,
    isMedia: true,
    storagePolicy: "location_1",
    resolvedStorageFileId: null,
    sizeBytes,
    firstSeenAt: timestamp,
    lastSeenAt: timestamp,
    lastChangedAt: timestamp,
    missingSince: null,
    updatedAt: timestamp
  };
}

describe("copy runner", () => {
  it("preserves a lease-loss abort reason", async () => {
    const controller = new AbortController();
    const leaseLost = new Error("lease lost while copying");
    leaseLost.name = "LeaseLostError";
    controller.abort(leaseLost);

    await expect(defaultCopyRunner.copyFile("unused-source", "unused-target", undefined, controller.signal)).rejects.toBe(leaseLost);
  });

  it("reports byte progress while comparing files", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "srtl-copier-"));
    try {
      const sourcePath = path.join(directory, "source.bin");
      const targetPath = path.join(directory, "target.bin");
      const payload = Buffer.alloc(2 * 1024 * 1024 + 128, 7);
      await Promise.all([fs.writeFile(sourcePath, payload), fs.writeFile(targetPath, payload)]);

      const progress: CopyFileProgress[] = [];
      const result = await defaultCopyRunner.runCmp(sourcePath, targetPath, (update) => {
        progress.push({ ...update });
      });

      expect(result).toMatchObject({ status: "pass" });
      expect(progress.length).toBeGreaterThanOrEqual(2);
      expect(progress[0]).toMatchObject({
        bytesProcessed: 0,
        totalBytes: payload.length
      });
      expect(progress[progress.length - 1]).toMatchObject({
        bytesProcessed: payload.length,
        totalBytes: payload.length,
        remainingSeconds: 0
      });
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it("closes the source file when the comparison cannot open the copy", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "srtl-copy-compare-open-"));
    const sourcePath = path.join(directory, "source.bin");
    const targetPath = path.join(directory, "target.bin");
    const realOpen = fs.open;
    const opened: Awaited<ReturnType<typeof fs.open>>[] = [];
    const open = vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      if (args[0] === targetPath) throw new Error("Input/output error");
      const handle = await realOpen(...args);
      opened.push(handle);
      return handle;
    });
    try {
      await fs.writeFile(sourcePath, "same bytes");
      await fs.writeFile(targetPath, "same bytes");

      await expect(defaultCopyRunner.runCmp(sourcePath, targetPath)).rejects.toThrow("Input/output error");
      expect(opened).toHaveLength(1);
      expect(opened[0]!.fd).toBe(-1);
    } finally {
      open.mockRestore();
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects destination parents that resolve outside the configured root", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "srtl-copier-escape-"));
    try {
      const symlinkDir = path.join(directory, "symlinks");
      const localDir = path.join(directory, "local");
      const remoteDir = path.join(directory, "remote");
      const outsideDir = path.join(directory, "outside");
      const sourcePath = path.join(remoteDir, "items", "Example Title", "source.mkv");
      const linkPath = path.join(symlinkDir, "items", "Example Title", "source.mkv");
      await Promise.all([
        fs.mkdir(path.dirname(sourcePath), { recursive: true }),
        fs.mkdir(path.dirname(linkPath), { recursive: true }),
        fs.mkdir(localDir, { recursive: true }),
        fs.mkdir(outsideDir, { recursive: true })
      ]);
      await fs.writeFile(sourcePath, "source");
      await fs.symlink(sourcePath, linkPath);
      await fs.symlink(outsideDir, path.join(localDir, "items"));
      const timestamp = new Date().toISOString();

      await expect(
        copyMediaLink(
          {
            id: 1,
            section: "items",
            itemName: "Example Title",
            relativePath: path.join("Example Title", "source.mkv"),
            linkPath,
            targetPath: sourcePath,
            kind: "remote",
            targetExists: true,
            isMedia: true,
            storagePolicy: "location_1",
            resolvedStorageFileId: null,
            sizeBytes: 6,
            firstSeenAt: timestamp,
            lastSeenAt: timestamp,
            lastChangedAt: timestamp,
            missingSince: null,
            updatedAt: timestamp
          },
          { symlinkDir, localDir, remoteDir },
          "to_local",
          fileRunner,
          undefined,
          { profile: "off", byteCompare: false, mediaValidation: "off" }
        )
      ).rejects.toThrow("Destination path parent resolves outside configured root");
      await expect(fs.readdir(outsideDir)).resolves.toEqual([]);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it("retries one transient source read failure before installing the copy", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "srtl-copier-retry-"));
    try {
      const symlinkDir = path.join(directory, "symlinks");
      const localDir = path.join(directory, "local");
      const remoteDir = path.join(directory, "remote");
      const relativePath = path.join("Retry Title", "retry.mkv");
      const sourcePath = path.join(remoteDir, "items", relativePath);
      const linkPath = path.join(symlinkDir, "items", relativePath);
      const destinationPath = path.join(localDir, "items", relativePath);
      await Promise.all([
        fs.mkdir(path.dirname(sourcePath), { recursive: true }),
        fs.mkdir(path.dirname(linkPath), { recursive: true }),
        fs.mkdir(path.join(localDir, "items"), { recursive: true })
      ]);
      await fs.writeFile(sourcePath, "retry source");
      await fs.symlink(sourcePath, linkPath);
      const timestamp = new Date().toISOString();
      let copyAttempts = 0;
      const runner = {
        ...fileRunner,
        async copyFile(source: string, destination: string, reportProgress: Parameters<typeof defaultCopyRunner.copyFile>[2], signal: AbortSignal | undefined) {
          copyAttempts += 1;
          if (copyAttempts === 1) throw Object.assign(new Error("temporary remote read failure"), { code: "EIO" });
          return defaultCopyRunner.copyFile(source, destination, reportProgress, signal);
        }
      };

      const result = await copyMediaLink(
        {
          id: 1,
          section: "items",
          itemName: "Retry Title",
          relativePath,
          linkPath,
          targetPath: sourcePath,
          kind: "remote",
          targetExists: true,
          isMedia: true,
          storagePolicy: "location_1",
          resolvedStorageFileId: null,
          sizeBytes: 12,
          firstSeenAt: timestamp,
          lastSeenAt: timestamp,
          lastChangedAt: timestamp,
          missingSince: null,
          updatedAt: timestamp
        },
        { symlinkDir, localDir, remoteDir },
        "to_local",
        runner,
        undefined,
        { profile: "off", byteCompare: false, mediaValidation: "off" }
      );

      expect(copyAttempts).toBe(2);
      expect(result).toMatchObject({ status: "copied", destinationPath });
      await expect(fs.readFile(destinationPath, "utf8")).resolves.toBe("retry source");
      await expect(fs.readlink(linkPath)).resolves.toBe(destinationPath);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects a junk source before transferring any bytes, with external expectations passed through", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "srtl-copier-preflight-"));
    try {
      const symlinkDir = path.join(directory, "symlinks");
      const localDir = path.join(directory, "local");
      const remoteDir = path.join(directory, "remote");
      const relativePath = path.join("Junk Title", "junk.mkv");
      const sourcePath = path.join(remoteDir, "items", relativePath);
      const linkPath = path.join(symlinkDir, "items", relativePath);
      await Promise.all([fs.mkdir(path.dirname(sourcePath), { recursive: true }), fs.mkdir(path.dirname(linkPath), { recursive: true }), fs.mkdir(path.join(localDir, "items"), { recursive: true })]);
      await fs.writeFile(sourcePath, Buffer.alloc(4096));
      await fs.symlink(sourcePath, linkPath);
      const timestamp = new Date().toISOString();
      let transfers = 0;
      let receivedExpectation: unknown;
      const runner = {
        ...fileRunner,
        async copyFile() { transfers += 1; },
        async inspectSource(inspectedPath: string, expectation: unknown) {
          receivedExpectation = expectation;
          return { status: "fail" as const, problems: [`${path.basename(inspectedPath)} starts with zero-filled data`], warnings: [], durationSeconds: null };
        }
      };
      const expectation = { source: "Radarr", sizeBytes: 4096 };
      await expect(copyMediaLink(
        { id: 1, section: "items", itemName: "Junk Title", relativePath, linkPath, targetPath: sourcePath, kind: "remote", targetExists: true, isMedia: true, storagePolicy: "location_1", resolvedStorageFileId: null, sizeBytes: 4096, firstSeenAt: timestamp, lastSeenAt: timestamp, lastChangedAt: timestamp, missingSince: null, updatedAt: timestamp },
        { symlinkDir, localDir, remoteDir },
        "to_local",
        runner,
        undefined,
        { profile: "off", byteCompare: false, mediaValidation: "off" },
        undefined,
        undefined,
        undefined,
        undefined,
        expectation
      )).rejects.toThrow("Source media failed preflight checks: junk.mkv starts with zero-filled data");
      expect(transfers).toBe(0);
      expect(receivedExpectation).toEqual(expectation);
      await expect(fs.readlink(linkPath)).resolves.toBe(sourcePath);
      await expect(fs.readdir(path.join(localDir, "items"))).resolves.toEqual([]);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it("creates readable destination directories and files under a restrictive process umask", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "srtl-copier-modes-"));
    const previousUmask = process.umask();
    try {
      const symlinkDir = path.join(directory, "symlinks");
      const localDir = path.join(directory, "local");
      const remoteDir = path.join(directory, "remote");
      const relativePath = path.join("Example Title", "Season 01", "episode.mkv");
      const sourcePath = path.join(remoteDir, "items", relativePath);
      const linkPath = path.join(symlinkDir, "items", relativePath);
      const destinationPath = path.join(localDir, "items", relativePath);
      await Promise.all([
        fs.mkdir(path.dirname(sourcePath), { recursive: true }),
        fs.mkdir(path.dirname(linkPath), { recursive: true }),
        fs.mkdir(path.join(localDir, "items"), { recursive: true })
      ]);
      await fs.writeFile(sourcePath, "source");
      await fs.symlink(sourcePath, linkPath);
      const timestamp = new Date().toISOString();

      process.umask(0o077);
      const result = await copyMediaLink(
        {
          id: 1,
          section: "items",
          itemName: "Example Title",
          relativePath,
          linkPath,
          targetPath: sourcePath,
          kind: "remote",
          targetExists: true,
          isMedia: true,
          storagePolicy: "location_1",
          resolvedStorageFileId: null,
          sizeBytes: 6,
          firstSeenAt: timestamp,
          lastSeenAt: timestamp,
          lastChangedAt: timestamp,
          missingSince: null,
          updatedAt: timestamp
        },
        { symlinkDir, localDir, remoteDir },
        "to_local",
        fileRunner,
        undefined,
        { profile: "off", byteCompare: false, mediaValidation: "off" }
      );

      expect(result.status).toBe("copied");
      expect((await fs.stat(path.join(localDir, "items", "Example Title"))).mode & 0o777).toBe(0o755);
      expect((await fs.stat(path.dirname(destinationPath))).mode & 0o777).toBe(0o755);
      expect((await fs.stat(destinationPath)).mode & 0o777).toBe(0o644);
      expect(await fs.readlink(linkPath)).toBe(destinationPath);
    } finally {
      process.umask(previousUmask);
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it("checks the job lease before promoting a transferred file", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "srtl-copier-lease-"));
    try {
      const symlinkDir = path.join(directory, "symlinks");
      const localDir = path.join(directory, "local");
      const remoteDir = path.join(directory, "remote");
      const relativePath = path.join("Lease Title", "lease.mkv");
      const sourcePath = path.join(remoteDir, "items", relativePath);
      const linkPath = path.join(symlinkDir, "items", relativePath);
      const destinationPath = path.join(localDir, "items", relativePath);
      await Promise.all([
        fs.mkdir(path.dirname(sourcePath), { recursive: true }),
        fs.mkdir(path.dirname(linkPath), { recursive: true }),
        fs.mkdir(path.join(localDir, "items"), { recursive: true })
      ]);
      await fs.writeFile(sourcePath, "lease source");
      await fs.symlink(sourcePath, linkPath);
      const timestamp = new Date().toISOString();
      const leaseLost = new Error("Job lease is no longer owned by this worker");
      leaseLost.name = "LeaseLostError";

      await expect(
        copyMediaLink(
          {
            id: 1,
            section: "items",
            itemName: "Lease Title",
            relativePath,
            linkPath,
            targetPath: sourcePath,
            kind: "remote",
            targetExists: true,
            isMedia: true,
            storagePolicy: "location_1",
            resolvedStorageFileId: null,
            sizeBytes: 12,
            firstSeenAt: timestamp,
            lastSeenAt: timestamp,
            lastChangedAt: timestamp,
            missingSince: null,
            updatedAt: timestamp
          },
          { symlinkDir, localDir, remoteDir },
          "to_local",
          fileRunner,
          undefined,
          { profile: "off", byteCompare: false, mediaValidation: "off" },
          undefined,
          undefined,
          undefined,
          async () => {
            throw leaseLost;
          }
        )
      ).rejects.toThrow("Job lease is no longer owned");

      await expect(fs.readlink(linkPath)).resolves.toBe(sourcePath);
      await expect(fs.stat(destinationPath)).rejects.toMatchObject({ code: "ENOENT" });
      expect((await fs.readdir(path.dirname(destinationPath))).filter((name) => name.includes("srtl-copy"))).toEqual([]);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it("restores the original symlink when journaling fails after repointing", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "srtl-copier-journal-"));
    try {
      const symlinkDir = path.join(directory, "symlinks");
      const localDir = path.join(directory, "local");
      const remoteDir = path.join(directory, "remote");
      const relativePath = path.join("Journal Title", "journal.mkv");
      const sourcePath = path.join(remoteDir, "items", relativePath);
      const linkPath = path.join(symlinkDir, "items", relativePath);
      const destinationPath = path.join(localDir, "items", relativePath);
      await Promise.all([
        fs.mkdir(path.dirname(sourcePath), { recursive: true }),
        fs.mkdir(path.dirname(linkPath), { recursive: true }),
        fs.mkdir(path.join(localDir, "items"), { recursive: true })
      ]);
      await fs.writeFile(sourcePath, "journal source");
      await fs.symlink(sourcePath, linkPath);
      const timestamp = new Date().toISOString();

      await expect(
        copyMediaLink(
          {
            id: 1,
            section: "items",
            itemName: "Journal Title",
            relativePath,
            linkPath,
            targetPath: sourcePath,
            kind: "remote",
            targetExists: true,
            isMedia: true,
            storagePolicy: "location_1",
            resolvedStorageFileId: null,
            sizeBytes: 14,
            firstSeenAt: timestamp,
            lastSeenAt: timestamp,
            lastChangedAt: timestamp,
            missingSince: null,
            updatedAt: timestamp
          },
          { symlinkDir, localDir, remoteDir },
          "to_local",
          fileRunner,
          undefined,
          { profile: "off", byteCompare: false, mediaValidation: "off" },
          undefined,
          undefined,
          async (update) => {
            if (update.stage === "repointed") throw new Error("journal unavailable");
          }
        )
      ).rejects.toThrow("journal unavailable");

      await expect(fs.readlink(linkPath)).resolves.toBe(sourcePath);
      await expect(fs.stat(destinationPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it("leaves the original destination intact when displacement fails", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "srtl-copier-displace-"));
    try {
      const symlinkDir = path.join(directory, "symlinks");
      const localDir = path.join(directory, "local");
      const remoteDir = path.join(directory, "remote");
      const relativePath = path.join("Displacement Title", "movie.mkv");
      const sourcePath = path.join(remoteDir, "items", relativePath);
      const linkPath = path.join(symlinkDir, "items", relativePath);
      const destinationPath = path.join(localDir, "items", relativePath);
      await Promise.all([
        fs.mkdir(path.dirname(sourcePath), { recursive: true }),
        fs.mkdir(path.dirname(linkPath), { recursive: true }),
        fs.mkdir(path.dirname(destinationPath), { recursive: true })
      ]);
      await fs.writeFile(sourcePath, "new destination contents");
      await fs.writeFile(destinationPath, "original destination contents");
      await fs.symlink(sourcePath, linkPath);
      let displacementBlocker: string | null = null;

      await expect(
        copyMediaLink(
          remoteCopyLink("Displacement Title", relativePath, linkPath, sourcePath, Buffer.byteLength("new destination contents")),
          { symlinkDir, localDir, remoteDir },
          "to_local",
          fileRunner,
          undefined,
          { profile: "off", byteCompare: false, mediaValidation: "off" },
          undefined,
          "replace",
          async (update) => {
            if (update.stage !== "destination_displaced" || !update.displacedPath) return;
            displacementBlocker = update.displacedPath;
            await fs.mkdir(displacementBlocker);
            await fs.writeFile(path.join(displacementBlocker, "sentinel"), "block file rename");
          }
        )
      ).rejects.toMatchObject({ code: expect.stringMatching(/EISDIR|ENOTDIR|ENOTEMPTY/) });

      await expect(fs.readFile(destinationPath, "utf8")).resolves.toBe("original destination contents");
      await expect(fs.readlink(linkPath)).resolves.toBe(sourcePath);
      if (displacementBlocker) await fs.rm(displacementBlocker, { recursive: true, force: true });
      expect((await fs.readdir(path.dirname(destinationPath))).filter((name) => name.includes(".srtl-replace-") || name.includes(".srtl-copy-"))).toEqual([]);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it("surfaces a reconciliation error when promoted-copy rollback fails", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "srtl-copier-rollback-"));
    let removeSpy: ReturnType<typeof vi.spyOn> | undefined;
    try {
      const symlinkDir = path.join(directory, "symlinks");
      const localDir = path.join(directory, "local");
      const remoteDir = path.join(directory, "remote");
      const relativePath = path.join("Rollback Title", "movie.mkv");
      const sourcePath = path.join(remoteDir, "items", relativePath);
      const linkPath = path.join(symlinkDir, "items", relativePath);
      const destinationPath = path.join(localDir, "items", relativePath);
      await Promise.all([
        fs.mkdir(path.dirname(sourcePath), { recursive: true }),
        fs.mkdir(path.dirname(linkPath), { recursive: true }),
        fs.mkdir(path.dirname(destinationPath), { recursive: true })
      ]);
      await fs.writeFile(sourcePath, "rollback contents");
      await fs.symlink(sourcePath, linkPath);

      const originalRemove = fs.rm.bind(fs);
      removeSpy = vi.spyOn(fs, "rm").mockImplementation(async (targetPath, options) => {
        if (path.resolve(String(targetPath)) === destinationPath) {
          throw Object.assign(new Error("injected rollback removal failure"), { code: "EIO" });
        }
        return originalRemove(targetPath, options);
      });

      await expect(
        copyMediaLink(
          remoteCopyLink("Rollback Title", relativePath, linkPath, sourcePath, Buffer.byteLength("rollback contents")),
          { symlinkDir, localDir, remoteDir },
          "to_local",
          fileRunner,
          undefined,
          { profile: "off", byteCompare: false, mediaValidation: "off" },
          undefined,
          undefined,
          async (update) => {
            if (update.stage === "repointed") throw new Error("injected journal failure after promotion");
          },
          (mutation) => mutation()
        )
      ).rejects.toBeInstanceOf(CopyReconciliationRequiredError);

      await expect(fs.readFile(destinationPath, "utf8")).resolves.toBe("rollback contents");
      await expect(fs.readlink(linkPath)).resolves.toBe(sourcePath);
    } finally {
      removeSpy?.mockRestore();
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it("does not overwrite a destination that appears while promotion waits for the lease guard", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "srtl-copier-promotion-race-"));
    try {
      const symlinkDir = path.join(directory, "symlinks");
      const localDir = path.join(directory, "local");
      const remoteDir = path.join(directory, "remote");
      const relativePath = path.join("Promotion Race Title", "movie.mkv");
      const sourcePath = path.join(remoteDir, "items", relativePath);
      const linkPath = path.join(symlinkDir, "items", relativePath);
      const destinationPath = path.join(localDir, "items", relativePath);
      await Promise.all([
        fs.mkdir(path.dirname(sourcePath), { recursive: true }),
        fs.mkdir(path.dirname(linkPath), { recursive: true }),
        fs.mkdir(path.dirname(destinationPath), { recursive: true })
      ]);
      await fs.writeFile(sourcePath, "copied contents");
      await fs.symlink(sourcePath, linkPath);
      let guardCalls = 0;

      await expect(
        copyMediaLink(
          remoteCopyLink("Promotion Race Title", relativePath, linkPath, sourcePath, Buffer.byteLength("copied contents")),
          { symlinkDir, localDir, remoteDir },
          "to_local",
          fileRunner,
          undefined,
          { profile: "off", byteCompare: false, mediaValidation: "off" },
          undefined,
          undefined,
          undefined,
          async (mutation) => {
            guardCalls += 1;
            if (guardCalls === 1) await fs.writeFile(destinationPath, "concurrent destination");
            return mutation();
          }
        )
      ).rejects.toThrow("Destination changed before copy promotion");

      await expect(fs.readFile(destinationPath, "utf8")).resolves.toBe("concurrent destination");
      await expect(fs.readlink(linkPath)).resolves.toBe(sourcePath);
      expect((await fs.readdir(path.dirname(destinationPath))).filter((name) => name.includes(".srtl-copy-"))).toEqual([]);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it("does not displace a destination replaced while conflict handling waits for the lease guard", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "srtl-copier-replacement-race-"));
    try {
      const symlinkDir = path.join(directory, "symlinks");
      const localDir = path.join(directory, "local");
      const remoteDir = path.join(directory, "remote");
      const relativePath = path.join("Replacement Race Title", "movie.mkv");
      const sourcePath = path.join(remoteDir, "items", relativePath);
      const linkPath = path.join(symlinkDir, "items", relativePath);
      const destinationPath = path.join(localDir, "items", relativePath);
      const concurrentPath = path.join(path.dirname(destinationPath), "concurrent.mkv");
      await Promise.all([
        fs.mkdir(path.dirname(sourcePath), { recursive: true }),
        fs.mkdir(path.dirname(linkPath), { recursive: true }),
        fs.mkdir(path.dirname(destinationPath), { recursive: true })
      ]);
      await fs.writeFile(sourcePath, "new copied contents");
      await fs.writeFile(destinationPath, "original destination");
      await fs.symlink(sourcePath, linkPath);
      let guardCalls = 0;

      await expect(
        copyMediaLink(
          remoteCopyLink("Replacement Race Title", relativePath, linkPath, sourcePath, Buffer.byteLength("new copied contents")),
          { symlinkDir, localDir, remoteDir },
          "to_local",
          fileRunner,
          undefined,
          { profile: "off", byteCompare: false, mediaValidation: "off" },
          undefined,
          "replace",
          undefined,
          async (mutation) => {
            guardCalls += 1;
            if (guardCalls === 1) {
              await fs.writeFile(concurrentPath, "concurrent destination");
              await fs.rename(concurrentPath, destinationPath);
            }
            return mutation();
          }
        )
      ).rejects.toThrow("Destination changed before copy promotion");

      await expect(fs.readFile(destinationPath, "utf8")).resolves.toBe("concurrent destination");
      await expect(fs.readlink(linkPath)).resolves.toBe(sourcePath);
      expect((await fs.readdir(path.dirname(destinationPath))).filter((name) => name.includes(".srtl-replace-") || name.includes(".srtl-copy-"))).toEqual([]);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it("does not repoint a source symlink retargeted by another process during transfer", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "srtl-copier-link-retarget-"));
    try {
      const symlinkDir = path.join(directory, "symlinks");
      const localDir = path.join(directory, "local");
      const remoteDir = path.join(directory, "remote");
      const relativePath = path.join("Retargeted Title", "movie.mkv");
      const sourcePath = path.join(remoteDir, "items", relativePath);
      const alternateSourcePath = path.join(remoteDir, "items", "Retargeted Title", "alternate.mkv");
      const linkPath = path.join(symlinkDir, "items", relativePath);
      const destinationPath = path.join(localDir, "items", relativePath);
      await Promise.all([
        fs.mkdir(path.dirname(sourcePath), { recursive: true }),
        fs.mkdir(path.dirname(linkPath), { recursive: true }),
        fs.mkdir(path.dirname(destinationPath), { recursive: true })
      ]);
      await Promise.all([fs.writeFile(sourcePath, "admitted source"), fs.writeFile(alternateSourcePath, "external retarget")]);
      await fs.symlink(sourcePath, linkPath);

      const runner = {
        ...fileRunner,
        async copyFile(...args: Parameters<typeof defaultCopyRunner.copyFile>) {
          await defaultCopyRunner.copyFile(...args);
          await fs.rm(linkPath);
          await fs.symlink(alternateSourcePath, linkPath);
        }
      };

      await expect(
        copyMediaLink(
          remoteCopyLink("Retargeted Title", relativePath, linkPath, sourcePath, Buffer.byteLength("admitted source")),
          { symlinkDir, localDir, remoteDir },
          "to_local",
          runner,
          undefined,
          { profile: "off", byteCompare: false, mediaValidation: "off" },
          undefined,
          undefined,
          undefined,
          (mutation) => mutation()
        )
      ).rejects.toThrow("Symlink target changed since the last inventory scan");

      await expect(fs.readlink(linkPath)).resolves.toBe(alternateSourcePath);
      await expect(fs.stat(destinationPath)).rejects.toMatchObject({ code: "ENOENT" });
      expect((await fs.readdir(path.dirname(destinationPath))).filter((name) => name.includes(".srtl-copy-"))).toEqual([]);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it("preserves a same-size replacement when promoted-copy rollback detects a different identity", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "srtl-copier-identity-rollback-"));
    try {
      const symlinkDir = path.join(directory, "symlinks");
      const localDir = path.join(directory, "local");
      const remoteDir = path.join(directory, "remote");
      const relativePath = path.join("Identity Rollback Title", "movie.mkv");
      const sourcePath = path.join(remoteDir, "items", relativePath);
      const linkPath = path.join(symlinkDir, "items", relativePath);
      const destinationPath = path.join(localDir, "items", relativePath);
      const replacementPath = path.join(path.dirname(destinationPath), "replacement.mkv");
      const sourceContents = Buffer.alloc(32, 0x61);
      const originalDestinationContents = Buffer.alloc(32, 0x63);
      const replacementContents = Buffer.alloc(32, 0x62);
      await Promise.all([
        fs.mkdir(path.dirname(sourcePath), { recursive: true }),
        fs.mkdir(path.dirname(linkPath), { recursive: true }),
        fs.mkdir(path.dirname(destinationPath), { recursive: true })
      ]);
      await Promise.all([fs.writeFile(sourcePath, sourceContents), fs.writeFile(destinationPath, originalDestinationContents)]);
      await fs.symlink(sourcePath, linkPath);
      const operationUpdates: CopyOperationUpdate[] = [];

      await expect(
        copyMediaLink(
          remoteCopyLink("Identity Rollback Title", relativePath, linkPath, sourcePath, sourceContents.length),
          { symlinkDir, localDir, remoteDir },
          "to_local",
          fileRunner,
          undefined,
          { profile: "off", byteCompare: false, mediaValidation: "off" },
          undefined,
          "replace",
          async (update) => {
            operationUpdates.push({ ...update });
            if (update.stage !== "repointed" || update.resultStatus !== "copied") return;
            await fs.writeFile(replacementPath, replacementContents);
            await fs.rename(replacementPath, destinationPath);
            throw new Error("injected journal failure after external destination replacement");
          },
          (mutation) => mutation()
        )
      ).rejects.toBeInstanceOf(CopyReconciliationRequiredError);

      await expect(fs.readFile(destinationPath)).resolves.toEqual(replacementContents);
      await expect(fs.readlink(linkPath)).resolves.toBe(sourcePath);
      const identityUpdates = [
        operationUpdates.find((update) => update.stage === "verified" && update.tempIdentity)?.tempIdentity,
        operationUpdates.find((update) => update.stage === "destination_displaced" && update.displacedIdentity)?.displacedIdentity,
        operationUpdates.find((update) => update.stage === "promoted" && update.destinationIdentity)?.destinationIdentity
      ];
      for (const rawIdentity of identityUpdates) {
        expect(rawIdentity).toBeTypeOf("string");
        expect(JSON.parse(rawIdentity!)).toEqual({
          dev: expect.stringMatching(/^\d+$/),
          ino: expect.stringMatching(/^\d+$/),
          size: sourceContents.length.toString(),
          mtimeNs: expect.stringMatching(/^\d+$/),
          ctimeNs: expect.stringMatching(/^\d+$/)
        });
      }
      const displacedUpdate = operationUpdates.find((update) => update.stage === "destination_displaced" && update.displacedIdentity);
      expect(displacedUpdate?.displacedPath).toBeTypeOf("string");
      await expect(fs.readFile(displacedUpdate!.displacedPath!)).resolves.toEqual(originalDestinationContents);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it("requires durable reconciliation when the lease wrapper fails after a filesystem mutation", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "srtl-copier-post-mutation-lease-"));
    try {
      const symlinkDir = path.join(directory, "symlinks");
      const localDir = path.join(directory, "local");
      const remoteDir = path.join(directory, "remote");
      const relativePath = path.join("Post Mutation Lease", "movie.mkv");
      const sourcePath = path.join(remoteDir, "items", relativePath);
      const linkPath = path.join(symlinkDir, "items", relativePath);
      const destinationPath = path.join(localDir, "items", relativePath);
      await Promise.all([
        fs.mkdir(path.dirname(sourcePath), { recursive: true }),
        fs.mkdir(path.dirname(linkPath), { recursive: true }),
        fs.mkdir(path.dirname(destinationPath), { recursive: true })
      ]);
      await Promise.all([fs.writeFile(sourcePath, "matching contents"), fs.writeFile(destinationPath, "matching contents")]);
      await fs.symlink(sourcePath, linkPath);
      const operationUpdates: CopyOperationUpdate[] = [];

      await expect(
        copyMediaLink(
          remoteCopyLink("Post Mutation Lease", relativePath, linkPath, sourcePath, Buffer.byteLength("matching contents")),
          { symlinkDir, localDir, remoteDir },
          "to_local",
          fileRunner,
          undefined,
          { profile: "off", byteCompare: false, mediaValidation: "off" },
          undefined,
          undefined,
          async (update) => {
            operationUpdates.push(update);
          },
          async (mutation) => {
            await mutation();
            throw new Error("injected lease transaction commit failure");
          }
        )
      ).rejects.toMatchObject({
        name: "CopyReconciliationRequiredError",
        message: expect.stringContaining("Filesystem mutation completed")
      });

      await expect(fs.readlink(linkPath)).resolves.toBe(destinationPath);
      expect(operationUpdates).toEqual(
        expect.arrayContaining([expect.objectContaining({ stage: "repointed", destinationIdentity: expect.any(String), resultStatus: "repointed" })])
      );
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it("carries a validation warning onto copied and repointed results, and still fails on a byte mismatch", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "srtl-copier-warning-"));
    try {
      const paths = { symlinkDir: path.join(directory, "symlinks"), localDir: path.join(directory, "local"), remoteDir: path.join(directory, "remote") };
      const warning = "File is 48 bytes shorter than its header declares; accepted because ffmpeg still read it to the end";
      const runner = { ...fileRunner, runFfmpeg: async () => ({ status: "pass" as const, output: "File ended prematurely", warning }) };
      const behavior = { profile: "fast", byteCompare: true, mediaValidation: "fast" } as const;
      const setUp = async (title: string, content: string) => {
        const relativePath = path.join(title, "movie.mkv");
        const sourcePath = path.join(paths.remoteDir, "items", relativePath);
        const linkPath = path.join(paths.symlinkDir, "items", relativePath);
        const destinationPath = path.join(paths.localDir, "items", relativePath);
        await Promise.all([fs.mkdir(path.dirname(sourcePath), { recursive: true }), fs.mkdir(path.dirname(linkPath), { recursive: true }), fs.mkdir(path.dirname(destinationPath), { recursive: true })]);
        await fs.writeFile(sourcePath, content);
        await fs.symlink(sourcePath, linkPath);
        return { link: remoteCopyLink(title, relativePath, linkPath, sourcePath, Buffer.byteLength(content)), destinationPath, linkPath };
      };

      const copied = await setUp("Copied Title", "short tail contents");
      await expect(copyMediaLink(copied.link, paths, "to_local", runner, undefined, behavior)).resolves.toMatchObject({ status: "copied", warning });

      const repointed = await setUp("Repointed Title", "short tail contents");
      await fs.writeFile(repointed.destinationPath, "short tail contents");
      await expect(copyMediaLink(repointed.link, paths, "to_local", runner, undefined, behavior)).resolves.toMatchObject({ status: "repointed", warning });

      const mismatched = await setUp("Mismatched Title", "short tail contents");
      const corruptingRunner = {
        ...runner,
        copyFile: async (sourcePath: string, tempPath: string) => {
          const content = await fs.readFile(sourcePath);
          content[0] ^= 0xff;
          await fs.writeFile(tempPath, content);
        }
      };
      await expect(copyMediaLink(mismatched.link, paths, "to_local", corruptingRunner, undefined, behavior)).rejects.toThrow("Byte compare failed");
      await expect(fs.readlink(mismatched.linkPath)).resolves.toBe(mismatched.link.targetPath);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it("rechecks cancellation after the lease guard finishes waiting", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "srtl-copier-cancel-lease-"));
    try {
      const symlinkDir = path.join(directory, "symlinks");
      const localDir = path.join(directory, "local");
      const remoteDir = path.join(directory, "remote");
      const relativePath = path.join("Cancellation Title", "movie.mkv");
      const sourcePath = path.join(remoteDir, "items", relativePath);
      const linkPath = path.join(symlinkDir, "items", relativePath);
      const destinationPath = path.join(localDir, "items", relativePath);
      await Promise.all([
        fs.mkdir(path.dirname(sourcePath), { recursive: true }),
        fs.mkdir(path.dirname(linkPath), { recursive: true }),
        fs.mkdir(path.dirname(destinationPath), { recursive: true })
      ]);
      await fs.writeFile(sourcePath, "cancelled contents");
      await fs.symlink(sourcePath, linkPath);

      const controller = new AbortController();
      const cancellation = new Error("cancelled while waiting for the lease");
      let releaseLease!: () => void;
      const leaseReleased = new Promise<void>((resolve) => {
        releaseLease = resolve;
      });
      let reportLeaseWait!: () => void;
      const leaseWaitStarted = new Promise<void>((resolve) => {
        reportLeaseWait = resolve;
      });
      let guardCalls = 0;
      const copy = copyMediaLink(
        remoteCopyLink("Cancellation Title", relativePath, linkPath, sourcePath, Buffer.byteLength("cancelled contents")),
        { symlinkDir, localDir, remoteDir },
        "to_local",
        fileRunner,
        undefined,
        { profile: "off", byteCompare: false, mediaValidation: "off" },
        controller.signal,
        undefined,
        undefined,
        async (mutation) => {
          guardCalls += 1;
          if (guardCalls === 1) {
            reportLeaseWait();
            await leaseReleased;
          }
          return mutation();
        }
      );

      await leaseWaitStarted;
      controller.abort(cancellation);
      releaseLease();

      await expect(copy).rejects.toBe(cancellation);
      await expect(fs.stat(destinationPath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.readlink(linkPath)).resolves.toBe(sourcePath);
      expect((await fs.readdir(path.dirname(destinationPath))).filter((name) => name.includes(".srtl-copy-"))).toEqual([]);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
});
