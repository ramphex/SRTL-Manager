import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  backupAlert,
  backupFolderName,
  defaultBackupSettings,
  dueBackupSlot,
  nextBackupSlot,
  normalizeBackupSettings,
  previousBackupSlot,
  type BackupEntry
} from "../src/shared/backups";
import {
  backupLocationRefusal,
  backupManifestFormat,
  backupName,
  defaultBackupCommandRunner,
  listBackups,
  pgConnectionEnvironment,
  planBackupPrune,
  prepareBackupDirectory,
  pruneBackups,
  requiredFreeBytes,
  verifyBackupFiles,
  type BackupCommandRunner,
  type BackupFileSet,
  type BackupRuntime
} from "../src/server/lib/backups";
import { createHash } from "node:crypto";
import { makeBackupTestDir } from "./backupHelpers";

const local = (year: number, month: number, day: number, hour = 0, minute = 0) => new Date(year, month - 1, day, hour, minute);

describe("backup schedule", () => {
  it("finds the start before and after a moment, on either side of today's start", () => {
    expect(previousBackupSlot("03:30", local(2026, 11, 4, 3, 30))).toEqual(local(2026, 11, 4, 3, 30));
    expect(previousBackupSlot("03:30", local(2026, 11, 4, 3, 29))).toEqual(local(2026, 11, 3, 3, 30));
    expect(nextBackupSlot("03:30", local(2026, 11, 4, 3, 29))).toEqual(local(2026, 11, 4, 3, 30));
    expect(nextBackupSlot("03:30", local(2026, 11, 4, 3, 30))).toEqual(local(2026, 11, 5, 3, 30));
  });

  it("crosses month and year ends", () => {
    expect(nextBackupSlot("23:59", local(2026, 12, 31, 23, 59))).toEqual(local(2027, 1, 1, 23, 59));
    expect(previousBackupSlot("03:30", local(2027, 1, 1, 1, 0))).toEqual(local(2026, 12, 31, 3, 30));
  });

  it("does not run before the schedule has started, or when off", () => {
    const now = local(2026, 11, 4, 12);
    expect(dueBackupSlot({ enabled: true, time: "03:30" }, { anchorAt: null, lastSlotAt: null }, now)).toBeNull();
    expect(dueBackupSlot({ enabled: false, time: "03:30" }, { anchorAt: local(2026, 11, 1).toISOString(), lastSlotAt: null }, now)).toBeNull();
  });

  it("runs a start that passed, once, including one missed while the worker was down", () => {
    const anchorAt = local(2026, 11, 1).toISOString();
    const missed = dueBackupSlot({ enabled: true, time: "03:30" }, { anchorAt, lastSlotAt: local(2026, 11, 2, 3, 30).toISOString() }, local(2026, 11, 4, 9));
    expect(missed).toEqual(local(2026, 11, 4, 3, 30));
    expect(dueBackupSlot({ enabled: true, time: "03:30" }, { anchorAt, lastSlotAt: missed!.toISOString() }, local(2026, 11, 4, 9))).toBeNull();
    expect(dueBackupSlot({ enabled: true, time: "03:30" }, { anchorAt, lastSlotAt: missed!.toISOString() }, local(2026, 11, 5, 3, 30))).toEqual(local(2026, 11, 5, 3, 30));
  });

  it("does not fire a start already in the past when the schedule was saved", () => {
    const savedAt = local(2026, 11, 4, 12);
    const settings = { enabled: true, time: "11:00" };
    expect(dueBackupSlot(settings, { anchorAt: savedAt.toISOString(), lastSlotAt: null }, local(2026, 11, 4, 12, 1))).toBeNull();
    expect(dueBackupSlot(settings, { anchorAt: savedAt.toISOString(), lastSlotAt: null }, local(2026, 11, 5, 11))).toEqual(local(2026, 11, 5, 11));
  });

  it("defaults to on, nightly and keeping seven, and ignores unusable saved values", () => {
    expect(defaultBackupSettings).toEqual({ enabled: true, time: "03:30", keep: 7, location: null });
    expect(normalizeBackupSettings({ enabled: "yes", time: "25:00", keep: -1, location: "  " })).toEqual(defaultBackupSettings);
    expect(normalizeBackupSettings({ enabled: false, time: "01:05", keep: 3, location: "/backups" })).toEqual({ enabled: false, time: "01:05", keep: 3, location: "/backups" });
  });
});

