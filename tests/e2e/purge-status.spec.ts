import { expect, test, type Page } from "@playwright/test";
import type { JobEventRecord, JobRecord, OrphanPurgeItem, OrphanPurgeItemPage } from "../../src/shared/types";

const baseUrl = process.env.SRTL_E2E_BASE_URL;
test.skip(!baseUrl, "Set SRTL_E2E_BASE_URL to run browser checks.");

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

const runningPurge: JobRecord = {
  id: 1932,
  type: "orphan_purge",
  status: "running",
  createdAt: minutesAgo(10),
  startedAt: minutesAgo(10),
  finishedAt: null,
  options: { rootType: "remote", mode: "delete", total: 19_981, reRequest: false },
  progress: {
    options: { rootType: "remote", mode: "delete", total: 19_981, reRequest: false },
    current: 4_000,
    total: 19_981,
    held: 0,
    deleted: 3_990,
    alreadyMissing: 10,
    failed: 0,
    remaining: 15_981,
    stage: "purging",
    message: "Checking Alpha.Bravo.S01E02.mkv"
  }
};

const finishedPurge: JobRecord = {
  id: 1931,
  type: "orphan_purge",
  status: "partially_failed",
  createdAt: minutesAgo(40),
  startedAt: minutesAgo(40),
  finishedAt: minutesAgo(38),
  options: { rootType: "local", mode: "hold", total: 5, reRequest: false },
  progress: {
    options: { rootType: "local", mode: "hold", total: 5, reRequest: false },
    current: 5,
    total: 5,
    held: 3,
    deleted: 0,
    alreadyMissing: 0,
    failed: 2,
    remaining: 0,
    stage: "partially_failed",
    message: "Orphan purge partially failed: 2 of 5 files were not purged",
    firstError: { filePath: "/local/shows/Charlie Delta/Charlie.Delta.S02E03.mkv", message: "The file changed after it was inventoried" }
  }
};

// A remote purge where two deleted files were back when the job looked again.
const cameBackPurge: JobRecord = {
  id: 1933,
  type: "orphan_purge",
  status: "partially_failed",
  createdAt: minutesAgo(30),
  startedAt: minutesAgo(30),
  finishedAt: minutesAgo(25),
  options: { rootType: "remote", mode: "delete", total: 6, reRequest: false },
  progress: {
    options: { rootType: "remote", mode: "delete", total: 6, reRequest: false },
    current: 6,
    total: 6,
    held: 0,
    deleted: 4,
    alreadyMissing: 0,
    failed: 0,
    cameBack: 2,
    resurfacedDeleted: 1,
    keepsComingBack: 1,
    listedNotReadable: 3,
    remaining: 0,
    stage: "partially_failed",
    message: "Orphan purge partially failed: 1 of 6 kept coming back after 3 deletes and was left in place; 2 of 6 were deleted but came back on remote storage",
    firstCameBack: { filePath: "/remote/India.Juliet.2003/India.Juliet.2003.mkv", message: "Storage showed the file again 2 minutes after the delete, with a different size or date" },
    recheck: { at: minutesAgo(26), delaySeconds: 120, total: 6, checked: 6 }
  }
};

function item(operationId: number, filePath: string, stage: OrphanPurgeItem["stage"], errorMessage: string | null = null): OrphanPurgeItem {
  return {
    operationId,
    targetKind: "file",
    rootType: "local",
    filePath,
    sizeBytes: 1_000,
    stage,
    errorMessage,
    note: null,
    deleteRounds: 1,
    heldPath: stage === "held" ? `/local/.srtl-purged/${operationId}` : null,
    purgeAfter: stage === "held" ? new Date(Date.now() + 7 * 86_400_000).toISOString() : null,
    completedAt: minutesAgo(39)
  };
}

