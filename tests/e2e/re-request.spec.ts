import { expect, test, type Page } from "@playwright/test";

const baseUrl = process.env.SRTL_E2E_BASE_URL;
test.skip(!baseUrl, "Set SRTL_E2E_BASE_URL to run browser checks.");

const preview = {
  total: 2,
  eligibleCount: 1,
  instances: [{ service: "radarr", instanceName: "Radarr 4K", count: 1 }],
  ineligible: [{ reason: "This title is not in Radarr.", count: 1, examples: ["Nobody.mkv"] }]
};

function damagedRow(id: number, name: string, extra: Record<string, unknown> = {}) {
  return { storageFileId: id, section: "movies", itemName: name, relativePath: `movies/${name}/${name}.mkv`, filePath: `/local/movies/${name}/${name}.mkv`, sizeBytes: 1_000_000, allocatedBytes: 0, storedPercent: 0, integrity: "hollow", zeroSamples: null, zeroSamplesTotal: 24, checkedAt: null, linked: true, remoteCopyExists: false, protectedReason: null, ...extra };
}

function orphanItem(id: number, name: string) {
  return { storageFileId: id, rootType: "local", relativePath: `movies/${name}/${name}.mkv`, filePath: `/local/movies/${name}/${name}.mkv`, section: "movies", itemName: name, sizeBytes: 1_000_000, mtimeMs: 0, category: "not_in_library", label: "not_in_library", matchedTitle: null, releaseName: name, releaseStatus: "none_linked", releaseFileCount: 1, releaseLinkedCount: 0, linkedSizeBytes: null, sizeComparison: null, episodeCoverage: null, extraLinkPath: null, protectedReason: null, hollow: false };
}

interface Options {
  role?: "owner" | "moderator";
  failedRows?: boolean;
}

