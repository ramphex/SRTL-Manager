import { describe, expect, it } from "vitest";
import { formatCurrentVersionDisplay } from "../src/client/versionDisplay";
import type { AppVersionInfo } from "../src/shared/types";

function versionInfo(currentVersion: string, currentChannel: AppVersionInfo["currentChannel"], currentChannelLabel: string): AppVersionInfo {
  const release = {
    latestVersion: null,
    updateAvailable: false,
    status: "unavailable" as const,
    releaseUrl: null,
    releaseNotes: null,
    message: "No GitHub releases yet"
  };

  return {
    currentVersion,
    currentChannel,
    currentChannelLabel,
    stable: { ...release, channel: "stable" },
    beta: { ...release, channel: "beta" },
    latestVersion: null,
    updateAvailable: false,
    status: "unavailable",
    releaseUrl: null,
    checkedAt: new Date(0).toISOString(),
    message: "No GitHub releases yet"
  };
}

describe("formatCurrentVersionDisplay", () => {
  it("shows the current numbered beta channel", () => {
    expect(formatCurrentVersionDisplay(versionInfo("0.1.0-beta.1", "beta", "Beta"))).toEqual({
      version: "0.1.0",
      channel: "Beta 1"
    });
  });

  it("preserves beta sequence details in the channel badge", () => {
    expect(formatCurrentVersionDisplay(versionInfo("0.2.0-beta.12", "beta", "Beta"))).toEqual({
      version: "0.2.0",
      channel: "Beta 12"
    });
  });

  it("keeps stable versions unchanged", () => {
    expect(formatCurrentVersionDisplay(versionInfo("0.1.0", "stable", "Stable"))).toEqual({
      version: "0.1.0",
      channel: "Stable"
    });
  });
});
