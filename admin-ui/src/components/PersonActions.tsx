import type { Person } from "../api";
import { useI18n } from "../i18n";
import type { PersonDialog } from "./PersonModals";

/** The buttons of one person: connection code, rename, block or unblock, delete. */
export function PersonActions({ person, busy, onDialog, onUnblock, size = "sm" }: { person: Person; busy?: boolean; onDialog(d: PersonDialog): void; onUnblock(): void; size?: "sm" | "md" }) {
  const { t } = useI18n();
  const sm = size === "sm" ? " btn--sm" : "";
  return (
    <span class="row-actions" role="group" aria-label={t("people.actions", { name: person.name })}>
      <button type="button" class={`btn${sm}`} onClick={() => onDialog({ kind: "code", person })}>
        {t("people.showCode")}
      </button>
      <button type="button" class={`btn btn--ghost${sm}`} onClick={() => onDialog({ kind: "rename", person })}>
        {t("people.rename")}
      </button>
      {person.state === "active" ? (
        <button type="button" class={`btn btn--ghost${sm}`} onClick={() => onDialog({ kind: "block", person })}>
          {t("people.block")}
        </button>
      ) : (
        <button type="button" class={`btn btn--ghost${sm}`} onClick={onUnblock} disabled={busy}>
          {t("people.unblock")}
        </button>
      )}
      <button type="button" class={`btn btn--danger${sm}`} onClick={() => onDialog({ kind: "delete", person })}>
        {t("people.delete")}
      </button>
    </span>
  );
}