describe("backup alerts", () => {
  const now = local(2026, 11, 4, 12);
  const verified = (createdAt: Date): BackupEntry => ({ name: "x", createdAt: createdAt.toISOString(), sizeBytes: 1, verified: true, problem: null, appVersion: null, migration: null, databaseSizeBytes: null });
  const base = {
    settings: { enabled: true, time: "03:30" },
    anchorAt: local(2026, 11, 1).toISOString(),
    locationRefusal: null,
    status: { ready: true, problem: null, backups: [verified(local(2026, 11, 4, 3, 31))] },
    lastRun: null,
    activeJobId: null,
    now
  };

  it("is quiet when today's backup exists", () => {
    expect(backupAlert(base)).toBeNull();
  });

  it("reports a missing scheduled backup as overdue only after the grace period", () => {
    const stale = { ...base, status: { ...base.status, backups: [verified(local(2026, 11, 3, 3, 31))] } };
    expect(backupAlert(stale)?.kind).toBe("overdue");
    expect(backupAlert({ ...stale, now: local(2026, 11, 4, 5) })).toBeNull();
    expect(backupAlert({ ...stale, activeJobId: 7 })).toBeNull();
    expect(backupAlert({ ...stale, settings: { enabled: false, time: "03:30" } })).toBeNull();
  });

  it("reports nothing overdue until a start has passed since the schedule began", () => {
    expect(backupAlert({ ...base, anchorAt: local(2026, 11, 4, 11).toISOString(), status: { ...base.status, backups: [] } })).toBeNull();
  });

  it("reports a failure until a newer verified backup exists, even with the schedule off", () => {
    const lastRun = { status: "failed" as const, finishedAt: local(2026, 11, 4, 6).toISOString(), message: "pg_dump exited with code 1" };
    expect(backupAlert({ ...base, lastRun })).toEqual({ kind: "failed", message: "The last database backup failed: pg_dump exited with code 1" });
    expect(backupAlert({ ...base, lastRun, settings: { enabled: false, time: "03:30" } })?.kind).toBe("failed");
    expect(backupAlert({ ...base, lastRun, status: { ...base.status, backups: [verified(local(2026, 11, 4, 7))] } })).toBeNull();
  });

  it("reports a refused or unusable location", () => {
    expect(backupAlert({ ...base, locationRefusal: "Refused" })).toEqual({ kind: "unavailable", message: "Refused" });
    expect(backupAlert({ ...base, status: { ready: false, problem: "Not writable", backups: [] } })).toEqual({ kind: "unavailable", message: "Not writable" });
  });
});

describe("backup location validation", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await makeBackupTestDir();
  });
  afterEach(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
  });

  it.each(["/", "/etc", "/etc/srtl", "/usr/local/backups", "/proc/1", "/sys/x", "/dev/shm/backups", "/boot", "/tmp", "/tmp/backups", "/var/tmp/x", "/var/lib/postgresql/data", "/home", "/mnt", "/var", "/srv", "/run/x"])("refuses the system path %s", async (location) => {
    expect(await backupLocationRefusal(location, [])).toMatch(/system folder/);
  });

  it.each(["/srv/srtl-backups", "/mnt/backups/srtl", "/home/someone/backups", "/backups", "/var/backups/srtl"])("accepts %s", async (location) => {
    expect(await backupLocationRefusal(location, ["/mnt/media"])).toBeNull();
  });

  it("refuses relative paths and parent references", async () => {
    expect(await backupLocationRefusal("backups", [])).toMatch(/absolute/);
    expect(await backupLocationRefusal("/srv/a/../etc", [])).toMatch(/\.\./);
  });

  it("refuses a media root, anything inside one, and any parent of one", async () => {
    const roots = ["/mnt/media/local", "/mnt/media/remote", "/mnt/symlinks"];
    for (const location of ["/mnt/media/local", "/mnt/symlinks/movies", "/mnt/media"]) {
      expect(await backupLocationRefusal(location, roots)).toMatch(/media or symlink root/);
    }
    expect(await backupLocationRefusal("/mnt/backups", roots)).toBeNull();
  });

  it("follows symbolic links, so a link cannot lead into the library or a system folder", async () => {
    const media = path.join(dir, "media");
    await fsp.mkdir(media);
    await fsp.symlink(media, path.join(dir, "innocent"));
    await fsp.symlink("/etc", path.join(dir, "config"));
    expect(await backupLocationRefusal(path.join(dir, "innocent"), [media])).toMatch(/media or symlink root/);
    expect(await backupLocationRefusal(path.join(dir, "innocent", "not-yet-created"), [media])).toMatch(/media or symlink root/);
    expect(await backupLocationRefusal(path.join(dir, "config"), [])).toMatch(/system folder/);
    expect(await backupLocationRefusal(path.join(dir, "fine"), [media])).toBeNull();
  });

  it("creates the folder privately and leaves the chosen location's own mode alone", async () => {
    const location = path.join(dir, "shared");
    await fsp.mkdir(location, { mode: 0o755 });
    await fsp.chmod(location, 0o755);
    const { directory, permissionsWarning } = await prepareBackupDirectory(location);
    expect(directory).toBe(path.join(location, backupFolderName));
    expect(fs.statSync(directory).mode & 0o777).toBe(0o700);
    expect(fs.statSync(location).mode & 0o777).toBe(0o755);
    expect(permissionsWarning).toBeNull();
    expect(fs.readdirSync(directory)).toEqual([]);
  });

  it("tightens a backup folder that was left too open", async () => {
    const location = path.join(dir, "loc");
    await fsp.mkdir(path.join(location, backupFolderName), { recursive: true });
    await fsp.chmod(path.join(location, backupFolderName), 0o777);
    await prepareBackupDirectory(location);
    expect(fs.statSync(path.join(location, backupFolderName)).mode & 0o777).toBe(0o700);
  });

  it("fails plainly on a location it cannot write", async () => {
    const location = path.join(dir, "locked");
    await fsp.mkdir(location);
    await fsp.chmod(location, 0o500);
    await expect(prepareBackupDirectory(location)).rejects.toMatchObject({ code: expect.stringMatching(/EACCES|EPERM/) });
    await fsp.chmod(location, 0o700);
  });
});

