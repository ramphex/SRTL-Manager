import { expect, test, type Page, type Route } from "@playwright/test";
import type { CopyRetryPlan, JobRecord } from "../../src/shared/types";

const baseUrl = process.env.SRTL_E2E_BASE_URL;
test.skip(!baseUrl, "Set SRTL_E2E_BASE_URL to run browser checks.");

function copyJob(id: number, status: JobRecord["status"], options: Record<string, unknown> = {}): JobRecord {
  const at = new Date(Date.now() - 60_000).toISOString();
  return {
    id,
    type: "copy",
    status,
    createdAt: at,
    startedAt: at,
    finishedAt: at,
    options: { direction: "to_local", ...options },
    progress: { total: 5, copied: 2, failed: 3, stage: status, message: "Copy job partially failed" }
  } as JobRecord;
}

function retryPlan(jobId: number, overrides: Partial<CopyRetryPlan> = {}): CopyRetryPlan {
  return { jobId, direction: "to_local", totalFailed: 3, retryCount: 3, skippedCount: 0, skipped: [], notReachedCount: 0, replaceOffered: false, deleteRemoteSourceOffered: false, summary: "", ...overrides };
}

interface MockOptions {
  role?: "owner" | "moderator";
  jobs: JobRecord[];
  plans?: Record<number, CopyRetryPlan>;
  onRetry?: (route: Route, jobId: number, body: unknown) => Promise<void> | void;
}

/** Answers every API call, and returns the bodies of the retries the page sent. */
async function mockApi(page: Page, { role = "owner", jobs, plans = {}, onRetry }: MockOptions) {
  const posted: Array<{ jobId: number; body: unknown }> = [];
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const retry = /^\/api\/jobs\/(\d+)\/copy-retry$/.exec(url.pathname);
    if (retry) {
      const jobId = Number(retry[1]);
      if (route.request().method() === "POST") {
        const body: unknown = route.request().postDataJSON();
        posted.push({ jobId, body });
        if (onRetry) await onRetry(route, jobId, body);
        else await route.fulfill({ json: { jobId: 900, retried: plans[jobId]?.retryCount ?? 0, skipped: plans[jobId]?.skippedCount ?? 0, summary: plans[jobId]?.summary ?? "", deleteRemoteSources: false } });
        return;
      }
      await route.fulfill({ json: plans[jobId] ?? retryPlan(jobId, { totalFailed: 0, retryCount: 0 }) });
      return;
    }
    const single = /^\/api\/jobs\/(\d+)$/.exec(url.pathname);
    let body: unknown = [];
    if (single) body = jobs.find((job) => job.id === Number(single[1])) ?? copyJob(Number(single[1]), "queued");
    else if (url.pathname === "/api/auth/me") body = { setupRequired: false, authenticated: true, user: { id: 1, username: "integration-test", role, mustChangePassword: false } };
    else if (url.pathname === "/api/system/path-migration") body = { status: "ready", blocking: false, activePaths: {}, detectedPaths: {}, environmentErrors: [], changes: [], migration: null };
    else if (url.pathname === "/api/onboarding") body = { required: false, phase: "completed" };
    else if (url.pathname === "/api/settings/user-preferences") body = { timeFormat: "24h", autoOpenTaskStatus: false, recentJobsCompletedWindowMinutes: 1440 };
    else if (url.pathname === "/api/settings/sections") body = { sections: ["movies"], sectionTitles: { movies: "Family Films" }, sectionTypes: { movies: "movies" } };
    else if (url.pathname === "/api/inventory/summary") body = { totalLinks: 0, remoteLinks: 10, localLinks: 5, brokenLinks: 0, otherLinks: 0, nonMediaLinks: 0, actionableRemoteLinks: 0, actionableLocalLinks: 0, assignedRemoteLinks: 0, unassignedRemoteLinks: 0, unassignedLocalLinks: 0, localFiles: 20, remoteFiles: 30, actionableRemoteFiles: 0, actionableLocalFiles: 0, assignedRemoteFiles: 0, unassignedRemoteFiles: 0, unassignedLocalFiles: 0, localOrphanFiles: 4, remoteOrphanFiles: 5, missingLinks: 0, missingLocalFiles: 0, missingRemoteFiles: 0 };
    else if (url.pathname === "/api/settings/paths") body = { symlinkDir: "/links", localDir: "/local", remoteDir: "/remote" };
    else if (url.pathname === "/api/inventory/scan-timestamps") body = { symlinkSections: {}, localSections: {}, remoteRoot: null };
    else if (url.pathname === "/api/settings/scan") body = { scanSymlinks: true, scanLocal: true, scanRemote: true };
    else if (url.pathname === "/api/settings/audit") body = { sections: [], targets: ["local", "remote"] };
    else if (url.pathname === "/api/settings/advanced") body = {};
    else if (url.pathname === "/api/settings/storage-locations") body = { locations: [{ key: "location_1", rootType: "local", displayName: "Home NAS", path: "/local" }, { key: "location_2", rootType: "remote", displayName: "Archive", path: "/remote" }] };
    else if (url.pathname === "/api/system/version") {
      const release = { latestVersion: "0.1.4-beta.4", updateAvailable: false, status: "up_to_date", releaseUrl: null };
      body = { currentVersion: "0.1.4-beta.4", currentChannel: "beta", currentChannelLabel: "Beta", stable: { ...release, channel: "stable" }, beta: { ...release, channel: "beta" }, ...release };
    } else if (url.pathname === "/api/jobs") body = jobs;
    else if (url.pathname.endsWith("/events/page")) body = { events: [], total: 0, hasOlder: false };
    else if (url.pathname.endsWith("/copy-failures")) body = { jobId: 0, totalFailures: 0, eligibleCount: 0, unidentifiedCount: 0, items: [] };
    await route.fulfill({ json: body });
  });
  return posted;
}