async function fixture(page: Page, options: Options = {}) {
  const posts = { damaged: [] as unknown[], orphans: [] as unknown[], previews: [] as unknown[], retries: [] as unknown[] };
  let failed = options.failedRows ?? false;
  const listRows = () => [
    { id: 1, jobId: 42, displayName: "Alpha.mkv", service: "radarr", instanceName: "Radarr 4K", title: "Alpha (2020)", episodes: null, status: "requested", message: null, previousMonitored: false, attempts: 1, createdAt: "2026-11-05T10:00:00.000Z", requestedAt: "2026-11-05T10:00:30.000Z" },
    { id: 2, jobId: 42, displayName: "Delta - S01E02.mkv", service: "sonarr", instanceName: "Sonarr", title: "Delta (2020)", episodes: "S01E02", status: failed ? "failed" : "pending", message: failed ? "Sonarr returned HTTP 500." : null, previousMonitored: true, attempts: 1, createdAt: "2026-11-05T10:00:00.000Z", requestedAt: null },
    { id: 3, jobId: 42, displayName: "Nobody.mkv", service: null, instanceName: null, title: null, episodes: null, status: "unmatched", message: "This title is not in Radarr.", previousMonitored: null, attempts: 0, createdAt: "2026-11-05T10:00:00.000Z", requestedAt: null }
  ];
  await page.context().route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    let body: unknown = [];
    if (url.pathname === "/api/auth/me") body = { setupRequired: false, authenticated: true, user: { id: 1, username: "integration-test", role: options.role ?? "owner", mustChangePassword: false } };
    else if (url.pathname === "/api/system/path-migration") body = { status: "ready", blocking: false, activePaths: {}, detectedPaths: {}, environmentErrors: [], changes: [], migration: null };
    else if (url.pathname === "/api/onboarding") body = { required: false, phase: "completed" };
    else if (url.pathname === "/api/settings/storage-locations") body = { locations: [{ key: "location_1", rootType: "local", displayName: "Home NAS", path: "/local" }, { key: "location_2", rootType: "remote", displayName: "Archive", path: "/remote" }] };
    else if (url.pathname === "/api/settings/user-preferences") body = { timeFormat: "24h", autoOpenTaskStatus: false, recentJobsCompletedWindowMinutes: 1440 };
    else if (url.pathname === "/api/inventory/summary") body = { totalLinks: 0, remoteLinks: 0, localLinks: 0, brokenLinks: 0, otherLinks: 0, nonMediaLinks: 0, actionableRemoteLinks: 0, actionableLocalLinks: 0, assignedRemoteLinks: 0, unassignedRemoteLinks: 0, unassignedLocalLinks: 0, localFiles: 2, remoteFiles: 0, actionableRemoteFiles: 0, actionableLocalFiles: 0, assignedRemoteFiles: 0, unassignedRemoteFiles: 0, unassignedLocalFiles: 0, localOrphanFiles: 2, remoteOrphanFiles: 0, missingLinks: 0, missingLocalFiles: 0, missingRemoteFiles: 0 };
    else if (url.pathname === "/api/damaged-files") body = [damagedRow(1, "Alpha"), damagedRow(2, "Nobody", { linked: false, remoteCopyExists: true }), damagedRow(3, "Fresh", { protectedReason: "Modified in the last 24 hours" })];
    else if (url.pathname === "/api/damaged-files/delete") { posts.damaged.push(request.postDataJSON()); body = { jobId: 42 }; }
    else if (url.pathname === "/api/orphans") body = { rootType: "local", items: [orphanItem(1, "Alpha"), orphanItem(2, "Nobody")], leftoverFolders: [], summary: [], labelSummary: [], hollowCount: 0, damagedCount: 0, symlinkInventoryAt: null, storageInventoryAt: null, staleWarning: null, storageStaleWarning: null, extraSymlinks: { folders: [], linkCount: 0, unmatchedCount: 0, problems: [] }, holdDays: 7 };
    else if (url.pathname === "/api/orphans/purge") { posts.orphans.push(request.postDataJSON()); body = { jobId: 42 }; }
    else if (url.pathname === "/api/re-requests/preview") { posts.previews.push(request.postDataJSON()); body = preview; }
    else if (url.pathname === "/api/re-requests/retry") { posts.retries.push(request.postDataJSON()); failed = false; body = { retried: 1 }; }
    else if (url.pathname === "/api/re-requests") body = { items: listRows(), counts: { queued: 0, pending: failed ? 0 : 1, requested: 1, failed: failed ? 1 : 0, unmatched: 1, skipped: 0 }, perMinute: 6 };
    else if (url.pathname === "/api/settings/sections") body = { sections: ["movies"], sectionTitles: { movies: "Movies" }, sectionTypes: { movies: "movies" } };
    else if (url.pathname === "/api/settings/paths") body = { symlinkDir: "/links", localDir: "/local", remoteDir: "/remote" };
    else if (url.pathname === "/api/inventory/scan-timestamps") body = { symlinkSections: {}, localSections: {}, remoteRoot: null };
    else if (url.pathname === "/api/settings/scan") body = { scanSymlinks: true, scanLocal: true, scanRemote: true };
    else if (url.pathname === "/api/settings/audit") body = { sections: [], targets: ["local", "remote"] };
    else if (url.pathname === "/api/settings/advanced") body = {};
    else if (url.pathname === "/api/jobs") body = [];
    else if (url.pathname === "/api/system/version") {
      const release = { latestVersion: "0.1.4-beta.1", updateAvailable: false, status: "up_to_date", releaseUrl: null };
      body = { currentVersion: "0.1.4-beta.1", currentChannel: "beta", currentChannelLabel: "Beta", stable: { ...release, channel: "stable" }, beta: { ...release, channel: "beta" }, ...release };
    }
    await route.fulfill({ json: body });
  });
  return posts;
}

