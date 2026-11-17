import { useEffect, useId, useRef, useState } from "react";

// Shared open state for the info-tooltip pattern: hover and keyboard focus show the panel through CSS,
// a tap or click pins it open, and Escape or a press elsewhere closes it.
export function useTooltipState() {
  const [open, setOpen] = useState(false);
  const tooltipId = useId();
  const tooltipRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return undefined;
    const handlePointerDown = (event: PointerEvent) => {
      if (!tooltipRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  return { open, setOpen, tooltipId, tooltipRef };
}
