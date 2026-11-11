import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openTestDatabase } from "./testDb";
import * as schema from "../src/server/db/schema";
import { damagedFilesCsv, listDamagedFiles } from "../src/server/lib/damagedFiles";
import { classifyIntegrity, needsZeroSampling, partialHollowZeroSamples, sampleZeroBlocks, zeroSampleBytes, zeroSampleCount, zeroSamplePositions, type ZeroSampleResult } from "../src/server/lib/mediaIntegrity";
import { persistScanResult, scanLibrary, listStorageFiles } from "../src/server/lib/scanner";
import { assessLocalIntegrity } from "../src/server/lib/storageIntegrity";
import { registerDamagedRoutes } from "../src/server/routes/damagedRoutes";

const mb = 1024 * 1024;
let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "srtl-damaged-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("integrity classifier", () => {
  it("only samples large files that are under 90% stored and not already hollow", () => {
    expect(needsZeroSampling(100 * mb, 95 * mb)).toBe(false);
    expect(needsZeroSampling(100 * mb, 70 * mb)).toBe(true);
    expect(needsZeroSampling(100 * mb, 0)).toBe(true);
    expect(needsZeroSampling(100 * mb, null)).toBe(false);
    expect(needsZeroSampling(100 * mb, 0.5 * mb)).toBe(false);
    expect(needsZeroSampling(10 * mb, 1 * mb)).toBe(false);
  });

  it("calls two or more all-zero samples partially hollow and keeps compressed files ok", () => {
    expect(partialHollowZeroSamples).toBe(2);
    expect(classifyIntegrity(100 * mb, 70 * mb, { zeroSamples: 0 })).toBe("ok");
    expect(classifyIntegrity(100 * mb, 70 * mb, { zeroSamples: 1 })).toBe("ok");
    expect(classifyIntegrity(100 * mb, 70 * mb, { zeroSamples: 2 })).toBe("partial_hollow");
    expect(classifyIntegrity(100 * mb, 30 * mb, { zeroSamples: 17 })).toBe("partial_hollow");
    expect(classifyIntegrity(100 * mb, 0.5 * mb, null)).toBe("hollow");
    expect(classifyIntegrity(100 * mb, 70 * mb, "failed")).toBe("unknown");
  });

  it("spreads 24 samples from the first to the last block of the file", () => {
    const positions = zeroSamplePositions(100 * mb);
    expect(positions).toHaveLength(zeroSampleCount);
    expect(positions[0]).toBe(0);
    expect(positions.at(-1)).toBe(100 * mb - zeroSampleBytes);
  });
});

describe("assessLocalIntegrity", () => {
  const file = (overrides: Partial<{ rootType: string; filePath: string; sizeBytes: number; mtimeMs: number; allocatedBytes: number | null }> = {}) => ({
    rootType: "local",
    filePath: "/local/movies/A/a.mkv",
    sizeBytes: 100 * mb,
    mtimeMs: 1,
    allocatedBytes: 70 * mb,
    ...overrides
  });
  const sampler = (zeroSamples: number, calls: string[] = []) => async (filePath: string): Promise<ZeroSampleResult> => {
    calls.push(filePath);
    return { zeroSamples, totalSamples: zeroSampleCount };
  };

  it("keeps a well-compressed file (Dora-style, 70% stored, no zero samples) ok", async () => {
    const result = await assessLocalIntegrity([file()], new Map(), { sampler: sampler(0), now: "t" });
    expect(result.get("/local/movies/A/a.mkv")).toEqual({ integrity: "ok", integrityZeroSamples: 0, integrityCheckedAt: "t" });
  });

  it("skips remote files entirely", async () => {
    const calls: string[] = [];
    const result = await assessLocalIntegrity([file({ rootType: "remote" })], new Map(), { sampler: sampler(24, calls), now: "t" });
    expect(calls).toEqual([]);
    expect(result.size).toBe(0);
  });

  it("does not re-read a file whose size, mtime and allocation are unchanged", async () => {
    const calls: string[] = [];
    const stored = { ...file(), integrity: "partial_hollow", integrityZeroSamples: 5, integrityCheckedAt: "earlier" };
    const existing = new Map([[stored.filePath, stored]]);
    expect((await assessLocalIntegrity([file()], existing, { sampler: sampler(5, calls), now: "t" })).size).toBe(0);
    expect(calls).toEqual([]);
    for (const changed of [file({ sizeBytes: 101 * mb }), file({ mtimeMs: 2 }), file({ allocatedBytes: 71 * mb })]) {
      await assessLocalIntegrity([changed], existing, { sampler: sampler(0, calls), now: "t" });
    }
    expect(calls).toHaveLength(3);
  });

  it("records read errors and timeouts as unknown and tries them again next time", async () => {
    const failing = async () => {
      throw new Error("EIO");
    };
    const first = await assessLocalIntegrity([file()], new Map(), { sampler: failing, now: "t" });
    expect(first.get(file().filePath)).toEqual({ integrity: "unknown", integrityZeroSamples: null, integrityCheckedAt: "t" });
    const calls: string[] = [];
    const existing = new Map([[file().filePath, { ...file(), ...first.get(file().filePath)! }]]);
    const second = await assessLocalIntegrity([file()], existing, { sampler: sampler(0, calls), now: "u" });
    expect(calls).toHaveLength(1);
    expect(second.get(file().filePath)?.integrity).toBe("ok");
  });

  it("never runs more than the requested number of reads at once", async () => {
    let active = 0;
    let peak = 0;
    const slow = async (): Promise<ZeroSampleResult> => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return { zeroSamples: 0, totalSamples: zeroSampleCount };
    };
    const files = Array.from({ length: 12 }, (_unused, index) => file({ filePath: `/local/f${index}.mkv` }));
    await assessLocalIntegrity(files, new Map(), { sampler: slow, concurrency: 2, now: "t" });
    expect(peak).toBeLessThanOrEqual(2);
  });
});

