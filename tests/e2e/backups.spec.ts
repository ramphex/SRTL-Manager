import { expect, test, type Page } from "@playwright/test";
import type { BackupSettings, BackupState } from "../../src/shared/backups";

const baseUrl = process.env.SRTL_E2E_BASE_URL;
test.skip(!baseUrl, "Set SRTL_E2E_BASE_URL to run browser checks.");

function hoursAgo(hours: number): string {
  return new Date(Date.now() - hours * 60 * 60_000).toISOString();
}

function backupEntry(name: string, createdAt: string, verified = true) {
  return { name, createdAt, sizeBytes: 120 * 1024 * 1024, verified, problem: verified ? null : "The dump file changed size", appVersion: "0.1.4-beta.4", migration: 27, databaseSizeBytes: 500 * 1024 * 1024 };
}

function healthyState(): BackupState {
  return {
    settings: { enabled: true, time: "03:30", keep: 7, location: null },
    location: "/backups",
    defaultLocation: "/backups",
    locationRefusal: null,
    status: {
      location: "/backups",
      directory: "/backups/srtl-manager-backups",
      checkedAt: new Date().toISOString(),
      ready: true,
      problem: null,
      permissionsWarning: null,
      freeBytes: 40 * 1024 ** 3,
      backups: [
        backupEntry("srtl-manager-backup-20261104T033000Z-j12", hoursAgo(5)),
        backupEntry("srtl-manager-backup-20261102T033000Z-j9", hoursAgo(52), false)
      ]
    },
    lastRun: { jobId: 12, status: "completed", trigger: "scheduled", startedAt: hoursAgo(5), finishedAt: hoursAgo(5), message: "Backup srtl-manager-backup-20261104T033000Z-j12 verified" },
    activeJobId: null,
    nextRunAt: new Date(Date.now() + 19 * 60 * 60_000).toISOString(),
    timeZone: "UTC",
    alert: null
  };
}

async function fixture(page: Page, initial: BackupState = healthyState()) {
  const state = { current: initial };
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    const body = request.postData() ? (request.postDataJSON() as unknown) : null;
    let response: unknown = [];
    let status = 200;
    if (url.pathname.startsWith("/api/backups")) calls.push({ method, path: url.pathname, body });
    if (url.pathname === "/api/auth/me") response = { setupRequired: false, authenticated: true, user: { id: 1, username: "integration-test", role: "owner", mustChangePassword: false } };
    else if (url.pathname === "/api/system/path-migration") response = { status: "ready", blocking: false, activePaths: {}, detectedPaths: {}, environmentErrors: [], changes: [], migration: null };
    else if (url.pathname === "/api/onboarding") response = { required: false, phase: "completed" };
    else if (url.pathname === "/api/settings/storage-locations") response = { locations: [{ key: "location_1", rootType: "local", displayName: "Home NAS", path: "/local" }, { key: "location_2", rootType: "remote", displayName: "Archive", path: "/remote" }] };
    else if (url.pathname === "/api/settings/user-preferences") response = { timeFormat: "24h", autoOpenTaskStatus: false, recentJobsCompletedWindowMinutes: 1440 };
    else if (url.pathname === "/api/settings/sections") response = { sections: ["movies"], sectionTitles: {}, sectionTypes: { movies: "movies" } };
    else if (url.pathname === "/api/settings/paths") response = { symlinkDir: "/links", localDir: "/local", remoteDir: "/remote" };
    else if (url.pathname === "/api/settings/scan") response = { scanSymlinks: true, scanLocal: true, scanRemote: true };
    else if (url.pathname === "/api/settings/audit") response = { sections: [], targets: ["local", "remote"] };
    else if (url.pathname === "/api/settings/advanced") response = {};
    else if (url.pathname === "/api/inventory/scan-timestamps") response = { symlinkSections: {}, localSections: {}, remoteRoot: null };
    else if (url.pathname === "/api/system/version") {
      const release = { latestVersion: "0.1.4-beta.3", updateAvailable: false, status: "up_to_date", releaseUrl: null };
      response = { currentVersion: "0.1.4-beta.3", currentChannel: "beta", currentChannelLabel: "Beta", stable: { ...release, channel: "stable" }, beta: { ...release, channel: "beta" }, ...release };
    } else if (url.pathname === "/api/backups") response = state.current;
    else if (url.pathname === "/api/backups/settings") {
      const settings = body as BackupSettings;
      if (settings.location === "/etc/backups") {
        status = 400;
        response = { error: "That backup location is a system folder or a temporary one. Choose a dedicated folder for backups.", code: "bad_request" };
      } else {
        state.current = { ...state.current, settings };
        response = state.current;
      }
    } else if (url.pathname === "/api/backups/run") {
      state.current = { ...state.current, activeJobId: 13 };
      response = { jobId: 13 };
    }
    await route.fulfill({ status, json: response });
  });
  return { state, calls };
}

