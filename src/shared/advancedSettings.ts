import type { AdvancedSettings, AuditJobBehaviorSettings, CopyJobBehaviorSettings, CopyMediaValidationMode, CopyVerificationProfile } from "./types";

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

export const defaultAdvancedSettings: AdvancedSettings = {
  copy: defaultCopyJobBehaviorSettings,
  audit: defaultAuditJobBehaviorSettings
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

export function normalizeAdvancedSettings(value: unknown): AdvancedSettings {
  const record = isRecord(value) ? value : {};
  return {
    copy: normalizeCopyBehavior(record.copy),
    audit: normalizeAuditBehavior(record.audit)
  };
}
