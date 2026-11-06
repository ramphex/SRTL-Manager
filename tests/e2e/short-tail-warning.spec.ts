import { expect, test, type Page } from "@playwright/test";

const baseUrl = process.env.SRTL_E2E_BASE_URL;
test.skip(!baseUrl, "Set SRTL_E2E_BASE_URL to run browser checks.");

const warning = "File is 48 bytes shorter than its header declares; accepted because ffmpeg still read it to the end";
const timestamp = new Date().toISOString();

async function mockApi(page: Page, job: Record<string, unknown>, responses: Record<string, unknown>) {
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    let body: unknown = {};
    if (url.pathname === "/api/auth/me") body = { setupRequired: false, authenticated: true, user: { id: 1, username: "integration-test", role: "owner", mustChangePassword: false } };
    else if (url.pathname === "/api/system/path-migration") body = { status: "ready", blocking: false, activePaths: {}, detectedPaths: {}, environmentErrors: [], changes: [], migration: null };
    else if (url.pathname === "/api/onboarding") body = { required: false, phase: "completed" };
    else if (url.pathname === "/api/settings/user-preferences") body = { timeFormat: "24h", autoOpenTaskStatus: false, recentJobsCompletedWindowMinutes: 1440 };
    else if (url.pathname === "/api/settings/sections") body = { sections: [], sectionTitles: {}, sectionTypes: {} };
    else if (url.pathname === "/api/settings/paths") body = { symlinkDir: "/links", localDir: "/local", remoteDir: "/remote" };
    else if (url.pathname === "/api/settings/scan") body = { scanSymlinks: false, scanLocal: false, scanRemote: false, symlinkSections: [], localSections: [] };
    else if (url.pathname === "/api/settings/audit") body = { sections: [], targets: ["local", "remote"] };
    else if (url.pathname === "/api/settings/storage-locations") body = { locations: [{ key: "location_1", rootType: "local", displayName: "Local", path: "/local" }, { key: "location_2", rootType: "remote", displayName: "Remote", path: "/remote" }] };
    else if (url.pathname === "/api/inventory/scan-timestamps") body = { symlinkSections: {}, localSections: {}, remoteRoot: null };
    else if (url.pathname === "/api/sections") body = [];
    else if (url.pathname === "/api/system/version") {
      const release = { latestVersion: "0.1.4-beta.1", updateAvailable: false, status: "up_to_date", releaseUrl: null };
      body = { currentVersion: "0.1.4-beta.1", currentChannel: "beta", currentChannelLabel: "Beta", stable: { ...release, channel: "stable" }, beta: { ...release, channel: "beta" }, ...release };
    } else if (url.pathname === `/api/jobs/${String(job.id)}`) body = job;
    else if (url.pathname === "/api/jobs") body = [job];
    else if (url.pathname in responses) body = responses[url.pathname];
    await route.fulfill({ json: body });
  });
}

test("a copy accepted with a warning reads as completed and shows the warning on its item and in its events", async ({ page }) => {
  const jobId = 910001;
  const data = { itemName: "Short Tail Title (2026)", linkPath: "/links/short.mkv", sourcePath: "/remote/short.mkv", destinationPath: "/local/short.mkv", warning };
  const events = [
    { id: 1, jobId, timestamp, level: "info", message: "Verified copy installed", data },
    { id: 2, jobId, timestamp, level: "warn", message: warning, data }
  ];
  const job = {
    id: jobId,
    type: "copy",
    status: "completed",
    createdAt: timestamp,
    startedAt: timestamp,
    finishedAt: timestamp,
    options: { direction: "to_local" },
    progress: { options: { direction: "to_local", itemName: "Short Tail Title (2026)" }, stage: "completed", message: "Copy job completed", total: 1, current: 1, copied: 1, repointed: 0, conflicts: 0, failed: 0 }
  };
  await mockApi(page, job, { [`/api/jobs/${jobId}/events/page`]: { events, total: events.length, hasOlder: false } });

  await page.goto(baseUrl!);
  await page.getByRole("button", { name: `View copy progress for job #${jobId}`, exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.locator(".copy-progress-stat-bad")).toHaveCount(0);
  await dialog.getByRole("button", { name: "View 1 completed item", exact: true }).hover();
  const details = dialog.getByRole("region", { name: "Completed item details", exact: true });
  await expect(details).toContainText("Copied and symlinked");
  await expect(details).toContainText(warning);
  await expect(dialog.locator(".event-warn")).toContainText(warning);
  await expect(dialog.locator(".event-warn")).toContainText("Warning");
});

test("an audit lists an accepted short tail as a warning, not a failure", async ({ page }) => {
  const jobId = 910002;
  const job = {
    id: jobId,
    type: "audit",
    status: "completed",
    createdAt: timestamp,
    startedAt: timestamp,
    finishedAt: timestamp,
    options: { mode: "fast" },
    progress: { options: { mode: "fast" }, stage: "completed", message: "Audit completed", total: 1, checked: 1, passed: 1, failed: 0 }
  };
  const run = { id: 77, jobId, status: "completed", checked: 1, passed: 1, failed: 0, sourceUnknown: 0, sourceMissing: 0, sourceCompareErrors: 0, byteMismatches: 0, targetValidationFailures: 0, startedAt: timestamp, finishedAt: timestamp, errorMessage: null, options: { mode: "fast" } };
  const result = { id: 1, auditRunId: 77, linkPath: "/links/short.mkv", targetPath: "/local/short.mkv", sourcePath: null, status: "warning", ffmpegStatus: "pass", cmpStatus: "source_unknown", message: `Passed ffmpeg; source unknown. ${warning}`, createdAt: timestamp };
  await mockApi(page, job, {
    [`/api/audits/job/${jobId}`]: run,
    "/api/audits/77/results/page": { results: [result], total: 1, offset: 0, hasMore: false },
    [`/api/jobs/${jobId}/events/page`]: { events: [], total: 0, hasOlder: false }
  });

  await page.goto(baseUrl!);
  await page.getByRole("button", { name: `View audit status for job #${jobId}`, exact: true }).click();
  const findings = page.getByRole("dialog").getByRole("region", { name: "Audit findings" });
  await expect(findings).toContainText(warning);
  await expect(findings.locator(".pill-warning")).toHaveText("Warning");
  await expect(findings).not.toContainText("Failed");
});
