import fs from "node:fs/promises";
import path from "node:path";
import { and, asc, count, desc, eq, inArray, isNull, ne, notInArray, sql } from "drizzle-orm";
import { first, nowIso, type Db, type DbExecutor } from "../db/database";
import * as schema from "../db/schema";
import { unresolvedCopyReconciliation } from "../jobs/copyReconciliation";
import { schedulerLockKey } from "../jobs/scheduling";
import { assertPathParentInside } from "./filesystemSafety";
import { inspectMountIdentity, persistentRootIdentityMatch } from "./mountIdentity";
import type {
  JobEventRecord,
  ManagedPathRoot,
  PathConfigurationState,
  PathMigrationIssue,
  PathMigrationRecord,
  PathMigrationStatus,
  PathMigrationSummary,
  PathMountIdentity,
  PathRootChange,
  PathRootIdentity,
  PathsSettings
} from "../../shared/types";

const pathConfigurationLockKey = 781_889_433;
const rootInspectionTimeoutMs = 5_000;
const filesystemReadTimeoutMs = 15_000;
const blockingMigrationStatuses: PathMigrationStatus[] = ["pending", "planning", "planned", "queued", "running", "rollback_pending", "failed"];
const emptyPaths: PathsSettings = { symlinkDir: "", localDir: "", remoteDir: "" };

type PathConfigurationRow = typeof schema.pathConfigurations.$inferSelect;
type PathMigrationRow = typeof schema.pathMigrations.$inferSelect;

export interface PathMigrationRunContext {
  jobId?: number;
  signal: AbortSignal;
  event(level: JobEventRecord["level"], message: string, data?: unknown): Promise<void>;
  setProgress(progress: unknown): Promise<void>;
  isCancelled(): Promise<boolean>;
  assertLease(): Promise<void>;
  withLease<T>(action: () => Promise<T>): Promise<T>;
  withLeaseDb<T>(action: (db: DbExecutor) => Promise<T>): Promise<T>;
  finishCompleted(action: (db: DbExecutor) => Promise<void>): Promise<boolean>;
}

export interface ReconcileEnvironmentPathsOptions {
  allowDirectAdoptionBeforeInventory?: boolean;
}

function errorMessage(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause;
  return cause instanceof Error && cause.message ? `${error.message}: ${cause.message}` : error.message;
}

class PathMigrationLeaseLostError extends Error {
  constructor(error: unknown) {
    super(errorMessage(error), { cause: error });
    this.name = "PathMigrationLeaseLostError";
  }
}

class PathMigrationRootIdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PathMigrationRootIdentityError";
  }
}

async function assertMigrationLease(ctx: PathMigrationRunContext): Promise<void> {
  try {
    await ctx.assertLease();
  } catch (error: unknown) {
    throw new PathMigrationLeaseLostError(error);
  }
}

async function withMigrationLease<T>(ctx: PathMigrationRunContext, action: () => Promise<T>, allowAborted = false): Promise<T> {
  try {
    return await ctx.withLease(async () => {
      if (!allowAborted && ctx.signal.aborted) {
        throw (ctx.signal.reason instanceof Error ? ctx.signal.reason : new Error("Path migration was terminated"));
      }
      return action();
    });
  } catch (error: unknown) {
    if (error instanceof Error && error.name === "LeaseLostError") throw new PathMigrationLeaseLostError(error);
    throw error;
  }
}

async function withMigrationLeaseDb<T>(
  ctx: PathMigrationRunContext,
  action: (db: DbExecutor) => Promise<T>,
  allowAborted = false
): Promise<T> {
  try {
    return await ctx.withLeaseDb(async (leaseDb) => {
      if (!allowAborted && ctx.signal.aborted) {
        throw (ctx.signal.reason instanceof Error ? ctx.signal.reason : new Error("Path migration was terminated"));
      }
      return action(leaseDb);
    });
  } catch (error: unknown) {
    if (error instanceof Error && error.name === "LeaseLostError") throw new PathMigrationLeaseLostError(error);
    throw error;
  }
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
      const leftPath = path.resolve(configured[left][1]);
      const rightPath = path.resolve(configured[right][1]);
      const leftRelative = path.relative(leftPath, rightPath);
      const rightRelative = path.relative(rightPath, leftPath);
      const overlaps =
        leftRelative === "" ||
        (!leftRelative.startsWith("..") && !path.isAbsolute(leftRelative)) ||
        (!rightRelative.startsWith("..") && !path.isAbsolute(rightRelative));
      if (overlaps) {
        errors.push(`${configured[left][0]} and ${configured[right][0]} cannot use the same or overlapping path.`);
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
    let mount: PathMountIdentity | null = null;
    if (value.mount != null) {
      if (
        typeof value.mount !== "object" ||
        typeof value.mount.mountPoint !== "string" ||
        typeof value.mount.root !== "string" ||
        typeof value.mount.filesystemType !== "string" ||
        typeof value.mount.source !== "string"
      ) {
        return null;
      }
      mount = {
        mountPoint: value.mount.mountPoint,
        root: value.mount.root,
        filesystemType: value.mount.filesystemType,
        source: value.mount.source
      };
    }
    return {
      available: value.available,
      realPath: typeof value.realPath === "string" ? value.realPath : null,
      device: typeof value.device === "string" ? value.device : null,
      inode: typeof value.inode === "string" ? value.inode : null,
      mount,
      error: typeof value.error === "string" ? value.error : null
    };
  } catch {
    return null;
  }
}

async function inspectRoot(root: string): Promise<PathRootIdentity> {
  if (!root) return { available: false, realPath: null, device: null, inode: null, mount: null, error: "Path is not configured" };
  try {
    return await withTimeout(
      (async (): Promise<PathRootIdentity> => {
        const realPath = await fs.realpath(root);
        const stat = await fs.stat(realPath, { bigint: true });
        const verifiedRealPath = await fs.realpath(root);
        if (verifiedRealPath !== realPath) {
          return { available: false, realPath: verifiedRealPath, device: null, inode: null, mount: null, error: "Path changed during inspection" };
        }
        if (!stat.isDirectory()) {
          return { available: false, realPath, device: String(stat.dev), inode: String(stat.ino), mount: null, error: "Path is not a directory" };
        }
        const mount = await inspectMountIdentity(realPath);
        return { available: true, realPath, device: String(stat.dev), inode: String(stat.ino), mount, error: null };
      })(),
      `Inspection of ${root}`,
      rootInspectionTimeoutMs
    );
  } catch (error: unknown) {
    return { available: false, realPath: null, device: null, inode: null, mount: null, error: errorMessage(error) };
  }
}

