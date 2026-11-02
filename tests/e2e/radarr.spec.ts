import { expect, test, type Page } from "@playwright/test";
import type { RadarrMovieStatus, RadarrOverview, RadarrSettings, RadarrSettingsInput, RadarrState } from "../../src/shared/radarr";

const baseUrl = process.env.SRTL_E2E_BASE_URL;
test.skip(!baseUrl, "Set SRTL_E2E_BASE_URL to run browser checks.");

function movie(id: number, title: string): RadarrMovieStatus {
  return { movieId: id, tmdbId: id + 100, title, folderPath: `/library/${title}`, section: "movies", itemName: title, tags: ["family", "local"], monitored: true, policy: "unassigned", tagPolicy: "location_1", managed: false, status: "review", message: null, syncedAt: null };
}

type FixtureOptions = { empty?: boolean; failure?: boolean; saveFailure?: boolean; extraInstances?: Array<Partial<RadarrSettings> & { id: string; name: string }> };

function instanceState(settings: Partial<RadarrSettings> & { id: string; name: string }): RadarrState {
  return { settings: { revision: 1, legacyWebhook: false, baseUrl: "", enabled: false, localTag: "", remoteTag: "", monitorOnCopy: false, mappingMode: "auto", mappings: [], hasApiKey: false, hasWebhookSecret: false, lastRefreshAt: null, lastError: null, ...settings }, movies: [], events: [], monitorUpdates: [] };
}

async function fixture(page: Page, options: FixtureOptions = {}) {
  const state: RadarrState = {
    settings: { id: "a1b2c3d4e5f6", name: "Radarr", legacyWebhook: true, revision: 1, baseUrl: "http://radarr:7878", enabled: false, localTag: "local", remoteTag: "ignored", monitorOnCopy: false, mappingMode: "manual", mappings: [{ rootPath: "/library", section: "movies" }], hasApiKey: true, hasWebhookSecret: true, lastRefreshAt: "2026-09-01T12:00:00.000Z", lastError: null },
    movies: options.empty ? [] : [movie(1, "Family Vacation in Burma (2020)"), movie(2, "My First Wedding (2020)"), { ...movie(3, "My Second Wedding (2021)"), tags: ["local", "ignored"], tagPolicy: "conflict" }, { ...movie(4, "My Third Wedding (2022)"), section: null, itemName: null, status: "unmapped" }],
    events: options.empty ? [] : [{ id: 1, movieId: 1, title: "Family Vacation in Burma (2020)", eventType: "Download", receivedAt: "2026-09-01T12:00:00.000Z", processedAt: null, error: "Imported symlink is not available at the mapped path yet. Waiting to rescan.", jobId: null, jobStatus: null }],
    monitorUpdates: options.empty ? [] : [{ id: 1, movieId: 2, title: "My First Wedding (2020)", monitored: false, copyJobId: 77, createdAt: "2026-09-01T12:05:00.000Z", processedAt: "2026-09-01T12:05:05.000Z", error: null }]
  };
  const instances: RadarrState[] = [state, ...(options.extraInstances ?? []).map(instanceState)];
  const writes: Array<{ movieIds: number[]; action: string }> = [];
  const saves: RadarrSettingsInput[] = [];
  const savedIds: string[] = [];
  const removed: string[] = [];
  const overview = (): RadarrOverview => ({ limit: 25, instances: instances.map((entry) => ({ settings: entry.settings, movies: entry.movies.length, mapped: entry.movies.filter((item) => item.section).length, review: entry.movies.filter((item) => item.status === "review").length, errors: entry.movies.filter((item) => item.status === "error").length })) });
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const instanceRoute = url.pathname.match(/^\/api\/settings\/radarr\/instances\/([^/]+)(?:\/(test|refresh|reconcile|rename))?$/);
    const target = instanceRoute ? instances.find((entry) => entry.settings.id === instanceRoute[1]) : undefined;
    let body: unknown = [];
    if (url.pathname === "/api/auth/me") body = { setupRequired: false, authenticated: true, user: { id: 1, username: "integration-test" } };
    else if (url.pathname === "/api/system/path-migration") body = { status: "ready", blocking: false, activePaths: {}, detectedPaths: {}, environmentErrors: [], changes: [], migration: null };
    else if (url.pathname === "/api/onboarding") body = { required: false, phase: "completed" };
    else if (url.pathname === "/api/settings/storage-locations") body = { locations: [{ key: "location_1", rootType: "local", displayName: "Home NAS", path: "/local" }, { key: "location_2", rootType: "remote", displayName: "Archive", path: "/remote" }] };
    else if (url.pathname === "/api/settings/user-preferences") body = { timeFormat: "24h", autoOpenTaskStatus: false, recentJobsCompletedWindowMinutes: 1440 };
    else if (url.pathname === "/api/settings/sections") body = options.extraInstances ? { sections: ["movies", "movies4k", "anime", "shows"], sectionTitles: { movies: "Family Films", movies4k: "Family Films 4K", anime: "Cartoons", shows: "Recordings" }, sectionTypes: { movies: "movies", movies4k: "movies", anime: "movies", shows: "shows" } } : { sections: ["movies", "shows"], sectionTitles: { movies: "Family Films", shows: "Recordings" }, sectionTypes: { movies: "movies", shows: "shows" } };
    else if (url.pathname === "/api/jobs/42") body = { id: 42, type: "scan", status: "completed", progress: { options: { scanSymlinks: true, scanLocal: false, scanRemote: false, titleScopes: [{ section: "movies", itemName: "My First Wedding (2020)" }] } }, startedAt: "2026-09-01T12:00:00.000Z", finishedAt: "2026-09-01T12:00:01.000Z" };
    else if (url.pathname === "/api/jobs/42/events/page") body = { events: [], total: 0, hasMore: false, nextBeforeId: null };
    else if (url.pathname === "/api/system/version") {
      const release = { latestVersion: "0.1.4-beta.1", updateAvailable: false, status: "up_to_date", releaseUrl: null };
      body = { currentVersion: "0.1.4-beta.1", currentChannel: "beta", currentChannelLabel: "Beta", stable: { ...release, channel: "stable" }, beta: { ...release, channel: "beta" }, ...release };
    } else if (url.pathname === "/api/settings/radarr") body = overview();
    else if (url.pathname === "/api/settings/sonarr") body = { instances: [], limit: 25 };
    else if (url.pathname === "/api/settings/sonarr/copy-defaults") body = { sections: [] };
    else if (url.pathname === "/api/settings/radarr/copy-defaults") body = { sections: instances.filter((entry) => entry.settings.enabled).flatMap((entry) => entry.settings.mappings.map((mapping) => ({ section: mapping.section, instanceId: entry.settings.id, instanceName: entry.settings.name, monitorOnCopy: entry.settings.monitorOnCopy }))) };
    else if (url.pathname === "/api/settings/radarr/instances" && request.method() === "POST") {
      const created = instanceState({ id: `new${instances.length}instance`, name: (request.postDataJSON() as { name: string }).name.trim() });
      instances.push(created);
      body = created;
    } else if (instanceRoute && !target) return route.fulfill({ status: 404, json: { error: "This Radarr instance no longer exists. Reload the integration settings." } });
    else if (target && instanceRoute?.[2] === "test") body = { version: "6.0.0", rootFolders: ["/library", "/library4k"], automaticMappings: [{ rootPath: "/library", section: "movies" }], unmatchedRootFolders: ["/library4k"], conflictingRootFolders: [] };
    else if (target && instanceRoute?.[2] === "reconcile") {
      const input: { movieIds: number[]; action: string } = request.postDataJSON();
      writes.push(input);
      await new Promise((resolve) => setTimeout(resolve, 250));
      if (options.failure) return route.fulfill({ status: 409, json: { error: "Storage policy cannot be changed while a copy job is running." } });
      for (const item of target.movies.filter((entry) => input.movieIds.includes(entry.movieId))) { item.managed = true; item.status = "pending"; }
      body = target;
    } else if (target && instanceRoute?.[2] === "refresh") body = target;
    else if (target && instanceRoute?.[2] === "rename") {
      target.settings = { ...target.settings, name: (request.postDataJSON() as { name: string }).name };
      body = overview();
    } else if (target && request.method() === "DELETE") {
      removed.push(target.settings.id);
      instances.splice(instances.indexOf(target), 1);
      body = overview();
    } else if (target) {
      if (request.method() === "PUT") {
        const input: RadarrSettingsInput = request.postDataJSON();
        saves.push(input);
        savedIds.push(target.settings.id);
        await new Promise((resolve) => setTimeout(resolve, 250));
        if (options.saveFailure) return route.fulfill({ status: 400, json: { error: "Radarr rejected the API key." } });
        target.settings = { ...target.settings, revision: target.settings.revision + 1, baseUrl: input.baseUrl, localTag: input.localTag, remoteTag: input.remoteTag, enabled: input.enabled, monitorOnCopy: input.monitorOnCopy, hasApiKey: target.settings.hasApiKey || Boolean(input.apiKey), hasWebhookSecret: target.settings.hasWebhookSecret || Boolean(input.webhookSecret), mappingMode: input.mappingMode, mappings: input.mappingMode === "auto" ? [{ rootPath: "/library", section: "movies" }] : input.mappings };
      }
      body = target;
    }
    await route.fulfill({ json: body });
  });
  return { state, instances, writes, saves, savedIds, removed };
}

