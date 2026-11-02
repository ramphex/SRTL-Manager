import { expect, test, type Page } from "@playwright/test";
import type { SonarrOverview, SonarrSeriesStatus, SonarrSettings, SonarrSettingsInput, SonarrState } from "../../src/shared/sonarr";

const baseUrl = process.env.SRTL_E2E_BASE_URL;
test.skip(!baseUrl, "Set SRTL_E2E_BASE_URL to run browser checks.");

function series(id: number, title: string, extra: Partial<SonarrSeriesStatus> = {}): SonarrSeriesStatus {
  return { seriesId: id, tvdbId: id + 500, title, folderPath: `/tv/${title}`, section: "shows", itemName: title, tags: ["family"], monitored: true, policy: "unassigned", tagPolicy: "unassigned", managed: true, status: "synced", message: null, syncedAt: null, ...extra };
}

function settings(extra: Partial<SonarrSettings> & { id: string; name: string }): SonarrSettings {
  return { revision: 1, legacyWebhook: false, baseUrl: "http://sonarr:8989", enabled: true, localTag: "local", remoteTag: "ignored", monitorOnCopy: true, mappingMode: "manual", mappings: [{ rootPath: "/tv", section: "shows" }], hasApiKey: true, hasWebhookSecret: false, lastRefreshAt: "2026-11-01T12:00:00.000Z", lastError: null, ...extra };
}

async function fixture(page: Page) {
  const instances: SonarrState[] = [
    {
      settings: settings({ id: "5e7a2b9c0d1f", name: "Sonarr" }),
      series: [series(1, "Family Holidays (2020)"), series(2, "Garden Diaries (2021)", { tags: ["ignored"], tagPolicy: "location_2", policy: "location_1", managed: false, status: "review" })],
      events: [{ id: 1, seriesId: 1, title: "Family Holidays", eventType: "Download", receivedAt: "2026-11-01T12:00:00.000Z", processedAt: "2026-11-01T12:00:04.000Z", error: null, jobId: 42, jobStatus: "completed" }],
      monitorUpdates: [{ id: 1, seriesId: 1, episodeId: 101, title: "Family Holidays (2020) S01E01", monitored: false, copyJobId: 77, createdAt: "2026-11-01T12:05:00.000Z", processedAt: "2026-11-01T12:05:05.000Z", error: null }]
    },
    { settings: settings({ id: "8c1d4e2f6a3b", name: "Sonarr 4K", mappings: [{ rootPath: "/tv4k", section: "shows4k" }] }), series: [], events: [], monitorUpdates: [] }
  ];
  const saves: SonarrSettingsInput[] = [];
  const overview = (): SonarrOverview => ({ limit: 25, instances: instances.map((entry) => ({ settings: entry.settings, series: entry.series.length, mapped: entry.series.length, review: entry.series.filter((item) => item.status === "review").length, errors: 0 })) });
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const instanceRoute = url.pathname.match(/^\/api\/settings\/sonarr\/instances\/([^/]+)(?:\/(test|refresh|reconcile|rename))?$/);
    const target = instanceRoute ? instances.find((entry) => entry.settings.id === instanceRoute[1]) : undefined;
    let body: unknown = [];
    if (url.pathname === "/api/auth/me") body = { setupRequired: false, authenticated: true, user: { id: 1, username: "integration-test" } };
    else if (url.pathname === "/api/system/path-migration") body = { status: "ready", blocking: false, activePaths: {}, detectedPaths: {}, environmentErrors: [], changes: [], migration: null };
    else if (url.pathname === "/api/onboarding") body = { required: false, phase: "completed" };
    else if (url.pathname === "/api/settings/storage-locations") body = { locations: [{ key: "location_1", rootType: "local", displayName: "Home NAS", path: "/local" }, { key: "location_2", rootType: "remote", displayName: "Archive", path: "/remote" }] };
    else if (url.pathname === "/api/settings/user-preferences") body = { timeFormat: "24h", autoOpenTaskStatus: false, recentJobsCompletedWindowMinutes: 1440 };
    else if (url.pathname === "/api/settings/sections") body = { sections: ["movies", "shows", "shows4k"], sectionTitles: { movies: "Family Films", shows: "Recordings", shows4k: "Recordings 4K" }, sectionTypes: { movies: "movies", shows: "shows", shows4k: "shows" } };
    else if (url.pathname === "/api/system/version") {
      const release = { latestVersion: "0.1.4-beta.1", updateAvailable: false, status: "up_to_date", releaseUrl: null };
      body = { currentVersion: "0.1.4-beta.1", currentChannel: "beta", currentChannelLabel: "Beta", stable: { ...release, channel: "stable" }, beta: { ...release, channel: "beta" }, ...release };
    } else if (url.pathname === "/api/settings/radarr") body = { instances: [], limit: 25 };
    else if (url.pathname === "/api/settings/sonarr") body = overview();
    else if (target && instanceRoute?.[2] === "test") body = { version: "4.0.15", rootFolders: ["/tv", "/tv4k"], automaticMappings: [], unmatchedRootFolders: ["/tv"], conflictingRootFolders: [{ rootPath: "/tv4k", section: "shows4k", instanceId: "8c1d4e2f6a3b", instanceName: "Sonarr 4K" }] };
    else if (target && request.method() === "PUT") {
      const input: SonarrSettingsInput = request.postDataJSON();
      saves.push(input);
      target.settings = { ...target.settings, revision: target.settings.revision + 1, hasWebhookSecret: target.settings.hasWebhookSecret || Boolean(input.webhookSecret), monitorOnCopy: input.monitorOnCopy };
      body = target;
    } else if (target) body = target;
    await route.fulfill({ json: body });
  });
  return { instances, saves };
}