const failedItems = [
  item(11, "/local/shows/Charlie Delta/Charlie.Delta.S02E03.mkv", "failed", "The file changed after it was inventoried"),
  item(12, "/local/shows/Echo Foxtrot/Echo.Foxtrot.S01E01.mkv", "failed", "No longer an orphan: a symlink points at it")
];
const cameBackItems: OrphanPurgeItem[] = [
  { ...item(21, "/remote/India.Juliet.2003/India.Juliet.2003.mkv", "came_back", "Storage showed the file again 2 minutes after the delete, with a different size or date"), rootType: "remote" },
  { ...item(22, "/remote/Kilo.Lima.2004/Kilo.Lima.2004.mkv", "came_back", "Storage listed the file again 2 minutes after the delete, but it could not be opened"), rootType: "remote" }
];
const keepsItems: OrphanPurgeItem[] = [
  { ...item(23, "/remote/Mike.November.2005/Mike.November.2005.mkv", "keeps_coming_back", "Mike.November.2005.mkv keeps coming back: storage showed another copy at the same path after each of 3 deletes, so it was left in place"), rootType: "remote", deleteRounds: 3 }
];
const resurfacedItems: OrphanPurgeItem[] = [
  { ...item(24, "/remote/Oscar.Papa.2006/Oscar.Papa.2006.mkv", "deleted"), rootType: "remote", deleteRounds: 2, note: "Another copy appeared at the same path after the delete and was deleted too (2 deletes in all)" }
];
const heldItems = [
  item(13, "/local/shows/Alpha Bravo/Alpha.Bravo.S01E02.mkv", "held"),
  item(14, "/local/shows/Alpha Bravo/Alpha.Bravo.S01E03.mkv", "held"),
  item(15, "/local/shows/Golf Hotel/Golf.Hotel.S01E01.mkv", "restored")
];

function event(id: number, jobId: number, level: JobEventRecord["level"], message: string, data: unknown): JobEventRecord {
  return { id, jobId, timestamp: minutesAgo(1), level, message, data };
}

async function mockApi(page: Page) {
  const itemRequests: string[] = [];
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    let body: unknown = [];
    const jobMatch = url.pathname.match(/^\/api\/jobs\/(\d+)(\/.*)?$/);
    const job = jobMatch ? [runningPurge, finishedPurge, cameBackPurge].find((candidate) => candidate.id === Number(jobMatch[1])) : undefined;
    if (url.pathname === "/api/auth/me") body = { setupRequired: false, authenticated: true, user: { id: 1, username: "integration-test", role: "owner", mustChangePassword: false } };
    else if (url.pathname === "/api/system/path-migration") body = { status: "ready", blocking: false, activePaths: {}, detectedPaths: {}, environmentErrors: [], changes: [], migration: null };
    else if (url.pathname === "/api/onboarding") body = { required: false, phase: "completed" };
    else if (url.pathname === "/api/settings/user-preferences") body = { timeFormat: "24h", autoOpenTaskStatus: false, recentJobsCompletedWindowMinutes: 1440 };
    else if (url.pathname === "/api/settings/sections") body = { sections: ["shows"], sectionTitles: { shows: "Shows" }, sectionTypes: { shows: "shows" } };
    else if (url.pathname === "/api/inventory/summary") body = { totalLinks: 0, remoteLinks: 0, localLinks: 0, brokenLinks: 0, otherLinks: 0, nonMediaLinks: 0, actionableRemoteLinks: 0, actionableLocalLinks: 0, assignedRemoteLinks: 0, unassignedRemoteLinks: 0, unassignedLocalLinks: 0, localFiles: 0, remoteFiles: 0, actionableRemoteFiles: 0, actionableLocalFiles: 0, assignedRemoteFiles: 0, unassignedRemoteFiles: 0, unassignedLocalFiles: 0, localOrphanFiles: 0, remoteOrphanFiles: 0, missingLinks: 0, missingLocalFiles: 0, missingRemoteFiles: 0 };
    else if (url.pathname === "/api/settings/paths") body = { symlinkDir: "/links", localDir: "/local", remoteDir: "/remote" };
    else if (url.pathname === "/api/inventory/scan-timestamps") body = { symlinkSections: {}, localSections: {}, remoteRoot: null };
    else if (url.pathname === "/api/settings/scan") body = { scanSymlinks: true, scanLocal: true, scanRemote: true };
    else if (url.pathname === "/api/settings/audit") body = { sections: [], targets: ["local", "remote"] };
    else if (url.pathname === "/api/settings/advanced") body = {};
    else if (url.pathname === "/api/settings/storage-locations") body = { locations: [{ key: "location_1", rootType: "local", displayName: "Home NAS", path: "/local" }, { key: "location_2", rootType: "remote", displayName: "Archive", path: "/remote" }] };
    else if (url.pathname === "/api/system/version") {
      const release = { latestVersion: "0.1.4-beta.6", updateAvailable: false, status: "up_to_date", releaseUrl: null };
      body = { currentVersion: "0.1.4-beta.6", currentChannel: "beta", currentChannelLabel: "Beta", stable: { ...release, channel: "stable" }, beta: { ...release, channel: "beta" }, ...release };
    } else if (url.pathname === "/api/jobs") body = [runningPurge, finishedPurge, cameBackPurge];
    else if (job && !jobMatch?.[2]) body = job;
    else if (job && jobMatch?.[2] === "/events/page") {
      body = job.id === runningPurge.id
        ? { events: [event(2, job.id, "info", "Orphan deleted", { filePath: "/remote/Alpha.Bravo/Alpha.Bravo.S01E01.mkv" })], total: 1, hasOlder: false }
        : job.id === cameBackPurge.id
          ? { events: [event(4, job.id, "warn", "Deleted orphan came back", { filePath: cameBackItems[0]!.filePath, reason: cameBackItems[0]!.errorMessage })], total: 1, hasOlder: false }
          : { events: [event(3, job.id, "error", "Orphan was not purged", { filePath: failedItems[0]!.filePath, reason: failedItems[0]!.errorMessage })], total: 1, hasOlder: false };
    } else if (job && jobMatch?.[2] === "/purge-items") {
      itemRequests.push(url.search);
      const requested = url.searchParams.get("outcome");
      const outcome = requested === "held" || requested === "came_back" || requested === "keeps_coming_back" || requested === "resurfaced" ? requested : "failed";
      const all = { held: heldItems, came_back: cameBackItems, keeps_coming_back: keepsItems, resurfaced: resurfacedItems, failed: failedItems }[outcome];
      const offset = Number(url.searchParams.get("offset") ?? 0);
      // One failed item per page, so the window has to load the second one.
      const limit = outcome === "failed" ? 1 : Number(url.searchParams.get("limit") ?? 100);
      const items = all.slice(offset, offset + limit);
      const page: OrphanPurgeItemPage = { jobId: job.id, outcome, items, total: all.length, offset, limit, hasMore: offset + items.length < all.length };
      body = page;
    }
    await route.fulfill({ json: body });
  });
  return itemRequests;
}

