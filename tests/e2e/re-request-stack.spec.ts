import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { expect, test, type Browser, type BrowserContextOptions, type Page } from "@playwright/test";

// The whole path with nothing mocked but Radarr and Sonarr: real server, worker, database and files, driven through the built client.
// Needs `npm run build` and Docker for the test database.
test.skip(!process.env.SRTL_E2E_STACK, "Set SRTL_E2E_STACK=1 after a build to run the full re-request path.");
test.describe.configure({ mode: "serial" });
test.setTimeout(90_000);

const repoRoot = path.resolve(import.meta.dirname, "../..");
const ownerPassword = "owner-password-for-tests";
const moderatorPassword = "moderator-password-for-tests";

interface MockState {
  radarr: { calls: string[]; searches: number[][]; movies: Array<{ id: number; monitored: boolean; movieFile: unknown; tags: number[] }> };
  radarr4k: { searches: number[][] };
  sonarr: { searches: number[][]; deletedFiles: number[]; seriesEdits: unknown[]; episodes: Array<{ id: number; monitored: boolean }> };
}

let stack: ChildProcess;
let baseUrl: string;
let controlUrl: string;

async function addFile(section: string, itemName: string, relativePath: string, linked = true): Promise<{ filePath: string; linkPath: string }> {
  return (await fetch(`${controlUrl}/file`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ section, itemName, relativePath, linked }) })).json() as Promise<{ filePath: string; linkPath: string }>;
}

async function exists(target: string): Promise<boolean> {
  return ((await (await fetch(`${controlUrl}/exists?path=${encodeURIComponent(target)}`)).json()) as { exists: boolean }).exists;
}

async function mocks(): Promise<MockState> {
  return (await fetch(`${controlUrl}/state`)).json() as Promise<MockState>;
}

async function setRadarr(body: { failSearch?: boolean; clearCalls?: boolean }): Promise<void> {
  await fetch(`${controlUrl}/radarr`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

async function signIn(page: Page, username: string, password: string) {
  await page.goto(baseUrl);
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
}

// Sign-in is limited per address, so every owner test reuses one signed-in session.
let ownerSession: BrowserContextOptions["storageState"];

async function ownerPage(browser: Browser): Promise<Page> {
  const page = await (await browser.newContext(ownerSession ? { storageState: ownerSession } : {})).newPage();
  if (!ownerSession) {
    await signIn(page, "the-owner", ownerPassword);
    await expect(page.getByRole("link", { name: "Library" }).first()).toBeVisible();
    ownerSession = await page.context().storageState();
  }
  await page.goto(`${baseUrl}/library?view=damaged`);
  await expect(page.getByRole("heading", { name: "Damaged files" })).toBeVisible();
  return page;
}

test.beforeAll(async () => {
  test.setTimeout(120_000);
  stack = spawn(path.join(repoRoot, "node_modules/.bin/tsx"), ["tests/e2e/reRequestStackServer.ts"], { cwd: repoRoot, stdio: ["ignore", "pipe", "inherit"] });
  await new Promise<void>((resolve, reject) => {
    let output = "";
    stack.once("exit", (code) => reject(new Error(`The test server stopped with code ${code}`)));
    stack.stdout!.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      const ready = /STACK_READY (\{.*\})/.exec(output);
      if (!ready) return;
      ({ baseUrl, controlUrl } = JSON.parse(ready[1]!) as { baseUrl: string; controlUrl: string });
      resolve();
    });
  });
});

test.afterAll(async () => {
  if (!stack) return;
  stack.removeAllListeners("exit");
  const stopped = new Promise((resolve) => stack.once("exit", resolve));
  stack.kill("SIGTERM");
  await stopped;
});

test("a delete with the option off touches nothing in Radarr", async ({ browser }) => {
  const quiet = await addFile("movies", "Quiet (2020)", "Quiet.mkv");
  await setRadarr({ clearCalls: true });
  const page = await ownerPage(browser);
  await page.getByRole("checkbox", { name: /Quiet/ }).check();
  await page.getByRole("button", { name: /Delete selected/ }).click();
  const confirm = page.getByRole("group", { name: "Confirm damaged file delete" });
  await expect(confirm.getByRole("checkbox", { name: /search for a new copy/ })).not.toBeChecked();
  await confirm.getByRole("button", { name: "Move to holding area" }).click();
  await expect.poll(() => exists(quiet.filePath), { timeout: 15_000 }).toBe(false);
  await expect.poll(() => exists(quiet.linkPath)).toBe(false);
  await page.waitForTimeout(1500);
  const state = await mocks();
  expect(state.radarr.calls).toEqual([]);
  expect(state.radarr.movies.find((movie) => movie.id === 3)?.movieFile).toBeTruthy();
  await page.context().close();
});