async function openSonarr(page: Page) {
  await page.goto(`${baseUrl}/settings/integrations`);
  await page.getByRole("tab", { name: "Sonarr", exact: true }).click();
  return page.getByRole("tabpanel", { name: "Sonarr", exact: true });
}

function sonarrTab(page: Page, name: string) {
  return page.getByRole("tablist", { name: "Sonarr settings" }).getByRole("tab", { name });
}

test("Sonarr has its own instance list and the same settings tabs as Radarr", async ({ page }) => {
  await fixture(page);
  const panel = await openSonarr(page);
  await expect(panel.getByRole("heading", { name: "Sonarr instances" })).toBeVisible();
  await expect(panel.locator(".radarr-instance")).toHaveCount(2);
  await expect(panel.locator(".radarr-instance").first()).toContainText("Recordings");
  await expect(page.getByRole("tablist", { name: "Sonarr settings" }).getByRole("tab")).toHaveText(["Connection", "Folder mappings", "Policy sync", "Copy monitoring", "Webhooks", "Activity"]);
  await expect(panel.getByLabel("Sonarr URL", { exact: true })).toHaveValue("http://sonarr:8989");
  await sonarrTab(page, "Folder mappings").click();
  // A folder owned by the other instance cannot be chosen here.
  await expect(panel.getByRole("option", { name: "Recordings 4K (mapped by Sonarr 4K)" })).toHaveAttribute("disabled", "");
  await expect(panel.getByRole("option", { name: "Family Films" })).toHaveCount(0);
  await sonarrTab(page, "Policy sync").click();
  await expect(panel.getByLabel("Sonarr policy preview")).toContainText("Garden Diaries (2021)");
  await expect(panel.getByLabel("Sonarr policy preview")).toContainText("Needs review");
  await expect(panel.getByRole("columnheader", { name: "Sonarr tags" })).toBeVisible();
  await sonarrTab(page, "Copy monitoring").click();
  await expect(panel.getByLabel("Update Sonarr monitoring after copies by default")).toBeChecked();
  await expect(panel).toContainText("The series stays monitored.");
  await sonarrTab(page, "Activity").click();
  await expect(panel.getByLabel("Recent Sonarr events")).toContainText("Download");
  await expect(panel.getByLabel("Recent Sonarr monitoring updates")).toContainText("Family Holidays (2020) S01E01");
  // Radarr's panel is untouched and hidden behind its own tab.
  await page.getByRole("tab", { name: "Radarr", exact: true }).click();
  await expect(page.getByRole("tabpanel", { name: "Radarr", exact: true })).toContainText("No Radarr instances yet.");
  await expect(panel).toBeHidden();
});

test("Sonarr webhook setup lists the Sonarr triggers with copyable URL, header key, and generated secret", async ({ page }) => {
  const { saves } = await fixture(page);
  const panel = await openSonarr(page);
  await sonarrTab(page, "Webhooks").click();
  const webhooks = panel.getByRole("tabpanel", { name: "Webhooks" });
  // No secret is saved yet, so the numbered steps start open.
  const steps = webhooks.locator("details");
  await expect(steps).toHaveAttribute("open");
  await expect(steps.locator(".radarr-webhook-steps > li")).toHaveCount(7);
  await expect(steps.locator(".radarr-trigger-list li")).toHaveText(["On File Import", "On File Upgrade", "On Rename", "On Series Add", "On Series Delete", "On Episode File Delete"]);
  await expect(steps).toContainText("No secret saved yet.");
  await expect(steps.getByLabel("Webhook URL", { exact: true })).toHaveValue(/\/api\/integrations\/sonarr\/5e7a2b9c0d1f\/webhook$/);
  await expect(steps.getByLabel("Key", { exact: true })).toHaveValue("X-SRTL-Webhook-Secret");
  await expect(webhooks.getByRole("button", { name: "Copy" })).toHaveCount(2);
  await webhooks.getByRole("button", { name: "Generate secret" }).click();
  const generated = await webhooks.getByLabel("Generated secret").inputValue();
  expect(generated).toMatch(/^[A-Za-z0-9_-]{43}$/);
  await expect(steps.getByLabel("Value", { exact: true })).toHaveValue(generated);
  await page.getByRole("button", { name: "Save Sonarr settings", exact: true }).click();
  await expect(steps).toContainText("A secret is saved.");
  expect(saves.at(-1)?.webhookSecret).toBe(generated);
  await expect(steps.getByLabel("Value", { exact: true })).toHaveValue(generated);
});

test("Sonarr settings fit narrow screens without sideways scrolling", async ({ page }, testInfo) => {
  await fixture(page);
  await openSonarr(page);
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const name of ["Connection", "Policy sync", "Webhooks", "Activity"]) {
      await sonarrTab(page, name).click();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
    await page.screenshot({ path: testInfo.outputPath(`sonarr-settings-${width}.png`), fullPage: true });
  }
});
