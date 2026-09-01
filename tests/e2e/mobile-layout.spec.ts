import { expect, test, type Locator, type Page } from "@playwright/test";

const baseUrl = process.env.SRTL_E2E_BASE_URL;
const mobileViewport = { width: 390, height: 844 };

test.skip(!baseUrl, "Set SRTL_E2E_BASE_URL to run browser layout checks.");
test.use({ viewport: mobileViewport, hasTouch: true, isMobile: true });

async function mockPopulatedDashboard(
  page: Page,
  options: { emptyInventory?: boolean; inventoryDelayMs?: number } = {}
) {
  const timestamp = new Date().toISOString();
  const inventory = {
    totalLinks: 1200,
    remoteLinks: 900,
    localLinks: 300,
    brokenLinks: 12,
    otherLinks: 0,
    nonMediaLinks: 0,
    actionableRemoteLinks: 47,
    actionableLocalLinks: 5,
    assignedRemoteLinks: 20,
    unassignedRemoteLinks: 30,
    unassignedLocalLinks: 4,
    localFiles: 310,
    remoteFiles: 920,
    actionableRemoteFiles: 47,
    actionableLocalFiles: 5,
    assignedRemoteFiles: 20,
    unassignedRemoteFiles: 30,
    unassignedLocalFiles: 4,
    localOrphanFiles: 10,
    remoteOrphanFiles: 20,
    missingLinks: 0,
    missingLocalFiles: 0,
    missingRemoteFiles: 0
  };
  const sections = [
    {
      section: "shows",
      title: "Shows",
      type: "shows",
      totalLinks: 700,
      itemCount: 40,
      seasonCount: 80,
      episodeCount: 700,
      remoteLinks: 500,
      localLinks: 200,
      brokenLinks: 8,
      otherLinks: 0,
      nonMediaLinks: 0,
      actionableRemoteLinks: 30,
      actionableLocalLinks: 4,
      assignedRemoteLinks: 10,
      unassignedRemoteLinks: 20,
      unassignedLocalLinks: 3
    },
    {
      section: "movies",
      title: "Movies",
      type: "movies",
      totalLinks: 300,
      itemCount: 300,
      seasonCount: 0,
      episodeCount: 0,
      remoteLinks: 250,
      localLinks: 50,
      brokenLinks: 2,
      otherLinks: 0,
      nonMediaLinks: 0,
      actionableRemoteLinks: 10,
      actionableLocalLinks: 1,
      assignedRemoteLinks: 5,
      unassignedRemoteLinks: 8,
      unassignedLocalLinks: 1
    },
    {
      section: "anime",
      title: "Anime",
      type: "shows",
      totalLinks: 200,
      itemCount: 15,
      seasonCount: 25,
      episodeCount: 200,
      remoteLinks: 150,
      localLinks: 50,
      brokenLinks: 2,
      otherLinks: 0,
      nonMediaLinks: 0,
      actionableRemoteLinks: 7,
      actionableLocalLinks: 0,
      assignedRemoteLinks: 5,
      unassignedRemoteLinks: 2,
      unassignedLocalLinks: 0
    }
  ];

  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    let body: unknown;

    if (url.pathname === "/api/auth/me") body = { setupRequired: false, authenticated: true, user: { id: 1, username: "mobile-layout-admin" } };
    else if (url.pathname === "/api/system/path-migration") body = { status: "ready", blocking: false, activePaths: {}, detectedPaths: {}, environmentErrors: [], changes: [], migration: null };
    else if (url.pathname === "/api/onboarding") body = { required: false, phase: "completed" };
    else if (url.pathname === "/api/settings/user-preferences") body = { timeFormat: "12h", autoOpenTaskStatus: false, recentJobsCompletedWindowMinutes: 1440 };
    else if (url.pathname === "/api/settings/storage-locations") {
      body = {
        locations: [
          { key: "location_1", rootType: "local", displayName: "Local", path: "/mnt/local" },
          { key: "location_2", rootType: "remote", displayName: "Remote", path: "/mnt/remote" }
        ]
      };
    } else if (url.pathname === "/api/system/version") {
      const stable = { channel: "stable", latestVersion: "0.1.2", updateAvailable: false, status: "up_to_date", releaseUrl: null, releaseNotes: null, message: "Up to date" };
      const beta = { channel: "beta", latestVersion: "0.1.3-beta.1", updateAvailable: false, status: "up_to_date", releaseUrl: null, releaseNotes: null, message: "Up to date" };
      body = {
        currentVersion: "0.1.3-beta.1",
        currentChannel: "beta",
        currentChannelLabel: "Beta",
        stable,
        beta,
        latestVersion: beta.latestVersion,
        updateAvailable: false,
        status: "up_to_date",
        releaseUrl: null,
        checkedAt: timestamp,
        message: "Up to date"
      };
    } else if (url.pathname === "/api/settings/sections") {
      body = {
        sections: ["shows", "movies", "anime"],
        sectionTitles: { shows: "Shows", movies: "Movies", anime: "Anime" },
        sectionTypes: { shows: "shows", movies: "movies", anime: "shows" }
      };
    } else if (url.pathname === "/api/settings/paths") body = { symlinkDir: "/mnt/links", localDir: "/mnt/local", remoteDir: "/mnt/remote" };
    else if (url.pathname === "/api/settings/scan") body = { scanSymlinks: false, scanLocal: false, scanRemote: false, symlinkSections: [], localSections: ["shows", "movies", "anime"] };
    else if (url.pathname === "/api/settings/audit") body = { sections: ["shows", "movies", "anime"], targets: ["local", "remote"] };
    else if (url.pathname === "/api/settings/advanced") {
      body = {
        scan: { symlinkFolderScheduling: "single_job" },
        copy: { profile: "balanced", byteCompare: true, mediaValidation: "fast" },
        audit: { defaultMode: "fast", byteCompareWhenSourceKnown: true }
      };
    } else if (url.pathname === "/api/sections") body = sections;
    else if (url.pathname === "/api/inventory/summary") {
      if (options.inventoryDelayMs) await new Promise((resolve) => setTimeout(resolve, options.inventoryDelayMs));
      body = options.emptyInventory ? Object.fromEntries(Object.keys(inventory).map((key) => [key, 0])) : inventory;
    }
    else if (url.pathname === "/api/inventory/scan-timestamps") {
      body = {
        symlinkSections: { shows: timestamp, movies: timestamp, anime: timestamp },
        localSections: { shows: null, movies: null, anime: null },
        remoteRoot: null
      };
    } else if (url.pathname === "/api/jobs") {
      body = [
        {
          id: 702,
          type: "scan",
          status: "completed",
          createdAt: timestamp,
          startedAt: timestamp,
          finishedAt: timestamp,
          progress: { stage: "completed", options: { scanSymlinks: true, scanLocal: false, scanRemote: false, symlinkSections: ["shows"] } }
        },
        {
          id: 703,
          type: "copy",
          status: "completed",
          createdAt: timestamp,
          startedAt: timestamp,
          finishedAt: timestamp,
          selection: {
            total: 2,
            unavailable: 0,
            titles: [
              { section: "shows", itemName: "Alpha Mobile Show", count: 1 },
              { section: "shows", itemName: "Zulu Mobile Show", count: 1 }
            ]
          },
          progress: { stage: "completed", total: 2, current: 2, copied: 2, options: { direction: "to_local" } }
        },
        {
          id: 704,
          type: "copy",
          status: "partially_failed",
          createdAt: timestamp,
          startedAt: timestamp,
          finishedAt: timestamp,
          selection: {
            total: 3,
            unavailable: 0,
            titles: [
              { section: "shows", itemName: "Alpha Failed Show", count: 1 },
              { section: "shows", itemName: "Bravo Failed Show", count: 1 },
              { section: "shows", itemName: "Changed Failed Show", count: 1 }
            ]
          },
          progress: { stage: "partially_failed", total: 3, current: 3, copied: 0, repointed: 0, conflicts: 0, failed: 3, options: { direction: "to_local" } }
        }
      ];
    } else if (url.pathname === "/api/jobs/702/events/page") {
      body = {
        events: [{ id: 9001, jobId: 702, timestamp, level: "info", message: "Mobile layout scan completed", data: null }],
        total: 1,
        hasOlder: false
      };
    } else if (url.pathname === "/api/jobs/704") {
      body = {
        id: 704,
        type: "copy",
        status: "partially_failed",
        createdAt: timestamp,
        startedAt: timestamp,
        finishedAt: timestamp,
        progress: { stage: "partially_failed", total: 3, current: 3, copied: 0, repointed: 0, conflicts: 0, failed: 3, options: { direction: "to_local" } }
      };
    } else if (url.pathname === "/api/jobs/704/events/page") {
      body = {
        events: [
          { id: 9100, jobId: 704, timestamp, level: "error", message: "transfer failed", data: { mediaLinkId: 101, itemName: "Alpha Failed Show", linkPath: "/links/alpha.mkv", sourcePath: "/remote/alpha.mkv" } },
          { id: 9101, jobId: 704, timestamp, level: "error", message: "validation failed", data: { mediaLinkId: 102, itemName: "Bravo Failed Show", linkPath: "/links/bravo.mkv", sourcePath: "/remote/bravo.mkv" } },
          { id: 9102, jobId: 704, timestamp, level: "error", message: "old failure", data: { mediaLinkId: 103, itemName: "Changed Failed Show", linkPath: "/links/changed.mkv", sourcePath: "/remote/changed.mkv" } }
        ],
        total: 3,
        hasOlder: false
      };
    } else if (url.pathname === "/api/jobs/704/copy-failures") {
      body = {
        jobId: 704,
        totalFailures: 3,
        eligibleCount: 2,
        unidentifiedCount: 0,
        items: [
          { key: "media:101", mediaLinkId: 101, copyOperationId: 1, section: "shows", itemName: "Alpha Failed Show", relativePath: "Alpha Failed Show/alpha.mkv", fileName: "alpha.mkv", reason: "transfer failed", symlinkStatus: "eligible", symlinkStatusDetail: "The symlink still matches the failed copy and can be removed without deleting its media target." },
          { key: "media:102", mediaLinkId: 102, copyOperationId: 2, section: "shows", itemName: "Bravo Failed Show", relativePath: "Bravo Failed Show/bravo.mkv", fileName: "bravo.mkv", reason: "validation failed", symlinkStatus: "eligible", symlinkStatusDetail: "The symlink still matches the failed copy and can be removed without deleting its media target." },
          { key: "media:103", mediaLinkId: 103, copyOperationId: 3, section: "shows", itemName: "Changed Failed Show", relativePath: "Changed Failed Show/changed.mkv", fileName: "changed.mkv", reason: "old failure", symlinkStatus: "changed", symlinkStatusDetail: "The symlink target changed after this copy failed. Rescan before taking action." }
        ]
      };
    } else if (url.pathname === "/api/jobs/704/copy-failures/remove-symlinks") {
      body = { jobId: 705 };
    } else if (url.pathname === "/api/jobs/705") {
      body = {
        id: 705,
        type: "symlink_cleanup",
        status: "completed",
        createdAt: timestamp,
        startedAt: timestamp,
        finishedAt: timestamp,
        progress: { removed: 2, alreadyMissing: 0, failed: 0, stage: "completed", message: "Symlink cleanup finished: 2 removed" }
      };
    } else {
      await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: `Unhandled mobile-layout mock: ${url.pathname}` }) });
      return;
    }

    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });
}

