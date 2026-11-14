import { useRef } from "preact/hooks";
import { api, BACKUP_URL } from "../api";
import { useApp } from "../context";
import { startDownload } from "../download";
import { useAction } from "../hooks";
import { Icon } from "../components/Icon";
import { PageHead } from "../components/bits";
import { useI18n } from "../i18n";

export function Backup() {
  const { t } = useI18n();
  const { refresh } = useApp();
  const { busy, run } = useAction();
  // A download that meets an ended session would save the 401 JSON as "the backup": check first.
  // A second click while the check runs does nothing (a skipped call is not a failed check).
  const checking = useRef(false);
  const download = async (e: Event) => {
    e.preventDefault();
    if (checking.current) return;
    checking.current = true;
    try {
      const r = await run(() => api.state());
      if (r.ok && r.value.authenticated && !r.value.mustEnrol2fa) startDownload(BACKUP_URL);
      else await refresh();
    } finally {
      checking.current = false;
    }
  };
  return (
    <>
      <PageHead
        eyebrow={t("backup.eyebrow")}
        title={t("backup.title")}
        lead={t("backup.lead")}
        actions={
          <a class="btn btn--primary" href={BACKUP_URL} download onClick={download} aria-disabled={busy ? true : undefined}>
            <Icon name="download" />
            {t("backup.download")}
          </a>
        }
      />
      <div class="card">
        <div class="card__body">
          <h2 class="card__title">{t("backup.downloadTitle")}</h2>
          <p class="card__sub card__sub--text">{t("backup.downloadText")}</p>
        </div>
      </div>
      <div class="two-col two-col--even stack">
        <div class="card card--flat">
          <div class="card__body">
            <h2 class="card__title">{t("backup.restoreTitle")}</h2>
            <p class="card__sub card__sub--text">{t("backup.restoreText")}</p>
          </div>
        </div>
        <div class="card card--flat">
          <div class="card__body">
            <h2 class="card__title">{t("backup.backTitle")}</h2>
            <p class="card__sub card__sub--text">{t("backup.backText")}</p>
            <p class="card__sub card__sub--text">{t("backup.limitText")}</p>
          </div>
        </div>
      </div>
    </>
  );
}
