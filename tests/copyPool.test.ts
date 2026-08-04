import { describe, expect, it, vi } from "vitest";
import { runKeyedPool } from "../src/server/jobs/copyPool";

describe("keyed copy pool", () => {
  it("runs independent lanes concurrently without overlapping one lane", async () => {
    const activeKeys = new Set<string>();
    let active = 0;
    let maximumActive = 0;
    const release: Array<() => void> = [];
    const started: string[] = [];

    const run = runKeyedPool(
      ["title-a/1", "title-a/2", "title-b/1", "title-c/1"],
      3,
      (item) => item.split("/")[0]!,
      async (item) => {
        const key = item.split("/")[0]!;
        expect(activeKeys.has(key)).toBe(false);
        activeKeys.add(key);
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        started.push(item);
        await new Promise<void>((resolve) => release.push(resolve));
        active -= 1;
        activeKeys.delete(key);
      }
    );

    await vi.waitFor(() => expect(started).toEqual(["title-a/1", "title-b/1", "title-c/1"]));
    expect(maximumActive).toBe(3);
    release.shift()?.();
    await vi.waitFor(() => expect(started).toContain("title-a/2"));
    while (release.length > 0) release.shift()?.();
    await run;
  });

  it("waits for active lanes to settle after one fails", async () => {
    let releaseSecond!: () => void;
    let markSecondStarted!: () => void;
    const secondStarted = new Promise<void>((resolve) => {
      markSecondStarted = resolve;
    });
    let secondSettled = false;
    const run = runKeyedPool(
      ["first", "second"],
      2,
      (item) => item,
      async (item) => {
        if (item === "first") throw new Error("lease lost");
        await new Promise<void>((resolve) => {
          releaseSecond = resolve;
          markSecondStarted();
        });
        secondSettled = true;
      }
    );

    await secondStarted;
    let rejected = false;
    void run.catch(() => {
      rejected = true;
    });
    await Promise.resolve();
    expect(rejected).toBe(false);
    releaseSecond();
    await expect(run).rejects.toThrow("lease lost");
    expect(secondSettled).toBe(true);
  });
});