async function expectNoGlobalOverflow(page: Page) {
  const dimensions = await page.evaluate(() => ({
    body: document.body.scrollWidth,
    document: document.documentElement.scrollWidth,
    viewport: window.innerWidth
  }));
  expect(dimensions.body, "body should not overflow the mobile viewport").toBeLessThanOrEqual(dimensions.viewport);
  expect(dimensions.document, "document should not overflow the mobile viewport").toBeLessThanOrEqual(dimensions.viewport);
}

async function expectTouchTarget(locator: Locator, label: string, requireSquare = false) {
  await expect(locator, `${label} should be visible`).toBeVisible();
  const box = await locator.boundingBox();
  expect(box, `${label} should have a measurable hit area`).not.toBeNull();
  expect(box!.height, `${label} should be at least 44px tall`).toBeGreaterThanOrEqual(44);
  if (requireSquare) expect(box!.width, `${label} should be at least 44px wide`).toBeGreaterThanOrEqual(44);
}

test.beforeEach(async ({ page }) => {
  await mockPopulatedDashboard(page);
  await page.goto(baseUrl!);
  await expect(page.locator(".dashboard-attention-panel").getByRole("heading", { name: "Needs attention", exact: true })).toBeVisible();
});

test("uses compact mobile navigation without delaying page content", async ({ page }) => {
  const appBar = page.locator(".mobile-app-bar");
  const bottomNavigation = page.locator(".mobile-bottom-nav");
  const openNavigation = appBar.getByRole("button", { name: "Open navigation", exact: true });
  const drawer = page.getByRole("dialog", { name: "Navigation", exact: true });

  await expect(appBar).toBeVisible();
  await expect(bottomNavigation).toBeVisible();
  await expect(drawer).toBeHidden();
  await expectTouchTarget(openNavigation, "open-navigation button", true);

  const appBarBox = await appBar.boundingBox();
  const contentBox = await page.locator("main.content").boundingBox();
  const attentionBox = await page.locator(".dashboard-attention-panel").boundingBox();
  expect(appBarBox).not.toBeNull();
  expect(contentBox).not.toBeNull();
  expect(attentionBox).not.toBeNull();
  expect(contentBox!.y, "page content should begin immediately after the compact app bar").toBeLessThanOrEqual(appBarBox!.y + appBarBox!.height + 24);
  expect(attentionBox!.y, "dashboard status should begin without a large spacer").toBeLessThanOrEqual(contentBox!.y + 24);

  const bottomTargets = bottomNavigation.locator("a, button");
  const bottomTargetCount = await bottomTargets.count();
  expect(bottomTargetCount, "bottom navigation should expose primary destinations").toBeGreaterThanOrEqual(2);
  for (let index = 0; index < bottomTargetCount; index += 1) {
    await expectTouchTarget(bottomTargets.nth(index), `bottom-navigation target ${index + 1}`, true);
  }

  const moreNavigation = bottomNavigation.getByRole("button", { name: "Open navigation", exact: true });
  await moreNavigation.click();
  await expect(moreNavigation).toHaveAttribute("aria-expanded", "true");
  await expect(drawer).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(moreNavigation).toHaveAttribute("aria-expanded", "false");
  await expect(moreNavigation).toBeFocused();

  await openNavigation.click();
  await expect(drawer).toBeVisible();
  const closeNavigation = drawer.getByRole("button", { name: "Close navigation", exact: true });
  await expectTouchTarget(closeNavigation, "close-navigation button", true);
  const drawerBox = await drawer.boundingBox();
  const drawerLinksBox = await drawer.locator(".mobile-nav-drawer-links").boundingBox();
  const drawerAccountBox = await drawer.locator(".mobile-nav-account").boundingBox();
  expect(drawerBox, "navigation drawer should have a measurable size").not.toBeNull();
  expect(drawerLinksBox, "navigation links should have a measurable size").not.toBeNull();
  expect(drawerAccountBox, "navigation account controls should have a measurable size").not.toBeNull();
  expect(drawerBox!.width, "navigation drawer should remain a compact mobile sheet").toBeLessThanOrEqual(320);
  expect(drawerBox!.height, "navigation drawer should end after its content instead of filling the screen").toBeLessThanOrEqual(mobileViewport.height - 120);
  expect(
    drawerAccountBox!.y - (drawerLinksBox!.y + drawerLinksBox!.height),
    "navigation account controls should follow the links without a flexible dead-space gap"
  ).toBeLessThanOrEqual(24);
  const drawerTypography = await drawer.evaluate((element) => {
    const navigationLink = element.querySelector<HTMLElement>(".nav-link");
    const accountChip = element.querySelector<HTMLElement>(".sidebar-user-chip");
    return {
      navigation: navigationLink ? Number.parseFloat(getComputedStyle(navigationLink).fontSize) : Number.NaN,
      account: accountChip ? Number.parseFloat(getComputedStyle(accountChip).fontSize) : Number.NaN
    };
  });
  expect(drawerTypography.navigation, "drawer navigation labels should use compact mobile type").toBeLessThanOrEqual(13);
  expect(drawerTypography.account, "drawer account text should use compact mobile type").toBeLessThanOrEqual(12);
  await expectNoGlobalOverflow(page);

  await closeNavigation.click();
  await expect(drawer).toBeHidden();
  await expect(openNavigation).toBeFocused();

  await openNavigation.click();
  await drawer.getByRole("link", { name: "Library", exact: true }).click();
  await expect(drawer).toBeHidden();
  await expect(page.locator("main.content")).toBeFocused();
  await expect(page.locator(".mobile-app-bar").getByText("Library", { exact: true })).toBeVisible();
  await expectNoGlobalOverflow(page);
});

