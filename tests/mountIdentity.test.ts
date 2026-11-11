import { describe, expect, it } from "vitest";
import { findMountIdentity, parseLinuxMountInfo, persistentRootIdentityMatch } from "../src/server/lib/mountIdentity";
import type { PathRootIdentity } from "../src/shared/types";

const remoteMount = {
  mountPoint: "/mnt/remote/storage",
  root: "/",
  filesystemType: "fuse.remotefs",
  source: "remotefs"
};

function rootIdentity(device: string, mount = remoteMount): PathRootIdentity {
  return {
    available: true,
    realPath: "/mnt/remote/storage/library",
    device,
    inode: "1320498586805139757",
    mount,
    error: null
  };
}

describe("managed root mount identity", () => {
  it("finds the most specific Linux mount and decodes escaped fields", () => {
    const mounts = parseLinuxMountInfo(
      [
        "36 25 8:2 / / rw,relatime - ext4 /dev/sda2 rw",
        "51 36 0:51 / /mnt/local/nas rw,relatime - nfs4 192.168.1.20:/mnt/pool/media rw",
        "65 36 0:65 / /mnt/remote/storage rw,nosuid,nodev - fuse.remotefs remotefs rw",
        "66 36 0:66 / /mnt/media\\040pool rw - fuse.example source\\040name rw"
      ].join("\n")
    );

    expect(findMountIdentity("/mnt/remote/storage/library", mounts)).toEqual(remoteMount);
    expect(findMountIdentity("/mnt/media pool/library", mounts)).toMatchObject({ mountPoint: "/mnt/media pool", source: "source name" });
  });

  it("accepts a new device number for the same canonical path and mount source", () => {
    expect(persistentRootIdentityMatch(rootIdentity("79"), rootIdentity("65"))).toBe(true);
  });

  it("rejects the same path when it falls back to a different mounted filesystem", () => {
    expect(
      persistentRootIdentityMatch(rootIdentity("79"), rootIdentity("2050", { mountPoint: "/", root: "/", filesystemType: "ext4", source: "/dev/sda2" }))
    ).toBe(false);
  });

  it("upgrades a legacy identity without mount metadata using its canonical path", () => {
    expect(persistentRootIdentityMatch({ ...rootIdentity("79"), mount: null }, rootIdentity("65"))).toBe(true);
  });

  it("does not upgrade a legacy mounted identity onto the host root filesystem", () => {
    expect(
      persistentRootIdentityMatch(
        { ...rootIdentity("79"), mount: null },
        rootIdentity("2050", { mountPoint: "/", root: "/", filesystemType: "ext4", source: "/dev/sda2" })
      )
    ).toBe(false);
  });
});
