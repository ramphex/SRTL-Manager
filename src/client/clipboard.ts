// navigator.clipboard only exists on secure origins, and self-hosted installs are often opened over plain HTTP.
export async function copyText(text: string): Promise<boolean> {
  if (window.isSecureContext && navigator.clipboard) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Permission can still be refused; fall through to the legacy copy command.
    }
  }
  return copyWithSelection(text);
}

function copyWithSelection(text: string): boolean {
  const scratch = document.createElement("textarea");
  scratch.value = text;
  scratch.setAttribute("readonly", "");
  scratch.style.position = "fixed";
  scratch.style.opacity = "0";
  scratch.style.pointerEvents = "none";
  document.body.appendChild(scratch);
  const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  scratch.focus();
  scratch.select();
  scratch.setSelectionRange(0, text.length);
  try {
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    scratch.remove();
    previousFocus?.focus();
  }
}