test("fits the redesigned dashboard summary and collapsed actions in the first viewport", async ({ page }) => {
  const summary = page.locator(".dashboard-summary");
  const attentionPanel = summary.locator(".dashboard-attention-panel");
  const attentionCards = attentionPanel.locator(".dashboard-attention-grid .stat");
  const storagePanel = summary.locator(".dashboard-storage-panel");
  const storageTable = storagePanel.getByRole("table", { name: "Storage totals by location", exact: true });
  const taskSection = page.locator(".dashboard-task-section");
  const actions = taskSection.locator(".dashboard-actions");
  const actionGroups = actions.locator(":scope > .action-group");
  const disclosures = actionGroups.locator(".dashboard-action-disclosure");
  const runScan = actionGroups.getByRole("button", { name: "Run Inventory Scan", exact: true });
  const runAudit = actionGroups.getByRole("button", { name: "Run Audit", exact: true });
  const bottomNavigation = page.locator(".mobile-bottom-nav");
  const order = await page.evaluate(() => {
    const summaryElement = document.querySelector(".dashboard-summary");
    const taskElement = document.querySelector(".dashboard-task-section");
    if (!summaryElement || !taskElement) return "missing";
    return summaryElement.compareDocumentPosition(taskElement) & Node.DOCUMENT_POSITION_FOLLOWING ? "summary-first" : "tasks-first";
  });

  expect(order, "dashboard summary should precede maintenance actions in DOM order").toBe("summary-first");
  await expect(attentionPanel).toBeVisible();
  await expect(storagePanel).toBeVisible();
  await expect(attentionCards).toHaveCount(4);

  const attentionBoxes = await attentionCards.evaluateAll((cards) => cards.map((card) => {
    const box = card.getBoundingClientRect();
    return { x: box.x, y: box.y, width: box.width, height: box.height };
  }));
  expect(Math.abs(attentionBoxes[0].y - attentionBoxes[1].y), "first attention row should contain two cards").toBeLessThanOrEqual(1);
  expect(Math.abs(attentionBoxes[2].y - attentionBoxes[3].y), "second attention row should contain two cards").toBeLessThanOrEqual(1);
  expect(attentionBoxes[2].y, "attention cards should form a second row").toBeGreaterThan(attentionBoxes[0].y);
  expect(Math.abs(attentionBoxes[0].x - attentionBoxes[2].x), "left attention column should align").toBeLessThanOrEqual(1);
  expect(Math.abs(attentionBoxes[1].x - attentionBoxes[3].x), "right attention column should align").toBeLessThanOrEqual(1);
  expect(attentionBoxes[1].x, "attention cards should form two columns").toBeGreaterThan(attentionBoxes[0].x);

  const storageRows = storageTable.locator("tbody tr");
  await expect(storageRows).toHaveCount(3);
  const storageMetrics = await storageRows.evaluateAll((rows) => rows.map((row) => {
    const rowBox = row.getBoundingClientRect();
    const cells = Array.from(row.children).map((cell) => {
      const cellBox = cell.getBoundingClientRect();
      return { x: cellBox.x, width: cellBox.width };
    });
    return { height: rowBox.height, cells };
  }));
  for (const [rowIndex, row] of storageMetrics.entries()) {
    expect(row.cells, `storage row ${rowIndex + 1} should preserve all four columns`).toHaveLength(4);
    expect(row.height, `storage row ${rowIndex + 1} should stay compact`).toBeLessThanOrEqual(44);
  }
  for (let columnIndex = 0; columnIndex < 4; columnIndex += 1) {
    const referenceCell = storageMetrics[0].cells[columnIndex];
    for (const row of storageMetrics.slice(1)) {
      expect(Math.abs(row.cells[columnIndex].x - referenceCell.x), `storage column ${columnIndex + 1} should align across rows`).toBeLessThanOrEqual(1);
      expect(Math.abs(row.cells[columnIndex].width - referenceCell.width), `storage column ${columnIndex + 1} should keep a consistent width`).toBeLessThanOrEqual(1);
    }
  }
  const storageTableBox = await storageTable.boundingBox();
  expect(storageTableBox).not.toBeNull();
  expect(storageTableBox!.height, "storage totals should remain compact on mobile").toBeLessThanOrEqual(152);

  await expect(actionGroups).toHaveCount(2);
  await expect(disclosures).toHaveCount(2);
  await expect(actionGroups.first().locator(".action-group-heading p")).toHaveText("0 of 3 sources · 0 of 6 folders");
  for (let index = 0; index < 2; index += 1) {
    await expect(disclosures.nth(index)).toHaveAccessibleName("Customize");
    await expect(disclosures.nth(index)).toHaveAttribute("aria-expanded", "false");
    await expect(actionGroups.nth(index).locator(".dashboard-action-options")).toBeHidden();
    await expectTouchTarget(disclosures.nth(index), `Customize disclosure ${index + 1}`);
  }

  await expectTouchTarget(runScan, "Run Inventory Scan button");
  await expectTouchTarget(runAudit, "Run Audit button");
  const bottomNavigationBox = await bottomNavigation.boundingBox();
  expect(bottomNavigationBox).not.toBeNull();
  for (const [label, locator] of [
    ["Inventory scan card", actionGroups.nth(0)],
    ["Run Inventory Scan button", runScan],
    ["Audit card", actionGroups.nth(1)],
    ["Run Audit button", runAudit]
  ] as const) {
    const box = await locator.boundingBox();
    expect(box, `${label} should have a measurable layout box`).not.toBeNull();
    expect(box!.y + box!.height, `${label} should be fully visible above mobile navigation`).toBeLessThanOrEqual(bottomNavigationBox!.y);
  }
  await expectNoGlobalOverflow(page);

  await disclosures.first().click();
  await expect(disclosures.first()).toHaveAttribute("aria-expanded", "true");
  const expandedOptions = actionGroups.first().locator(".dashboard-action-options");
  await expect(expandedOptions).toBeVisible();
  const localScope = expandedOptions.getByRole("region", { name: "Local files", exact: true });
  await expect(localScope.getByRole("checkbox")).not.toBeChecked();
  await expect(localScope).toContainText("0/3 folders");
  const expandedOptionsBox = await expandedOptions.boundingBox();
  expect(expandedOptionsBox).not.toBeNull();
  expect(expandedOptionsBox!.x, "expanded options should stay inside the left viewport edge").toBeGreaterThanOrEqual(0);
  expect(expandedOptionsBox!.x + expandedOptionsBox!.width, "expanded options should stay inside the right viewport edge").toBeLessThanOrEqual(mobileViewport.width);
  await expectNoGlobalOverflow(page);
});

