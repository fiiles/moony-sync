import { useState } from "preact/hooks";
import { api, type Vault } from "../api";
import { ErrorNote } from "../components/ErrorNote";
import { Icon } from "../components/Icon";
import { Modal } from "../components/Modal";
import { LastActivity, LoadError, PageHead, PageSkeleton, Size } from "../components/bits";
import { PersonActions } from "../components/PersonActions";
import { PersonDialogs, unblock, type PersonDialog } from "../components/PersonModals";
import { StateBadge } from "../components/StateBadge";
import { formatDate } from "../format";
import { errorMessage, useAction, useResource } from "../hooks";
import { useI18n } from "../i18n";
import { Link, navigate } from "../router";

export function PersonDetail({ id }: { id: string }) {
  const { t, lang } = useI18n();
  const res = useResource(() => api.person(id), [id]);
  const [dialog, setDialog] = useState<PersonDialog | null>(null);
  const [dropping, setDropping] = useState<Vault | null>(null);
  const action = useAction();
  const drop = useAction();

  const p = res.data;
  if (!p) {
    return res.error ? (
      <>
        <Link to="/people" class="back">
          <Icon name="back" />
          {t("person.back")}
        </Link>
        <LoadError message={errorMessage(t, res.error)} onRetry={res.reload} />
      </>
    ) : (
      <PageSkeleton />
    );
  }

  return (
    <>
      <Link to="/people" class="back">
        <Icon name="back" />
        {t("person.back")}
      </Link>
      <PageHead
        eyebrow={t("person.eyebrow")}
        title={p.name}
        lead={t("person.created", { date: formatDate(p.createdAt, lang) })}
        actions={<StateBadge state={p.state} />}
      />
      <div class="detail-actions">
        <PersonActions
          person={p}
          size="md"
          busy={action.busy}
          onDialog={setDialog}
          onUnblock={async () => {
            if ((await action.run(() => unblock(p))).ok) res.reload();
          }}
        />
      </div>
      <ErrorNote error={action.error} />

      <div class="stats stats--3">
        <div class="stat">
          <span class="stat__label">{t("person.profiles")}</span>
          <b class="stat__value">{p.profiles}</b>
        </div>
        <div class="stat">
          <span class="stat__label">{t("person.space")}</span>
          <b class="stat__value">
            <Size bytes={p.bytes} />
          </b>
        </div>
        <div class="stat">
          <span class="stat__label">{t("person.lastActivity")}</span>
          <b class="stat__value">
            <LastActivity at={p.lastActivity} dash />
          </b>
        </div>
      </div>

      <div class="card card--table vaults-table">
        <div class="card__head">
          <div>
            <h2 class="card__title">{t("person.profilesTitle")}</h2>
            <p class="card__sub">{t("person.profilesSub")}</p>
          </div>
        </div>
        {p.vaults.length === 0 ? (
          <div class="table__foot table__foot--text">
            <span>{t("person.noProfiles")}</span>
          </div>
        ) : (
          <div class="table" role="table" aria-label={t("person.profilesTitle")}>
            <div class="table__head" role="row">
              <span role="columnheader">{t("person.colId")}</span>
              <span role="columnheader" class="cell--num">{t("person.colSpace")}</span>
              <span role="columnheader" class="cell--num">{t("person.colFiles")}</span>
              <span role="columnheader">{t("person.colActivity")}</span>
              <span role="columnheader" />
            </div>
            {p.vaults.map((v) => (
              <div class="table__row" role="row" key={v.id}>
                <span role="cell" class="cell--name mono">
                  {v.shortId}
                </span>
                <span role="cell" class="cell--num" data-label={t("person.colSpace")}>
                  <Size bytes={v.bytes} />
                </span>
                <span role="cell" class="cell--num" data-label={t("person.colFiles")}>
                  {v.files}
                </span>
                <span role="cell" data-label={t("person.colActivity")}>
                  <LastActivity at={v.lastActivity} />
                </span>
                <span role="cell" class="cell--actions">
                  <span class="row-actions">
                    <button type="button" class="btn btn--danger btn--sm" onClick={() => setDropping(v)}>
                      {t("person.deleteProfile")}
                    </button>
                  </span>
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {dropping ? (
        <Modal
          title={t("profile.deleteTitle", { id: dropping.shortId })}
          small
          busy={drop.busy}
          onClose={() => setDropping(null)}
          onSubmit={async () => {
            if ((await drop.run(() => api.deleteVault(p.id, dropping.id))).ok) {
              setDropping(null);
              res.reload();
            }
          }}
          actions={
            <>
              <button type="button" class="btn" onClick={() => setDropping(null)} disabled={drop.busy}>
                {t("common.cancel")}
              </button>
              <button type="submit" class="btn btn--destructive" disabled={drop.busy}>
                {t("profile.deleteSubmit")}
              </button>
            </>
          }
        >
          <p class="modal__text">{t("profile.deleteText")}</p>
          <ErrorNote error={drop.error} />
        </Modal>
      ) : null}

      <PersonDialogs dialog={dialog} onClose={() => setDialog(null)} onChanged={res.reload} onDeleted={() => navigate("/people")} />
    </>
  );
}
