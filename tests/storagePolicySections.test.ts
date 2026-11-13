import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp, type AppContext } from "../src/server/app";
import { endPool, openDatabase, setSetting } from "../src/server/db/database";
import * as schema from "../src/server/db/schema";
import { JobWorker } from "../src/server/jobs/jobRunner";
import { markOnboardingCompleteForExistingInstall } from "../src/server/lib/onboarding";
import { persistSectionSettings } from "../src/server/lib/sectionSettings";
import { listStoragePolicyTitles, resolveUnplacedStoragePolicies } from "../src/server/lib/storagePolicies";
import { planPolicyPlacement } from "../src/server/lib/storagePolicyPlacement";
import { applyStoragePolicySectionMigration } from "../src/server/db/storagePolicySectionMigration";
import type { PathsSettings, StoragePolicyTitle } from "../src/shared/types";
import { readSetupToken } from "./authHelpers";
import { createTestDatabase, type TestDatabaseHandle } from "./testDb";

const quietLogger = { info: () => undefined, warn: () => undefined, error: () => undefined };

const passingRunner = {
  async copyFile(source: string, target: string) {
    await fs.copyFile(source, target);
  },
  async runCmp(source: string, target: string) {
    const [left, right] = await Promise.all([fs.readFile(source), fs.readFile(target)]);
    return { status: left.equals(right) ? ("pass" as const) : ("fail" as const), output: "" };
  },
  async runFfmpeg() {
    return { status: "pass" as const, output: "" };
  }
};

