export type ReRequestStatus = "queued" | "pending" | "requested" | "failed" | "unmatched" | "skipped";
export type ReRequestService = "radarr" | "sonarr";
// "search" clears the arr's file record and searches for a new copy; "rescan" asks the arr to rescan the title's folder on disk.
export type ReRequestAction = "search" | "rescan";

export interface ReRequestRecord {
  id: number;
  jobId: number;
  action: ReRequestAction;
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

// What a delete job did with "Ask Radarr/Sonarr to rescan", kept in the job's progress. Rescans are sent by the worker
// as pacing allows, so `asked` counts the ones waiting their turn; what each one did is in the job's events.
export interface ArrRescanSummary {
  // Titles that had a library symlink deleted.
  titles: number;
  // One rescan per Radarr movie or Sonarr series.
  asked: number;
  // Titles left out because a re-request already clears the deleted files from Radarr or Sonarr.
  coveredByReRequest: number;
  // Titles no Radarr or Sonarr instance knows.
  notMatched: number;
  // Titles whose instance is paused, or that could not be queued; they can be retried from the re-request activity list.
  failed: number;
  // The first few titles that were not matched or failed, with the reason.
  problems: Array<{ title: string; reason: string; kind: "not_matched" | "failed" }>;
}
