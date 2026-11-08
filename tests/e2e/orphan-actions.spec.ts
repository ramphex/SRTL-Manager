import { expect, test, type Page } from "@playwright/test";

const baseUrl = process.env.SRTL_E2E_BASE_URL;
test.skip(!baseUrl, "Set SRTL_E2E_BASE_URL to run browser checks.");

function orphanReview(rootType: "local" | "remote", count: number, extra: { stale?: boolean; extraProblem?: boolean; paths?: string[] } = {}) {
  const items = Array.from({ length: count }, (_, index) => ({
    storageFileId: index + 1, rootType, relativePath: extra.paths?.[index] ?? `movies/Title ${index}/file.mkv`, filePath: `/${rootType}/${extra.paths?.[index] ?? `movies/Title ${index}/file.mkv`}`, section: "movies", itemName: `Title ${index}`,
    sizeBytes: 1_000_000, mtimeMs: 0, category: index % 2 ? "superseded" : "unlinked", protectedReason: index === 0 ? "modified recently" : null, hollow: false,
    label: index % 2 ? "superseded" : index % 8 === 6 ? "episode_not_linked" : index % 4 === 2 ? "title_in_library" : "no_title_match", matchedTitle: index % 4 === 2 ? `Title ${index} (2020)` : null,
    releaseName: `Title ${index}`, releaseStatus: index === 2 ? "partly_linked" : "none_linked", releaseFileCount: index === 2 ? 8 : 1, releaseLinkedCount: index === 2 ? 3 : 0,
    linkedSizeBytes: index % 2 ? 500_000 : null, sizeComparison: index % 2 ? "larger" : null, episodeCoverage: null, extraLinkPath: null
  }));
  const labelTotals = (label: string) => {
    const matching = items.filter((item) => item.label === label);
    return { label, count: matching.length, sizeBytes: matching.reduce((total, item) => total + item.sizeBytes, 0), purgeableCount: matching.filter((item) => !item.protectedReason).length };
  };
  return {
    rootType, items,
    leftoverFolders: [{ folderId: 1, rootType, relativePath: "movies/Empty", dirPath: `/${rootType}/movies/Empty`, fileCount: 1, totalBytes: 10, newestMtimeMs: 0, protectedReason: null }],
    summary: [], labelSummary: ["superseded", "episode_not_linked", "title_in_library", "no_title_match"].map(labelTotals).filter((entry) => entry.count > 0), hollowCount: 0, symlinkInventoryAt: null, storageInventoryAt: null,
    staleWarning: extra.stale ? "The symlink scan is more than 24 hours old." : null, storageStaleWarning: null,
    extraSymlinks: { folders: [], linkCount: 0, unmatchedCount: 0, problems: extra.extraProblem ? ["Extra symlink folder /other could not be read (ENOENT)."] : [] }, holdDays: 7
  };
}

async function fixture(page: Page, options: { remoteCount?: number; stale?: boolean; extraProblem?: boolean; paths?: string[] } = {}) {
  const purges: Array<{ rootType: string; storageFileIds: number[]; folderIds: number[]; mode: string }> = [];
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    let body: unknown = [];
    if (url.pathname === "/api/auth/me") body = { setupRequired: false, authenticated: true, user: { id: 1, username: "integration-test", role: "owner", mustChangePassword: false } };
    else if (url.pathname === "/api/system/path-migration") body = { status: "ready", blocking: false, activePaths: {}, detectedPaths: {}, environmentErrors: [], changes: [], migration: null };
    else if (url.pathname === "/api/onboarding") body = { required: false, phase: "completed" };
    else if (url.pathname === "/api/settings/storage-locations") body = { locations: [{ key: "location_1", rootType: "local", displayName: "Home NAS", path: "/local" }, { key: "location_2", rootType: "remote", displayName: "Archive", path: "/remote" }] };
    else if (url.pathname === "/api/settings/user-preferences") body = { timeFormat: "24h", autoOpenTaskStatus: false, recentJobsCompletedWindowMinutes: 1440 };
    else if (url.pathname === "/api/inventory/summary") body = { totalLinks: 0, remoteLinks: 10, localLinks: 5, brokenLinks: 0, otherLinks: 0, nonMediaLinks: 0, actionableRemoteLinks: 0, actionableLocalLinks: 0, assignedRemoteLinks: 0, unassignedRemoteLinks: 0, unassignedLocalLinks: 0, localFiles: 20, remoteFiles: 30, actionableRemoteFiles: 0, actionableLocalFiles: 0, assignedRemoteFiles: 0, unassignedRemoteFiles: 0, unassignedLocalFiles: 0, localOrphanFiles: 4, remoteOrphanFiles: options.remoteCount ?? 1500, missingLinks: 0, missingLocalFiles: 0, missingRemoteFiles: 0 };
    else if (url.pathname === "/api/orphans") body = url.searchParams.get("rootType") === "local" ? orphanReview("local", 4, options) : orphanReview("remote", options.remoteCount ?? 1500, options);
    else if (url.pathname === "/api/orphans/purge") { purges.push(request.postDataJSON()); body = { jobId: 99 }; }
    else if (url.pathname === "/api/re-requests") body = { items: [], counts: { queued: 0, pending: 0, requested: 0, failed: 0, unmatched: 0, skipped: 0 }, perMinute: 6 };
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
  return purges;
}

