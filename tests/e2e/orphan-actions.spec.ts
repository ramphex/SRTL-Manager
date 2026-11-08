import { expect, test, type Page } from "@playwright/test";

const baseUrl = process.env.SRTL_E2E_BASE_URL;
test.skip(!baseUrl, "Set SRTL_E2E_BASE_URL to run browser checks.");

interface FixtureOptions {
  remoteCount?: number;
  stale?: boolean;
  extraProblem?: boolean;
  inUseSkipped?: { library: number; extra: number };
  failedJob?: "progress" | "events";
  held?: boolean;
  paths?: string[];
}

function orphanReview(rootType: "local" | "remote", count: number, extra: FixtureOptions = {}) {
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
    extraSymlinks: { folders: [], linkCount: 0, unmatchedCount: 0, problems: extra.extraProblem ? ["Extra symlink folder /other could not be read (ENOENT)."] : [] }, holdDays: 7,
    ...(extra.inUseSkipped === undefined ? {} : { skippedInUse: { total: extra.inUseSkipped.library + extra.inUseSkipped.extra, files: extra.inUseSkipped.library + extra.inUseSkipped.extra, folders: 0, byReason: { library_link: extra.inUseSkipped.library, extra_link: extra.inUseSkipped.extra } } })
  };
}

function failedPurgeJob(kind: "progress" | "events") {
  const progress = { options: { rootType: "remote", mode: "delete", total: 6 }, current: 6, total: 6, held: 0, deleted: 4, alreadyMissing: 0, failed: 2, stage: "partially_failed", message: "Orphan purge partially failed: 2 of 6 files were not purged" };
  return {
    id: 97, type: "orphan_purge", status: "partially_failed", createdAt: "2026-11-08T09:00:00.000Z", startedAt: "2026-11-08T09:00:01.000Z", finishedAt: "2026-11-08T09:01:00.000Z",
    options: { rootType: "remote", mode: "delete" },
    progress: kind === "progress" ? { ...progress, firstError: { filePath: "/remote/movies/Title 1/file.mkv", message: "could not be deleted (EACCES)" } } : progress
  };
}

async function fixture(page: Page, options: FixtureOptions = {}) {
  const purges: Array<{ rootType: string; storageFileIds: number[]; folderIds: number[]; mode: string; reRequest?: boolean }> = [];
  const restores: unknown[] = [];
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
    else if (url.pathname === "/api/orphans/held") body = options.held ? [{ operationId: 5, jobId: 40, rootType: "remote", filePath: "/remote/shows/Alpha Bravo/Alpha.Bravo.S01E02.mkv", heldPath: "/remote/.srtl-purged/x", sizeBytes: 1_000_000, heldAt: "2026-11-05T10:00:00.000Z", purgeAfter: "2026-11-12T10:00:00.000Z" }] : [];
    else if (url.pathname === "/api/orphans/held/restore") { restores.push(request.postDataJSON()); body = { restored: 1, errors: [] }; }
    else if (url.pathname === "/api/jobs/97/events") body = [{ id: 3, jobId: 97, timestamp: "2026-11-08T09:00:30.000Z", level: "error", message: "Orphan was not purged", data: { filePath: "/remote/x", reason: "Charlie (2001) could not be deleted (EIO)" } }];
    else if (url.pathname === "/api/re-requests") body = { items: [], counts: { queued: 0, pending: 0, requested: 0, failed: 0, unmatched: 0, skipped: 0 }, perMinute: 6 };
    else if (url.pathname === "/api/settings/sections") body = { sections: ["movies"], sectionTitles: { movies: "Movies" }, sectionTypes: { movies: "movies" } };
    else if (url.pathname === "/api/settings/paths") body = { symlinkDir: "/links", localDir: "/local", remoteDir: "/remote" };
    else if (url.pathname === "/api/inventory/scan-timestamps") body = { symlinkSections: {}, localSections: {}, remoteRoot: null };
    else if (url.pathname === "/api/settings/scan") body = { scanSymlinks: true, scanLocal: true, scanRemote: true };
    else if (url.pathname === "/api/settings/audit") body = { sections: [], targets: ["local", "remote"] };
    else if (url.pathname === "/api/settings/advanced") body = {};
    else if (url.pathname === "/api/jobs") body = options.failedJob && !url.searchParams.get("activeOnly") ? [failedPurgeJob(options.failedJob)] : [];
    else if (url.pathname === "/api/system/version") {
      const release = { latestVersion: "0.1.4-beta.1", updateAvailable: false, status: "up_to_date", releaseUrl: null };
      body = { currentVersion: "0.1.4-beta.1", currentChannel: "beta", currentChannelLabel: "Beta", stable: { ...release, channel: "stable" }, beta: { ...release, channel: "beta" }, ...release };
    }
    await route.fulfill({ json: body });
  });
  return Object.assign(purges, { restores });
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
  // Remote storage cannot hold files, so the dialog starts on Delete now and says why.
  await expect(dialog.getByRole("button", { name: /Hold 7 days/ })).toBeDisabled();
  await expect(dialog.getByText(/can't hold files, so deletes are immediate/)).toBeVisible();
  const confirm = dialog.getByRole("button", { name: /^Delete [\d,]+ items/ });
  await expect(confirm).toBeDisabled();
  await dialog.getByLabel("Confirmation phrase").fill("purge 1499 remote items");
  await expect(confirm).toBeEnabled();
  await dialog.getByLabel(/Also include leftover folders/).check();
  await expect(confirm).toBeDisabled();
  await dialog.getByLabel("Confirmation phrase").fill("purge 1500 remote items");
  await confirm.click();
  await expect(dialog.getByRole("link", { name: "#99" })).toBeVisible();
  expect(purges).toHaveLength(1);
  expect(purges[0]).toMatchObject({ rootType: "remote", mode: "delete", folderIds: [1] });
  expect(purges[0]!.storageFileIds).toHaveLength(1499);
  expect(purges[0]!.storageFileIds).not.toContain(1);
});

