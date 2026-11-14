import { useI18n } from "../i18n";
import { errorMessage } from "../hooks";
import { Icon } from "./Icon";

/** An inline error next to its cause; says what to do, never shows raw JSON. */
export function ErrorNote({ error, extra }: { error: unknown; extra?: string | null }) {
  const { t } = useI18n();
  if (!error && !extra) return null;
  return (
    <div class="alert alert--error note" role="alert">
      <Icon name="alert" />
      <div>{extra ?? errorMessage(t, error)}</div>
    </div>
  );
}
