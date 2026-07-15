import { expect, test } from "@playwright/test";
import type { OnboardingState } from "../../src/shared/types";

const baseUrl = process.env.SRTL_E2E_BASE_URL;
const sessionToken = process.env.SRTL_E2E_SESSION_TOKEN;
const sessionCookieName = process.env.SRTL_E2E_SESSION_COOKIE_NAME ?? (baseUrl && new URL(baseUrl).port ? `srtl_session_${new URL(baseUrl).port}` : "srtl_session");

test.skip(!baseUrl, "Set SRTL_E2E_BASE_URL to run browser smoke checks.");

test.beforeEach(async ({ context }) => {
  if (!baseUrl || !sessionToken) return;
  const url = new URL(baseUrl);
  await context.addCookies([
    {
      name: sessionCookieName,
      value: sessionToken,
      domain: url.hostname,
      path: "/",
      httpOnly: true,
      sameSite: "Lax"
    }
  ]);
});

test("loads the web app shell", async ({ page }) => {
  await page.goto(baseUrl!);

  await expect(page.locator("body")).toContainText(/SRTL Manager|Dashboard|Sign in|Create admin/i);
});

test("normal login starts with a blank username", async ({ page }) => {
  await page.route("**/api/auth/me", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ setupRequired: false, authenticated: false, user: null })
    });
  });

  await page.goto(baseUrl!);
  await expect(page.locator(".auth-header .brand span")).toHaveText("Sign in");
  await expect(page.getByLabel("Username", { exact: true })).toHaveValue("");
});

test("loads the authenticated dashboard when a development session is provided", async ({ page }) => {
  test.skip(!sessionToken, "Set SRTL_E2E_SESSION_TOKEN to exercise authenticated pages.");
  await page.goto(baseUrl!);
  await expect(page.getByText("Inventory Scan", { exact: true })).toBeVisible();
  await expect(page.getByText("Library Summary", { exact: true })).toBeVisible();
});

test("renders every authenticated route without page errors or global overflow", async ({ page }) => {
  test.skip(!sessionToken, "Set SRTL_E2E_SESSION_TOKEN to exercise authenticated pages.");
  test.setTimeout(90_000);
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });

  const routes = [
    { path: "/", expected: "Inventory Scan" },
    { path: "/library", expected: "Library" },
    { path: "/scans", expected: "History > Scans" },
    { path: "/audits", expected: "History > Audits" },
    { path: "/integrations", expected: "Coming soon" },
    { path: "/logs", expected: "Logs" },
    { path: "/settings", expected: "Settings > Library" },
    { path: "/settings/integrations", expected: "Settings > Integrations" },
    { path: "/settings/advanced", expected: "Settings > Advanced" },
    { path: "/settings/user", expected: "Settings > User settings" }
  ];

  for (const viewport of [
    { width: 1440, height: 1000 },
    { width: 390, height: 844 }
  ]) {
    await page.setViewportSize(viewport);
    for (const route of routes) {
      await page.goto(`${baseUrl}${route.path}`);
      await expect(page.locator("body")).toContainText(route.expected);
      await expect(page.locator("body")).not.toContainText("Internal Server Error");
      if (route.path === "/settings") {
        await expect(page.getByLabel("Location 1 friendly name", { exact: true })).toBeVisible();
        await expect(page.getByLabel("Location 2 friendly name", { exact: true })).toBeVisible();
        await expect(page.getByLabel("Location 1 mounted path", { exact: true })).toBeVisible();
        await expect(page.getByLabel("Location 2 mounted path", { exact: true })).toBeVisible();
      }
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        `${route.path} overflowed at ${viewport.width}px`
      ).toBe(true);
    }
  }

  expect(pageErrors).toEqual([]);
  expect(consoleErrors).toEqual([]);
});