test("local purge all starts on hold and only asks for the phrase on a large purge", async ({ page }) => {
  await fixture(page);
  await page.goto(`${baseUrl}/library?view=local-orphans`);
  await page.getByRole("button", { name: "Purge all eligible" }).click();
  const dialog = page.getByRole("dialog", { name: "Purge all eligible orphans" });
  await expect(dialog.getByRole("button", { name: /Hold 7 days/ })).toHaveAttribute("aria-pressed", "true");
  await expect(dialog.getByLabel("Confirmation phrase")).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: /^Hold 3 items/ })).toBeEnabled();
});

test("remote delete needs the phrase even for a small purge", async ({ page }) => {
  await fixture(page, { remoteCount: 6 });
  await page.goto(`${baseUrl}/library?view=remote-orphans`);
  await page.getByRole("button", { name: "Purge all eligible" }).click();
  const dialog = page.getByRole("dialog", { name: "Purge all eligible orphans" });
  await expect(dialog.getByRole("button", { name: /Delete now/ })).toHaveAttribute("aria-pressed", "true");
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
  const labels = page.getByRole("group", { name: "Orphan categories" });
  // The caveat sits behind an info button instead of a paragraph.
  await expect(page.getByText(/compares names only and can be wrong/)).toBeHidden();
  await page.getByRole("button", { name: "About these labels" }).click();
  await expect(page.getByText(/compares names only and can be wrong/)).toBeVisible();
  await labels.getByRole("button", { name: /^Title in library \d/ }).click();
  await expect(labels.getByRole("button", { name: /^Title in library \d/ })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "About Title in library" }).click();
  await expect(page.getByText(/compares names only and can be wrong/)).toBeVisible();
  await expect(page.getByText("Name looks like Title 2 (2020)")).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "Select all 1 title in library" })).toBeVisible();
  await labels.getByRole("button", { name: /Episode not linked/ }).click();
  await page.getByRole("button", { name: "About Episode not linked" }).click();
  await expect(page.getByText(/Not linked does not mean missing/)).toBeVisible();
  await expect(page.getByText("Name looks like Title 6 (2020)")).toBeVisible();
  await labels.getByRole("button", { name: /No title match/ }).click();
  await page.getByRole("button", { name: "About No title match" }).click();
  await expect(page.getByText(/may still be in the library under another name/)).toBeVisible();
  await labels.getByRole("button", { name: /^All \d/ }).click();

  await page.getByLabel("Filter by release").selectOption("partly_linked");
  await expect(page.getByText("partly linked, 3 of 8 files in use")).toBeVisible();
  await expect(page.getByRole("checkbox", { name: /^Select file/ })).toHaveCount(1);
  await page.getByLabel("Filter by release").selectOption("all");

  await page.getByLabel("Filter by size against the linked file").selectOption("larger");
  await expect(page.getByRole("checkbox", { name: /^Select file/ })).toHaveCount(4);
  await expect(page.getByText(/^Larger than linked/).first()).toBeVisible();
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