const set = (name: string, createdAt: string, verified: boolean, owned = true): BackupFileSet => ({
  owned,
  entry: { name, createdAt, sizeBytes: 1, verified, problem: verified ? null : "bad", appVersion: null, migration: null, databaseSizeBytes: null }
});

describe("backup pruning plan", () => {
  const day = (value: number) => `2026-11-${String(value).padStart(2, "0")}T03:30:00.000Z`;
  const verifiedDays = (...days: number[]) => days.map((value) => set(`b${value}`, day(value), true));

  it("keeps the newest up to the setting", () => {
    expect(planBackupPrune(verifiedDays(1, 2, 3, 4, 5), 3).sort()).toEqual(["b1", "b2"]);
  });

  it("removes nothing at or under the setting", () => {
    expect(planBackupPrune(verifiedDays(1, 2, 3), 3)).toEqual([]);
    expect(planBackupPrune(verifiedDays(1), 7)).toEqual([]);
  });

  it("never keeps fewer than two verified backups, whatever the setting says", () => {
    expect(planBackupPrune(verifiedDays(1, 2, 3, 4), 1).sort()).toEqual(["b1", "b2"]);
    expect(planBackupPrune(verifiedDays(1, 2), 1)).toEqual([]);
    expect(planBackupPrune(verifiedDays(1, 2, 3), 0)).toEqual(["b1"]);
    expect(planBackupPrune(verifiedDays(1, 2, 3), -5)).toEqual(["b1"]);
  });

  it("does not count unverified backups toward the two", () => {
    const sets = [...verifiedDays(5), set("bad4", day(4), false), set("bad3", day(3), false), set("old1", day(1), true)];
    // Only two are verified, so the verified ones stay, and the damaged one older than them goes.
    expect(planBackupPrune(sets, 1)).toEqual([]);
    expect(planBackupPrune([...sets, set("b6", day(6), true)], 1).sort()).toEqual(["bad3", "bad4", "old1"]);
  });

  it("never plans to remove files without this feature's manifest", () => {
    const sets = [...verifiedDays(3, 4, 5), set("stranger", day(1), false, false)];
    expect(planBackupPrune(sets, 2)).toEqual(["b3"]);
  });
});

