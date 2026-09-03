import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { removeExpectedSymlink } from "../src/server/jobs/symlinkCleanup";

describe("failed-copy symlink removal", () => {
  let directory: string;
  let symlinkRoot: string;
  let mediaRoot: string;

  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "srtl-symlink-cleanup-"));
    symlinkRoot = path.join(directory, "plex");
    mediaRoot = path.join(directory, "remote");
    await Promise.all([fs.mkdir(symlinkRoot, { recursive: true }), fs.mkdir(mediaRoot, { recursive: true })]);
  });

  afterEach(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });

  it("unlinks an exact relative symlink without deleting its target or parent directory", async () => {
    const targetPath = path.join(mediaRoot, "shows", "Example", "episode.mkv");
    const linkPath = path.join(symlinkRoot, "shows", "Example", "episode.mkv");
    await Promise.all([fs.mkdir(path.dirname(targetPath), { recursive: true }), fs.mkdir(path.dirname(linkPath), { recursive: true })]);
    await fs.writeFile(targetPath, "preserved media");
    await fs.symlink(path.relative(path.dirname(linkPath), targetPath), linkPath);

    await expect(removeExpectedSymlink(symlinkRoot, linkPath, targetPath)).resolves.toBe("removed");
    await expect(fs.lstat(linkPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.readFile(targetPath, "utf8")).resolves.toBe("preserved media");
    await expect(fs.stat(path.dirname(linkPath))).resolves.toMatchObject({});
  });

  it("is idempotent when the managed symlink is already absent", async () => {
    const linkPath = path.join(symlinkRoot, "movies", "Missing", "movie.mkv");
    await fs.mkdir(path.dirname(linkPath), { recursive: true });
    await expect(removeExpectedSymlink(symlinkRoot, linkPath, path.join(mediaRoot, "missing.mkv"))).resolves.toBe("already_missing");
  });

  it("rejects changed targets, non-symlink paths, and paths outside the managed root", async () => {
    const expectedTarget = path.join(mediaRoot, "expected.mkv");
    const changedTarget = path.join(mediaRoot, "changed.mkv");
    const linkPath = path.join(symlinkRoot, "movies", "Changed", "movie.mkv");
    await Promise.all([
      fs.mkdir(path.dirname(linkPath), { recursive: true }),
      fs.writeFile(expectedTarget, "expected"),
      fs.writeFile(changedTarget, "changed")
    ]);
    await fs.symlink(changedTarget, linkPath);
    await expect(removeExpectedSymlink(symlinkRoot, linkPath, expectedTarget)).rejects.toThrow("Symlink target changed");
    await expect(fs.readlink(linkPath)).resolves.toBe(changedTarget);

    await fs.unlink(linkPath);
    await fs.writeFile(linkPath, "ordinary file");
    await expect(removeExpectedSymlink(symlinkRoot, linkPath, expectedTarget)).rejects.toThrow("no longer a symlink");
    await expect(fs.readFile(linkPath, "utf8")).resolves.toBe("ordinary file");

    const outsidePath = path.join(directory, "outside-link.mkv");
    await fs.symlink(expectedTarget, outsidePath);
    await expect(removeExpectedSymlink(symlinkRoot, outsidePath, expectedTarget)).rejects.toThrow("outside configured root");
    await expect(fs.readlink(outsidePath)).resolves.toBe(expectedTarget);
  });
});
