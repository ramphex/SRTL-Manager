import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { describeFileHeader, fileHeaderFailLabel } from "../src/shared/fileHeaders";
import {
  checkFileHeader,
  checkFileHeaders,
  classifyFileHeader,
  detectHeaderContainer,
  startsWithArchive,
  headerMinimumBytes,
  headerReadBytes,
  readFileHead,
  type HeaderReader
} from "../src/server/lib/fileHeaders";
import { withFilesystemTimeout } from "../src/server/lib/filesystemSafety";

const size = 50 * 1024 * 1024;

// 64 KB that match no container: no zero runs at the signature offsets and no sync bytes where TS would have them.
function noise(length = headerReadBytes): Buffer {
  const bytes = randomBytes(length);
  for (let index = 0; index < length; index += 1) if (bytes[index] === 0 || bytes[index] === 0x47) bytes[index] = 0x5a;
  bytes.write("noise data!!", 0, "latin1");
  return bytes;
}

function withSignature(signature: Buffer | number[], offset = 0): Buffer {
  const bytes = noise();
  Buffer.from(signature).copy(bytes, offset);
  return bytes;
}

const box = (type: string, boxSize = 0x20) => {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(boxSize, 0);
  header.write(type, 4, "latin1");
  return header;
};

describe("container signatures", () => {
  it.each([
    ["Matroska", "film.mkv", withSignature([0x1a, 0x45, 0xdf, 0xa3]), "matroska"],
    ["WebM", "clip.webm", withSignature([0x1a, 0x45, 0xdf, 0xa3]), "matroska"],
    ["MP4 ftyp", "film.mp4", withSignature(Buffer.concat([box("ftyp"), Buffer.from("isom")])), "mp4"],
    ["MOV moov first", "film.mov", withSignature(box("moov")), "mp4"],
    ["M4V mdat first", "film.m4v", withSignature(box("mdat", 1)), "mp4"],
    ["free box first", "film.mp4", withSignature(box("free", 8)), "mp4"],
    ["wide box first", "film.mov", withSignature(box("wide", 8)), "mp4"],
    ["skip box first", "film.mp4", withSignature(box("skip", 0)), "mp4"],
    ["AVI", "film.avi", withSignature(Buffer.from("RIFF\x10\x20\x30\x40AVI LIST", "latin1")), "avi"],
    ["MPEG-PS", "film.mpg", withSignature([0x00, 0x00, 0x01, 0xba]), "mpeg_ps"],
    ["VOB as MPEG-PS", "VTS_01_1.vob", withSignature([0x00, 0x00, 0x01, 0xba]), "mpeg_ps"],
    ["MPEG video", "film.m2v", withSignature([0x00, 0x00, 0x01, 0xb3]), "mpeg_video"],
    ["ASF", "film.wmv", withSignature([0x30, 0x26, 0xb2, 0x75, 0x8e, 0x66, 0xcf, 0x11, 0xa6, 0xd9, 0x00, 0xaa, 0x00, 0x62, 0xce, 0x6c]), "asf"],
    ["FLV", "clip.flv", withSignature([0x46, 0x4c, 0x56, 0x01]), "flv"],
    ["Ogg", "clip.ogv", withSignature(Buffer.from("OggS")), "ogg"],
    ["RealMedia", "clip.rmvb", withSignature(Buffer.from(".RMF")), "realmedia"]
  ])("passes %s", (_label, name, head, container) => {
    expect(detectHeaderContainer(head)).toBe(container);
    expect(classifyFileHeader(`/media/${name}`, size, head)).toEqual({ status: "pass", reason: container });
  });

  it("passes MPEG-TS with sync bytes at 0 and 188, and M2TS with 192-byte packets", () => {
    const ts = noise();
    ts[0] = 0x47;
    ts[188] = 0x47;
    expect(classifyFileHeader("/media/show.ts", size, ts)).toEqual({ status: "pass", reason: "mpeg_ts" });
    const m2ts = noise();
    m2ts[4] = 0x47;
    m2ts[196] = 0x47;
    expect(classifyFileHeader("/media/00001.m2ts", size, m2ts)).toEqual({ status: "pass", reason: "m2ts" });
    const oneSync = noise();
    oneSync[0] = 0x47;
    expect(classifyFileHeader("/media/show.ts", size, oneSync)).toEqual({ status: "fail", reason: "not_video" });
  });

  it("passes a known container under the wrong extension, since it still plays", () => {
    expect(classifyFileHeader("/media/film.mp4", size, withSignature([0x1a, 0x45, 0xdf, 0xa3]))).toEqual({ status: "pass", reason: "matroska" });
  });

  it("does not take an MP4 box name with an impossible box size", () => {
    expect(detectHeaderContainer(withSignature(box("ftyp", 5)))).toBeNull();
  });
});