test("edits friendly storage names and applies them across primary library surfaces", async ({ page }) => {
  test.skip(!sessionToken, "Set SRTL_E2E_SESSION_TOKEN to exercise authenticated pages.");
  const paths = { location_1: "/mnt/storage-one", location_2: "/mnt/storage-two" };
  let displayNames = { location_1: "Local", location_2: "Remote" };
  let submittedBody: unknown;

  await page.route("**/api/settings/storage-locations", async (route) => {
    if (route.request().method() === "PUT") {
      submittedBody = route.request().postDataJSON();
      const body = submittedBody as { locations: Array<{ key: keyof typeof displayNames; displayName: string }> };
      displayNames = Object.fromEntries(body.locations.map((location) => [location.key, location.displayName])) as typeof displayNames;
    }

    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        locations: [
          { key: "location_1", rootType: "local", displayName: displayNames.location_1, path: paths.location_1 },
          { key: "location_2", rootType: "remote", displayName: displayNames.location_2, path: paths.location_2 }
        ]
      })
    });
  });

  await page.goto(`${baseUrl}/settings`);
  await page.getByLabel("Location 1 friendly name", { exact: true }).fill("NAS");
  await page.getByLabel("Location 2 friendly name", { exact: true }).fill("Archive");
  await page.getByRole("button", { name: "Save friendly names", exact: true }).click();
  await expect(page.getByText("Friendly names saved.", { exact: true })).toBeVisible();
  expect(submittedBody).toEqual({
    locations: [
      { key: "location_1", displayName: "NAS" },
      { key: "location_2", displayName: "Archive" }
    ]
  });
  await expect(page.getByLabel("Location 1 mounted path", { exact: true })).toHaveValue(paths.location_1);
  await expect(page.getByLabel("Location 2 mounted path", { exact: true })).toHaveValue(paths.location_2);

  await page.goto(baseUrl!);
  await expect(page.locator("#local-summary-title")).toHaveText("NAS");
  await expect(page.locator("#remote-summary-title")).toHaveText("Archive");

  await page.goto(`${baseUrl}/library`);
  await expect(page.getByRole("button", { name: "NAS files", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Archive files", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Storage Policies", exact: true }).click();
  const policyTabs = page.locator(".policy-tabs");
  await expect(policyTabs.getByRole("button", { name: /^Unassigned/ })).toBeVisible();
  await expect(policyTabs.getByRole("button", { name: /^NAS/ })).toBeVisible();
  await expect(policyTabs.getByRole("button", { name: /^Archive/ })).toBeVisible();
  await expect(policyTabs.getByRole("button", { name: /^Assign / })).toHaveCount(0);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${baseUrl}/settings`);
  await expect(page.getByLabel("Location 1 friendly name", { exact: true })).toHaveValue("NAS");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("applies and persists theme changes across the sidebar and content shell", async ({ page }) => {
  test.skip(!sessionToken, "Set SRTL_E2E_SESSION_TOKEN to exercise authenticated pages.");
  await page.goto(baseUrl!);
  await expect(page.getByText("Inventory Scan", { exact: true })).toBeVisible();

  const darkTheme = page.getByRole("button", { name: "Dark theme", exact: true });
  await darkTheme.click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(darkTheme).toHaveAttribute("aria-pressed", "true");
  const dashboardColors = await page.evaluate(() => ({
    sidebar: getComputedStyle(document.querySelector(".sidebar")!).backgroundColor,
    content: getComputedStyle(document.querySelector(".content")!).backgroundColor
  }));
  expect(dashboardColors.sidebar).not.toBe(dashboardColors.content);

  await page.goto(`${baseUrl}/settings/advanced`);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.getByRole("button", { name: "Dark theme", exact: true })).toHaveAttribute("aria-pressed", "true");

  await page.getByRole("button", { name: "Light theme", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.goto(`${baseUrl}/library`);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(page.getByRole("button", { name: "Light theme", exact: true })).toHaveAttribute("aria-pressed", "true");
});

test("a detected path change blocks the app behind a responsive migration gate", async ({ page }) => {
  const unavailableIdentity = { available: false, realPath: null, device: null, inode: null, error: "Identity unavailable in browser fixture" };
  const sameIdentity = { available: true, realPath: "/storage/local", device: "1", inode: "2", error: null };
  const state = {
    status: "ready_to_apply",
    blocking: true,
    activePaths: { symlinkDir: "/mnt/links-old", localDir: "/mnt/local-old", remoteDir: "/mnt/remote" },
    detectedPaths: { symlinkDir: "/mnt/links", localDir: "/mnt/local", remoteDir: "/mnt/remote" },
    environmentErrors: [],
    changes: [
      {
        root: "symlink",
        label: "Symlink directory",
        activePath: "/mnt/links-old",
        detectedPath: "/mnt/links",
        changed: true,
        identityMatch: "unknown",
        activeIdentity: unavailableIdentity,
        detectedIdentity: unavailableIdentity
      },
      {
        root: "local",
        label: "Local directory",
        activePath: "/mnt/local-old",
        detectedPath: "/mnt/local",
        changed: true,
        identityMatch: "same",
        activeIdentity: sameIdentity,
        detectedIdentity: sameIdentity
      },
      {
        root: "remote",
        label: "Remote directory",
        activePath: "/mnt/remote",
        detectedPath: "/mnt/remote",
        changed: false,
        identityMatch: "same",
        activeIdentity: sameIdentity,
        detectedIdentity: sameIdentity
      }
    ],
    migration: {
      id: 12,
      status: "planned",
      jobId: null,
      errorMessage: null,
      createdAt: "2026-07-10T12:00:00.000Z",
      plannedAt: "2026-07-10T12:01:00.000Z",
      startedAt: null,
      finishedAt: null,
      summary: {
        totalLinks: 58_114,
        affectedLinks: 53,
        readyLinks: 53,
        blockedLinks: 0,
        repointLinks: 45,
        rebaseLinkPaths: 53,
        localFiles: 53_973,
        remoteFiles: 12_134,
        copySources: 100,
        activeJobs: 2
      },
      issues: []
    }
  };

  await page.route("**/api/auth/me", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ setupRequired: false, authenticated: true, user: { id: 1, username: "admin" } }) });
  });
  await page.route("**/api/system/path-migration", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(state) });
  });

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(baseUrl!);
  await expect(page.getByRole("heading", { name: "Storage paths require attention", exact: true })).toBeVisible();
  await expect(page.getByText("Maintenance mode", { exact: true })).toBeVisible();
  await expect(page.locator(".path-change-row")).toHaveCount(3);
  await expect(page.getByText("Same root detected", { exact: true })).toBeVisible();
  const applyButton = page.getByRole("button", { name: "Apply validated migration", exact: true });
  await expect(applyButton).toBeDisabled();
  await page.getByRole("checkbox", { name: "I confirm the detected paths expose the same storage content.", exact: true }).check();
  await expect(applyButton).toBeEnabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("heading", { name: "Storage paths require attention", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("first-run onboarding configures folders and queues the initial policy scan", async ({ page }) => {
  const paths = { symlinkDir: "/mnt/links", localDir: "/mnt/local", remoteDir: "/mnt/remote" };
  const pathChecks: OnboardingState["pathChecks"] = [
    { root: "symlink", label: "Symlink directory", path: paths.symlinkDir, ready: true, message: null },
    { root: "local", label: "Local directory", path: paths.localDir, ready: true, message: null },
    { root: "remote", label: "Remote directory", path: paths.remoteDir, ready: true, message: null }
  ];
  let onboardingState: OnboardingState = {
    required: true,
    phase: "configuration_required",
    policyMode: null,
    initialScanJobId: null as number | null,
    startedAt: null,
    completedAt: null,
    errorMessage: null,
    policyResult: null,
    paths,
    pathChecks,
    storageLocations: {
      locations: [
        { key: "location_1", rootType: "local", displayName: "Local", path: paths.localDir },
        { key: "location_2", rootType: "remote", displayName: "Remote", path: paths.remoteDir }
      ]
    },
    sections: { sections: ["stale-folder"], sectionTypes: { "stale-folder": "other" } },
    detectedSections: ["archive", "primary"]
  };
  let submitted: unknown = null;
  const scanStartedAt = new Date(Date.now() - 4_000).toISOString();
  let scanProgress: Record<string, unknown> = {
    options: { scanSymlinks: true, scanLocal: false, scanRemote: false, symlinkSections: ["archive", "primary"], localSections: [] },
    stage: "scanning",
    message: "Checked 12 of 20 discovered symlinks",
    totalLinks: 12,
    discoveredLinks: 20,
    checkedLinks: 12,
    completedWorkUnits: 1,
    totalWorkUnits: 2
  };

  await page.route("**/api/auth/me", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ setupRequired: false, authenticated: true, user: { id: 1, username: "admin" } }) });
  });
  await page.route("**/api/system/path-migration", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ status: "ready", blocking: false, activePaths: paths, detectedPaths: paths, environmentErrors: [], changes: [], migration: null })
    });
  });
  await page.route("**/api/onboarding**", async (route) => {
    if (route.request().url().endsWith("/start")) {
      submitted = route.request().postDataJSON();
      onboardingState = {
        ...onboardingState,
        phase: "queued",
        policyMode: "leave_unassigned",
        initialScanJobId: 900,
        detectedSections: [],
        storageLocations: {
          locations: [
            { key: "location_1", rootType: "local", displayName: "NAS", path: paths.localDir },
            { key: "location_2", rootType: "remote", displayName: "Archive", path: paths.remoteDir }
          ]
        }
      };
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ jobId: 900, state: onboardingState }) });
      return;
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(onboardingState) });
  });
  await page.route("**/api/jobs/900", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        id: 900,
        type: "scan",
        status: "running",
        createdAt: "2026-07-10T12:00:00.000Z",
        startedAt: scanStartedAt,
        finishedAt: null,
        progress: scanProgress
      })
    });
  });

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(baseUrl!);
  await expect(page.getByRole("heading", { name: "Confirm mounted storage", exact: true })).toBeVisible();
  await expect(page.locator(".onboarding-path-row")).toHaveCount(3);
  await expect(page.getByLabel("Location 1 friendly name", { exact: true })).toHaveValue("Local");
  await expect(page.getByLabel("Location 2 friendly name", { exact: true })).toHaveValue("Remote");
  await page.getByLabel("Location 1 friendly name", { exact: true }).fill("NAS");
  await page.getByLabel("Location 2 friendly name", { exact: true }).fill("Archive");
  await page.getByRole("checkbox", { name: "I confirmed these paths and friendly names.", exact: true }).check();
  await page.getByRole("button", { name: "Continue", exact: true }).click();

  await expect(page.getByRole("heading", { name: "Configure library folders", exact: true })).toBeVisible();
  await expect(page.getByText(paths.symlinkDir, { exact: true })).toBeVisible();
  await expect(page.locator(".section-settings-row")).toHaveCount(2);
  await expect(page.getByLabel("Section 1 symlink folder", { exact: true })).toHaveValue("archive");
  await expect(page.getByLabel("Section 2 symlink folder", { exact: true })).toHaveValue("primary");
  await expect(page.getByLabel("Section 1 symlink folder", { exact: true })).not.toHaveValue("stale-folder");
  await page.getByRole("button", { name: "Continue", exact: true }).click();

  const leaveUnassigned = page.getByRole("button", { name: /Leave all unassigned/i });
  await expect(page.getByText("NAS / Archive", { exact: true })).toBeVisible();
  await leaveUnassigned.click();
  await expect(leaveUnassigned).toHaveClass(/selected/);
  await page.getByRole("button", { name: "Save and run initial scan", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Initial inventory scan", exact: true })).toBeVisible();
  await expect(page.getByText("Job #900", { exact: true })).toBeVisible();
  await expect(page.getByText("12 checked / 20 found", { exact: true })).toBeVisible();
  await expect(page.getByText("1 / 2 folders", { exact: true })).toBeVisible();
  await expect(page.locator(".scan-progress-track.is-live")).toBeVisible();
  const durationValue = page.locator(".scan-progress-stats > span").filter({ hasText: "Duration" }).locator("strong");
  const initialDuration = await durationValue.textContent();
  expect(initialDuration).not.toBeNull();
  await expect(durationValue).not.toHaveText(initialDuration!);
  await expect(page.locator(".scan-progress-panel .log-chip-list")).toHaveCount(0);
  expect(submitted).toMatchObject({
    policyMode: "leave_unassigned",
    storageLocations: {
      locations: [
        { key: "location_1", displayName: "NAS" },
        { key: "location_2", displayName: "Archive" }
      ]
    },
    sections: { sections: ["archive", "primary"] }
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  scanProgress = {
    ...scanProgress,
    stage: "indexing",
    message: "Writing scan results to the inventory database",
    totalLinks: 20,
    localLinks: 12,
    remoteLinks: 8,
    brokenLinks: 0,
    missingLinks: 3,
    actionableRemoteLinks: 2,
    actionableLocalLinks: 1,
    unassignedRemoteLinks: 8,
    unassignedLocalLinks: 12
  };
  await page.reload();
  await expect(page.getByRole("heading", { name: "Initial inventory scan", exact: true })).toBeVisible();
  const scanStats = page.locator(".scan-progress-stats > span");
  await expect(scanStats).toHaveCount(5);
  await expect(scanStats.filter({ hasText: "Pointing to NAS" })).toContainText("12");
  await expect(scanStats.filter({ hasText: "Pointing to Archive" })).toContainText("8");
  await expect(scanStats.filter({ hasText: "Broken symlinks" })).toContainText("0");
  await expect(page.getByText("No longer found symlinks", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Removed since previous scan", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Needs assignment", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Unassigned", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Total links", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Remote links", { exact: true })).toHaveCount(0);
  await expect(page.getByText(/Copy to (local|remote) links/i)).toHaveCount(0);
  await expect(page.locator(".scan-progress-panel .log-chip-list")).toHaveCount(0);

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("heading", { name: "Initial inventory scan", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("advanced settings can disable copy verification and identify the recommended profile", async ({ page }) => {
  test.skip(!sessionToken, "Set SRTL_E2E_SESSION_TOKEN to exercise authenticated pages.");
  let savedSettings: unknown = null;
  const initialSettings = {
    copy: { profile: "balanced", byteCompare: true, mediaValidation: "fast" },
    audit: { defaultMode: "fast", byteCompareWhenSourceKnown: true }
  };

  await page.route("**/api/settings/advanced", async (route) => {
    if (route.request().method() === "PUT") {
      savedSettings = route.request().postDataJSON();
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(savedSettings) });
      return;
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(initialSettings) });
  });

  await page.goto(`${baseUrl}/settings/advanced`);
  const copySection = page.locator(".advanced-settings-section").filter({ hasText: "Copy verification" });
  await expect(copySection).toHaveCount(1);
  await expect(copySection.getByRole("button", { name: "Balanced (recommended) Byte compare and fast validation", exact: true })).toHaveCount(1);
  const offButton = copySection.getByRole("button", { name: "Off Skip post-transfer byte compare and media validation", exact: true });
  await expect(offButton).toHaveCount(1);
  await offButton.click();

  await expect(offButton).toHaveClass(/selected/);
  const byteCompare = copySection.locator('input[type="checkbox"]');
  await expect(byteCompare).not.toBeChecked();
  await expect(byteCompare).toBeDisabled();
  await expect(copySection.locator(".advanced-readonly-value")).toContainText("Off");
  await page.getByRole("button", { name: "Save advanced settings", exact: true }).click();
  await expect(copySection.getByText("Current: Off", { exact: true })).toBeVisible();
  expect(savedSettings).toMatchObject({ copy: { profile: "off", byteCompare: false, mediaValidation: "off" } });
});

test("title rescan controls explain their scope and lock sibling actions while queueing", async ({ page }) => {
  test.skip(!sessionToken, "Set SRTL_E2E_SESSION_TOKEN to exercise authenticated pages.");
  const item = {
    id: null,
    title: "Targeted Rescan Test (2026)",
    normalizedTitle: "targeted rescan test (2026)",
    policy: "unassigned",
    category: "other",
    sections: ["library"],
    linkCount: 1,
    remoteLinkCount: 1,
    localLinkCount: 0,
    fileCount: 1,
    remoteFileCount: 1,
    localFileCount: 0,
    sectionCount: 1,
    source: "scan",
    updatedAt: null
  };
  const policyLabel = "Unassigned";
  let submittedBody: unknown = null;
  let releaseRequest!: () => void;
  let markRequestSeen!: () => void;
  const requestSeen = new Promise<void>((resolve) => {
    markRequestSeen = resolve;
  });
  const releaseGate = new Promise<void>((resolve) => {
    releaseRequest = resolve;
  });

  await page.route("**/api/jobs?*", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
  });
  await page.route("**/api/storage-policies?*", async (route) => {
    const policy = new URL(route.request().url()).searchParams.get("policy");
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(policy === "unassigned" ? [item] : []) });
  });
  await page.route("**/api/scans", async (route) => {
    submittedBody = route.request().postDataJSON();
    markRequestSeen();
    await releaseGate;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ jobId: 999999 }) });
  });

  await page.goto(`${baseUrl}/library`);
  await page.getByRole("button", { name: "Storage Policies", exact: true }).click();
  const policyTab = page.locator(".policy-tabs button").filter({ hasText: policyLabel });
  await expect(policyTab).toHaveCount(1);
  await policyTab.click();
  await page.getByPlaceholder("Filter scanned titles", { exact: true }).fill(item.title);

  const row = page.locator("tbody tr").filter({ hasText: item.title });
  await expect(row).toHaveCount(1);
  const rescanButton = row.getByRole("button", { name: `Rescan ${item.title}`, exact: true });
  await expect(rescanButton).toBeVisible();
  await rescanButton.hover();
  const rescanTooltip = page.getByRole("tooltip");
  await expect(rescanTooltip).toContainText("Rescan this title's symlinks");
  expect(await rescanTooltip.evaluate((element) => element.parentElement === document.body)).toBe(true);
  const tooltipBox = await rescanTooltip.boundingBox();
  const viewport = page.viewportSize();
  expect(tooltipBox).not.toBeNull();
  expect(viewport).not.toBeNull();
  expect(tooltipBox!.x).toBeGreaterThanOrEqual(0);
  expect(tooltipBox!.y).toBeGreaterThanOrEqual(0);
  expect(tooltipBox!.x + tooltipBox!.width).toBeLessThanOrEqual(viewport!.width);
  expect(tooltipBox!.y + tooltipBox!.height).toBeLessThanOrEqual(viewport!.height);

  const click = rescanButton.click();
  await requestSeen;
  await expect(rescanButton).toBeDisabled();
  await expect(row.locator("button:not(:disabled)")).toHaveCount(0);
  releaseRequest();
  await click;

  expect(submittedBody).toMatchObject({
    scanSymlinks: true,
    scanLocal: false,
    scanRemote: false,
    titleScopes: item.sections.map((section) => ({ section, itemName: item.title }))
  });
});

test("recent jobs identifies a targeted scan by title instead of only its parent folder", async ({ page }) => {
  test.skip(!sessionToken, "Set SRTL_E2E_SESSION_TOKEN to exercise authenticated pages.");
  const jobId = 999997;
  const timestamp = new Date().toISOString();
  const title = "Targeted Scope Test (2026)";
  const job = {
    id: jobId,
    type: "scan",
    status: "completed",
    createdAt: timestamp,
    startedAt: timestamp,
    finishedAt: timestamp,
    progress: {
      options: {
        scanSymlinks: true,
        scanLocal: false,
        scanRemote: false,
        symlinkSections: ["movies4k"],
        localSections: [],
        titleScopes: [{ section: "movies4k", itemName: title }]
      },
      stage: "completed",
      message: "Title rescan completed"
    }
  };

  await page.route("**/api/jobs?*", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([job]) });
  });
  await page.route("**/api/settings/sections", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ sections: ["movies4k"], sectionTitles: { movies4k: "Movies 4K" }, sectionTypes: { movies4k: "movie" } })
    });
  });

  await page.goto(baseUrl!);
  const row = page.locator("tbody tr").filter({ hasText: `#${jobId}` });
  await expect(row).toHaveCount(1);
  await expect(row.locator(".job-scope-cell > span")).toHaveText("Title rescan");
  await expect(row.locator(".job-scope-cell > small")).toContainText(title);
  await expect(row.locator(".job-scope-cell > small")).toContainText("Movies 4K");
});

