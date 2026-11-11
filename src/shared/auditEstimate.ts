import type { AuditMode } from "./types";

/**
 * Rough read and decode speeds for audit estimates. A fast audit reads every byte of the file (a demux with stream
 * copy), so it runs at disk speed; through a remote mount it runs at download speed; a deep audit decodes every frame
 * in software, so it is CPU bound. These are deliberately round numbers for a shared, modest server.
 */
export const auditThroughput = {
  fastLocalBytesPerSecond: 130_000_000,
  remoteBytesPerSecond: 40_000_000,
  deepBytesPerSecond: 12_000_000
} as const;

export interface AuditEstimateInput {
  mode: AuditMode;
  localBytes: number;
  remoteBytes: number;
  // Bytes of recorded sources that byte compare would also read; sources are usually on the remote mount.
  sourceBytes: number;
}

export function estimateAuditSeconds(input: AuditEstimateInput): number {
  const local = input.mode === "deep" ? input.localBytes / auditThroughput.deepBytesPerSecond : input.localBytes / auditThroughput.fastLocalBytesPerSecond;
  const remote = input.remoteBytes / (input.mode === "deep" ? Math.min(auditThroughput.deepBytesPerSecond, auditThroughput.remoteBytesPerSecond) : auditThroughput.remoteBytesPerSecond);
  const sources = input.sourceBytes / auditThroughput.remoteBytesPerSecond;
  return Math.ceil(local + remote + sources);
}

export const libraryWideRemoteAuditRefusal =
  "Library-wide remote audits are turned off: an audit reads every remote byte through the remote mount, so it would download the whole remote library. Audit one title, one folder or a selection of files instead.";

export const libraryWideDeepAuditRefusal =
  "Library-wide deep audits are turned off: a deep audit decodes every frame in software, which would keep the CPU busy for weeks or months. Start a deep audit from one title, one folder, a selection of files or the Damaged files page instead.";

/** Plain-language duration for estimates: minutes, hours or days, rounded up. */
export function roughDuration(seconds: number): string {
  if (seconds < 90) return "about a minute";
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 90) return `about ${minutes} minutes`;
  const hours = Math.round(seconds / 3600);
  if (hours < 48) return `about ${hours} hours`;
  const days = Math.round(seconds / 86_400);
  return `about ${days} days`;
}