describe("broken files", () => {
  it("fails a file that is all zeros from byte 0", () => {
    expect(classifyFileHeader("/media/film.mkv", size, Buffer.alloc(headerReadBytes))).toEqual({ status: "fail", reason: "zeros" });
  });

  it("fails random bytes where the header should be", () => {
    expect(classifyFileHeader("/media/film.mkv", size, noise())).toEqual({ status: "fail", reason: "not_video" });
    expect(classifyFileHeader("/media/VTS_01_1.vob", size, noise())).toEqual({ status: "fail", reason: "not_video" });
  });

  it("fails a 258-byte MP4 shell on its size, even though it starts with ftyp", () => {
    const stub = Buffer.concat([box("ftyp"), Buffer.alloc(250, 0x41)]);
    expect(stub).toHaveLength(258);
    expect(classifyFileHeader("/media/film.mp4", stub.length, stub)).toEqual({ status: "fail", reason: "too_small" });
  });

  it("fails a 0-byte file", () => {
    expect(classifyFileHeader("/media/film.mkv", 0, Buffer.alloc(0))).toEqual({ status: "fail", reason: "empty" });
    expect(classifyFileHeader("/media/VIDEO_TS.IFO", 0, Buffer.alloc(0))).toEqual({ status: "fail", reason: "empty" });
  });

  it("fails anything under the minimum size without reading", async () => {
    let reads = 0;
    const reader: HeaderReader = async () => {
      reads += 1;
      return { head: withSignature([0x1a, 0x45, 0xdf, 0xa3]), sizeBytes: headerMinimumBytes - 1 };
    };
    await expect(checkFileHeader({ filePath: "/media/film.mkv", sizeBytes: headerMinimumBytes - 1, mtimeMs: 1 }, { reader })).resolves.toMatchObject({ status: "fail", reason: "too_small" });
    expect(reads).toBe(0);
  });

  it("tells an archive that was never unpacked apart from other non-video files", () => {
    const rar4 = [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00];
    const rar5 = [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00];
    const sevenZip = [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c];
    const zip = [0x50, 0x4b, 0x03, 0x04];
    for (const signature of [rar4, rar5, sevenZip, zip]) {
      expect(startsWithArchive(withSignature(signature))).toBe(true);
      expect(classifyFileHeader("/media/film.mkv", size, withSignature(signature))).toEqual({ status: "fail", reason: "archive" });
      // An archive named like a disc image is still an archive, not an unrecognised image.
      expect(classifyFileHeader("/media/disc.iso", size, withSignature(signature))).toEqual({ status: "fail", reason: "archive" });
    }
    // Near misses are not archives: a different RAR byte, a ZIP end record, and a signature that is not at byte 0.
    for (const bytes of [withSignature([0x52, 0x61, 0x72, 0x21, 0x1a, 0x08]), withSignature([0x50, 0x4b, 0x05, 0x06]), withSignature(zip, 1)]) {
      expect(startsWithArchive(bytes)).toBe(false);
      expect(classifyFileHeader("/media/film.mkv", size, bytes)).toEqual({ status: "fail", reason: "not_video" });
    }
    // A video container still wins, and a tiny archive fails on its size before its bytes are looked at.
    expect(classifyFileHeader("/media/film.mkv", size, withSignature([0x1a, 0x45, 0xdf, 0xa3]))).toEqual({ status: "pass", reason: "matroska" });
    expect(classifyFileHeader("/media/film.mkv", 4096, withSignature(rar5).subarray(0, 4096))).toEqual({ status: "fail", reason: "too_small" });
  });

  it("gives every failure a plain reason for Damaged files", () => {
    expect(fileHeaderFailLabel("not_video")).toBe("Not a video file: the start of the file isn't any known video format");
    expect(fileHeaderFailLabel("zeros")).toBe("Starts with zeros: no video data");
    expect(fileHeaderFailLabel("too_small")).toBe("Too small to be a video");
    expect(fileHeaderFailLabel("archive")).toBe("Archive, not a video: the download was never unpacked");
    expect(fileHeaderFailLabel("empty")).toBe("Empty file: 0 bytes");
    expect(fileHeaderFailLabel("something new")).toBe("Not a video file");
    expect(fileHeaderFailLabel(null)).toBe("Not a video file");
  });

  it("describes every verdict in plain words", () => {
    expect(describeFileHeader({ status: "pass", reason: "matroska" })).toBe("Header check passed (Matroska/WebM)");
    expect(describeFileHeader({ status: "fail", reason: "zeros" })).toBe("Header check failed: the file starts with zeros, so it holds no video data");
    expect(describeFileHeader({ status: "fail", reason: "not_video" })).toBe("Header check failed: not a valid video file: no known container header");
    expect(describeFileHeader({ status: "fail", reason: "archive" })).toBe("Header check failed: an archive, not a video: the download was never unpacked");
    expect(describeFileHeader({ status: "retry", reason: "timed out" })).toBe("Header check could not run (timed out); it will be tried again");
  });
});

