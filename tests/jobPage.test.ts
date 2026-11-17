import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp, type AppContext } from "../src/server/app";
import * as schema from "../src/server/db/schema";
import { markOnboardingCompleteForExistingInstall } from "../src/server/lib/onboarding";
import { jobPageSize, maxJobPageSize } from "../src/shared/jobLabels";
import type { JobPage, JobStatus, JobType } from "../src/shared/types";
import { readSetupToken } from "./authHelpers";
import { createTestDatabase, type TestDatabaseHandle } from "./testDb";

const ownerPassword = "owner-password-1234";
const temporaryPassword = "temporary-password-1";

let root: string;
let database: TestDatabaseHandle;
let ctx: AppContext;
let ownerCookie: string;

function cookieFrom(headers: Record<string, unknown>): string {
  return String(headers["set-cookie"]).split(";")[0]!;
}

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

async function insertJob(input: { type?: JobType; status?: JobStatus; finishedMinutesAgo?: number | null; options?: Record<string, unknown> } = {}): Promise<number> {
  const status = input.status ?? "completed";
  const finishedAt = status === "queued" || status === "running" ? null : minutesAgo(input.finishedMinutesAgo ?? 5);
  const [row] = await ctx.database.db
    .insert(schema.jobs)
    .values({
      type: input.type ?? "scan",
      status,
      createdAt: minutesAgo(60 * 24 * 30),
      startedAt: status === "queued" ? null : minutesAgo(60 * 24 * 30),
      finishedAt,
      options: JSON.stringify(input.options ?? {}),
      progress: "{}"
    })
    .returning({ id: schema.jobs.id });
  return row!.id;
}

async function getPage(query: string, cookie = ownerCookie) {
  const response = await ctx.app.inject({ method: "GET", url: `/api/jobs/page${query}`, headers: { cookie } });
  return response;
}

async function page(query: string, cookie = ownerCookie): Promise<JobPage> {
  const response = await getPage(query, cookie);
  expect(response.statusCode, response.body).toBe(200);
  return response.json<JobPage>();
}