test("damaged files: re-request stays off unless chosen, and says what it cannot do first", async ({ page }) => {
  const posts = await fixture(page);
  await page.goto(`${baseUrl}/library?view=damaged`);
  await expect(page.getByRole("checkbox", { name: /Fresh/ })).toBeDisabled();
  await expect(page.getByText("Protected: Modified in the last 24 hours")).toBeVisible();
  await page.getByRole("checkbox", { name: /Alpha/ }).check();
  await page.getByRole("button", { name: /Delete selected/ }).click();
  const confirm = page.getByRole("group", { name: "Confirm damaged file delete" });
  const option = confirm.getByRole("checkbox", { name: /search for a new copy/ });
  await expect(option).not.toBeChecked();
  await expect(confirm.getByText(/symlink is removed too/)).toBeVisible();
  // Nothing is looked up until it is chosen.
  expect(posts.previews).toEqual([]);
  await confirm.getByRole("button", { name: "Move to holding area" }).click();
  await expect(page.getByRole("status")).toContainText("#42");
  expect(posts.damaged).toEqual([{ storageFileIds: [1], mode: "hold", reRequest: false }]);

  await page.getByRole("checkbox", { name: /Alpha/ }).check();
  await page.getByRole("checkbox", { name: /Nobody/ }).check();
  await page.getByRole("button", { name: /Delete selected/ }).click();
  await expect(option).not.toBeChecked();
  await option.check();
  const summary = page.getByTestId("re-request-preview");
  await expect(summary).toContainText("1 of 2 files can be re-requested: 1 in Radarr 4K.");
  await expect(summary).toContainText("This title is not in Radarr.");
  await expect(summary).toContainText("Nobody.mkv");
  await expect(confirm.getByText(/has a remote copy/)).toBeVisible();
  expect(posts.previews).toEqual([{ storageFileIds: [1, 2] }]);
  await confirm.getByRole("button", { name: /Delete now/ }).click();
  await confirm.getByRole("button", { name: "Delete permanently" }).click();
  await expect.poll(() => posts.damaged.length).toBe(2);
  expect(posts.damaged[1]).toEqual({ storageFileIds: [1, 2], mode: "delete", reRequest: true });
});

test("orphan purges carry the same choice, in both the confirmation and purge all", async ({ page }) => {
  const posts = await fixture(page);
  await page.goto(`${baseUrl}/library?view=local-orphans`);
  await page.getByRole("checkbox", { name: "Select Alpha.mkv" }).check();
  // The choice sits in the selection bar, visible before anything is confirmed, and off by default.
  const bar = page.getByRole("region", { name: "Selected orphans" });
  const option = bar.getByRole("checkbox", { name: /search for a new copy/ });
  await expect(option).not.toBeChecked();
  await option.check();
  expect(posts.previews).toEqual([]);
  await bar.getByRole("button", { name: "Purge selected" }).click();
  const confirm = page.getByRole("group", { name: "Confirm orphan purge" });
  await expect(confirm.getByTestId("re-request-preview")).toContainText("1 in Radarr 4K");
  await confirm.getByRole("button", { name: "Move to holding area" }).click();
  await expect.poll(() => posts.orphans.length).toBe(1);
  expect(posts.orphans[0]).toMatchObject({ storageFileIds: [1], mode: "hold", reRequest: true });

  await page.getByRole("button", { name: "Purge all eligible" }).click();
  const dialog = page.getByRole("dialog", { name: "Purge all eligible orphans" });
  await expect(dialog.getByRole("checkbox", { name: /search for a new copy/ })).not.toBeChecked();
  await dialog.getByRole("button", { name: /^Hold 2 items/ }).click();
  await expect.poll(() => posts.orphans.length).toBe(2);
  expect(posts.orphans[1]).toMatchObject({ storageFileIds: [1, 2], reRequest: false });
});

