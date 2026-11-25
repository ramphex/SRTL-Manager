import { expect, test, type Page } from "@playwright/test";

const baseUrl = process.env.SRTL_E2E_BASE_URL;
test.skip(!baseUrl, "Set SRTL_E2E_BASE_URL to run browser checks.");

interface FixtureOptions {
  blocked?: boolean;
}

function brokenLink(id: number, section: string, itemName: string, fileName: string) {
  const relativePath = `${itemName}/${fileName}`;
  return {
    mediaLinkId: id, section, sectionTitle: section === "shows" ? "TV" : "Films", itemName, relativePath,
    linkPath: `/links/${section}/${relativePath}`, targetPath: `/remote/${section}/${relativePath}`, targetRoot: "remote",
    brokenSince: "2026-11-20T10:00:00.000Z", lastSeenAt: "2026-11-24T03:00:00.000Z"
  };
}

const items = [
  brokenLink(11, "movies", "Quiet Harbor (2011)", "Quiet.Harbor.2011.mkv"),
  brokenLink(12, "shows", "Lantern Bay", "Season 01/Lantern.Bay.S01E01.mkv"),
  brokenLink(13, "shows", "Lantern Bay", "Season 01/Lantern.Bay.S01E02.mkv")
];

const rule = "Deleting is blocked while a storage location the links point into looks down or empty.";

function review(options: FixtureOptions) {
  const warning = "The remote storage at /remote looks down: It is empty. Every link into it looks broken while it is down, so nothing can be deleted or rescanned until it is back and a full symlink scan has run.";
  return {
    items,
    rechecked: !options.blocked,
    notListed: { targetExists: 2, changed: 1, unchecked: 0 },
    lastFullScanAt: "2026-11-24T03:00:00.000Z",
    safety: {
      blocked: Boolean(options.blocked),
      mounts: [{ rootType: "remote", path: "/remote", mounted: !options.blocked, reason: options.blocked ? "It is empty." : null }],
      spike: null,
      warnings: options.blocked ? [warning] : [],
      rule
    }
  };
}

const removed = [
  { operationId: 7, jobId: 118, mediaLinkId: 9, section: "movies", itemName: "Copper Fields (2008)", relativePath: "Copper Fields (2008)/Copper.Fields.mkv", linkPath: "/links/movies/Copper Fields (2008)/Copper.Fields.mkv", targetPath: "/remote/movies/Copper Fields (2008)/Copper.Fields.mkv", stage: "removed", message: null, completedAt: "2026-11-23T09:00:00.000Z" }
];

function arrState(options: FixtureOptions) {
  const record = (id: number, title: string, relativePath: string, episodes: string | null, service: "sonarr" | "radarr") => ({
    id, jobId: 129, service, instanceName: service === "sonarr" ? "Sonarr" : "Radarr", title, section: service === "sonarr" ? "shows" : "movies", sectionTitle: service === "sonarr" ? "TV" : "Films",
    itemName: title, relativePath, arrPath: `/${service === "sonarr" ? "tv" : "m"}/${title}/${relativePath}`, episodes, firstFoundAt: "2026-11-24T04:00:00.000Z", checkedAt: "2026-11-25T04:00:00.000Z", requestedAt: null
  });
  return {
    items: options.blocked ? [] : [record(1, "Paper Lanterns", "Season 02/Paper.Lanterns.S02E05.mkv", "S02E05", "sonarr"), record(2, "Paper Lanterns", "Season 02/Paper.Lanterns.S02E06.mkv", "S02E06", "sonarr"), record(3, "Copper Fields (2008)", "Copper.Fields.mkv", null, "radarr")],
    lastCheck: { jobId: 129, finishedAt: "2026-11-25T04:00:00.000Z", status: "partially_failed", message: "Radarr/Sonarr disk check: 3 records have nothing on disk; 1 instance could not be checked", instances: [
      { service: "sonarr", instanceId: "s1", instanceName: "Sonarr", status: "checked", message: null, titles: 40, files: 900, missing: 2 },
      { service: "radarr", instanceId: "r2", instanceName: "Radarr 4K", status: "unreachable", message: "Radarr could not be reached.", titles: 0, files: 0, missing: 0 }
    ] },
    activeJobId: null,
    hiddenBecauseStorageDown: Boolean(options.blocked),
    configured: true
  };
}