test("dashboard orphan counts open the matching review", async ({ page }) => {
  await fixture(page);
  await page.goto(`${baseUrl}/`);
  await page.getByRole("link", { name: "Review 1,500 Archive orphans" }).click();
  await expect(page.getByRole("heading", { name: "Review Archive orphans" })).toBeVisible();
  await page.goto(`${baseUrl}/`);
  await page.getByRole("link", { name: "Review 4 Home NAS orphans" }).click();
  await expect(page.getByRole("heading", { name: "Review Home NAS orphans" })).toBeVisible();
  await page.goto(`${baseUrl}/`);
  await page.getByRole("link", { name: "Review 1,504 orphans" }).click();
  await expect(page.getByRole("heading", { name: "Review Home NAS orphans" })).toBeVisible();
});

test("purge all eligible requires the typed phrase for large remote purges and skips protected files", async ({ page }) => {
  const purges = await fixture(page);
  await page.goto(`${baseUrl}/library?view=remote-orphans`);
  await page.getByRole("button", { name: "Purge all eligible" }).click();
  const dialog = page.getByRole("dialog", { name: "Purge all eligible orphans" });
  await expect(dialog.getByTestId("purge-all-summary")).toContainText("1,499 items");
  await expect(dialog.getByTestId("purge-all-summary")).toContainText("1 protected file is left alone");
  const confirm = dialog.getByRole("button", { name: /^Hold [\d,]+ items/ });
  await expect(confirm).toBeDisabled();
  await dialog.getByLabel("Confirmation phrase").fill("purge 1499 remote items");
  await expect(confirm).toBeEnabled();
  await dialog.getByLabel(/Also include leftover folders/).check();
  await expect(confirm).toBeDisabled();
  await dialog.getByLabel("Confirmation phrase").fill("purge 1500 remote items");
  await confirm.click();
  await expect(dialog.getByRole("link", { name: "#99" })).toBeVisible();
  expect(purges).toHaveLength(1);
  expect(purges[0]).toMatchObject({ rootType: "remote", mode: "hold", folderIds: [1] });
  expect(purges[0]!.storageFileIds).toHaveLength(1499);
  expect(purges[0]!.storageFileIds).not.toContain(1);
});

test("remote delete needs the phrase even for a small purge, and a stale scan blocks purging", async ({ page }) => {
  await fixture(page, { remoteCount: 6 });
  await page.goto(`${baseUrl}/library?view=remote-orphans`);
  await page.getByRole("button", { name: "Purge all eligible" }).click();
  const dialog = page.getByRole("dialog", { name: "Purge all eligible orphans" });
  await expect(dialog.getByLabel("Confirmation phrase")).toHaveCount(0);
  await dialog.getByRole("button", { name: /Delete now/ }).click();
  await expect(dialog.getByLabel("Confirmation phrase")).toBeVisible();
  await expect(dialog.getByRole("button", { name: /^Delete 5 items/ })).toBeDisabled();
});

test("stale symlink scan disables purge all", async ({ page }) => {
  await fixture(page, { remoteCount: 6, stale: true });
  await page.goto(`${baseUrl}/library?view=remote-orphans`);
  await expect(page.getByRole("button", { name: "Purge all eligible" })).toBeDisabled();
});