test("shows each result, and retries what failed", async ({ page }) => {
  const posts = await fixture(page, { failedRows: true });
  await page.goto(`${baseUrl}/library?view=damaged`);
  const table = page.getByRole("region", { name: "Recent re-requests" }).or(page.getByLabel("Recent re-requests"));
  await expect(table.getByRole("row", { name: /Alpha \(2020\)/ })).toContainText("Search sent");
  await expect(table.getByRole("row", { name: /Alpha \(2020\)/ })).toContainText("Was unmonitored; monitored now.");
  await expect(table.getByRole("row", { name: /Nobody.mkv/ })).toContainText("No match");
  await expect(table.getByRole("row", { name: /Nobody.mkv/ })).toContainText("This title is not in Radarr.");
  const failed = table.getByRole("row", { name: /Delta \(2020\) S01E02/ });
  await expect(failed).toContainText("Sonarr returned HTTP 500.");
  await failed.getByRole("button", { name: "Retry" }).click();
  await expect.poll(() => posts.retries.length).toBe(1);
  expect(posts.retries[0]).toEqual({ ids: [2] });
  await expect(failed).toContainText("Waiting its turn");
  await expect(page.getByRole("button", { name: /Retry all failed/ })).toHaveCount(0);
});

test("moderators see damaged files read-only", async ({ page }) => {
  const posts = await fixture(page, { role: "moderator" });
  await page.goto(`${baseUrl}/library?view=damaged`);
  await expect(page.getByRole("heading", { name: "Damaged files" })).toBeVisible();
  await expect(page.getByText("Alpha", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("checkbox")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Delete selected/ })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Re-requests" })).toHaveCount(0);
  expect(posts.previews).toEqual([]);
});

test("the dashboard link opens the damaged files tab and the address keeps it there", async ({ page }) => {
  await fixture(page);
  const damagedTab = page.getByRole("button", { name: "Damaged files" });
  await page.goto(`${baseUrl}/`);
  await page.getByRole("link", { name: "Library → Damaged files" }).click();
  await expect(page.getByRole("heading", { name: "Damaged files" })).toBeVisible();
  await expect(damagedTab).toHaveClass("selected");
  await expect(page).toHaveURL(/\/library\?view=damaged$/);

  await page.reload();
  await expect(page.getByRole("heading", { name: "Damaged files" })).toBeVisible();
  await expect(damagedTab).toHaveClass("selected");

  await page.goBack();
  await expect(page.getByRole("heading", { name: "Dashboard", exact: true })).toBeVisible();
  await page.goForward();
  await expect(page.getByRole("heading", { name: "Damaged files" })).toBeVisible();
  await expect(damagedTab).toHaveClass("selected");
});

test("the dashboard link opens the damaged files tab in a new browser tab", async ({ page }) => {
  await fixture(page);
  await page.goto(`${baseUrl}/`);
  const opened = page.context().waitForEvent("page");
  await page.getByRole("link", { name: "Library → Damaged files" }).click({ modifiers: ["ControlOrMeta"] });
  const newTab = await opened;
  await expect(newTab.getByRole("heading", { name: "Damaged files" })).toBeVisible();
  await expect(newTab.getByRole("button", { name: "Damaged files" })).toHaveClass("selected");
  await expect(page.getByRole("heading", { name: "Dashboard", exact: true })).toBeVisible();
});

test("the dashboard link takes a moderator to the read-only damaged files tab", async ({ page }) => {
  await fixture(page, { role: "moderator" });
  await page.goto(`${baseUrl}/`);
  await page.getByRole("link", { name: "Library → Damaged files" }).click();
  await expect(page.getByRole("heading", { name: "Not allowed" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Damaged files" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Damaged files" })).toHaveClass("selected");
  await expect(page.getByRole("checkbox")).toHaveCount(0);
});

test("the confirmation fits a phone", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await fixture(page);
  await page.goto(`${baseUrl}/library?view=damaged`);
  await page.getByRole("checkbox", { name: /Alpha/ }).check();
  await page.getByRole("button", { name: /Delete selected/ }).click();
  await page.getByRole("checkbox", { name: /search for a new copy/ }).check();
  await expect(page.getByTestId("re-request-preview")).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});