async function inspectPaths(paths: PathsSettings): Promise<{ symlink: PathRootIdentity; local: PathRootIdentity; remote: PathRootIdentity }> {
  const [symlink, local, remote] = await Promise.all([inspectRoot(paths.symlinkDir), inspectRoot(paths.localDir), inspectRoot(paths.remoteDir)]);
  return { symlink, local, remote };
}

type InspectedPaths = Awaited<ReturnType<typeof inspectPaths>>;

interface PathMigrationTargetIdentity {
  dev: string;
  ino: string;
  size: string;
  mtimeNs: string;
  ctimeNs: string;
}

function serializeTargetIdentity(identity: PathMigrationTargetIdentity): string {
  return JSON.stringify(identity);
}

function parseTargetIdentity(rawIdentity: string | null): PathMigrationTargetIdentity {
  if (!rawIdentity) {
    throw new Error("Mapped target has no exact file identity; analyze the path migration again before applying it");
  }
  let value: unknown;
  try {
    value = JSON.parse(rawIdentity);
  } catch (error: unknown) {
    throw new Error("Mapped target has an invalid exact file identity; analyze the path migration again", { cause: error });
  }
  if (!value || typeof value !== "object") {
    throw new Error("Mapped target has an invalid exact file identity; analyze the path migration again");
  }
  const identity = value as Partial<PathMigrationTargetIdentity>;
  const keys: Array<keyof PathMigrationTargetIdentity> = ["dev", "ino", "size", "mtimeNs", "ctimeNs"];
  if (!keys.every((key) => typeof identity[key] === "string" && /^\d+$/.test(identity[key]))) {
    throw new Error("Mapped target has an invalid exact file identity; analyze the path migration again");
  }
  return {
    dev: identity.dev!,
    ino: identity.ino!,
    size: identity.size!,
    mtimeNs: identity.mtimeNs!,
    ctimeNs: identity.ctimeNs!
  };
}

