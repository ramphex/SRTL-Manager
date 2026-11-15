import { Check } from "lucide-react";
import { describeFileHeader, type FileHeaderState } from "../shared/fileHeaders";
import { formatDate, useUserPreferences } from "./appShared";
import { StatusPill } from "./App";

/**
 * A small checkmark for a file whose header check passed. Unchecked, skipped and retry show nothing; a failed check
 * shows the damaged pill instead (see HeaderFailedPill), so a passed file never looks different from today's rows.
 */
export function HeaderCheckMark({ header }: { header: FileHeaderState | null | undefined }) {
  const { timeFormat } = useUserPreferences();
  if (header?.status !== "pass") return null;
  const label = `Header check passed ${formatDate(header.checkedAt, timeFormat)}`;
  return (
    <span className="header-check-mark" title={label} aria-label={label} role="img">
      <Check size={12} strokeWidth={3} aria-hidden="true" />
    </span>
  );
}

/** Mark from just a check time, for places that only know the file passed, such as a copy job's items. */
export function HeaderCheckedAtMark({ checkedAt }: { checkedAt: string | null | undefined }) {
  return checkedAt ? <HeaderCheckMark header={{ status: "pass", reason: null, checkedAt }} /> : null;
}

export function HeaderFailedPill({ header }: { header: FileHeaderState | null | undefined }) {
  if (header?.status !== "fail") return null;
  return (
    <span title={describeFileHeader(header)}>
      <StatusPill value="Bad header" toneValue="damaged" />
    </span>
  );
}
