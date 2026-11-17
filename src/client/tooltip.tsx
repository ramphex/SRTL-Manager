import type { ReactNode } from "react";
import { useTooltipState } from "./tooltipState";

// The info-tooltip pattern with visible text as the trigger instead of an info icon.
// The panel describes the trigger, so screen readers announce it on focus.
export function TextTooltip({ trigger, children, className }: { trigger: ReactNode; children: ReactNode; className?: string }) {
  const { open, setOpen, tooltipId, tooltipRef } = useTooltipState();
  return (
    <span ref={tooltipRef} className={`info-tooltip text-tooltip${className ? ` ${className}` : ""}${open ? " is-open" : ""}`}>
      <button type="button" className="text-tooltip-trigger" aria-describedby={tooltipId} onClick={() => setOpen((value) => !value)}>
        {trigger}
      </button>
      <span id={tooltipId} className="info-tooltip-panel" role="tooltip">
        {children}
      </span>
    </span>
  );
}