describe("Recent jobs paging and search", () => {
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "srtl-job-page-"));
    for (const folder of ["links", "local", "remote"]) await fs.mkdir(path.join(root, folder), { recursive: true });
    database = await createTestDatabase();
    ctx = await createApp({
      rootDir: root,
      dataDir: path.join(root, "data"),
      databaseUrl: database.databaseUrl,
      autoMigrate: true,
      anonymousRequestsPerMinute: 100_000,
      paths: { symlinkDir: path.join(root, "links"), localDir: path.join(root, "local"), remoteDir: path.join(root, "remote") }
    });
    ctx.app.log.level = "silent";
    await markOnboardingCompleteForExistingInstall(ctx.database.db);
    const setup = await ctx.app.inject({
      method: "POST",
      url: "/api/auth/setup",
      payload: { setupToken: readSetupToken(ctx), username: "the-owner", password: ownerPassword, confirmPassword: ownerPassword }
    });
    expect(setup.statusCode).toBe(200);
    ownerCookie = cookieFrom(setup.headers);
  });

  afterEach(async () => {
    if (typeof ctx !== "undefined") await ctx.app.close();
    if (typeof database !== "undefined") await database.cleanup();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("returns ten jobs by default, says whether more exist, and pages on with the offset it gives", async () => {
    const ids: number[] = [];
    for (let index = 0; index < 23; index += 1) ids.push(await insertJob());
    const newestFirst = [...ids].reverse();

    const first = await page("");
    expect(first.jobs.map((job) => job.id)).toEqual(newestFirst.slice(0, jobPageSize));
    expect(first).toMatchObject({ hasMore: true, nextOffset: 10 });

    const second = await page(`?offset=${first.nextOffset}&limit=10`);
    expect(second.jobs.map((job) => job.id)).toEqual(newestFirst.slice(10, 20));
    expect(second).toMatchObject({ hasMore: true, nextOffset: 20 });

    const last = await page(`?offset=${second.nextOffset}&limit=10`);
    expect(last.jobs.map((job) => job.id)).toEqual(newestFirst.slice(20));
    expect(last).toMatchObject({ hasMore: false, nextOffset: 23 });
  });

  it("puts active jobs first, and keeps them however old while the finished window drops old finished jobs", async () => {
    const running = await insertJob({ status: "running" });
    const oldFinished = await insertJob({ finishedMinutesAgo: 120 });
    const recentFailed = await insertJob({ status: "failed", finishedMinutesAgo: 10 });
    const recentCompleted = await insertJob({ finishedMinutesAgo: 5 });

    const windowed = await page("?completedWithinMinutes=60");
    expect(windowed.jobs.map((job) => job.id)).toEqual([running, recentCompleted, recentFailed]);
    expect(windowed.hasMore).toBe(false);

    expect((await page("")).jobs.map((job) => job.id)).toEqual([running, recentCompleted, recentFailed, oldFinished]);
  });

  it("caps the page size and refuses bad paging values", async () => {
    for (let index = 0; index < maxJobPageSize + 5; index += 1) await insertJob();
    expect((await getPage(`?limit=${maxJobPageSize + 1}`)).statusCode).toBe(400);
    expect((await getPage("?offset=-1")).statusCode).toBe(400);
    expect((await getPage(`?q=${"a".repeat(201)}`)).statusCode).toBe(400);
    const capped = await page(`?limit=${maxJobPageSize}`);
    expect(capped.jobs).toHaveLength(maxJobPageSize);
    expect(capped.hasMore).toBe(true);
  });

  it("searches every job by id, type name, status and the folders and titles in its options", async () => {
    const oldAudit = await insertJob({ type: "audit", finishedMinutesAgo: 60 * 24 * 20, options: { sections: ["movies"], mode: "deep" } });
    const purge = await insertJob({ type: "orphan_purge", status: "partially_failed" });
    const titleScan = await insertJob({ type: "scan", options: { titleScopes: [{ section: "shows", itemName: "Example Show (2049)" }] } });
    const copy = await insertJob({ type: "copy", options: { direction: "to_local", linkIds: [2049, 12] } });

    // The finished window does not limit a search.
    expect((await page(`?q=%23${oldAudit}&completedWithinMinutes=15`)).jobs.map((job) => job.id)).toEqual([oldAudit]);
    expect((await page(`?q=${oldAudit}`)).jobs.map((job) => job.id)).toContain(oldAudit);
    expect((await page("?q=orphan%20purge")).jobs.map((job) => job.id)).toEqual([purge]);
    expect((await page("?q=Inventory")).jobs.map((job) => job.id)).toEqual([titleScan]);
    expect((await page("?q=partially%20failed")).jobs.map((job) => job.id)).toEqual([purge]);
    expect((await page("?q=deep%20movies")).jobs.map((job) => job.id)).toEqual([oldAudit]);
    expect((await page("?q=example%20SHOW")).jobs.map((job) => job.id)).toEqual([titleScan]);
    expect((await page("?q=copy%20local")).jobs.map((job) => job.id)).toEqual([copy]);
    // A year matches the title that has it, not a copy whose link id list happens to hold the same number.
    expect((await page("?q=2049")).jobs.map((job) => job.id)).toEqual([titleScan]);
  });

  it("matches the titles a job selected", async () => {
    const copy = await insertJob({ type: "copy", options: { direction: "to_remote" } });
    await insertJob({ type: "copy", options: { direction: "to_remote" } });
    await ctx.database.db.update(schema.jobs).set({ selectionFrozen: true });
    await ctx.database.db.insert(schema.jobSelectionItems).values({
      jobId: copy,
      mediaLinkId: 1,
      selectionOrder: 0,
      section: "movies",
      itemName: "Sample Feature (1999)",
      relativePath: "Sample Feature (1999)/feature.mkv",
      linkPath: "movies/Sample Feature (1999)/feature.mkv",
      createdAt: minutesAgo(1)
    });
    expect((await page("?q=sample%20feature")).jobs.map((job) => job.id)).toEqual([copy]);
  });

  it("treats LIKE wildcards in a search as plain text and pages through search results", async () => {
    for (let index = 0; index < 12; index += 1) await insertJob({ type: "audit" });
    await insertJob({ type: "scan" });
    expect((await page("?q=%25")).jobs).toEqual([]);
    expect((await page("?q=_")).jobs).toEqual([]);

    const first = await page("?q=audit");
    expect(first.jobs).toHaveLength(10);
    expect(first.hasMore).toBe(true);
    const second = await page(`?q=audit&offset=${first.nextOffset}`);
    expect(second.jobs).toHaveLength(2);
    expect(second.hasMore).toBe(false);
    expect(first.jobs.every((job) => job.type === "audit") && second.jobs.every((job) => job.type === "audit")).toBe(true);
  });

  it("never lets a restricted account find a settings job by what its hidden options say", async () => {
    const backup = await insertJob({ type: "backup", options: { folder: "secret-backup-folder" } });
    const created = await ctx.app.inject({
      method: "POST",
      url: "/api/accounts",
      headers: { cookie: ownerCookie },
      payload: { username: "helper-moderator", role: "moderator", temporaryPassword }
    });
    expect(created.statusCode).toBe(201);
    const login = await ctx.app.inject({ method: "POST", url: "/api/auth/login", remoteAddress: "198.51.100.40", payload: { username: "helper-moderator", password: temporaryPassword } });
    expect(login.statusCode).toBe(200);
    const finalPassword = "helper-moderator-final-password";
    const change = await ctx.app.inject({
      method: "PUT",
      url: "/api/auth/user",
      headers: { cookie: cookieFrom(login.headers) },
      payload: { username: "helper-moderator", currentPassword: temporaryPassword, newPassword: finalPassword, confirmNewPassword: finalPassword }
    });
    expect(change.statusCode).toBe(200);
    const moderator = cookieFrom(change.headers);

    expect((await page("?q=secret-backup", ownerCookie)).jobs.map((job) => job.id)).toEqual([backup]);
    expect((await page("?q=secret-backup", moderator)).jobs).toEqual([]);
    const listed = await page("?q=backup", moderator);
    expect(listed.jobs.map((job) => job.id)).toEqual([backup]);
    expect(listed.jobs[0]!.options).toEqual({});
  });

  it("keeps the old jobs list answering with a plain array", async () => {
    await insertJob();
    const response = await ctx.app.inject({ method: "GET", url: "/api/jobs?completedWithinMinutes=60", headers: { cookie: ownerCookie } });
    expect(response.statusCode).toBe(200);
    expect(Array.isArray(response.json())).toBe(true);
  });
});
