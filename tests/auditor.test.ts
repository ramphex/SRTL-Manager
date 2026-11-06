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

  it("reports content check failures without running ffmpeg or byte compare", async () => {
    const targetPath = path.join(tmpDir, "hollow.mkv");
    await fs.writeFile(targetPath, "placeholder");
    let commands = 0;
    const runner: AuditCommandRunner = {
      runFfmpeg: async () => { commands += 1; return { status: "pass", output: "" }; },
      runCmp: async () => { commands += 1; return { status: "pass", output: "" }; },
      inspectMedia: async () => ({ status: "fail", problems: ["File is hollow: only 512 bytes of 20.5 GB is stored on disk"], warnings: [], durationSeconds: null })
    };

    const result = await auditMediaLink(link(targetPath), path.join(tmpDir, "source.mkv"), "fast", runner);
    expect(result).toMatchObject({ status: "fail", ffmpegStatus: "fail", cmpStatus: "skipped", message: "Media content check failed: File is hollow: only 512 bytes of 20.5 GB is stored on disk" });
    expect(commands).toBe(0);
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

  it("reports an accepted short tail as a warning, and never over a byte mismatch", async () => {
    const targetPath = path.join(tmpDir, "short-tail.mkv");
    const sourcePath = path.join(tmpDir, "short-tail-source.mkv");
    await fs.writeFile(targetPath, "local");
    await fs.writeFile(sourcePath, "local");
    const warning = "File is 48 bytes shorter than its header declares; accepted because ffmpeg still read it to the end";
    const runFfmpeg = async () => ({ status: "pass" as const, output: "File ended prematurely", warning });

    const matching = await auditMediaLink(link(targetPath), sourcePath, "fast", { runFfmpeg, runCmp: async () => ({ status: "pass", output: "" }) });
    expect(matching).toMatchObject({ status: "warning", ffmpegStatus: "pass", cmpStatus: "pass" });
    expect(matching.message).toBe(`Passed ffmpeg and byte compare. ${warning}`);

    const different = await auditMediaLink(link(targetPath), sourcePath, "fast", { runFfmpeg, runCmp: async () => ({ status: "fail", output: "differ" }) });
    expect(different).toMatchObject({ status: "fail", ffmpegStatus: "pass", cmpStatus: "fail" });
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