test("distinguishes loading inventory from an empty all-clear library", async ({ page }) => {
  await page.unroute("**/api/**");
  await mockPopulatedDashboard(page, { emptyInventory: true, inventoryDelayMs: 700 });
  await page.reload({ waitUntil: "domcontentloaded" });

  const summary = page.locator(".dashboard-summary");
  await expect(summary).toHaveAttribute("aria-busy", "true");
  await expect(summary.getByRole("heading", { name: "Checking library health", exact: true })).toBeVisible();
  await expect(summary.locator(".dashboard-attention-grid .stat strong")).toHaveText(["...", "...", "...", "..."]);

  await expect(summary).toHaveAttribute("aria-busy", "false");
  await expect(summary.getByRole("heading", { name: "All clear", exact: true })).toBeVisible();
  await expect(summary.locator(".dashboard-attention-grid .stat strong")).toHaveText(["0", "0", "0", "0"]);
  await expectNoGlobalOverflow(page);
});

test("keeps an opened dashboard tooltip inside the mobile viewport", async ({ page }) => {
  const trigger = page.getByRole("button", { name: "About inventory scans", exact: true });
  const tooltip = page.locator(".info-tooltip").filter({ has: trigger }).getByRole("tooltip");

  await expectTouchTarget(trigger, "inventory information button", true);
  await trigger.click();
  await expect(tooltip).toBeVisible();

  const box = await tooltip.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x, "tooltip should stay inside the left viewport edge").toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width, "tooltip should stay inside the right viewport edge").toBeLessThanOrEqual(mobileViewport.width);
  expect(box!.y, "tooltip should stay inside the top viewport edge").toBeGreaterThanOrEqual(0);
  expect(box!.y + box!.height, "tooltip should stay above the bottom viewport edge").toBeLessThanOrEqual(mobileViewport.height);
  const bottomNavigationBox = await page.locator(".mobile-bottom-nav").boundingBox();
  expect(bottomNavigationBox).not.toBeNull();
  expect(box!.y + box!.height, "tooltip should not be covered by mobile navigation").toBeLessThanOrEqual(bottomNavigationBox!.y);
  await expectNoGlobalOverflow(page);
});

