import fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";
import { and, count, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { dbAll, dbGet, first, getSectionSettings, nowIso, type Db } from "../db/database";
import * as schema from "../db/schema";
import { inferSectionContentType } from "../../shared/sections";
import { canonicalTitleKey } from "./storagePolicies";
import { applyPendingOnboardingPolicy } from "./onboarding";
import { isMediaFile, isPathInside, safeRelativePath } from "./media";
import { assertReadableRegularFile, withFilesystemTimeout } from "./filesystemSafety";
import { reconcileStorageFilePolicies } from "./storageFilePolicies";
import type {
  InventorySummary,
  InventoryScanTimestamps,
  LinkKind,
  MediaLinkRow,
  MediaLinksPage,
  MediaLinkTreeKindFilter,
  MediaLinkTree,
  MediaLinkTreeNode,
  PathsSettings,
  ScanOptions,
  ScanTitleScope,
  SectionContentType,
  SectionSettings,
  SectionSummary,
  StoragePolicyKind,
  StorageFileRow,
  StorageFileTree,
  StorageFileTreeNode,
  StorageRootType
} from "../../shared/types";

type StoragePolicyLookup = Map<string, StoragePolicyKind>;

export interface ClassifiedLink {
  section: string;
  itemName: string;
  relativePath: string;
  linkPath: string;
  targetPath: string;
  kind: LinkKind;
  targetExists: boolean;
  isMedia: boolean;
  storagePolicy: StoragePolicyKind;
  resolvedStorageFileId?: number | null;
  sizeBytes: number | null;
  targetMtimeMs: number | null;
  targetReadError: string | null;
}

export interface ClassifiedStorageFile {
  rootType: StorageRootType;
  rootPath: string;
  section: string;
  itemName: string;
  relativePath: string;
  filePath: string;
  storagePolicy: StoragePolicyKind;
  sizeBytes: number;
  mtimeMs: number;
}

export interface StorageScanIssue {
  rootType: StorageRootType;
  rootPath: string;
  directoryPath: string;
  relativePath: string;
  message: string;
  attempts: number;
}

export interface ScanResult {
  options: ScanOptions;
  links: ClassifiedLink[];
  storageFiles: ClassifiedStorageFile[];
  reconciledStorageFiles: ClassifiedStorageFile[];
  storageScanIssues: StorageScanIssue[];
  summaries: SectionSummary[];
  inventory: InventorySummary;
}

export interface ScanActivity {
  phase: "discovering_symlinks" | "checking_symlinks";
  currentSection: string;
  discoveredLinks: number;
  checkedLinks: number;
  completedWorkUnits: number;
  totalWorkUnits: number;
  message: string;
}

export type ScanActivityReporter = (activity: ScanActivity) => Promise<void>;

export const defaultScanOptions: ScanOptions = {
  scanSymlinks: true,
  scanLocal: false,
  scanRemote: false
};

const maxSymlinkDiscoveryPasses = 2;

function storagePolicyForTitle(storagePolicies: StoragePolicyLookup, title: string): StoragePolicyKind {
  const titleKey = canonicalTitleKey(title);
  return storagePolicies.get(titleKey) ?? "unassigned";
}

export async function classifySymlink(
  linkPath: string,
  sectionRoot: string,
  paths: PathsSettings,
  section: string,
  storagePolicies: StoragePolicyLookup,
  verifyTargetReadability = false
): Promise<ClassifiedLink> {
  const rawTargetPath = await withFilesystemTimeout(fs.readlink(linkPath), `Symlink target read for ${linkPath}`);
  const targetPath = path.isAbsolute(rawTargetPath) ? rawTargetPath : path.resolve(path.dirname(linkPath), rawTargetPath);
  const relativePath = safeRelativePath(sectionRoot, linkPath);
  const [itemName] = relativePath.split(path.sep);
  const media = isMediaFile(linkPath) || isMediaFile(targetPath);
  const targetRootType: StorageRootType | "other" = isPathInside(paths.remoteDir, targetPath) ? "remote" : isPathInside(paths.localDir, targetPath) ? "local" : "other";
  let targetExists = false;
  let sizeBytes: number | null = null;
  let targetMtimeMs: number | null = null;
  let targetReadError: string | null = null;

  const attempts = targetRootType === "remote" ? (verifyTargetReadability ? 3 : 2) : 1;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      if (verifyTargetReadability && media && targetRootType !== "other") {
        const snapshot = await assertReadableRegularFile(targetPath, `Symlink target ${targetPath}`, { attempts: 1, timeoutMs: 5_000 });
        sizeBytes = snapshot.size;
        targetMtimeMs = Math.trunc(snapshot.mtimeMs);
      } else {
        const stat = await withFilesystemTimeout(fs.stat(targetPath), `Target check for ${targetPath}`);
        sizeBytes = stat.isFile() ? stat.size : null;
        targetMtimeMs = Math.trunc(stat.mtimeMs);
      }
      targetExists = true;
      targetReadError = null;
      break;
    } catch (error) {
      targetExists = false;
      targetReadError = verifyTargetReadability ? describeError(error) : null;
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, verifyTargetReadability ? 350 : 100));
    }
  }

  let kind: LinkKind;
  if (!media) {
    kind = "non_media";
  } else if (!targetExists) {
    kind = "broken";
  } else if (targetRootType === "remote") {
    kind = "remote";
  } else if (targetRootType === "local") {
    kind = "local";
  } else {
    kind = "other";
  }

  const storagePolicy = storagePolicyForTitle(storagePolicies, itemName || "");
  return {
    section,
    itemName: itemName || path.basename(linkPath),
    relativePath,
    linkPath,
    targetPath,
    kind,
    targetExists,
    isMedia: media,
    storagePolicy,
    sizeBytes,
    targetMtimeMs,
    targetReadError
  };
}

async function assertReadableDirectory(root: string, label: string): Promise<void> {
  let stat;
  try {
    stat = await withFilesystemTimeout(fs.stat(root), `Inspection of ${label}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} is unavailable: ${root} (${message})`, { cause: error });
  }
  if (!stat.isDirectory()) {
    throw new Error(`${label} is not a directory: ${root}`);
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissingPathError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

async function symlinkChangedSinceDiscovery(linkPath: string, error: unknown): Promise<boolean> {
  if (isMissingPathError(error)) return true;
  if ((error as NodeJS.ErrnoException | null)?.code !== "EINVAL") return false;

  try {
    const stat = await withFilesystemTimeout(fs.lstat(linkPath), `Rechecking changed symlink ${linkPath}`);
    return !stat.isSymbolicLink();
  } catch (inspectionError) {
    if (isMissingPathError(inspectionError)) return true;
    throw inspectionError;
  }
}

type ScanCancellationCheck = () => Promise<boolean>;

async function throwIfScanCancelled(isCancelled?: ScanCancellationCheck): Promise<void> {
  if (isCancelled && (await isCancelled())) throw new Error("Job terminated");
}

async function walkSymlinks(
  root: string,
  isCancelled?: ScanCancellationCheck,
  onSymlinkDiscovered?: (linkPath: string) => Promise<void> | undefined
): Promise<string[]> {
  const links: string[] = [];
  async function walk(dir: string, required: boolean): Promise<void> {
    await throwIfScanCancelled(isCancelled);
    let entries: Dirent[];
    try {
      entries = await withFilesystemTimeout(fs.readdir(dir, { withFileTypes: true }), `Reading symlink directory ${dir}`);
    } catch (error) {
      if (!required && isMissingPathError(error)) return;
      throw error;
    }
    for (const entry of entries) {
      await throwIfScanCancelled(isCancelled);
      const fullPath = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        links.push(fullPath);
        const progressUpdate = onSymlinkDiscovered?.(fullPath);
        if (progressUpdate) await progressUpdate;
      } else if (entry.isDirectory()) {
        await walk(fullPath, false);
      }
    }
  }
  await walk(root, true);
  return links;
}

interface StorageWalkFailure {
  directoryPath: string;
  error: unknown;
}

interface StorageWalkResult {
  files: ClassifiedStorageFile[];
  failedDirectories: StorageWalkFailure[];
}

async function walkStorageFilesCollecting(root: string, rootType: StorageRootType, storageRoot: string, tolerateReadErrors: boolean, isCancelled?: ScanCancellationCheck): Promise<StorageWalkResult> {
  const files: ClassifiedStorageFile[] = [];
  const failedDirectories: StorageWalkFailure[] = [];

  async function walk(dir: string): Promise<void> {
    await throwIfScanCancelled(isCancelled);
    let entries: Dirent[];
    try {
      entries = await withFilesystemTimeout(fs.readdir(dir, { withFileTypes: true }), `Reading storage directory ${dir}`);
    } catch (error) {
      if (!tolerateReadErrors) throw error;
      failedDirectories.push({ directoryPath: dir, error });
      return;
    }

    for (const entry of entries) {
      await throwIfScanCancelled(isCancelled);
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile() && isMediaFile(fullPath)) {
        try {
          const stat = await withFilesystemTimeout(fs.stat(fullPath), `Reading storage file ${fullPath}`);
          files.push({
            rootType,
            rootPath: storageRoot,
            section: "",
            itemName: "",
            relativePath: safeRelativePath(storageRoot, fullPath),
            filePath: fullPath,
            storagePolicy: "unassigned",
            sizeBytes: stat.size,
            mtimeMs: Math.trunc(stat.mtimeMs)
          });
        } catch (error) {
          if (!tolerateReadErrors) throw error;
          failedDirectories.push({ directoryPath: dir, error });
        }
      }
    }
  }

  await walk(root);
  return { files, failedDirectories };
}