function radarrTab(page: Page, name: string) {
  return page.getByRole("tablist", { name: "Radarr settings" }).getByRole("tab", { name });
}

async function openTab(page: Page, name: string) {
  await radarrTab(page, name).click();
  await expect(radarrTab(page, name)).toHaveAttribute("aria-selected", "true");
}

test("settings are split into tabs that share one configuration form", async ({ page }) => {
  await fixture(page);
  await page.goto(`${baseUrl}/settings/integrations`);
  await expect(page.getByRole("tablist", { name: "Radarr settings" }).getByRole("tab")).toHaveText(["Connection", "Folder mappings", "Policy sync", "Copy monitoring", "Webhooks", "Activity"]);
  await expect(radarrTab(page, "Connection")).toHaveAttribute("aria-selected", "true");
  const connection = page.getByRole("tabpanel", { name: "Connection" });
  await expect(connection.getByLabel("Radarr URL", { exact: true })).toBeVisible();
  await expect(connection.getByLabel("API key", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Home NAS policy tag", { exact: true })).toBeHidden();
  await openTab(page, "Policy sync");
  const policy = page.getByRole("tabpanel", { name: "Policy sync" });
  await expect(policy.getByRole("heading")).toHaveText(["Policy tags", "Policy synchronization"]);
  await expect(policy.getByLabel("Home NAS policy tag", { exact: true })).toBeVisible();
  await expect(policy.getByLabel("Archive policy tag", { exact: true })).toBeVisible();
  await expect(policy.getByLabel("Radarr policy preview")).toBeVisible();
  await expect(page.getByLabel("Radarr URL", { exact: true })).toBeHidden();
  await openTab(page, "Copy monitoring");
  const monitoring = page.getByRole("tabpanel", { name: "Copy monitoring" });
  await expect(monitoring.getByLabel("Update Radarr monitoring after copies by default")).not.toBeChecked();
  await openTab(page, "Webhooks");
  const webhooks = page.getByRole("tabpanel", { name: "Webhooks" });
  await expect(webhooks.getByLabel("Header value (secret)", { exact: true })).toBeVisible();
  // A saved secret means the webhook is set up, so the steps start collapsed but still open on click.
  const steps = webhooks.locator("details");
  await expect(steps).not.toHaveAttribute("open");
  await webhooks.getByText("Webhook setup", { exact: true }).click();
  await expect(steps).toHaveAttribute("open");
  await expect(steps.locator(".radarr-webhook-steps > li")).toHaveCount(7);
  await expect(steps.locator(".radarr-trigger-list li")).toHaveText(["On File Import", "On File Upgrade", "On Rename", "On Movie Added", "On Movie Delete", "On Movie File Delete"]);
  await expect(steps).toContainText("leave all others off. SRTL rejects event types it doesn't handle");
  await expect(steps).toContainText("A secret is saved.");
  // Each step carries the value Radarr needs, in Radarr's own order: URL, then the header key and value.
  expect(await steps.locator("input").evaluateAll((inputs) => inputs.map((input) => input.id))).toEqual(["radarr-webhook-url", "radarr-webhook-header"]);
  await expect(steps.getByLabel("Key", { exact: true })).toHaveValue("X-SRTL-Webhook-Secret");
  await expect(steps).toContainText("Value: the secret you saved in step 1.");
  await steps.getByRole("button", { name: "Activity tab", exact: true }).click();
  await expect(radarrTab(page, "Activity")).toHaveAttribute("aria-selected", "true");
  await openTab(page, "Webhooks");
  await openTab(page, "Activity");
  const activity = page.getByRole("tabpanel", { name: "Activity" });
  await expect(activity.getByRole("heading")).toHaveText(["Webhook events", "Monitoring updates"]);
  await expect(activity.getByLabel("Recent Radarr events")).toBeVisible();
  await expect(activity.getByLabel("Recent Radarr monitoring updates")).toContainText("Unmonitor");
  await expect(activity.getByLabel("Recent Radarr monitoring updates")).toContainText("#77");
  await expect(page.locator(".radarr-integration-header").getByLabel("Enable integration", { exact: true })).toBeVisible();
  await expect(page.locator(".radarr-integration-header").getByRole("button", { name: "Save Radarr settings", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Save Radarr settings", exact: true })).toHaveCount(1);
  for (const id of ["radarr-url", "radarr-api-key", "radarr-local-tag", "radarr-remote-tag", "radarr-webhook-secret"]) {
    expect(await page.locator(`#${id}`).evaluate((field: HTMLInputElement) => field.form?.id)).toBe("radarr-settings-form");
  }
  expect(await page.getByLabel("Update Radarr monitoring after copies by default").evaluate((field: HTMLInputElement) => field.form?.id)).toBe("radarr-settings-form");
  expect(await page.getByLabel("Search Radarr titles").evaluate((field: HTMLInputElement) => field.form)).toBeNull();
});

test("Radarr tabs follow arrow keys, remember the selection, and mark unsaved edits", async ({ page }) => {
  await fixture(page);
  await page.goto(`${baseUrl}/settings/integrations`);
  const connection = radarrTab(page, "Connection");
  await connection.focus();
  await connection.press("ArrowRight");
  await expect(radarrTab(page, "Folder mappings")).toBeFocused();
  await expect(radarrTab(page, "Folder mappings")).toHaveAttribute("aria-selected", "true");
  await radarrTab(page, "Folder mappings").press("End");
  await expect(radarrTab(page, "Activity")).toBeFocused();
  await radarrTab(page, "Activity").press("ArrowRight");
  await expect(connection).toBeFocused();
  await connection.press("ArrowLeft");
  await expect(radarrTab(page, "Activity")).toHaveAttribute("aria-selected", "true");
  await radarrTab(page, "Activity").press("Home");
  await expect(connection).toHaveAttribute("aria-selected", "true");
  await openTab(page, "Webhooks");
  await page.getByLabel("Header value (secret)", { exact: true }).fill("fixture_only_webhook_secret_1234");
  await openTab(page, "Connection");
  await expect(radarrTab(page, "Webhooks")).toHaveAccessibleName("Webhooks (unsaved changes)");
  await expect(connection).toHaveAccessibleName("Connection");
  await expect(page.locator(".radarr-save-status")).toHaveText("Unsaved changes");
  await openTab(page, "Activity");
  await page.setViewportSize({ width: 320, height: 800 });
  await page.reload();
  await expect(radarrTab(page, "Activity")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByLabel("Recent Radarr events")).toBeVisible();
  const tab = await radarrTab(page, "Activity").boundingBox();
  expect(tab!.x).toBeGreaterThanOrEqual(0);
  expect(tab!.x + tab!.width).toBeLessThanOrEqual(320);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("unsaved edits are visible and policy actions never submit or use draft settings", async ({ page }) => {
  const { saves, writes } = await fixture(page);
  await page.goto(`${baseUrl}/settings/integrations`);
  await openTab(page, "Policy sync");
  const status = page.locator(".radarr-save-status");
  await expect(status).toHaveText("No unsaved changes");
  const tag = page.getByLabel("Home NAS policy tag", { exact: true });
  await tag.fill("home");
  await expect(status).toHaveText("Unsaved changes");
  await expect(radarrTab(page, "Policy sync")).toHaveAccessibleName("Policy sync (unsaved changes)");
  await expect(page.locator(".radarr-draft-notice")).toContainText("use saved settings");
  await tag.fill("local");
  await expect(status).toHaveText("No unsaved changes");
  await expect(radarrTab(page, "Policy sync")).toHaveAccessibleName("Policy sync");
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
  await expect(radarrTab(page, "Policy sync")).toHaveAttribute("aria-selected", "true");
  expect(saves).toHaveLength(1);
  expect(saves[0]).toMatchObject({ enabled: true, localTag: "home" });
});

test("failed saves keep the draft and unsaved marker until retry succeeds", async ({ page }) => {
  const options = { saveFailure: true };
  const { saves } = await fixture(page, options);
  await page.goto(`${baseUrl}/settings/integrations`);
  await openTab(page, "Policy sync");
  await page.getByLabel("Archive policy tag", { exact: true }).fill("archive");
  await page.getByRole("button", { name: "Save Radarr settings", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Radarr rejected the API key.");
  await expect(page.locator(".radarr-save-status")).toHaveText("Unsaved changes");
  await expect(page.getByLabel("Archive policy tag", { exact: true })).toHaveValue("archive");
  await page.getByRole("tab", { name: "Sonarr", exact: true }).click();
  await page.getByRole("tab", { name: "Radarr", exact: true }).click();
  await expect(radarrTab(page, "Policy sync")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByLabel("Archive policy tag", { exact: true })).toHaveValue("archive");
  options.saveFailure = false;
  await page.getByRole("button", { name: "Save Radarr settings", exact: true }).click();
  await expect(page.locator(".radarr-save-status")).toHaveText("No unsaved changes");
  expect(saves).toHaveLength(2);
});

test("the shared save reveals invalid fields on hidden tabs and keeps the webhook secret optional", async ({ page }) => {
  const { state, saves } = await fixture(page);
  state.settings.hasWebhookSecret = false;
  await page.goto(`${baseUrl}/settings/integrations`);
  await page.getByLabel("Enable integration", { exact: true }).check();
  const save = page.getByRole("button", { name: "Save Radarr settings", exact: true });
  await openTab(page, "Webhooks");
  const secret = page.getByLabel("Header value (secret)", { exact: true });
  expect(await secret.evaluate((field: HTMLInputElement) => field.validity.valueMissing)).toBe(false);
  await secret.fill("fixture_only_webhook_secret_1234");
  await openTab(page, "Folder mappings");
  const root = page.getByLabel("Radarr root folder");
  await root.fill("");
  await expect(radarrTab(page, "Folder mappings")).toHaveAccessibleName("Folder mappings (unsaved changes)");
  await openTab(page, "Webhooks");
  await save.click();
  expect(saves).toHaveLength(0);
  await expect(radarrTab(page, "Folder mappings")).toHaveAttribute("aria-selected", "true");
  await expect(root).toBeFocused();
  expect(await root.evaluate((field: HTMLInputElement) => field.validity.valueMissing)).toBe(true);
  await root.fill("/library");
  await save.click();
  await expect.poll(() => saves.length).toBe(1);
  await openTab(page, "Webhooks");
  await expect(secret).toHaveValue("");
  await expect(secret).toHaveAttribute("placeholder", "Saved; leave blank to keep");
});

test("integration tabs isolate settings and preserve edits with mouse and keyboard", async ({ page }, testInfo) => {
  const { saves } = await fixture(page);
  await page.goto(`${baseUrl}/settings/integrations`);
  const radarr = page.getByRole("tab", { name: "Radarr", exact: true });
  const sonarr = page.getByRole("tab", { name: "Sonarr", exact: true });
  await expect(radarr).toHaveAttribute("aria-selected", "true");
  await openTab(page, "Policy sync");
  await page.getByLabel("Home NAS policy tag", { exact: true }).fill("home");
  await sonarr.click();
  await expect(page.getByRole("tabpanel", { name: "Radarr" })).toBeHidden();
  await expect(page.getByRole("tabpanel", { name: "Sonarr" })).toContainText("No Sonarr instances yet.");
  await expect(page.getByRole("button", { name: "Save Radarr settings" })).toBeHidden();
  await sonarr.press("ArrowLeft");
  await expect(radarr).toBeFocused();
  await expect(page.getByLabel("Home NAS policy tag", { exact: true })).toHaveValue("home");
  await radarr.press("End");
  const watchSync = page.getByRole("tab", { name: "Watch sync", exact: true });
  await expect(watchSync).toBeFocused();
  await watchSync.press("Home");
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
  await page.getByRole("button", { name: "Test connection", exact: true }).click();
  await expect(page.getByText("Radarr 6.0.0 connected")).toBeVisible();
  await openTab(page, "Folder mappings");
  await expect(page.getByRole("button", { name: "Automatic", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByLabel("Radarr root folder")).toHaveCount(0);
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
  await expect(page.locator(".radarr-save-status")).toHaveText("No unsaved changes");
  await page.reload();
  await expect(radarrTab(page, "Folder mappings")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("button", { name: "Automatic", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(preview).toContainText("Saved matches");
});

test("automatic mapping exposes no-match and connection failure states without stale matches", async ({ page }) => {
  await fixture(page);
  await page.goto(`${baseUrl}/settings/integrations`);
  await openTab(page, "Folder mappings");
  await page.getByRole("button", { name: "Automatic", exact: true }).click();
  await openTab(page, "Connection");
  await page.getByRole("button", { name: "Test connection", exact: true }).click();
  await openTab(page, "Folder mappings");
  const preview = page.getByRole("region", { name: "Automatic folder matches" });
  await expect(preview).toContainText("Family Films");
  await openTab(page, "Connection");
  await page.getByLabel("Radarr URL", { exact: true }).fill("http://different:7878");
  await openTab(page, "Folder mappings");
  await expect(preview).not.toContainText("Family Films");
  await openTab(page, "Connection");
  await page.getByLabel("API key", { exact: true }).fill("newtestkey");
  await page.route("**/api/settings/radarr/instances/*/test", (route) => route.fulfill({ json: { version: "6.0.0", rootFolders: ["/different/movies"], automaticMappings: [], unmatchedRootFolders: ["/different/movies"], conflictingRootFolders: [] } }));
  await page.getByRole("button", { name: "Test connection", exact: true }).click();
  await openTab(page, "Folder mappings");
  await expect(preview).toContainText("No exact folder matches found.");
  await openTab(page, "Connection");
  await page.route("**/api/settings/radarr/instances/*/test", (route) => route.fulfill({ status: 400, json: { error: "Radarr connection failed or timed out." } }));
  await page.getByRole("button", { name: "Test connection", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Radarr connection failed or timed out.");
  await expect(page.getByText("Radarr 6.0.0 connected")).toHaveCount(0);
});

test("connection preserves saved secrets and only applies edits after saving", async ({ page }) => {
  const { saves } = await fixture(page);
  await page.goto(`${baseUrl}/settings/integrations`);
  await expect(page.getByRole("heading", { name: "Settings > Integrations" })).toBeVisible();
  await expect(page.getByLabel("API key", { exact: true })).toHaveValue("");
  await openTab(page, "Folder mappings");
  await expect(page.getByLabel("SRTL symlink section").locator("option")).toHaveText(["Select section", "Family Films"]);
  await openTab(page, "Policy sync");
  await page.getByLabel("Home NAS policy tag", { exact: true }).fill("home");
  await openTab(page, "Connection");
  await page.getByRole("button", { name: "Test connection", exact: true }).click();
  await expect(page.getByText("Radarr 6.0.0 connected")).toBeVisible();
  await openTab(page, "Policy sync");
  await page.getByRole("button", { name: "Refresh preview" }).click();
  await expect(page.getByLabel("Home NAS policy tag", { exact: true })).toHaveValue("home");
  expect(saves).toHaveLength(0);
  await page.getByLabel("Enable integration").check();
  await page.getByRole("button", { name: "Save Radarr settings" }).click();
  await expect(page.locator(".radarr-state")).toHaveText("Current: Enabled");
  expect(saves[0]).toMatchObject({ localTag: "home", apiKey: "", webhookSecret: "", enabled: true });
  await openTab(page, "Connection");
  await expect(page.getByLabel("API key", { exact: true })).toHaveValue("");
});

test("unconfigured policy tags stay empty with examples and cannot enable sync", async ({ page }) => {
  const { state, saves } = await fixture(page);
  state.settings.localTag = "";
  state.settings.remoteTag = "";
  await page.goto(`${baseUrl}/settings/integrations`);
  await openTab(page, "Policy sync");
  const localTag = page.getByLabel("Home NAS policy tag", { exact: true });
  const remoteTag = page.getByLabel("Archive policy tag", { exact: true });
  await expect(localTag).toHaveValue("");
  await expect(localTag).toHaveAttribute("placeholder", "local");
  await expect(remoteTag).toHaveValue("");
  await expect(remoteTag).toHaveAttribute("placeholder", "remote");
  await openTab(page, "Connection");
  await page.getByRole("button", { name: "Test connection", exact: true }).click();
  await expect(page.getByText("Radarr 6.0.0 connected")).toBeVisible();
  await page.getByRole("button", { name: "Save Radarr settings" }).click();
  await expect.poll(() => saves.length).toBe(1);
  expect(saves[0]).toMatchObject({ localTag: "", remoteTag: "", enabled: false });
  await openTab(page, "Policy sync");
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
    await expect(setupGuide).toContainText("follow the Webhook setup steps in the Webhooks tab.");
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
    const tooltip = page.getByRole("tooltip").filter({ hasText: "Save this instance's settings to apply this change" });
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
  await openTab(page, "Policy sync");
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
  await openTab(page, "Policy sync");
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
  await openTab(page, "Policy sync");
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
  await openTab(page, "Copy monitoring");
  const toggle = page.getByLabel("Update Radarr monitoring after copies by default");
  await toggle.check();
  await expect(page.locator(".radarr-save-status")).toHaveText("Unsaved changes");
  await expect(radarrTab(page, "Copy monitoring")).toHaveAccessibleName("Copy monitoring (unsaved changes)");
  await page.getByRole("button", { name: "Save Radarr settings", exact: true }).click();
  await expect(page.locator(".radarr-save-status")).toHaveText("No unsaved changes");
  expect(saves[0]).toMatchObject({ monitorOnCopy: true });
  await expect(toggle).toBeChecked();
  await expect(radarrTab(page, "Copy monitoring")).toHaveAccessibleName("Copy monitoring");
});

test("select all matching selects every mapped filtered title across pages", async ({ page }) => {
  const { state } = await fixture(page);
  state.movies = [...Array.from({ length: 30 }, (_, index) => movie(index + 1, `Wedding Recording ${String(index + 1).padStart(2, "0")}`)), { ...movie(31, "Wedding Recording Unmapped"), section: null, itemName: null, status: "unmapped" }];
  await page.goto(`${baseUrl}/settings/integrations`);
  await openTab(page, "Policy sync");
  await page.getByRole("button", { name: "Select all matching" }).click();
  await expect(page.getByText("30 selected", { exact: true })).toBeVisible();
});

test("empty integration remains usable", async ({ page }) => {
  await fixture(page, { empty: true });
  await page.goto(`${baseUrl}/settings/integrations`);
  await openTab(page, "Policy sync");
  await expect(page.getByText("No titles loaded.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Select page" })).toBeDisabled();
  await openTab(page, "Activity");
  await expect(page.getByText("No webhook events received.")).toBeVisible();
  await expect(page.getByText("No monitoring updates yet.")).toBeVisible();
});

test("webhook activity opens the standard scan status window", async ({ page }) => {
  const { state } = await fixture(page);
  state.events[0] = { ...state.events[0]!, error: null, processedAt: "2026-09-01T12:00:01.000Z", jobId: 42, jobStatus: "completed" };
  await page.goto(`${baseUrl}/settings/integrations`);
  await openTab(page, "Activity");
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
      const tablist = await page.getByRole("tablist", { name: "Radarr settings" }).boundingBox();
      expect(tablist!.x).toBeGreaterThanOrEqual(0);
      expect(tablist!.x + tablist!.width).toBeLessThanOrEqual(width);
      for (const name of ["Connection", "Folder mappings", "Policy sync", "Copy monitoring", "Webhooks", "Activity"]) {
        await openTab(page, name);
        await expect(page.getByRole("button", { name: "Save Radarr settings", exact: true })).toBeVisible();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        const fieldBounds = await page.locator(".radarr-fields input:not([type=checkbox]):visible, .radarr-fields select:visible").evaluateAll((fields) => fields.map((field) => {
          const box = field.getBoundingClientRect();
          return { left: box.left, right: box.right, width: box.width, height: box.height };
        }));
        expect(fieldBounds.every((box) => box.left >= 0 && box.right <= width && box.width >= 100 && box.height >= 38)).toBe(true);
        if (name === "Policy sync") {
          await expect(page.getByRole("heading", { name: "Policy synchronization" })).toBeVisible();
          const previous = await page.getByRole("button", { name: "Previous page" }).boundingBox();
          const next = await page.getByRole("button", { name: "Next page" }).boundingBox();
          expect(previous?.y).toBe(next?.y);
        }
        await page.screenshot({ path: testInfo.outputPath(`radarr-${theme}-${width}-${name.toLowerCase().replaceAll(" ", "-")}.png`), fullPage: true });
      }
    }
  });
}

const otherInstances = [
  { id: "b2c3d4e5f6a1", name: "Radarr 4K", baseUrl: "http://radarr4k:7878", hasApiKey: true, localTag: "keep", remoteTag: "cloud", mappingMode: "manual" as const, mappings: [{ rootPath: "/library4k", section: "movies4k" }], lastRefreshAt: "2026-09-01T12:10:00.000Z", lastError: "Radarr returned HTTP 503." },
  { id: "c3d4e5f6a1b2", name: "Anime" }
];

function instanceList(page: Page) {
  return page.getByRole("region", { name: "Radarr instances" }).getByRole("listitem");
}

function instanceButton(page: Page, name: string) {
  return page.getByRole("region", { name: "Radarr instances" }).locator(".radarr-instance").filter({ has: page.locator(".radarr-instance-name").getByText(name, { exact: true }) });
}

test("instances are listed with status and folders, and each keeps its own settings and draft", async ({ page }) => {
  const { saves, savedIds } = await fixture(page, { extraInstances: otherInstances });
  await page.goto(`${baseUrl}/settings/integrations`);
  await expect(instanceList(page)).toHaveCount(3);
  await expect(instanceList(page).nth(0)).toContainText("Radarr");
  await expect(instanceList(page).nth(0)).toContainText("Paused");
  await expect(instanceList(page).nth(0)).toContainText("Family Films");
  await expect(instanceList(page).nth(0)).toContainText("3 need review");
  await expect(instanceList(page).nth(1)).toContainText("Error");
  await expect(instanceList(page).nth(1)).toContainText("Family Films 4K");
  await expect(instanceList(page).nth(1)).toContainText("Radarr returned HTTP 503.");
  await expect(instanceList(page).nth(2)).toContainText("Not connected");
  await expect(instanceList(page).nth(2)).toContainText("No folders mapped");
  await expect(instanceButton(page, "Radarr")).toHaveAttribute("aria-current", "true");

  await openTab(page, "Policy sync");
  await page.getByLabel("Home NAS policy tag", { exact: true }).fill("home");
  await instanceButton(page, "Radarr 4K").click();
  await expect(instanceButton(page, "Radarr 4K")).toHaveAttribute("aria-current", "true");
  await expect(page.locator(".radarr-integration-header h2")).toHaveText("Radarr 4K");
  await expect(page.getByLabel("Home NAS policy tag", { exact: true })).toHaveValue("keep");
  await expect(page.locator(".radarr-save-status")).toHaveText("No unsaved changes");
  await expect(instanceButton(page, "Radarr")).toHaveAccessibleName(/unsaved changes/);
  await expect(page.getByText("No titles loaded.")).toBeVisible();
  await openTab(page, "Webhooks");
  await expect(page.getByLabel("Webhook URL", { exact: true })).toHaveValue(/\/api\/integrations\/radarr\/b2c3d4e5f6a1\/webhook$/);
  await expect(page.getByText("keeps working for this instance")).toHaveCount(0);

  await instanceButton(page, "Radarr").click();
  await expect(page.getByLabel("Webhook URL", { exact: true })).toHaveValue(/\/api\/integrations\/radarr\/a1b2c3d4e5f6\/webhook$/);
  await page.getByText("Webhook setup", { exact: true }).click();
  await expect(page.getByText("The original URL ending in /api/integrations/radarr/webhook keeps working for this instance.")).toBeVisible();
  await openTab(page, "Policy sync");
  await expect(page.getByLabel("Home NAS policy tag", { exact: true })).toHaveValue("home");
  await expect(page.locator(".radarr-save-status")).toHaveText("Unsaved changes");
  await page.getByRole("button", { name: "Save Radarr settings", exact: true }).click();
  await expect(page.locator(".radarr-save-status")).toHaveText("No unsaved changes");
  expect(saves).toHaveLength(1);
  expect(savedIds).toEqual(["a1b2c3d4e5f6"]);
  expect(saves[0]).toMatchObject({ localTag: "home" });
  await expect(instanceButton(page, "Radarr")).not.toHaveAccessibleName(/unsaved changes/);

  // The selected instance is remembered across reloads.
  await instanceButton(page, "Anime").click();
  await page.reload();
  await expect(instanceButton(page, "Anime")).toHaveAttribute("aria-current", "true");
  await expect(page.locator(".radarr-state")).toHaveText("Current: Not connected");
});

test("folder mappings show folders owned by other instances", async ({ page }) => {
  await fixture(page, { extraInstances: otherInstances });
  await page.goto(`${baseUrl}/settings/integrations`);
  await openTab(page, "Folder mappings");
  const options = page.getByLabel("SRTL symlink section").locator("option");
  await expect(options).toHaveText(["Select section", "Family Films", "Family Films 4K (mapped by Radarr 4K)", "Cartoons"]);
  expect(await options.evaluateAll((items) => items.map((item) => (item as HTMLOptionElement).disabled))).toEqual([false, false, true, false]);
  await expect(page.getByText("Mapped by other instances: Family Films 4K (Radarr 4K).")).toBeVisible();
  await instanceButton(page, "Anime").click();
  await page.route("**/api/settings/radarr/instances/*/test", (route) => route.fulfill({ json: { version: "6.0.0", rootFolders: ["/library", "/anime"], automaticMappings: [{ rootPath: "/anime", section: "anime" }], unmatchedRootFolders: [], conflictingRootFolders: [{ rootPath: "/library", section: "movies", instanceId: "a1b2c3d4e5f6", instanceName: "Radarr" }] } }));
  await openTab(page, "Connection");
  await page.getByLabel("Radarr URL", { exact: true }).fill("http://anime:7878");
  await page.getByLabel("API key", { exact: true }).fill("animekey");
  await page.getByRole("button", { name: "Test connection", exact: true }).click();
  await openTab(page, "Folder mappings");
  const preview = page.getByRole("region", { name: "Automatic folder matches" });
  await expect(preview).toContainText("Cartoons");
  await expect(preview).toContainText("Folders mapped by another instance");
  await expect(preview).toContainText("/library: Family Films belongs to Radarr");
});

test("instances can be added, renamed, and removed with confirmation", async ({ page }) => {
  const { removed, instances } = await fixture(page);
  await page.goto(`${baseUrl}/settings/integrations`);
  await expect(instanceList(page)).toHaveCount(1);
  await page.getByRole("button", { name: "Add instance", exact: true }).click();
  await page.getByLabel("Instance name", { exact: true }).fill("Radarr 4K");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(instanceList(page)).toHaveCount(2);
  await expect(instanceButton(page, "Radarr 4K")).toHaveAttribute("aria-current", "true");
  await expect(radarrTab(page, "Connection")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByLabel("Radarr URL", { exact: true })).toHaveValue("");
  await expect(page.getByRole("button", { name: "Save Radarr 4K settings", exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Rename Radarr 4K", exact: true }).click();
  await page.getByLabel("Instance name", { exact: true }).fill("Radarr UHD");
  await page.getByRole("button", { name: "Save name", exact: true }).click();
  await expect(page.locator(".radarr-integration-header h2")).toHaveText("Radarr UHD");
  await expect(instanceButton(page, "Radarr UHD")).toBeVisible();

  await page.getByRole("button", { name: "Remove Radarr UHD", exact: true }).click();
  const confirmation = page.getByRole("group", { name: "Confirm removing Radarr UHD" });
  await expect(confirmation).toContainText("Tags and monitoring in Radarr stay exactly as they are.");
  await confirmation.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(removed).toEqual([]);
  await page.getByRole("button", { name: "Remove Radarr UHD", exact: true }).click();
  await page.getByRole("button", { name: "Remove instance", exact: true }).click();
  await expect(instanceList(page)).toHaveCount(1);
  await expect(instanceButton(page, "Radarr")).toHaveAttribute("aria-current", "true");
  expect(removed).toHaveLength(1);
  expect(instances.map((entry) => entry.settings.name)).toEqual(["Radarr"]);
});

test("no instances shows an empty state with Add instance", async ({ page }) => {
  const { instances } = await fixture(page);
  instances.splice(0);
  await page.goto(`${baseUrl}/settings/integrations`);
  await expect(page.getByText("No Radarr instances yet.")).toBeVisible();
  await expect(page.getByRole("tablist", { name: "Radarr settings" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Add instance", exact: true })).toBeEnabled();
});

for (const width of [1440, 390, 320]) {
  test(`ten instances stay usable at ${width}px`, async ({ page }, testInfo) => {
    const many = Array.from({ length: 9 }, (_, index) => ({ id: `e${index}e${index}e${index}`, name: `Radarr instance with a long name ${index + 2}`, enabled: index % 2 === 0, hasApiKey: true, mappings: index === 0 ? [{ rootPath: "/library4k", section: "movies4k" }] : [] }));
    await fixture(page, { extraInstances: many });
    await page.setViewportSize({ width, height: 1000 });
    await page.goto(`${baseUrl}/settings/integrations`);
    await expect(instanceList(page)).toHaveCount(10);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const boxes = await instanceList(page).evaluateAll((items) => items.map((item) => item.getBoundingClientRect()).map((box) => ({ left: box.left, right: box.right, height: box.height })));
    expect(boxes.every((box) => box.left >= 0 && box.right <= width && box.height >= 44)).toBe(true);
    await instanceButton(page, "Radarr instance with a long name 10").click();
    await expect(page.locator(".radarr-integration-header h2")).toHaveText("Radarr instance with a long name 10");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`radarr-instances-${width}.png`), fullPage: true });
  });
}

test("generate secret fills the webhook secret, marks it unsaved, and stays copyable after saving until the page is left", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const { state, saves } = await fixture(page);
  state.settings.hasWebhookSecret = false;
  await page.goto(`${baseUrl}/settings/integrations`);
  await openTab(page, "Webhooks");
  await expect(page.locator(".radarr-save-status")).toHaveText("No unsaved changes");
  await page.getByRole("button", { name: "Generate secret", exact: true }).click();
  const generated = page.getByLabel("Generated secret", { exact: true });
  const first = await generated.inputValue();
  expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
  await expect(page.getByLabel("Header value (secret)", { exact: true })).toHaveValue(first);
  await expect(radarrTab(page, "Webhooks")).toHaveAccessibleName("Webhooks (unsaved changes)");
  await expect(page.getByRole("group", { name: "Generated webhook secret" })).toContainText("SRTL only stores a hash and can't show it again after you leave this page.");
  await expect(page.getByRole("group", { name: "Generated webhook secret" })).not.toContainText("replaces the current secret");
  const generatedGroup = page.getByRole("group", { name: "Generated webhook secret" });
  await generatedGroup.getByRole("button", { name: "Copy", exact: true }).click();
  await expect(generatedGroup.getByRole("button", { name: "Copied", exact: true })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(first);
  const steps = page.locator(".radarr-webhook-setup");
  await expect(steps).toHaveAttribute("open");
  for (const [label, value] of [["Webhook URL", /\/api\/integrations\/radarr\/a1b2c3d4e5f6\/webhook$/], ["Key", /^X-SRTL-Webhook-Secret$/], ["Value", new RegExp(`^${first}$`)]] as const) {
    const field = steps.locator(".radarr-step-field").filter({ has: page.getByLabel(label, { exact: true }) });
    await field.getByRole("button", { name: "Copy", exact: true }).click();
    await expect(field.getByRole("button", { name: "Copied", exact: true })).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toMatch(value);
  }
  await page.getByRole("button", { name: "Generate new secret", exact: true }).click();
  const second = await generated.inputValue();
  expect(second).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(second).not.toBe(first);
  // Typing over it falls back to manual entry and hides the generated value.
  await page.getByLabel("Header value (secret)", { exact: true }).fill("typed_by_hand_secret_value_123");
  await expect(generated).toHaveCount(0);
  await page.getByRole("button", { name: "Generate secret", exact: true }).click();
  const third = await generated.inputValue();
  await page.getByRole("button", { name: "Save Radarr settings", exact: true }).click();
  await expect(page.locator(".radarr-save-status")).toHaveText("No unsaved changes");
  expect(saves[0]?.webhookSecret).toBe(third);
  // Saving is step 1 of the setup, so the steps stay open and the saved secret stays copyable for steps 4 and 5.
  await expect(generated).toHaveValue(third);
  await expect(page.getByRole("group", { name: "Generated webhook secret" })).toContainText("Saved. Copy it into Radarr");
  await expect(steps).toHaveAttribute("open");
  await expect(steps.getByLabel("Value", { exact: true })).toHaveValue(third);
  await expect(steps).toContainText("A secret is saved.");
  await expect(page.getByLabel("Header value (secret)", { exact: true })).toHaveValue("");
  await expect(page.getByLabel("Header value (secret)", { exact: true })).toHaveAttribute("placeholder", "Saved; leave blank to keep");
  // With a saved secret, generating warns that Radarr needs the replacement.
  await page.getByRole("button", { name: "Generate new secret", exact: true }).click();
  await expect(page.getByRole("group", { name: "Generated webhook secret" })).toContainText("Saving replaces the current secret, so Radarr must be updated with this new value.");
  // Leaving the page drops the generated secret: SRTL can't show a saved one again.
  await page.reload();
  await expect(page.locator(".radarr-webhook-setup")).not.toHaveAttribute("open");
  await expect(generated).toHaveCount(0);
});

test("the Webhooks tab with unsaved changes fits a phone-width page", async ({ page }) => {
  const { state } = await fixture(page);
  state.settings.hasWebhookSecret = false;
  await page.setViewportSize({ width: 390, height: 1000 });
  await page.goto(`${baseUrl}/settings/integrations`);
  await openTab(page, "Webhooks");
  await page.getByRole("button", { name: "Generate secret", exact: true }).click();
  await expect(page.locator(".radarr-webhook-setup")).toHaveAttribute("open");
  await expect(radarrTab(page, "Webhooks")).toHaveAccessibleName("Webhooks (unsaved changes)");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  for (const id of ["radarr-webhook-url", "radarr-webhook-header", "radarr-webhook-header-value", "radarr-webhook-secret", "radarr-generated-secret"]) {
    const box = await page.locator(`#${id}`).boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  }
});