test("keeps task dialogs keyboard-contained and restores focus when closed", async ({ page }) => {
  const trigger = page.getByRole("button", { name: "Run Audit", exact: true });
  await trigger.focus();
  await trigger.click();

  const dialog = page.getByRole("dialog", { name: "Audit selected targets" });
  await expect(dialog).toBeVisible();
  const closeButton = dialog.getByRole("button", { name: "Close audit window", exact: true });
  await expect(closeButton).toBeFocused();
  await expect.poll(() => page.evaluate(() => document.body.style.overflow)).toBe("hidden");

  await page.keyboard.press("Shift+Tab");
  expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  await page.keyboard.press("Tab");
  await expect(closeButton).toBeFocused();

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
  await expect.poll(() => page.evaluate(() => document.body.style.overflow)).toBe("");
});

test("lets touch and keyboard users dismiss selected-title details", async ({ page }) => {
  const row = page.getByRole("row").filter({ hasText: "#703" });
  const trigger = row.getByRole("button", { name: "View selected titles", exact: true });
  const details = row.getByRole("region", { name: "Selected titles", exact: true });

  await trigger.click();
  await expect(details).toBeVisible();
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  await details.getByRole("button", { name: "Close selected titles", exact: true }).click();
  await expect(details).toBeHidden();
  await expect(trigger).toBeFocused();
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await page.keyboard.press("Tab");
  expect(await details.evaluate((element) => !element.contains(document.activeElement))).toBe(true);

  await trigger.focus();
  await trigger.press("Enter");
  await expect(details).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(details).toBeHidden();
  await expect(trigger).toBeFocused();
});