function recentJobs(page: Page) {
  return page.getByRole("table", { name: "Recent jobs" });
}

test("the jobs list says how many items a retry covers, and one click starts it", async ({ page }) => {
  const posted = await mockApi(page, { jobs: [copyJob(41, "partially_failed")], plans: { 41: retryPlan(41) } });
  await page.goto(`${baseUrl}/`);
  const button = recentJobs(page).getByRole("button", { name: "Retry 3 failed items from job #41" });
  await expect(button).toHaveText("Retry failed (3)");
  await button.click();
  await expect(recentJobs(page).getByRole("status")).toHaveText("Job #900 is retrying 3 failed items.");
  expect(posted).toEqual([{ jobId: 41, body: {} }]);
});

test("a retry already on its way is not sent twice by a double click", async ({ page }) => {
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const posted = await mockApi(page, {
    jobs: [copyJob(42, "failed")],
    plans: { 42: retryPlan(42, { totalFailed: 1, retryCount: 1 }) },
    onRetry: async (route) => {
      await held;
      await route.fulfill({ json: { jobId: 901, retried: 1, skipped: 0, summary: "", deleteRemoteSources: false } });
    }
  });
  await page.goto(`${baseUrl}/`);
  const button = recentJobs(page).getByRole("button", { name: "Retry 1 failed item from job #42" });
  await button.dblclick();
  await expect(button).toBeDisabled();
  await expect(button).toHaveText("Retrying...");
  release();
  await expect(recentJobs(page).getByRole("status")).toHaveText("Job #901 is retrying 1 failed item.");
  expect(posted).toHaveLength(1);
});

test("says what was skipped and why when it starts", async ({ page }) => {
  const summary = "Skipping 2: 1 already copied, 1 with a link that is gone or missing.";
  await mockApi(page, { jobs: [copyJob(43, "partially_failed")], plans: { 43: retryPlan(43, { retryCount: 1, skippedCount: 2, summary }) } });
  await page.goto(`${baseUrl}/`);
  const button = recentJobs(page).getByRole("button", { name: "Retry 1 failed item from job #43" });
  await expect(button).toHaveText("Retry failed (1)");
  await expect(button).toHaveAttribute("title", summary);
  await button.click();
  await expect(recentJobs(page).getByRole("status")).toHaveText(`Job #900 is retrying 1 failed item. ${summary}`);
});