async function openBackups(page: Page) {
  await page.goto(`${baseUrl}/settings/backups`);
  await expect(page.getByRole("heading", { name: "Settings > Backups" })).toBeVisible();
}

test("shows the last run, next run, location and existing backups", async ({ page }) => {
  await fixture(page);
  await openBackups(page);
  await expect(page.getByText("Verified · ", { exact: false }).first()).toBeVisible();
  await expect(page.getByText("job #12")).toBeVisible();
  await expect(page.getByText("03:30 server time (UTC)")).toBeVisible();
  await expect(page.getByText("/backups/srtl-manager-backups")).toBeVisible();
  await expect(page.getByText("40.0 GB free")).toBeVisible();

  const table = page.getByRole("table", { name: "Existing backups" });
  const [good, damaged] = [table.getByRole("row").nth(1), table.getByRole("row").nth(2)];
  await expect(good).toContainText("srtl-manager-backup-20261104T033000Z-j12");
  await expect(good).toContainText("5 h ago");
  await expect(good).toContainText("120.0 MB");
  await expect(good).toContainText("Verified");
  await expect(damaged).toContainText("2 days ago");
  await expect(damaged).toContainText("Not verified");
  await expect(damaged).toContainText("The dump file changed size");
});

test("explains the secret key, and offers a guide rather than a restore button", async ({ page }) => {
  await fixture(page);
  await openBackups(page);
  await expect(page.getByText("SRTL_SECRET_KEY", { exact: true })).toBeVisible();
  await expect(page.getByText(/A backup does not include it/)).toBeVisible();
  await expect(page.getByRole("link", { name: "restore guide" })).toHaveAttribute("href", /docs\/backups\.md/);
  await expect(page.getByRole("button", { name: /restore/i })).toHaveCount(0);
});

test("saves the schedule, retention and location", async ({ page }) => {
  const { calls } = await fixture(page);
  await openBackups(page);
  const save = page.getByRole("button", { name: "Save backup settings" });
  await expect(save).toBeDisabled();
  await page.getByLabel("Start time (server time)").fill("02:15");
  await page.getByLabel("Backups to keep").fill("10");
  await page.getByLabel("Backup location").fill("/srv/srtl-backups");
  await save.click();
  await expect(page.getByText("Backup settings saved.")).toBeVisible();
  expect(calls.find((call) => call.method === "PUT")?.body).toEqual({ enabled: true, time: "02:15", keep: 10, location: "/srv/srtl-backups" });
  await expect(save).toBeDisabled();
});

test("turns the schedule off and on", async ({ page }) => {
  const { calls } = await fixture(page);
  await openBackups(page);
  await page.getByLabel(/Back up the database every day/).uncheck();
  await expect(page.getByLabel("Start time (server time)")).toBeDisabled();
  await page.getByRole("button", { name: "Save backup settings" }).click();
  await expect(page.getByText("Backup settings saved.")).toBeVisible();
  expect(calls.find((call) => call.method === "PUT")?.body).toMatchObject({ enabled: false });
});