async function writeBackup(directory: string, at: Date, jobId: number, overrides: Record<string, unknown> = {}): Promise<string> {
  const name = backupName(at, jobId);
  const dump = Buffer.from(`dump ${name}`);
  const sha256 = createHash("sha256").update(dump).digest("hex");
  await fsp.writeFile(path.join(directory, `${name}.dump`), dump, { mode: 0o600 });
  await fsp.writeFile(path.join(directory, `${name}.dump.sha256`), `${sha256}  ${name}.dump\n`, { mode: 0o600 });
  await fsp.writeFile(path.join(directory, `${name}.manifest.json`), JSON.stringify({
    format: backupManifestFormat, formatVersion: 1, name, dumpFile: `${name}.dump`, checksumFile: `${name}.dump.sha256`,
    createdAt: at.toISOString(), verifiedAt: at.toISOString(), appVersion: "0.0.0", migration: 27, databaseSizeBytes: 100,
    dumpSizeBytes: dump.length, sha256, postgresVersion: "17", pgDumpVersion: "17", trigger: "manual", jobId, restoreNeeds: "key", ...overrides
  }), { mode: 0o600 });
  return name;
}

describe("backup files on disk", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await makeBackupTestDir();
  });
  afterEach(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
  });
  const at = (day: number) => new Date(Date.UTC(2026, 10, day, 3, 30));

  it("lists its own backups, newest first, as verified", async () => {
    const older = await writeBackup(dir, at(1), 1);
    const newer = await writeBackup(dir, at(2), 2);
    const sets = await listBackups(dir);
    expect(sets.map((item) => item.entry.name)).toEqual([newer, older]);
    expect(sets.every((item) => item.owned && item.entry.verified)).toBe(true);
    expect(sets[0]?.entry).toMatchObject({ appVersion: "0.0.0", migration: 27, databaseSizeBytes: 100 });
  });

  it("does not count a damaged or incomplete backup as verified", async () => {
    const resized = await writeBackup(dir, at(1), 1);
    await fsp.appendFile(path.join(dir, `${resized}.dump`), "x");
    const noChecksum = await writeBackup(dir, at(2), 2);
    await fsp.rm(path.join(dir, `${noChecksum}.dump.sha256`));
    const noDump = await writeBackup(dir, at(3), 3);
    await fsp.rm(path.join(dir, `${noDump}.dump`));
    const noManifest = await writeBackup(dir, at(4), 4);
    await fsp.rm(path.join(dir, `${noManifest}.manifest.json`));
    const sets = new Map((await listBackups(dir)).map((item) => [item.entry.name, item]));
    expect(sets.get(resized)?.entry.problem).toMatch(/changed size/);
    expect(sets.get(noChecksum)?.entry.problem).toMatch(/checksum/);
    expect(sets.get(noDump)?.entry.problem).toMatch(/missing/);
    expect(sets.get(noManifest)).toMatchObject({ owned: false, entry: { verified: false, problem: "No valid manifest" } });
  });

  it("prunes only its own named, manifest-backed regular files", async () => {
    const removed = await writeBackup(dir, at(1), 1);
    const kept1 = await writeBackup(dir, at(2), 2);
    const kept2 = await writeBackup(dir, at(3), 3);

    // Everything here is older than the kept backups and must survive.
    const strangers = ["notes.txt", "photo.dump", "family.manifest.json", "srtl-manager-backup-holiday.dump", "srtl-manager-backup-20200101T000000Z-j1.dump.sha256"];
    for (const file of strangers) await fsp.writeFile(path.join(dir, file), "not a backup");
    // Right name, no manifest.
    const orphanDump = `${backupName(new Date(Date.UTC(2020, 0, 2)), 9)}.dump`;
    await fsp.writeFile(path.join(dir, orphanDump), "someone's file");
    // Right names, but the manifest is not one of ours.
    const foreign = backupName(new Date(Date.UTC(2020, 0, 3)), 10);
    await fsp.writeFile(path.join(dir, `${foreign}.dump`), "someone's file");
    await fsp.writeFile(path.join(dir, `${foreign}.manifest.json`), JSON.stringify({ format: "another-tool", name: foreign }));
    // A manifest that names another file proves nothing.
    const mismatched = backupName(new Date(Date.UTC(2020, 0, 4)), 11);
    await writeBackup(dir, new Date(Date.UTC(2020, 0, 4)), 11, { dumpFile: "notes.txt" });
    // A symbolic link wearing a backup name.
    const outside = path.join(dir, "..", `${path.basename(dir)}-outside.dump`);
    await fsp.writeFile(outside, "outside");
    const linked = backupName(new Date(Date.UTC(2020, 0, 5)), 12);
    await fsp.symlink(outside, path.join(dir, `${linked}.dump`));

    expect(await pruneBackups(dir, 2)).toEqual([removed]);

    const remaining = fs.readdirSync(dir);
    for (const name of [kept1, kept2]) {
      expect(remaining).toEqual(expect.arrayContaining([`${name}.dump`, `${name}.dump.sha256`, `${name}.manifest.json`]));
    }
    expect(remaining).not.toEqual(expect.arrayContaining([`${removed}.dump`]));
    expect(remaining).toEqual(expect.arrayContaining([...strangers, orphanDump, `${foreign}.dump`, `${foreign}.manifest.json`, `${mismatched}.dump`, `${linked}.dump`]));
    expect(fs.readFileSync(outside, "utf8")).toBe("outside");
    await fsp.rm(outside);
  });

  it("leaves two verified backups behind even with a setting of one", async () => {
    await writeBackup(dir, at(1), 1);
    const second = await writeBackup(dir, at(2), 2);
    const third = await writeBackup(dir, at(3), 3);
    await pruneBackups(dir, 1);
    expect((await listBackups(dir)).map((item) => item.entry.name)).toEqual([third, second]);
  });

  describe("verification", () => {
    const runtime = (runCommand: BackupCommandRunner): BackupRuntime => ({
      databaseUrl: "postgres://user:secret@127.0.0.1:5432/app",
      defaultLocation: dir,
      pgBinDir: null,
      paths: { symlinkDir: "", localDir: "", remoteDir: "" },
      runCommand
    });
    const listOk: BackupCommandRunner = async () => ({ exitCode: 0, stdout: "12; 1259 1 TABLE public schema_migrations owner\n", stderr: "" });

    it("passes with a matching checksum and a readable archive", async () => {
      const name = await writeBackup(dir, at(1), 1);
      await expect(verifyBackupFiles(dir, name, runtime(listOk))).resolves.toMatch(/^[0-9a-f]{64}$/);
    });

    it("fails when the dump does not match its checksum, without asking pg_restore", async () => {
      const name = await writeBackup(dir, at(1), 1);
      await fsp.writeFile(path.join(dir, `${name}.dump`), "tampered");
      const runner = vi.fn(listOk);
      await expect(verifyBackupFiles(dir, name, runtime(runner))).rejects.toThrow(/does not match its checksum/);
      expect(runner).not.toHaveBeenCalled();
    });

    it("fails when the checksum file is gone", async () => {
      const name = await writeBackup(dir, at(1), 1);
      await fsp.rm(path.join(dir, `${name}.dump.sha256`));
      await expect(verifyBackupFiles(dir, name, runtime(listOk))).rejects.toThrow(/checksum file/);
    });

    it("fails when pg_restore cannot read the archive", async () => {
      const name = await writeBackup(dir, at(1), 1);
      await expect(verifyBackupFiles(dir, name, runtime(async () => ({ exitCode: 1, stdout: "", stderr: "pg_restore: error: not a valid archive" })))).rejects.toThrow(/not a valid archive/);
    });

    it("fails on a readable archive that holds none of this app's tables", async () => {
      const name = await writeBackup(dir, at(1), 1);
      await expect(verifyBackupFiles(dir, name, runtime(async () => ({ exitCode: 0, stdout: "; empty\n", stderr: "" })))).rejects.toThrow(/does not contain/);
    });
  });
});

describe("backup commands", () => {
  it("gives pg_dump its connection through the environment", () => {
    expect(pgConnectionEnvironment("postgres://app%40user:p%40ss%2Fword@db.internal:6543/srtl?sslmode=require")).toMatchObject({
      PGHOST: "db.internal", PGPORT: "6543", PGDATABASE: "srtl", PGUSER: "app@user", PGPASSWORD: "p@ss/word", PGSSLMODE: "require"
    });
  });

  it("asks for more free space than the database's likely dump", () => {
    expect(requiredFreeBytes(500_000_000, null)).toBeGreaterThan(250_000_000);
    expect(requiredFreeBytes(500_000_000, 400_000_000)).toBeGreaterThan(600_000_000);
  });

  it("reports a missing program as an error the caller can name", async () => {
    await expect(defaultBackupCommandRunner({ file: "/nonexistent/pg_dump", args: ["--version"], env: {} })).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("stops a running command when the job is terminated", async () => {
    const controller = new AbortController();
    const running = defaultBackupCommandRunner({ file: "/bin/sleep", args: ["30"], env: {}, signal: controller.signal });
    controller.abort();
    await expect(running).rejects.toThrow(/terminated/);
  });
});
