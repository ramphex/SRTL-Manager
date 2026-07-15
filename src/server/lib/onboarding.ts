import fs from "node:fs/promises";
import path from "node:path";
import { and, count, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { first, getJsonSetting, getSectionSettings, getSetting, nowIso, setSetting, type Db } from "../db/database";
import * as schema from "../db/schema";
import { canonicalTitleKey, setStoragePolicyTitles } from "./storagePolicies";
import { getStorageLocationsSettings, storageLocationNamesFromUpdate } from "./storageLocations";
import type {
  OnboardingPathCheck,
  OnboardingPhase,
  OnboardingPolicyResult,
  OnboardingStartRequest,
  OnboardingState,
  PathsSettings,
  ScanOptions,
  SectionSettings
} from "../../shared/types";

export const onboardingSettingKey = "onboarding.v1";

const onboardingLockKey = 1_904_227_031;
const pathCheckTimeoutMs = 5_000;
const activeJobStatuses = ["queued", "running"] as const;

const policyResultSchema = z.object({
  totalTitles: z.number().int().nonnegative(),
  assignedLocalTitles: z.number().int().nonnegative(),
  assignedRemoteTitles: z.number().int().nonnegative(),
  unassignedTitles: z.number().int().nonnegative(),
  mixedTitles: z.number().int().nonnegative(),
  localSymlinks: z.number().int().nonnegative(),
  remoteSymlinks: z.number().int().nonnegative()
});

const persistedOnboardingSchema = z.object({
  version: z.literal(1),
  status: z.enum(["account_required", "configuration_required", "scan_pending", "completed"]),
  policyMode: z.enum(["match_current_locations", "leave_unassigned"]).nullable(),
  initialScanJobId: z.number().int().positive().nullable(),
  startedAt: z.string().nullable(),
  policyAppliedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  policyResult: policyResultSchema.nullable()
});

type PersistedOnboardingState = z.infer<typeof persistedOnboardingSchema>;

type TitleLocation = {
  title: string;
  hasLocal: boolean;
  hasRemote: boolean;
};

export class OnboardingInputError extends Error {}

export class OnboardingConflictError extends Error {}

function accountRequiredState(): PersistedOnboardingState {
  return {
    version: 1,
    status: "account_required",
    policyMode: null,
    initialScanJobId: null,
    startedAt: null,
    policyAppliedAt: null,
    completedAt: null,
    policyResult: null
  };
}

function completedExistingInstallState(): PersistedOnboardingState {
  return {
    version: 1,
    status: "completed",
    policyMode: null,
    initialScanJobId: null,
    startedAt: null,
    policyAppliedAt: null,
    completedAt: nowIso(),
    policyResult: null
  };
}

function parsePersistedOnboarding(raw: string): PersistedOnboardingState {
  try {
    return persistedOnboardingSchema.parse(JSON.parse(raw));
  } catch (error: unknown) {
    throw new Error(`Stored onboarding state is invalid: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

async function readPersistedOnboarding(db: Db): Promise<PersistedOnboardingState | null> {
  const raw = await getSetting(db, onboardingSettingKey);
  return raw ? parsePersistedOnboarding(raw) : null;
}

export async function reconcileOnboardingState(db: Db): Promise<void> {
  await db.transaction(async (transaction) => {
    await transaction.execute(sql`select pg_advisory_xact_lock(${onboardingLockKey})`);
    const existing = await first(transaction.select({ value: schema.appSettings.value }).from(schema.appSettings).where(eq(schema.appSettings.key, onboardingSettingKey)).limit(1));
    if (existing) {
      parsePersistedOnboarding(existing.value);
      return;
    }

    const admin = await first(transaction.select({ id: schema.adminUsers.id }).from(schema.adminUsers).limit(1));
    const state = admin ? completedExistingInstallState() : accountRequiredState();
    await transaction.insert(schema.appSettings).values({ key: onboardingSettingKey, value: JSON.stringify(state), updatedAt: nowIso() });
  });
}

export async function markOnboardingAccountCreated(db: Db): Promise<void> {
  const existing = (await readPersistedOnboarding(db)) ?? accountRequiredState();
  if (existing.status === "completed") return;
  await setSetting(db, onboardingSettingKey, {
    ...existing,
    status: "configuration_required",
    initialScanJobId: null,
    startedAt: null,
    policyAppliedAt: null,
    completedAt: null,
    policyResult: null
  } satisfies PersistedOnboardingState);
}

export async function markOnboardingCompleteForExistingInstall(db: Db): Promise<void> {
  await setSetting(db, onboardingSettingKey, completedExistingInstallState());
}

export async function isOnboardingComplete(db: Db): Promise<boolean> {
  return (await readPersistedOnboarding(db))?.status === "completed";
}

export async function canAdoptEnvironmentPathsBeforeInitialScan(db: Db): Promise<boolean> {
  const state = await readPersistedOnboarding(db);
  if (!state || !["account_required", "configuration_required"].includes(state.status) || state.initialScanJobId) return false;

  const managedCounts = await Promise.all([
    first(db.select({ value: count() }).from(schema.mediaLinks)),
    first(db.select({ value: count() }).from(schema.storageFiles)),
    first(db.select({ value: count() }).from(schema.storagePolicies)),
    first(db.select({ value: count() }).from(schema.copySources)),
    first(db.select({ value: count() }).from(schema.jobs))
  ]);
  return managedCounts.every((row) => Number(row?.value ?? 0) === 0);
}

async function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  let timeout: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(`${label} timed out after ${pathCheckTimeoutMs / 1_000} seconds`)), pathCheckTimeoutMs);
      })
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function inspectPath(root: OnboardingPathCheck["root"], label: string, value: string): Promise<OnboardingPathCheck> {
  if (!value) return { root, label, path: value, ready: false, message: `${label} is not configured in .env.` };
  if (!path.isAbsolute(value)) return { root, label, path: value, ready: false, message: `${label} must be an absolute path.` };
  try {
    const stat = await withTimeout(fs.stat(value), `Checking ${label.toLowerCase()}`);
    if (!stat.isDirectory()) return { root, label, path: value, ready: false, message: `${label} is not a directory.` };
    return { root, label, path: value, ready: true, message: null };
  } catch (error: unknown) {
    return { root, label, path: value, ready: false, message: error instanceof Error ? error.message : String(error) };
  }
}

async function inspectConfiguredPaths(paths: PathsSettings): Promise<OnboardingPathCheck[]> {
  return Promise.all([
    inspectPath("symlink", "Symlink directory", paths.symlinkDir),
    inspectPath("local", "Local directory", paths.localDir),
    inspectPath("remote", "Remote directory", paths.remoteDir)
  ]);
}

function uncheckedConfiguredPaths(paths: PathsSettings): OnboardingPathCheck[] {
  return [
    { root: "symlink", label: "Symlink directory", path: paths.symlinkDir, ready: Boolean(paths.symlinkDir), message: null },
    { root: "local", label: "Local directory", path: paths.localDir, ready: Boolean(paths.localDir), message: null },
    { root: "remote", label: "Remote directory", path: paths.remoteDir, ready: Boolean(paths.remoteDir), message: null }
  ];
}

async function detectSymlinkSections(symlinkDir: string): Promise<string[]> {
  if (!symlinkDir) return [];
  try {
    const entries = await withTimeout(fs.readdir(symlinkDir, { withFileTypes: true }), "Reading symlink folders");
    const folders: string[] = [];
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      if (entry.isDirectory()) {
        folders.push(entry.name);
        continue;
      }
      if (!entry.isSymbolicLink()) continue;
      try {
        const stat = await withTimeout(fs.stat(path.join(symlinkDir, entry.name)), `Checking ${entry.name}`);
        if (stat.isDirectory()) folders.push(entry.name);
      } catch {
        // Broken top-level links are not valid section choices.
      }
    }
    return folders.sort((left, right) => left.localeCompare(right));
  } catch {
    return [];
  }
}

function progressMessage(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as { message?: unknown };
    return typeof value.message === "string" ? value.message : null;
  } catch {
    return null;
  }
}

async function derivePendingPhase(db: Db, state: PersistedOnboardingState): Promise<{ phase: OnboardingPhase; errorMessage: string | null }> {
  if (!state.initialScanJobId) return { phase: "failed", errorMessage: "The initial scan was not queued. Review the setup and try again." };
  const job = await first(db.select().from(schema.jobs).where(eq(schema.jobs.id, state.initialScanJobId)).limit(1));
  if (!job) return { phase: "failed", errorMessage: "The initial scan job no longer exists. Review the setup and try again." };
  if (job.status === "queued") return { phase: "queued", errorMessage: null };
  if (job.status === "running") return { phase: "scanning", errorMessage: null };
  if (job.status === "completed") return { phase: "failed", errorMessage: "The scan completed, but onboarding did not finish. Run the initial scan again." };
  const scanRun = await first(db.select().from(schema.scanRuns).where(eq(schema.scanRuns.jobId, job.id)).orderBy(desc(schema.scanRuns.id)).limit(1));
  return {
    phase: "failed",
    errorMessage: scanRun?.errorMessage ?? progressMessage(job.progress) ?? (job.status === "cancelled" ? "The initial scan was terminated." : "The initial scan failed.")
  };
}

export async function getOnboardingState(db: Db): Promise<OnboardingState> {
  const persisted = await readPersistedOnboarding(db);
  if (!persisted) throw new Error("Onboarding state has not been initialized");
  const [paths, sections, storageLocations] = await Promise.all([
    getJsonSetting<PathsSettings>(db, "paths", { symlinkDir: "", localDir: "", remoteDir: "" }),
    getSectionSettings(db),
    getStorageLocationsSettings(db)
  ]);
  const shouldInspectPaths = persisted.status === "account_required" || persisted.status === "configuration_required";
  const pathChecks = shouldInspectPaths ? await inspectConfiguredPaths(paths) : uncheckedConfiguredPaths(paths);
  const detectedSections = shouldInspectPaths && pathChecks.find((check) => check.root === "symlink")?.ready ? await detectSymlinkSections(paths.symlinkDir) : [];

  let phase: OnboardingPhase = persisted.status === "scan_pending" ? "queued" : persisted.status;
  let errorMessage: string | null = null;
  if (persisted.status === "scan_pending") {
    const pending = await derivePendingPhase(db, persisted);
    phase = pending.phase;
    errorMessage = pending.errorMessage;
  }

  return {
    required: persisted.status !== "completed",
    phase,
    policyMode: persisted.policyMode,
    initialScanJobId: persisted.initialScanJobId,
    startedAt: persisted.startedAt,
    completedAt: persisted.completedAt,
    errorMessage,
    policyResult: persisted.policyResult,
    paths,
    pathChecks,
    storageLocations,
    sections,
    detectedSections
  };
}

async function validateSectionDirectories(paths: PathsSettings, settings: SectionSettings): Promise<void> {
  const pathChecks = await inspectConfiguredPaths(paths);
  const pathErrors = pathChecks.filter((check) => !check.ready).map((check) => `${check.label}: ${check.message ?? "Unavailable"}`);
  if (pathErrors.length > 0) throw new OnboardingInputError(pathErrors.join(" "));

  const sectionErrors: string[] = [];
  for (const section of settings.sections) {
    const sectionPath = path.join(paths.symlinkDir, section);
    try {
      const stat = await withTimeout(fs.stat(sectionPath), `Checking symlink folder ${section}`);
      if (!stat.isDirectory()) sectionErrors.push(`${section} is not a directory inside the symlink root.`);
    } catch (error: unknown) {
      sectionErrors.push(`${section}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (sectionErrors.length > 0) throw new OnboardingInputError(sectionErrors.join(" "));
}

export async function startOnboarding(db: Db, request: OnboardingStartRequest): Promise<number> {
  const paths = await getJsonSetting<PathsSettings>(db, "paths", { symlinkDir: "", localDir: "", remoteDir: "" });
  const storageLocationNames = storageLocationNamesFromUpdate(request.storageLocations);
  await validateSectionDirectories(paths, request.sections);

  const options: ScanOptions = {
    scanSymlinks: true,
    scanLocal: false,
    scanRemote: false,
    symlinkSections: request.sections.sections,
    localSections: []
  };

  return db.transaction(async (transaction) => {
    await transaction.execute(sql`select pg_advisory_xact_lock(${onboardingLockKey})`);
    const stateRow = await first(transaction.select({ value: schema.appSettings.value }).from(schema.appSettings).where(eq(schema.appSettings.key, onboardingSettingKey)).limit(1));
    if (!stateRow) throw new OnboardingConflictError("Onboarding state has not been initialized");
    const state = parsePersistedOnboarding(stateRow.value);
    if (state.status === "completed") throw new OnboardingConflictError("Onboarding has already been completed");

    if (state.initialScanJobId) {
      const existingJob = await first(transaction.select({ status: schema.jobs.status }).from(schema.jobs).where(eq(schema.jobs.id, state.initialScanJobId)).limit(1));
      if (existingJob && activeJobStatuses.includes(existingJob.status as (typeof activeJobStatuses)[number])) {
        throw new OnboardingConflictError(`Initial scan job #${state.initialScanJobId} is already ${existingJob.status}`);
      }
    }

    const activeJob = await first(transaction.select({ id: schema.jobs.id }).from(schema.jobs).where(inArray(schema.jobs.status, [...activeJobStatuses])).limit(1));
    if (activeJob) throw new OnboardingConflictError(`Wait for job #${activeJob.id} to finish before starting the initial scan`);

    const timestamp = nowIso();
    await transaction
      .insert(schema.appSettings)
      .values({ key: "storageLocationNames", value: JSON.stringify(storageLocationNames), updatedAt: timestamp })
      .onConflictDoUpdate({ target: schema.appSettings.key, set: { value: JSON.stringify(storageLocationNames), updatedAt: timestamp } });
    await transaction
      .insert(schema.appSettings)
      .values({ key: "sections", value: JSON.stringify(request.sections), updatedAt: timestamp })
      .onConflictDoUpdate({ target: schema.appSettings.key, set: { value: JSON.stringify(request.sections), updatedAt: timestamp } });
    for (const section of request.sections.sections) {
      const displayName = request.sections.sectionTitles?.[section] ?? null;
      const contentType = request.sections.sectionTypes?.[section] ?? "other";
      await transaction
        .insert(schema.sections)
        .values({ name: section, displayName, contentType, createdAt: timestamp, updatedAt: timestamp })
        .onConflictDoUpdate({ target: schema.sections.name, set: { displayName, contentType, updatedAt: timestamp } });
    }
    const job = await first(
      transaction
        .insert(schema.jobs)
        .values({
          type: "scan",
          status: "queued",
          createdAt: timestamp,
          startedAt: null,
          finishedAt: null,
          lockedBy: null,
          lockedAt: null,
          heartbeatAt: null,
          cancelRequestedAt: null,
          progress: JSON.stringify({ options, onboarding: true })
        })
        .returning({ id: schema.jobs.id })
    );
    if (!job) throw new Error("Initial scan job was not queued");

    const nextState: PersistedOnboardingState = {
      version: 1,
      status: "scan_pending",
      policyMode: request.policyMode,
      initialScanJobId: job.id,
      startedAt: timestamp,
      policyAppliedAt: null,
      completedAt: null,
      policyResult: null
    };
    await transaction
      .insert(schema.appSettings)
      .values({ key: onboardingSettingKey, value: JSON.stringify(nextState), updatedAt: timestamp })
      .onConflictDoUpdate({ target: schema.appSettings.key, set: { value: JSON.stringify(nextState), updatedAt: timestamp } });
    await transaction
      .insert(schema.appSettings)
      .values({ key: "scanSettings", value: JSON.stringify(options), updatedAt: timestamp })
      .onConflictDoUpdate({ target: schema.appSettings.key, set: { value: JSON.stringify(options), updatedAt: timestamp } });
    const auditSettings = { sections: request.sections.sections, targets: ["local", "remote"] };
    await transaction
      .insert(schema.appSettings)
      .values({ key: "auditSettings", value: JSON.stringify(auditSettings), updatedAt: timestamp })
      .onConflictDoUpdate({ target: schema.appSettings.key, set: { value: JSON.stringify(auditSettings), updatedAt: timestamp } });
    await transaction.insert(schema.jobEvents).values({
      jobId: job.id,
      timestamp,
      level: "info",
      message: "Initial setup scan queued",
      data: JSON.stringify({ type: "scan", policyMode: request.policyMode, sections: request.sections.sections })
    });
    return job.id;
  });
}

export async function applyPendingOnboardingPolicy(db: Db, jobId: number): Promise<OnboardingPolicyResult | null> {
  const state = await readPersistedOnboarding(db);
  if (!state || state.status !== "scan_pending" || state.initialScanJobId !== jobId || !state.policyMode) return null;
  if (state.policyAppliedAt && state.policyResult) return state.policyResult;

  const links = await db
    .select({ itemName: schema.mediaLinks.itemName, kind: schema.mediaLinks.kind })
    .from(schema.mediaLinks)
    .where(and(isNull(schema.mediaLinks.missingSince), eq(schema.mediaLinks.isMedia, true)));
  const titles = new Map<string, TitleLocation>();
  let localSymlinks = 0;
  let remoteSymlinks = 0;
  for (const link of links) {
    const titleKey = canonicalTitleKey(link.itemName);
    if (!titleKey) continue;
    const title = titles.get(titleKey) ?? { title: link.itemName, hasLocal: false, hasRemote: false };
    if (link.kind === "local") {
      title.hasLocal = true;
      localSymlinks += 1;
    }
    if (link.kind === "remote") {
      title.hasRemote = true;
      remoteSymlinks += 1;
    }
    titles.set(titleKey, title);
  }

  const allTitles = [...titles.values()].map((title) => title.title);
  const localTitles = [...titles.values()].filter((title) => title.hasLocal).map((title) => title.title);
  const remoteOnlyTitles = [...titles.values()].filter((title) => title.hasRemote && !title.hasLocal).map((title) => title.title);
  const mixedTitles = [...titles.values()].filter((title) => title.hasLocal && title.hasRemote).length;

  await setStoragePolicyTitles(db, allTitles, "unassigned", { source: "onboarding" });
  if (state.policyMode === "match_current_locations") {
    await setStoragePolicyTitles(db, localTitles, "location_1", { source: "onboarding" });
    await setStoragePolicyTitles(db, remoteOnlyTitles, "location_2", { source: "onboarding" });
  }

  const assignedLocalTitles = state.policyMode === "match_current_locations" ? localTitles.length : 0;
  const assignedRemoteTitles = state.policyMode === "match_current_locations" ? remoteOnlyTitles.length : 0;
  const result: OnboardingPolicyResult = {
    totalTitles: titles.size,
    assignedLocalTitles,
    assignedRemoteTitles,
    unassignedTitles: titles.size - assignedLocalTitles - assignedRemoteTitles,
    mixedTitles,
    localSymlinks,
    remoteSymlinks
  };
  const timestamp = nowIso();
  await setSetting(db, onboardingSettingKey, { ...state, policyAppliedAt: timestamp, policyResult: result } satisfies PersistedOnboardingState);
  await db.insert(schema.jobEvents).values({
    jobId,
    timestamp,
    level: "info",
    message: state.policyMode === "match_current_locations" ? "Initial policies assigned from current symlink locations" : "Initial titles left unassigned",
    data: JSON.stringify({ policyMode: state.policyMode, ...result })
  });
  return result;
}

export async function completeOnboardingScan(db: Db, jobId: number): Promise<boolean> {
  const state = await readPersistedOnboarding(db);
  if (!state || state.status !== "scan_pending" || state.initialScanJobId !== jobId) return false;
  if (!state.policyAppliedAt || !state.policyResult) throw new Error("Initial policy processing did not complete");
  const timestamp = nowIso();
  await setSetting(db, onboardingSettingKey, { ...state, status: "completed", completedAt: timestamp } satisfies PersistedOnboardingState);
  await db.insert(schema.jobEvents).values({ jobId, timestamp, level: "info", message: "Initial setup completed", data: JSON.stringify(state.policyResult) });
  return true;
}
