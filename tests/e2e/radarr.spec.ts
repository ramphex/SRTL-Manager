import { expect, test, type Page } from "@playwright/test";
import type { RadarrMovieStatus, RadarrSettingsInput, RadarrState } from "../../src/shared/radarr";

const baseUrl = process.env.SRTL_E2E_BASE_URL;
test.skip(!baseUrl, "Set SRTL_E2E_BASE_URL to run browser checks.");

function movie(id: number, title: string): RadarrMovieStatus {
  return { movieId: id, tmdbId: id + 100, title, folderPath: `/library/${title}`, section: "movies", itemName: title, tags: ["family", "local"], monitored: true, policy: "unassigned", tagPolicy: "location_1", managed: false, status: "review", message: null, syncedAt: null };
}

async function fixture(page: Page, options: { empty?: boolean; failure?: boolean; saveFailure?: boolean } = {}) {
  const state: RadarrState = {
    settings: { revision: 1, baseUrl: "http://radarr:7878", enabled: false, localTag: "local", remoteTag: "ignored", monitorOnCopy: false, mappingMode: "manual", mappings: [{ rootPath: "/library", section: "movies" }], hasApiKey: true, hasWebhookSecret: true, lastRefreshAt: "2026-09-01T12:00:00.000Z", lastError: null },
    movies: options.empty ? [] : [movie(1, "Family Vacation in Burma (2020)"), movie(2, "My First Wedding (2020)"), { ...movie(3, "My Second Wedding (2021)"), tags: ["local", "ignored"], tagPolicy: "conflict" }, { ...movie(4, "My Third Wedding (2022)"), section: null, itemName: null, status: "unmapped" }],
    events: options.empty ? [] : [{ id: 1, movieId: 1, title: "Family Vacation in Burma (2020)", eventType: "Download", receivedAt: "2026-09-01T12:00:00.000Z", processedAt: null, error: "Imported symlink is not available at the mapped path yet. Waiting to rescan.", jobId: null, jobStatus: null }],
    monitorUpdates: options.empty ? [] : [{ id: 1, movieId: 2, title: "My First Wedding (2020)", monitored: false, copyJobId: 77, createdAt: "2026-09-01T12:05:00.000Z", processedAt: "2026-09-01T12:05:05.000Z", error: null }]
  };
  const writes: Array<{ movieIds: number[]; action: string }> = [];
  const saves: RadarrSettingsInput[] = [];
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    let body: unknown = [];
    if (url.pathname === "/api/auth/me") body = { setupRequired: false, authenticated: true, user: { id: 1, username: "integration-test" } };
    else if (url.pathname === "/api/system/path-migration") body = { status: "ready", blocking: false, activePaths: {}, detectedPaths: {}, environmentErrors: [], changes: [], migration: null };
    else if (url.pathname === "/api/onboarding") body = { required: false, phase: "completed" };
    else if (url.pathname === "/api/settings/storage-locations") body = { locations: [{ key: "location_1", rootType: "local", displayName: "Home NAS", path: "/local" }, { key: "location_2", rootType: "remote", displayName: "Archive", path: "/remote" }] };
    else if (url.pathname === "/api/settings/user-preferences") body = { timeFormat: "24h", autoOpenTaskStatus: false, recentJobsCompletedWindowMinutes: 1440 };
    else if (url.pathname === "/api/settings/sections") body = { sections: ["movies", "shows"], sectionTitles: { movies: "Family Films", shows: "Recordings" }, sectionTypes: { movies: "movies", shows: "shows" } };
    else if (url.pathname === "/api/jobs/42") body = { id: 42, type: "scan", status: "completed", progress: { options: { scanSymlinks: true, scanLocal: false, scanRemote: false, titleScopes: [{ section: "movies", itemName: "My First Wedding (2020)" }] } }, startedAt: "2026-09-01T12:00:00.000Z", finishedAt: "2026-09-01T12:00:01.000Z" };
    else if (url.pathname === "/api/jobs/42/events/page") body = { events: [], total: 0, hasMore: false, nextBeforeId: null };
    else if (url.pathname === "/api/system/version") {
      const release = { latestVersion: "0.1.4-beta.1", updateAvailable: false, status: "up_to_date", releaseUrl: null };
      body = { currentVersion: "0.1.4-beta.1", currentChannel: "beta", currentChannelLabel: "Beta", stable: { ...release, channel: "stable" }, beta: { ...release, channel: "beta" }, ...release };
    } else if (url.pathname === "/api/settings/radarr/test") body = { version: "6.0.0", rootFolders: ["/library", "/library4k"], automaticMappings: [{ rootPath: "/library", section: "movies" }], unmatchedRootFolders: ["/library4k"] };
    else if (url.pathname === "/api/settings/radarr/reconcile") {
      const input: { movieIds: number[]; action: string } = request.postDataJSON();
      writes.push(input);
      await new Promise((resolve) => setTimeout(resolve, 250));
      if (options.failure) return route.fulfill({ status: 409, json: { error: "Storage policy cannot be changed while a copy job is running." } });
      for (const item of state.movies.filter((entry) => input.movieIds.includes(entry.movieId))) { item.managed = true; item.status = "pending"; }
      body = state;
    } else if (url.pathname === "/api/settings/radarr/refresh") body = state;
    else if (url.pathname === "/api/settings/radarr/copy-defaults") body = { available: state.settings.enabled, monitorOnCopy: state.settings.monitorOnCopy, sections: state.settings.enabled ? state.settings.mappings.map((mapping) => mapping.section) : [] };
    else if (url.pathname === "/api/settings/radarr") {
      if (request.method() === "PUT") {
        const input: RadarrSettingsInput = request.postDataJSON();
        saves.push(input);
        await new Promise((resolve) => setTimeout(resolve, 250));
        if (options.saveFailure) return route.fulfill({ status: 400, json: { error: "Radarr rejected the API key." } });
        state.settings = { ...state.settings, revision: state.settings.revision + 1, baseUrl: input.baseUrl, localTag: input.localTag, remoteTag: input.remoteTag, enabled: input.enabled, monitorOnCopy: input.monitorOnCopy, hasApiKey: state.settings.hasApiKey || Boolean(input.apiKey), hasWebhookSecret: state.settings.hasWebhookSecret || Boolean(input.webhookSecret), mappingMode: input.mappingMode, mappings: input.mappingMode === "auto" ? [{ rootPath: "/library", section: "movies" }] : input.mappings };
      }
      body = state;
    }
    await route.fulfill({ json: body });
  });
  return { state, writes, saves };
}