test("an unreadable extra symlink folder blocks purging and says why", async ({ page }) => {
  await fixture(page, { remoteCount: 6, extraProblem: true });
  await page.goto(`${baseUrl}/library?view=remote-orphans`);
  await expect(page.getByRole("alert").filter({ hasText: "could not be read" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Purge all eligible" })).toBeDisabled();
});

test("the review filters and sorts by the new labels, and says a title match is only a name match", async ({ page }) => {
  await fixture(page, { remoteCount: 8 });
  await page.goto(`${baseUrl}/library?view=remote-orphans`);
  await expect(page.getByText(/compares names only and can be wrong/)).toBeVisible();
  await page.getByRole("group", { name: "Orphan categories" }).getByRole("button", { name: /^Title is in the library \d/ }).click();
  await expect(page.getByText(/compares names only and can be wrong/)).toBeVisible();
  await expect(page.getByText("Name looks like Title 2 (2020)")).toBeVisible();
  await expect(page.getByRole("button", { name: /^Select all title is in the library \(1\)/ })).toBeVisible();
  await page.getByRole("group", { name: "Orphan categories" }).getByRole("button", { name: /episode is not linked/ }).click();
  await expect(page.getByText(/Not linked does not mean missing/)).toBeVisible();
  await expect(page.getByText("Name looks like Title 6 (2020)")).toBeVisible();
  await page.getByRole("group", { name: "Orphan categories" }).getByRole("button", { name: /No title match/ }).click();
  await expect(page.getByText(/may still be in the library under another name/)).toBeVisible();
  await page.getByRole("group", { name: "Orphan categories" }).getByRole("button", { name: /All orphans/ }).click();

  await page.getByLabel("Filter by release").selectOption("partly_linked");
  await expect(page.getByText("partly linked, 3 of 8 files in use")).toBeVisible();
  await expect(page.getByRole("checkbox", { name: /^Select file/ })).toHaveCount(1);
  await page.getByLabel("Filter by release").selectOption("all");

  await page.getByLabel("Filter by size against the linked file").selectOption("larger");
  await expect(page.getByRole("checkbox", { name: /^Select file/ })).toHaveCount(4);
  await expect(page.getByText(/^Larger than the linked file \(/).first()).toBeVisible();
  await expect(page.getByText(/A larger file is not always a better one/)).toBeVisible();

  await page.getByLabel("Sort orphans").selectOption("size_desc");
  await expect(page.getByRole("checkbox", { name: /^Select file/ })).toHaveCount(4);
});

test("orphan search forgives punctuation, word order, apostrophes and small typos", async ({ page }) => {
  const paths = [
    "shows/Alpha.Bravo/Season 01/Alpha.Bravo.S01E02.1080p.mkv",
    "shows/Alpha.Bravo/Season 01/Alpha.Bravo.S01E03.1080p.mkv",
    "movies/Charlie's Lab (2019)/Charlie's Lab (2019).mkv",
    "movies/Delta! Echo (2020)/Delta! Echo (2020).mkv",
    "movies/Foxtrot Golf (2018)/Foxtrot.Golf.2018.mkv"
  ];
  await fixture(page, { remoteCount: paths.length, paths });
  await page.goto(`${baseUrl}/library?view=remote-orphans`);
  const search = page.getByLabel("Search orphan files");
  // File rows only; the leftover folder has a row of its own.
  const rows = page.getByLabel("Orphan files").locator("tbody tr").filter({ hasText: ".mkv" });
  await expect(rows).toHaveCount(5);

  const expectFiles = async (query: string, files: string[]) => {
    await search.fill(query);
    await expect(rows).toHaveCount(files.length);
    for (const file of files) await expect(rows.filter({ hasText: file })).toHaveCount(1);
  };
  await expectFiles("Alpha Bravo", ["Alpha.Bravo.S01E02.1080p.mkv", "Alpha.Bravo.S01E03.1080p.mkv"]);
  await expectFiles("bravo alpha s01e02", ["Alpha.Bravo.S01E02.1080p.mkv"]);
  await expectFiles("Charlies Lab", ["Charlie's Lab (2019).mkv"]);
  await expectFiles("charlie s lab", ["Charlie's Lab (2019).mkv"]);
  await expectFiles("Delta Echo", ["Delta! Echo (2020).mkv"]);
  await expectFiles("Foxtrto Glof", []);
  await expectFiles("Foxtrto golf", ["Foxtrot.Golf.2018.mkv"]);
  // Episode codes and years stay exact.
  await expectFiles("Alpha S01E04", []);
  await expectFiles("Charlies 2018", []);
  await search.fill("");
  await expect(rows).toHaveCount(5);
});