test("won't save fewer than the minimum kept", async ({ page }) => {
  await fixture(page);
  await openBackups(page);
  await page.getByLabel("Backups to keep").fill("1");
  await expect(page.getByText("Keep between 2 and 365 backups.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Save backup settings" })).toBeDisabled();
});

test("shows why a location was refused and keeps the draft", async ({ page }) => {
  await fixture(page);
  await openBackups(page);
  await page.getByLabel("Backup location").fill("/etc/backups");
  await page.getByRole("button", { name: "Save backup settings" }).click();
  await expect(page.getByRole("alert")).toContainText("system folder");
  await expect(page.getByLabel("Backup location")).toHaveValue("/etc/backups");
});

test("starts a backup and blocks a second one while it runs", async ({ page }) => {
  const { calls } = await fixture(page);
  await openBackups(page);
  await page.getByRole("button", { name: "Back up now" }).click();
  await expect(page.getByText("Backup job #13 queued.", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: "Backup running..." })).toBeDisabled();
  expect(calls.filter((call) => call.method === "POST" && call.path === "/api/backups/run")).toHaveLength(1);
});

test("says plainly when the location cannot be written", async ({ page }) => {
  const state = healthyState();
  const problem = "SRTL Manager does not have permission to write to the backup location /backups.";
  await fixture(page, { ...state, status: { ...state.status!, ready: false, problem, freeBytes: null, backups: [] }, alert: { kind: "unavailable", message: problem } });
  await openBackups(page);
  await expect(page.getByRole("alert")).toContainText(problem);
  await expect(page.getByText("Not usable")).toBeVisible();
  await expect(page.getByText("No backups at this location yet.")).toBeVisible();
});

test("waits for the worker to check a newly saved location", async ({ page }) => {
  await fixture(page, { ...healthyState(), status: null });
  await openBackups(page);
  await expect(page.getByText("Waiting for the worker to check this location")).toBeVisible();
});

for (const [kind, message] of [
  ["failed", "The last database backup failed: pg_dump exited with code 1"],
  ["overdue", "The database backup scheduled for 03:30 did not finish."]
] as const) {
  test(`shows a ${kind} backup on other pages, with a link to the settings`, async ({ page }) => {
    await fixture(page, { ...healthyState(), alert: { kind, message } });
    await page.goto(`${baseUrl}/settings/advanced`);
    const banner = page.getByText("Database backups need attention.").locator("..").locator("..");
    await expect(banner).toContainText(message);
    await banner.getByRole("link", { name: "Open backup settings" }).click();
    await expect(page.getByRole("heading", { name: "Settings > Backups" })).toBeVisible();
    // The settings page shows the alert itself, so the banner steps aside.
    await expect(page.getByText("Database backups need attention.")).toHaveCount(0);
    await expect(page.getByRole("alert")).toContainText(message);
  });
}

test("shows the same alert on the dashboard", async ({ page }) => {
  await fixture(page, { ...healthyState(), alert: { kind: "failed", message: "The last database backup failed: no space" } });
  await page.goto(`${baseUrl}/`);
  await expect(page.getByText("Database backups need attention.")).toBeVisible();
});

test("shows no banner while backups are healthy", async ({ page }) => {
  await fixture(page);
  await page.goto(`${baseUrl}/settings/advanced`);
  await expect(page.getByRole("heading", { name: "Settings > Advanced" })).toBeVisible();
  await expect(page.getByText("Database backups need attention.")).toHaveCount(0);
});

test("fits a phone screen without horizontal scrolling", async ({ page }) => {
  await fixture(page);
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(`${baseUrl}/settings/backups`);
  await expect(page.getByRole("heading", { name: "Backup settings" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Back up now" })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});
