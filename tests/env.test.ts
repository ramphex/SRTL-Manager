import { describe, expect, it } from "vitest";
import { mergeEnvSettings, parseEnvFile, readProcessEnvSettings } from "../src/server/lib/env";

describe("environment settings", () => {
  it("parses supported deployment settings", () => {
    const env = parseEnvFile(`
SYMLINK_DIR="/symlinks"
SRTL_LOCATION_1_PATH='/local'
SRTL_LOCATION_2_PATH=/remote
SRTL_WORKER_COUNT=4
SRTL_MAX_RUNNING_JOBS=8
IGNORED=value
`);
    expect(env).toEqual({
      SYMLINK_DIR: "/symlinks",
      SRTL_LOCATION_1_PATH: "/local",
      SRTL_LOCATION_2_PATH: "/remote",
      SRTL_WORKER_COUNT: "4"
    });
  });

  it("merges process environment settings over file defaults", () => {
    const fileDefaults = parseEnvFile(`
SYMLINK_DIR=/old/links
SRTL_LOCATION_1_PATH=/old/local
SRTL_LOCATION_2_PATH=/old/remote
`);
    const runtime = readProcessEnvSettings({
      SYMLINK_DIR: "/mnt/local/nas/symlinks",
      SRTL_LOCATION_1_PATH: "/mnt/local/nas/local",
      SRTL_LOCATION_2_PATH: "/mnt/remote",
      SRTL_WORKER_COUNT: "2",
      SRTL_MAX_RUNNING_COPIES: "1"
    });
    expect(mergeEnvSettings(fileDefaults, runtime)).toEqual({
      SYMLINK_DIR: "/mnt/local/nas/symlinks",
      SRTL_LOCATION_1_PATH: "/mnt/local/nas/local",
      SRTL_LOCATION_2_PATH: "/mnt/remote",
      SRTL_WORKER_COUNT: "2"
    });
  });
});
