import { afterEach, describe, expect, it } from "vitest";
import { appendBoundedOutput, commandTimeoutMs, processOutputLimitBytes } from "../src/server/lib/processSafety";

describe("process safety", () => {
  afterEach(() => {
    delete process.env.SRTL_COMMAND_TIMEOUT_MS;
    delete process.env.SRTL_COMMAND_OUTPUT_LIMIT_BYTES;
  });

  it("bounds retained command output to prevent unbounded memory growth", () => {
    const output = appendBoundedOutput("first output\n", Buffer.alloc(128, "x"), 32);

    expect(output).toContain("earlier command output truncated");
    expect(output.endsWith("x".repeat(32))).toBe(true);
  });

  it("rejects unsafe timeout and output-limit settings", () => {
    process.env.SRTL_COMMAND_TIMEOUT_MS = "10";
    process.env.SRTL_COMMAND_OUTPUT_LIMIT_BYTES = "1";

    expect(commandTimeoutMs()).toBe(6 * 60 * 60_000);
    expect(processOutputLimitBytes()).toBe(256 * 1024);
  });
});