describe("disc images and DVD files", () => {
  it("passes ISO 9660 and UDF images by their volume descriptors", () => {
    const iso = withSignature(Buffer.from("CD001"), 0x8001);
    expect(classifyFileHeader("/media/disc.iso", size, iso)).toEqual({ status: "pass", reason: "disc_image" });
    const udf = withSignature(Buffer.from("BEA01"), 0x8001);
    Buffer.from("NSR03").copy(udf, 0x8801);
    expect(classifyFileHeader("/media/disc.iso", size, udf)).toEqual({ status: "pass", reason: "disc_image" });
    expect(classifyFileHeader("/media/disc.img", size, iso)).toEqual({ status: "pass", reason: "disc_image" });
  });

  it("skips an image it cannot recognise instead of failing it, but fails one that is all zeros", () => {
    expect(classifyFileHeader("/media/disc.iso", size, noise())).toEqual({ status: "skipped", reason: null });
    expect(classifyFileHeader("/media/disc.img", size, noise())).toEqual({ status: "skipped", reason: null });
    expect(classifyFileHeader("/media/disc.iso", size, Buffer.alloc(headerReadBytes))).toEqual({ status: "fail", reason: "zeros" });
  });

  it("lets small DVD menu files through the size rule", () => {
    const ifo = Buffer.concat([Buffer.from("DVDVIDEO-VTS"), Buffer.alloc(4000, 0x11)]);
    expect(classifyFileHeader("/media/VTS_01_0.IFO", ifo.length, ifo)).toEqual({ status: "pass", reason: "dvd_ifo" });
    expect(classifyFileHeader("/media/VTS_01_0.BUP", 4000, noise(4000))).toEqual({ status: "skipped", reason: null });
  });
});

