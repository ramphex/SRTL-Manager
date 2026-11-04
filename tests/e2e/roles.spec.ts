import { expect, test, type APIRequestContext, type Cookie, type Page } from "@playwright/test";

const baseUrl = process.env.SRTL_E2E_BASE_URL;
const sessionToken = process.env.SRTL_E2E_SESSION_TOKEN;
const sessionCookieName = process.env.SRTL_E2E_SESSION_COOKIE_NAME ?? (baseUrl && new URL(baseUrl).port ? `srtl_session_${new URL(baseUrl).port}` : "srtl_session");

if (process.env.CI && baseUrl && !sessionToken) {
  throw new Error("CI browser checks require SRTL_E2E_SESSION_TOKEN so authenticated coverage cannot be skipped.");
}

test.skip(!baseUrl || !sessionToken, "Set SRTL_E2E_BASE_URL and SRTL_E2E_SESSION_TOKEN to run the role checks against a real server.");
test.describe.configure({ mode: "serial" });

const suffix = Date.now().toString(36);
const temporaryPassword = `temporary-${suffix}-password`;
const finalPassword = `chosen-${suffix}-password`;
const adminName = `e2e-admin-${suffix}`;
const moderatorName = `e2e-moderator-${suffix}`;
const phone = { width: 390, height: 844 };

function ownerHeaders(): Record<string, string> {
  return { cookie: `${sessionCookieName}=${sessionToken}`, origin: baseUrl! };
}

async function createAccount(request: APIRequestContext, username: string, role: "admin" | "moderator") {
  const response = await request.post(`${baseUrl}/api/accounts`, { headers: ownerHeaders(), data: { username, role, temporaryPassword } });
  expect(response.status(), await response.text()).toBe(201);
  return (await response.json()) as { id: number };
}

async function signInAsOwner(page: Page) {
  const url = new URL(baseUrl!);
  await page.context().addCookies([{ name: sessionCookieName, value: sessionToken!, domain: url.hostname, path: "/", httpOnly: true, sameSite: "Lax" }]);
}

async function signInThroughForm(page: Page, username: string, password: string) {
  await page.goto(baseUrl!);
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
}

