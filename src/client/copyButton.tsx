import { useEffect, useState } from "react";
import { Check, ClipboardCopy } from "lucide-react";
import { copyText } from "./clipboard";

export function CopyButton({ text, label = "Copy", fallbackInputId }: { text: string; label?: string; fallbackInputId?: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  useEffect(() => {
    if (state === "idle") return;
    const timer = window.setTimeout(() => setState("idle"), 2000);
    return () => window.clearTimeout(timer);
  }, [state]);
  useEffect(() => setState("idle"), [text]);
  const copy = async () => {
    const copied = await copyText(text);
    setState(copied ? "copied" : "failed");
    // When the browser blocks copying entirely, leave the value selected so Cmd/Ctrl+C still works.
    if (!copied && fallbackInputId) document.getElementById(fallbackInputId)?.focus();
  };
  return (
    <button type="button" className="secondary" onClick={() => void copy()} aria-live="polite">
      {state === "copied" ? <Check size={16} /> : <ClipboardCopy size={16} />}
      {state === "copied" ? "Copied" : state === "failed" ? "Press Ctrl/Cmd+C" : label}
    </button>
  );
}