test("explains itself instead of starting an empty job when everything was skipped", async ({ page }) => {
  const summary = "Nothing to retry: 3 already copied.";
  const posted = await mockApi(page, { jobs: [copyJob(44, "failed")], plans: { 44: retryPlan(44, { retryCount: 0, skippedCount: 3, summary }) } });
  await page.goto(`${baseUrl}/`);
  const button = recentJobs(page).getByRole("button", { name: "Nothing to retry from job #44" });
  await expect(button).toHaveAttribute("aria-expanded", "false");
  await expect(recentJobs(page).getByText(summary)).toHaveCount(0);
  await button.click();
  await expect(recentJobs(page).getByText(summary)).toBeVisible();
  expect(posted).toEqual([]);

  await page.getByRole("button", { name: "View copy progress for job #44" }).click();
  const dialog = page.locator(".copy-dialog");
  await expect(dialog.getByText(summary)).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Nothing to retry from job #44" })).toBeDisabled();
});

test("shows nothing for a job with no failed items, or that is not finished", async ({ page }) => {
  await mockApi(page, { jobs: [copyJob(45, "completed"), copyJob(46, "running"), copyJob(47, "failed")] });
  await page.goto(`${baseUrl}/`);
  await expect(recentJobs(page).locator("tbody tr")).toHaveCount(3);
  await expect(recentJobs(page).locator(".copy-retry-button")).toHaveCount(0);
});

test("shows the server's refusal", async ({ page }) => {
  await mockApi(page, {
    jobs: [copyJob(48, "failed")],
    plans: { 48: retryPlan(48) },
    onRetry: (route) => route.fulfill({ status: 409, json: { error: "Nothing to retry: 3 already queued in job #77." } })
  });
  await page.goto(`${baseUrl}/`);
  await recentJobs(page).getByRole("button", { name: "Retry 3 failed items from job #48" }).click();
  await expect(recentJobs(page).getByRole("alert")).toHaveText("Nothing to retry: 3 already queued in job #77.");
});

test("the job's own page offers it, then follows the new job", async ({ page }) => {
  const posted = await mockApi(page, { jobs: [copyJob(49, "partially_failed")], plans: { 49: retryPlan(49) } });
  await page.goto(`${baseUrl}/`);
  await page.getByRole("button", { name: "View copy progress for job #49" }).click();
  const dialog = page.locator(".copy-dialog");
  await dialog.getByRole("button", { name: "Retry 3 failed items from job #49" }).click();
  await expect(dialog.getByRole("status").filter({ hasText: "Job #900 is retrying 3 failed items." })).toBeVisible();
  await expect(dialog.getByText("Job #900 -")).toBeVisible();
  expect(posted).toEqual([{ jobId: 49, body: {} }]);
});

test("the logs page offers it on the selected job", async ({ page }) => {
  await mockApi(page, { jobs: [copyJob(50, "failed")], plans: { 50: retryPlan(50, { totalFailed: 2, retryCount: 2 }) } });
  await page.goto(`${baseUrl}/logs`);
  await expect(page.getByRole("region", { name: "Job #50 details" }).getByRole("button", { name: "Retry 2 failed items from job #50" })).toBeVisible();
});