function uniqueStorageFiles(files: ClassifiedStorageFile[]): ClassifiedStorageFile[] {
  return [...new Map(files.map((file) => [file.filePath, file])).values()];
}

async function walkStorageFiles(root: string, rootType: StorageRootType, storageRoot = root, isCancelled?: ScanCancellationCheck): Promise<ClassifiedStorageFile[]> {
  return (await walkStorageFilesCollecting(root, rootType, storageRoot, false, isCancelled)).files;
}

async function walkRemoteStorageFiles(root: string, isCancelled?: ScanCancellationCheck): Promise<{ files: ClassifiedStorageFile[]; issues: StorageScanIssue[] }> {
  const firstPass = await walkStorageFilesCollecting(root, "remote", root, true, isCancelled);
  const files = [...firstPass.files];
  const failureAttempts = new Map<string, { error: unknown; attempts: number }>();

  for (const failure of firstPass.failedDirectories) {
    const existing = failureAttempts.get(failure.directoryPath);
    failureAttempts.set(failure.directoryPath, { error: failure.error, attempts: (existing?.attempts ?? 0) + 1 });
  }

  for (const failure of firstPass.failedDirectories) {
    await throwIfScanCancelled(isCancelled);
    const retry = await walkStorageFilesCollecting(failure.directoryPath, "remote", root, true, isCancelled);
    files.push(...retry.files);

    const retryFailurePaths = new Set<string>();
    for (const retryFailure of retry.failedDirectories) {
      retryFailurePaths.add(retryFailure.directoryPath);
      const existing = failureAttempts.get(retryFailure.directoryPath);
      failureAttempts.set(retryFailure.directoryPath, { error: retryFailure.error, attempts: (existing?.attempts ?? 0) + 1 });
    }

    if (!retryFailurePaths.has(failure.directoryPath)) {
      failureAttempts.delete(failure.directoryPath);
    }
  }

  const issues = [...failureAttempts.entries()].map(([directoryPath, issue]) => ({
    rootType: "remote" as const,
    rootPath: root,
    directoryPath,
    relativePath: safeRelativePath(root, directoryPath),
    message: describeError(issue.error),
    attempts: issue.attempts
  }));

  return { files: uniqueStorageFiles(files), issues };
}

function scanSections(settings: SectionSettings, selectedSections: string[] | undefined): string[] {
  if (!selectedSections) return settings.sections;
  const requested = new Set(selectedSections);
  return settings.sections.filter((section) => requested.has(section));
}

function scanSymlinkSections(settings: SectionSettings, options: ScanOptions): string[] {
  return scanSections(settings, options.symlinkSections ?? options.sections);
}

function scanLocalSections(settings: SectionSettings, options: ScanOptions): string[] {
  return scanSections(settings, options.localSections ?? options.sections);
}

function scanTitleScopeKey(section: string, itemName: string): string {
  return `${section}\0${itemName}`;
}

function scanTitleScopesBySection(scopes: ScanTitleScope[] | undefined): Map<string, string[]> | null {
  if (!scopes?.length) return null;
  const titlesBySection = new Map<string, string[]>();
  for (const scope of scopes) {
    const titles = titlesBySection.get(scope.section) ?? [];
    titles.push(scope.itemName);
    titlesBySection.set(scope.section, titles);
  }
  return titlesBySection;
}

function scopedSectionSettings(settings: SectionSettings, sections: string[]): SectionSettings {
  return {
    sections,
    sectionTitles: settings.sectionTitles,
    sectionTypes: settings.sectionTypes
  };
}