/** The forced first step: a temporary password opens nothing else. */
async function replaceTemporaryPassword(page: Page) {
  await expect(page.getByRole("heading", { name: "Choose your password" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Library" })).toHaveCount(0);
  await page.getByLabel("Temporary password").fill(temporaryPassword);
  await page.getByLabel("New password", { exact: true }).fill(finalPassword);
  await page.getByLabel("Confirm new password").fill(finalPassword);
  await page.getByRole("button", { name: "Save password" }).click();
  await expect(page.getByRole("heading", { name: "Choose your password" })).toHaveCount(0);
}

async function expectNoSidewaysScroll(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
}

async function expandSettings(page: Page) {
  const settings = page.getByRole("button", { name: "Settings" }).first();
  if ((await settings.getAttribute("aria-expanded")) !== "true") await settings.click();
}

test.describe("roles in the browser", () => {
  let moderatorId = 0;
  // Sign-in is limited per address, so later tests reuse this browser session.
  let moderatorCookies: Cookie[] = [];

  test.beforeAll(async ({ request }) => {
    await createAccount(request, adminName, "admin");
    moderatorId = (await createAccount(request, moderatorName, "moderator")).id;
  });

  test("the owner sees accounts, every role and the ownership transfer", async ({ page }) => {
    await signInAsOwner(page);
    await page.goto(`${baseUrl}/settings/accounts`);
    await expect(page.getByRole("heading", { name: "Accounts", exact: true }).first()).toBeVisible();
    await expect(page.locator("aside .sidebar-user-role").first()).toHaveText("Owner");
    const row = page.locator(`[data-account="${moderatorName}"]`);
    await expect(row).toContainText("Moderator");
    await expect(row).toContainText("Temporary password");
    await expect(row).toContainText(/Created by \S+/);
    await expect(page.locator(`[data-account="${adminName}"]`).getByRole("button", { name: "Reset password" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Transfer ownership" })).toBeVisible();
    await expect(page.locator(".account-form").filter({ hasText: "Create account" }).locator("select option")).toHaveText(["Admin", "Moderator"]);
    await expect(page.getByRole("heading", { name: "Recent account changes" })).toBeVisible();
    await expect(page.getByText(moderatorName).first()).toBeVisible();
    await page.goto(`${baseUrl}/settings/user`);
    await expect(page.getByRole("region", { name: "Signed-in sessions" }).getByRole("columnheader", { name: "Address" })).toBeVisible();
  });

  test("the owner's accounts page works at phone width", async ({ page }) => {
    await page.setViewportSize(phone);
    await signInAsOwner(page);
    await page.goto(`${baseUrl}/settings/accounts`);
    await expect(page.locator(`[data-account="${moderatorName}"]`)).toBeVisible();
    await expectNoSidewaysScroll(page);
    await page.locator(`[data-account="${moderatorName}"]`).getByRole("button", { name: "Reset password" }).click();
    await page.locator(`[data-account="${moderatorName}"]`).getByRole("button", { name: "Generate" }).click();
    await expectNoSidewaysScroll(page);
  });

  test("an admin replaces the temporary password, then manages only moderators", async ({ page }) => {
    await signInThroughForm(page, adminName, temporaryPassword);
    await replaceTemporaryPassword(page);
    await expect(page.locator("aside .sidebar-user-role").first()).toHaveText("Admin");
    await page.goto(`${baseUrl}/settings/accounts`);
    await expect(page.locator(`[data-account="${moderatorName}"]`).getByRole("button", { name: "Reset password" })).toBeVisible();
    await expect(page.locator(".account-form").filter({ hasText: "Create account" }).locator("select option")).toHaveText(["Moderator"]);
    await expect(page.getByRole("heading", { name: "Transfer ownership" })).toHaveCount(0);
    const self = page.locator(`[data-account="${adminName}"]`);
    await expect(self).toContainText("You");
    await expect(self.getByRole("button")).toHaveCount(0);
    await page.goto(`${baseUrl}/settings/backups`);
    await expect(page.getByText("Not allowed")).toHaveCount(0);
    await expandSettings(page);
    await expect(page.getByRole("link", { name: "Accounts" }).first()).toBeVisible();
  });

  test("a moderator sees no control they cannot use, and a forbidden link says so", async ({ page }) => {
    const refused: string[] = [];
    page.on("response", (response) => {
      if (response.status() === 403) refused.push(new URL(response.url()).pathname);
    });
    await signInThroughForm(page, moderatorName, temporaryPassword);
    await replaceTemporaryPassword(page);
    await expect(page.locator("aside .sidebar-user-role").first()).toHaveText("Moderator");
    await expandSettings(page);
    for (const name of ["Backups", "Advanced", "Media servers", "Integrations", "Accounts"]) {
      await expect(page.getByRole("link", { name, exact: true })).toHaveCount(0);
    }
    await expect(page.getByRole("link", { name: "User settings" }).first()).toBeVisible();
    moderatorCookies = await page.context().cookies();

    await page.goto(`${baseUrl}/library`);
    await expect(page.getByRole("button", { name: "Symlinks" }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: /orphans/i })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Storage Policies" })).toHaveCount(0);

    await page.goto(`${baseUrl}/now-playing`);
    await expect(page.getByRole("heading", { name: "Now Playing" }).first()).toBeVisible();
    await expect(page.getByText("Look up the location of public client addresses")).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Open Media servers" })).toHaveCount(0);

    await page.goto(`${baseUrl}/settings/user`);
    await expect(page.getByRole("heading", { name: "Sessions" })).toBeVisible();
    await expect(page.getByLabel("Current password")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Security activity" })).toHaveCount(0);
    await expect(page.getByRole("columnheader", { name: "Device" })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "Address" })).toHaveCount(0);

    // The client asked for nothing it would be refused, so nothing the screens did was hidden by an error.
    expect(refused).toEqual([]);

    for (const url of ["/settings", "/settings/sections", "/settings/advanced", "/settings/backups", "/settings/media-servers", "/settings/integrations", "/settings/accounts", "/library?view=local-orphans", "/library?view=remote-orphans", "/library?view=policies"]) {
      await page.goto(`${baseUrl}${url}`);
      await expect(page.getByRole("heading", { name: "Not allowed" }), url).toBeVisible();
      await expect(page.getByRole("link", { name: "Back to the dashboard" }), url).toBeVisible();
    }
  });

  test("the server refuses a moderator whatever the screens show", async ({ page, request }) => {
    await page.context().addCookies(moderatorCookies);
    await page.goto(baseUrl!);
    await expect(page.locator("aside .sidebar-user-role").first()).toHaveText("Moderator");
    const cookie = moderatorCookies.map((entry) => `${entry.name}=${entry.value}`).join("; ");
    const headers = { cookie, origin: baseUrl! };
    for (const path of ["/api/settings/paths", "/api/backups", "/api/media-servers", "/api/settings/radarr", "/api/accounts", "/api/auth/security-events"]) {
      expect((await request.get(`${baseUrl}${path}`, { headers })).status(), path).toBe(403);
    }
    expect((await request.post(`${baseUrl}/api/orphans/purge`, { headers, data: { rootType: "local", storageFileIds: [1], mode: "delete" } })).status()).toBe(403);
    expect((await request.post(`${baseUrl}/api/accounts/transfer-ownership`, { headers, data: { targetId: 1, currentPassword: finalPassword } })).status()).toBe(403);
    const locations = (await (await request.get(`${baseUrl}/api/settings/storage-locations`, { headers })).json()) as { locations: Array<{ path: string }> };
    expect(locations.locations.map((location) => location.path)).toEqual(["", ""]);
  });

  test("a moderator's pages work at phone width", async ({ page }) => {
    await page.setViewportSize(phone);
    await page.context().addCookies(moderatorCookies);
    for (const url of ["/settings/user", "/settings/accounts", "/library"]) {
      await page.goto(`${baseUrl}${url}`);
      await page.waitForLoadState("networkidle");
      await expectNoSidewaysScroll(page);
    }
    await page.goto(`${baseUrl}/settings/accounts`);
    await expect(page.getByRole("heading", { name: "Not allowed" })).toBeVisible();
  });

  test("disabling an account signs it out of its open browser", async ({ page, request }) => {
    await page.context().addCookies(moderatorCookies);
    await page.goto(baseUrl!);
    await expect(page.locator("aside .sidebar-user-role").first()).toHaveText("Moderator");
    const disabled = await request.post(`${baseUrl}/api/accounts/${moderatorId}/disable`, { headers: ownerHeaders() });
    expect(disabled.status()).toBe(200);
    await page.goto(baseUrl!);
    await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
    await page.getByLabel("Username").fill(moderatorName);
    await page.getByLabel("Password").fill(finalPassword);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByText("Invalid username or password")).toBeVisible();
  });
});
