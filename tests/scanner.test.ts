import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openTestDatabase } from "./testDb";
import * as schema from "../src/server/db/schema";
import { getInventorySummary, getStoragePolicyMap, listMediaLinks, listMediaLinkTree, listStorageFileTree, listStorageFiles, persistScanResult, scanLibrary, type ScanActivity } from "../src/server/lib/scanner";
import { listStoragePolicyCandidates, setStoragePolicyTitle } from "../src/server/lib/storagePolicies";

let tmpDir: string;

describe("scanner", () => {
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "srtl-scan-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("classifies local, remote, broken, and non-media links without mutating files", async () => {
    const symlinkDir = path.join(tmpDir, "plex");
    const localDir = path.join(tmpDir, "local");
    const remoteDir = path.join(tmpDir, "remote");
    await fs.mkdir(path.join(symlinkDir, "movies", "Remote Movie"), { recursive: true });
    await fs.mkdir(path.join(symlinkDir, "movies", "Local Movie"), { recursive: true });
    await fs.mkdir(path.join(symlinkDir, "movies", "Broken Movie"), { recursive: true });
    await fs.mkdir(path.join(symlinkDir, "movies", "Metadata"), { recursive: true });
    await fs.mkdir(path.join(localDir, "movies", "Local Movie"), { recursive: true });
    await fs.mkdir(path.join(localDir, "movies", "Orphan Local"), { recursive: true });
    await fs.mkdir(path.join(remoteDir, "movies", "Remote Movie"), { recursive: true });
    await fs.mkdir(path.join(remoteDir, "movies", "Orphan Remote"), { recursive: true });

    const remoteTarget = path.join(remoteDir, "movies", "Remote Movie", "remote.mkv");
    const localTarget = path.join(localDir, "movies", "Local Movie", "local.mkv");
    const localOrphan = path.join(localDir, "movies", "Orphan Local", "orphan-local.mkv");
    const remoteOrphan = path.join(remoteDir, "movies", "Orphan Remote", "orphan-remote.mkv");
    await fs.writeFile(remoteTarget, "remote");
    await fs.writeFile(localTarget, "local");
    await fs.writeFile(localOrphan, "orphan-local");
    await fs.writeFile(remoteOrphan, "orphan-remote");
    await fs.symlink(remoteTarget, path.join(symlinkDir, "movies", "Remote Movie", "remote.mkv"));
    await fs.symlink(localTarget, path.join(symlinkDir, "movies", "Local Movie", "local.mkv"));
    await fs.symlink(path.join(remoteDir, "missing.mkv"), path.join(symlinkDir, "movies", "Broken Movie", "missing.mkv"));
    await fs.symlink(path.join(remoteDir, "poster.jpg"), path.join(symlinkDir, "movies", "Metadata", "poster.jpg"));

    const result = await scanLibrary(
      { symlinkDir, localDir, remoteDir },
      { sections: ["movies"], sectionTitles: { movies: "Movie Library" }, sectionTypes: { movies: "movies" } },
      new Map([["remote movie", "location_2"]]),
      { scanSymlinks: true, scanLocal: true, scanRemote: true }
    );
    const kinds = Object.fromEntries(result.links.map((link) => [link.itemName, link.kind]));

    expect(kinds).toMatchObject({
      "Remote Movie": "remote",
      "Local Movie": "local",
      "Broken Movie": "broken",
      Metadata: "non_media"
    });
    expect(result.summaries[0]).toMatchObject({
      title: "Movie Library",
      type: "movies",
      totalLinks: 4,
      itemCount: 3,
      seasonCount: 0,
      episodeCount: 3,
      remoteLinks: 1,
      localLinks: 1,
      brokenLinks: 1,
      nonMediaLinks: 1,
      actionableRemoteLinks: 0,
      assignedRemoteLinks: 1
    });
    expect(result.inventory).toMatchObject({
      localFiles: 2,
      remoteFiles: 2,
      localOrphanFiles: 1,
      remoteOrphanFiles: 1
    });
    await expect(fs.readFile(remoteTarget, "utf8")).resolves.toBe("remote");
  });

  it("reports live symlink discovery and target-checking activity", async () => {
    const symlinkDir = path.join(tmpDir, "links");
    const localDir = path.join(tmpDir, "local");
    const remoteDir = path.join(tmpDir, "remote");
    const titleDir = path.join(symlinkDir, "movies", "Example Title");
    const targetDir = path.join(localDir, "movies", "Example Title");
    await fs.mkdir(titleDir, { recursive: true });
    await fs.mkdir(targetDir, { recursive: true });
    await fs.mkdir(remoteDir, { recursive: true });
    const firstTarget = path.join(targetDir, "first.mkv");
    const secondTarget = path.join(targetDir, "second.mkv");
    await fs.writeFile(firstTarget, "first");
    await fs.writeFile(secondTarget, "second");
    await fs.symlink(firstTarget, path.join(titleDir, "first.mkv"));
    await fs.symlink(secondTarget, path.join(titleDir, "second.mkv"));
    const updates: ScanActivity[] = [];

    await scanLibrary(
      { symlinkDir, localDir, remoteDir },
      { sections: ["movies"], sectionTitles: { movies: "Movie Library" } },
      new Map(),
      { scanSymlinks: true, scanLocal: false, scanRemote: false },
      undefined,
      async (activity) => {
        updates.push(activity);
      }
    );

    expect(updates.some((update) => update.phase === "discovering_symlinks" && update.currentSection === "movies")).toBe(true);
    expect(updates.at(-1)).toMatchObject({
      phase: "checking_symlinks",
      discoveredLinks: 2,
      checkedLinks: 2,
      completedWorkUnits: 1,
      totalWorkUnits: 1,
      message: "Finished checking Movie Library"
    });
  });

  it("refreshes a scan root when a discovered symlink is replaced before target checking", async () => {
    const symlinkDir = path.join(tmpDir, "plex");
    const localDir = path.join(tmpDir, "local");
    const remoteDir = path.join(tmpDir, "remote");
    const titleDir = path.join(symlinkDir, "shows", "Example Show", "Season 01");
    await fs.mkdir(titleDir, { recursive: true });
    await fs.mkdir(localDir, { recursive: true });
    await fs.mkdir(remoteDir, { recursive: true });

    const oldTarget = path.join(remoteDir, "episode-720p.mkv");
    const newTarget = path.join(remoteDir, "episode-1080p.mkv");
    const oldLink = path.join(titleDir, "episode-720p.mkv");
    const newLink = path.join(titleDir, "episode-1080p.mkv");
    await fs.writeFile(oldTarget, "old");
    await fs.writeFile(newTarget, "new");
    await fs.symlink(oldTarget, oldLink);
    let replaced = false;

    const result = await scanLibrary(
      { symlinkDir, localDir, remoteDir },
      { sections: ["shows"], sectionTypes: { shows: "shows" } },
      new Map(),
      { scanSymlinks: true, scanLocal: false, scanRemote: false },
      undefined,
      async (activity) => {
        if (replaced || activity.phase !== "checking_symlinks") return;
        replaced = true;
        await fs.rm(oldLink);
        await fs.symlink(newTarget, newLink);
      }
    );

    expect(replaced).toBe(true);
    expect(result.links).toEqual([
      expect.objectContaining({
        linkPath: newLink,
        targetPath: newTarget,
        kind: "remote",
        targetExists: true
      })
    ]);
    expect(result.inventory).toMatchObject({ totalLinks: 1, remoteLinks: 1, brokenLinks: 0 });
  });

  it("continues when a nested symlink directory disappears during discovery", async () => {
    const symlinkDir = path.join(tmpDir, "plex");
    const localDir = path.join(tmpDir, "local");
    const remoteDir = path.join(tmpDir, "remote");
    const titleDir = path.join(symlinkDir, "movies", "Removed Movie");
    await fs.mkdir(titleDir, { recursive: true });
    await fs.mkdir(localDir, { recursive: true });
    await fs.mkdir(remoteDir, { recursive: true });
    await fs.symlink(path.join(remoteDir, "movie.mkv"), path.join(titleDir, "movie.mkv"));

    const realReaddir = fs.readdir.bind(fs);
    let removed = false;
    const readdirSpy = vi.spyOn(fs, "readdir").mockImplementation((async (directory: unknown, options: unknown) => {
      if (!removed && String(directory) === titleDir) {
        removed = true;
        await fs.rm(titleDir, { recursive: true });
      }
      return realReaddir(directory as never, options as never);
    }) as typeof fs.readdir);

    try {
      const result = await scanLibrary(
        { symlinkDir, localDir, remoteDir },
        { sections: ["movies"] },
        new Map(),
        { scanSymlinks: true, scanLocal: false, scanRemote: false }
      );

      expect(removed).toBe(true);
      expect(result.links).toEqual([]);
      expect(result.inventory.totalLinks).toBe(0);
    } finally {
      readdirSpy.mockRestore();
    }
  });

  it("still fails a scan for non-transient symlink read errors", async () => {
    const symlinkDir = path.join(tmpDir, "plex");
    const localDir = path.join(tmpDir, "local");
    const remoteDir = path.join(tmpDir, "remote");
    const titleDir = path.join(symlinkDir, "movies", "Unreadable Movie");
    await fs.mkdir(titleDir, { recursive: true });
    await fs.mkdir(localDir, { recursive: true });
    await fs.mkdir(remoteDir, { recursive: true });

    const targetPath = path.join(remoteDir, "movie.mkv");
    const linkPath = path.join(titleDir, "movie.mkv");
    await fs.writeFile(targetPath, "movie");
    await fs.symlink(targetPath, linkPath);
    const realReadlink = fs.readlink.bind(fs);
    const readlinkSpy = vi.spyOn(fs, "readlink").mockImplementation((async (candidate: unknown, options?: unknown) => {
      if (String(candidate) === linkPath) throw Object.assign(new Error("permission denied"), { code: "EACCES" });
      return realReadlink(candidate as never, options as never);
    }) as typeof fs.readlink);

    try {
      await expect(
        scanLibrary(
          { symlinkDir, localDir, remoteDir },
          { sections: ["movies"] },
          new Map(),
          { scanSymlinks: true, scanLocal: false, scanRemote: false }
        )
      ).rejects.toMatchObject({ code: "EACCES" });
    } finally {
      readlinkSpy.mockRestore();
    }
  });

  it("marks disappeared symlinks and storage files missing instead of deleting rows", async () => {
    const symlinkDir = path.join(tmpDir, "plex");
    const localDir = path.join(tmpDir, "local");
    const remoteDir = path.join(tmpDir, "remote");
    await fs.mkdir(path.join(symlinkDir, "movies", "Local Movie"), { recursive: true });
    await fs.mkdir(path.join(localDir, "movies", "Local Movie"), { recursive: true });
    await fs.mkdir(remoteDir, { recursive: true });

    const localTarget = path.join(localDir, "movies", "Local Movie", "local.mkv");
    const linkPath = path.join(symlinkDir, "movies", "Local Movie", "local.mkv");
    await fs.writeFile(localTarget, "local");
    await fs.symlink(localTarget, linkPath);

    const database = await openTestDatabase();
    try {
      const firstScan = await scanLibrary({ symlinkDir, localDir, remoteDir }, { sections: ["movies"] }, new Map(), { scanSymlinks: true, scanLocal: true, scanRemote: true });
      await persistScanResult(database.db, firstScan, 1);
      expect(await listMediaLinks(database.db)).toHaveLength(1);
      expect(await listStorageFiles(database.db, "local", true)).toHaveLength(0);

      await fs.rm(linkPath);
      await fs.rm(localTarget);

      const secondScan = await scanLibrary({ symlinkDir, localDir, remoteDir }, { sections: ["movies"] }, new Map(), { scanSymlinks: true, scanLocal: true, scanRemote: true });
      await persistScanResult(database.db, secondScan, 2);

      expect(await listMediaLinks(database.db)).toHaveLength(0);
      expect(await listMediaLinks(database.db, undefined, "missing")).toMatchObject([{ linkPath, missingSince: expect.any(String) }]);
      expect(await listStorageFiles(database.db)).toHaveLength(0);
      expect(await listStorageFiles(database.db, "local", false, "missing")).toMatchObject([{ filePath: localTarget, missingSince: expect.any(String) }]);
    } finally {
      await database.close();
    }
  });

  it("keeps titles unassigned when a scan is not the configured onboarding scan", async () => {
    const symlinkDir = path.join(tmpDir, "plex");
    const localDir = path.join(tmpDir, "local");
    const remoteDir = path.join(tmpDir, "remote");
    await fs.mkdir(path.join(symlinkDir, "shows", "Mixed Show", "Season 01"), { recursive: true });
    await fs.mkdir(path.join(localDir, "shows", "Mixed Show", "Season 01"), { recursive: true });
    await fs.mkdir(path.join(remoteDir, "shows", "Mixed Show", "Season 01"), { recursive: true });

    const localEpisode = path.join(localDir, "shows", "Mixed Show", "Season 01", "episode-1.mkv");
    const remoteEpisode = path.join(remoteDir, "shows", "Mixed Show", "Season 01", "episode-2.mkv");
    await fs.writeFile(localEpisode, "local");
    await fs.writeFile(remoteEpisode, "remote");
    await fs.symlink(localEpisode, path.join(symlinkDir, "shows", "Mixed Show", "Season 01", "episode-1.mkv"));
    await fs.symlink(remoteEpisode, path.join(symlinkDir, "shows", "Mixed Show", "Season 01", "episode-2.mkv"));

    const database = await openTestDatabase();
    try {
      const scan = await scanLibrary(
        { symlinkDir, localDir, remoteDir },
        { sections: ["shows"], sectionTypes: { shows: "shows" } },
        new Map(),
        { scanSymlinks: true, scanLocal: false, scanRemote: false }
      );
      const summary = await persistScanResult(database.db, scan, 1);

      expect(summary).toMatchObject({ localLinks: 1, remoteLinks: 1, actionableRemoteLinks: 0, unassignedLocalLinks: 1, unassignedRemoteLinks: 1 });
      expect((await listMediaLinks(database.db, undefined, "current")).map((link) => [link.relativePath, link.storagePolicy]).sort()).toEqual([
        [path.join("Mixed Show", "Season 01", "episode-1.mkv"), "unassigned"],
        [path.join("Mixed Show", "Season 01", "episode-2.mkv"), "unassigned"]
      ]);
      expect(await database.db.select().from(schema.storagePolicies)).toEqual([]);
    } finally {
      await database.close();
    }
  });

  it("rolls back partial inventory writes when indexing is cancelled", async () => {
    const symlinkDir = path.join(tmpDir, "symlinks");
    const localDir = path.join(tmpDir, "local");
    const remoteDir = path.join(tmpDir, "remote");
    await fs.mkdir(path.join(symlinkDir, "items", "First"), { recursive: true });
    await fs.mkdir(path.join(symlinkDir, "items", "Second"), { recursive: true });
    await fs.mkdir(path.join(remoteDir, "items", "First"), { recursive: true });
    await fs.mkdir(path.join(remoteDir, "items", "Second"), { recursive: true });
    await fs.mkdir(localDir, { recursive: true });
    const firstTarget = path.join(remoteDir, "items", "First", "first.mkv");
    const secondTarget = path.join(remoteDir, "items", "Second", "second.mkv");
    await fs.writeFile(firstTarget, "first");
    await fs.writeFile(secondTarget, "second");
    await fs.symlink(firstTarget, path.join(symlinkDir, "items", "First", "first.mkv"));
    await fs.symlink(secondTarget, path.join(symlinkDir, "items", "Second", "second.mkv"));
    const result = await scanLibrary(
      { symlinkDir, localDir, remoteDir },
      { sections: ["items"] },
      new Map(),
      { scanSymlinks: true, scanLocal: false, scanRemote: false }
    );
    const database = await openTestDatabase();
    let checks = 0;
    try {
      await expect(
        database.db.transaction((transaction) =>
          persistScanResult(transaction, result, 1, async () => {
            checks += 1;
            return checks >= 3;
          })
        )
      ).rejects.toThrow("Scan indexing was cancelled");
      expect(await database.db.select().from(schema.mediaLinks)).toEqual([]);
      expect(await database.db.select().from(schema.sections)).toEqual([]);
    } finally {
      await database.close();
    }
  });

  it("runs symlink-only scans without walking local or remote storage roots", async () => {
    const symlinkDir = path.join(tmpDir, "plex");
    const localDir = path.join(tmpDir, "local-not-mounted");
    const remoteDir = path.join(tmpDir, "remote-not-mounted");
    await fs.mkdir(path.join(symlinkDir, "movies", "Remote Movie"), { recursive: true });
    await fs.symlink(path.join(remoteDir, "movies", "Remote Movie", "remote.mkv"), path.join(symlinkDir, "movies", "Remote Movie", "remote.mkv"));

    const result = await scanLibrary({ symlinkDir, localDir, remoteDir }, { sections: ["movies"] }, new Map());

    expect(result.links).toHaveLength(1);
    expect(result.links[0]).toMatchObject({ kind: "broken", targetExists: false });
    expect(result.summaries[0]).toMatchObject({ totalLinks: 1, brokenLinks: 1, remoteLinks: 0 });
    expect(result.storageFiles).toHaveLength(0);
    expect(result.options).toEqual({ scanSymlinks: true, scanLocal: false, scanRemote: false });
  });

  it("preserves unscanned storage scopes during scoped inventory updates", async () => {
    const symlinkDir = path.join(tmpDir, "plex");
    const localDir = path.join(tmpDir, "local");
    const remoteDir = path.join(tmpDir, "remote");
    await fs.mkdir(path.join(symlinkDir, "movies"), { recursive: true });
    await fs.mkdir(path.join(localDir, "movies"), { recursive: true });
    await fs.mkdir(path.join(remoteDir, "movies"), { recursive: true });
    const localFile = path.join(localDir, "movies", "local.mkv");
    const remoteFile = path.join(remoteDir, "movies", "remote.mkv");
    await fs.writeFile(localFile, "local");
    await fs.writeFile(remoteFile, "remote");

    const database = await openTestDatabase();
    try {
      const fullScan = await scanLibrary({ symlinkDir, localDir, remoteDir }, { sections: ["movies"] }, new Map(), { scanSymlinks: true, scanLocal: true, scanRemote: true });
      await persistScanResult(database.db, fullScan, 1);
      expect(await listStorageFiles(database.db, "remote")).toHaveLength(1);

      await fs.rm(remoteFile);
      const localOnlyScan = await scanLibrary({ symlinkDir, localDir, remoteDir }, { sections: ["movies"] }, new Map(), { scanSymlinks: false, scanLocal: true, scanRemote: false });
      await persistScanResult(database.db, localOnlyScan, 2);

      expect(await listStorageFiles(database.db, "remote")).toMatchObject([{ filePath: remoteFile, missingSince: null }]);
    } finally {
      await database.close();
    }
  });

  it("does not report already-linked files as orphans during a storage-only rescan", async () => {
    const symlinkDir = path.join(tmpDir, "plex");
    const localDir = path.join(tmpDir, "local");
    const remoteDir = path.join(tmpDir, "remote");
    const targetPath = path.join(localDir, "movies", "Linked Movie", "linked.mkv");
    const linkPath = path.join(symlinkDir, "movies", "Linked Movie", "linked.mkv");
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.mkdir(path.dirname(linkPath), { recursive: true });
    await fs.mkdir(remoteDir, { recursive: true });
    await fs.writeFile(targetPath, "linked");
    await fs.symlink(targetPath, linkPath);

    const database = await openTestDatabase();
    try {
      const initial = await scanLibrary({ symlinkDir, localDir, remoteDir }, { sections: ["movies"] }, new Map(), {
        scanSymlinks: true,
        scanLocal: true,
        scanRemote: false
      });
      await persistScanResult(database.db, initial, 1);

      const localOnly = await scanLibrary({ symlinkDir, localDir, remoteDir }, { sections: ["movies"] }, new Map(), {
        scanSymlinks: false,
        scanLocal: true,
        scanRemote: false,
        localSections: ["movies"]
      });
      const summary = await persistScanResult(database.db, localOnly, 2);

      expect(summary).toMatchObject({ localFiles: 1, localOrphanFiles: 0, remoteFiles: 0, remoteOrphanFiles: 0 });
    } finally {
      await database.close();
    }
  });

  it("reports paths newly missing from the selected scan scope", async () => {
    const symlinkDir = path.join(tmpDir, "plex");
    const localDir = path.join(tmpDir, "local");
    const remoteDir = path.join(tmpDir, "remote");
    const targetPath = path.join(localDir, "movies", "Missing Movie", "missing.mkv");
    const linkPath = path.join(symlinkDir, "movies", "Missing Movie", "missing.mkv");
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.mkdir(path.dirname(linkPath), { recursive: true });
    await fs.mkdir(remoteDir, { recursive: true });
    await fs.writeFile(targetPath, "missing");
    await fs.symlink(targetPath, linkPath);

    const database = await openTestDatabase();
    try {
      const initial = await scanLibrary({ symlinkDir, localDir, remoteDir }, { sections: ["movies"] }, new Map(), {
        scanSymlinks: true,
        scanLocal: true,
        scanRemote: false
      });
      await persistScanResult(database.db, initial, 1);

      await fs.rm(linkPath);
      await fs.rm(targetPath);
      const rescan = await scanLibrary({ symlinkDir, localDir, remoteDir }, { sections: ["movies"] }, new Map(), {
        scanSymlinks: true,
        scanLocal: true,
        scanRemote: false,
        symlinkSections: ["movies"],
        localSections: ["movies"]
      });
      const summary = await persistScanResult(database.db, rescan, 2);

      expect(summary).toMatchObject({ missingLinks: 1, missingLocalFiles: 1, missingRemoteFiles: 0 });
    } finally {
      await database.close();
    }
  });

  it("preserves unselected section links and storage files during section-scoped scans", async () => {
    const symlinkDir = path.join(tmpDir, "plex");
    const localDir = path.join(tmpDir, "local");
    const remoteDir = path.join(tmpDir, "remote");
    await fs.mkdir(path.join(symlinkDir, "movies", "Movie One"), { recursive: true });
    await fs.mkdir(path.join(symlinkDir, "shows", "Show One"), { recursive: true });
    await fs.mkdir(path.join(localDir, "movies", "Movie One"), { recursive: true });
    await fs.mkdir(path.join(localDir, "shows", "Show One"), { recursive: true });
    await fs.mkdir(remoteDir, { recursive: true });

    const movieFile = path.join(localDir, "movies", "Movie One", "movie.mkv");
    const showFile = path.join(localDir, "shows", "Show One", "show.mkv");
    const movieLink = path.join(symlinkDir, "movies", "Movie One", "movie.mkv");
    const showLink = path.join(symlinkDir, "shows", "Show One", "show.mkv");
    await fs.writeFile(movieFile, "movie");
    await fs.writeFile(showFile, "show");
    await fs.symlink(movieFile, movieLink);
    await fs.symlink(showFile, showLink);

    const database = await openTestDatabase();
    try {
      const settings = { sections: ["movies", "shows"] };
      const fullScan = await scanLibrary({ symlinkDir, localDir, remoteDir }, settings, new Map(), { scanSymlinks: true, scanLocal: true, scanRemote: false });
      await persistScanResult(database.db, fullScan, 1);
      expect(await listMediaLinks(database.db)).toHaveLength(2);
      expect(await listStorageFiles(database.db, "local")).toHaveLength(2);

      await fs.rm(showLink);
      await fs.rm(showFile);

      const movieOnlyScan = await scanLibrary({ symlinkDir, localDir, remoteDir }, settings, new Map(), {
        scanSymlinks: true,
        scanLocal: true,
        scanRemote: false,
        sections: ["movies"]
      });
      await persistScanResult(database.db, movieOnlyScan, 2);

      expect(movieOnlyScan.links.map((link) => link.section)).toEqual(["movies"]);
      expect(movieOnlyScan.storageFiles.map((file) => file.relativePath)).toEqual([path.join("movies", "Movie One", "movie.mkv")]);
      expect((await listMediaLinks(database.db)).map((link) => link.linkPath).sort()).toEqual([movieLink, showLink].sort());
      expect(await listMediaLinks(database.db, undefined, "missing")).toHaveLength(0);
      expect((await listStorageFiles(database.db, "local")).map((file) => file.filePath).sort()).toEqual([movieFile, showFile].sort());
      expect(await listStorageFiles(database.db, "local", false, "missing")).toHaveLength(0);
    } finally {
      await database.close();
    }
  });

  it("persists disjoint per-folder symlink scans concurrently without invalidating sibling sections", async () => {
    const symlinkDir = path.join(tmpDir, "plex");
    const localDir = path.join(tmpDir, "local");
    const remoteDir = path.join(tmpDir, "remote");
    const movieTarget = path.join(remoteDir, "movies", "Movie One", "movie.mkv");
    const showTarget = path.join(remoteDir, "shows", "Show One", "show.mkv");
    const movieLink = path.join(symlinkDir, "movies", "Movie One", "movie.mkv");
    const showLink = path.join(symlinkDir, "shows", "Show One", "show.mkv");
    await Promise.all([
      fs.mkdir(path.dirname(movieTarget), { recursive: true }),
      fs.mkdir(path.dirname(showTarget), { recursive: true }),
      fs.mkdir(path.dirname(movieLink), { recursive: true }),
      fs.mkdir(path.dirname(showLink), { recursive: true }),
      fs.mkdir(localDir, { recursive: true })
    ]);
    await Promise.all([fs.writeFile(movieTarget, "movie"), fs.writeFile(showTarget, "show")]);
    await Promise.all([fs.symlink(movieTarget, movieLink), fs.symlink(showTarget, showLink)]);

    const settings = {
      sections: ["movies", "shows"],
      sectionTypes: { movies: "movies" as const, shows: "shows" as const }
    };
    const policies = new Map([
      ["movie one", "location_1" as const],
      ["show one", "location_2" as const]
    ]);
    const database = await openTestDatabase();
    try {
      const initial = await scanLibrary(
        { symlinkDir, localDir, remoteDir },
        settings,
        policies,
        { scanSymlinks: true, scanLocal: false, scanRemote: true }
      );
      await persistScanResult(database.db, initial, 1);

      const [movieScan, showScan] = await Promise.all(
        ["movies", "shows"].map((section) =>
          scanLibrary(
            { symlinkDir, localDir, remoteDir },
            settings,
            policies,
            { scanSymlinks: true, scanLocal: false, scanRemote: false, symlinkSections: [section] }
          )
        )
      );
      await Promise.all([persistScanResult(database.db, movieScan, 2), persistScanResult(database.db, showScan, 3)]);

      const links = await listMediaLinks(database.db);
      expect(links.map((link) => [link.linkPath, link.missingSince, link.resolvedStorageFileId == null]).sort()).toEqual(
        [
          [movieLink, null, false],
          [showLink, null, false]
        ].sort()
      );
      expect((await listStorageFiles(database.db, "remote")).map((file) => [file.filePath, file.storagePolicy]).sort()).toEqual(
        [
          [movieTarget, "location_1"],
          [showTarget, "location_2"]
        ].sort()
      );
      expect(await listMediaLinks(database.db, undefined, "missing")).toHaveLength(0);
    } finally {
      await database.close();
    }
  });

  it("reconciles only the selected title during a targeted symlink rescan", async () => {
    const symlinkDir = path.join(tmpDir, "plex");
    const localDir = path.join(tmpDir, "local");
    const remoteDir = path.join(tmpDir, "remote");
    const firstTitleRoot = path.join(symlinkDir, "shows", "First Title", "Season 01");
    const secondTitleRoot = path.join(symlinkDir, "shows", "Second Title", "Season 01");
    await fs.mkdir(firstTitleRoot, { recursive: true });
    await fs.mkdir(secondTitleRoot, { recursive: true });
    await fs.mkdir(remoteDir, { recursive: true });

    const oldFirstLink = path.join(firstTitleRoot, "old-episode.mkv");
    const newFirstLink = path.join(firstTitleRoot, "new-episode.mkv");
    const secondLink = path.join(secondTitleRoot, "episode.mkv");
    const oldFirstTarget = path.join(remoteDir, "first-old.mkv");
    const newFirstTarget = path.join(remoteDir, "first-new.mkv");
    const secondTarget = path.join(remoteDir, "second.mkv");
    await fs.writeFile(oldFirstTarget, "old");
    await fs.writeFile(newFirstTarget, "new");
    await fs.writeFile(secondTarget, "second");
    await fs.symlink(oldFirstTarget, oldFirstLink);
    await fs.symlink(secondTarget, secondLink);

    const settings = { sections: ["shows"], sectionTypes: { shows: "shows" as const } };
    const database = await openTestDatabase();
    try {
      const initialScan = await scanLibrary(
        { symlinkDir, localDir, remoteDir },
        settings,
        new Map(),
        { scanSymlinks: true, scanLocal: false, scanRemote: false, symlinkSections: ["shows"] }
      );
      await persistScanResult(database.db, initialScan, 1);

      await fs.rm(oldFirstLink);
      await fs.symlink(newFirstTarget, newFirstLink);

      const titleRescan = await scanLibrary(
        { symlinkDir, localDir, remoteDir },
        settings,
        new Map(),
        {
          scanSymlinks: true,
          scanLocal: false,
          scanRemote: false,
          symlinkSections: ["shows"],
          titleScopes: [{ section: "shows", itemName: "First Title" }]
        }
      );
      const summary = await persistScanResult(database.db, titleRescan, 2);

      expect(titleRescan.links.map((link) => link.linkPath)).toEqual([newFirstLink]);
      expect(titleRescan.reconciledStorageFiles).toEqual([
        expect.objectContaining({
          rootType: "remote",
          section: "shows",
          itemName: "First Title",
          filePath: newFirstTarget,
          sizeBytes: 3
        })
      ]);
      expect(summary).toMatchObject({ totalLinks: 1, remoteLinks: 1, missingLinks: 1 });
      const persistedLinks = (await database.db.select().from(schema.mediaLinks)).filter((link) => !link.missingSince);
      expect(persistedLinks.map((link) => [link.linkPath, link.lastSeenJobId]).sort()).toEqual(
        [
          [newFirstLink, 2],
          [secondLink, 1]
        ].sort()
      );
      const rescannedLink = persistedLinks.find((link) => link.linkPath === newFirstLink);
      expect(rescannedLink?.resolvedStorageFileId).toEqual(expect.any(Number));
      expect(await listStorageFiles(database.db, "remote")).toEqual([
        expect.objectContaining({ filePath: newFirstTarget, section: "shows", itemName: "First Title" })
      ]);
      await expect(database.db.select().from(schema.storageFiles).where(eq(schema.storageFiles.filePath, newFirstTarget))).resolves.toEqual([
        expect.objectContaining({ filePath: newFirstTarget, lastSeenJobId: 2 })
      ]);
      expect(await listMediaLinks(database.db, undefined, "missing")).toMatchObject([{ linkPath: oldFirstLink, missingSince: expect.any(String) }]);
    } finally {
      await database.close();
    }
  });

  it("marks a targeted symlink broken when its target cannot pass the bounded read preflight", async () => {
    const symlinkDir = path.join(tmpDir, "links");
    const localDir = path.join(tmpDir, "local");
    const remoteDir = path.join(tmpDir, "remote");
    const titleRoot = path.join(symlinkDir, "movies", "Unreadable Title");
    const invalidTarget = path.join(remoteDir, "invalid-target.mkv");
    await fs.mkdir(titleRoot, { recursive: true });
    await fs.mkdir(invalidTarget, { recursive: true });
    await fs.mkdir(localDir, { recursive: true });
    await fs.symlink(invalidTarget, path.join(titleRoot, "Unreadable Title.mkv"));

    const result = await scanLibrary(
      { symlinkDir, localDir, remoteDir },
      { sections: ["movies"], sectionTypes: { movies: "movies" } },
      new Map(),
      {
        scanSymlinks: true,
        scanLocal: false,
        scanRemote: false,
        symlinkSections: ["movies"],
        titleScopes: [{ section: "movies", itemName: "Unreadable Title" }]
      }
    );

    expect(result.links).toEqual([
      expect.objectContaining({
        itemName: "Unreadable Title",
        kind: "broken",
        targetExists: false,
        targetReadError: expect.stringContaining("not a regular file")
      })
    ]);
    expect(result.reconciledStorageFiles).toEqual([]);
  });

  it("uses separate section scopes for symlink and local file scans", async () => {
    const symlinkDir = path.join(tmpDir, "plex");
    const localDir = path.join(tmpDir, "local");
    const remoteDir = path.join(tmpDir, "remote");
    await fs.mkdir(path.join(symlinkDir, "movies", "Movie One"), { recursive: true });
    await fs.mkdir(path.join(symlinkDir, "shows", "Show One"), { recursive: true });
    await fs.mkdir(path.join(localDir, "movies", "Movie One"), { recursive: true });
    await fs.mkdir(path.join(localDir, "shows", "Show One"), { recursive: true });
    await fs.mkdir(remoteDir, { recursive: true });

    const movieFile = path.join(localDir, "movies", "Movie One", "movie.mkv");
    const showFile = path.join(localDir, "shows", "Show One", "show.mkv");
    await fs.writeFile(movieFile, "movie");
    await fs.writeFile(showFile, "show");
    await fs.symlink(movieFile, path.join(symlinkDir, "movies", "Movie One", "movie.mkv"));
    await fs.symlink(showFile, path.join(symlinkDir, "shows", "Show One", "show.mkv"));

    const result = await scanLibrary({ symlinkDir, localDir, remoteDir }, { sections: ["movies", "shows"] }, new Map(), {
      scanSymlinks: true,
      scanLocal: true,
      scanRemote: false,
      symlinkSections: ["movies"],
      localSections: ["shows"]
    });

    expect(result.links.map((link) => link.section)).toEqual(["movies"]);
    expect(result.storageFiles.map((file) => file.relativePath)).toEqual([path.join("shows", "Show One", "show.mkv")]);
  });

  it("limits policy and copy work to current symlinks while retaining storage-only files as unassigned orphans", async () => {
    const symlinkDir = path.join(tmpDir, "plex");
    const localDir = path.join(tmpDir, "local");
    const remoteDir = path.join(tmpDir, "remote");
    await fs.mkdir(path.join(symlinkDir, "movies", "Remote Copy Local"), { recursive: true });
    await fs.mkdir(path.join(symlinkDir, "movies", "Local Copy Remote"), { recursive: true });
    await fs.mkdir(path.join(symlinkDir, "movies", "Remote Needs Policy"), { recursive: true });
    await fs.mkdir(path.join(symlinkDir, "movies", "Local Needs Policy"), { recursive: true });
    await fs.mkdir(path.join(localDir, "movies", "Local Copy Remote"), { recursive: true });
    await fs.mkdir(path.join(localDir, "movies", "Local Needs Policy"), { recursive: true });
    await fs.mkdir(path.join(localDir, "movies", "Local File Copy Remote"), { recursive: true });
    await fs.mkdir(path.join(localDir, "movies", "Local File Needs Policy"), { recursive: true });
    await fs.mkdir(path.join(remoteDir, "Remote Copy Local"), { recursive: true });
    await fs.mkdir(path.join(remoteDir, "Remote Needs Policy"), { recursive: true });
    await fs.mkdir(path.join(remoteDir, "Remote File Copy Local"), { recursive: true });
    await fs.mkdir(path.join(remoteDir, "Remote File Needs Policy"), { recursive: true });
    await fs.mkdir(path.join(remoteDir, "Remote File Assign Remote"), { recursive: true });

    const remoteCopyLinkTarget = path.join(remoteDir, "Remote Copy Local", "remote.mkv");
    const localCopyLinkTarget = path.join(localDir, "movies", "Local Copy Remote", "local.mkv");
    const remoteUnassignedTarget = path.join(remoteDir, "Remote Needs Policy", "remote.mkv");
    const localUnassignedTarget = path.join(localDir, "movies", "Local Needs Policy", "local.mkv");
    await fs.writeFile(remoteCopyLinkTarget, "remote copy local");
    await fs.writeFile(localCopyLinkTarget, "local copy remote");
    await fs.writeFile(remoteUnassignedTarget, "remote needs policy");
    await fs.writeFile(localUnassignedTarget, "local needs policy");
    await fs.writeFile(path.join(localDir, "movies", "Local File Copy Remote", "file.mkv"), "local file copy remote");
    await fs.writeFile(path.join(localDir, "movies", "Local File Needs Policy", "file.mkv"), "local file needs policy");
    await fs.writeFile(path.join(remoteDir, "Remote File Copy Local", "file.mkv"), "remote file copy local");
    await fs.writeFile(path.join(remoteDir, "Remote File Needs Policy", "file.mkv"), "remote file needs policy");
    await fs.writeFile(path.join(remoteDir, "Remote File Assign Remote", "file.mkv"), "remote file assign remote");
    await fs.symlink(remoteCopyLinkTarget, path.join(symlinkDir, "movies", "Remote Copy Local", "remote.mkv"));
    await fs.symlink(localCopyLinkTarget, path.join(symlinkDir, "movies", "Local Copy Remote", "local.mkv"));
    await fs.symlink(remoteUnassignedTarget, path.join(symlinkDir, "movies", "Remote Needs Policy", "remote.mkv"));
    await fs.symlink(localUnassignedTarget, path.join(symlinkDir, "movies", "Local Needs Policy", "local.mkv"));

    const database = await openTestDatabase();
    try {
      const timestamp = new Date().toISOString();
      await database.db
        .insert(schema.storagePolicies)
        .values([
          { title: "Remote Copy Local", normalizedTitle: "remote copy local", policy: "location_1", source: "test", updatedAt: timestamp },
          { title: "Local Copy Remote", normalizedTitle: "local copy remote", policy: "location_2", source: "test", updatedAt: timestamp },
          { title: "Remote File Copy Local", normalizedTitle: "remote file copy local", policy: "location_1", source: "test", updatedAt: timestamp },
          { title: "Local File Copy Remote", normalizedTitle: "local file copy remote", policy: "location_2", source: "test", updatedAt: timestamp },
          { title: "Remote File Assign Remote", normalizedTitle: "remote file assign remote", policy: "location_2", source: "test", updatedAt: timestamp }
        ]);

      const result = await scanLibrary(
        { symlinkDir, localDir, remoteDir },
        { sections: ["movies"], sectionTypes: { movies: "movies" } },
        await getStoragePolicyMap(database.db),
        { scanSymlinks: true, scanLocal: true, scanRemote: true }
      );

      expect(result.summaries[0]).toMatchObject({
        actionableRemoteLinks: 1,
        actionableLocalLinks: 1,
        unassignedRemoteLinks: 1,
        unassignedLocalLinks: 1
      });
      expect(result.inventory).toMatchObject({
        actionableRemoteLinks: 1,
        actionableLocalLinks: 1,
        unassignedRemoteLinks: 1,
        unassignedLocalLinks: 1,
        actionableRemoteFiles: 0,
        actionableLocalFiles: 0,
        assignedRemoteFiles: 0,
        unassignedRemoteFiles: 3,
        unassignedLocalFiles: 2
      });

      await persistScanResult(database.db, result, 1);
      expect(await getInventorySummary(database.db)).toMatchObject({
        actionableRemoteLinks: 1,
        actionableLocalLinks: 1,
        unassignedRemoteLinks: 1,
        actionableRemoteFiles: 0,
        actionableLocalFiles: 0,
        assignedRemoteFiles: 0,
        unassignedRemoteFiles: 3,
        unassignedLocalFiles: 2
      });

      expect((await listStorageFiles(database.db, "remote", true)).find((file) => file.itemName === "Remote File Copy Local")).toMatchObject({
        storagePolicy: "unassigned"
      });
      expect((await listStorageFiles(database.db, "remote")).find((file) => file.filePath === remoteCopyLinkTarget)).toMatchObject({
        storagePolicy: "location_1"
      });

      expect(await listStoragePolicyCandidates(database.db, "Local File Needs", 10)).toEqual([]);
      expect((await listStorageFiles(database.db, "local", true)).find((file) => file.itemName === "Local File Needs Policy")).toMatchObject({
        storagePolicy: "unassigned"
      });

      const candidates = await listStoragePolicyCandidates(database.db, "Remote Needs", 10);
      expect(candidates).toMatchObject([{ title: "Remote Needs Policy", linkCount: 1, remoteLinkCount: 1 }]);

      await setStoragePolicyTitle(database.db, "Remote Needs Policy", "location_1");
      expect(await getInventorySummary(database.db)).toMatchObject({
        actionableRemoteLinks: 2,
        unassignedRemoteLinks: 0,
        actionableRemoteFiles: 0,
        unassignedRemoteFiles: 3
      });
    } finally {
      await database.close();
    }
  });

  it("scans the remote root without selected section folders", async () => {
    const symlinkDir = path.join(tmpDir, "plex");
    const localDir = path.join(tmpDir, "local");
    const remoteDir = path.join(tmpDir, "remote");
    await fs.mkdir(symlinkDir, { recursive: true });
    await fs.mkdir(localDir, { recursive: true });
    await fs.mkdir(path.join(remoteDir, "Release One"), { recursive: true });
    await fs.mkdir(path.join(remoteDir, "Anime Release"), { recursive: true });

    const remoteMovie = path.join(remoteDir, "Release One", "movie.mkv");
    const remoteAnime = path.join(remoteDir, "Anime Release", "episode.mkv");
    await fs.writeFile(remoteMovie, "remote movie");
    await fs.writeFile(remoteAnime, "remote anime");

    const result = await scanLibrary({ symlinkDir, localDir, remoteDir }, { sections: ["movies", "anime"] }, new Map(), {
      scanSymlinks: false,
      scanLocal: false,
      scanRemote: true,
      symlinkSections: [],
      localSections: []
    });

    expect(result.links).toHaveLength(0);
    expect(result.storageFiles.map((file) => file.relativePath).sort()).toEqual([path.join("Anime Release", "episode.mkv"), path.join("Release One", "movie.mkv")].sort());
    expect(result.inventory).toMatchObject({ remoteFiles: 2, localFiles: 0 });
  });

  it("retries unreadable remote directories at the end before reporting them", async () => {
    const symlinkDir = path.join(tmpDir, "plex");
    const localDir = path.join(tmpDir, "local");
    const remoteDir = path.join(tmpDir, "remote");
    const flakyDir = path.join(remoteDir, "Flaky Release");
    await fs.mkdir(symlinkDir, { recursive: true });
    await fs.mkdir(localDir, { recursive: true });
    await fs.mkdir(path.join(remoteDir, "Healthy Release"), { recursive: true });
    await fs.mkdir(flakyDir, { recursive: true });

    await fs.writeFile(path.join(remoteDir, "Healthy Release", "healthy.mkv"), "healthy");
    await fs.writeFile(path.join(flakyDir, "flaky.mkv"), "flaky");

    const realReaddir = fs.readdir.bind(fs);
    let flakyAttempts = 0;
    const readdirSpy = vi.spyOn(fs, "readdir").mockImplementation((async (dir: unknown, options: unknown) => {
      if (String(dir) === flakyDir) {
        flakyAttempts += 1;
        if (flakyAttempts === 1) throw new Error("temporary remote read failure");
      }
      return realReaddir(dir as never, options as never);
    }) as typeof fs.readdir);

    try {
      const result = await scanLibrary({ symlinkDir, localDir, remoteDir }, { sections: ["movies"] }, new Map(), {
        scanSymlinks: false,
        scanLocal: false,
        scanRemote: true
      });

      expect(flakyAttempts).toBe(2);
      expect(result.storageScanIssues).toHaveLength(0);
      expect(result.storageFiles.map((file) => file.relativePath).sort()).toEqual([path.join("Flaky Release", "flaky.mkv"), path.join("Healthy Release", "healthy.mkv")].sort());
    } finally {
      readdirSpy.mockRestore();
    }
  });

  it("does not mark files missing under confirmed unreadable remote directories", async () => {
    const symlinkDir = path.join(tmpDir, "plex");
    const localDir = path.join(tmpDir, "local");
    const remoteDir = path.join(tmpDir, "remote");
    const brokenDir = path.join(remoteDir, "Broken Release");
    await fs.mkdir(symlinkDir, { recursive: true });
    await fs.mkdir(localDir, { recursive: true });
    await fs.mkdir(path.join(remoteDir, "Healthy Release"), { recursive: true });
    await fs.mkdir(brokenDir, { recursive: true });

    const healthyFile = path.join(remoteDir, "Healthy Release", "healthy.mkv");
    const protectedFile = path.join(brokenDir, "protected.mkv");
    await fs.writeFile(healthyFile, "healthy");
    await fs.writeFile(protectedFile, "protected");

    const database = await openTestDatabase();
    const realReaddir = fs.readdir.bind(fs);
    try {
      const firstScan = await scanLibrary({ symlinkDir, localDir, remoteDir }, { sections: ["movies"] }, new Map(), {
        scanSymlinks: false,
        scanLocal: false,
        scanRemote: true
      });
      await persistScanResult(database.db, firstScan, 1);
      expect(await listStorageFiles(database.db, "remote")).toHaveLength(2);

      const readdirSpy = vi.spyOn(fs, "readdir").mockImplementation((async (dir: unknown, options: unknown) => {
        if (String(dir) === brokenDir) throw new Error("confirmed remote read failure");
        return realReaddir(dir as never, options as never);
      }) as typeof fs.readdir);

      try {
        const secondScan = await scanLibrary({ symlinkDir, localDir, remoteDir }, { sections: ["movies"] }, new Map(), {
          scanSymlinks: false,
          scanLocal: false,
          scanRemote: true
        });
        await persistScanResult(database.db, secondScan, 2);

        expect(secondScan.storageFiles.map((file) => file.filePath)).toEqual([healthyFile]);
        expect(secondScan.storageScanIssues).toMatchObject([{ directoryPath: brokenDir, attempts: 2 }]);
        expect((await listStorageFiles(database.db, "remote")).map((file) => file.filePath).sort()).toEqual([healthyFile, protectedFile].sort());
        expect(await listStorageFiles(database.db, "remote", false, "missing")).toHaveLength(0);
      } finally {
        readdirSpy.mockRestore();
      }
    } finally {
      await database.close();
    }
  });

  it("walks the whole remote root during section-scoped remote scans", async () => {
    const symlinkDir = path.join(tmpDir, "plex");
    const localDir = path.join(tmpDir, "local");
    const remoteDir = path.join(tmpDir, "remote");
    await fs.mkdir(path.join(symlinkDir, "movies"), { recursive: true });
    await fs.mkdir(path.join(localDir, "movies", "Movie One"), { recursive: true });
    await fs.mkdir(path.join(localDir, "shows", "Show One"), { recursive: true });
    await fs.mkdir(path.join(remoteDir, "Release One"), { recursive: true });
    await fs.mkdir(path.join(remoteDir, "shows", "Show One"), { recursive: true });

    const localMovie = path.join(localDir, "movies", "Movie One", "movie.mkv");
    const localShow = path.join(localDir, "shows", "Show One", "show.mkv");
    const remoteRelease = path.join(remoteDir, "Release One", "remote.mkv");
    const remoteShow = path.join(remoteDir, "shows", "Show One", "show.mkv");
    await fs.writeFile(localMovie, "movie");
    await fs.writeFile(localShow, "show");
    await fs.writeFile(remoteRelease, "remote");
    await fs.writeFile(remoteShow, "remote show");

    const result = await scanLibrary({ symlinkDir, localDir, remoteDir }, { sections: ["movies", "shows"] }, new Map(), {
      scanSymlinks: false,
      scanLocal: true,
      scanRemote: true,
      sections: ["movies"]
    });

    expect(result.storageFiles.filter((file) => file.rootType === "local").map((file) => file.relativePath)).toEqual([path.join("movies", "Movie One", "movie.mkv")]);
    expect(result.storageFiles.filter((file) => file.rootType === "remote").map((file) => file.relativePath).sort()).toEqual(
      [path.join("Release One", "remote.mkv"), path.join("shows", "Show One", "show.mkv")].sort()
    );

    const database = await openTestDatabase();
    try {
      await persistScanResult(database.db, result, 1);
      expect(await listStorageFiles(database.db, "remote")).toHaveLength(2);

      await fs.rm(remoteRelease);
      const secondScan = await scanLibrary({ symlinkDir, localDir, remoteDir }, { sections: ["movies", "shows"] }, new Map(), {
        scanSymlinks: false,
        scanLocal: true,
        scanRemote: true,
        sections: ["movies"]
      });
      await persistScanResult(database.db, secondScan, 2);

      expect(await listStorageFiles(database.db, "remote", false, "missing")).toMatchObject([{ filePath: remoteRelease, missingSince: expect.any(String) }]);
    } finally {
      await database.close();
    }
  });

  it("uses explicit section types for show season summaries", async () => {
    const symlinkDir = path.join(tmpDir, "plex");
    const localDir = path.join(tmpDir, "local");
    const remoteDir = path.join(tmpDir, "remote");
    await fs.mkdir(path.join(symlinkDir, "anime", "Example Anime", "Season 01"), { recursive: true });
    await fs.mkdir(path.join(remoteDir, "anime", "Example Anime", "Season 01"), { recursive: true });
    await fs.mkdir(localDir, { recursive: true });

    const remoteEpisode = path.join(remoteDir, "anime", "Example Anime", "Season 01", "episode-1.mkv");
    await fs.writeFile(remoteEpisode, "remote");
    await fs.symlink(remoteEpisode, path.join(symlinkDir, "anime", "Example Anime", "Season 01", "episode-1.mkv"));

    const inferred = await scanLibrary({ symlinkDir, localDir, remoteDir }, { sections: ["anime"] }, new Map(), {
      scanSymlinks: true,
      scanLocal: false,
      scanRemote: false
    });
    expect(inferred.summaries[0]).toMatchObject({ section: "anime", type: "other", itemCount: 1, seasonCount: 0, episodeCount: 1 });

    const explicit = await scanLibrary({ symlinkDir, localDir, remoteDir }, { sections: ["anime"], sectionTypes: { anime: "shows" } }, new Map(), {
      scanSymlinks: true,
      scanLocal: false,
      scanRemote: false
    });
    expect(explicit.summaries[0]).toMatchObject({ section: "anime", type: "shows", itemCount: 1, seasonCount: 1, episodeCount: 1 });
  });

  it("returns symlink inventory as a section folder tree", async () => {
    const symlinkDir = path.join(tmpDir, "plex");
    const localDir = path.join(tmpDir, "local");
    const remoteDir = path.join(tmpDir, "remote");
    await fs.mkdir(path.join(symlinkDir, "movies"), { recursive: true });
    await fs.mkdir(path.join(symlinkDir, "shows", "Example Show", "Season 01"), { recursive: true });
    await fs.mkdir(path.join(symlinkDir, "shows", "Other Show", "Season 01"), { recursive: true });
    await fs.mkdir(path.join(localDir, "shows", "Example Show", "Season 01"), { recursive: true });
    await fs.mkdir(path.join(remoteDir, "shows", "Example Show", "Season 01"), { recursive: true });
    await fs.mkdir(path.join(remoteDir, "shows", "Other Show", "Season 01"), { recursive: true });

    const localEpisode = path.join(localDir, "shows", "Example Show", "Season 01", "episode-1.mkv");
    const remoteEpisode = path.join(remoteDir, "shows", "Example Show", "Season 01", "episode-2.mkv");
    const otherEpisode = path.join(remoteDir, "shows", "Other Show", "Season 01", "episode-1.mkv");
    await fs.writeFile(localEpisode, "local");
    await fs.writeFile(remoteEpisode, "remote");
    await fs.writeFile(otherEpisode, "other");
    await fs.symlink(localEpisode, path.join(symlinkDir, "shows", "Example Show", "Season 01", "episode-1.mkv"));
    await fs.symlink(remoteEpisode, path.join(symlinkDir, "shows", "Example Show", "Season 01", "episode-2.mkv"));
    await fs.symlink(otherEpisode, path.join(symlinkDir, "shows", "Other Show", "Season 01", "episode-1.mkv"));

    const database = await openTestDatabase();
    try {
      const result = await scanLibrary(
        { symlinkDir, localDir, remoteDir },
        { sections: ["shows"], sectionTypes: { shows: "shows" } },
        new Map(),
        { scanSymlinks: true, scanLocal: true, scanRemote: true }
      );
      await persistScanResult(database.db, result, 1);
      expect(result.summaries[0]).toMatchObject({
        section: "shows",
        type: "shows",
        itemCount: 2,
        seasonCount: 2,
        episodeCount: 3
      });

      const root = await listMediaLinkTree(database.db, { section: "shows" });
      expect(root.prefix).toBe("");
      expect(root.nodes).toMatchObject([
        { type: "folder", name: "Example Show", path: "Example Show", totalLinks: 2, childFolderCount: 1, remoteLinks: 1, localLinks: 1 },
        { type: "folder", name: "Other Show", path: "Other Show", totalLinks: 1, childFolderCount: 1, remoteLinks: 1 }
      ]);

      const mixedOnly = await listMediaLinkTree(database.db, { section: "shows", kind: "mixed" });
      expect(mixedOnly.nodes.map((node) => node.name)).toEqual(["Example Show"]);
      expect(mixedOnly.nodes).toMatchObject([{ type: "folder", name: "Example Show", remoteLinks: 1, localLinks: 1 }]);

      const show = await listMediaLinkTree(database.db, { section: "shows", prefix: "Example Show" });
      expect(show.parentPrefix).toBe(null);
      expect(show.nodes).toMatchObject([{ type: "folder", name: "Season 01", path: "Example Show/Season 01", totalLinks: 2, childFolderCount: 0 }]);

      const season = await listMediaLinkTree(database.db, { section: "shows", prefix: "Example Show/Season 01" });
      expect(season.parentPrefix).toBe("Example Show");
      expect(season.nodes).toMatchObject([
        { type: "link", name: "episode-1.mkv", totalLinks: 1, localLinks: 1, link: { targetPath: localEpisode, kind: "local" } },
        { type: "link", name: "episode-2.mkv", totalLinks: 1, remoteLinks: 1, link: { targetPath: remoteEpisode, kind: "remote" } }
      ]);

      const remoteOnly = await listMediaLinkTree(database.db, { section: "shows", prefix: "Example Show/Season 01", kind: "remote" });
      expect(remoteOnly.nodes).toMatchObject([{ type: "link", name: "episode-2.mkv", remoteLinks: 1 }]);
    } finally {
      await database.close();
    }
  });

  it("returns storage inventory as a folder tree without loading every file row", async () => {
    const symlinkDir = path.join(tmpDir, "plex");
    const localDir = path.join(tmpDir, "local");
    const remoteDir = path.join(tmpDir, "remote");
    await fs.mkdir(path.join(symlinkDir, "movies"), { recursive: true });
    await fs.mkdir(path.join(symlinkDir, "shows", "Example Show", "Season 01"), { recursive: true });
    await fs.mkdir(path.join(localDir, "shows", "Example Show", "Season 01"), { recursive: true });
    await fs.mkdir(path.join(localDir, "shows", "Example Show", "Season 02"), { recursive: true });
    await fs.mkdir(path.join(localDir, "movies", "Movie One"), { recursive: true });
    await fs.mkdir(remoteDir, { recursive: true });

    const linkedEpisode = path.join(localDir, "shows", "Example Show", "Season 01", "episode-1.mkv");
    const orphanEpisode = path.join(localDir, "shows", "Example Show", "Season 02", "orphan.mkv");
    const orphanMovie = path.join(localDir, "movies", "Movie One", "movie.mkv");
    await fs.writeFile(linkedEpisode, "linked");
    await fs.writeFile(orphanEpisode, "orphan");
    await fs.writeFile(orphanMovie, "movie");
    await fs.symlink(linkedEpisode, path.join(symlinkDir, "shows", "Example Show", "Season 01", "episode-1.mkv"));

    const database = await openTestDatabase();
    try {
      const result = await scanLibrary(
        { symlinkDir, localDir, remoteDir },
        { sections: ["movies", "shows"], sectionTypes: { movies: "movies", shows: "shows" } },
        new Map(),
        { scanSymlinks: true, scanLocal: true, scanRemote: false }
      );
      await persistScanResult(database.db, result, 1);

      const root = await listStorageFileTree(database.db, { rootType: "local" });
      expect(root).toMatchObject({
        rootType: "local",
        prefix: "",
        nodes: [
          { type: "folder", name: "movies", path: "movies", totalFiles: 1, linkedFiles: 0, orphanFiles: 1 },
          { type: "folder", name: "shows", path: "shows", totalFiles: 2, childFolderCount: 1, linkedFiles: 1, orphanFiles: 1 }
        ]
      });

      const season = await listStorageFileTree(database.db, { rootType: "local", prefix: path.join("shows", "Example Show", "Season 01") });
      expect(season.parentPrefix).toBe("shows/Example Show");
      expect(season.nodes).toMatchObject([
        { type: "file", name: "episode-1.mkv", totalFiles: 1, linkedFiles: 1, orphanFiles: 0, file: { filePath: linkedEpisode, linked: true, linkCount: 1 } }
      ]);

      const orphans = await listStorageFileTree(database.db, { rootType: "local", prefix: path.join("shows", "Example Show"), orphanOnly: true });
      expect(orphans.nodes).toMatchObject([{ type: "folder", name: "Season 02", totalFiles: 1, linkedFiles: 0, orphanFiles: 1 }]);
    } finally {
      await database.close();
    }
  });
});
