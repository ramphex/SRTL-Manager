// The file header check reads the first bytes of each video file and looks for a container signature.
// pass: a known container starts the file. fail: the file is empty, too small, starts with zeros, is an archive
// (RAR, 7z or ZIP: a download that was never unpacked), or starts with something that is not a video container. retry: the file could not be read in time; it is checked again later.
// skipped: a disc image or DVD menu file whose layout SRTL does not recognise; it is not judged either way.
export type FileHeaderStatus = "pass" | "fail" | "retry" | "skipped";

export type FileHeaderFailReason = "empty" | "too_small" | "zeros" | "archive" | "not_video";

export interface FileHeaderState {
  status: FileHeaderStatus;
  // For pass: the container found (for example "matroska"). For fail: a FileHeaderFailReason. For retry: what went wrong.
  reason: string | null;
  checkedAt: string;
}

const failReasonText: Record<FileHeaderFailReason, string> = {
  empty: "the file is empty (0 bytes)",
  too_small: "the file is too small to be a video",
  zeros: "the file starts with zeros, so it holds no video data",
  archive: "an archive, not a video: the download was never unpacked",
  not_video: "not a valid video file: no known container header"
};

// Short, plain reasons for lists such as Damaged files, where the verdict is already shown as "Bad header".
const failReasonLabels: Record<FileHeaderFailReason, string> = {
  empty: "Empty file: 0 bytes",
  too_small: "Too small to be a video",
  zeros: "Starts with zeros: no video data",
  archive: "Archive, not a video: the download was never unpacked",
  not_video: "Not a video file: the start of the file isn't any known video format"
};

const containerNames: Record<string, string> = {
  matroska: "Matroska/WebM",
  mp4: "MP4/MOV",
  avi: "AVI",
  mpeg_ts: "MPEG-TS",
  m2ts: "M2TS",
  mpeg_ps: "MPEG-PS",
  mpeg_video: "MPEG video",
  asf: "ASF/WMV",
  flv: "FLV",
  ogg: "Ogg",
  realmedia: "RealMedia",
  wtv: "WTV",
  disc_image: "disc image",
  dvd_ifo: "DVD menu file"
};

export function fileHeaderFailText(reason: string | null | undefined): string {
  return failReasonText[reason as FileHeaderFailReason] ?? "not a valid video file";
}

/** The plain reason a file failed the header check, for lists that already say it failed. */
export function fileHeaderFailLabel(reason: string | null | undefined): string {
  return failReasonLabels[reason as FileHeaderFailReason] ?? "Not a video file";
}

export function fileHeaderContainerName(reason: string | null | undefined): string | null {
  return reason ? (containerNames[reason] ?? null) : null;
}

/** A sentence for tooltips, logs and the copy job: what the header check found. */
export function describeFileHeader(state: Pick<FileHeaderState, "status" | "reason">): string {
  if (state.status === "pass") {
    const name = fileHeaderContainerName(state.reason);
    return name ? `Header check passed (${name})` : "Header check passed";
  }
  if (state.status === "fail") return `Header check failed: ${fileHeaderFailText(state.reason)}`;
  if (state.status === "skipped") return "Header not checked: SRTL does not recognise this disc image layout";
  return `Header check could not run${state.reason ? ` (${state.reason})` : ""}; it will be tried again`;
}
