import type { ComponentChildren } from "preact";
import { formatBytes, formatDateTime, formatRelative } from "../format";
import { useI18n } from "../i18n";
import { Icon } from "./Icon";

export function PageHead({ eyebrow, title, lead, actions }: { eyebrow: string; title: string; lead?: string; actions?: ComponentChildren }) {
  return (
    <div class="page-head">
      <div>
        <div class="eyebrow">{eyebrow}</div>
        <h1>{title}</h1>
        {lead ? <p>{lead}</p> : null}
      </div>
      {actions ? <div class="actions">{actions}</div> : null}
    </div>
  );
}

/** "4 min ago" with the absolute time in the title; "No activity yet" for null. */
export function LastActivity({ at, dash }: { at: number | null; dash?: boolean }) {
  const { lang, t } = useI18n();
  if (at === null) return <span class="faint" title={t("common.never")}>{dash ? "—" : t("common.never")}</span>;
  return <time dateTime={new Date(at * 1000).toISOString()} title={formatDateTime(at, lang)}>{formatRelative(at, lang)}</time>;
}

export function Size({ bytes }: { bytes: number }) {
  const { lang } = useI18n();
  return <>{formatBytes(bytes, lang)}</>;
}

/** Placeholder blocks shaped like the page while it loads (no page spinners). */
export function PageSkeleton() {
  const { t } = useI18n();
  return (
    <div aria-busy="true" aria-label={t("common.loading")}>
      <div class="stats">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} class="skeleton skeleton--stat" />
        ))}
      </div>
      <div class="skeleton skeleton--card" />
    </div>
  );
}

export function LoadError({ message, onRetry }: { message: string; onRetry(): void }) {
  const { t } = useI18n();
  return (
    <div class="alert alert--error" role="alert">
      <div>{message}</div>
      <div class="actions">
        <button type="button" class="btn btn--sm" onClick={onRetry}>
          {t("common.retry")}
        </button>
      </div>
    </div>
  );
}

/** Fetches the page's data again; busy while it runs. */
export function RefreshButton({ busy, onClick }: { busy: boolean; onClick(): void }) {
  const { t } = useI18n();
  return (
    <button type="button" class={busy ? "btn is-loading" : "btn"} aria-busy={busy} onClick={onClick}>
      <Icon name="refresh" />
      {t("common.refresh")}
    </button>
  );
}
