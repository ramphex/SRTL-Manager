import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { expect, test } from "@playwright/test";

// The dashboard work search against the real server and database: nothing is mocked.
// Needs `npm run build` and Docker for the test database.
test.skip(!process.env.SRTL_E2E_STACK, "Set SRTL_E2E_STACK=1 after a build to run the full search path.");
test.setTimeout(90_000);

const repoRoot = path.resolve(import.meta.dirname, "../..");
let stack: ChildProcess;
let baseUrl: string;

test.beforeAll(async () => {
  test.setTimeout(120_000);
  stack = spawn(path.join(repoRoot, "node_modules/.bin/tsx"), ["tests/e2e/searchStackServer.ts"], { cwd: repoRoot, stdio: ["ignore", "pipe", "inherit"] });
  await new Promise<void>((resolve, reject) => {
    let output = "";
    stack.once("exit", (code) => reject(new Error(`The test server stopped with code ${code}`)));
    stack.stdout!.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      const ready = /STACK_READY (\{.*\})/.exec(output);
      if (!ready) return;
      ({ baseUrl } = JSON.parse(ready[1]!) as { baseUrl: string });
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

test("the dashboard work search forgives punctuation, word order, apostrophes and small typos", async ({ page }) => {
  await page.goto(baseUrl);
  await page.getByLabel("Username").fill("the-owner");
  await page.getByLabel("Password").fill("owner-password-for-tests");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("button", { name: /^movies: 4 .* need a storage policy$/i }).click();

  const search = page.getByPlaceholder("Search work");
  const rows = page.locator(".actionable-panel-body tbody tr");
  await expect(rows).toHaveCount(4);
  const expectTitles = async (query: string, titles: string[]) => {
    await search.fill(query);
    await expect(rows).toHaveCount(titles.length);
    for (const title of titles) await expect(page.getByRole("checkbox", { name: `Select ${title}` })).toBeVisible();
  };

  await expectTitles("Charlies Lab", ["Charlie's Lab (2020)"]);
  await expectTitles("lab charlie s", ["Charlie's Lab (2020)"]);
  await expectTitles("Delta Echo", ["Delta! Echo (2021)"]);
  await expectTitles("bravo alpha", ["Alpha Bravo (2019)"]);
  await expectTitles("Fxotrot", ["Foxtrot Golf (2018)"]);
  await expectTitles("2019", ["Alpha Bravo (2019)"]);
  await expectTitles("Foxtrot 2019", []);
  await search.fill("");
  await expect(rows).toHaveCount(4);
});