test("settings and related activity are grouped by purpose with one configuration form", async ({ page }) => {
  await fixture(page);
  await page.goto(`${baseUrl}/settings/integrations`);
  await expect(page.locator(".radarr-section > .radarr-heading h2")).toHaveText(["Connection", "Folder mappings", "Policy synchronization", "Copy monitoring", "Webhooks"]);
  const connection = page.getByRole("region", { name: "Connection", exact: true });
  await expect(connection.getByLabel("Radarr URL", { exact: true })).toBeVisible();
  await expect(connection.getByLabel("API key", { exact: true })).toBeVisible();
  await expect(connection.getByLabel("Home NAS policy tag", { exact: true })).toHaveCount(0);
  const policy = page.getByRole("region", { name: "Policy synchronization", exact: true });
  await expect(policy.getByLabel("Home NAS policy tag", { exact: true })).toBeVisible();
  await expect(policy.getByLabel("Archive policy tag", { exact: true })).toBeVisible();
  await expect(policy.getByLabel("Radarr policy preview")).toBeVisible();
  const monitoring = page.getByRole("region", { name: "Copy monitoring", exact: true });
  await expect(monitoring.getByLabel("Update Radarr monitoring after copies by default")).not.toBeChecked();
  expect(await monitoring.getByLabel("Update Radarr monitoring after copies by default").evaluate((field: HTMLInputElement) => field.form?.id)).toBe("radarr-settings-form");
  await expect(monitoring.getByLabel("Recent Radarr monitoring updates")).toContainText("Unmonitor");
  await expect(monitoring.getByLabel("Recent Radarr monitoring updates")).toContainText("#77");
  const webhooks = page.getByRole("region", { name: "Webhooks", exact: true });
  await expect(webhooks.getByLabel("X-SRTL-Webhook-Secret", { exact: true })).toBeVisible();
  await expect(webhooks.getByLabel("Recent Radarr events")).toBeVisible();
  await webhooks.getByText("Webhook setup", { exact: true }).click();
  await expect(webhooks.locator("details")).toContainText("Select On Import, On Upgrade, and On Rename");
  await expect(page.locator(".radarr-integration-header").getByLabel("Enable integration", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Save Radarr settings", exact: true })).toHaveCount(1);
  for (const id of ["radarr-url", "radarr-api-key", "radarr-local-tag", "radarr-remote-tag", "radarr-webhook-secret"]) {
    expect(await page.locator(`#${id}`).evaluate((field: HTMLInputElement) => field.form?.id)).toBe("radarr-settings-form");
  }
  expect(await policy.getByLabel("Search Radarr titles").evaluate((field: HTMLInputElement) => field.form)).toBeNull();
});

test("unsaved edits are visible and policy actions never submit or use draft settings", async ({ page }) => {
  const { saves, writes } = await fixture(page);
  await page.goto(`${baseUrl}/settings/integrations`);
  const status = page.locator(".radarr-save-status");
  await expect(status).toHaveText("No unsaved changes");
  const tag = page.getByLabel("Home NAS policy tag", { exact: true });
  await tag.fill("home");
  await expect(status).toHaveText("Unsaved changes");
  await expect(page.locator(".radarr-draft-notice")).toContainText("use saved settings");
  await tag.fill("local");
  await expect(status).toHaveText("No unsaved changes");
  await tag.fill("home");
  await page.getByLabel("Enable integration", { exact: true }).check();
  await expect(page.locator(".radarr-state")).toHaveText("Current: Paused");
  await page.getByLabel("Search Radarr titles").fill("My First");
  await page.getByLabel("Search Radarr titles").press("Enter");
  await page.getByRole("checkbox", { name: "Select My First Wedding (2020)" }).check();
  await page.getByRole("button", { name: "Use SRTL policies", exact: true }).click();
  const confirmation = page.getByRole("group", { name: "Confirm policy synchronization" });
  await expect(confirmation).toContainText("Only the local and ignored tags");
  await expect(confirmation).toContainText("Tag updates will wait until the connection is enabled.");
  expect(saves).toHaveLength(0);
  await page.getByRole("button", { name: "Confirm", exact: true }).click();
  await expect(page.getByRole("button", { name: "Save Radarr settings", exact: true })).toBeDisabled();
  await expect(page.getByText("0 selected", { exact: true })).toBeVisible();
  expect(writes).toEqual([{ movieIds: [2], action: "use_srtl" }]);
  expect(saves).toHaveLength(0);
  await expect(tag).toHaveValue("home");
  await expect(status).toHaveText("Unsaved changes");
  await page.getByRole("button", { name: "Save Radarr settings", exact: true }).click();
  await expect(status).toHaveText("Saving settings...");
  await expect(page.getByRole("button", { name: "Refresh preview", exact: true })).toBeDisabled();
  await expect(status).toHaveText("No unsaved changes");
  await expect(page.locator(".radarr-state")).toHaveText("Current: Enabled");
  await expect(page.locator(".radarr-draft-notice")).toHaveCount(0);
  expect(saves).toHaveLength(1);
  expect(saves[0]).toMatchObject({ enabled: true, localTag: "home" });
});

test("failed saves keep the draft and unsaved marker until retry succeeds", async ({ page }) => {
  const options = { saveFailure: true };
  const { saves } = await fixture(page, options);
  await page.goto(`${baseUrl}/settings/integrations`);
  await page.getByLabel("Archive policy tag", { exact: true }).fill("archive");
  await page.getByRole("button", { name: "Save Radarr settings", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Radarr rejected the API key.");
  await expect(page.locator(".radarr-save-status")).toHaveText("Unsaved changes");
  await expect(page.getByLabel("Archive policy tag", { exact: true })).toHaveValue("archive");
  await page.getByRole("tab", { name: "Sonarr Coming soon", exact: true }).click();
  await page.getByRole("tab", { name: "Radarr", exact: true }).click();
  await expect(page.getByLabel("Archive policy tag", { exact: true })).toHaveValue("archive");
  options.saveFailure = false;
  await page.getByRole("button", { name: "Save Radarr settings", exact: true }).click();
  await expect(page.locator(".radarr-save-status")).toHaveText("No unsaved changes");
  expect(saves).toHaveLength(2);
});

test("the shared save validates mapping fields and keeps the webhook secret optional", async ({ page }) => {
  const { state, saves } = await fixture(page);
  state.settings.hasWebhookSecret = false;
  await page.goto(`${baseUrl}/settings/integrations`);
  await page.getByLabel("Enable integration", { exact: true }).check();
  const save = page.getByRole("button", { name: "Save Radarr settings", exact: true });
  const secret = page.getByLabel("X-SRTL-Webhook-Secret", { exact: true });
  expect(await secret.evaluate((field: HTMLInputElement) => field.validity.valueMissing)).toBe(false);
  await secret.fill("fixture_only_webhook_secret_1234");
  const root = page.getByLabel("Radarr root folder");
  await root.fill("");
  await save.click();
  expect(saves).toHaveLength(0);
  expect(await root.evaluate((field: HTMLInputElement) => field.validity.valueMissing)).toBe(true);
  await root.fill("/library");
  await save.click();
  await expect.poll(() => saves.length).toBe(1);
  await expect(secret).toHaveValue("");
  await expect(secret).toHaveAttribute("placeholder", "Saved; leave blank to keep");
});

test("integration tabs isolate settings and preserve edits with mouse and keyboard", async ({ page }, testInfo) => {
  const { saves } = await fixture(page);
  await page.goto(`${baseUrl}/settings/integrations`);
  const radarr = page.getByRole("tab", { name: "Radarr", exact: true });
  const sonarr = page.getByRole("tab", { name: "Sonarr Coming soon", exact: true });
  await expect(radarr).toHaveAttribute("aria-selected", "true");
  await page.getByLabel("Home NAS policy tag", { exact: true }).fill("home");
  await sonarr.click();
  await expect(page.getByRole("tabpanel", { name: "Radarr" })).toBeHidden();
  await expect(page.getByRole("tabpanel", { name: "Sonarr Coming soon" })).toContainText("Sonarr integration is not available yet.");
  await expect(page.getByRole("button", { name: "Save Radarr settings" })).toBeHidden();
  await sonarr.press("ArrowLeft");
  await expect(radarr).toBeFocused();
  await expect(page.getByLabel("Home NAS policy tag", { exact: true })).toHaveValue("home");
  await radarr.press("End");
  await expect(sonarr).toBeFocused();
  await sonarr.press("Home");
  await expect(radarr).toBeFocused();
  expect(saves).toHaveLength(0);
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    await sonarr.click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`sonarr-tab-${width}.png`) });
    await radarr.click();
    await expect(page.getByLabel("Home NAS policy tag", { exact: true })).toHaveValue("home");
  }
});

