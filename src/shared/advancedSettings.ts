import type {
  AdvancedSettings,
  AuditJobBehaviorSettings,
  CleanupSettings,
  CopyJobBehaviorSettings,
  CopyMediaValidationMode,
  CopyVerificationProfile,
  ScanJobBehaviorSettings
} from "./types";

const copyProfiles: CopyVerificationProfile[] = ["off", "fast", "balanced", "deep", "custom"];
const mediaValidationModes: CopyMediaValidationMode[] = ["off", "fast", "deep"];

export function copyBehaviorForProfile(profile: CopyVerificationProfile): CopyJobBehaviorSettings {
  if (profile === "off") return { profile, byteCompare: false, mediaValidation: "off" };
  if (profile === "fast") return { profile, byteCompare: true, mediaValidation: "off" };
  if (profile === "deep") return { profile, byteCompare: true, mediaValidation: "deep" };
  if (profile === "custom") return { profile, byteCompare: true, mediaValidation: "fast" };
  return { profile: "balanced", byteCompare: true, mediaValidation: "fast" };
}

export const defaultCopyJobBehaviorSettings: CopyJobBehaviorSettings = copyBehaviorForProfile("balanced");

export const defaultAuditJobBehaviorSettings: AuditJobBehaviorSettings = {
  defaultMode: "fast",
  byteCompareWhenSourceKnown: true
};

export const defaultScanJobBehaviorSettings: ScanJobBehaviorSettings = {
  symlinkFolderScheduling: "single_job",
  includeRemoteWithSymlinkScans: true,
  scheduledInventory: { enabled: true, hour: 5 }
};

export const defaultCleanupSettings: CleanupSettings = {
  holdDays: 7,
  deleteRemoteSourceAfterCopy: false,
  reRequestsPerMinute: 6,
  // A remote mount can bring a deleted file back by itself. Two minutes covers several of its refresh cycles
  // (30 seconds by default on the usual mount), so a file that comes back is caught by the purge that deleted it.
  purgeRecheckSeconds: 120,
  // Some remote mounts show another copy of a release at the same path as soon as the last file of its folder is
  // deleted. A few seconds is enough for that, and is paid once per remote folder whose last video a purge deletes.
  purgeSettleSeconds: 3
};

export const maxPurgeRecheckSeconds = 3600;
export const maxPurgeSettleSeconds = 60;

export const defaultAdvancedSettings: AdvancedSettings = {
  scan: defaultScanJobBehaviorSettings,
  copy: defaultCopyJobBehaviorSettings,
  audit: defaultAuditJobBehaviorSettings,
  cleanup: defaultCleanupSettings
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function normalizeCopyBehavior(value: unknown): CopyJobBehaviorSettings {
  const record = isRecord(value) ? value : {};
  const profile = copyProfiles.includes(record.profile as CopyVerificationProfile) ? (record.profile as CopyVerificationProfile) : defaultCopyJobBehaviorSettings.profile;
  if (profile !== "custom") return copyBehaviorForProfile(profile);

  const byteCompare = typeof record.byteCompare === "boolean" ? record.byteCompare : defaultCopyJobBehaviorSettings.byteCompare;
  const mediaValidation = mediaValidationModes.includes(record.mediaValidation as CopyMediaValidationMode)
    ? (record.mediaValidation as CopyMediaValidationMode)
    : defaultCopyJobBehaviorSettings.mediaValidation;

  if (!byteCompare && mediaValidation === "off") return { ...copyBehaviorForProfile("custom"), profile: "custom" };
  return { profile, byteCompare, mediaValidation };
}

function normalizeAuditBehavior(value: unknown): AuditJobBehaviorSettings {
  const record = isRecord(value) ? value : {};
  return {
    defaultMode: record.defaultMode === "deep" ? "deep" : "fast",
    byteCompareWhenSourceKnown: record.byteCompareWhenSourceKnown !== false
  };
}

function normalizeScanBehavior(value: unknown): ScanJobBehaviorSettings {
  const record = isRecord(value) ? value : {};
  const scheduled = isRecord(record.scheduledInventory) ? record.scheduledInventory : {};
  const hour = Number(scheduled.hour);
  return {
    symlinkFolderScheduling: record.symlinkFolderScheduling === "per_folder" ? "per_folder" : "single_job",
    includeRemoteWithSymlinkScans: record.includeRemoteWithSymlinkScans !== false,
    scheduledInventory: {
      enabled: scheduled.enabled !== false,
      hour: Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : defaultScanJobBehaviorSettings.scheduledInventory.hour
    }
  };
}

function normalizeCleanup(value: unknown): CleanupSettings {
  const record = isRecord(value) ? value : {};
  const holdDays = Number(record.holdDays);
  const reRequestsPerMinute = Number(record.reRequestsPerMinute);
  const purgeRecheckSeconds = Number(record.purgeRecheckSeconds);
  const purgeSettleSeconds = Number(record.purgeSettleSeconds);
  return {
    holdDays: Number.isInteger(holdDays) && holdDays >= 1 && holdDays <= 90 ? holdDays : defaultCleanupSettings.holdDays,
    deleteRemoteSourceAfterCopy: record.deleteRemoteSourceAfterCopy === true,
    reRequestsPerMinute: Number.isInteger(reRequestsPerMinute) && reRequestsPerMinute >= 1 && reRequestsPerMinute <= 60 ? reRequestsPerMinute : defaultCleanupSettings.reRequestsPerMinute,
    purgeRecheckSeconds:
      record.purgeRecheckSeconds !== undefined && record.purgeRecheckSeconds !== null && Number.isInteger(purgeRecheckSeconds) && purgeRecheckSeconds >= 0 && purgeRecheckSeconds <= maxPurgeRecheckSeconds
        ? purgeRecheckSeconds
        : defaultCleanupSettings.purgeRecheckSeconds,
    purgeSettleSeconds:
      record.purgeSettleSeconds !== undefined && record.purgeSettleSeconds !== null && Number.isInteger(purgeSettleSeconds) && purgeSettleSeconds >= 0 && purgeSettleSeconds <= maxPurgeSettleSeconds
        ? purgeSettleSeconds
        : defaultCleanupSettings.purgeSettleSeconds
  };
}

export function normalizeAdvancedSettings(value: unknown): AdvancedSettings {
  const record = isRecord(value) ? value : {};
  return {
    scan: normalizeScanBehavior(record.scan),
    copy: normalizeCopyBehavior(record.copy),
    audit: normalizeAuditBehavior(record.audit),
    cleanup: normalizeCleanup(record.cleanup)
  };
}
