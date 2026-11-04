import { expect, test, type Page } from "@playwright/test";
import type { JobRecord } from "../../src/shared/types";

const baseUrl = process.env.SRTL_E2E_BASE_URL;
test.skip(!baseUrl, "Set SRTL_E2E_BASE_URL to run browser checks.");

function rescan(id: number, itemName: string, status: JobRecord["status"] = "completed"): JobRecord {
  const at = new Date(Date.now() - (10 - id) * 60_000).toISOString();
  return { id, type: "scan", status, createdAt: at, startedAt: at, finishedAt: at, options: { scanSymlinks: true, titleScopes: [{ section: "movies", itemName }] }, progress: {} };
}

async function mockApi(page: Page, jobs: JobRecord[]) {
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    let body: unknown = [];
    if (url.pathname === "/api/auth/me") body = { setupRequired: false, authenticated: true, user: { id: 1, username: "integration-test", role: "owner", mustChangePassword: false } };
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
      const release = { latestVersion: "0.1.4-beta.1", updateAvailable: false, status: "up_to_date", releaseUrl: null };
      body = { currentVersion: "0.1.4-beta.1", currentChannel: "beta", currentChannelLabel: "Beta", stable: { ...release, channel: "stable" }, beta: { ...release, channel: "beta" }, ...release };
    } else if (url.pathname === "/api/jobs") body = jobs;
    await route.fulfill({ json: body });
  });
}

test("consecutive rescans of one title collapse and expand with the chevron", async ({ page }) => {
  await mockApi(page, [rescan(5, "Other Film"), rescan(4, "The Gift of Deceit", "failed"), rescan(3, "The Gift of Deceit"), rescan(2, "The Gift of Deceit"), rescan(1, "Other Film")]);
  await page.goto(`${baseUrl}/`);
  const table = page.getByRole("table", { name: "Recent jobs" });
  await expect(table.locator("tbody tr")).toHaveCount(3);
  const toggle = table.getByRole("button", { name: /Expand 3 jobs · 1 failed/ });
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(table.getByText("1 failed", { exact: true })).toBeVisible();
  await expect(table.getByText(/^\d+ jobs/)).toHaveCount(0);
  await toggle.click();
  await expect(table.locator("tbody tr")).toHaveCount(6);
  await expect(table.getByRole("button", { name: /Collapse 3 jobs/ })).toHaveAttribute("aria-expanded", "true");
  await table.getByRole("button", { name: /Collapse 3 jobs/ }).click();
  await expect(table.locator("tbody tr")).toHaveCount(3);
});