test("automatic mapping previews exact matches and manual mode keeps editable values", async ({ page }, testInfo) => {
  const { state, saves } = await fixture(page);
  state.settings.mappingMode = "auto";
  state.settings.mappings = [];
  await page.goto(`${baseUrl}/settings/integrations`);
  await expect(page.getByRole("button", { name: "Automatic", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByLabel("Radarr root folder")).toHaveCount(0);
  await page.getByRole("button", { name: "Test connection", exact: true }).click();
  const preview = page.getByRole("region", { name: "Automatic folder matches" });
  await expect(preview).toContainText("Family Films");
  await expect(preview).toContainText("/library4k");
  await expect(preview).toContainText("Excluded from synchronization.");
  expect(saves).toHaveLength(0);
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    await preview.scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`automatic-mapping-${width}.png`) });
  }
  await page.getByRole("button", { name: "Manual", exact: true }).click();
  await expect(page.getByLabel("Radarr root folder")).toHaveValue("/library");
  await page.getByLabel("Radarr root folder").fill("/radarr/films");
  await page.getByRole("button", { name: "Automatic", exact: true }).click();
  await page.getByRole("button", { name: "Manual", exact: true }).click();
  await expect(page.getByLabel("Radarr root folder")).toHaveValue("/radarr/films");
  await page.getByRole("button", { name: "Save Radarr settings" }).click();
  await expect.poll(() => saves.length).toBe(1);
  expect(saves[0]).toMatchObject({ mappingMode: "manual", mappings: [{ rootPath: "/radarr/films", section: "movies" }] });
  await page.getByRole("button", { name: "Automatic", exact: true }).click();
  await page.getByRole("button", { name: "Save Radarr settings" }).click();
  await expect.poll(() => saves.length).toBe(2);
  expect(saves[1]?.mappingMode).toBe("auto");
  await page.reload();
  await expect(page.getByRole("button", { name: "Automatic", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(preview).toContainText("Saved matches");
});

test("automatic mapping exposes no-match and connection failure states without stale matches", async ({ page }) => {
  await fixture(page);
  await page.goto(`${baseUrl}/settings/integrations`);
  await page.getByRole("button", { name: "Automatic", exact: true }).click();
  await page.getByRole("button", { name: "Test connection", exact: true }).click();
  const preview = page.getByRole("region", { name: "Automatic folder matches" });
  await expect(preview).toContainText("Family Films");
  await page.getByLabel("Radarr URL", { exact: true }).fill("http://different:7878");
  await expect(preview).not.toContainText("Family Films");
  await page.getByLabel("API key", { exact: true }).fill("newtestkey");
  await page.route("**/api/settings/radarr/test", (route) => route.fulfill({ json: { version: "6.0.0", rootFolders: ["/different/movies"], automaticMappings: [], unmatchedRootFolders: ["/different/movies"] } }));
  await page.getByRole("button", { name: "Test connection", exact: true }).click();
  await expect(preview).toContainText("No exact folder matches found.");
  await page.route("**/api/settings/radarr/test", (route) => route.fulfill({ status: 400, json: { error: "Radarr connection failed or timed out." } }));
  await page.getByRole("button", { name: "Test connection", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Radarr connection failed or timed out.");
  await expect(page.getByText("Radarr 6.0.0 connected")).toHaveCount(0);
});

test("connection preserves saved secrets and only applies edits after saving", async ({ page }) => {
  const { saves } = await fixture(page);
  await page.goto(`${baseUrl}/settings/integrations`);
  await expect(page.getByRole("heading", { name: "Settings > Integrations" })).toBeVisible();
  await expect(page.getByLabel("API key", { exact: true })).toHaveValue("");
  await expect(page.getByLabel("SRTL symlink section").locator("option")).toHaveText(["Select section", "Family Films"]);
  await page.getByLabel("Home NAS policy tag", { exact: true }).fill("home");
  await page.getByRole("button", { name: "Test connection", exact: true }).click();
  await expect(page.getByText("Radarr 6.0.0 connected")).toBeVisible();
  await page.getByRole("button", { name: "Refresh preview" }).click();
  await expect(page.getByLabel("Home NAS policy tag", { exact: true })).toHaveValue("home");
  expect(saves).toHaveLength(0);
  await page.getByLabel("Enable integration").check();
  await page.getByRole("button", { name: "Save Radarr settings" }).click();
  await expect(page.locator(".radarr-state")).toHaveText("Current: Enabled");
  expect(saves[0]).toMatchObject({ localTag: "home", apiKey: "", webhookSecret: "", enabled: true });
  await expect(page.getByLabel("API key", { exact: true })).toHaveValue("");
});

test("unconfigured policy tags stay empty with examples and cannot enable sync", async ({ page }) => {
  const { state, saves } = await fixture(page);
  state.settings.localTag = "";
  state.settings.remoteTag = "";
  await page.goto(`${baseUrl}/settings/integrations`);
  const localTag = page.getByLabel("Home NAS policy tag", { exact: true });
  const remoteTag = page.getByLabel("Archive policy tag", { exact: true });
  await expect(localTag).toHaveValue("");
  await expect(localTag).toHaveAttribute("placeholder", "local");
  await expect(remoteTag).toHaveValue("");
  await expect(remoteTag).toHaveAttribute("placeholder", "remote");
  await page.getByRole("button", { name: "Test connection", exact: true }).click();
  await expect(page.getByText("Radarr 6.0.0 connected")).toBeVisible();
  await page.getByRole("button", { name: "Save Radarr settings" }).click();
  await expect.poll(() => saves.length).toBe(1);
  expect(saves[0]).toMatchObject({ localTag: "", remoteTag: "", enabled: false });
  await page.getByRole("checkbox", { name: "Select My First Wedding (2020)" }).check();
  await expect(page.getByRole("button", { name: "Use SRTL policies" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Import existing tags" })).toBeDisabled();
  await page.getByLabel("Enable integration").check();
  await page.getByRole("button", { name: "Save Radarr settings" }).click();
  expect(await localTag.evaluate((input: HTMLInputElement) => input.validity.valueMissing)).toBe(true);
  expect(saves).toHaveLength(1);
  await localTag.fill("BAD TAG");
  expect(await localTag.evaluate((input: HTMLInputElement) => input.validity.patternMismatch)).toBe(true);
  await localTag.fill("home-storage");
  expect(await localTag.evaluate((input: HTMLInputElement) => input.validity.valid)).toBe(true);
});

test("setup help is readable on hover, keyboard focus, and touch without clipping", async ({ page }, testInfo) => {
  await fixture(page);
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto(`${baseUrl}/settings/integrations`);
    await page.getByText("Setup guide and requirements", { exact: true }).click();
    const setupGuide = page.locator("details").filter({ has: page.getByText("Setup guide and requirements", { exact: true }) });
    await expect(setupGuide).toContainText("These are required to test or save a paused connection.");
    await expect(setupGuide).toContainText("On Import, On Upgrade, and On Rename");
    await page.getByText("Setup guide and requirements", { exact: true }).click();
    const help = page.getByRole("button", { name: "About API key", exact: true });
    if (width === 1440) {
      await help.hover();
      await expect(page.getByRole("tooltip").filter({ hasText: "Find it in Radarr" })).toBeVisible();
      await page.mouse.move(0, 0);
      await help.focus();
    } else await help.click();
    const tooltip = page.getByRole("tooltip").filter({ hasText: "Find it in Radarr" });
    await expect(tooltip).toBeVisible();
    const box = await tooltip.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(width);
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.y + box!.height).toBeLessThanOrEqual(1000);
    await page.screenshot({ path: testInfo.outputPath(`radarr-help-${width}.png`) });
    await page.getByLabel("Radarr URL", { exact: true }).click();
    await expect(tooltip).toBeHidden();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
});

for (const theme of ["dark", "light"]) {
  test(`enable integration help stays inside the viewport in ${theme} theme`, async ({ page }, testInfo) => {
    await page.addInitScript((value) => localStorage.setItem("srtl-theme", value), theme);
    await fixture(page);
    await page.goto(`${baseUrl}/settings/integrations`);
    const help = page.getByRole("button", { name: "About enabling integration", exact: true });
    const tooltip = page.getByRole("tooltip").filter({ hasText: "Save Radarr settings to apply this change" });
    const assertContained = async () => {
      await expect(tooltip).toBeVisible();
      const bounds = await tooltip.boundingBox();
      const viewport = page.viewportSize()!;
      expect(bounds).not.toBeNull();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width);
      expect(bounds!.y).toBeGreaterThanOrEqual(0);
      expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport.height);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    };
    for (const width of [1440, 1024, 821, 820, 390, 320]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.getByLabel("Radarr URL", { exact: true }).click();
      await page.mouse.move(0, 0);
      await expect(tooltip).toBeHidden();
      if (width > 820) {
        await help.hover();
        await assertContained();
        await page.mouse.move(0, 0);
        await expect(tooltip).toBeHidden();
        await help.focus();
        await assertContained();
      }
      await help.click();
      await page.mouse.move(0, 0);
      await assertContained();
      await page.screenshot({ path: testInfo.outputPath(`enable-help-${theme}-${width}.png`) });
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await assertContained();
    await expect(page.getByLabel("Enable integration", { exact: true })).not.toBeChecked();
  });
}

test("policy changes require selection and confirmation and show immediate progress", async ({ page }) => {
  const { writes } = await fixture(page);
  await page.goto(`${baseUrl}/settings/integrations`);
  await expect(page.getByRole("button", { name: "Use SRTL policies" })).toBeDisabled();
  await page.getByRole("checkbox", { name: "Select My First Wedding (2020)" }).check();
  await page.getByRole("button", { name: "Import existing tags" }).click();
  expect(writes).toHaveLength(0);
  await expect(page.getByRole("group", { name: "Confirm policy synchronization" })).toContainText("No files will be copied.");
  await page.getByRole("button", { name: "Confirm", exact: true }).click();
  await expect(page.getByRole("button", { name: "Applying..." })).toBeDisabled();
  await expect(page.getByText("0 selected", { exact: true })).toBeVisible();
  expect(writes).toEqual([{ movieIds: [2], action: "import_tags" }]);
  await page.getByRole("checkbox", { name: "Select My Second Wedding (2021)" }).check();
  await expect(page.getByRole("button", { name: "Import existing tags" })).toBeDisabled();
  await expect(page.getByRole("checkbox", { name: "Select My Third Wedding (2022)" })).toBeDisabled();
  await page.getByRole("button", { name: "Clear selection" }).click();
  await page.getByLabel("Search Radarr titles").fill("Family");
  await page.getByRole("button", { name: "Select page" }).click();
  await expect(page.getByText("1 selected", { exact: true })).toBeVisible();
});

test("failed reconciliation retains selected titles and displays the error", async ({ page }) => {
  await fixture(page, { failure: true });
  await page.goto(`${baseUrl}/settings/integrations`);
  await page.getByRole("checkbox", { name: "Select My First Wedding (2020)" }).check();
  await page.getByRole("button", { name: "Import existing tags" }).click();
  await page.getByRole("button", { name: "Confirm", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText("Storage policy cannot be changed while a copy job is running.");
  await expect(page.getByRole("checkbox", { name: "Select My First Wedding (2020)" })).toBeChecked();
});

test("selection survives pagination and the requested batch excludes unchecked titles", async ({ page }) => {
  const { state, writes } = await fixture(page);
  state.movies = Array.from({ length: 30 }, (_, index) => movie(index + 1, `Wedding Recording ${String(index + 1).padStart(2, "0")}`));
  await page.goto(`${baseUrl}/settings/integrations`);
  await page.getByRole("button", { name: "Select page" }).click();
  await expect(page.getByText("25 selected", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Next page" }).click();
  await expect(page.getByRole("checkbox", { name: "Select Wedding Recording 26" })).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "Select Wedding Recording 01" })).toHaveCount(0);
  await page.getByRole("button", { name: "Select page" }).click();
  await expect(page.getByText("30 selected", { exact: true })).toBeVisible();
  await page.getByRole("checkbox", { name: "Select Wedding Recording 28" }).uncheck();
  await page.getByRole("button", { name: "Use SRTL policies" }).click();
  await page.getByRole("button", { name: "Confirm", exact: true }).click();
  await expect(page.getByText("0 selected", { exact: true })).toBeVisible();
  expect(writes[0]?.movieIds).toHaveLength(29);
  expect(writes[0]?.movieIds).not.toContain(28);
});

test("copy monitoring default is saved with the shared configuration form", async ({ page }) => {
  const { saves } = await fixture(page);
  await page.goto(`${baseUrl}/settings/integrations`);
  const toggle = page.getByLabel("Update Radarr monitoring after copies by default");
  await toggle.check();
  await expect(page.locator(".radarr-save-status")).toHaveText("Unsaved changes");
  await page.getByRole("button", { name: "Save Radarr settings", exact: true }).click();
  await expect(page.locator(".radarr-save-status")).toHaveText("No unsaved changes");
  expect(saves[0]).toMatchObject({ monitorOnCopy: true });
  await expect(toggle).toBeChecked();
});

test("select all matching selects every mapped filtered title across pages", async ({ page }) => {
  const { state } = await fixture(page);
  state.movies = [...Array.from({ length: 30 }, (_, index) => movie(index + 1, `Wedding Recording ${String(index + 1).padStart(2, "0")}`)), { ...movie(31, "Wedding Recording Unmapped"), section: null, itemName: null, status: "unmapped" }];
  await page.goto(`${baseUrl}/settings/integrations`);
  await page.getByRole("button", { name: "Select all matching" }).click();
  await expect(page.getByText("30 selected", { exact: true })).toBeVisible();
});

test("empty integration remains usable", async ({ page }) => {
  await fixture(page, { empty: true });
  await page.goto(`${baseUrl}/settings/integrations`);
  await expect(page.getByText("No titles loaded.")).toBeVisible();
  await expect(page.getByText("No webhook events received.")).toBeVisible();
  await expect(page.getByText("No monitoring updates yet.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Select page" })).toBeDisabled();
});

test("webhook activity opens the standard scan status window", async ({ page }) => {
  const { state } = await fixture(page);
  state.events[0] = { ...state.events[0]!, error: null, processedAt: "2026-09-01T12:00:01.000Z", jobId: 42, jobStatus: "completed" };
  await page.goto(`${baseUrl}/settings/integrations`);
  await page.getByRole("button", { name: "View scan job #42" }).click();
  await expect(page.getByRole("dialog")).toContainText("Job #42");
  await expect(page.getByRole("dialog")).toContainText("Completed");
  await page.getByRole("button", { name: "Close scan status window" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

for (const theme of ["dark", "light"]) {
  test(`Radarr layout remains contained in ${theme} theme`, async ({ page }, testInfo) => {
    await page.addInitScript((value) => localStorage.setItem("srtl-theme", value), theme);
    await fixture(page);
    for (const width of [1440, 390, 320]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.goto(`${baseUrl}/settings/integrations`);
      await expect(page.getByRole("heading", { name: "Policy synchronization" })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const fieldBounds = await page.locator(".radarr-fields input:not([type=checkbox]), .radarr-fields select").evaluateAll((fields) => fields.map((field) => {
        const box = field.getBoundingClientRect();
        return { left: box.left, right: box.right, width: box.width, height: box.height };
      }));
      expect(fieldBounds.every((box) => box.left >= 0 && box.right <= width && box.width >= 100 && box.height >= 38)).toBe(true);
      const previous = await page.getByRole("button", { name: "Previous page" }).boundingBox();
      const next = await page.getByRole("button", { name: "Next page" }).boundingBox();
      expect(previous?.y).toBe(next?.y);
      await page.screenshot({ path: testInfo.outputPath(`radarr-${theme}-${width}.png`), fullPage: true });
    }
  });
}
