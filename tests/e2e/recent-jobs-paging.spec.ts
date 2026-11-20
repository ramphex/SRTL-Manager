import { expect, test, type Page } from "@playwright/test";
import type { JobPage, JobRecord } from "../../src/shared/types";

const baseUrl = process.env.SRTL_E2E_BASE_URL;
test.skip(!baseUrl, "Set SRTL_E2E_BASE_URL to run browser checks.");

function job(id: number): JobRecord {
  const at = new Date(Date.now() - (100 - id) * 60_000).toISOString();
  const type = id % 5 === 0 ? "audit" : "scan";
  return { id, type, status: "completed", createdAt: at, startedAt: at, finishedAt: at, options: {}, progress: {} };
}

// 25 jobs, newest first; every fifth one is an audit.
const jobs = Array.from({ length: 25 }, (_, index) => job(25 - index));

async function mockApi(page: Page) {
  const pageRequests: URLSearchParams[] = [];
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    let body: unknown = [];
    if (url.pathname === "/api/auth/me") body = { setupRequired: false, authenticated: true, user: { id: 1, username: "integration-test", role: "owner", mustChangePassword: false } };
    else if (url.pathname === "/api/system/path-migration") body = { status: "ready", blocking: false, activePaths: {}, detectedPaths: {}, environmentErrors: [], changes: [], migration: null };
    else if (url.pathname === "/api/onboarding") body = { required: false, phase: "completed" };
    else if (url.pathname === "/api/settings/user-preferences") body = { timeFormat: "24h", autoOpenTaskStatus: false, recentJobsCompletedWindowMinutes: 1440 };
    else if (url.pathname === "/api/settings/sections") body = { sections: ["movies"], sectionTitles: { movies: "Family Films" }, sectionTypes: { movies: "movies" } };
    else if (url.pathname === "/api/settings/paths") body = { symlinkDir: "/links", localDir: "/local", remoteDir: "/remote" };
    else if (url.pathname === "/api/inventory/scan-timestamps") body = { symlinkSections: {}, localSections: {}, remoteRoot: null };
    else if (url.pathname === "/api/settings/scan") body = { scanSymlinks: true, scanLocal: true, scanRemote: true };
    else if (url.pathname === "/api/settings/audit") body = { sections: [], targets: ["local", "remote"] };
    else if (url.pathname === "/api/settings/advanced") body = {};
    else if (url.pathname === "/api/settings/storage-locations") body = { locations: [{ key: "location_1", rootType: "local", displayName: "Home NAS", path: "/local" }, { key: "location_2", rootType: "remote", displayName: "Archive", path: "/remote" }] };
    else if (url.pathname === "/api/system/version") {
      const release = { latestVersion: "0.1.5-beta.7", updateAvailable: false, status: "up_to_date", releaseUrl: null };
      body = { currentVersion: "0.1.5-beta.7", currentChannel: "beta", currentChannelLabel: "Beta", stable: { ...release, channel: "stable" }, beta: { ...release, channel: "beta" }, ...release };
    } else if (url.pathname === "/api/jobs/page") {
      pageRequests.push(url.searchParams);
      const search = url.searchParams.get("q")?.toLowerCase() ?? "";
      const offset = Number(url.searchParams.get("offset") ?? 0);
      const limit = Number(url.searchParams.get("limit") ?? 10);
      const matching = search ? jobs.filter((entry) => entry.type.includes(search)) : jobs;
      const shown = matching.slice(offset, offset + limit);
      const result: JobPage = { jobs: shown, hasMore: offset + shown.length < matching.length, nextOffset: offset + shown.length };
      body = result;
    }
    await route.fulfill({ json: body });
  });
  return pageRequests;
}

test("the library overview shows ten jobs, loads ten more per Show more, and searches on the server", async ({ page }) => {
  const pageRequests = await mockApi(page);
  await page.goto(`${baseUrl}/library`);
  const table = page.getByRole("table", { name: "Recent jobs" });
  await expect(table.locator("tbody tr")).toHaveCount(10);
  const showMore = page.getByRole("button", { name: "Show more" });
  await showMore.click();
  await expect(table.locator("tbody tr")).toHaveCount(20);
  await showMore.click();
  await expect(table.locator("tbody tr")).toHaveCount(25);
  await expect(showMore).toHaveCount(0);

  await page.getByRole("button", { name: "Search jobs" }).click();
  const search = page.getByRole("searchbox", { name: "Search jobs" });
  await expect(search).toBeFocused();
  await search.pressSequentially("audit", { delay: 30 });
  await expect(table.locator("tbody tr")).toHaveCount(5);
  expect(pageRequests.filter((params) => params.get("q")).map((params) => params.get("q"))).toEqual(["audit"]);

  await search.fill("nothing-like-this");
  await expect(page.getByText("No jobs match “nothing-like-this”.")).toBeVisible();

  // Closing the search goes back to the list as it was left.
  await search.press("Escape");
  await expect(search).toHaveCount(0);
  await expect(table.locator("tbody tr")).toHaveCount(25);

  // Leaving the Library overview and coming back starts folded again.
  await page.getByRole("link", { name: "Logs", exact: true }).click();
  // Wait for the Logs page itself: until its code loads, the Library is only hidden, not closed.
  await expect(page.getByRole("heading", { name: "Logs", exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Library", exact: true }).click();
  await expect(table.locator("tbody tr")).toHaveCount(10);
});