test("protected and in-use files are counted, not listed with checkboxes", async ({ page }) => {
  await fixture(page, { remoteCount: 6, inUseSkipped: { library: 10, extra: 2 } });
  await page.goto(`${baseUrl}/library?view=remote-orphans`);
  await expect(page.getByText("12 in use (10 by library links, 2 by extra symlink folders), 1 protected not listed.")).toBeVisible();
  await expect(page.getByRole("checkbox", { name: /^Select file/ })).toHaveCount(5);
  await expect(page.getByRole("checkbox", { name: /^Select file/, disabled: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Show protected" })).toHaveCount(0);
  await expect(page.getByLabel("Filter by release").locator("option")).toHaveText(["All releases", "No file in the release is linked", "Release is partly linked"]);
});

test("selecting files brings up the action bar, with the re-request choice up front and hold only where storage can hold", async ({ page }) => {
  const purges = await fixture(page, { remoteCount: 6 });
  const bar = page.getByRole("region", { name: "Selected orphans" });
  await page.goto(`${baseUrl}/library?view=local-orphans`);
  await expect(bar).toHaveCount(0);
  await page.getByRole("checkbox", { name: /^Select file/ }).first().check();
  await expect(bar.getByRole("button", { name: /Hold 7 days/ })).toHaveAttribute("aria-pressed", "true");
  await expect(bar.getByRole("button", { name: /Hold 7 days/ })).toBeEnabled();

  await page.goto(`${baseUrl}/library?view=remote-orphans`);
  await page.getByRole("checkbox", { name: /^Select file/ }).first().check();
  await expect(bar).toContainText("1 file selected");
  await expect(bar.getByRole("button", { name: /Hold 7 days/ })).toBeDisabled();
  await expect(bar.getByRole("button", { name: /Delete now/ })).toHaveAttribute("aria-pressed", "true");
  await expect(bar.getByText("This storage can't hold files, so deletes are immediate.")).toBeVisible();
  await expect(bar.getByRole("checkbox", { name: /search for a new copy/ })).not.toBeChecked();
  await page.getByRole("tab", { name: /Folders with no video/ }).click();
  await page.getByRole("checkbox", { name: "Select folder movies/Empty" }).check();
  await expect(bar).toContainText("1 file and 1 folder selected");
  await bar.getByRole("button", { name: "Purge selected" }).click();
  await page.getByRole("group", { name: "Confirm orphan purge" }).getByRole("button", { name: "Delete permanently" }).click();
  await expect.poll(() => purges.length).toBe(1);
  expect(purges[0]).toMatchObject({ rootType: "remote", mode: "delete", storageFileIds: [2], folderIds: [1], reRequest: false });
  await expect(bar).toHaveCount(0);
});

test("a failed purge job shows a red banner with its first error, until dismissed", async ({ page }) => {
  await fixture(page, { remoteCount: 6, failedJob: "progress" });
  await page.goto(`${baseUrl}/library?view=remote-orphans`);
  const alert = page.getByRole("alert").filter({ hasText: "Purge job #97" });
  await expect(alert).toContainText("Purge job #97 partly failed: 2 of 6 items not purged.");
  await expect(alert).toContainText("First error: file.mkv: could not be deleted (EACCES)");
  await expect(page.getByText(/finished/)).toHaveCount(0);
  await alert.getByRole("button", { name: "Dismiss" }).click();
  await expect(alert).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("checkbox", { name: /^Select file/ }).first()).toBeVisible();
  await expect(page.getByRole("alert").filter({ hasText: "Purge job #97" })).toHaveCount(0);
});

test("without a first error in the job, the banner takes it from the job's events", async ({ page }) => {
  await fixture(page, { remoteCount: 6, failedJob: "events" });
  await page.goto(`${baseUrl}/library?view=remote-orphans`);
  await expect(page.getByRole("alert").filter({ hasText: "Purge job #97" })).toContainText("First error: Charlie (2001) could not be deleted (EIO)");
});

test("held files have their own tab with a restore button", async ({ page }) => {
  const purges = await fixture(page, { remoteCount: 6, held: true });
  await page.goto(`${baseUrl}/library?view=remote-orphans`);
  await page.getByRole("tab", { name: /Holding area 1/ }).click();
  const restore = page.getByRole("button", { name: /Restore selected/ });
  await expect(restore).toBeDisabled();
  await page.getByRole("checkbox", { name: /^Select held/ }).check();
  await restore.click();
  await expect.poll(() => purges.restores.length).toBe(1);
  expect(purges.restores[0]).toEqual({ operationIds: [5] });
});