describe("reading files", () => {
  let tmpDir: string;
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "srtl-header-"));
  });
  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function write(name: string, content: Buffer, totalSize = content.length): Promise<{ filePath: string; sizeBytes: number; mtimeMs: number }> {
    const filePath = path.join(tmpDir, name);
    await fs.writeFile(filePath, content);
    if (totalSize > content.length) await fs.truncate(filePath, totalSize);
    const stat = await fs.stat(filePath);
    return { filePath, sizeBytes: stat.size, mtimeMs: Math.trunc(stat.mtimeMs) };
  }

  it("reads only the first 64 KB of a real file and judges it", async () => {
    const good = await write("Example Film (2020).mkv", withSignature([0x1a, 0x45, 0xdf, 0xa3]), 2 * 1024 * 1024);
    await expect(checkFileHeader(good)).resolves.toMatchObject({ status: "pass", reason: "matroska", checkedSizeBytes: good.sizeBytes, checkedMtimeMs: good.mtimeMs });
    const read = await readFileHead(good.filePath, headerReadBytes, 5_000);
    expect(read.head).toHaveLength(headerReadBytes);
    expect(read.sizeBytes).toBe(2 * 1024 * 1024);
    const zeros = await write("Zero Film (2021).mkv", Buffer.alloc(0), 2 * 1024 * 1024);
    await expect(checkFileHeader(zeros)).resolves.toMatchObject({ status: "fail", reason: "zeros" });
  });

  it("turns a timeout into retry, never a failure", async () => {
    const stalled: HeaderReader = (filePath, _length, timeoutMs) => withFilesystemTimeout(new Promise<never>(() => undefined), `Reading the header of ${filePath}`, timeoutMs);
    const started = Date.now();
    await expect(checkFileHeader({ filePath: "/media/stalled.mkv", sizeBytes: size, mtimeMs: 1 }, { reader: stalled, timeoutMs: 30 })).resolves.toEqual({
      status: "retry",
      reason: "timed out",
      checkedSizeBytes: size,
      checkedMtimeMs: 1
    });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("turns read errors and a changed size into retry", async () => {
    await expect(checkFileHeader({ filePath: path.join(tmpDir, "missing.mkv"), sizeBytes: size, mtimeMs: 1 })).resolves.toMatchObject({ status: "retry", reason: "ENOENT" });
    const grown = await write("Grown Film (2022).mkv", withSignature([0x1a, 0x45, 0xdf, 0xa3]), 2 * 1024 * 1024);
    await expect(checkFileHeader({ ...grown, sizeBytes: grown.sizeBytes - 1 })).resolves.toMatchObject({ status: "retry", reason: "changed since the last scan" });
    const short: HeaderReader = async () => ({ head: Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), sizeBytes: size });
    await expect(checkFileHeader({ filePath: "/media/short.mkv", sizeBytes: size, mtimeMs: 1 }, { reader: short })).resolves.toMatchObject({ status: "retry", reason: "short read" });
  });

  it("checks each file once when more workers than files wait on the cancel check", async () => {
    const reader: HeaderReader = async () => ({ head: withSignature([0x1a, 0x45, 0xdf, 0xa3]), sizeBytes: size });
    const targets = Array.from({ length: 3 }, (_unused, index) => ({ filePath: `/media/${index}.mkv`, sizeBytes: size, mtimeMs: 1 }));
    const results = await checkFileHeaders(targets, { reader, concurrency: 4, isCancelled: async () => false });
    expect(results.map(({ target }) => target.filePath).sort()).toEqual(["/media/0.mkv", "/media/1.mkv", "/media/2.mkv"]);
  });

  it("stops starting new files when the time budget runs out, keeping order", async () => {
    let clock = 0;
    const reader: HeaderReader = async () => {
      clock += 10;
      return { head: withSignature([0x1a, 0x45, 0xdf, 0xa3]), sizeBytes: size };
    };
    const targets = Array.from({ length: 10 }, (_unused, index) => ({ filePath: `/media/${index}.mkv`, sizeBytes: size, mtimeMs: 1 }));
    const results = await checkFileHeaders(targets, { reader, concurrency: 1, deadlineMs: 30, now: () => clock });
    expect(results.map(({ target }) => target.filePath)).toEqual(["/media/0.mkv", "/media/1.mkv", "/media/2.mkv"]);
  });
});