test("presents the library summary as readable mobile cards", async ({ page }) => {
  await page.locator(".mobile-bottom-nav").getByRole("link", { name: "Library", exact: true }).click();
  await expect(page.locator(".mobile-app-bar").getByText("Library", { exact: true })).toBeVisible();

  const table = page.getByRole("table", { name: "Library summary by section", exact: true });
  const rows = table.locator(".mobile-card-row");
  await expect(rows).toHaveCount(3);
  await expect(rows.first()).toContainText("Shows");
  await expect(rows.first().locator('[data-label="Unassigned"]')).toBeVisible();
  await expect(table).toHaveCSS("overflow-x", "visible");

  for (let index = 0; index < (await rows.count()); index += 1) {
    const box = await rows.nth(index).boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(mobileViewport.width);
  }

  const cardStyles = await page.evaluate(() => {
    const table = document.createElement("table");
    table.className = "mobile-card-table storage-tree-table";
    const body = document.createElement("tbody");
    const row = document.createElement("tr");
    row.className = "mobile-card-row";
    const primary = document.createElement("td");
    primary.className = "mobile-card-primary";
    const selection = document.createElement("td");
    selection.className = "mobile-card-select";
    const duplicateStatus = document.createElement("td");
    duplicateStatus.className = "mobile-card-status";
    row.append(primary, selection, duplicateStatus);
    body.append(row);
    table.append(body);
    document.body.append(table);
    const primaryStyle = getComputedStyle(primary);
    const selectionStyle = getComputedStyle(selection);
    const statusStyle = getComputedStyle(duplicateStatus);
    const result = {
      primaryBorderTop: primaryStyle.borderTopWidth,
      primaryPaddingRight: primaryStyle.paddingRight,
      selectionDisplay: selectionStyle.display,
      selectionPosition: selectionStyle.position,
      statusDisplay: statusStyle.display
    };
    table.remove();
    return result;
  });
  expect(cardStyles).toEqual({
    primaryBorderTop: "0px",
    primaryPaddingRight: "46px",
    selectionDisplay: "flex",
    selectionPosition: "absolute",
    statusDisplay: "none"
  });
  await expectNoGlobalOverflow(page);
});