function targetIdentitiesMatch(left: PathMigrationTargetIdentity, right: PathMigrationTargetIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

async function readTargetIdentity(targetPath: string): Promise<PathMigrationTargetIdentity> {
  const stat = await withTimeout(fs.stat(targetPath, { bigint: true }), `Reading mapped target ${targetPath}`, filesystemReadTimeoutMs);
  if (!stat.isFile()) throw new Error(`Mapped target is not a regular file: ${targetPath}`);
  return {
    dev: stat.dev.toString(),
    ino: stat.ino.toString(),
    size: stat.size.toString(),
    mtimeNs: stat.mtimeNs.toString(),
    ctimeNs: stat.ctimeNs.toString()
  };
}

function physicalPathOverlap(left: string, right: string): boolean {
  const leftRelative = path.relative(path.resolve(left), path.resolve(right));
  const rightRelative = path.relative(path.resolve(right), path.resolve(left));
  return (
    leftRelative === "" ||
    (!leftRelative.startsWith("..") && !path.isAbsolute(leftRelative)) ||
    (!rightRelative.startsWith("..") && !path.isAbsolute(rightRelative))
  );
}

function inspectedPathErrors(identities: InspectedPaths): string[] {
  const roots: Array<[string, PathRootIdentity]> = [
    ["Symlink directory", identities.symlink],
    ["Local directory", identities.local],
    ["Remote directory", identities.remote]
  ];
  const errors = roots
    .filter(([, identity]) => !identity.available)
    .map(([label, identity]) => `${label} is unavailable${identity.error ? `: ${identity.error}` : "."}`);

  for (let left = 0; left < roots.length; left += 1) {
    for (let right = left + 1; right < roots.length; right += 1) {
      const leftIdentity = roots[left][1];
      const rightIdentity = roots[right][1];
      if (!leftIdentity.available || !rightIdentity.available) continue;
      const sameIdentity =
        Boolean(leftIdentity.device && leftIdentity.inode) &&
        leftIdentity.device === rightIdentity.device &&
        leftIdentity.inode === rightIdentity.inode;
      const overlappingRealPaths = Boolean(
        leftIdentity.realPath && rightIdentity.realPath && physicalPathOverlap(leftIdentity.realPath, rightIdentity.realPath)
      );
      if (sameIdentity || overlappingRealPaths) {
        errors.push(`${roots[left][0]} and ${roots[right][0]} resolve to the same or overlapping physical path.`);
      }
    }
  }
  return errors;
}

function strictRootIdentityMatch(expected: PathRootIdentity | null, actual: PathRootIdentity): boolean {
  if (!expected || !persistentRootIdentityMatch(expected, actual)) return false;
  if (expected.device && expected.inode && actual.device && actual.inode) {
    return expected.device === actual.device && expected.inode === actual.inode;
  }
  return true;
}

function configurationPersistentIdentityMatch(configuration: PathConfigurationRow, identities: InspectedPaths): boolean {
  const expected = configurationIdentities(configuration);
  return (
    persistentRootIdentityMatch(expected.symlink, identities.symlink) &&
    persistentRootIdentityMatch(expected.local, identities.local) &&
    persistentRootIdentityMatch(expected.remote, identities.remote)
  );
}

function configurationStrictIdentityMatch(configuration: PathConfigurationRow, identities: InspectedPaths): boolean {
  const expected = configurationIdentities(configuration);
  return (
    strictRootIdentityMatch(expected.symlink, identities.symlink) &&
    strictRootIdentityMatch(expected.local, identities.local) &&
    strictRootIdentityMatch(expected.remote, identities.remote)
  );
}

async function assertConfigurationRootIdentity(configuration: PathConfigurationRow, phase: string): Promise<void> {
  const paths = pathsFromConfiguration(configuration);
  const lexicalErrors = validateManagedPaths(paths);
  const identities = await inspectPaths(paths);
  const errors = [...lexicalErrors, ...(lexicalErrors.length === 0 ? inspectedPathErrors(identities) : [])];
  if (errors.length > 0) {
    throw new PathMigrationRootIdentityError(`${phase}: ${errors.join(" ")}`);
  }
  if (!configurationStrictIdentityMatch(configuration, identities)) {
    throw new PathMigrationRootIdentityError(
      `${phase}: a managed storage root no longer matches the physical directory recorded during migration analysis. Analyze the path change again before continuing.`
    );
  }
}

function identityMatch(active: PathRootIdentity | null, detected: PathRootIdentity | null): PathRootChange["identityMatch"] {
  if (!active?.available || !detected?.available) return "unknown";
  return persistentRootIdentityMatch(active, detected) ? "same" : "different";
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

async function cancelPathMigrations(db: DbExecutor, migrations: PathMigrationRow[], message: string): Promise<void> {
  for (const migration of migrations) {
    const timestamp = nowIso();
    let job = migration.jobId == null
      ? null
      : await first(db.select().from(schema.jobs).where(eq(schema.jobs.id, migration.jobId)).for("update").limit(1));
    const needsRollback =
      migration.status === "running" ||
      migration.status === "rollback_pending" ||
      (migration.status === "failed" && migration.startedAt != null);

    if (needsRollback) {
      if (migration.status === "rollback_pending" && job && (job.status === "queued" || job.status === "running")) continue;
      if (!job) {
        job = await first(
          db
            .insert(schema.jobs)
            .values({
              type: "path_migration",
              status: "queued",
              createdAt: timestamp,
              startedAt: null,
              finishedAt: null,
              lockedBy: null,
              lockedAt: null,
              heartbeatAt: null,
              leaseVersion: 0,
              exclusive: true,
              cancelRequestedAt: null,
              progress: JSON.stringify({ migrationId: migration.id, stage: "rollback_pending", current: 0, total: 0, message: "Path migration rollback queued" })
            })
            .returning()
        );
      } else {
        job = await first(
          db
            .update(schema.jobs)
            .set({
              status: "queued",
              finishedAt: null,
              lockedBy: null,
              lockedAt: null,
              heartbeatAt: null,
              leaseVersion: sql`${schema.jobs.leaseVersion} + 1`,
              cancelRequestedAt: null,
              progress: JSON.stringify({ migrationId: migration.id, stage: "rollback_pending", current: 0, total: 0, message: "Path migration rollback queued" })
            })
            .where(eq(schema.jobs.id, job.id))
            .returning()
        );
      }
      if (!job) throw new Error(`Could not queue rollback recovery for path migration #${migration.id}`);
      await db
        .update(schema.pathMigrations)
        .set({ status: "rollback_pending", jobId: job.id, finishedAt: null, errorMessage: message })
        .where(eq(schema.pathMigrations.id, migration.id));
      await db.update(schema.pathConfigurations).set({ status: "pending" }).where(eq(schema.pathConfigurations.id, migration.targetConfigId));
      await db.insert(schema.jobEvents).values({
        jobId: job.id,
        timestamp,
        level: "warn",
        message: "Path migration rollback queued after environment paths changed",
        data: JSON.stringify({ migrationId: migration.id, reason: message })
      });
      continue;
    }

    await db
      .update(schema.pathMigrations)
      .set({ status: "cancelled", finishedAt: timestamp, errorMessage: message })
      .where(eq(schema.pathMigrations.id, migration.id));
    await db.update(schema.pathConfigurations).set({ status: "cancelled" }).where(eq(schema.pathConfigurations.id, migration.targetConfigId));
    if (job?.status === "queued") {
      await db
        .update(schema.jobs)
        .set({ status: "cancelled", finishedAt: timestamp, cancelRequestedAt: timestamp })
        .where(and(eq(schema.jobs.id, job.id), eq(schema.jobs.status, "queued")));
      await db.insert(schema.jobEvents).values({
        jobId: job.id,
        timestamp,
        level: "warn",
        message: "Queued path migration cancelled after environment paths changed",
        data: JSON.stringify({ migrationId: migration.id, reason: message })
      });
    }
  }
}

async function legacyJournalPathExists(filePath: string | null): Promise<boolean> {
  if (!filePath) return false;
  try {
    await fs.lstat(filePath);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return false;
    return true;
  }
}

async function markUncertainLegacyFailedCopyOperations(db: DbExecutor): Promise<void> {
  const legacyOperations = (
    await db
      .select()
      .from(schema.copyOperations)
      .where(and(eq(schema.copyOperations.stage, "failed"), isNull(schema.copyOperations.reconciliationResolvedAt)))
  ).filter(
    (operation) =>
      operation.tempIdentity == null &&
      operation.destinationIdentity == null &&
      operation.displacedIdentity == null
  );

  for (const operation of legacyOperations) {
    const reasons: string[] = [];
    try {
      const target = await symlinkTarget(operation.linkPath);
      if (path.resolve(target) !== path.resolve(operation.originalTargetPath)) {
        reasons.push("the library symlink no longer points to its original target");
      }
    } catch (error: unknown) {
      reasons.push(`the library symlink cannot be verified: ${errorMessage(error)}`);
    }
    if (await legacyJournalPathExists(operation.tempPath)) reasons.push("a journaled temporary copy still exists");
    if (await legacyJournalPathExists(operation.displacedPath)) reasons.push("a journaled displaced destination still exists");
    if (await legacyJournalPathExists(operation.destinationPath)) {
      reasons.push("the journaled destination exists but its ownership cannot be proven");
    }
    if (reasons.length === 0) continue;

    await db
      .update(schema.copyOperations)
      .set({
        stage: "reconciliation_required",
        errorMessage: `Legacy copy operation requires manual reconciliation because ${reasons.join(" and ")}`,
        updatedAt: nowIso(),
        completedAt: null
      })
      .where(and(eq(schema.copyOperations.id, operation.id), eq(schema.copyOperations.stage, "failed")));
  }
}

export async function reconcileEnvironmentPaths(
  db: Db,
  environmentPaths: PathsSettings,
  options: ReconcileEnvironmentPathsOptions = {}
): Promise<void> {
  const detectedPaths = normalizeManagedPaths(environmentPaths);
  const lexicalEnvironmentErrors = validateManagedPaths(detectedPaths);

  await db.transaction(async (transaction) => {
    await transaction.execute(sql`select pg_advisory_xact_lock(${schedulerLockKey})`);
    await transaction.execute(sql`select pg_advisory_xact_lock(${pathConfigurationLockKey})`);
    await markUncertainLegacyFailedCopyOperations(transaction);
    const detectedIdentities = await inspectPaths(detectedPaths);
    const environmentErrors = [
      ...lexicalEnvironmentErrors,
      ...(lexicalEnvironmentErrors.length === 0 ? inspectedPathErrors(detectedIdentities) : [])
    ];
    await transaction
      .select({ id: schema.jobs.id })
      .from(schema.jobs)
      .where(eq(schema.jobs.status, "running"))
      .orderBy(asc(schema.jobs.id))
      .for("update");
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
      let initialPaths: PathsSettings | null = null;
      let identities: InspectedPaths | null = null;
      if (validateManagedPaths(legacyPaths).length === 0) {
        const legacyIdentities = await inspectPaths(legacyPaths);
        if (inspectedPathErrors(legacyIdentities).length === 0) {
          initialPaths = legacyPaths;
          identities = legacyIdentities;
        }
      }
      if (!initialPaths && environmentErrors.length === 0) {
        initialPaths = detectedPaths;
        identities = detectedIdentities;
      }
      if (initialPaths && identities) {
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

    if (
      active &&
      environmentErrors.length === 0 &&
      pathsEqual(pathsFromConfiguration(active), detectedPaths) &&
      configurationPersistentIdentityMatch(active, detectedIdentities)
    ) {
      const timestamp = nowIso();
      const blocking = await transaction.select().from(schema.pathMigrations).where(inArray(schema.pathMigrations.status, blockingMigrationStatuses));
      if (blocking.length > 0) {
        await cancelPathMigrations(transaction, blocking, "Configured paths and storage mounts match the active configuration.");
      }
      await transaction
        .update(schema.pathConfigurations)
        .set({
          symlinkIdentity: JSON.stringify(detectedIdentities.symlink),
          localIdentity: JSON.stringify(detectedIdentities.local),
          remoteIdentity: JSON.stringify(detectedIdentities.remote)
        })
        .where(eq(schema.pathConfigurations.id, active.id));
      await transaction
        .insert(schema.appSettings)
        .values({ key: "paths", value: JSON.stringify(detectedPaths), updatedAt: timestamp })
        .onConflictDoUpdate({ target: schema.appSettings.key, set: { value: JSON.stringify(detectedPaths), updatedAt: timestamp } });
      return;
    }

    if (active && environmentErrors.length === 0 && options.allowDirectAdoptionBeforeInventory) {
      const timestamp = nowIso();
      const blocking = await transaction.select().from(schema.pathMigrations).where(inArray(schema.pathMigrations.status, blockingMigrationStatuses));
      if (blocking.length > 0) {
        await cancelPathMigrations(transaction, blocking, "Storage paths were corrected before the initial inventory scan.");
      }
      await transaction
        .update(schema.pathConfigurations)
        .set({
          symlinkDir: detectedPaths.symlinkDir,
          localDir: detectedPaths.localDir,
          remoteDir: detectedPaths.remoteDir,
          symlinkIdentity: JSON.stringify(detectedIdentities.symlink),
          localIdentity: JSON.stringify(detectedIdentities.local),
          remoteIdentity: JSON.stringify(detectedIdentities.remote),
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
      if (
        target &&
        pathsEqual(pathsFromConfiguration(target), detectedPaths) &&
        configurationPersistentIdentityMatch(target, detectedIdentities)
      ) return;
      await cancelPathMigrations(transaction, [existing], "A newer environment path change replaced this migration.");
    }

    const target = await first(
      transaction
        .insert(schema.pathConfigurations)
        .values({
          status: "pending",
          symlinkDir: detectedPaths.symlinkDir,
          localDir: detectedPaths.localDir,
          remoteDir: detectedPaths.remoteDir,
          symlinkIdentity: JSON.stringify(detectedIdentities.symlink),
          localIdentity: JSON.stringify(detectedIdentities.local),
          remoteIdentity: JSON.stringify(detectedIdentities.remote),
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

export async function isPathConfigurationBlocked(db: DbExecutor): Promise<boolean> {
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
  const rootIdentityMatch = identityMatch(activeIdentity, detectedIdentity);
  return {
    root,
    label,
    activePath,
    detectedPath,
    changed: activePath !== detectedPath || rootIdentityMatch !== "same",
    identityMatch: rootIdentityMatch,
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
  if (migration.status === "queued" || migration.status === "running" || migration.status === "rollback_pending") return "migrating";
  if (migration.status === "failed") return "failed";
  return "change_pending";
}

export async function getPathConfigurationState(db: Db, environmentPaths: PathsSettings): Promise<PathConfigurationState> {
  const detectedPaths = normalizeManagedPaths(environmentPaths);
  const lexicalEnvironmentErrors = validateManagedPaths(detectedPaths);
  const detectedIdentities = await inspectPaths(detectedPaths);
  const environmentErrors = [
    ...lexicalEnvironmentErrors,
    ...(lexicalEnvironmentErrors.length === 0 ? inspectedPathErrors(detectedIdentities) : [])
  ];
  const active =
    (await first(db.select().from(schema.pathConfigurations).where(eq(schema.pathConfigurations.status, "active")).limit(1))) ?? null;
  const migration = await latestBlockingMigration(db);
  const target = migration
    ? ((await first(db.select().from(schema.pathConfigurations).where(eq(schema.pathConfigurations.id, migration.targetConfigId)).limit(1))) ?? null)
    : null;
  const activePaths = active ? pathsFromConfiguration(active) : null;
  const targetPaths = target ? pathsFromConfiguration(target) : detectedPaths;
  const activeIdentities = configurationIdentities(active);
  const targetIdentities = target
    ? configurationIdentities(target)
    : migration
      ? configurationIdentities(null)
      : detectedIdentities;
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
      targetIdentity: null,
      validationStatus: "blocked",
      message: `Symlink could not be validated at the detected path: ${errorMessage(error)}`,
      appliedAt: null,
      rolledBackAt: null
    };
  }

  const desiredTarget = targetPathForConfiguration(baselineTarget, source, target);
  const targetChanged = path.resolve(actualTarget) !== path.resolve(desiredTarget);
  if (!linkPathChanged && !targetChanged) return null;

  let expectedSizeBytes = link.sizeBytes;
  if (targetChanged) {
    const oldTargetStat = await withTimeout(fs.stat(baselineTarget), `Reading source target ${baselineTarget}`, filesystemReadTimeoutMs).catch(() => null);
    if (oldTargetStat?.isFile()) expectedSizeBytes = Number(oldTargetStat.size);
  }

  let targetIdentity: PathMigrationTargetIdentity;
  try {
    targetIdentity = await readTargetIdentity(desiredTarget);
    const destinationSize = Number(targetIdentity.size);
    if (expectedSizeBytes != null && destinationSize !== expectedSizeBytes) {
      throw new Error(`Mapped target size differs from the indexed file (${destinationSize} bytes instead of ${expectedSizeBytes} bytes)`);
    }
    expectedSizeBytes = destinationSize;
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
      targetIdentity: null,
      validationStatus: "blocked",
      message: `Mapped target could not be validated: ${errorMessage(error)}`,
      appliedAt: null,
      rolledBackAt: null
    };
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
    targetIdentity: serializeTargetIdentity(targetIdentity),
    validationStatus: "ready",
    message: targetChanged ? "Mapped target exists and passed exact identity validation." : "Symlink path and mapped target passed exact identity validation.",
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

async function assertCopyOperationsReconciledForPathMigration(db: DbExecutor): Promise<void> {
  const reconciliationOperation = await first(
    db
      .select({ id: schema.copyOperations.id })
      .from(schema.copyOperations)
      .where(unresolvedCopyReconciliation())
      .limit(1)
  );
  if (reconciliationOperation) {
    throw new Error(
      `Copy operation #${reconciliationOperation.id} requires manual reconciliation before managed paths can be migrated`
    );
  }

  const incompleteOperation = await first(
    db
      .select({ id: schema.copyOperations.id, jobId: schema.copyOperations.jobId })
      .from(schema.copyOperations)
      .where(notInArray(schema.copyOperations.stage, ["committed", "rolled_back", "failed"]))
      .limit(1)
  );
  if (incompleteOperation) {
    throw new Error(
      `Copy operation #${incompleteOperation.id} from job #${incompleteOperation.jobId} has unresolved filesystem changes; recover or manually reconcile it before managed paths can be migrated`
    );
  }

  const activeCopyOperation = await first(
    db
      .select({ jobId: schema.jobs.id })
      .from(schema.copyOperations)
      .innerJoin(schema.jobs, eq(schema.jobs.id, schema.copyOperations.jobId))
      .where(
        and(
          eq(schema.jobs.type, "copy"),
          inArray(schema.jobs.status, ["queued", "running"]),
          notInArray(schema.copyOperations.stage, ["rolled_back", "failed"])
        )
      )
      .limit(1)
  );
  if (activeCopyOperation) {
    throw new Error(
      `Copy job #${activeCopyOperation.jobId} is still reconciling filesystem changes; wait for recovery before analyzing or applying the path migration`
    );
  }
}

export async function planPathMigration(db: Db, migrationId: number): Promise<void> {
  const { migration, source, target } = await migrationContext(db, migrationId);
  if (!["pending", "planned", "failed"].includes(migration.status)) throw new Error("Path migration cannot be analyzed in its current state");
  const targetPaths = pathsFromConfiguration(target);
  const environmentErrors = validateManagedPaths(targetPaths);
  if (environmentErrors.length > 0) throw new Error(environmentErrors.join(" "));

  await db.transaction(async (transaction) => {
    await transaction.execute(sql`select pg_advisory_xact_lock(${schedulerLockKey})`);
    const currentMigration = await first(
      transaction.select().from(schema.pathMigrations).where(eq(schema.pathMigrations.id, migrationId)).for("update").limit(1)
    );
    if (!currentMigration || !["pending", "planned", "failed"].includes(currentMigration.status)) {
      throw new Error("Path migration analysis is already running or the detected path change was replaced");
    }
    const otherBlockingMigration = await first(
      transaction
        .select({ id: schema.pathMigrations.id })
        .from(schema.pathMigrations)
        .where(and(ne(schema.pathMigrations.id, migrationId), inArray(schema.pathMigrations.status, blockingMigrationStatuses)))
        .limit(1)
    );
    if (otherBlockingMigration) {
      throw new Error(
        `Path migration #${otherBlockingMigration.id} is still being reconciled; wait for it to finish before analyzing this path change`
      );
    }
    const activePathJob = await first(
      transaction
        .select({ id: schema.jobs.id })
        .from(schema.jobs)
        .where(and(eq(schema.jobs.type, "path_migration"), inArray(schema.jobs.status, ["queued", "running"])))
        .limit(1)
    );
    if (activePathJob) {
      throw new Error(
        `Path migration job #${activePathJob.id} is still active; wait for it to finish before analyzing this path change`
      );
    }
    await assertCopyOperationsReconciledForPathMigration(transaction);
    const runningJob = await first(transaction.select({ id: schema.jobs.id }).from(schema.jobs).where(eq(schema.jobs.status, "running")).limit(1));
    if (runningJob) throw new Error("Another job is still stopping for the path change; wait for it to pause before analyzing migration");
    if (currentMigration.status === "failed" && currentMigration.startedAt != null) {
      const unresolvedItem = await first(
        transaction
          .select({ id: schema.pathMigrationItems.id })
          .from(schema.pathMigrationItems)
          .where(
            and(
              eq(schema.pathMigrationItems.migrationId, migrationId),
              ne(schema.pathMigrationItems.validationStatus, "rolled_back")
            )
          )
          .limit(1)
      );
      if (unresolvedItem) {
        throw new Error(
          "Path migration cannot be analyzed again until every previously applied symlink is rolled back or manually reconciled"
        );
      }
    }
    const claimed = await first(
      transaction
        .update(schema.pathMigrations)
        .set({ status: "planning", errorMessage: null, plannedAt: null, finishedAt: null })
        .where(and(eq(schema.pathMigrations.id, migrationId), inArray(schema.pathMigrations.status, ["pending", "planned", "failed"])))
        .returning({ id: schema.pathMigrations.id })
    );
    if (!claimed) throw new Error("Path migration analysis is already running or the detected path change was replaced");
    await transaction.delete(schema.pathMigrationItems).where(eq(schema.pathMigrationItems.migrationId, migrationId));
  });
  try {
    const identities = await inspectPaths(targetPaths);
    await db
      .update(schema.pathConfigurations)
      .set({ symlinkIdentity: JSON.stringify(identities.symlink), localIdentity: JSON.stringify(identities.local), remoteIdentity: JSON.stringify(identities.remote) })
      .where(eq(schema.pathConfigurations.id, target.id));
    const rootErrors = inspectedPathErrors(identities);
    if (rootErrors.length > 0) throw new Error(rootErrors.join(" "));
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

async function replaceSymlink(
  linkRoot: string,
  linkPath: string,
  expectedTargetPath: string,
  targetPath: string,
  ctx: PathMigrationRunContext,
  allowAborted = false,
  assertRootIdentity?: () => Promise<void>
): Promise<void> {
  await assertPathParentInside(linkRoot, linkPath, "Path migration symlink");
  const tempPath = `${linkPath}.srtl-path-migration-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  try {
    await fs.symlink(targetPath, tempPath);
    const installedTarget = await symlinkTarget(tempPath);
    if (path.resolve(installedTarget) !== path.resolve(targetPath)) throw new Error("Temporary symlink target validation failed");
    await assertPathParentInside(linkRoot, linkPath, "Path migration symlink");
    await withMigrationLease(
      ctx,
      async () => {
        await assertRootIdentity?.();
        const currentTarget = await symlinkTarget(linkPath);
        if (path.resolve(currentTarget) !== path.resolve(expectedTargetPath)) {
          throw new Error(`Symlink changed while path migration waited for its lease: ${linkPath}`);
        }
        await fs.rename(tempPath, linkPath);
      },
      allowAborted
    );
  } catch (error: unknown) {
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function rollbackMigrationItems(
  db: Db,
  migrationId: number,
  linkRoot: string,
  ctx: PathMigrationRunContext,
  eligibleStatuses: string[] = ["ready", "applied"],
  assertRootIdentity?: () => Promise<void>
): Promise<string[]> {
  const errors: string[] = [];
  const items = await db
    .select()
    .from(schema.pathMigrationItems)
    .where(and(eq(schema.pathMigrationItems.migrationId, migrationId), inArray(schema.pathMigrationItems.validationStatus, eligibleStatuses)))
    .orderBy(desc(schema.pathMigrationItems.id));
  for (const item of items) {
    try {
      if (!item.targetChanged) {
        await withMigrationLeaseDb(
          ctx,
          async (leaseDb) => {
            await leaseDb
              .update(schema.pathMigrationItems)
              .set({ validationStatus: "rolled_back", rolledBackAt: nowIso(), message: "Migration step remained at its original target." })
              .where(and(eq(schema.pathMigrationItems.id, item.id), inArray(schema.pathMigrationItems.validationStatus, eligibleStatuses)));
          },
          true
        );
        continue;
      }
      const currentTarget = await symlinkTarget(item.currentLinkPath);
      const resolvedCurrentTarget = path.resolve(currentTarget);
      if (resolvedCurrentTarget === path.resolve(item.targetPathAfter)) {
        await replaceSymlink(linkRoot, item.currentLinkPath, item.targetPathAfter, item.targetPathBefore, ctx, true, assertRootIdentity);
      } else if (resolvedCurrentTarget !== path.resolve(item.targetPathBefore)) {
        const message = `Rollback stopped because the symlink target changed again. Expected either ${item.targetPathBefore} or ${item.targetPathAfter}, found ${currentTarget}. Manual review is required.`;
        await withMigrationLeaseDb(
          ctx,
          async (leaseDb) => {
            await leaseDb
              .update(schema.pathMigrationItems)
              .set({ validationStatus: "blocked", rolledBackAt: null, message })
              .where(and(eq(schema.pathMigrationItems.id, item.id), inArray(schema.pathMigrationItems.validationStatus, eligibleStatuses)));
          },
          true
        );
        throw new Error(message);
      }
      await withMigrationLeaseDb(
        ctx,
        async (leaseDb) => {
          await leaseDb
            .update(schema.pathMigrationItems)
            .set({ validationStatus: "rolled_back", rolledBackAt: nowIso(), message: "Repointing was rolled back after migration stopped." })
            .where(and(eq(schema.pathMigrationItems.id, item.id), inArray(schema.pathMigrationItems.validationStatus, eligibleStatuses)));
        },
        true
      );
    } catch (error: unknown) {
      if (error instanceof PathMigrationLeaseLostError) throw error;
      const message = `${item.currentLinkPath}: ${errorMessage(error)}`;
      errors.push(message);
      await ctx.event("error", "Path migration rollback failed", { linkPath: item.currentLinkPath, error: errorMessage(error) });
    }
  }
  return errors;
}

async function cancelQueuedJobsForMigration(db: DbExecutor, migrationJobId: number): Promise<number> {
  await assertCopyOperationsReconciledForPathMigration(db);
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

async function rebaseStorageInventory(db: Pick<DbExecutor, "execute">, rootType: "local" | "remote", oldRoot: string, newRoot: string): Promise<void> {
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

async function rebaseMissingMediaLinks(db: Pick<DbExecutor, "execute">, column: "link_path" | "target_path", oldRoot: string, newRoot: string): Promise<void> {
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
  const assertTargetRootIdentity = () =>
    assertConfigurationRootIdentity(target, "Managed storage root validation failed");
  if (migration.status === "completed") {
    const itemCount = await first(
      db.select({ value: count() }).from(schema.pathMigrationItems).where(eq(schema.pathMigrationItems.migrationId, migrationId))
    );
    const total = Number(itemCount?.value ?? 0);
    await ctx.setProgress({ migrationId, stage: "completed", current: total, total, message: "Path migration completed" });
    await ctx.event("info", "Recovered completed managed path migration", { migrationId, total });
    return;
  }
  try {
    await assertMigrationLease(ctx);
    await assertTargetRootIdentity();
    await assertMigrationLease(ctx);
  } catch (error: unknown) {
    if (!(error instanceof PathMigrationRootIdentityError)) throw error;
    await withMigrationLeaseDb(
      ctx,
      async (leaseDb) => {
        const timestamp = nowIso();
        if (migration.status === "rollback_pending") {
          await leaseDb
            .update(schema.pathMigrations)
            .set({ errorMessage: `${error.message} Automatic rollback was not attempted because the recorded target root is no longer trustworthy.` })
            .where(and(eq(schema.pathMigrations.id, migrationId), eq(schema.pathMigrations.status, "rollback_pending")));
        } else {
          await leaseDb
            .update(schema.pathMigrations)
            .set({ status: "failed", errorMessage: error.message, finishedAt: timestamp })
            .where(and(eq(schema.pathMigrations.id, migrationId), inArray(schema.pathMigrations.status, ["queued", "running"])));
        }
      },
      true
    );
    throw error;
  }
  if (migration.status === "rollback_pending") {
    const totalRow = await first(
      db.select({ value: count() }).from(schema.pathMigrationItems).where(eq(schema.pathMigrationItems.migrationId, migrationId))
    );
    const total = Number(totalRow?.value ?? 0);
    await ctx.event("warn", "Recovering interrupted path migration rollback", { migrationId, total });
    await ctx.setProgress({ migrationId, stage: "rollback_pending", current: 0, total, message: "Restoring symlinks to the active paths" });
    const rollbackErrors = await rollbackMigrationItems(
      db,
      migrationId,
      target.symlinkDir,
      ctx,
      ["ready", "applied", "rolled_back", "blocked"],
      assertTargetRootIdentity
    );
    if (rollbackErrors.length > 0) {
      const message = `Path migration rollback requires manual reconciliation for ${rollbackErrors.length} symlink(s).`;
      await withMigrationLeaseDb(
        ctx,
        async (leaseDb) => {
          await leaseDb.update(schema.pathMigrations).set({ errorMessage: message }).where(eq(schema.pathMigrations.id, migrationId));
        },
        true
      );
      throw new Error(message);
    }
    const migrationJobId = ctx.jobId ?? migration.jobId;
    if (migrationJobId == null) throw new Error("Rollback-pending path migration is not linked to a worker job");
    await withMigrationLeaseDb(
      ctx,
      async (leaseDb) => {
        const remaining = await first(
          leaseDb
            .select({ value: count() })
            .from(schema.pathMigrationItems)
            .where(and(eq(schema.pathMigrationItems.migrationId, migrationId), ne(schema.pathMigrationItems.validationStatus, "rolled_back")))
        );
        if (Number(remaining?.value ?? 0) > 0) throw new Error("Path migration rollback did not reconcile every item");
        const timestamp = nowIso();
        const cancelled = await first(
          leaseDb
            .update(schema.pathMigrations)
            .set({ status: "cancelled", finishedAt: timestamp })
            .where(and(eq(schema.pathMigrations.id, migrationId), eq(schema.pathMigrations.status, "rollback_pending")))
            .returning({ id: schema.pathMigrations.id })
        );
        if (!cancelled) throw new Error("Path migration rollback state changed before recovery completed");
        await leaseDb.update(schema.pathConfigurations).set({ status: "cancelled" }).where(eq(schema.pathConfigurations.id, migration.targetConfigId));
        await leaseDb
          .update(schema.jobs)
          .set({
            cancelRequestedAt: timestamp,
            progress: JSON.stringify({ migrationId, stage: "cancelled", current: total, total, message: "Path migration rollback completed" })
          })
          .where(eq(schema.jobs.id, migrationJobId));
        await leaseDb.insert(schema.jobEvents).values({
          jobId: migrationJobId,
          timestamp,
          level: "warn",
          message: "Path migration rollback completed",
          data: JSON.stringify({ migrationId, total })
        });
      },
      true
    );
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

  const cancelledJobs = await withMigrationLeaseDb(ctx, async (leaseDb) => {
    const runningJobs = await leaseDb
      .select({ id: schema.jobs.id })
      .from(schema.jobs)
      .where(and(eq(schema.jobs.status, "running"), ne(schema.jobs.id, migration.jobId ?? -1)));
    if (runningJobs.length > 0) throw new Error("Another job is still running; wait for it to pause before migrating paths");
    const cancelled = await cancelQueuedJobsForMigration(leaseDb, migration.jobId ?? -1);
    const runningMigration = await first(
      leaseDb
        .update(schema.pathMigrations)
        .set({ status: "running", startedAt: migration.startedAt ?? nowIso(), errorMessage: null })
        .where(and(eq(schema.pathMigrations.id, migrationId), inArray(schema.pathMigrations.status, ["queued", "running"])))
        .returning({ id: schema.pathMigrations.id })
    );
    if (!runningMigration) throw new Error("Path migration was replaced before the worker started");
    return cancelled;
  });
  const items = await db.select().from(schema.pathMigrationItems).where(eq(schema.pathMigrationItems.migrationId, migrationId)).orderBy(asc(schema.pathMigrationItems.id));
  const total = items.length;
  await ctx.event("warn", "Managed path migration started", { migrationId, total, cancelledJobs });
  await ctx.setProgress({ migrationId, stage: "validating", current: 0, total, message: "Revalidating mapped symlinks" });

  const assertMappedTarget = async (item: typeof schema.pathMigrationItems.$inferSelect): Promise<void> => {
    const expectedIdentity = parseTargetIdentity(item.targetIdentity);
    const currentIdentity = await readTargetIdentity(item.targetPathAfter);
    if (!targetIdentitiesMatch(currentIdentity, expectedIdentity)) {
      throw new Error(`Mapped target changed after analysis: ${item.targetPathAfter}`);
    }
    if (item.expectedSizeBytes != null && Number(currentIdentity.size) !== item.expectedSizeBytes) {
      throw new Error(`Mapped target size no longer matches migration analysis: ${item.targetPathAfter}`);
    }
  };
  const assertMappedTargetAndRoot = async (item: typeof schema.pathMigrationItems.$inferSelect): Promise<void> => {
    await assertTargetRootIdentity();
    await assertMappedTarget(item);
  };

  let completed = items.filter((item) => item.validationStatus === "applied").length;
  let committed = false;
  try {
    for (const item of items) {
      if (await ctx.isCancelled()) throw new Error("Path migration was terminated");
      if (completed === 0 || completed % 25 === 0) {
        const currentMigration = await first(db.select({ status: schema.pathMigrations.status }).from(schema.pathMigrations).where(eq(schema.pathMigrations.id, migrationId)).limit(1));
        if (currentMigration?.status !== "running") throw new Error("Detected paths changed again while migration was running");
      }
      if (item.validationStatus === "applied") {
        const currentTarget = await symlinkTarget(item.currentLinkPath);
        await assertMappedTarget(item);
        if (path.resolve(currentTarget) === path.resolve(item.targetPathAfter)) continue;
        if (!item.targetChanged || path.resolve(currentTarget) !== path.resolve(item.targetPathBefore)) {
          throw new Error(`Applied symlink changed after migration state was written: ${item.currentLinkPath}`);
        }
        await replaceSymlink(
          target.symlinkDir,
          item.currentLinkPath,
          item.targetPathBefore,
          item.targetPathAfter,
          ctx,
          false,
          () => assertMappedTargetAndRoot(item)
        );
        continue;
      }
      if (item.validationStatus !== "ready") throw new Error(`Symlink is not ready for migration: ${item.currentLinkPath}`);
      if (item.targetChanged) {
        const currentTarget = await symlinkTarget(item.currentLinkPath);
        if (path.resolve(currentTarget) === path.resolve(item.targetPathBefore)) {
          await replaceSymlink(
            target.symlinkDir,
            item.currentLinkPath,
            item.targetPathBefore,
            item.targetPathAfter,
            ctx,
            false,
            () => assertMappedTargetAndRoot(item)
          );
        } else if (path.resolve(currentTarget) !== path.resolve(item.targetPathAfter)) {
          throw new Error(`Symlink changed after analysis: ${item.currentLinkPath}`);
        }
      }
      completed += 1;
      await withMigrationLeaseDb(ctx, async (leaseDb) => {
        await assertMappedTarget(item);
        if (!item.targetChanged) {
          const currentTarget = await symlinkTarget(item.currentLinkPath);
          if (path.resolve(currentTarget) !== path.resolve(item.targetPathAfter)) {
            throw new Error(`Symlink changed after analysis: ${item.currentLinkPath}`);
          }
        }
        const appliedItem = await first(
          leaseDb
            .update(schema.pathMigrationItems)
            .set({ validationStatus: "applied", appliedAt: nowIso(), rolledBackAt: null, message: "Migration step applied." })
            .where(and(eq(schema.pathMigrationItems.id, item.id), eq(schema.pathMigrationItems.validationStatus, "ready")))
            .returning({ id: schema.pathMigrationItems.id })
        );
        if (!appliedItem) throw new Error(`Path migration item changed before it could be applied: ${item.currentLinkPath}`);
      });
      if (completed === total || completed % 25 === 0) {
        await ctx.setProgress({ migrationId, stage: "repointing", current: completed, total, message: `Validated and migrated ${completed} of ${total} symlinks` });
      }
    }

    const sourcePaths = pathsFromConfiguration(source);
    const targetPaths = pathsFromConfiguration(target);
    const migrationJobId = ctx.jobId ?? migration.jobId;
    if (ctx.signal.aborted) {
      throw (ctx.signal.reason instanceof Error ? ctx.signal.reason : new Error("Path migration was terminated"));
    }
    const finalized = await ctx.finishCompleted(async (leaseDb) => {
      await leaseDb.execute(sql`select pg_advisory_xact_lock(${pathConfigurationLockKey})`);
      const currentMigration = await first(
        leaseDb.select({ status: schema.pathMigrations.status }).from(schema.pathMigrations).where(eq(schema.pathMigrations.id, migrationId)).limit(1)
      );
      if (currentMigration?.status !== "running") throw new Error("Detected paths changed again before migration could be committed");
      await assertConfigurationRootIdentity(target, "Managed storage roots changed before migration commit");
      await mapWithConcurrency(items, 8, assertMappedTarget);
      await leaseDb.execute(sql`
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
      await rebaseStorageInventory(leaseDb, "local", sourcePaths.localDir, targetPaths.localDir);
      await rebaseStorageInventory(leaseDb, "remote", sourcePaths.remoteDir, targetPaths.remoteDir);
      await rebaseMissingMediaLinks(leaseDb, "link_path", sourcePaths.symlinkDir, targetPaths.symlinkDir);
      await rebaseMissingMediaLinks(leaseDb, "target_path", sourcePaths.localDir, targetPaths.localDir);
      await rebaseMissingMediaLinks(leaseDb, "target_path", sourcePaths.remoteDir, targetPaths.remoteDir);
      const copySources = await leaseDb.select().from(schema.copySources);
      for (const row of copySources) {
        const rebased = rebaseCopySourceRow(row, sourcePaths, targetPaths);
        await leaseDb
          .update(schema.copySources)
          .set({ sourcePath: rebased.sourcePath, destinationPath: rebased.destinationPath, linkPath: rebased.linkPath })
          .where(eq(schema.copySources.id, row.id));
      }
      const timestamp = nowIso();
      await leaseDb.update(schema.pathConfigurations).set({ status: "superseded" }).where(eq(schema.pathConfigurations.id, source.id));
      await leaseDb.update(schema.pathConfigurations).set({ status: "active", appliedAt: timestamp }).where(eq(schema.pathConfigurations.id, target.id));
      await leaseDb
        .insert(schema.appSettings)
        .values({ key: "paths", value: JSON.stringify(targetPaths), updatedAt: timestamp })
        .onConflictDoUpdate({ target: schema.appSettings.key, set: { value: JSON.stringify(targetPaths), updatedAt: timestamp } });
      await leaseDb
        .update(schema.pathMigrations)
        .set({ status: "completed", finishedAt: timestamp, errorMessage: null })
        .where(eq(schema.pathMigrations.id, migrationId));
      if (migrationJobId != null) {
        await leaseDb
          .update(schema.jobs)
          .set({ progress: JSON.stringify({ migrationId, stage: "completed", current: total, total, message: "Path migration completed" }) })
          .where(eq(schema.jobs.id, migrationJobId));
        await leaseDb.insert(schema.jobEvents).values({
          jobId: migrationJobId,
          timestamp,
          level: "info",
          message: "Managed path migration completed",
          data: JSON.stringify({ migrationId, total })
        });
      }
    });
    if (!finalized) throw new Error("Path migration was terminated before its final commit");
    committed = true;
  } catch (error: unknown) {
    if (!committed) {
      if (error instanceof PathMigrationLeaseLostError) throw error;
      await assertMigrationLease(ctx);
      if (error instanceof PathMigrationRootIdentityError) {
        const message = `${error.message} Automatic rollback was not attempted because the recorded target roots are no longer trustworthy.`;
        await withMigrationLeaseDb(
          ctx,
          async (leaseDb) => {
            await leaseDb
              .update(schema.pathMigrations)
              .set({ status: "failed", errorMessage: message, finishedAt: nowIso() })
              .where(eq(schema.pathMigrations.id, migrationId));
          },
          true
        );
        throw new Error(message, { cause: error });
      }
      const rollbackErrors = await rollbackMigrationItems(db, migrationId, target.symlinkDir, ctx, undefined, assertTargetRootIdentity);
      await assertMigrationLease(ctx);
      const message = rollbackErrors.length > 0 ? `${errorMessage(error)} Rollback also failed for ${rollbackErrors.length} symlink(s).` : errorMessage(error);
      const failureFilter = rollbackErrors.length > 0
        ? eq(schema.pathMigrations.id, migrationId)
        : and(eq(schema.pathMigrations.id, migrationId), eq(schema.pathMigrations.status, "running"));
      await withMigrationLeaseDb(
        ctx,
        async (leaseDb) => {
          await leaseDb.update(schema.pathMigrations).set({ status: "failed", errorMessage: message, finishedAt: nowIso() }).where(failureFilter);
        },
        true
      );
      throw new Error(message, { cause: error });
    }
    throw error;
  }
}
