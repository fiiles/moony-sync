import type { Person } from "../api";
import { useI18n } from "../i18n";

/** Person states are neutral: Active plain, Blocked outlined (green and red-brown mean something else). */
export function StateBadge({ state }: { state: Person["state"] }) {
  const { t } = useI18n();
  return <span class={`badge${state === "blocked" ? " badge--outline" : ""}`}>{t(`people.state.${state}`)}</span>;
}