test("asks before replacing or deleting, and removes nothing unless it is ticked", async ({ page }) => {
  const posted = await mockApi(page, {
    jobs: [copyJob(51, "failed", { localConflictStrategy: "replace" })],
    plans: { 51: retryPlan(51, { replaceOffered: true, deleteRemoteSourceOffered: true }) }
  });
  await page.goto(`${baseUrl}/`);
  await recentJobs(page).getByRole("button", { name: "Retry 3 failed items from job #51" }).click();
  expect(posted).toEqual([]);
  const dialog = page.getByRole("dialog", { name: "Retry 3 failed items from job #51" });
  const replace = dialog.getByRole("checkbox", { name: /Replace existing local files/ });
  const remove = dialog.getByRole("checkbox", { name: /Delete remote sources/ });
  await expect(replace).not.toBeChecked();
  await expect(remove).not.toBeChecked();
  await dialog.getByRole("button", { name: "Retry 3 failed items" }).click();
  await expect(dialog).toHaveCount(0);
  expect(posted).toEqual([{ jobId: 51, body: { replaceExisting: false, deleteRemoteSources: false } }]);
});

test("sends a replacement only when asked for", async ({ page }) => {
  const posted = await mockApi(page, {
    jobs: [copyJob(52, "failed", { localConflictStrategy: "replace" })],
    plans: { 52: retryPlan(52, { replaceOffered: true }) }
  });
  await page.goto(`${baseUrl}/`);
  await recentJobs(page).getByRole("button", { name: "Retry 3 failed items from job #52" }).click();
  const dialog = page.getByRole("dialog", { name: "Retry 3 failed items from job #52" });
  await expect(dialog.getByRole("checkbox", { name: /Delete remote sources/ })).toHaveCount(0);
  await dialog.getByRole("checkbox", { name: /Replace existing local files/ }).check();
  await dialog.getByRole("button", { name: "Retry 3 failed items" }).click();
  await expect(dialog).toHaveCount(0);
  expect(posted).toEqual([{ jobId: 52, body: { replaceExisting: true, deleteRemoteSources: false } }]);
});

test("a moderator is told a replacing job will keep both, and cannot choose otherwise", async ({ page }) => {
  const posted = await mockApi(page, {
    role: "moderator",
    jobs: [copyJob(53, "failed", { localConflictStrategy: "replace" })],
    plans: { 53: retryPlan(53, { replaceOffered: true, deleteRemoteSourceOffered: true }) }
  });
  await page.goto(`${baseUrl}/`);
  await recentJobs(page).getByRole("button", { name: "Retry 3 failed items from job #53" }).click();
  const dialog = page.getByRole("dialog", { name: "Retry 3 failed items from job #53" });
  await expect(dialog.getByText("Your retry will keep both")).toBeVisible();
  await expect(dialog.getByRole("checkbox")).toHaveCount(0);
  await dialog.getByRole("button", { name: "Retry 3 failed items" }).click();
  await expect(dialog).toHaveCount(0);
  expect(posted).toEqual([{ jobId: 53, body: { replaceExisting: false, deleteRemoteSources: false } }]);
});

test("a moderator gets one click when only the remote delete was on, and no button for a copy to remote", async ({ page }) => {
  const posted = await mockApi(page, {
    role: "moderator",
    jobs: [copyJob(54, "failed"), copyJob(55, "failed", { direction: "to_remote" })],
    plans: { 54: retryPlan(54, { deleteRemoteSourceOffered: true }), 55: retryPlan(55, { direction: "to_remote" }) }
  });
  await page.goto(`${baseUrl}/`);
  await expect(recentJobs(page).locator(".copy-retry-button")).toHaveCount(1);
  await recentJobs(page).getByRole("button", { name: "Retry 3 failed items from job #54" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect.poll(() => posted).toEqual([{ jobId: 54, body: {} }]);
});

test("fits a phone, with its explanation open", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const summary = "Nothing to retry: 2 already copied, 1 with a link that is gone or missing, 3 already queued in job #1234567.";
  await mockApi(page, { jobs: [copyJob(56, "failed"), copyJob(57, "partially_failed")], plans: { 56: retryPlan(56, { retryCount: 0, skippedCount: 6, totalFailed: 6, summary }), 57: retryPlan(57) } });
  await page.goto(`${baseUrl}/`);
  await page.getByRole("button", { name: "Nothing to retry from job #56" }).click();
  await expect(page.getByText(summary)).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});