test("job progress shows the complete event timeline and opens the selected full log", async ({ page }) => {
  test.skip(!sessionToken, "Set SRTL_E2E_SESSION_TOKEN to exercise authenticated pages.");
  const jobId = 999998;
  const timestamp = new Date(Date.now() - 60_000).toISOString();
  const finishedAt = new Date().toISOString();
  const job = {
    id: jobId,
    type: "copy",
    status: "completed",
    createdAt: timestamp,
    startedAt: timestamp,
    finishedAt,
    progress: {
      options: { direction: "to_local", itemName: "Event Timeline Test" },
      stage: "completed",
      message: "Copy job finished",
      total: 1,
      current: 1,
      copied: 1,
      repointed: 0,
      conflicts: 0,
      failed: 0
    }
  };
  const events = Array.from({ length: 105 }, (_, index) => ({
    id: 7000 + index,
    jobId,
    timestamp,
    level: "info",
    message: `Timeline event ${index + 1}`,
    data: {}
  }));

  await page.route(`**/api/jobs/${jobId}/events/page*`, async (route) => {
    const beforeId = new URL(route.request().url()).searchParams.get("beforeId");
    const pageEvents = beforeId ? events.slice(0, 5) : events.slice(5);
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ events: pageEvents, total: events.length, hasOlder: !beforeId }) });
  });
  await page.route(`**/api/jobs/${jobId}`, async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(job) });
  });
  await page.route("**/api/jobs?*", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([job]) });
  });

  await page.goto(baseUrl!);
  const progressButton = page.getByRole("button", { name: `View copy progress for job #${jobId}`, exact: true });
  await expect(progressButton).toHaveCount(1);
  await progressButton.click();

  const dialog = page.getByRole("dialog");
  await expect(dialog).toHaveCount(1);
  await expect(dialog.getByText("105 events", { exact: true })).toBeVisible();
  await expect(dialog.locator(".audit-dialog-event-list > .event")).toHaveCount(105);
  await expect(dialog.locator(".audit-dialog-event-list")).toContainText("Timeline event 1");

  const fullEventsLink = dialog.getByRole("link", { name: "See full events", exact: true });
  await expect(fullEventsLink).toHaveCount(1);
  await Promise.all([page.waitForURL(`${baseUrl}/logs?job=${jobId}`), fullEventsLink.click()]);
  await expect(page.getByText(`Job #${jobId} events`, { exact: true })).toBeVisible();
  await expect(page.locator(".events")).toContainText("Timeline event 1");
  const summaryCards = page.locator(".logs-summary > .log-summary-card");
  await expect(summaryCards).toHaveCount(5);
  const summaryCardTops = await summaryCards.evaluateAll((cards) => cards.map((card) => Math.round(card.getBoundingClientRect().top)));
  expect(new Set(summaryCardTops).size).toBe(1);
});
