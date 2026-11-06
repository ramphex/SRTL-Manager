export type ReRequestStatus = "queued" | "pending" | "requested" | "failed" | "unmatched" | "skipped";
export type ReRequestService = "radarr" | "sonarr";

export interface ReRequestRecord {
  id: number;
  jobId: number;
  displayName: string;
  service: ReRequestService | null;
  instanceName: string | null;
  title: string | null;
  episodes: string | null;
  status: ReRequestStatus;
  message: string | null;
  previousMonitored: boolean | null;
  attempts: number;
  createdAt: string;
  requestedAt: string | null;
}

export interface ReRequestList {
  items: ReRequestRecord[];
  // Across all history still kept, not only the rows listed.
  counts: Record<ReRequestStatus, number>;
  perMinute: number;
}

// What would happen for a selection, grouped so a very large selection stays a small answer.
export interface ReRequestPreview {
  total: number;
  eligibleCount: number;
  instances: Array<{ service: ReRequestService; instanceName: string; count: number }>;
  ineligible: Array<{ reason: string; count: number; examples: string[] }>;
}
