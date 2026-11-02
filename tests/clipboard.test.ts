// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { copyText } from "../src/client/clipboard";

function setSecureContext(secure: boolean) {
  Object.defineProperty(window, "isSecureContext", { configurable: true, value: secure });
}

describe("copyText", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    Reflect.deleteProperty(navigator, "clipboard");
    Reflect.deleteProperty(document, "execCommand");
  });

  it("uses the clipboard API on secure pages", async () => {
    setSecureContext(true);
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });

    await expect(copyText("https://example.test/hook")).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith("https://example.test/hook");
  });

  it("falls back to the copy command on plain HTTP and cleans up after itself", async () => {
    setSecureContext(false);
    let copiedValue = "";
    const execCommand = vi.fn(() => {
      copiedValue = (document.activeElement as HTMLTextAreaElement).value;
      return true;
    });
    Object.defineProperty(document, "execCommand", { configurable: true, value: execCommand });

    await expect(copyText("secret-value")).resolves.toBe(true);
    expect(execCommand).toHaveBeenCalledWith("copy");
    expect(copiedValue).toBe("secret-value");
    expect(document.querySelector("textarea")).toBeNull();
  });

  it("falls back when the clipboard API refuses, and reports a blocked copy", async () => {
    setSecureContext(true);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: vi.fn().mockRejectedValue(new Error("denied")) } });
    Object.defineProperty(document, "execCommand", { configurable: true, value: vi.fn(() => false) });

    await expect(copyText("value")).resolves.toBe(false);
  });
});