test("a running purge opens a status window with live progress from the recent jobs table", async ({ page }) => {
  const itemRequests = await mockApi(page);
  await page.goto(`${baseUrl}/`);
  const table = page.getByRole("table", { name: "Recent jobs" });
  await expect(table.getByRole("button", { name: "Terminate job #1932" })).toBeVisible();
  await table.getByRole("button", { name: "View purge status for job #1932" }).click();

  const dialog = page.getByRole("dialog", { name: "Orphan purge" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(/Job #1932 - 19,981 remote orphans, deleted/)).toBeVisible();
  const panel = dialog.getByRole("group", { name: "Purge progress" });
  await expect(panel.getByText("Deleting files")).toBeVisible();
  await expect(panel.getByText("4,000 / 19,981")).toBeVisible();
  await expect(panel.getByRole("progressbar", { name: "Purge progress" })).toHaveAttribute("aria-valuenow", "20");
  await expect(panel.getByText("Alpha.Bravo.S01E02.mkv")).toBeVisible();
  await expect(panel.locator("span", { hasText: "Deleted" }).locator("strong")).toHaveText("3,990");
  await expect(panel.locator("span", { hasText: "Already missing" }).locator("strong")).toHaveText("10");
  await expect(panel.locator("span", { hasText: "Left to do" }).locator("strong")).toHaveText("15,981");
  await expect(panel.locator("span", { hasText: /^.*Rate$/ }).locator("strong")).toHaveText(/\/ s$/);
  await expect(panel.locator("span", { hasText: "Time remaining" }).locator("strong")).toHaveText(/\d+m/);
  await expect(dialog.getByRole("button", { name: /Terminate/ })).toBeVisible();
  await expect(dialog.getByText("Orphan deleted")).toBeVisible();
  // Nothing failed or was held, so the item lists are not asked for.
  await expect(dialog.getByRole("region", { name: "Failed items" })).toHaveCount(0);
  expect(itemRequests).toEqual([]);
  await dialog.getByRole("button", { name: "Close purge status window" }).click();
  await expect(dialog).toHaveCount(0);
});

test("a finished purge with failures lists every failed item, the first error and the held files", async ({ page }) => {
  await mockApi(page);
  await page.goto(`${baseUrl}/`);
  const table = page.getByRole("table", { name: "Recent jobs" });
  await expect(table.getByRole("button", { name: "Terminate job #1931" })).toHaveCount(0);
  await table.getByRole("button", { name: "View purge status for job #1931" }).click();

  const dialog = page.getByRole("dialog", { name: "Orphan purge" });
  const panel = dialog.getByRole("group", { name: "Purge progress" });
  await expect(panel.getByText("Partially failed").first()).toBeVisible();
  await expect(panel.getByRole("progressbar", { name: "Purge progress" })).toHaveAttribute("aria-valuenow", "100");
  await expect(panel.locator("p", { hasText: "First error:" })).toContainText("Charlie.Delta.S02E03.mkv: The file changed after it was inventoried");
  await expect(panel.locator("span", { hasText: "Time remaining" }).locator("strong")).toHaveText("Done");

  const failed = dialog.getByRole("list", { name: "Failed items" });
  await expect(failed.getByRole("listitem")).toHaveCount(1);
  await expect(dialog.getByText("1 of 2")).toBeVisible();
  await dialog.getByRole("button", { name: "Load more failed items" }).click();
  await expect(failed.getByRole("listitem")).toHaveCount(2);
  await expect(failed.getByText("No longer an orphan: a symlink points at it")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Load more failed items" })).toHaveCount(0);

  const held = dialog.getByRole("list", { name: "Held items" });
  await expect(held.getByRole("listitem")).toHaveCount(3);
  await expect(held.getByText(/Held until/)).toHaveCount(2);
  await expect(held.getByText("Restored", { exact: true }).first()).toBeVisible();
  const holdingLink = dialog.getByRole("link", { name: "Open holding area" });
  await expect(holdingLink).toHaveAttribute("href", /\/library\?.*view=local-orphans/);
  await expect(holdingLink).toHaveAttribute("href", /held=true/);
});

test("the logs page shows a purge's progress and opens the same status window", async ({ page }) => {
  await mockApi(page);
  await page.goto(`${baseUrl}/logs?job=1931`);
  const detail = page.getByRole("region", { name: "Job #1931 details" });
  await expect(detail.getByRole("group", { name: "Purge progress" })).toBeVisible();
  await detail.getByRole("button", { name: "View purge status" }).click();
  const dialog = page.getByRole("dialog", { name: "Orphan purge" });
  await expect(dialog.getByRole("list", { name: "Failed items" })).toBeVisible();
});

test("a purge whose deleted files came back lists them apart from the deleted ones", async ({ page }) => {
  const itemRequests = await mockApi(page);
  await page.goto(`${baseUrl}/`);
  const table = page.getByRole("table", { name: "Recent jobs" });
  await table.getByRole("button", { name: "View purge status for job #1933" }).click();

  const dialog = page.getByRole("dialog", { name: "Orphan purge" });
  const panel = dialog.getByRole("group", { name: "Purge progress" });
  await expect(panel.getByText("Partially failed").first()).toBeVisible();
  await expect(panel.locator("span", { hasText: /^[\d,]+Deleted$/ }).locator("strong")).toHaveText("4");
  await expect(panel.locator("span", { hasText: /^[\d,]+Came back$/ }).locator("strong")).toHaveText("2");
  await expect(panel.locator("span", { hasText: /^[\d,]+Resurfaced copy deleted$/ }).locator("strong")).toHaveText("1");
  await expect(panel.locator("span", { hasText: /^[\d,]+Keeps coming back$/ }).locator("strong")).toHaveText("1");
  await expect(panel.locator("span", { hasText: /^[\d,]+Listed, not readable$/ }).locator("strong")).toHaveText("3");
  await expect(panel.locator("p", { hasText: "Came back:" })).toContainText("India.Juliet.2003.mkv: Storage showed the file again 2 minutes after the delete");
  await expect(panel.getByText("Checked 6 deleted remote items again 2 minutes after the last delete. 2 came back and are not counted as deleted.")).toBeVisible();

  const cameBack = dialog.getByRole("list", { name: "Came back after the delete" });
  await expect(cameBack.getByRole("listitem")).toHaveCount(2);
  await expect(cameBack.getByText("Storage listed the file again 2 minutes after the delete, but it could not be opened")).toBeVisible();
  await expect(cameBack.getByText("Came back", { exact: true })).toHaveCount(2);
  await expect(dialog.getByRole("list", { name: "Failed items" })).toHaveCount(0);
  await expect(dialog.getByRole("link", { name: "Open holding area" })).toHaveCount(0);
  const keeps = dialog.getByRole("list", { name: "Keeps coming back" });
  await expect(keeps.getByText(/after each of 3 deletes, so it was left in place/)).toBeVisible();
  const again = dialog.getByRole("list", { name: "Deleted again after another copy appeared" });
  await expect(again.getByText("Deleted 2 times")).toBeVisible();
  await expect(again.getByText("Another copy appeared at the same path after the delete and was deleted too (2 deletes in all)")).toBeVisible();
  expect(itemRequests.every((search) => /outcome=(came_back|keeps_coming_back|resurfaced)/.test(search))).toBe(true);
});