async function fixture(page: Page, options: FixtureOptions = {}) {
  const deletes: unknown[] = [];
  const rescans: unknown[] = [];
  const arrRescans: unknown[] = [];
  const checks: unknown[] = [];
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    let body: unknown = [];
    if (url.pathname === "/api/auth/me") body = { setupRequired: false, authenticated: true, user: { id: 1, username: "integration-test", role: "owner", mustChangePassword: false } };
    else if (url.pathname === "/api/system/path-migration") body = { status: "ready", blocking: false, activePaths: {}, detectedPaths: {}, environmentErrors: [], changes: [], migration: null };
    else if (url.pathname === "/api/onboarding") body = { required: false, phase: "completed" };
    else if (url.pathname === "/api/settings/storage-locations") body = { locations: [{ key: "location_1", rootType: "local", displayName: "Home NAS", path: "/local" }, { key: "location_2", rootType: "remote", displayName: "Archive", path: "/remote" }] };
    else if (url.pathname === "/api/settings/user-preferences") body = { timeFormat: "24h", autoOpenTaskStatus: false, recentJobsCompletedWindowMinutes: 1440 };
    else if (url.pathname === "/api/inventory/summary") body = { totalLinks: 0, remoteLinks: 10, localLinks: 5, brokenLinks: 3, otherLinks: 0, nonMediaLinks: 0, actionableRemoteLinks: 0, actionableLocalLinks: 0, assignedRemoteLinks: 0, unassignedRemoteLinks: 0, unassignedLocalLinks: 0, localFiles: 20, remoteFiles: 30, actionableRemoteFiles: 0, actionableLocalFiles: 0, assignedRemoteFiles: 0, unassignedRemoteFiles: 0, unassignedLocalFiles: 0, localOrphanFiles: 0, remoteOrphanFiles: 0, missingLinks: 0, missingLocalFiles: 0, missingRemoteFiles: 0 };
    else if (url.pathname === "/api/broken-links") body = review(options);
    else if (url.pathname === "/api/broken-links/removed") body = removed;
    else if (url.pathname === "/api/broken-links/arr-missing") body = arrState(options);
    else if (url.pathname === "/api/broken-links/arr-missing/check") { checks.push(true); body = { jobId: 130 }; }
    else if (url.pathname === "/api/broken-links/arr-missing/rescan") { arrRescans.push(request.postDataJSON()); body = { titles: 1, asked: 1, searched: 0, notMatched: 0, failed: 0, problems: [], relinked: 0 }; }
    else if (url.pathname === "/api/broken-links/delete") { deletes.push(request.postDataJSON()); body = { jobId: 120 }; }
    else if (url.pathname === "/api/broken-links/rescan") { rescans.push(request.postDataJSON()); body = { titles: 1, asked: 0, searched: 1, notMatched: 0, failed: 0, problems: [], relinked: 0 }; }
    else if (url.pathname === "/api/jobs/120") body = { id: 120, type: "symlink_cleanup", status: "completed", createdAt: "2026-11-25T09:00:00.000Z", startedAt: "2026-11-25T09:00:01.000Z", finishedAt: "2026-11-25T09:00:02.000Z", options: { brokenLinks: true }, progress: { current: 2, total: 2, removed: 1, alreadyMissing: 0, skipped: 1, failed: 0, stage: "completed", message: "Broken link cleanup finished: 1 removed, 1 skipped because they changed. Rescan asked for 1 title" } };
    else if (url.pathname === "/api/broken-links/jobs/120") body = [
      { operationId: 21, jobId: 120, mediaLinkId: 12, section: "shows", itemName: "Lantern Bay", relativePath: items[1]!.relativePath, linkPath: items[1]!.linkPath, targetPath: items[1]!.targetPath, stage: "removed", message: null, completedAt: "2026-11-25T09:00:02.000Z" },
      { operationId: 22, jobId: 120, mediaLinkId: 13, section: "shows", itemName: "Lantern Bay", relativePath: items[2]!.relativePath, linkPath: items[2]!.linkPath, targetPath: items[2]!.targetPath, stage: "skipped", message: "The target exists again, so the link was left in place", completedAt: "2026-11-25T09:00:02.000Z" }
    ];
    else if (url.pathname === "/api/re-requests") body = { items: [], counts: { queued: 0, pending: 0, requested: 0, failed: 0, unmatched: 0, skipped: 0 }, perMinute: 6 };
    else if (url.pathname === "/api/settings/sections") body = { sections: ["movies", "shows"], sectionTitles: { movies: "Films", shows: "TV" }, sectionTypes: { movies: "movies", shows: "shows" } };
    else if (url.pathname === "/api/settings/paths") body = { symlinkDir: "/links", localDir: "/local", remoteDir: "/remote" };
    else if (url.pathname === "/api/inventory/scan-timestamps") body = { symlinkSections: {}, localSections: {}, remoteRoot: null };
    else if (url.pathname === "/api/settings/scan") body = { scanSymlinks: true, scanLocal: true, scanRemote: true };
    else if (url.pathname === "/api/settings/audit") body = { sections: [], targets: ["local", "remote"] };
    else if (url.pathname === "/api/settings/advanced") body = {};
    else if (url.pathname === "/api/system/version") {
      const release = { latestVersion: "0.1.6-beta.1", updateAvailable: false, status: "up_to_date", releaseUrl: null };
      body = { currentVersion: "0.1.6-beta.1", currentChannel: "beta", currentChannelLabel: "Beta", stable: { ...release, channel: "stable" }, beta: { ...release, channel: "beta" }, ...release };
    }
    await route.fulfill({ json: body });
  });
  return { deletes, rescans, arrRescans, checks };
}