async function directoryExists(root: string): Promise<boolean> {
  try {
    const stat = await withFilesystemTimeout(fs.stat(root), `Inspecting directory ${root}`);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

async function optionalReadableDirectory(root: string, label: string): Promise<boolean> {
  try {
    const stat = await withFilesystemTimeout(fs.stat(root), `Inspection of ${label}`);
    if (!stat.isDirectory()) throw new Error(`${label} is not a directory: ${root}`);
    return true;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") return false;
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} is unavailable: ${root} (${message})`, { cause: error });
  }
}

async function walkLocalStorageFilesForSections(root: string, sections: string[], isCancelled?: ScanCancellationCheck): Promise<ClassifiedStorageFile[]> {
  await assertReadableDirectory(root, "Local storage root");
  if (sections.length === 0) return walkStorageFiles(root, "local", root, isCancelled);

  const files: ClassifiedStorageFile[] = [];
  for (const section of sections) {
    await throwIfScanCancelled(isCancelled);
    const sectionRoot = path.join(root, section);
    if (await directoryExists(sectionRoot)) {
      files.push(...(await walkStorageFiles(sectionRoot, "local", root, isCancelled)));
    }
  }
  return files;
}

export async function scanLibrary(
  paths: PathsSettings,
  settings: SectionSettings,
  storagePolicies: StoragePolicyLookup,
  options: ScanOptions = defaultScanOptions,
  isCancelled?: ScanCancellationCheck,
  onProgress?: ScanActivityReporter
): Promise<ScanResult> {
  const links: ClassifiedLink[] = [];
  const storageFiles: ClassifiedStorageFile[] = [];
  const storageScanIssues: StorageScanIssue[] = [];
  const symlinkSections = scanSymlinkSections(settings, options);
  const localSections = scanLocalSections(settings, options);
  const titleScopesBySection = scanTitleScopesBySection(options.titleScopes);
  const scopedSettings = scopedSectionSettings(settings, symlinkSections);
  const totalSymlinkWorkUnits = symlinkSections.reduce((total, section) => total + (titleScopesBySection?.get(section)?.length || 1), 0);
  let discoveredLinks = 0;
  let checkedLinks = 0;
  let completedWorkUnits = 0;
  let lastProgressAt = 0;

  function shouldReportSymlinkActivity(): boolean {
    return Boolean(onProgress && Date.now() - lastProgressAt >= 350);
  }

  function reportSymlinkActivity(
    phase: ScanActivity["phase"],
    currentSection: string,
    message: string,
    force = false
  ): Promise<void> | undefined {
    if (!onProgress) return undefined;
    const timestamp = Date.now();
    if (!force && timestamp - lastProgressAt < 350) return undefined;
    lastProgressAt = timestamp;
    return onProgress({
      phase,
      currentSection,
      discoveredLinks,
      checkedLinks,
      completedWorkUnits,
      totalWorkUnits: totalSymlinkWorkUnits,
      message
    });
  }

  if (options.scanSymlinks) {
    for (const section of symlinkSections) {
      await throwIfScanCancelled(isCancelled);
      const sectionRoot = path.join(paths.symlinkDir, section);
      await assertReadableDirectory(sectionRoot, `Symlink folder "${section}"`);
      const scopedTitles = titleScopesBySection?.get(section);
      const scanRoots = scopedTitles?.length ? scopedTitles.map((itemName) => path.resolve(sectionRoot, itemName)) : [sectionRoot];
      for (const scanRoot of scanRoots) {
        if (path.dirname(scanRoot) !== path.resolve(sectionRoot) && scanRoot !== path.resolve(sectionRoot)) {
          throw new Error(`Title scan path must be directly inside symlink folder "${section}"`);
        }
        const sectionLabel = settings.sectionTitles?.[section]?.trim() || section;
        const scanLabel = scanRoot === path.resolve(sectionRoot) ? sectionLabel : `${sectionLabel} / ${path.basename(scanRoot)}`;
        if (scanRoot !== path.resolve(sectionRoot) && !(await optionalReadableDirectory(scanRoot, "Symlink title folder"))) {
          completedWorkUnits += 1;
          const skippedUpdate = reportSymlinkActivity("discovering_symlinks", section, `No symlink folder was found for ${scanLabel}`, true);
          if (skippedUpdate) await skippedUpdate;
          continue;
        }
        const startingUpdate = reportSymlinkActivity("discovering_symlinks", section, `Discovering symlinks in ${scanLabel}`, true);
        if (startingUpdate) await startingUpdate;
        const discoveredInRoot = new Set<string>();
        const checkedInRoot = new Set<string>();
        for (let discoveryPass = 0; discoveryPass < maxSymlinkDiscoveryPasses; discoveryPass += 1) {
          let refreshNeeded = false;
          const symlinks = await walkSymlinks(scanRoot, isCancelled, (linkPath) => {
            if (discoveredInRoot.has(linkPath)) return undefined;
            discoveredInRoot.add(linkPath);
            discoveredLinks += 1;
            if (!shouldReportSymlinkActivity()) return undefined;
            return reportSymlinkActivity("discovering_symlinks", section, `Found ${discoveredLinks.toLocaleString()} symlinks while reading ${scanLabel}`, true);
          });
          const checkingUpdate = reportSymlinkActivity("checking_symlinks", section, `Checking symlink targets in ${scanLabel}`, true);
          if (checkingUpdate) await checkingUpdate;
          for (const linkPath of symlinks) {
            if (checkedInRoot.has(linkPath)) continue;
            await throwIfScanCancelled(isCancelled);
            try {
              links.push(await classifySymlink(linkPath, sectionRoot, paths, section, storagePolicies, Boolean(titleScopesBySection)));
            } catch (error) {
              if (!(await symlinkChangedSinceDiscovery(linkPath, error))) throw error;
              if (discoveredInRoot.delete(linkPath)) discoveredLinks = Math.max(0, discoveredLinks - 1);
              refreshNeeded = true;
              continue;
            }
            checkedInRoot.add(linkPath);
            checkedLinks += 1;
            if (!shouldReportSymlinkActivity()) continue;
            const progressUpdate = reportSymlinkActivity(
              "checking_symlinks",
              section,
              `Checked ${checkedLinks.toLocaleString()} of ${discoveredLinks.toLocaleString()} discovered symlinks`,
              true
            );
            if (progressUpdate) await progressUpdate;
          }
          if (!refreshNeeded || discoveryPass + 1 >= maxSymlinkDiscoveryPasses) break;
          const refreshUpdate = reportSymlinkActivity("discovering_symlinks", section, `Refreshing ${scanLabel} after symlinks changed during the scan`, true);
          if (refreshUpdate) await refreshUpdate;
        }
        completedWorkUnits += 1;
        const completedUpdate = reportSymlinkActivity("checking_symlinks", section, `Finished checking ${scanLabel}`, true);
        if (completedUpdate) await completedUpdate;
      }
    }
  }

  if (options.scanLocal) {
    storageFiles.push(...(await walkLocalStorageFilesForSections(paths.localDir, localSections, isCancelled)));
  }

  if (options.scanRemote) {
    await assertReadableDirectory(paths.remoteDir, "Remote storage root");
    const remoteScan = await walkRemoteStorageFiles(paths.remoteDir, isCancelled);
    storageFiles.push(...remoteScan.files);
    storageScanIssues.push(...remoteScan.issues);
  }

  const classifiedStorageFiles = applyStorageFileMetadata(storageFiles, settings);
  const reconciledStorageFiles = titleScopesBySection
    ? uniqueStorageFiles(links.map((link) => storageFileFromTargetedLink(link, paths)).filter((file): file is ClassifiedStorageFile => file !== null))
    : [];
  const summaries = summarizeLinks(links, scopedSettings.sections, scopedSettings.sectionTitles, scopedSettings.sectionTypes);
  return { options, links, storageFiles: classifiedStorageFiles, reconciledStorageFiles, storageScanIssues, summaries, inventory: summarizeInventory(links, classifiedStorageFiles) };
}

export function summarizeLinks(
  links: ClassifiedLink[],
  sections: string[],
  sectionTitles: Record<string, string | null | undefined> = {},
  sectionTypes: Record<string, SectionContentType | null | undefined> = {}
): SectionSummary[] {
  return sections.map((section) => {
    const sectionLinks = links.filter((link) => link.section === section);
    const mediaLinks = sectionLinks.filter((link) => link.isMedia);
    const type = sectionTypes[section] ?? inferSectionContentType(section);
    const itemNames = new Set<string>();
    const seasonPaths = new Set<string>();

    for (const link of mediaLinks) {
      const [itemName, seasonName] = splitRelativePathParts(link.relativePath);
      if (itemName) itemNames.add(itemName);
      if (type === "shows" && itemName && seasonName) seasonPaths.add(`${itemName}/${seasonName}`);
    }

    const summary: SectionSummary = {
      section,
      title: sectionTitles[section]?.trim() || section,
      type,
      totalLinks: sectionLinks.length,
      itemCount: itemNames.size,
      seasonCount: seasonPaths.size,
      episodeCount: mediaLinks.length,
      remoteLinks: 0,
      localLinks: 0,
      brokenLinks: 0,
      otherLinks: 0,
      nonMediaLinks: 0,
      actionableRemoteLinks: 0,
      actionableLocalLinks: 0,
      assignedRemoteLinks: 0,
      unassignedRemoteLinks: 0,
      unassignedLocalLinks: 0
    };

    for (const link of sectionLinks) {
      if (link.kind === "remote") {
        summary.remoteLinks += 1;
        if (link.storagePolicy === "location_1") summary.actionableRemoteLinks += 1;
        else if (link.storagePolicy === "location_2") summary.assignedRemoteLinks += 1;
        else summary.unassignedRemoteLinks += 1;
      } else if (link.kind === "local") {
        summary.localLinks += 1;
        if (link.storagePolicy === "location_2") summary.actionableLocalLinks += 1;
        else if (link.storagePolicy === "unassigned") summary.unassignedLocalLinks += 1;
      } else if (link.kind === "broken") {
        summary.brokenLinks += 1;
      } else if (link.kind === "non_media") {
        summary.nonMediaLinks += 1;
      } else {
        summary.otherLinks += 1;
      }
    }

    return summary;
  });
}

function splitRelativePathParts(relativePath: string): string[] {
  return relativePath.replace(/\\/g, "/").split("/").filter(Boolean);
}

function filenameTitle(fileName: string): string {
  const extension = path.extname(fileName);
  return extension ? fileName.slice(0, -extension.length) : fileName;
}

function storageFileMetadata(relativePath: string, rootType: StorageRootType, sectionNames: Set<string>): Pick<ClassifiedStorageFile, "section" | "itemName"> {
  const parts = splitRelativePathParts(relativePath);
  if (parts.length === 0) return { section: "", itemName: "" };
  if (parts.length > 1 && sectionNames.has(parts[0])) {
    return { section: parts[0], itemName: parts.length === 2 ? filenameTitle(parts[1]) : parts[1] };
  }
  if (rootType === "local" && parts.length > 1) {
    return { section: "", itemName: parts[0] };
  }
  return { section: "", itemName: parts.length > 1 ? parts[0] : filenameTitle(parts[0]) };
}

function applyStorageFileMetadata(files: ClassifiedStorageFile[], settings: SectionSettings): ClassifiedStorageFile[] {
  const sectionNames = new Set(settings.sections);
  return files.map((file) => {
    const metadata = storageFileMetadata(file.relativePath, file.rootType, sectionNames);
    return {
      ...file,
      ...metadata,
      storagePolicy: "unassigned"
    };
  });
}

function storageFileFromTargetedLink(link: ClassifiedLink, paths: PathsSettings): ClassifiedStorageFile | null {
  if (!link.targetExists || !link.isMedia || link.sizeBytes === null || link.targetMtimeMs === null) return null;
  if (link.kind !== "local" && link.kind !== "remote") return null;
  const rootPath = link.kind === "local" ? paths.localDir : paths.remoteDir;
  return {
    rootType: link.kind,
    rootPath,
    section: link.section,
    itemName: link.itemName,
    relativePath: safeRelativePath(rootPath, link.targetPath),
    filePath: link.targetPath,
    storagePolicy: link.storagePolicy,
    sizeBytes: link.sizeBytes,
    mtimeMs: link.targetMtimeMs
  };
}

export function summarizeInventory(links: ClassifiedLink[], storageFiles: ClassifiedStorageFile[]): InventorySummary {
  const linkedTargets = new Set(links.filter((link) => link.targetExists && link.isMedia).map((link) => link.targetPath));
  const localFiles = storageFiles.filter((file) => file.rootType === "local");
  const remoteFiles = storageFiles.filter((file) => file.rootType === "remote");
  const unlinkedFiles = storageFiles.filter((file) => !linkedTargets.has(file.filePath));
  const unlinkedLocalFiles = unlinkedFiles.filter((file) => file.rootType === "local");
  const unlinkedRemoteFiles = unlinkedFiles.filter((file) => file.rootType === "remote");
  return {
    totalLinks: links.length,
    remoteLinks: links.filter((link) => link.kind === "remote").length,
    localLinks: links.filter((link) => link.kind === "local").length,
    brokenLinks: links.filter((link) => link.kind === "broken").length,
    otherLinks: links.filter((link) => link.kind === "other").length,
    nonMediaLinks: links.filter((link) => link.kind === "non_media").length,
    actionableRemoteLinks: links.filter((link) => link.kind === "remote" && link.storagePolicy === "location_1").length,
    actionableLocalLinks: links.filter((link) => link.kind === "local" && link.storagePolicy === "location_2").length,
    assignedRemoteLinks: links.filter((link) => link.kind === "remote" && link.storagePolicy === "location_2").length,
    unassignedRemoteLinks: links.filter((link) => link.kind === "remote" && link.storagePolicy === "unassigned").length,
    unassignedLocalLinks: links.filter((link) => link.kind === "local" && link.storagePolicy === "unassigned").length,
    localFiles: localFiles.length,
    remoteFiles: remoteFiles.length,
    actionableRemoteFiles: 0,
    actionableLocalFiles: 0,
    assignedRemoteFiles: 0,
    unassignedRemoteFiles: unlinkedRemoteFiles.length,
    unassignedLocalFiles: unlinkedLocalFiles.length,
    localOrphanFiles: unlinkedLocalFiles.length,
    remoteOrphanFiles: unlinkedRemoteFiles.length,
    missingLinks: 0,
    missingLocalFiles: 0,
    missingRemoteFiles: 0
  };
}

function linkChanged(existing: typeof schema.mediaLinks.$inferSelect | undefined, link: ClassifiedLink, resolvedStorageFileId: number | null): boolean {
  if (!existing) return true;
  return (
    existing.section !== link.section ||
    existing.itemName !== link.itemName ||
    existing.relativePath !== link.relativePath ||
    existing.targetPath !== link.targetPath ||
    existing.kind !== link.kind ||
    existing.targetExists !== link.targetExists ||
    existing.isMedia !== link.isMedia ||
    existing.storagePolicy !== link.storagePolicy ||
    existing.resolvedStorageFileId !== resolvedStorageFileId ||
    existing.sizeBytes !== link.sizeBytes
  );
}

function storageFileChanged(existing: typeof schema.storageFiles.$inferSelect | undefined, file: ClassifiedStorageFile): boolean {
  if (!existing) return true;
  return (
    existing.rootType !== file.rootType ||
    existing.rootPath !== file.rootPath ||
    existing.section !== file.section ||
    existing.itemName !== file.itemName ||
    existing.relativePath !== file.relativePath ||
    existing.storagePolicy !== file.storagePolicy ||
    existing.sizeBytes !== file.sizeBytes ||
    existing.mtimeMs !== file.mtimeMs
  );
}

function firstRelativePathPart(relativePath: string): string {
  return relativePath.replace(/\\/g, "/").split("/").filter(Boolean)[0] ?? "";
}

function scopedSectionSet(selectedSections: string[] | undefined): Set<string> | null {
  return selectedSections && selectedSections.length > 0 ? new Set(selectedSections) : null;
}

function isInsideUnscannedStorageDirectory(file: typeof schema.storageFiles.$inferSelect, issues: StorageScanIssue[]): boolean {
  return issues.some((issue) => issue.rootType === file.rootType && isPathInside(issue.directoryPath, file.filePath));
}

async function throwIfPersistenceCancelled(isCancelled?: ScanCancellationCheck): Promise<void> {
  if (isCancelled && (await isCancelled())) throw new Error("Scan indexing was cancelled");
}

export async function persistScanResult(db: Db, result: ScanResult, jobId: number, isCancelled?: ScanCancellationCheck): Promise<InventorySummary> {
  await throwIfPersistenceCancelled(isCancelled);
  const timestamp = nowIso();
  const filesToReconcile = uniqueStorageFiles([...result.storageFiles, ...result.reconciledStorageFiles]);
  const seenStorageFilePaths = new Set(result.storageFiles.map((file) => file.filePath));
  const seenLinkPaths = new Set(result.links.map((link) => link.linkPath));
  const scannedStorageRootTypes = new Set<StorageRootType>();
  const scannedSymlinkSections = scopedSectionSet(result.options.symlinkSections ?? result.options.sections);
  const scannedSymlinkTitles = result.options.titleScopes?.length
    ? new Set(result.options.titleScopes.map((scope) => scanTitleScopeKey(scope.section, scope.itemName)))
    : null;
  const scannedLocalSections = scopedSectionSet(result.options.localSections ?? result.options.sections);
  const affectedStorageFilePolicyIds = new Set<number>();
  let missingLinks = 0;
  let missingLocalFiles = 0;
  let missingRemoteFiles = 0;
  if (result.options.scanLocal) scannedStorageRootTypes.add("local");
  if (result.options.scanRemote) scannedStorageRootTypes.add("remote");
  const existingStorageFiles = await db.select().from(schema.storageFiles);
  const existingStorageFileByPath = new Map(existingStorageFiles.map((file) => [file.filePath, file]));

  for (const file of filesToReconcile) {
    await throwIfPersistenceCancelled(isCancelled);
    const existing = existingStorageFileByPath.get(file.filePath);
    const persistedFile: ClassifiedStorageFile = { ...file, storagePolicy: normalizeStoragePolicy(existing?.storagePolicy) };
    const firstSeenAt = existing?.firstSeenAt ?? timestamp;
    const lastChangedAt = storageFileChanged(existing, persistedFile) ? timestamp : existing?.lastChangedAt ?? timestamp;
    const persisted = await db
      .insert(schema.storageFiles)
      .values({ ...persistedFile, firstSeenAt, lastSeenAt: timestamp, lastChangedAt, missingSince: null, lastSeenJobId: jobId, updatedAt: timestamp })
      .onConflictDoUpdate({
        target: schema.storageFiles.filePath,
        set: { ...persistedFile, lastSeenAt: timestamp, lastChangedAt, missingSince: null, lastSeenJobId: jobId, updatedAt: timestamp }
      })
      .returning({ id: schema.storageFiles.id });
    if (persisted[0]) affectedStorageFilePolicyIds.add(persisted[0].id);
  }

  for (const file of existingStorageFiles) {
    await throwIfPersistenceCancelled(isCancelled);
    const fileSection = firstRelativePathPart(file.relativePath);
    const scannedFileSection = file.rootType === "remote" || !scannedLocalSections || scannedLocalSections.has(fileSection);
    if (
      !file.missingSince &&
      scannedStorageRootTypes.has(file.rootType as StorageRootType) &&
      scannedFileSection &&
      !seenStorageFilePaths.has(file.filePath) &&
      !isInsideUnscannedStorageDirectory(file, result.storageScanIssues)
    ) {
      await db.update(schema.storageFiles).set({ missingSince: timestamp, updatedAt: timestamp }).where(eq(schema.storageFiles.id, file.id));
      affectedStorageFilePolicyIds.add(file.id);
      if (file.rootType === "local") missingLocalFiles += 1;
      if (file.rootType === "remote") missingRemoteFiles += 1;
    }
  }

  if (result.options.scanSymlinks) {
    const currentStorageFiles = (await db.select().from(schema.storageFiles)).filter((file) => !file.missingSince);
    const storageFileIdByPath = new Map(currentStorageFiles.map((file) => [file.filePath, file.id]));
    const existingMediaLinks = await db.select().from(schema.mediaLinks);
    const existingMediaLinkByPath = new Map(existingMediaLinks.map((link) => [link.linkPath, link]));

    for (const link of result.links) {
      await throwIfPersistenceCancelled(isCancelled);
      const resolvedStorageFileId = storageFileIdByPath.get(link.targetPath) ?? null;
      const existing = existingMediaLinkByPath.get(link.linkPath);
      if (existing?.resolvedStorageFileId != null) affectedStorageFilePolicyIds.add(existing.resolvedStorageFileId);
      if (resolvedStorageFileId != null) affectedStorageFilePolicyIds.add(resolvedStorageFileId);
      const firstSeenAt = existing?.firstSeenAt ?? existing?.updatedAt ?? timestamp;
      const lastChangedAt = linkChanged(existing, link, resolvedStorageFileId) ? timestamp : existing?.lastChangedAt ?? existing?.updatedAt ?? timestamp;
      const values = {
        section: link.section,
        itemName: link.itemName,
        relativePath: link.relativePath,
        linkPath: link.linkPath,
        targetPath: link.targetPath,
        kind: link.kind,
        targetExists: link.targetExists,
        isMedia: link.isMedia,
        storagePolicy: link.storagePolicy,
        sizeBytes: link.sizeBytes,
        resolvedStorageFileId,
        firstSeenAt,
        lastSeenAt: timestamp,
        lastChangedAt,
        missingSince: null,
        lastSeenJobId: jobId,
        updatedAt: timestamp
      };
      await db
        .insert(schema.mediaLinks)
        .values(values)
        .onConflictDoUpdate({
          target: schema.mediaLinks.linkPath,
          set: { ...values, firstSeenAt, lastChangedAt }
        });
    }

    for (const link of existingMediaLinks) {
      await throwIfPersistenceCancelled(isCancelled);
      const scannedLinkScope = scannedSymlinkTitles
        ? scannedSymlinkTitles.has(scanTitleScopeKey(link.section, link.itemName))
        : !scannedSymlinkSections || scannedSymlinkSections.has(link.section);
      if (scannedLinkScope && link.resolvedStorageFileId != null) affectedStorageFilePolicyIds.add(link.resolvedStorageFileId);
      if (!link.missingSince && scannedLinkScope && !seenLinkPaths.has(link.linkPath)) {
        await db.update(schema.mediaLinks).set({ missingSince: timestamp, updatedAt: timestamp }).where(eq(schema.mediaLinks.id, link.id));
        missingLinks += 1;
      }
    }

    for (const summary of result.summaries) {
      await throwIfPersistenceCancelled(isCancelled);
      await db
        .insert(schema.sections)
        .values({ name: summary.section, contentType: summary.type, createdAt: timestamp, updatedAt: timestamp })
        .onConflictDoUpdate({
          target: schema.sections.name,
          set: { updatedAt: timestamp }
        });
    }
  }

  const symlinkOnlyReconciliation = result.options.scanSymlinks && !result.options.scanLocal && !result.options.scanRemote;
  const scannedStorageKinds = new Set<LinkKind>([
    ...(result.options.scanLocal ? (["local"] as const) : []),
    ...(result.options.scanRemote ? (["remote"] as const) : [])
  ]);
  await reconcileResolvedStorageFiles(
    db,
    timestamp,
    symlinkOnlyReconciliation
      ? result.options.titleScopes?.length
        ? { linkPaths: seenLinkPaths }
        : scannedSymlinkSections
          ? { sections: scannedSymlinkSections }
          : undefined
      : {
          ...(result.options.scanLocal && !result.options.scanRemote && scannedLocalSections ? { sections: scannedLocalSections } : {}),
          ...(scannedStorageKinds.size > 0 ? { kinds: scannedStorageKinds } : {})
        }
  );
  await throwIfPersistenceCancelled(isCancelled);
  await applyPendingOnboardingPolicy(db, jobId);
  await throwIfPersistenceCancelled(isCancelled);
  await reconcileStorageFilePolicies(db, timestamp, [...affectedStorageFilePolicyIds]);
  await throwIfPersistenceCancelled(isCancelled);

  const scannedLinks = (await db.select().from(schema.mediaLinks)).filter((link) => seenLinkPaths.has(link.linkPath) && !link.missingSince);
  const persistedLinkInventory = summarizeInventory(
    scannedLinks.map((link) => ({
      section: link.section,
      itemName: link.itemName,
      relativePath: link.relativePath,
      linkPath: link.linkPath,
      targetPath: link.targetPath,
      kind: link.kind as LinkKind,
      targetExists: link.targetExists,
      isMedia: link.isMedia,
      storagePolicy: normalizeStoragePolicy(link.storagePolicy),
      resolvedStorageFileId: link.resolvedStorageFileId,
      sizeBytes: link.sizeBytes,
      targetMtimeMs: null,
      targetReadError: null
    })),
    []
  );
  const currentLinkTargets = new Set(
    (await db.select({ targetPath: schema.mediaLinks.targetPath, missingSince: schema.mediaLinks.missingSince }).from(schema.mediaLinks))
      .filter((link) => !link.missingSince)
      .map((link) => link.targetPath)
  );
  const scannedFilePaths = new Set(result.storageFiles.map((file) => file.filePath));
  const scannedFiles = (await db.select().from(schema.storageFiles)).filter((file) => scannedFilePaths.has(file.filePath) && !file.missingSince);
  const unlinkedFiles = scannedFiles.filter((file) => !currentLinkTargets.has(file.filePath));
  const localFiles = scannedFiles.filter((file) => file.rootType === "local");
  const remoteFiles = scannedFiles.filter((file) => file.rootType === "remote");
  const unlinkedLocalFiles = unlinkedFiles.filter((file) => file.rootType === "local");
  const unlinkedRemoteFiles = unlinkedFiles.filter((file) => file.rootType === "remote");

  return {
    ...result.inventory,
    totalLinks: persistedLinkInventory.totalLinks,
    remoteLinks: persistedLinkInventory.remoteLinks,
    localLinks: persistedLinkInventory.localLinks,
    brokenLinks: persistedLinkInventory.brokenLinks,
    otherLinks: persistedLinkInventory.otherLinks,
    nonMediaLinks: persistedLinkInventory.nonMediaLinks,
    actionableRemoteLinks: persistedLinkInventory.actionableRemoteLinks,
    actionableLocalLinks: persistedLinkInventory.actionableLocalLinks,
    assignedRemoteLinks: persistedLinkInventory.assignedRemoteLinks,
    unassignedRemoteLinks: persistedLinkInventory.unassignedRemoteLinks,
    unassignedLocalLinks: persistedLinkInventory.unassignedLocalLinks,
    localFiles: localFiles.length,
    remoteFiles: remoteFiles.length,
    actionableRemoteFiles: 0,
    actionableLocalFiles: 0,
    assignedRemoteFiles: 0,
    unassignedRemoteFiles: unlinkedRemoteFiles.length,
    unassignedLocalFiles: unlinkedLocalFiles.length,
    localOrphanFiles: unlinkedLocalFiles.length,
    remoteOrphanFiles: unlinkedRemoteFiles.length,
    missingLinks,
    missingLocalFiles,
    missingRemoteFiles
  };
}

interface ResolvedStorageFileScope {
  linkPaths?: ReadonlySet<string>;
  sections?: ReadonlySet<string>;
  kinds?: ReadonlySet<LinkKind>;
}

async function reconcileResolvedStorageFiles(db: Db, timestamp: string, scope?: ResolvedStorageFileScope): Promise<void> {
  const currentStorageFiles = (await db.select().from(schema.storageFiles)).filter((file) => !file.missingSince);
  const storageFileIdByPath = new Map(currentStorageFiles.map((file) => [file.filePath, file.id]));
  for (const link of await db.select().from(schema.mediaLinks)) {
    if (
      link.missingSince ||
      (scope?.linkPaths && !scope.linkPaths.has(link.linkPath)) ||
      (scope?.sections && !scope.sections.has(link.section)) ||
      (scope?.kinds && !scope.kinds.has(link.kind as LinkKind))
    ) continue;
    const resolvedStorageFileId = storageFileIdByPath.get(link.targetPath) ?? null;
    if (link.resolvedStorageFileId !== resolvedStorageFileId) {
      await db.update(schema.mediaLinks).set({ resolvedStorageFileId, updatedAt: timestamp }).where(eq(schema.mediaLinks.id, link.id));
    }
  }
}

export async function getStoragePolicyMap(db: Db): Promise<Map<string, StoragePolicyKind>> {
  const rows = await db.select().from(schema.storagePolicies);
  return new Map(
    rows
      .map((row): [string, StoragePolicyKind] | null => {
        const titleKey = canonicalTitleKey(row.normalizedTitle);
        if (!titleKey) return null;
        if (row.policy !== "location_1" && row.policy !== "location_2") return null;
        return [titleKey, row.policy];
      })
      .filter((row): row is [string, StoragePolicyKind] => row !== null)
  );
}

function normalizeStoragePolicy(value: string | null | undefined): StoragePolicyKind {
  return value === "location_1" || value === "location_2" ? value : "unassigned";
}

function serializeMediaLink(row: typeof schema.mediaLinks.$inferSelect): MediaLinkRow {
  return {
    id: row.id,
    section: row.section,
    itemName: row.itemName,
    relativePath: row.relativePath,
    linkPath: row.linkPath,
    targetPath: row.targetPath,
    kind: row.kind as LinkKind,
    targetExists: row.targetExists,
    isMedia: row.isMedia,
    storagePolicy: normalizeStoragePolicy(row.storagePolicy),
    resolvedStorageFileId: row.resolvedStorageFileId,
    sizeBytes: row.sizeBytes,
    firstSeenAt: row.firstSeenAt ?? row.updatedAt,
    lastSeenAt: row.lastSeenAt ?? row.updatedAt,
    lastChangedAt: row.lastChangedAt ?? row.updatedAt,
    missingSince: row.missingSince,
    updatedAt: row.updatedAt
  };
}

type MediaLinkStatusFilter = "current" | "missing" | "all";

type MediaLinkListFilters = {
  kind?: LinkKind;
  status?: MediaLinkStatusFilter;
  section?: string;
  storagePolicy?: StoragePolicyKind;
  relativePathPrefix?: string;
  search?: string;
};

function normalizeRelativeFilterPrefix(prefix = ""): string {
  return prefix.replace(/\\/g, "/").split("/").filter(Boolean).join("/");
}

function mediaLinkFilters(options: MediaLinkListFilters) {
  const status = options.status ?? "current";
  const filters: SQL[] = [];
  if (options.kind) filters.push(eq(schema.mediaLinks.kind, options.kind));
  if (options.section) filters.push(eq(schema.mediaLinks.section, options.section));
  if (options.storagePolicy) filters.push(eq(schema.mediaLinks.storagePolicy, options.storagePolicy));
  const relativePathPrefix = normalizeRelativeFilterPrefix(options.relativePathPrefix);
  if (relativePathPrefix) {
    filters.push(sql`(${schema.mediaLinks.relativePath} = ${relativePathPrefix} or ${schema.mediaLinks.relativePath} like ${`${relativePathPrefix}/%`})`);
  }
  const search = options.search?.trim().toLowerCase();
  if (search) {
    const pattern = `%${search}%`;
    filters.push(sql`(
      lower(${schema.mediaLinks.itemName}) like ${pattern}
      or lower(${schema.mediaLinks.relativePath}) like ${pattern}
      or lower(${schema.mediaLinks.linkPath}) like ${pattern}
      or lower(${schema.mediaLinks.targetPath}) like ${pattern}
    )`);
  }
  if (status === "current") filters.push(isNull(schema.mediaLinks.missingSince));
  if (status === "missing") filters.push(isNotNull(schema.mediaLinks.missingSince));
  return filters.length > 0 ? and(...filters) : undefined;
}

export async function listMediaLinks(db: Db, kind?: LinkKind, status: MediaLinkStatusFilter = "current", filters: Pick<MediaLinkListFilters, "section" | "storagePolicy"> = {}): Promise<MediaLinkRow[]> {
  const where = mediaLinkFilters({ kind, status, ...filters });
  const rows = where ? await db.select().from(schema.mediaLinks).where(where) : await db.select().from(schema.mediaLinks);
  return rows.map(serializeMediaLink);
}

export async function listMediaLinksByIds(db: Db, ids: number[]): Promise<MediaLinkRow[]> {
  const uniqueIds = [...new Set(ids)];
  if (uniqueIds.length === 0) return [];

  const rows = await db.select().from(schema.mediaLinks).where(inArray(schema.mediaLinks.id, uniqueIds));
  const rowById = new Map(rows.map((row) => [row.id, row]));
  return uniqueIds
    .map((id) => rowById.get(id))
    .filter((row): row is typeof schema.mediaLinks.$inferSelect => Boolean(row))
    .map(serializeMediaLink);
}

export function listMediaLinksPage(
  db: Db,
  options: MediaLinkListFilters & { limit: number; offset: number }
): Promise<MediaLinksPage> {
  const status = options.status ?? "current";
  const where = mediaLinkFilters({ ...options, status });
  return listMediaLinksPageRows(db, options, where);
}

async function listMediaLinksPageRows(
  db: Db,
  options: MediaLinkListFilters & { limit: number; offset: number },
  where: SQL<unknown> | undefined
): Promise<MediaLinksPage> {
  const rows = where
    ? await db.select().from(schema.mediaLinks).where(where).orderBy(desc(schema.mediaLinks.id)).limit(options.limit).offset(options.offset)
    : await db.select().from(schema.mediaLinks).orderBy(desc(schema.mediaLinks.id)).limit(options.limit).offset(options.offset);
  const totalRow = where
    ? await first(db.select({ value: count() }).from(schema.mediaLinks).where(where).limit(1))
    : await first(db.select({ value: count() }).from(schema.mediaLinks).limit(1));
  const total = Number(totalRow?.value ?? 0);
  return {
    rows: rows.map(serializeMediaLink),
    total,
    limit: options.limit,
    offset: options.offset,
    hasMore: options.offset + rows.length < total
  };
}

function normalizeTreePrefix(prefix = ""): string {
  return prefix
    .replace(/\\/g, "/")
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean)
    .join("/");
}

function parentTreePrefix(prefix: string): string | null {
  const parts = prefix.split("/").filter(Boolean);
  if (parts.length <= 1) return null;
  return parts.slice(0, -1).join("/");
}

function mediaLinkTreeWhere(options: { section: string; kind?: MediaLinkTreeKindFilter; status?: "current" | "missing" | "all" }, prefix: string) {
  const status = options.status ?? "current";
  const filters: SQL<unknown>[] = [sql`ml.section = ${options.section}`];
  if (options.kind && options.kind !== "mixed") filters.push(sql`ml.kind = ${options.kind}`);
  if (status === "current") filters.push(sql`ml.missing_since is null`);
  if (status === "missing") filters.push(sql`ml.missing_since is not null`);
  if (prefix) filters.push(sql`substr(ml.relative_path, 1, ${prefix.length + 1}) = ${`${prefix}/`}`);
  return sql.join(filters, sql` and `);
}

function mediaLinkRemainingSql(prefix: string): SQL<unknown> {
  return prefix ? sql`substr(ml.relative_path, ${prefix.length + 2})` : sql`ml.relative_path`;
}

type MediaLinkTreeAggregateRow = {
  name: string;
  isFolder: number;
  totalLinks: number;
  childFolderCount: number;
  remoteLinks: number;
  localLinks: number;
  brokenLinks: number;
  otherLinks: number;
  nonMediaLinks: number;
  actionableRemoteLinks: number;
  actionableLocalLinks: number;
  assignedRemoteLinks: number;
  unassignedRemoteLinks: number;
  unassignedLocalLinks: number;
};

type RawMediaLinkRow = {
  id: number;
  section: string;
  itemName: string;
  relativePath: string;
  linkPath: string;
  targetPath: string;
  kind: string;
  targetExists: number | boolean;
  isMedia: number | boolean;
  storagePolicy: string | null;
  resolvedStorageFileId: number | null;
  sizeBytes: number | null;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
  lastChangedAt: string | null;
  missingSince: string | null;
  updatedAt: string;
};

function serializeRawMediaLink(row: RawMediaLinkRow): MediaLinkRow {
  return {
    id: row.id,
    section: row.section,
    itemName: row.itemName,
    relativePath: row.relativePath,
    linkPath: row.linkPath,
    targetPath: row.targetPath,
    kind: row.kind as LinkKind,
    targetExists: Boolean(row.targetExists),
    isMedia: Boolean(row.isMedia),
    storagePolicy: normalizeStoragePolicy(row.storagePolicy),
    resolvedStorageFileId: row.resolvedStorageFileId,
    sizeBytes: row.sizeBytes,
    firstSeenAt: row.firstSeenAt ?? row.updatedAt,
    lastSeenAt: row.lastSeenAt ?? row.updatedAt,
    lastChangedAt: row.lastChangedAt ?? row.updatedAt,
    missingSince: row.missingSince,
    updatedAt: row.updatedAt
  };
}

export function listMediaLinkTree(
  db: Db,
  options: { section: string; prefix?: string; kind?: MediaLinkTreeKindFilter; status?: "current" | "missing" | "all" }
): Promise<MediaLinkTree> {
  return listMediaLinkTreeRows(db, options);
}

async function listMediaLinkTreeRows(
  db: Db,
  options: { section: string; prefix?: string; kind?: MediaLinkTreeKindFilter; status?: "current" | "missing" | "all" }
): Promise<MediaLinkTree> {
  const prefix = normalizeTreePrefix(options.prefix);
  const where = mediaLinkTreeWhere(options, prefix);
  const remaining = mediaLinkRemainingSql(prefix);
  const mixedHaving =
    options.kind === "mixed" && !prefix
      ? sql`having sum(case when kind = 'remote' then 1 else 0 end) > 0 and sum(case when kind = 'local' then 1 else 0 end) > 0`
      : sql``;
  const rows = await dbAll<MediaLinkTreeAggregateRow>(db, sql`
    with tree_rows as (
      select
        case
          when position('/' in ${remaining}) > 0 then substring(${remaining} from 1 for position('/' in ${remaining}) - 1)
          else ${remaining}
        end as name,
        case when position('/' in ${remaining}) > 0 then true else false end as is_folder,
        case
          when position('/' in ${remaining}) > 0 then substring(${remaining} from position('/' in ${remaining}) + 1)
          else ''
        end as child_path,
        ml.kind as kind,
        ml.storage_policy as storage_policy
      from media_links ml
      where ${where}
        and ${remaining} <> ''
    )
    select
      name,
      is_folder as "isFolder",
      count(*) as "totalLinks",
      count(distinct case
        when position('/' in child_path) > 0 then substring(child_path from 1 for position('/' in child_path) - 1)
        else null
      end) as "childFolderCount",
      sum(case when kind = 'remote' then 1 else 0 end) as "remoteLinks",
      sum(case when kind = 'local' then 1 else 0 end) as "localLinks",
      sum(case when kind = 'broken' then 1 else 0 end) as "brokenLinks",
      sum(case when kind = 'other' then 1 else 0 end) as "otherLinks",
      sum(case when kind = 'non_media' then 1 else 0 end) as "nonMediaLinks",
      sum(case when kind = 'remote' and storage_policy = 'location_1' then 1 else 0 end) as "actionableRemoteLinks",
      sum(case when kind = 'local' and storage_policy = 'location_2' then 1 else 0 end) as "actionableLocalLinks",
      sum(case when kind = 'remote' and storage_policy = 'location_2' then 1 else 0 end) as "assignedRemoteLinks",
      sum(case when kind = 'remote' and storage_policy = 'unassigned' then 1 else 0 end) as "unassignedRemoteLinks",
      sum(case when kind = 'local' and storage_policy = 'unassigned' then 1 else 0 end) as "unassignedLocalLinks"
    from tree_rows
    group by name, is_folder
    ${mixedHaving}
    order by is_folder desc, lower(name)
  `);
  const directLinks = await dbAll<RawMediaLinkRow>(db, sql`
    select
      ml.id,
      ml.section,
      ml.item_name as "itemName",
      ml.relative_path as "relativePath",
      ml.link_path as "linkPath",
      ml.target_path as "targetPath",
      ml.kind,
      ml.target_exists as "targetExists",
      ml.is_media as "isMedia",
      ml.storage_policy as "storagePolicy",
      ml.resolved_storage_file_id as "resolvedStorageFileId",
      ml.size_bytes as "sizeBytes",
      ml.first_seen_at as "firstSeenAt",
      ml.last_seen_at as "lastSeenAt",
      ml.last_changed_at as "lastChangedAt",
      ml.missing_since as "missingSince",
      ml.updated_at as "updatedAt"
    from media_links ml
    where ${where}
      and position('/' in ${remaining}) = 0
    order by lower(${remaining})
  `);
  const linkByPath = new Map(directLinks.map((link) => [link.relativePath, serializeRawMediaLink(link)]));
  const nodes: MediaLinkTreeNode[] = rows.map((row) => {
    const path = prefix ? `${prefix}/${row.name}` : row.name;
    return {
      type: row.isFolder ? "folder" : "link",
      name: row.name,
      path,
      totalLinks: Number(row.totalLinks ?? 0),
      childFolderCount: Number(row.childFolderCount ?? 0),
      remoteLinks: Number(row.remoteLinks ?? 0),
      localLinks: Number(row.localLinks ?? 0),
      brokenLinks: Number(row.brokenLinks ?? 0),
      otherLinks: Number(row.otherLinks ?? 0),
      nonMediaLinks: Number(row.nonMediaLinks ?? 0),
      actionableRemoteLinks: Number(row.actionableRemoteLinks ?? 0),
      actionableLocalLinks: Number(row.actionableLocalLinks ?? 0),
      assignedRemoteLinks: Number(row.assignedRemoteLinks ?? 0),
      unassignedRemoteLinks: Number(row.unassignedRemoteLinks ?? 0),
      unassignedLocalLinks: Number(row.unassignedLocalLinks ?? 0),
      link: row.isFolder ? null : linkByPath.get(path) ?? null
    };
  });

  return {
    section: options.section,
    prefix,
    parentPrefix: parentTreePrefix(prefix),
    totalLinks: nodes.reduce((total, node) => total + node.totalLinks, 0),
    nodes
  };
}

export async function listStorageFiles(db: Db, rootType?: StorageRootType, orphanOnly = false, status: "current" | "missing" | "all" = "current"): Promise<StorageFileRow[]> {
  const linkCountByStorageId = new Map<number, number>();
  for (const link of await db.select().from(schema.mediaLinks)) {
    if (link.missingSince || link.resolvedStorageFileId == null) continue;
    linkCountByStorageId.set(link.resolvedStorageFileId, (linkCountByStorageId.get(link.resolvedStorageFileId) ?? 0) + 1);
  }
  return (await db.select().from(schema.storageFiles))
    .filter((row) => !rootType || row.rootType === rootType)
    .filter((row) => status === "all" || (status === "current" ? !row.missingSince : Boolean(row.missingSince)))
    .map((row) => {
      const linkCount = linkCountByStorageId.get(row.id) ?? 0;
      return {
        id: row.id,
        rootType: row.rootType as StorageRootType,
        rootPath: row.rootPath,
        section: row.section,
        itemName: row.itemName,
        relativePath: row.relativePath,
        filePath: row.filePath,
        storagePolicy: normalizeStoragePolicy(row.storagePolicy),
        sizeBytes: row.sizeBytes,
        mtimeMs: row.mtimeMs,
        firstSeenAt: row.firstSeenAt,
        lastSeenAt: row.lastSeenAt,
        lastChangedAt: row.lastChangedAt,
        missingSince: row.missingSince,
        updatedAt: row.updatedAt,
        linkCount,
        linked: linkCount > 0
      };
    })
    .filter((row) => !orphanOnly || !row.linked);
}

type StorageFileTreeAggregateRow = {
  name: string;
  isFolder: number;
  totalFiles: number;
  childFolderCount: number;
  linkedFiles: number;
  orphanFiles: number;
  actionableRemoteFiles: number;
  actionableLocalFiles: number;
  assignedRemoteFiles: number;
  unassignedRemoteFiles: number;
  unassignedLocalFiles: number;
  sizeBytes: number;
  mtimeMs: number | null;
};

type RawStorageFileRow = {
  id: number;
  rootType: string;
  rootPath: string;
  section: string;
  itemName: string;
  relativePath: string;
  filePath: string;
  storagePolicy: string | null;
  sizeBytes: number;
  mtimeMs: number;
  firstSeenAt: string;
  lastSeenAt: string;
  lastChangedAt: string;
  missingSince: string | null;
  updatedAt: string;
  linkCount: number;
};

function serializeRawStorageFile(row: RawStorageFileRow): StorageFileRow {
  const linkCount = Number(row.linkCount ?? 0);
  return {
    id: row.id,
    rootType: row.rootType as StorageRootType,
    rootPath: row.rootPath,
    section: row.section,
    itemName: row.itemName,
    relativePath: row.relativePath,
    filePath: row.filePath,
    storagePolicy: normalizeStoragePolicy(row.storagePolicy),
    sizeBytes: row.sizeBytes,
    mtimeMs: row.mtimeMs,
    firstSeenAt: row.firstSeenAt,
    lastSeenAt: row.lastSeenAt,
    lastChangedAt: row.lastChangedAt,
    missingSince: row.missingSince,
    updatedAt: row.updatedAt,
    linkCount,
    linked: linkCount > 0
  };
}

function storageFileTreeWhere(options: { rootType: StorageRootType; orphanOnly?: boolean; status?: "current" | "missing" | "all" }, prefix: string) {
  const status = options.status ?? "current";
  const filters: SQL<unknown>[] = [sql`sf.root_type = ${options.rootType}`];
  if (status === "current") filters.push(sql`sf.missing_since is null`);
  if (status === "missing") filters.push(sql`sf.missing_since is not null`);
  if (options.orphanOnly) {
    filters.push(sql`not exists (
      select 1
      from media_links ml
      where ml.missing_since is null and ml.resolved_storage_file_id = sf.id
    )`);
  }
  if (prefix) filters.push(sql`substr(sf.relative_path, 1, ${prefix.length + 1}) = ${`${prefix}/`}`);
  return sql.join(filters, sql` and `);
}

function storageFileRemainingSql(prefix: string): SQL<unknown> {
  return prefix ? sql`substr(sf.relative_path, ${prefix.length + 2})` : sql`sf.relative_path`;
}

export function listStorageFileTree(
  db: Db,
  options: { rootType: StorageRootType; prefix?: string; orphanOnly?: boolean; status?: "current" | "missing" | "all" }
): Promise<StorageFileTree> {
  return listStorageFileTreeRows(db, options);
}

async function listStorageFileTreeRows(
  db: Db,
  options: { rootType: StorageRootType; prefix?: string; orphanOnly?: boolean; status?: "current" | "missing" | "all" }
): Promise<StorageFileTree> {
  const prefix = normalizeTreePrefix(options.prefix);
  const where = storageFileTreeWhere(options, prefix);
  const remaining = storageFileRemainingSql(prefix);
  const rows = await dbAll<StorageFileTreeAggregateRow>(db, sql`
    with tree_rows as (
      select
        case
          when position('/' in ${remaining}) > 0 then substring(${remaining} from 1 for position('/' in ${remaining}) - 1)
          else ${remaining}
        end as name,
        case when position('/' in ${remaining}) > 0 then true else false end as is_folder,
        case
          when position('/' in ${remaining}) > 0 then substring(${remaining} from position('/' in ${remaining}) + 1)
          else ''
        end as child_path,
        exists (
          select 1
          from media_links ml
          where ml.missing_since is null and ml.resolved_storage_file_id = sf.id
        ) as linked,
        sf.root_type as root_type,
        sf.storage_policy as storage_policy,
        sf.size_bytes as size_bytes,
        sf.mtime_ms as mtime_ms
      from storage_files sf
      where ${where}
        and ${remaining} <> ''
    )
    select
      name,
      is_folder as "isFolder",
      count(*) as "totalFiles",
      count(distinct case
        when position('/' in child_path) > 0 then substring(child_path from 1 for position('/' in child_path) - 1)
        else null
      end) as "childFolderCount",
      sum(case when linked then 1 else 0 end) as "linkedFiles",
      sum(case when linked then 0 else 1 end) as "orphanFiles",
      sum(case when linked = false and root_type = 'remote' and storage_policy = 'location_1' then 1 else 0 end) as "actionableRemoteFiles",
      sum(case when linked = false and root_type = 'local' and storage_policy = 'location_2' then 1 else 0 end) as "actionableLocalFiles",
      sum(case when linked = false and root_type = 'remote' and storage_policy = 'location_2' then 1 else 0 end) as "assignedRemoteFiles",
      sum(case when linked = false and root_type = 'remote' and storage_policy = 'unassigned' then 1 else 0 end) as "unassignedRemoteFiles",
      sum(case when linked = false and root_type = 'local' and storage_policy = 'unassigned' then 1 else 0 end) as "unassignedLocalFiles",
      sum(size_bytes) as "sizeBytes",
      max(mtime_ms) as "mtimeMs"
    from tree_rows
    group by name, is_folder
    order by is_folder desc, lower(name)
  `);
  const directFiles = await dbAll<RawStorageFileRow>(db, sql`
    select
      sf.id,
      sf.root_type as "rootType",
      sf.root_path as "rootPath",
      sf.section,
      sf.item_name as "itemName",
      sf.relative_path as "relativePath",
      sf.file_path as "filePath",
      sf.storage_policy as "storagePolicy",
      sf.size_bytes as "sizeBytes",
      sf.mtime_ms as "mtimeMs",
      sf.first_seen_at as "firstSeenAt",
      sf.last_seen_at as "lastSeenAt",
      sf.last_changed_at as "lastChangedAt",
      sf.missing_since as "missingSince",
      sf.updated_at as "updatedAt",
      (
        select count(*)
        from media_links ml
        where ml.missing_since is null and ml.resolved_storage_file_id = sf.id
      ) as "linkCount"
    from storage_files sf
    where ${where}
      and position('/' in ${remaining}) = 0
    order by lower(${remaining})
  `);
  const fileByPath = new Map(directFiles.map((file) => [file.relativePath, serializeRawStorageFile(file)]));
  const nodes: StorageFileTreeNode[] = rows.map((row) => {
    const nodePath = prefix ? `${prefix}/${row.name}` : row.name;
    return {
      type: row.isFolder ? "folder" : "file",
      name: row.name,
      path: nodePath,
      totalFiles: Number(row.totalFiles ?? 0),
      childFolderCount: Number(row.childFolderCount ?? 0),
      linkedFiles: Number(row.linkedFiles ?? 0),
      orphanFiles: Number(row.orphanFiles ?? 0),
      actionableRemoteFiles: Number(row.actionableRemoteFiles ?? 0),
      actionableLocalFiles: Number(row.actionableLocalFiles ?? 0),
      assignedRemoteFiles: Number(row.assignedRemoteFiles ?? 0),
      unassignedRemoteFiles: Number(row.unassignedRemoteFiles ?? 0),
      unassignedLocalFiles: Number(row.unassignedLocalFiles ?? 0),
      sizeBytes: Number(row.sizeBytes ?? 0),
      mtimeMs: row.mtimeMs == null ? null : Number(row.mtimeMs),
      file: row.isFolder ? null : fileByPath.get(nodePath) ?? null
    };
  });

  return {
    rootType: options.rootType,
    prefix,
    parentPrefix: parentTreePrefix(prefix),
    totalFiles: nodes.reduce((total, node) => total + node.totalFiles, 0),
    nodes
  };
}

export async function getInventorySummary(db: Db): Promise<InventorySummary> {
  const [links, files] = await Promise.all([
    dbGet<Record<string, number>>(db, sql`
      select
        count(*) filter (where missing_since is null) as "totalLinks",
        count(*) filter (where missing_since is null and kind = 'remote') as "remoteLinks",
        count(*) filter (where missing_since is null and kind = 'local') as "localLinks",
        count(*) filter (where missing_since is null and kind = 'broken') as "brokenLinks",
        count(*) filter (where missing_since is null and kind = 'other') as "otherLinks",
        count(*) filter (where missing_since is null and kind = 'non_media') as "nonMediaLinks",
        count(*) filter (where missing_since is null and kind = 'remote' and storage_policy = 'location_1') as "actionableRemoteLinks",
        count(*) filter (where missing_since is null and kind = 'local' and storage_policy = 'location_2') as "actionableLocalLinks",
        count(*) filter (where missing_since is null and kind = 'remote' and storage_policy = 'location_2') as "assignedRemoteLinks",
        count(*) filter (where missing_since is null and kind = 'remote' and storage_policy = 'unassigned') as "unassignedRemoteLinks",
        count(*) filter (where missing_since is null and kind = 'local' and storage_policy = 'unassigned') as "unassignedLocalLinks",
        count(*) filter (where missing_since is not null) as "missingLinks"
      from media_links
    `),
    dbGet<Record<string, number>>(db, sql`
      with file_state as (
        select
          sf.root_type,
          sf.missing_since,
          not exists (
            select 1
            from media_links ml
            where ml.missing_since is null
              and ml.resolved_storage_file_id = sf.id
          ) as orphaned
        from storage_files sf
      )
      select
        count(*) filter (where missing_since is null and root_type = 'local') as "localFiles",
        count(*) filter (where missing_since is null and root_type = 'remote') as "remoteFiles",
        count(*) filter (where missing_since is null and root_type = 'remote' and orphaned) as "unassignedRemoteFiles",
        count(*) filter (where missing_since is null and root_type = 'local' and orphaned) as "unassignedLocalFiles",
        count(*) filter (where missing_since is null and root_type = 'local' and orphaned) as "localOrphanFiles",
        count(*) filter (where missing_since is null and root_type = 'remote' and orphaned) as "remoteOrphanFiles",
        count(*) filter (where missing_since is not null and root_type = 'local') as "missingLocalFiles",
        count(*) filter (where missing_since is not null and root_type = 'remote') as "missingRemoteFiles"
      from file_state
    `)
  ]);
  const linkCount = (key: string) => Number(links?.[key] ?? 0);
  const fileCount = (key: string) => Number(files?.[key] ?? 0);
  return {
    totalLinks: linkCount("totalLinks"),
    remoteLinks: linkCount("remoteLinks"),
    localLinks: linkCount("localLinks"),
    brokenLinks: linkCount("brokenLinks"),
    otherLinks: linkCount("otherLinks"),
    nonMediaLinks: linkCount("nonMediaLinks"),
    actionableRemoteLinks: linkCount("actionableRemoteLinks"),
    actionableLocalLinks: linkCount("actionableLocalLinks"),
    assignedRemoteLinks: linkCount("assignedRemoteLinks"),
    unassignedRemoteLinks: linkCount("unassignedRemoteLinks"),
    unassignedLocalLinks: linkCount("unassignedLocalLinks"),
    localFiles: fileCount("localFiles"),
    remoteFiles: fileCount("remoteFiles"),
    actionableRemoteFiles: 0,
    actionableLocalFiles: 0,
    assignedRemoteFiles: 0,
    unassignedRemoteFiles: fileCount("unassignedRemoteFiles"),
    unassignedLocalFiles: fileCount("unassignedLocalFiles"),
    localOrphanFiles: fileCount("localOrphanFiles"),
    remoteOrphanFiles: fileCount("remoteOrphanFiles"),
    missingLinks: linkCount("missingLinks"),
    missingLocalFiles: fileCount("missingLocalFiles"),
    missingRemoteFiles: fileCount("missingRemoteFiles")
  };
}

type SectionScanTimestampRow = {
  section: string | null;
  lastSeenAt: string | null;
};

type CompletedScanTimestampRow = {
  startedAt: string;
  finishedAt: string | null;
  progress: string;
  options: string;
};

function recordFromUnknown(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function stringArrayFromUnknown(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.filter((section): section is string => typeof section === "string") : undefined;
}

function scanTitleScopesFromUnknown(value: unknown): ScanTitleScope[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value
    .map((scope) => recordFromUnknown(scope))
    .filter((scope): scope is Record<string, unknown> => Boolean(scope))
    .filter((scope) => typeof scope.section === "string" && typeof scope.itemName === "string")
    .map((scope) => ({ section: String(scope.section), itemName: String(scope.itemName) }));
}

function scanOptionsFromProgress(progress: string, optionsJson: string): Partial<ScanOptions> | null {
  try {
    const parsed = recordFromUnknown(JSON.parse(progress));
    const options = recordFromUnknown(JSON.parse(optionsJson)) ?? recordFromUnknown(parsed?.options);
    if (!options) return null;
    return {
      scanSymlinks: options.scanSymlinks === true,
      scanLocal: options.scanLocal === true,
      scanRemote: options.scanRemote === true,
      symlinkSections: stringArrayFromUnknown(options.symlinkSections),
      localSections: stringArrayFromUnknown(options.localSections),
      titleScopes: scanTitleScopesFromUnknown(options.titleScopes),
      sections: stringArrayFromUnknown(options.sections)
    };
  } catch {
    return null;
  }
}

function setLatestTimestamp(timestamps: Map<string, string>, key: string, value: string | null): void {
  if (!value) return;
  const current = timestamps.get(key);
  if (!current || Date.parse(value) > Date.parse(current)) timestamps.set(key, value);
}

function selectedScanSections(sections: string[] | undefined, legacySections: string[] | undefined, configuredSections: string[]): string[] {
  const selectedSections = sections ?? legacySections ?? configuredSections;
  const configured = new Set(configuredSections);
  return [...new Set(selectedSections)].filter((section) => configured.has(section));
}

export async function getInventoryScanTimestamps(db: Db): Promise<InventoryScanTimestamps> {
  const configuredSections = (await getSectionSettings(db)).sections;
  const symlinkSectionTimestamps = new Map<string, string>();
  const localSectionTimestamps = new Map<string, string>();
  let remoteRoot: string | null = null;

  const completedScans = await dbAll<CompletedScanTimestampRow>(db, sql`
    select sr.started_at as "startedAt", sr.finished_at as "finishedAt", j.progress as progress, j.options as options
    from scan_runs sr
    join jobs j on j.id = sr.job_id
    where sr.status = 'completed'
    order by sr.finished_at asc, sr.started_at asc
  `);

  for (const scan of completedScans) {
    const options = scanOptionsFromProgress(scan.progress, scan.options);
    if (!options) continue;
    const timestamp = scan.finishedAt ?? scan.startedAt;

    if (options.scanSymlinks && !options.titleScopes?.length) {
      for (const section of selectedScanSections(options.symlinkSections, options.sections, configuredSections)) setLatestTimestamp(symlinkSectionTimestamps, section, timestamp);
    }

    if (options.scanLocal) {
      for (const section of selectedScanSections(options.localSections, options.sections, configuredSections)) setLatestTimestamp(localSectionTimestamps, section, timestamp);
    }

    if (options.scanRemote && (!remoteRoot || Date.parse(timestamp) > Date.parse(remoteRoot))) remoteRoot = timestamp;
  }

  const symlinkRows = await dbAll<SectionScanTimestampRow>(db, sql`
    select section, max(last_seen_at) as "lastSeenAt"
    from media_links
    where missing_since is null
    group by section
  `);
  const localRows = await dbAll<SectionScanTimestampRow>(db, sql`
    select section, max("lastSeenAt") as "lastSeenAt"
    from (
      select
        case
          when position('/' in relative_path) > 0 then substring(relative_path from 1 for position('/' in relative_path) - 1)
          else relative_path
        end as section,
        last_seen_at as "lastSeenAt"
      from storage_files
      where root_type = 'local' and missing_since is null
    ) local_scan_timestamps
    group by section
  `);
  const remoteRow = await dbGet<{ lastSeenAt: string | null }>(db, sql`
    select max(last_seen_at) as "lastSeenAt"
    from storage_files
    where root_type = 'remote' and missing_since is null
  `);

  for (const row of symlinkRows) {
    if (row.section && !symlinkSectionTimestamps.has(row.section)) setLatestTimestamp(symlinkSectionTimestamps, row.section, row.lastSeenAt);
  }

  for (const row of localRows) {
    if (row.section) setLatestTimestamp(localSectionTimestamps, row.section, row.lastSeenAt);
  }

  if (remoteRow?.lastSeenAt && (!remoteRoot || Date.parse(remoteRow.lastSeenAt) > Date.parse(remoteRoot))) remoteRoot = remoteRow.lastSeenAt;

  return {
    symlinkSections: Object.fromEntries(symlinkSectionTimestamps),
    localSections: Object.fromEntries(localSectionTimestamps),
    remoteRoot
  };
}

export async function listSectionSummaries(db: Db): Promise<SectionSummary[]> {
  const sectionRows = await db.select().from(schema.sections);
  const sectionTitles = Object.fromEntries(sectionRows.map((row) => [row.name, row.displayName]));
  const sectionTypes = Object.fromEntries(sectionRows.map((row) => [row.name, row.contentType as SectionContentType | null]));
  const sections = sectionRows.map((row) => row.name);
  const links = (await listMediaLinks(db)).map((row) => ({
    section: row.section,
    itemName: row.itemName,
    relativePath: row.relativePath,
    linkPath: row.linkPath,
    targetPath: row.targetPath,
    kind: row.kind,
    targetExists: row.targetExists,
    isMedia: row.isMedia,
    storagePolicy: row.storagePolicy,
    sizeBytes: row.sizeBytes,
    targetMtimeMs: null,
    targetReadError: null
  }));
  return summarizeLinks(links, sections, sectionTitles, sectionTypes);
}
