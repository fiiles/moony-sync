import { useEffect, useRef, useState } from "preact/hooks";
import { useI18n } from "../i18n";
import { Icon } from "./Icon";

/** Copies with the Clipboard API, which exists only in a secure context (https or localhost), so
 *  on a plain-http page (the usual self-hosted case) it falls back to a temporary textarea and
 *  document.execCommand("copy"). When both fail the button says to copy by hand. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the textarea */
  }
  const sink = document.createElement("textarea");
  sink.value = text;
  sink.className = "copy-sink";
  sink.setAttribute("readonly", "");
  sink.setAttribute("aria-hidden", "true");
  sink.tabIndex = -1;
  const previous = document.activeElement as HTMLElement | null;
  document.body.appendChild(sink);
  try {
    sink.select();
    sink.setSelectionRange(0, text.length);
    return typeof document.execCommand === "function" && document.execCommand("copy");
  } catch {
    return false;
  } finally {
    sink.remove();
    previous?.focus?.();
  }
}

export function CopyButton({ text, label }: { text: string; label?: string }) {
  const { t } = useI18n();
  const [state, setState] = useState<"idle" | "done" | "manual">("idle");
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const copy = async () => {
    const ok = await copyText(text);
    setState(ok ? "done" : "manual");
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setState("idle"), ok ? 2000 : 8000);
  };
  return (
    <span class="copy">
      <button type="button" class="btn" onClick={copy}>
        <Icon name={state === "done" ? "check" : "copy"} />
        <span aria-live="polite">{state === "done" ? t("common.copied") : (label ?? t("common.copy"))}</span>
      </button>
      {state === "manual" ? (
        <span class="copy__manual" role="status">
          {t("common.copyManual")}
        </span>
      ) : null}
    </span>
  );
}
