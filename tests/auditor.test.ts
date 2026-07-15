import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { auditMediaLink, type AuditCommandRunner } from "../src/server/lib/auditor";
import type { MediaLinkRow } from "../src/shared/types";

let tmpDir: string;

describe("auditor", () => {
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "srtl-audit-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("passes when ffmpeg passes and source is unknown", async () => {
    const targetPath = path.join(tmpDir, "local.mkv");
    await fs.writeFile(targetPath, "ok");
    const runner: AuditCommandRunner = {
      runFfmpeg: async () => ({ status: "pass", output: "" }),
      runCmp: async () => ({ status: "fail", output: "should not run" })
    };

    const result = await auditMediaLink(link(targetPath), null, "fast", runner);
    expect(result).toMatchObject({ status: "pass", ffmpegStatus: "pass", cmpStatus: "source_unknown" });
  });

  it("fails when byte compare fails", async () => {
    const targetPath = path.join(tmpDir, "local.mkv");
    const sourcePath = path.join(tmpDir, "source.mkv");
    await fs.writeFile(targetPath, "local");
    await fs.writeFile(sourcePath, "source");
    const runner: AuditCommandRunner = {
      runFfmpeg: async () => ({ status: "pass", output: "" }),
      runCmp: async () => ({ status: "fail", output: "byte 1 differs" })
    };

    const result = await auditMediaLink(link(targetPath), sourcePath, "deep", runner);
    expect(result).toMatchObject({ status: "fail", ffmpegStatus: "pass", cmpStatus: "fail" });
  });

  it("skips byte compare when audit settings disable it", async () => {
    const targetPath = path.join(tmpDir, "local.mkv");
    const sourcePath = path.join(tmpDir, "source.mkv");
    await fs.writeFile(targetPath, "local");
    await fs.writeFile(sourcePath, "source");
    let compared = false;
    const runner: AuditCommandRunner = {
      runFfmpeg: async () => ({ status: "pass", output: "" }),
      runCmp: async () => {
        compared = true;
        return { status: "fail", output: "should not run" };
      }
    };

    const result = await auditMediaLink(link(targetPath), sourcePath, "fast", runner, { byteCompare: false });
    expect(compared).toBe(false);
    expect(result).toMatchObject({ status: "pass", ffmpegStatus: "pass", cmpStatus: "skipped", message: "Passed ffmpeg; byte compare skipped" });
  });
});

function link(targetPath: string): MediaLinkRow {
  const timestamp = new Date().toISOString();
  return {
    id: 1,
    section: "movies",
    itemName: "Movie",
    relativePath: "Movie/local.mkv",
    linkPath: "/plex/movies/Movie/local.mkv",
    targetPath,
    kind: "local",
    targetExists: true,
    isMedia: true,
    storagePolicy: "unassigned",
    resolvedStorageFileId: 1,
    sizeBytes: null,
    firstSeenAt: timestamp,
    lastSeenAt: timestamp,
    lastChangedAt: timestamp,
    missingSince: null,
    updatedAt: timestamp
  };
}