test("the dashboard count opens the review, grouped by folder and title, with search and folder filters", async ({ page }) => {
  await fixture(page);
  await page.goto(`${baseUrl}/`);
  await page.getByRole("link", { name: "3 broken links" }).click();
  await expect(page.getByRole("heading", { name: "Broken links" })).toBeVisible();
  const table = page.getByRole("table", { name: "Broken links" });
  await expect(table.getByRole("rowheader", { name: "Films" })).toBeVisible();
  await expect(table.getByRole("rowheader", { name: /Lantern Bay \(2 links\)/ })).toBeVisible();
  await expect(page.getByText("2 have a target again, 1 changed since the scan; not listed.")).toBeVisible();

  await page.getByLabel("Search broken links").fill("S01E02");
  await expect(table.getByRole("checkbox")).toHaveCount(1);
  await expect(table.getByRole("checkbox", { name: "Select Lantern.Bay.S01E02.mkv" })).toBeVisible();
  await page.getByLabel("Search broken links").fill("");
  await page.getByLabel("Filter by library folder").selectOption("movies");
  await expect(table.getByRole("checkbox")).toHaveCount(1);
  await expect(table.getByRole("rowheader", { name: "TV" })).toHaveCount(0);
});

test("delete selected confirms, rescans by default, and reports links that were skipped", async ({ page }) => {
  const { deletes } = await fixture(page);
  await page.goto(`${baseUrl}/library?view=broken-links`);
  await page.getByRole("checkbox", { name: "Select Lantern.Bay.S01E01.mkv" }).check();
  await page.getByRole("checkbox", { name: "Select Lantern.Bay.S01E02.mkv" }).check();
  await page.getByRole("button", { name: "Delete selected" }).click();
  const confirm = page.getByRole("group", { name: "Confirm broken link delete" });
  await expect(confirm).toContainText("Delete 2 broken symlinks in 1 title?");
  await expect(confirm.getByLabel("Ask Radarr/Sonarr to rescan the affected titles")).toBeChecked();
  await expect(confirm.getByLabel("Also search for the removed items")).not.toBeChecked();
  await confirm.getByRole("button", { name: "Delete 2 links" }).click();
  await expect(page.getByTestId("broken-link-job-result")).toContainText("1 removed, 1 skipped because they changed");
  await expect(page.getByRole("list", { name: "Links not removed" })).toContainText("Lantern.Bay.S01E02.mkv: Skipped, changed. The target exists again");
  expect(deletes).toEqual([{ mediaLinkIds: [12, 13], rescan: true, search: false }]);
});

