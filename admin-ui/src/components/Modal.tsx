import type { ComponentChildren } from "preact";
import { useEffect, useId, useRef } from "preact/hooks";
import { useI18n } from "../i18n";
import { Icon } from "./Icon";

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

interface ModalProps {
  title: string;
  lead?: string;
  onClose(): void;
  /** Submitting the form inside (Enter in a field, or the submit button). */
  onSubmit?(): void;
  /** A confirmation is narrower. */
  small?: boolean;
  /** While a request runs, the dialog cannot be closed. */
  busy?: boolean;
  /** Cannot be dismissed (no ×, Escape ignored): the content must be left through its own button. */
  locked?: boolean;
  children?: ComponentChildren;
  /** The footer's buttons; the first one in the DOM that is not disabled gets focus if nothing else does. */
  actions?: ComponentChildren;
}

/** A dialog on the design system's `.modal`: focus moves in, Tab stays inside, Escape closes,
 *  and focus returns to where it was. */
export function Modal({ title, lead, onClose, onSubmit, small, busy, locked, children, actions }: ModalProps) {
  const { t } = useI18n();
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const root = ref.current!;
    const target =
      root.querySelector<HTMLElement>("[data-autofocus]") ??
      root.querySelector<HTMLElement>(".modal__body input, .modal__body select, .modal__body textarea") ??
      root.querySelector<HTMLElement>(".modal__foot button");
    (target ?? root).focus();
    return () => previous?.focus?.();
  }, []);

  // Escape works wherever the focus is (a click on the backdrop can move it out of the dialog).
  const closeRef = useRef<() => void>(() => undefined);
  closeRef.current = () => {
    if (!busy && !locked) onClose();
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeRef.current();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const keydown = (e: KeyboardEvent) => {
    if (e.key !== "Tab") return;
    const items = Array.from(ref.current!.querySelectorAll<HTMLElement>(FOCUSABLE));
    if (items.length === 0) {
      e.preventDefault();
      return;
    }
    const first = items[0]!;
    const last = items[items.length - 1]!;
    const active = document.activeElement;
    if (e.shiftKey && (active === first || active === ref.current)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  };

  const content = (
    <>
      <div class="modal__head">
        <div>
          <h2 id={titleId}>{title}</h2>
          {lead ? <p>{lead}</p> : null}
        </div>
        {locked ? null : (
          <button type="button" class="modal__close" aria-label={t("common.close")} onClick={onClose} disabled={busy}>
            <Icon name="x" size={14} />
          </button>
        )}
      </div>
      <div class="modal__body">{children}</div>
      {actions ? (
        <div class="modal__foot">
          <div class="actions">{actions}</div>
        </div>
      ) : null}
    </>
  );

  return (
    <div class="modal-scrim is-open">
      <div
        ref={ref}
        class={`modal${small ? " modal--sm" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={keydown}
      >
        {onSubmit ? (
          <form
            class="modal__form"
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              if (!busy) onSubmit();
            }}
          >
            {content}
          </form>
        ) : (
          content
        )}
      </div>
    </div>
  );
}
