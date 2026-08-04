import { describe, expect, it } from "vitest";
import { CopyTransferLimiter } from "../src/server/jobs/copyLimiter";

describe("copy transfer limiter", () => {
  it("admits up to the configured limit and releases waiters in order", async () => {
    const limiter = new CopyTransferLimiter(2);
    const signal = new AbortController().signal;
    const first = await limiter.acquire(signal);
    const second = await limiter.acquire(signal);
    let thirdStarted = false;
    const thirdPromise = limiter.acquire(signal).then((release) => {
      thirdStarted = true;
      return release;
    });

    await Promise.resolve();
    expect(limiter.activeCount).toBe(2);
    expect(limiter.waitingCount).toBe(1);
    expect(thirdStarted).toBe(false);

    first();
    const third = await thirdPromise;
    expect(thirdStarted).toBe(true);
    expect(limiter.activeCount).toBe(2);

    second();
    third();
    expect(limiter.activeCount).toBe(0);
  });

  it("removes an aborted waiter without consuming a transfer slot", async () => {
    const limiter = new CopyTransferLimiter(1);
    const active = await limiter.acquire(new AbortController().signal);
    const waitingController = new AbortController();
    const waiting = limiter.acquire(waitingController.signal);

    waitingController.abort(new Error("job lease lost"));
    await expect(waiting).rejects.toThrow("job lease lost");
    expect(limiter.waitingCount).toBe(0);

    active();
    expect(limiter.activeCount).toBe(0);
  });

  it("does not impose an arbitrary upper limit", () => {
    expect(new CopyTransferLimiter(128).maximum).toBe(128);
  });
});