test("delete all shown takes only the filtered links", async ({ page }) => {
  const { deletes } = await fixture(page);
  await page.goto(`${baseUrl}/library?view=broken-links`);
  await page.getByLabel("Filter by library folder").selectOption("shows");
  await page.getByRole("button", { name: "Delete all shown (2)" }).click();
  const confirm = page.getByRole("group", { name: "Confirm broken link delete" });
  await confirm.getByLabel("Also search for the removed items").check();
  await confirm.getByRole("button", { name: "Delete 2 links" }).click();
  await expect(page.getByTestId("broken-link-job-result")).toBeVisible();
  expect(deletes).toEqual([{ mediaLinkIds: [12, 13], rescan: true, search: true }]);
});

test("a storage mount that looks down blocks every delete and says why", async ({ page }) => {
  const { deletes } = await fixture(page, { blocked: true });
  await page.goto(`${baseUrl}/library?view=broken-links`);
  await expect(page.getByRole("alert").filter({ hasText: "Deleting is blocked." })).toContainText("looks down");
  await expect(page.getByText("These are the last scan's results.")).toBeVisible();
  await expect(page.getByRole("button", { name: /Delete all shown/ })).toBeDisabled();
  await expect(page.getByRole("checkbox", { name: "Select Quiet.Harbor.2011.mkv" })).toBeDisabled();
  await page.getByRole("button", { name: "How this works" }).click();
  await expect(page.getByText(rule)).toBeVisible();
  expect(deletes).toEqual([]);
});

test("removed links can be sent for another rescan, with a search", async ({ page }) => {
  const { rescans } = await fixture(page);
  await page.goto(`${baseUrl}/library?view=broken-links`);
  await page.getByRole("tab", { name: /Removed, last 30 days/ }).click();
  await page.getByRole("checkbox", { name: "Select removed Copper.Fields.mkv" }).check();
  await page.getByLabel("Also search for the removed items").check();
  await page.getByRole("button", { name: /Ask Radarr\/Sonarr to rescan \(1\)/ }).click();
  await expect(page.getByRole("status").filter({ hasText: "Rescan asked for 0 titles; search queued for 1 item." })).toBeVisible();
  expect(rescans).toEqual([{ operationIds: [7], search: true }]);
});

test("records Sonarr or Radarr have with nothing on disk are listed by title and can be rescanned", async ({ page }) => {
  const { arrRescans, checks } = await fixture(page);
  await page.goto(`${baseUrl}/library?view=broken-links`);
  await page.getByRole("tab", { name: /In Sonarr\/Radarr, not on disk/ }).click();
  const table = page.getByRole("table", { name: "Records with nothing on disk" });
  await expect(table.getByRole("rowheader", { name: /Paper Lanterns \(Sonarr, 2 records\)/ })).toBeVisible();
  await expect(table.getByText("/tv/Paper Lanterns/Season 02/Paper.Lanterns.S02E05.mkv")).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "Radarr 4K could not be reached" })).toBeVisible();
  // Nothing here can be deleted.
  await expect(page.getByRole("button", { name: /Delete/ }).filter({ hasText: "selected" })).toHaveCount(0);

  await page.getByLabel("Search Sonarr and Radarr records").fill("S02E06");
  await page.getByRole("checkbox", { name: "Select all 1 shown" }).check();
  await page.getByRole("button", { name: /Ask Radarr\/Sonarr to rescan \(1\)/ }).click();
  await expect(page.getByRole("status").filter({ hasText: "Rescan asked for 1 title." })).toBeVisible();
  expect(arrRescans).toEqual([{ ids: [2], search: false }]);

  await page.getByRole("button", { name: "Check now" }).click();
  await expect.poll(() => checks.length).toBe(1);
});

test("records are hidden while storage looks down", async ({ page }) => {
  await fixture(page, { blocked: true });
  await page.goto(`${baseUrl}/library?view=broken-links`);
  await page.getByRole("tab", { name: /In Sonarr\/Radarr, not on disk/ }).click();
  await expect(page.getByText("Storage looks down, so these records are not shown")).toBeVisible();
  await expect(page.getByRole("button", { name: "Check now" })).toBeDisabled();
});