test("an owner deletes damaged files and asks for new copies, and sees each result", async ({ browser }) => {
  await addFile("movies", "Alpha (2020)", "Alpha.mkv");
  await addFile("movies", "Nobody (2020)", "Nobody.mkv", false);
  await addFile("shows", "Delta (2020)", "Season 01/Delta - S01E01.mkv");
  const page = await ownerPage(browser);
  for (const name of [/Alpha/, /Nobody/, /Delta/]) await page.getByRole("checkbox", { name }).check();
  await page.getByRole("button", { name: /Delete selected/ }).click();
  const confirm = page.getByRole("group", { name: "Confirm damaged file delete" });
  await confirm.getByRole("checkbox", { name: /search for a new copy/ }).check();
  const preview = page.getByTestId("re-request-preview");
  await expect(preview).toContainText("2 of 3 files can be re-requested: 1 in Radarr, 1 in Sonarr.");
  await expect(preview).toContainText("This title is not in Radarr.");
  await expect(preview).toContainText("Nobody.mkv");
  await confirm.getByRole("button", { name: /Delete now/ }).click();
  await confirm.getByRole("button", { name: "Delete permanently" }).click();

  const table = page.getByLabel("Recent re-requests");
  await expect(table.getByRole("row", { name: /Alpha \(2020\)/ })).toContainText("Search sent", { timeout: 30_000 });
  await expect(table.getByRole("row", { name: /Alpha \(2020\)/ })).toContainText("Was unmonitored; monitored now.");
  await expect(table.getByRole("row", { name: /Delta \(2020\) S01E01/ })).toContainText("Search sent", { timeout: 30_000 });
  await expect(table.getByRole("row", { name: /Nobody.mkv/ })).toContainText("No match");
  await expect(table.getByRole("row", { name: /Nobody.mkv/ })).toContainText("This title is not in Radarr.");

  const state = await mocks();
  expect(state.radarr.searches).toEqual([[1]]);
  expect(state.radarr.movies.find((movie) => movie.id === 1)).toMatchObject({ monitored: true, movieFile: null, tags: [1] });
  expect(state.sonarr.deletedFiles).toEqual([40]);
  expect(state.sonarr.searches).toEqual([[101]]);
  expect(state.sonarr.episodes.find((episode) => episode.id === 101)?.monitored).toBe(true);
  // The neighbouring episode keeps its own monitoring, and the series is never edited.
  expect(state.sonarr.episodes.find((episode) => episode.id === 102)?.monitored).toBe(false);
  expect(state.sonarr.seriesEdits).toEqual([]);
  await page.context().close();
});

test("a failed search keeps the delete, shows the failure, and retries from the page", async ({ browser }) => {
  const bravo = await addFile("movies", "Bravo (2020)", "Bravo.mkv");
  await setRadarr({ failSearch: true });
  const page = await ownerPage(browser);
  await page.getByRole("checkbox", { name: /Bravo/ }).check();
  await page.getByRole("button", { name: /Delete selected/ }).click();
  const confirm = page.getByRole("group", { name: "Confirm damaged file delete" });
  await confirm.getByRole("checkbox", { name: /search for a new copy/ }).check();
  await expect(page.getByTestId("re-request-preview")).toContainText("1 of 1 file can be re-requested");
  await confirm.getByRole("button", { name: "Move to holding area" }).click();
  const row = page.getByLabel("Recent re-requests").getByRole("row", { name: /Bravo \(2020\)/ });
  await expect(row).toContainText("Radarr returned HTTP 500.", { timeout: 30_000 });
  expect(await exists(bravo.filePath)).toBe(false);
  await setRadarr({ failSearch: false });
  await row.getByRole("button", { name: "Retry" }).click();
  await expect(row).toContainText("Search sent", { timeout: 30_000 });
  expect((await mocks()).radarr.searches).toContainEqual([2]);
  await page.context().close();
});

test("a bulk delete is paced, per instance", async ({ browser }) => {
  for (let index = 0; index < 8; index += 1) await addFile("movies4k", `Bulk${index} (2020)`, `Bulk${index}.mkv`);
  const page = await ownerPage(browser);
  await page.getByRole("button", { name: /^Select all/ }).click();
  await page.getByRole("button", { name: /Delete selected \(8\)/ }).click();
  const confirm = page.getByRole("group", { name: "Confirm damaged file delete" });
  await confirm.getByRole("checkbox", { name: /search for a new copy/ }).check();
  await expect(page.getByTestId("re-request-preview")).toContainText("8 of 8 files can be re-requested: 8 in Radarr 4K.");
  await confirm.getByRole("button", { name: /Delete now/ }).click();
  await confirm.getByRole("button", { name: "Delete permanently" }).click();
  // The default allowance is six a minute, one per pass, so the other two wait.
  await expect.poll(async () => (await mocks()).radarr4k.searches.length, { timeout: 30_000 }).toBe(6);
  await page.waitForTimeout(3000);
  const { searches } = (await mocks()).radarr4k;
  expect(searches.length).toBe(6);
  expect(searches.every((search) => search.length === 1)).toBe(true);
  await expect(page.getByLabel("Recent re-requests").getByText("Waiting its turn")).toHaveCount(2, { timeout: 10_000 });
  await page.context().close();
});

test("a moderator sees damaged files read-only and is refused by the server", async ({ browser }) => {
  const remaining = await addFile("movies", "Later (2020)", "Later.mkv");
  const page = await (await browser.newContext()).newPage();
  await signIn(page, "a-moderator", moderatorPassword);
  await expect(page.getByRole("link", { name: "Library" }).first()).toBeVisible();
  await page.goto(`${baseUrl}/library?view=damaged`);
  await expect(page.getByRole("heading", { name: "Damaged files" })).toBeVisible();
  await expect(page.getByText("Later (2020)", { exact: true })).toBeVisible();
  await expect(page.getByRole("checkbox")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Delete selected/ })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Re-requests" })).toHaveCount(0);
  const origin = { origin: baseUrl };
  expect((await page.request.post(`${baseUrl}/api/damaged-files/delete`, { headers: origin, data: { storageFileIds: [1], mode: "delete", reRequest: true } })).status()).toBe(403);
  expect((await page.request.get(`${baseUrl}/api/re-requests`)).status()).toBe(403);
  expect((await page.request.post(`${baseUrl}/api/re-requests/retry`, { headers: origin, data: { ids: "all_failed" } })).status()).toBe(403);
  expect(await exists(remaining.filePath)).toBe(true);
  await page.context().close();
});
