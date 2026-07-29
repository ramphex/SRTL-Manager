import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { copyMediaLink, defaultCopyRunner, type CopyFileProgress } from "../src/server/lib/copier";

describe("copy runner", () => {
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
          defaultCopyRunner,
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
        ...defaultCopyRunner,
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
        defaultCopyRunner,
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
});