describe("storage policy migration 33", () => {
  it("copies each title-wide policy to every folder holding the title and keeps titles without links", async () => {
    const testDatabase = await createTestDatabase();
    try {
      // Bring a current database back to the state before migration 33: one row per title, no section.
      const fresh = await openDatabase(testDatabase.databaseUrl);
      await fresh.close();
      const legacy = new Pool({ connectionString: testDatabase.databaseUrl });
      try {
        await legacy.query(`DELETE FROM schema_migrations WHERE version = 33`);
        await legacy.query(`DROP INDEX storage_policies_section_title_idx`);
        await legacy.query(`DROP INDEX IF EXISTS storage_policies_normalized_title_idx`);
        await legacy.query(`ALTER TABLE storage_policies DROP COLUMN section`);
        await legacy.query(`ALTER TABLE storage_policies ADD CONSTRAINT storage_policies_normalized_title_key UNIQUE (normalized_title)`);
        await legacy.query(`
          INSERT INTO storage_policies (title, normalized_title, policy, source, updated_at) VALUES
            ('Alpha (2020)', 'alpha (2020)', 'location_1', 'manual', '2026-01-01T00:00:00.000Z'),
            ('Bravo (2021)', 'bravo (2021)', 'location_2', 'radarr', '2026-01-02T00:00:00.000Z'),
            ('Charlie''s Story (2022)', 'charlie''s story (2022)', 'location_2', 'manual', '2026-01-03T00:00:00.000Z'),
            ('Echo (2024)', 'echo (2024)', 'location_1', 'manual', '2026-01-05T00:00:00.000Z')
        `);
        const link = (id: number, section: string, itemName: string, policy: string, missing = false) =>
          legacy.query(
            `INSERT INTO media_links (section, item_name, relative_path, link_path, target_path, kind, target_exists, is_media, storage_policy, missing_since, updated_at)
             VALUES ($1, $2, $3, $4, $5, 'remote', true, true, $6, $7, '2026-01-01T00:00:00.000Z')`,
            [section, itemName, `${itemName}/${id}.mkv`, `/links/${section}/${itemName}/${id}.mkv`, `/remote/${id}.mkv`, policy, missing ? "2026-01-01T00:00:00.000Z" : null]
          );
        await link(1, "movies", "Alpha (2020)", "location_1");
        await link(2, "movies4k", "Alpha (2020)", "location_1");
        await link(3, "movies", "Bravo (2021)", "location_2");
        await link(4, "anime", "Bravo (2021)", "location_2", true);
        // The same title spelled the way the folder spells it still matches.
        await link(5, "movies", "Charlies Story (2022)", "location_2");
        await link(6, "movies", "Delta (2023)", "unassigned");
      } finally {
        await endPool(legacy);
      }

      const migrated = await openDatabase(testDatabase.databaseUrl);
      try {
        const rows = (
          await migrated.pool.query<{ section: string; title: string; policy: string; source: string; updated_at: string }>(
            `SELECT section, title, policy, source, updated_at FROM storage_policies ORDER BY title, section`
          )
        ).rows;
        expect(rows).toEqual([
          { section: "movies", title: "Alpha (2020)", policy: "location_1", source: "manual", updated_at: "2026-01-01T00:00:00.000Z" },
          { section: "movies4k", title: "Alpha (2020)", policy: "location_1", source: "manual", updated_at: "2026-01-01T00:00:00.000Z" },
          { section: "anime", title: "Bravo (2021)", policy: "location_2", source: "radarr", updated_at: "2026-01-02T00:00:00.000Z" },
          { section: "movies", title: "Bravo (2021)", policy: "location_2", source: "radarr", updated_at: "2026-01-02T00:00:00.000Z" },
          { section: "movies", title: "Charlie's Story (2022)", policy: "location_2", source: "manual", updated_at: "2026-01-03T00:00:00.000Z" },
          // No folder holds this title yet, so it waits with an empty section.
          { section: "", title: "Echo (2024)", policy: "location_1", source: "manual", updated_at: "2026-01-05T00:00:00.000Z" }
        ]);
        // Links keep the policy they had.
        expect((await migrated.pool.query(`SELECT section, item_name, storage_policy FROM media_links ORDER BY id`)).rows.map((row) => row.storage_policy)).toEqual([
          "location_1",
          "location_1",
          "location_2",
          "location_2",
          "location_2",
          "unassigned"
        ]);
        expect((await migrated.pool.query(`SELECT name FROM schema_migrations WHERE version = 33`)).rows).toEqual([{ name: "storage_policy_sections" }]);

        // Running the migration again changes nothing.
        const client = await migrated.pool.connect();
        try {
          await applyStoragePolicySectionMigration(client);
        } finally {
          client.release();
        }
        expect((await migrated.pool.query(`SELECT section, title, policy FROM storage_policies ORDER BY title, section`)).rows).toHaveLength(6);

        // The same title can now hold a different policy per folder.
        await migrated.pool.query(
          `INSERT INTO storage_policies (section, title, normalized_title, policy, source, updated_at) VALUES ('anime', 'Alpha (2020)', 'alpha (2020)', 'location_2', 'manual', 'now')`
        );
        await expect(
          migrated.pool.query(`INSERT INTO storage_policies (section, title, normalized_title, policy, source, updated_at) VALUES ('anime', 'Alpha (2020)', 'alpha (2020)', 'location_1', 'manual', 'now')`)
        ).rejects.toThrow();
      } finally {
        await migrated.close();
      }
    } finally {
      await testDatabase.cleanup();
    }
  });

  it("places a waiting policy in the folders a title first appears in, newest row first", () => {
    const row = (id: number, section: string, title: string, policy: string, updatedAt: string) => ({ id, section, title, normalizedTitle: title.toLowerCase(), policy, source: "manual", updatedAt });
    const plan = planPolicyPlacement(
      [row(1, "", "Foxtrot (2025)", "location_1", "2026-01-01"), row(2, "", "foxtrot (2025)", "location_2", "2026-02-01"), row(3, "movies4k", "Foxtrot (2025)", "location_1", "2026-01-01"), row(4, "", "Golf (2026)", "location_2", "2026-01-01")],
      [
        { section: "movies", itemName: "Foxtrot (2025)" },
        { section: "movies4k", itemName: "Foxtrot (2025)" }
      ]
    );
    // movies4k already has its own row; the newer of the two waiting rows wins in movies; Golf keeps waiting.
    expect(plan.inserts).toEqual([{ section: "movies", title: "foxtrot (2025)", normalizedTitle: "foxtrot (2025)", policy: "location_2", source: "manual", updatedAt: "2026-02-01" }]);
    expect(plan.deleteIds.sort()).toEqual([1, 2]);
  });
});