async function sparseFile(filePath: string, size: number, writtenBytes: number): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const handle = await fs.open(filePath, "w");
  try {
    if (writtenBytes > 0) await handle.write(randomBytes(writtenBytes), 0, writtenBytes, 0);
    await handle.truncate(size);
  } finally {
    await handle.close();
  }
}

describe("scan integrity persistence", () => {
  async function setup() {
    const symlinkDir = path.join(tmpDir, "plex");
    const localDir = path.join(tmpDir, "local");
    const remoteDir = path.join(tmpDir, "remote");
    await fs.mkdir(path.join(symlinkDir, "movies", "Half"), { recursive: true });
    await fs.mkdir(remoteDir, { recursive: true });
    await sparseFile(path.join(localDir, "movies", "Empty", "empty.mkv"), 64 * mb, 4096);
    await sparseFile(path.join(localDir, "movies", "Half", "half.mkv"), 64 * mb, 32 * mb);
    await sparseFile(path.join(localDir, "movies", "Full", "full.mkv"), 64 * mb, 64 * mb);
    await fs.symlink(path.join(localDir, "movies", "Half", "half.mkv"), path.join(symlinkDir, "movies", "Half", "half.mkv"));
    await sparseFile(path.join(remoteDir, "movies", "Half", "half.mkv"), 64 * mb, 0);
    await sparseFile(path.join(remoteDir, "movies", "Remote Only", "remote.mkv"), 64 * mb, 0);
    const half = await fs.stat(path.join(localDir, "movies", "Half", "half.mkv"));
    // Filesystems without sparse files store every block, so nothing here would look suspect.
    const supported = half.blocks * 512 < half.size * 0.9;
    const paths = { symlinkDir, localDir, remoteDir };
    const scan = (options: { scanSymlinks: boolean; scanLocal: boolean; scanRemote: boolean }) => scanLibrary(paths, { sections: ["movies"] }, new Map(), options);
    return { paths, supported, scan };
  }

  function countingSampler() {
    const calls: string[] = [];
    return { calls, zeroSampler: async (filePath: string, size: number) => (calls.push(filePath), sampleZeroBlocks(filePath, size)) };
  }

  it("classifies sparse, half-written and fully written files and only re-samples what changed", async () => {
    const { supported, scan, paths } = await setup();
    if (!supported) return;
    const database = await openTestDatabase();
    try {
      const sampler = countingSampler();
      await persistScanResult(database.db, await scan({ scanSymlinks: true, scanLocal: true, scanRemote: true }), 1, undefined, sampler);
      const files = await listStorageFiles(database.db, "local");
      const byName = (name: string) => files.find((file) => path.basename(path.dirname(file.filePath)) === name)!;
      expect(byName("Empty")).toMatchObject({ integrity: "hollow", hollow: true, zeroSamples: null });
      expect(byName("Half")).toMatchObject({ integrity: "partial_hollow", hollow: false });
      expect(byName("Half").zeroSamples).toBeGreaterThanOrEqual(2);
      expect(byName("Full")).toMatchObject({ integrity: "ok", zeroSamples: null, hollow: false });
      // Only the half-written local file was read; the fully sparse one is hollow by allocation and the full one is not a suspect.
      expect(sampler.calls).toEqual([path.join(paths.localDir, "movies", "Half", "half.mkv")]);

      const remote = await listStorageFiles(database.db, "remote");
      expect(remote.every((file) => file.zeroSamples === null && file.integrityCheckedAt === null)).toBe(true);

      await persistScanResult(database.db, await scan({ scanSymlinks: true, scanLocal: true, scanRemote: true }), 2, undefined, sampler);
      expect(sampler.calls).toHaveLength(1);

      const touched = path.join(paths.localDir, "movies", "Half", "half.mkv");
      const later = new Date(Date.now() + 60_000);
      await fs.utimes(touched, later, later);
      await persistScanResult(database.db, await scan({ scanSymlinks: false, scanLocal: true, scanRemote: false }), 3, undefined, sampler);
      expect(sampler.calls).toHaveLength(2);
    } finally {
      await database.close();
    }
  });

  it("stores read errors as unknown, not damaged", async () => {
    const { supported, scan } = await setup();
    if (!supported) return;
    const database = await openTestDatabase();
    try {
      await persistScanResult(database.db, await scan({ scanSymlinks: false, scanLocal: true, scanRemote: false }), 1, undefined, {
        zeroSampler: async () => {
          throw new Error("Input/output error");
        }
      });
      const half = (await listStorageFiles(database.db, "local")).find((file) => file.filePath.endsWith("half.mkv"))!;
      expect(half).toMatchObject({ integrity: "unknown", zeroSamples: null });
      expect(await listDamagedFiles(database.db)).toEqual([expect.objectContaining({ integrity: "hollow" })]);

      const sampler = countingSampler();
      await persistScanResult(database.db, await scan({ scanSymlinks: false, scanLocal: true, scanRemote: false }), 2, undefined, sampler);
      expect(sampler.calls).toHaveLength(1);
      expect((await listStorageFiles(database.db, "local")).find((file) => file.filePath.endsWith("half.mkv"))?.integrity).toBe("partial_hollow");
    } finally {
      await database.close();
    }
  });

  it("lists damaged local files with library and remote-copy context, exports CSV, and serves both over the API", async () => {
    const { supported, scan } = await setup();
    if (!supported) return;
    const database = await openTestDatabase();
    const app = Fastify();
    try {
      await persistScanResult(database.db, await scan({ scanSymlinks: true, scanLocal: true, scanRemote: true }), 1);
      const rows = await listDamagedFiles(database.db);
      expect(rows.map((row) => [row.itemName, row.integrity, row.linked, row.remoteCopyExists])).toEqual([
        ["Empty", "hollow", false, false],
        ["Half", "partial_hollow", true, true]
      ]);
      const half = rows.find((row) => row.itemName === "Half")!;
      expect(half.storedPercent).toBeGreaterThan(40);
      expect(half.storedPercent).toBeLessThan(60);
      expect(half.zeroSamplesTotal).toBe(24);

      const csv = damagedFilesCsv(rows);
      const lines = csv.trim().split("\r\n");
      expect(lines[0]).toBe("Title,Section,Verdict,Path,Size bytes,Stored bytes,Stored %,Zero samples,Samples,Checked at,Linked in library,Remote copy exists,Last audit,Audit result,Audited at");
      expect(lines).toHaveLength(3);
      expect(lines[2]).toContain("Half,movies,Damaged,");
      expect(lines[2]).toMatch(/,yes,yes,,,$/);

      registerDamagedRoutes(app, database.db, {} as never);
      const json = await app.inject({ method: "GET", url: "/api/damaged-files" });
      expect(json.statusCode).toBe(200);
      expect(json.json()).toHaveLength(2);
      const exported = await app.inject({ method: "GET", url: "/api/damaged-files.csv" });
      expect(exported.headers["content-type"]).toContain("text/csv");
      expect(exported.headers["content-disposition"]).toMatch(/attachment; filename="srtl-damaged-files-\d{4}-\d{2}-\d{2}\.csv"/);
      expect(exported.body).toBe(csv);
    } finally {
      await app.close();
      await database.close();
    }
  });

  it("includes pre-migration hollow rows and ignores missing and remote files", async () => {
    const database = await openTestDatabase();
    try {
      const base = { rootPath: "/r", section: "movies", itemName: "Old", relativePath: "movies/Old/old.mkv", filePath: "/l/movies/Old/old.mkv", storagePolicy: "unassigned", sizeBytes: 100 * mb, mtimeMs: 1, firstSeenAt: "t", lastSeenAt: "t", lastChangedAt: "t", lastSeenJobId: 1, updatedAt: "t" };
      await database.db.insert(schema.storageFiles).values([
        { ...base, rootType: "local", allocatedBytes: 1000 },
        { ...base, rootType: "local", filePath: "/l/gone.mkv", relativePath: "movies/Old/gone.mkv", allocatedBytes: 1000, missingSince: "t" },
        { ...base, rootType: "remote", filePath: "/r/movies/Old/old.mkv", allocatedBytes: 1000, integrity: "hollow" }
      ]);
      expect((await listDamagedFiles(database.db)).map((row) => row.filePath)).toEqual(["/l/movies/Old/old.mkv"]);
    } finally {
      await database.close();
    }
  });
});

describe("csv escaping", () => {
  it("quotes commas and neutralises spreadsheet formulas in file names", () => {
    const csv = damagedFilesCsv([
      { storageFileId: 1, section: "movies", itemName: "=HYPERLINK(\"x\")", relativePath: "a,b.mkv", filePath: "/l/a,b.mkv", sizeBytes: 1, allocatedBytes: null, storedPercent: null, integrity: "hollow", zeroSamples: null, zeroSamplesTotal: 24, checkedAt: null, linked: false, remoteCopyExists: false, protectedReason: null, audit: null }
    ]);
    expect(csv).toContain("\"'=HYPERLINK(\"\"x\"\")\"");
    expect(csv).toContain("\"/l/a,b.mkv\"");
  });
});