test("shows selected job details before the mobile job picker", async ({ page }) => {
  await page.locator(".mobile-bottom-nav").getByRole("link", { name: "Activity", exact: true }).click();
  const detail = page.getByRole("region", { name: "Job #704 details", exact: true });
  const picker = page.getByRole("region", { name: "Job picker", exact: true });
  await expect(detail).toBeVisible();
  await expect(picker).toBeVisible();
  await expect(detail.getByText("transfer failed", { exact: true })).toBeVisible();
  await expectTouchTarget(detail.getByRole("link", { name: "Change job", exact: true }), "Change job link");
  const jobCards = picker.locator(".log-job-card");
  await expect(jobCards).toHaveCount(3);
  expect(
    await jobCards.evaluateAll((cards) => cards.every((card) => [...card.querySelectorAll("button")].every((button) => !button.querySelector("button")))),
    "job cards should not nest title-detail buttons inside the job-selection button"
  ).toBe(true);

  const detailBox = await detail.boundingBox();
  const pickerBox = await picker.boundingBox();
  expect(detailBox).not.toBeNull();
  expect(pickerBox).not.toBeNull();
  expect(detailBox!.y, "selected events should lead the mobile list/detail view").toBeLessThan(pickerBox!.y);
  await expectNoGlobalOverflow(page);
});