describe("per-folder storage policies", () => {
  let app: AppContext;
  let database: TestDatabaseHandle;
  let root: string;
  let paths: PathsSettings;
  let cookie: string;

  async function remoteMovie(section: string, itemName: string, file: string, sharedTarget?: string): Promise<string> {
    const target = sharedTarget ?? path.join(paths.remoteDir, section, itemName, file);
    await fs.mkdir(path.dirname(target), { recursive: true });
    if (!sharedTarget) await fs.writeFile(target, `remote bytes of ${section}/${itemName}/${file}`);
    const link = path.join(paths.symlinkDir, section, itemName, file);
    await fs.mkdir(path.dirname(link), { recursive: true });
    await fs.symlink(target, link);
    return target;
  }

  async function drain(): Promise<void> {
    const worker = new JobWorker(app.database.db, { workerId: "per-folder-policy", logger: quietLogger, copyRunner: passingRunner });
    while (await worker.runOnce()) {
      // run every queued job
    }
  }

  async function scan(): Promise<void> {
    await app.jobs.startScan({ scanSymlinks: true, scanLocal: true, scanRemote: true });
    await drain();
  }

  async function linkPolicies(): Promise<Record<string, string>> {
    const links = await app.database.db.select().from(schema.mediaLinks);
    return Object.fromEntries(links.map((link) => [`${link.section}/${link.itemName}`, link.storagePolicy]));
  }

  async function linkTargets(): Promise<Record<string, string>> {
    const links = await app.database.db.select().from(schema.mediaLinks);
    return Object.fromEntries(links.map((link) => [`${link.section}/${link.itemName}`, link.targetPath]));
  }

  async function rowsFor(title: string): Promise<StoragePolicyTitle[]> {
    return (await listStoragePolicyTitles(app.database.db)).filter((item) => item.title === title);
  }

  function assign(payload: Record<string, unknown>) {
    return app.app.inject({ method: "POST", url: "/api/storage-policies", headers: { cookie }, payload });
  }

  function assignMany(payload: Record<string, unknown>) {
    return app.app.inject({ method: "POST", url: "/api/storage-policies/bulk", headers: { cookie }, payload });
  }

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "srtl-per-folder-policy-"));
    paths = { symlinkDir: path.join(root, "links"), localDir: path.join(root, "local"), remoteDir: path.join(root, "remote") };
    for (const folder of Object.values(paths)) await fs.mkdir(folder, { recursive: true });
    database = await createTestDatabase();
    app = await createApp({ rootDir: root, databaseUrl: database.databaseUrl, autoMigrate: true, paths });
    app.app.log.level = "silent";
    await markOnboardingCompleteForExistingInstall(app.database.db);
    await persistSectionSettings(app.database.db, {
      sections: ["movies", "movies4k"],
      sectionTypes: { movies: "movies", movies4k: "movies" },
      sectionTitles: { movies: "Movies", movies4k: "Movies 4K" }
    });
    await setSetting(app.database.db, "advancedSettings", { copy: { profile: "fast" }, cleanup: { holdDays: 7, deleteRemoteSourceAfterCopy: true } });
    const setup = await app.app.inject({
      method: "POST",
      url: "/api/auth/setup",
      payload: { setupToken: readSetupToken(app), username: "fixture", password: "fixture-password-123", confirmPassword: "fixture-password-123" }
    });
    cookie = String(setup.headers["set-cookie"]);
  });

  afterEach(async () => {
    await app?.app.close();
    await database?.cleanup();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("assigning in movies4k leaves the same title in movies untouched", async () => {
    await remoteMovie("movies", "Alpha (2020)", "Alpha.mkv");
    await remoteMovie("movies4k", "Alpha (2020)", "Alpha 2160p.mkv");
    await scan();

    // A folder is required; changing every folder is an explicit choice.
    expect((await assign({ title: "Alpha (2020)", policy: "location_1" })).statusCode).toBe(400);
    expect((await assignMany({ titles: ["Alpha (2020)"], policy: "location_1" })).statusCode).toBe(400);
    expect((await assign({ title: "Alpha (2020)", section: "shows", policy: "location_1" })).statusCode).toBe(400);

    const assigned = await assign({ title: "Alpha (2020)", section: "movies4k", policy: "location_1" });
    expect(assigned.statusCode).toBe(200);
    expect(assigned.json()).toMatchObject({ title: "Alpha (2020)", section: "movies4k", policy: "location_1", otherFolders: [{ section: "movies", policy: "unassigned" }] });
    expect(await linkPolicies()).toEqual({ "movies/Alpha (2020)": "unassigned", "movies4k/Alpha (2020)": "location_1" });
    expect((await rowsFor("Alpha (2020)")).map((item) => [item.section, item.policy])).toEqual([
      ["movies", "unassigned"],
      ["movies4k", "location_1"]
    ]);

    const remote = await assignMany({ items: [{ title: "Alpha (2020)", section: "movies" }], policy: "location_2" });
    expect(remote.json()).toMatchObject({ updated: 1, sections: ["movies"] });
    expect(await linkPolicies()).toEqual({ "movies/Alpha (2020)": "location_2", "movies4k/Alpha (2020)": "location_1" });

    // Unassigning one folder leaves the other folder's policy.
    const unassigned = await assignMany({ items: [{ title: "Alpha (2020)", section: "movies4k" }], policy: "unassigned" });
    expect(unassigned.json()).toMatchObject({ updated: 1, sections: ["movies4k"] });
    expect(await linkPolicies()).toEqual({ "movies/Alpha (2020)": "location_2", "movies4k/Alpha (2020)": "unassigned" });

    // Asking for every folder changes both, and says so.
    const everywhere = await assignMany({ items: [{ title: "Alpha (2020)", section: "movies" }], allFolders: true, policy: "location_1" });
    expect(everywhere.json()).toMatchObject({ updated: 2, sections: ["movies", "movies4k"] });
    expect(await linkPolicies()).toEqual({ "movies/Alpha (2020)": "location_1", "movies4k/Alpha (2020)": "location_1" });

    // Removing a policy by id removes only that folder's row.
    const movies4kRow = (await rowsFor("Alpha (2020)")).find((item) => item.section === "movies4k")!;
    expect((await app.app.inject({ method: "DELETE", url: `/api/storage-policies/${movies4kRow.id}`, headers: { cookie } })).statusCode).toBe(200);
    expect(await linkPolicies()).toEqual({ "movies/Alpha (2020)": "location_1", "movies4k/Alpha (2020)": "unassigned" });

    // A rescan keeps each folder's policy.
    await scan();
    expect(await linkPolicies()).toEqual({ "movies/Alpha (2020)": "location_1", "movies4k/Alpha (2020)": "unassigned" });
  });

  it("copies one folder's copy to local while the other folder's copy of the same title stays remote", async () => {
    await remoteMovie("movies", "Bravo (2021)", "Bravo.mkv");
    const uhdSource = await remoteMovie("movies4k", "Bravo (2021)", "Bravo 2160p.mkv");
    await scan();
    await assign({ title: "Bravo (2021)", section: "movies", policy: "location_1" });
    await assign({ title: "Bravo (2021)", section: "movies4k", policy: "location_2" });

    // A copy to local of the title across folders still only takes the folder whose policy is local.
    const jobId = await app.jobs.startCopy({ direction: "to_local", itemName: "Bravo (2021)" });
    await drain();
    expect(await app.jobs.getJob(jobId)).toMatchObject({ status: "completed" });
    const targets = await linkTargets();
    expect(targets["movies/Bravo (2021)"]).toBe(path.join(paths.localDir, "movies", "Bravo (2021)", "Bravo.mkv"));
    expect(targets["movies4k/Bravo (2021)"]).toBe(uhdSource);
    await expect(fs.stat(uhdSource)).resolves.toBeTruthy();
    await expect(fs.stat(path.join(paths.localDir, "movies4k"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await linkPolicies()).toEqual({ "movies/Bravo (2021)": "location_1", "movies4k/Bravo (2021)": "location_2" });
  });

  it("keeps a file two folders share where it is while the other folder still wants it there", async () => {
    // One remote file linked from both folders: the 1080p folder wants it local, the 4K folder wants it remote.
    const shared = path.join(paths.remoteDir, "shared", "Charlie (2022)", "Charlie.mkv");
    await fs.mkdir(path.dirname(shared), { recursive: true });
    await fs.writeFile(shared, "shared remote bytes");
    await remoteMovie("movies", "Charlie (2022)", "Charlie.mkv", shared);
    await remoteMovie("movies4k", "Charlie (2022)", "Charlie.mkv", shared);
    await scan();
    await assign({ title: "Charlie (2022)", section: "movies", policy: "location_1" });
    await assign({ title: "Charlie (2022)", section: "movies4k", policy: "location_2" });

    // The shared file has no single policy, and each row says which folder it shares with.
    const [file] = await app.database.db.select().from(schema.storageFiles);
    expect(file).toMatchObject({ filePath: shared, storagePolicy: "unassigned" });
    expect((await rowsFor("Charlie (2022)")).map((item) => [item.section, item.sharedFileSections])).toEqual([
      ["movies", ["movies4k"]],
      ["movies4k", ["movies"]]
    ]);
    const listed = await app.app.inject({ method: "GET", url: "/api/storage-policies?policy=location_1", headers: { cookie } });
    expect(listed.json()).toEqual([expect.objectContaining({ section: "movies", sharedFileSections: ["movies4k"] })]);

    // Copying the 1080p folder to local repoints only its link; the remote source is kept because 4K still uses it,
    // even with remote-source deletion on.
    const jobId = await app.jobs.startCopy({ direction: "to_local", section: "movies" });
    await drain();
    expect(await app.jobs.getJob(jobId)).toMatchObject({ status: "completed" });
    const targets = await linkTargets();
    expect(targets["movies/Charlie (2022)"]).toBe(path.join(paths.localDir, "movies", "Charlie (2022)", "Charlie.mkv"));
    expect(targets["movies4k/Charlie (2022)"]).toBe(shared);
    await expect(fs.readFile(shared, "utf8")).resolves.toBe("shared remote bytes");
    const events = await app.jobs.listEvents(jobId);
    expect(events.map((event) => event.message)).not.toContain("Deleted remote source after verified copy");
    expect(events.map((event) => event.message)).toEqual(expect.arrayContaining([expect.stringContaining(`Kept remote source ${shared}: another symlink still points to it (in movies4k)`)]));

    // Once the folders no longer share a file, the note goes away.
    await scan();
    expect((await rowsFor("Charlie (2022)")).map((item) => item.sharedFileSections)).toEqual([[], []]);
  });

  it("keeps a local file another folder links when a copy replaces previous local files", async () => {
    // The 4K folder's earlier local file is also what the 1080p folder links to.
    const previous = path.join(paths.localDir, "movies4k", "Echo (2024)", "Echo old.mkv");
    await fs.mkdir(path.dirname(previous), { recursive: true });
    await fs.writeFile(previous, "previous local bytes");
    const movieLink = path.join(paths.symlinkDir, "movies", "Echo (2024)", "Echo old.mkv");
    await fs.mkdir(path.dirname(movieLink), { recursive: true });
    await fs.symlink(previous, movieLink);
    await remoteMovie("movies4k", "Echo (2024)", "Echo.mkv");
    await scan();
    await assign({ title: "Echo (2024)", section: "movies4k", policy: "location_1" });
    await assign({ title: "Echo (2024)", section: "movies", policy: "location_1" });

    const conflicts = await app.jobs.previewCopyConflicts({ direction: "to_local", section: "movies4k" });
    expect(conflicts.conflicts.flatMap((conflict) => conflict.candidates.map((candidate) => candidate.filePath))).toEqual([previous]);
    const jobId = await app.jobs.startCopy({ direction: "to_local", section: "movies4k", localConflictStrategy: "replace" });
    await drain();
    expect(await app.jobs.getJob(jobId)).toMatchObject({ status: "completed" });
    await expect(fs.readFile(previous, "utf8")).resolves.toBe("previous local bytes");
    expect((await linkTargets())["movies/Echo (2024)"]).toBe(previous);
    expect((await linkTargets())["movies4k/Echo (2024)"]).toBe(path.join(paths.localDir, "movies4k", "Echo (2024)", "Echo.mkv"));
    const messages = (await app.jobs.listEvents(jobId)).map((event) => event.message);
    expect(messages).toContain(`Kept previous local file ${previous}: still linked from movies`);
    expect(messages).not.toContain("Replaced previous local files");
  });

  it("places a saved policy for a title with no folder yet in the folders where it first appears", async () => {
    const timestamp = new Date().toISOString();
    await app.database.db.insert(schema.storagePolicies).values({ section: "", title: "Delta (2023)", normalizedTitle: "delta (2023)", policy: "location_2", source: "manual", updatedAt: timestamp });
    expect(await rowsFor("Delta (2023)")).toEqual([expect.objectContaining({ section: null, policy: "location_2", sections: [] })]);
    await persistSectionSettings(app.database.db, {
      sections: ["movies", "movies4k"],
      sectionTypes: { movies: "movies", movies4k: "movies" },
      sectionDefaultPolicies: { movies: "location_1" }
    });
    await remoteMovie("movies", "Delta (2023)", "Delta.mkv");
    await remoteMovie("movies4k", "Delta (2023)", "Delta 2160p.mkv");
    await scan();

    // The saved policy wins over the folder default and lands in both folders.
    expect(await linkPolicies()).toEqual({ "movies/Delta (2023)": "location_2", "movies4k/Delta (2023)": "location_2" });
    const rows = await app.database.db.select().from(schema.storagePolicies);
    expect(rows.map((row) => [row.section, row.policy, row.source]).sort()).toEqual([
      ["movies", "location_2", "manual"],
      ["movies4k", "location_2", "manual"]
    ]);
    expect(await resolveUnplacedStoragePolicies(app.database.db)).toBe(0);
  });
});
