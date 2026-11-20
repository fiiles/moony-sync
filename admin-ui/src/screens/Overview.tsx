import { useState } from "preact/hooks";
import { api } from "../api";
import { CopyButton } from "../components/CopyButton";
import { ErrorNote } from "../components/ErrorNote";
import { Field } from "../components/Field";
import { Icon } from "../components/Icon";
import { LastActivity, LoadError, PageHead, PageSkeleton, RefreshButton, Size } from "../components/bits";
import { errorMessage, useAction, useResource } from "../hooks";
import { useI18n } from "../i18n";
import { formatBytes } from "../format";

export function Overview() {
  const { t, lang } = useI18n();
  const res = useResource(() => api.overview(), [], { refreshEveryMs: 30_000, refreshOnFocus: true });
  const { busy, error, run } = useAction();
  const [suggestion, setSuggestion] = useState<string | null>(null);

  const o = res.data;
  if (!o) {
    return res.error ? <LoadError message={errorMessage(t, res.error)} onRetry={res.reload} /> : <PageSkeleton />;
  }

  const confirmAddress = async (e: Event) => {
    e.preventDefault();
    const r = await run(() => api.saveAddress(suggestion ?? o.addressSuggestion));
    if (r.ok) res.reload();
  };

  return (
    <>
      <PageHead eyebrow={t("overview.eyebrow")} title={t("overview.title")} lead={t("overview.lead")} actions={<RefreshButton busy={res.refreshing} onClick={() => void res.refresh()} />} />

      {o.insecure ? (
        <div class="alert note">
          <Icon name="alert" />
          <div>
            <b>{t("http.title")}</b>
            {t("http.text")}
          </div>
        </div>
      ) : null}

      {o.proxyWarning ? (
        <div class="alert note">
          <Icon name="alert" />
          <div>{t(`proxy.${o.proxyWarning}`)}</div>
        </div>
      ) : null}

      <div class="stats">
        <div class="stat">
          <span class="stat__label">{t("overview.people")}</span>
          <b class="stat__value">{o.people}</b>
          <span class="stat__note">&nbsp;</span>
        </div>
        <div class="stat">
          <span class="stat__label">{t("overview.profiles")}</span>
          <b class="stat__value">{o.profiles}</b>
          <span class="stat__note">{t("overview.profilesNote")}</span>
        </div>
        <div class="stat">
          <span class="stat__label">{t("overview.space")}</span>
          <b class="stat__value">
            <Size bytes={o.bytesUsed} />
          </b>
          <span class="stat__note">{t("overview.spaceNote", { free: formatBytes(o.bytesFree, lang) })}</span>
        </div>
        <div class="stat">
          <span class="stat__label">{t("overview.lastSync")}</span>
          <b class="stat__value">
            <LastActivity at={o.lastActivity} dash />
          </b>
          <span class="stat__note">{t("overview.lastSyncNote")}</span>
        </div>
      </div>

      <div class="two-col">
        {o.address === null ? (
          <div class="card">
            <form class="card__body" onSubmit={confirmAddress} noValidate>
              <h2 class="card__title">{t("overview.confirmTitle")}</h2>
              <p class="card__sub card__sub--text">{t("overview.confirmText")}</p>
              <Field label={t("overview.addressLabel")} value={suggestion ?? o.addressSuggestion} onValue={setSuggestion} mono inputMode="url" autocapitalize="off" spellcheck={false} required />
              <ErrorNote error={error} />
              <button type="submit" class="btn btn--primary" disabled={busy}>
                {t("overview.confirmSubmit")}
              </button>
            </form>
          </div>
        ) : (
          <div class="card">
            <div class="card__body">
              <h2 class="card__title">{t("overview.addressTitle")}</h2>
              <p class="card__sub card__sub--text">{t("overview.addressText")}</p>
              <div class="addr">
                <input class="input input--mono" readOnly value={o.address} aria-label={t("overview.addressLabel")} onFocus={(e) => e.currentTarget.select()} />
                <CopyButton text={o.address} />
              </div>
            </div>
          </div>
        )}
        <div class="card card--flat">
          <div class="card__body">
            <h2 class="card__title">{t("overview.serverTitle")}</h2>
            <div class="kv kv--first">
              <span>{t("overview.statusLabel")}</span>
              <b>{t("overview.statusValue")}</b>
            </div>
            <div class="kv">
              <span>{t("overview.versionLabel")}</span>
              <b>{o.version}</b>
            </div>
            <div class="kv">
              <span>{t("overview.dataLabel")}</span>
              <b>{t("overview.dataValue")}</b>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