test("keeps failed-copy symlink selection touch friendly", async ({ page }) => {
  await page.getByRole("button", { name: "View copy progress for job #704", exact: true }).click();
  const copyDialog = page.locator(".copy-dialog");
  await copyDialog.getByRole("button", { name: "View 3 failed items", exact: true }).click();
  const failedDetails = copyDialog.getByRole("region", { name: "Failed item details", exact: true });
  const alphaRow = failedDetails.locator("li").filter({ hasText: "Alpha Failed Show" });
  const alphaCheckbox = alphaRow.getByRole("checkbox", { name: "Select symlink for Alpha Failed Show, alpha.mkv", exact: true });
  const alphaTrash = alphaRow.getByRole("button", { name: "Remove symlink for Alpha Failed Show, alpha.mkv", exact: true });

  await expectTouchTarget(alphaRow.locator(".copy-item-details-select-control"), "failed-symlink selection control", true);
  await expectTouchTarget(alphaTrash, "failed-symlink trash button", true);
  await alphaCheckbox.check();
  await failedDetails.getByRole("checkbox", { name: "Select symlink for Bravo Failed Show, bravo.mkv", exact: true }).check();
  const removeSelected = failedDetails.getByRole("button", { name: "Remove 2 selected symlinks", exact: true });
  await expectTouchTarget(removeSelected, "remove-selected symlinks button");
  await expectNoGlobalOverflow(page);
});

test.describe("desktop disclosure compatibility", () => {
  test.use({ viewport: { width: 1440, height: 900 }, hasTouch: false, isMobile: false });

  test("keeps selected-title details dismissed after the pointer leaves", async ({ page }) => {
    const row = page.getByRole("row").filter({ hasText: "#703" });
    const trigger = row.getByRole("button", { name: "View selected titles", exact: true });
    const details = row.getByRole("region", { name: "Selected titles", exact: true });

    await trigger.hover();
    await expect(details).toBeVisible();
    await trigger.click();
    await details.getByRole("button", { name: "Close selected titles", exact: true }).click();
    await expect(details).toBeHidden();
    await expect(trigger).toBeFocused();
    await page.mouse.move(10, 10);
    await expect(details).toBeHidden();
    await expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  test("offers individual and multi-select removal for failed-copy symlinks", async ({ page }) => {
    await page.getByRole("button", { name: "View copy progress for job #704", exact: true }).click();
    const copyDialog = page.locator(".copy-dialog");
    await copyDialog.getByRole("button", { name: "View 3 failed items", exact: true }).click();
    const failedDetails = copyDialog.getByRole("region", { name: "Failed item details", exact: true });
    const alphaCheckbox = failedDetails.getByRole("checkbox", { name: "Select symlink for Alpha Failed Show, alpha.mkv", exact: true });
    const bravoCheckbox = failedDetails.getByRole("checkbox", { name: "Select symlink for Bravo Failed Show, bravo.mkv", exact: true });
    const changedCheckbox = failedDetails.getByRole("checkbox", { name: "Select symlink for Changed Failed Show, changed.mkv", exact: true });

    await expect(alphaCheckbox).toBeEnabled();
    await expect(bravoCheckbox).toBeEnabled();
    await expect(changedCheckbox).toBeDisabled();
    await failedDetails.getByRole("button", { name: "Remove symlink for Alpha Failed Show, alpha.mkv", exact: true }).click();

    const cleanupDialog = page.getByRole("dialog", { name: "Remove failed-copy symlinks", exact: true });
    await expect(cleanupDialog).toContainText("1 of 2 removable selected");
    await cleanupDialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(copyDialog).toBeVisible();
    await copyDialog.getByRole("button", { name: "View 3 failed items", exact: true }).click();
    await expect(failedDetails).toBeVisible();
    await alphaCheckbox.check();
    await bravoCheckbox.check();
    const cleanupRequest = page.waitForRequest(
      (request) => request.method() === "POST" && new URL(request.url()).pathname === "/api/jobs/704/copy-failures/remove-symlinks"
    );
    await failedDetails.getByRole("button", { name: "Remove 2 selected symlinks", exact: true }).click();
    await cleanupDialog.getByRole("button", { name: "Remove 2 symlinks", exact: true }).click();
    expect((await cleanupRequest).postDataJSON()).toEqual({ mediaLinkIds: [101, 102] });
    await expect(cleanupDialog).toContainText("Symlink cleanup finished: 2 removed");
  });
});
