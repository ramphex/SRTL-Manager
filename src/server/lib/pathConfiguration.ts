import fs from "node:fs/promises";
import path from "node:path";
import { and, asc, count, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { first, nowIso, type Db } from "../db/database";
import * as schema from "../db/schema";
import { assertPathParentInside } from "./filesystemSafety";
import type {
  JobEventRecord,
  ManagedPathRoot,
  PathConfigurationState,
  PathMigrationIssue,
  PathMigrationRecord,
  PathMigrationStatus,
  PathMigrationSummary,
  PathRootChange,
  PathRootIdentity,
  PathsSettings
} from "../../shared/types";

const pathConfigurationLockKey = 781_889_433;
const rootInspectionTimeoutMs = 5_000;
const filesystemReadTimeoutMs = 15_000;
const blockingMigrationStatuses: PathMigrationStatus[] = ["pending", "planning", "planned", "queued", "running", "failed"];
const emptyPaths: PathsSettings = { symlinkDir: "", localDir: "", remoteDir: "" };

type PathConfigurationRow = typeof schema.pathConfigurations.$inferSelect;
type PathMigrationRow = typeof schema.pathMigrations.$inferSelect;

export interface PathMigrationRunContext {
  signal: AbortSignal;
  event(level: JobEventRecord["level"], message: string, data?: unknown): Promise<void>;
  setProgress(progress: unknown): Promise<void>;
  isCancelled(): Promise<boolean>;
}

export interface ReconcileEnvironmentPathsOptions {
  allowDirectAdoptionBeforeInventory?: boolean;
}

function errorMessage(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause;
  return cause instanceof Error && cause.message ? `${error.message}: ${cause.message}` : error.message;
}

async function withTimeout<T>(operation: Promise<T>, description: string, timeoutMs: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new Error(`${description} timed out after ${timeoutMs / 1_000} seconds`)), timeoutMs);
  });
  try {
    return await Promise.race([operation, timedOut]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function normalizePathValue(value: string): string {
  const trimmed = value.trim();
  return trimmed ? path.resolve(trimmed) : "";
}

export function normalizeManagedPaths(paths: PathsSettings): PathsSettings {
  return {
    symlinkDir: normalizePathValue(paths.symlinkDir),
    localDir: normalizePathValue(paths.localDir),
    remoteDir: normalizePathValue(paths.remoteDir)
  };
}

export function validateManagedPaths(paths: PathsSettings): string[] {
  const errors: string[] = [];
  const roots = [
    ["Symlink directory", paths.symlinkDir],
    ["Local directory", paths.localDir],
    ["Remote directory", paths.remoteDir]
  ] as const;

  for (const [label, value] of roots) {
    if (!value) errors.push(`${label} is not configured in .env.`);
    else if (!path.isAbsolute(value)) errors.push(`${label} must be an absolute path.`);
  }

  const configured = roots.filter(([, value]) => Boolean(value));
  for (let left = 0; left < configured.length; left += 1) {
    for (let right = left + 1; right < configured.length; right += 1) {
      if (path.resolve(configured[left][1]) === path.resolve(configured[right][1])) {
        errors.push(`${configured[left][0]} and ${configured[right][0]} cannot use the same path.`);
      }
    }
  }
  return errors;
}

function pathsEqual(left: PathsSettings | null, right: PathsSettings): boolean {
  return Boolean(left && left.symlinkDir === right.symlinkDir && left.localDir === right.localDir && left.remoteDir === right.remoteDir);
}

function pathsFromConfiguration(row: PathConfigurationRow): PathsSettings {
  return { symlinkDir: row.symlinkDir, localDir: row.localDir, remoteDir: row.remoteDir };
}

function parseIdentity(raw: string): PathRootIdentity | null {
  try {
    const value = JSON.parse(raw) as Partial<PathRootIdentity>;
    if (typeof value.available !== "boolean") return null;
    return {
      available: value.available,
      realPath: typeof value.realPath === "string" ? value.realPath : null,
      device: typeof value.device === "string" ? value.device : null,
      inode: typeof value.inode === "string" ? value.inode : null,
      error: typeof value.error === "string" ? value.error : null
    };
  } catch {
    return null;
  }
}

async function inspectRoot(root: string): Promise<PathRootIdentity> {
  if (!root) return { available: false, realPath: null, device: null, inode: null, error: "Path is not configured" };
  try {
    return await withTimeout(
      (async (): Promise<PathRootIdentity> => {
      const [stat, realPath] = await Promise.all([fs.stat(root, { bigint: true }), fs.realpath(root)]);
      if (!stat.isDirectory()) {
        return { available: false, realPath, device: String(stat.dev), inode: String(stat.ino), error: "Path is not a directory" };
      }
      return { available: true, realPath, device: String(stat.dev), inode: String(stat.ino), error: null };
      })(),
      `Inspection of ${root}`,
      rootInspectionTimeoutMs
    );
  } catch (error: unknown) {
    return { available: false, realPath: null, device: null, inode: null, error: errorMessage(error) };
  }
}

async function inspectPaths(paths: PathsSettings): Promise<{ symlink: PathRootIdentity; local: PathRootIdentity; remote: PathRootIdentity }> {
  const [symlink, local, remote] = await Promise.all([inspectRoot(paths.symlinkDir), inspectRoot(paths.localDir), inspectRoot(paths.remoteDir)]);
  return { symlink, local, remote };
}

function identityMatch(active: PathRootIdentity | null, detected: PathRootIdentity | null): PathRootChange["identityMatch"] {
  if (!active?.available || !detected?.available) return "unknown";
  if (active.realPath && active.realPath === detected.realPath) return "same";
  if (active.device && active.inode && active.device === detected.device && active.inode === detected.inode) return "same";
  return "different";
}

function configurationIdentities(row: PathConfigurationRow | null): Record<ManagedPathRoot, PathRootIdentity | null> {
  return {
    symlink: row ? parseIdentity(row.symlinkIdentity) : null,
    local: row ? parseIdentity(row.localIdentity) : null,
    remote: row ? parseIdentity(row.remoteIdentity) : null
  };
}

async function latestBlockingMigration(db: Db): Promise<PathMigrationRow | null> {
  return (
    (await first(
      db
        .select()
        .from(schema.pathMigrations)
        .where(inArray(schema.pathMigrations.status, blockingMigrationStatuses))
        .orderBy(desc(schema.pathMigrations.id))
        .limit(1)
    )) ?? null
  );
}

export async function reconcileEnvironmentPaths(
  db: Db,
  environmentPaths: PathsSettings,
  options: ReconcileEnvironmentPathsOptions = {}
): Promise<void> {
  const detectedPaths = normalizeManagedPaths(environmentPaths);
  const environmentErrors = validateManagedPaths(detectedPaths);

  await db.transaction(async (transaction) => {
    await transaction.execute(sql`select pg_advisory_xact_lock(${pathConfigurationLockKey})`);
    let active =
      (await first(transaction.select().from(schema.pathConfigurations).where(eq(schema.pathConfigurations.status, "active")).limit(1))) ?? null;

    if (!active) {
      const legacySetting = await first(transaction.select({ value: schema.appSettings.value }).from(schema.appSettings).where(eq(schema.appSettings.key, "paths")).limit(1));
      let legacyPaths: PathsSettings;
      try {
        const parsed = JSON.parse(legacySetting?.value ?? "null") as Partial<PathsSettings> | null;
        legacyPaths = normalizeManagedPaths({
          symlinkDir: typeof parsed?.symlinkDir === "string" ? parsed.symlinkDir : "",
          localDir: typeof parsed?.localDir === "string" ? parsed.localDir : "",
          remoteDir: typeof parsed?.remoteDir === "string" ? parsed.remoteDir : ""
        });
      } catch {
        legacyPaths = emptyPaths;
      }
      const initialPaths = validateManagedPaths(legacyPaths).length === 0 ? legacyPaths : environmentErrors.length === 0 ? detectedPaths : null;
      if (initialPaths) {
        const identities = await inspectPaths(initialPaths);
        active =
          (await first(
            transaction
              .insert(schema.pathConfigurations)
              .values({
                status: "active",
                symlinkDir: initialPaths.symlinkDir,
                localDir: initialPaths.localDir,
                remoteDir: initialPaths.remoteDir,
                symlinkIdentity: JSON.stringify(identities.symlink),
                localIdentity: JSON.stringify(identities.local),
                remoteIdentity: JSON.stringify(identities.remote),
                createdAt: nowIso(),
                appliedAt: nowIso()
              })
              .returning()
          )) ?? null;
        if (!active) throw new Error("Initial path configuration was not created");
      }
    }

    if (active && environmentErrors.length === 0 && pathsEqual(pathsFromConfiguration(active), detectedPaths)) {
      const blocking = await transaction.select().from(schema.pathMigrations).where(inArray(schema.pathMigrations.status, blockingMigrationStatuses));
      if (blocking.length > 0) {
        const timestamp = nowIso();
        await transaction
          .update(schema.pathMigrations)
          .set({ status: "cancelled", finishedAt: timestamp, errorMessage: "Detected paths were restored before migration." })
          .where(inArray(schema.pathMigrations.id, blocking.map((row) => row.id)));
        await transaction
          .update(schema.pathConfigurations)
          .set({ status: "cancelled" })
          .where(inArray(schema.pathConfigurations.id, blocking.map((row) => row.targetConfigId)));
      }
      await transaction
        .insert(schema.appSettings)
        .values({ key: "paths", value: JSON.stringify(detectedPaths), updatedAt: nowIso() })
        .onConflictDoUpdate({ target: schema.appSettings.key, set: { value: JSON.stringify(detectedPaths), updatedAt: nowIso() } });
      return;
    }

    if (active && environmentErrors.length === 0 && options.allowDirectAdoptionBeforeInventory) {
      const timestamp = nowIso();
      const identities = await inspectPaths(detectedPaths);
      const blocking = await transaction.select().from(schema.pathMigrations).where(inArray(schema.pathMigrations.status, blockingMigrationStatuses));
      if (blocking.length > 0) {
        await transaction
          .update(schema.pathMigrations)
          .set({ status: "cancelled", finishedAt: timestamp, errorMessage: "Storage paths were corrected before the initial inventory scan." })
          .where(inArray(schema.pathMigrations.id, blocking.map((row) => row.id)));
        await transaction
          .update(schema.pathConfigurations)
          .set({ status: "cancelled" })
          .where(inArray(schema.pathConfigurations.id, blocking.map((row) => row.targetConfigId)));
      }
      await transaction
        .update(schema.pathConfigurations)
        .set({
          symlinkDir: detectedPaths.symlinkDir,
          localDir: detectedPaths.localDir,
          remoteDir: detectedPaths.remoteDir,
          symlinkIdentity: JSON.stringify(identities.symlink),
          localIdentity: JSON.stringify(identities.local),
          remoteIdentity: JSON.stringify(identities.remote),
          appliedAt: timestamp
        })
        .where(eq(schema.pathConfigurations.id, active.id));
      await transaction
        .insert(schema.appSettings)
        .values({ key: "paths", value: JSON.stringify(detectedPaths), updatedAt: timestamp })
        .onConflictDoUpdate({ target: schema.appSettings.key, set: { value: JSON.stringify(detectedPaths), updatedAt: timestamp } });
      return;
    }

    const existing =
      (await first(
        transaction
          .select()
          .from(schema.pathMigrations)
          .where(inArray(schema.pathMigrations.status, blockingMigrationStatuses))
          .orderBy(desc(schema.pathMigrations.id))
          .limit(1)
      )) ?? null;
    if (existing) {
      const target = await first(transaction.select().from(schema.pathConfigurations).where(eq(schema.pathConfigurations.id, existing.targetConfigId)).limit(1));
      if (target && pathsEqual(pathsFromConfiguration(target), detectedPaths)) return;
      const timestamp = nowIso();
      await transaction
        .update(schema.pathMigrations)
        .set({ status: "cancelled", finishedAt: timestamp, errorMessage: "A newer environment path change replaced this migration." })
        .where(eq(schema.pathMigrations.id, existing.id));
      await transaction.update(schema.pathConfigurations).set({ status: "cancelled" }).where(eq(schema.pathConfigurations.id, existing.targetConfigId));
    }

    const identities = await inspectPaths(detectedPaths);
    const target = await first(
      transaction
        .insert(schema.pathConfigurations)
        .values({
          status: "pending",
          symlinkDir: detectedPaths.symlinkDir,
          localDir: detectedPaths.localDir,
          remoteDir: detectedPaths.remoteDir,
          symlinkIdentity: JSON.stringify(identities.symlink),
          localIdentity: JSON.stringify(identities.local),
          remoteIdentity: JSON.stringify(identities.remote),
          createdAt: nowIso(),
          appliedAt: null
        })
        .returning()
    );
    if (!target) throw new Error("Pending path configuration was not created");
    await transaction.insert(schema.pathMigrations).values({
      sourceConfigId: active?.id ?? null,
      targetConfigId: target.id,
      status: "pending",
      jobId: null,
      errorMessage: environmentErrors.length > 0 ? environmentErrors.join(" ") : null,
      createdAt: nowIso(),
      plannedAt: null,
      startedAt: null,
      finishedAt: null
    });
  });
}

export async function isPathConfigurationBlocked(db: Db): Promise<boolean> {
  const row = await first(
    db
      .select({ id: schema.pathMigrations.id })
      .from(schema.pathMigrations)
      .where(inArray(schema.pathMigrations.status, blockingMigrationStatuses))
      .limit(1)
  );
  return Boolean(row);
}

function rootChange(root: ManagedPathRoot, label: string, activePath: string, detectedPath: string, activeIdentity: PathRootIdentity | null, detectedIdentity: PathRootIdentity | null): PathRootChange {
  return {
    root,
    label,
    activePath,
    detectedPath,
    changed: activePath !== detectedPath,
    identityMatch: activePath === detectedPath ? "same" : identityMatch(activeIdentity, detectedIdentity),
    activeIdentity,
    detectedIdentity
  };
}

async function migrationSummary(db: Db, migrationId: number): Promise<PathMigrationSummary> {
  const itemCounts = await first(
    db
      .select({
        affectedLinks: count(),
        readyLinks: sql<number>`count(*) filter (where ${schema.pathMigrationItems.validationStatus} in ('ready', 'applied'))`,
        blockedLinks: sql<number>`count(*) filter (where ${schema.pathMigrationItems.validationStatus} = 'blocked')`,
        repointLinks: sql<number>`count(*) filter (where ${schema.pathMigrationItems.targetChanged} = true)`,
        rebaseLinkPaths: sql<number>`count(*) filter (where ${schema.pathMigrationItems.linkPathBefore} <> ${schema.pathMigrationItems.linkPathAfter})`
      })
      .from(schema.pathMigrationItems)
      .where(eq(schema.pathMigrationItems.migrationId, migrationId))
  );
  const [totalLinks, localFiles, remoteFiles, copySources, activeJobs] = await Promise.all([
    first(db.select({ value: count() }).from(schema.mediaLinks)),
    first(db.select({ value: count() }).from(schema.storageFiles).where(eq(schema.storageFiles.rootType, "local"))),
    first(db.select({ value: count() }).from(schema.storageFiles).where(eq(schema.storageFiles.rootType, "remote"))),
    first(db.select({ value: count() }).from(schema.copySources)),
    first(db.select({ value: count() }).from(schema.jobs).where(and(inArray(schema.jobs.status, ["queued", "running"]), ne(schema.jobs.type, "path_migration"))))
  ]);
  return {
    totalLinks: Number(totalLinks?.value ?? 0),
    affectedLinks: Number(itemCounts?.affectedLinks ?? 0),
    readyLinks: Number(itemCounts?.readyLinks ?? 0),
    blockedLinks: Number(itemCounts?.blockedLinks ?? 0),
    repointLinks: Number(itemCounts?.repointLinks ?? 0),
    rebaseLinkPaths: Number(itemCounts?.rebaseLinkPaths ?? 0),
    localFiles: Number(localFiles?.value ?? 0),
    remoteFiles: Number(remoteFiles?.value ?? 0),
    copySources: Number(copySources?.value ?? 0),
    activeJobs: Number(activeJobs?.value ?? 0)
  };
}

async function migrationIssues(db: Db, migrationId: number): Promise<PathMigrationIssue[]> {
  const rows = await db
    .select({ id: schema.pathMigrationItems.id, itemName: schema.pathMigrationItems.itemName, linkPath: schema.pathMigrationItems.currentLinkPath, message: schema.pathMigrationItems.message })
    .from(schema.pathMigrationItems)
    .where(and(eq(schema.pathMigrationItems.migrationId, migrationId), eq(schema.pathMigrationItems.validationStatus, "blocked")))
    .orderBy(asc(schema.pathMigrationItems.id))
    .limit(25);
  return rows;
}

function stateStatus(migration: PathMigrationRow | null, environmentErrors: string[]): PathConfigurationState["status"] {
  if (environmentErrors.length > 0) return "invalid_environment";
  if (!migration) return "ready";
  if (migration.status === "planning") return "planning";
  if (migration.status === "planned") return "ready_to_apply";
  if (migration.status === "queued" || migration.status === "running") return "migrating";
  if (migration.status === "failed") return "failed";
  return "change_pending";
}

export async function getPathConfigurationState(db: Db, environmentPaths: PathsSettings): Promise<PathConfigurationState> {
  const detectedPaths = normalizeManagedPaths(environmentPaths);
  const environmentErrors = validateManagedPaths(detectedPaths);
  const active =
    (await first(db.select().from(schema.pathConfigurations).where(eq(schema.pathConfigurations.status, "active")).limit(1))) ?? null;
  const migration = await latestBlockingMigration(db);
  const target = migration
    ? ((await first(db.select().from(schema.pathConfigurations).where(eq(schema.pathConfigurations.id, migration.targetConfigId)).limit(1))) ?? null)
    : null;
  const activePaths = active ? pathsFromConfiguration(active) : null;
  const targetPaths = target ? pathsFromConfiguration(target) : detectedPaths;
  const activeIdentities = configurationIdentities(active);
  const targetIdentities = configurationIdentities(target);
  const changes = [
    rootChange("symlink", "Symlink directory", activePaths?.symlinkDir ?? "", targetPaths.symlinkDir, activeIdentities.symlink, targetIdentities.symlink),
    rootChange("local", "Local directory", activePaths?.localDir ?? "", targetPaths.localDir, activeIdentities.local, targetIdentities.local),
    rootChange("remote", "Remote directory", activePaths?.remoteDir ?? "", targetPaths.remoteDir, activeIdentities.remote, targetIdentities.remote)
  ];
  const migrationRecord: PathMigrationRecord | null = migration
    ? {
        id: migration.id,
        status: migration.status as PathMigrationStatus,
        jobId: migration.jobId,
        errorMessage: migration.errorMessage,
        createdAt: migration.createdAt,
        plannedAt: migration.plannedAt,
        startedAt: migration.startedAt,
        finishedAt: migration.finishedAt,
        summary: await migrationSummary(db, migration.id),
        issues: await migrationIssues(db, migration.id)
      }
    : null;

  return {
    status: stateStatus(migration, environmentErrors),
    blocking: Boolean(migration || environmentErrors.length > 0 || !active),
    activePaths,
    detectedPaths,
    environmentErrors,
    changes,
    migration: migrationRecord
  };
}

function isPathInside(root: string, candidate: string): boolean {
  if (!root || !candidate) return false;
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function rebasePath(value: string, oldRoot: string, newRoot: string): string {
  if (!oldRoot || !newRoot || oldRoot === newRoot || !isPathInside(oldRoot, value)) return path.resolve(value);
  return path.resolve(newRoot, path.relative(path.resolve(oldRoot), path.resolve(value)));
}

function targetPathForConfiguration(value: string, source: PathsSettings, target: PathsSettings): string {
  if (source.localDir !== target.localDir) {
    if (isPathInside(target.localDir, value)) return path.resolve(value);
    if (isPathInside(source.localDir, value)) return rebasePath(value, source.localDir, target.localDir);
  }
  if (source.remoteDir !== target.remoteDir) {
    if (isPathInside(target.remoteDir, value)) return path.resolve(value);
    if (isPathInside(source.remoteDir, value)) return rebasePath(value, source.remoteDir, target.remoteDir);
  }
  return path.resolve(value);
}

async function readSymlinkDetails(linkPath: string): Promise<{ rawTarget: string; resolvedTarget: string }> {
  return withTimeout(
    (async () => {
      const stat = await fs.lstat(linkPath);
      if (!stat.isSymbolicLink()) throw new Error("Path is no longer a symlink");
      const rawTarget = await fs.readlink(linkPath);
      return {
        rawTarget,
        resolvedTarget: path.resolve(path.isAbsolute(rawTarget) ? rawTarget : path.resolve(path.dirname(linkPath), rawTarget))
      };
    })(),
    `Reading symlink ${linkPath}`,
    filesystemReadTimeoutMs
  );
}

async function symlinkTarget(linkPath: string): Promise<string> {
  return (await readSymlinkDetails(linkPath)).resolvedTarget;
}

async function validateMigrationItem(link: typeof schema.mediaLinks.$inferSelect, source: PathsSettings, target: PathsSettings): Promise<typeof schema.pathMigrationItems.$inferInsert | null> {
  const linkPathAfter = rebasePath(link.linkPath, source.symlinkDir, target.symlinkDir);
  const linkPathChanged = path.resolve(link.linkPath) !== path.resolve(linkPathAfter);
  let actualTarget: string;
  let baselineTarget: string;
  try {
    const details = await readSymlinkDetails(linkPathAfter);
    actualTarget = details.resolvedTarget;
    baselineTarget = linkPathChanged && !path.isAbsolute(details.rawTarget) ? path.resolve(link.targetPath) : actualTarget;
  } catch (error: unknown) {
    if (!linkPathChanged && source.localDir === target.localDir && source.remoteDir === target.remoteDir) return null;
    return {
      migrationId: 0,
      mediaLinkId: link.id,
      itemName: link.itemName,
      currentLinkPath: linkPathAfter,
      linkPathBefore: link.linkPath,
      linkPathAfter,
      targetPathBefore: link.targetPath,
      targetPathAfter: targetPathForConfiguration(link.targetPath, source, target),
      targetChanged: false,
      expectedSizeBytes: link.sizeBytes,
      validationStatus: "blocked",
      message: `Symlink could not be validated at the detected path: ${errorMessage(error)}`,
      appliedAt: null,
      rolledBackAt: null
    };
  }

  const desiredTarget = targetPathForConfiguration(baselineTarget, source, target);
  const targetChanged = path.resolve(actualTarget) !== path.resolve(desiredTarget);
  if (!linkPathChanged && !targetChanged) return null;

  const managedTargetChanged =
    (source.localDir !== target.localDir && (isPathInside(source.localDir, baselineTarget) || isPathInside(target.localDir, baselineTarget))) ||
    (source.remoteDir !== target.remoteDir && (isPathInside(source.remoteDir, baselineTarget) || isPathInside(target.remoteDir, baselineTarget)));
  let expectedSizeBytes = link.sizeBytes;
  if (targetChanged) {
    const oldTargetStat = await withTimeout(fs.stat(baselineTarget), `Reading source target ${baselineTarget}`, filesystemReadTimeoutMs).catch(() => null);
    if (oldTargetStat?.isFile()) expectedSizeBytes = Number(oldTargetStat.size);
  }

  if (managedTargetChanged || targetChanged) {
    try {
      const destinationStat = await withTimeout(fs.stat(desiredTarget), `Reading mapped target ${desiredTarget}`, filesystemReadTimeoutMs);
      if (!destinationStat.isFile()) throw new Error("Mapped target is not a regular file");
      if (expectedSizeBytes != null && Number(destinationStat.size) !== expectedSizeBytes) {
        throw new Error(`Mapped target size differs from the indexed file (${Number(destinationStat.size)} bytes instead of ${expectedSizeBytes} bytes)`);
      }
      expectedSizeBytes = Number(destinationStat.size);
    } catch (error: unknown) {
      return {
        migrationId: 0,
        mediaLinkId: link.id,
        itemName: link.itemName,
        currentLinkPath: linkPathAfter,
        linkPathBefore: link.linkPath,
        linkPathAfter,
        targetPathBefore: actualTarget,
        targetPathAfter: desiredTarget,
        targetChanged,
        expectedSizeBytes,
        validationStatus: "blocked",
        message: `Mapped target could not be validated: ${errorMessage(error)}`,
        appliedAt: null,
        rolledBackAt: null
      };
    }
  }

  return {
    migrationId: 0,
    mediaLinkId: link.id,
    itemName: link.itemName,
    currentLinkPath: linkPathAfter,
    linkPathBefore: link.linkPath,
    linkPathAfter,
    targetPathBefore: actualTarget,
    targetPathAfter: desiredTarget,
    targetChanged,
    expectedSizeBytes,
    validationStatus: "ready",
    message: targetChanged ? "Mapped target exists and passed size validation." : "Symlink path is available under the detected root.",
    appliedAt: null,
    rolledBackAt: null
  };
}

async function mapWithConcurrency<T, R>(values: T[], concurrency: number, mapper: (value: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      while (nextIndex < values.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await mapper(values[index]);
      }
    })
  );
  return results;
}

async function migrationContext(db: Db, migrationId: number): Promise<{ migration: PathMigrationRow; source: PathConfigurationRow; target: PathConfigurationRow }> {
  const migration = await first(db.select().from(schema.pathMigrations).where(eq(schema.pathMigrations.id, migrationId)).limit(1));
  if (!migration) throw new Error("Path migration was not found");
  if (!migration.sourceConfigId) throw new Error("Initial path configuration is incomplete; correct .env and restart the app");
  const [source, target] = await Promise.all([
    first(db.select().from(schema.pathConfigurations).where(eq(schema.pathConfigurations.id, migration.sourceConfigId)).limit(1)),
    first(db.select().from(schema.pathConfigurations).where(eq(schema.pathConfigurations.id, migration.targetConfigId)).limit(1))
  ]);
  if (!source || !target) throw new Error("Path migration configuration is incomplete");
  return { migration, source, target };
}

export async function planPathMigration(db: Db, migrationId: number): Promise<void> {
  const { migration, source, target } = await migrationContext(db, migrationId);
  if (!["pending", "planned", "failed"].includes(migration.status)) throw new Error("Path migration cannot be analyzed in its current state");
  const targetPaths = pathsFromConfiguration(target);
  const environmentErrors = validateManagedPaths(targetPaths);
  if (environmentErrors.length > 0) throw new Error(environmentErrors.join(" "));

  const claimed = await first(
    db
      .update(schema.pathMigrations)
      .set({ status: "planning", errorMessage: null, plannedAt: null, finishedAt: null })
      .where(and(eq(schema.pathMigrations.id, migrationId), inArray(schema.pathMigrations.status, ["pending", "planned", "failed"])))
      .returning({ id: schema.pathMigrations.id })
  );
  if (!claimed) throw new Error("Path migration analysis is already running or the detected path change was replaced");
  await db.delete(schema.pathMigrationItems).where(eq(schema.pathMigrationItems.migrationId, migrationId));
  try {
    const identities = await inspectPaths(targetPaths);
    await db
      .update(schema.pathConfigurations)
      .set({ symlinkIdentity: JSON.stringify(identities.symlink), localIdentity: JSON.stringify(identities.local), remoteIdentity: JSON.stringify(identities.remote) })
      .where(eq(schema.pathConfigurations.id, target.id));
    const inspectedRoots: Array<[string, PathRootIdentity]> = [
      ["Symlink directory", identities.symlink],
      ["Local directory", identities.local],
      ["Remote directory", identities.remote]
    ];
    const unavailableRoots = inspectedRoots.filter(([, identity]) => !identity.available);
    if (unavailableRoots.length > 0) {
      throw new Error(
        unavailableRoots
          .map(([label, identity]) => `${label} is unavailable${identity.error ? `: ${identity.error}` : ""}`)
          .join(" ")
      );
    }
    const links = await db.select().from(schema.mediaLinks).where(isNull(schema.mediaLinks.missingSince)).orderBy(asc(schema.mediaLinks.id));
    const planned = (await mapWithConcurrency(links, 8, (link) => validateMigrationItem(link, pathsFromConfiguration(source), targetPaths))).filter(
      (item): item is NonNullable<typeof item> => item !== null
    );
    for (let offset = 0; offset < planned.length; offset += 500) {
      await db.insert(schema.pathMigrationItems).values(planned.slice(offset, offset + 500).map((item) => ({ ...item, migrationId })));
    }
    const plannedMigration = await first(
      db
        .update(schema.pathMigrations)
        .set({ status: "planned", plannedAt: nowIso(), errorMessage: null })
        .where(and(eq(schema.pathMigrations.id, migrationId), eq(schema.pathMigrations.status, "planning")))
        .returning({ id: schema.pathMigrations.id })
    );
    if (!plannedMigration) throw new Error("Detected paths changed again while migration analysis was running");
  } catch (error: unknown) {
    await db
      .update(schema.pathMigrations)
      .set({ status: "failed", errorMessage: errorMessage(error), finishedAt: nowIso() })
      .where(and(eq(schema.pathMigrations.id, migrationId), eq(schema.pathMigrations.status, "planning")));
    throw error;
  }
}

export async function assertPathMigrationReady(db: Db, migrationId: number): Promise<void> {
  const migration = await first(db.select().from(schema.pathMigrations).where(eq(schema.pathMigrations.id, migrationId)).limit(1));
  if (!migration || migration.status !== "planned") throw new Error("Analyze the path change before starting migration");
  const blocked = await first(
    db
      .select({ value: count() })
      .from(schema.pathMigrationItems)
      .where(and(eq(schema.pathMigrationItems.migrationId, migrationId), eq(schema.pathMigrationItems.validationStatus, "blocked")))
  );
  if (Number(blocked?.value ?? 0) > 0) throw new Error("Resolve every blocked symlink before starting migration");
  const running = await first(
    db
      .select({ value: count() })
      .from(schema.jobs)
      .where(and(eq(schema.jobs.status, "running"), ne(schema.jobs.type, "path_migration")))
  );
  if (Number(running?.value ?? 0) > 0) throw new Error("Waiting for the active job to pause before path migration can start");
}

async function replaceSymlink(linkRoot: string, linkPath: string, targetPath: string): Promise<void> {
  await assertPathParentInside(linkRoot, linkPath, "Path migration symlink");
  const tempPath = `${linkPath}.srtl-path-migration-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  try {
    await fs.symlink(targetPath, tempPath);
    const installedTarget = await symlinkTarget(tempPath);
    if (path.resolve(installedTarget) !== path.resolve(targetPath)) throw new Error("Temporary symlink target validation failed");
    await assertPathParentInside(linkRoot, linkPath, "Path migration symlink");
    await fs.rename(tempPath, linkPath);
  } catch (error: unknown) {
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function rollbackMigrationItems(db: Db, migrationId: number, linkRoot: string, ctx: PathMigrationRunContext): Promise<string[]> {
  const errors: string[] = [];
  const items = await db
    .select()
    .from(schema.pathMigrationItems)
    .where(and(eq(schema.pathMigrationItems.migrationId, migrationId), eq(schema.pathMigrationItems.validationStatus, "applied")))
    .orderBy(desc(schema.pathMigrationItems.id));
  for (const item of items) {
    if (!item.targetChanged) continue;
    try {
      const currentTarget = await symlinkTarget(item.currentLinkPath);
      if (path.resolve(currentTarget) !== path.resolve(item.targetPathAfter)) {
        const message = `Rollback stopped because the symlink target changed again. Expected ${item.targetPathAfter}, found ${currentTarget}. Manual review is required.`;
        await db
          .update(schema.pathMigrationItems)
          .set({ validationStatus: "blocked", rolledBackAt: null, message })
          .where(eq(schema.pathMigrationItems.id, item.id));
        throw new Error(message);
      }
      await replaceSymlink(linkRoot, item.currentLinkPath, item.targetPathBefore);
      await db
        .update(schema.pathMigrationItems)
        .set({ validationStatus: "rolled_back", rolledBackAt: nowIso(), message: "Repointing was rolled back after migration stopped." })
        .where(eq(schema.pathMigrationItems.id, item.id));
    } catch (error: unknown) {
      const message = `${item.currentLinkPath}: ${errorMessage(error)}`;
      errors.push(message);
      await ctx.event("error", "Path migration rollback failed", { linkPath: item.currentLinkPath, error: errorMessage(error) });
    }
  }
  return errors;
}

async function cancelQueuedJobsForMigration(db: Db, migrationJobId: number): Promise<number> {
  const queued = await db
    .select({ id: schema.jobs.id })
    .from(schema.jobs)
    .where(and(eq(schema.jobs.status, "queued"), ne(schema.jobs.id, migrationJobId)));
  if (queued.length === 0) return 0;
  const timestamp = nowIso();
  await db
    .update(schema.jobs)
    .set({ status: "cancelled", finishedAt: timestamp, cancelRequestedAt: timestamp })
    .where(inArray(schema.jobs.id, queued.map((row) => row.id)));
  await db.insert(schema.jobEvents).values(
    queued.map((row) => ({
      jobId: row.id,
      timestamp,
      level: "warn",
      message: "Job cancelled because managed storage paths changed",
      data: JSON.stringify({ pathMigrationJobId: migrationJobId })
    }))
  );
  return queued.length;
}

async function rebaseStorageInventory(db: Pick<Db, "execute">, rootType: "local" | "remote", oldRoot: string, newRoot: string): Promise<void> {
  if (oldRoot === newRoot) return;
  await db.execute(sql`
    UPDATE storage_files
    SET file_path = ${newRoot} || substr(file_path, ${oldRoot.length + 1}),
        root_path = ${newRoot},
        updated_at = ${nowIso()}
    WHERE root_type = ${rootType}
      AND (file_path = ${oldRoot} OR left(file_path, ${oldRoot.length + 1}) = ${`${oldRoot}${path.sep}`})
  `);
}

async function rebaseMissingMediaLinks(db: Pick<Db, "execute">, column: "link_path" | "target_path", oldRoot: string, newRoot: string): Promise<void> {
  if (oldRoot === newRoot) return;
  if (column === "link_path") {
    await db.execute(sql`
      UPDATE media_links
      SET link_path = ${newRoot} || substr(link_path, ${oldRoot.length + 1}),
          updated_at = ${nowIso()}
      WHERE missing_since IS NOT NULL
        AND (link_path = ${oldRoot} OR left(link_path, ${oldRoot.length + 1}) = ${`${oldRoot}${path.sep}`})
    `);
    return;
  }
  await db.execute(sql`
    UPDATE media_links
    SET target_path = ${newRoot} || substr(target_path, ${oldRoot.length + 1}),
        updated_at = ${nowIso()}
    WHERE missing_since IS NOT NULL
      AND (target_path = ${oldRoot} OR left(target_path, ${oldRoot.length + 1}) = ${`${oldRoot}${path.sep}`})
  `);
}

function rebaseCopySourceRow(row: typeof schema.copySources.$inferSelect, source: PathsSettings, target: PathsSettings): typeof schema.copySources.$inferInsert {
  let sourcePath = rebasePath(row.sourcePath, source.localDir, target.localDir);
  sourcePath = rebasePath(sourcePath, source.remoteDir, target.remoteDir);
  let destinationPath = rebasePath(row.destinationPath, source.localDir, target.localDir);
  destinationPath = rebasePath(destinationPath, source.remoteDir, target.remoteDir);
  return {
    id: row.id,
    sourcePath,
    destinationPath,
    linkPath: rebasePath(row.linkPath, source.symlinkDir, target.symlinkDir),
    recordedAt: row.recordedAt
  };
}

export async function runPathMigration(db: Db, migrationId: number, ctx: PathMigrationRunContext): Promise<void> {
  const { migration, source, target } = await migrationContext(db, migrationId);
  if (migration.status === "completed") {
    const itemCount = await first(
      db.select({ value: count() }).from(schema.pathMigrationItems).where(eq(schema.pathMigrationItems.migrationId, migrationId))
    );
    const total = Number(itemCount?.value ?? 0);
    await ctx.setProgress({ migrationId, stage: "completed", current: total, total, message: "Path migration completed" });
    await ctx.event("info", "Recovered completed managed path migration", { migrationId, total });
    return;
  }
  if (!["queued", "running"].includes(migration.status)) throw new Error("Path migration is not queued");
  const blocked = await first(
    db
      .select({ value: count() })
      .from(schema.pathMigrationItems)
      .where(and(eq(schema.pathMigrationItems.migrationId, migrationId), eq(schema.pathMigrationItems.validationStatus, "blocked")))
  );
  if (Number(blocked?.value ?? 0) > 0) throw new Error("Path migration contains blocked symlinks");

  const runningJobs = await db
    .select({ id: schema.jobs.id })
    .from(schema.jobs)
    .where(and(eq(schema.jobs.status, "running"), ne(schema.jobs.id, migration.jobId ?? -1)));
  if (runningJobs.length > 0) throw new Error("Another job is still running; wait for it to pause before migrating paths");

  const cancelledJobs = await cancelQueuedJobsForMigration(db, migration.jobId ?? -1);
  const runningMigration = await first(
    db
      .update(schema.pathMigrations)
      .set({ status: "running", startedAt: migration.startedAt ?? nowIso(), errorMessage: null })
      .where(and(eq(schema.pathMigrations.id, migrationId), inArray(schema.pathMigrations.status, ["queued", "running"])))
      .returning({ id: schema.pathMigrations.id })
  );
  if (!runningMigration) throw new Error("Path migration was replaced before the worker started");
  const items = await db.select().from(schema.pathMigrationItems).where(eq(schema.pathMigrationItems.migrationId, migrationId)).orderBy(asc(schema.pathMigrationItems.id));
  const total = items.length;
  await ctx.event("warn", "Managed path migration started", { migrationId, total, cancelledJobs });
  await ctx.setProgress({ migrationId, stage: "validating", current: 0, total, message: "Revalidating mapped symlinks" });

  let completed = items.filter((item) => item.validationStatus === "applied").length;
  let committed = false;
  try {
    for (const item of items) {
      if (await ctx.isCancelled()) throw new Error("Path migration was terminated");
      if (completed === 0 || completed % 25 === 0) {
        const currentMigration = await first(db.select({ status: schema.pathMigrations.status }).from(schema.pathMigrations).where(eq(schema.pathMigrations.id, migrationId)).limit(1));
        if (currentMigration?.status !== "running") throw new Error("Detected paths changed again while migration was running");
      }
      if (item.validationStatus === "applied") continue;
      if (item.validationStatus !== "ready") throw new Error(`Symlink is not ready for migration: ${item.currentLinkPath}`);
      if (item.targetChanged) {
        const currentTarget = await symlinkTarget(item.currentLinkPath);
        if (path.resolve(currentTarget) === path.resolve(item.targetPathBefore)) {
          const destinationStat = await withTimeout(fs.stat(item.targetPathAfter), `Reading mapped target ${item.targetPathAfter}`, filesystemReadTimeoutMs);
          if (!destinationStat.isFile()) throw new Error(`Mapped target is no longer a regular file: ${item.targetPathAfter}`);
          if (item.expectedSizeBytes != null && Number(destinationStat.size) !== item.expectedSizeBytes) {
            throw new Error(`Mapped target changed after analysis: ${item.targetPathAfter}`);
          }
          await replaceSymlink(target.symlinkDir, item.currentLinkPath, item.targetPathAfter);
        } else if (path.resolve(currentTarget) !== path.resolve(item.targetPathAfter)) {
          throw new Error(`Symlink changed after analysis: ${item.currentLinkPath}`);
        }
      } else {
        await symlinkTarget(item.currentLinkPath);
      }
      completed += 1;
      await db
        .update(schema.pathMigrationItems)
        .set({ validationStatus: "applied", appliedAt: nowIso(), rolledBackAt: null, message: "Migration step applied." })
        .where(eq(schema.pathMigrationItems.id, item.id));
      if (completed === total || completed % 25 === 0) {
        await ctx.setProgress({ migrationId, stage: "repointing", current: completed, total, message: `Validated and migrated ${completed} of ${total} symlinks` });
      }
    }

    const sourcePaths = pathsFromConfiguration(source);
    const targetPaths = pathsFromConfiguration(target);
    const copySources = await db.select().from(schema.copySources);
    await db.transaction(async (transaction) => {
      await transaction.execute(sql`select pg_advisory_xact_lock(${pathConfigurationLockKey})`);
      const currentMigration = await first(
        transaction.select({ status: schema.pathMigrations.status }).from(schema.pathMigrations).where(eq(schema.pathMigrations.id, migrationId)).limit(1)
      );
      if (currentMigration?.status !== "running") throw new Error("Detected paths changed again before migration could be committed");
      await transaction.execute(sql`
        UPDATE media_links AS media
        SET link_path = item.link_path_after,
            target_path = item.target_path_after,
            target_exists = CASE WHEN item.target_changed THEN true ELSE media.target_exists END,
            updated_at = ${nowIso()}
        FROM path_migration_items AS item
        WHERE item.migration_id = ${migrationId}
          AND item.media_link_id = media.id
          AND item.validation_status = 'applied'
      `);
      await rebaseStorageInventory(transaction, "local", sourcePaths.localDir, targetPaths.localDir);
      await rebaseStorageInventory(transaction, "remote", sourcePaths.remoteDir, targetPaths.remoteDir);
      await rebaseMissingMediaLinks(transaction, "link_path", sourcePaths.symlinkDir, targetPaths.symlinkDir);
      await rebaseMissingMediaLinks(transaction, "target_path", sourcePaths.localDir, targetPaths.localDir);
      await rebaseMissingMediaLinks(transaction, "target_path", sourcePaths.remoteDir, targetPaths.remoteDir);
      for (const row of copySources) {
        const rebased = rebaseCopySourceRow(row, sourcePaths, targetPaths);
        await transaction
          .update(schema.copySources)
          .set({ sourcePath: rebased.sourcePath, destinationPath: rebased.destinationPath, linkPath: rebased.linkPath })
          .where(eq(schema.copySources.id, row.id));
      }
      const timestamp = nowIso();
      await transaction.update(schema.pathConfigurations).set({ status: "superseded" }).where(eq(schema.pathConfigurations.id, source.id));
      await transaction.update(schema.pathConfigurations).set({ status: "active", appliedAt: timestamp }).where(eq(schema.pathConfigurations.id, target.id));
      await transaction
        .insert(schema.appSettings)
        .values({ key: "paths", value: JSON.stringify(targetPaths), updatedAt: timestamp })
        .onConflictDoUpdate({ target: schema.appSettings.key, set: { value: JSON.stringify(targetPaths), updatedAt: timestamp } });
      await transaction
        .update(schema.pathMigrations)
        .set({ status: "completed", finishedAt: timestamp, errorMessage: null })
        .where(eq(schema.pathMigrations.id, migrationId));
    });
    committed = true;
  } catch (error: unknown) {
    if (!committed) {
      const rollbackErrors = await rollbackMigrationItems(db, migrationId, target.symlinkDir, ctx);
      const message = rollbackErrors.length > 0 ? `${errorMessage(error)} Rollback also failed for ${rollbackErrors.length} symlink(s).` : errorMessage(error);
      const failureFilter = rollbackErrors.length > 0
        ? eq(schema.pathMigrations.id, migrationId)
        : and(eq(schema.pathMigrations.id, migrationId), eq(schema.pathMigrations.status, "running"));
      await db.update(schema.pathMigrations).set({ status: "failed", errorMessage: message, finishedAt: nowIso() }).where(failureFilter);
      throw new Error(message, { cause: error });
    }
    throw error;
  }

  await ctx.setProgress({ migrationId, stage: "completed", current: total, total, message: "Path migration completed" }).catch(() => undefined);
  await ctx.event("info", "Managed path migration completed", { migrationId, total }).catch(() => undefined);
}
