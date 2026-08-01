import { describe, expect, it } from "vitest";
import { isActivePathMigrationStatus, pathMigrationProgressTitle, pathMigrationStatusLabel } from "../src/client/appShared";

describe("path migration display", () => {
  it("keeps rollback recovery active and clearly labelled", () => {
    expect(isActivePathMigrationStatus("rollback_pending")).toBe(true);
    expect(pathMigrationStatusLabel("rollback_pending")).toBe("Rolling back");
    expect(pathMigrationProgressTitle("rollback_pending", "Restoring symlinks to the active paths")).toBe("Rolling back paths");
  });

  it("preserves the existing active migration presentation", () => {
    expect(isActivePathMigrationStatus("queued")).toBe(true);
    expect(isActivePathMigrationStatus("running")).toBe(true);
    expect(isActivePathMigrationStatus("planned")).toBe(false);
    expect(pathMigrationStatusLabel("planned")).toBe("Ready");
    expect(pathMigrationProgressTitle("running", "Repointing symlinks")).toBe("Repointing symlinks");
  });
});
