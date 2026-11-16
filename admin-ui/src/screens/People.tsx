import { useState } from "preact/hooks";
import { api, type Person } from "../api";
import { Icon } from "../components/Icon";
import { ErrorNote } from "../components/ErrorNote";
import { LastActivity, LoadError, PageHead, PageSkeleton, RefreshButton, Size } from "../components/bits";
import { PersonActions } from "../components/PersonActions";
import { AddPersonModal, PersonDialogs, unblock, type PersonDialog } from "../components/PersonModals";
import { StateBadge } from "../components/StateBadge";
import { errorMessage, useAction, useResource } from "../hooks";
import { useI18n } from "../i18n";
import { Link } from "../router";

export function People() {
  const { t } = useI18n();
  const res = useResource(() => api.people(), [], { refreshEveryMs: 30_000, refreshOnFocus: true });
  const [adding, setAdding] = useState(false);
  const [dialog, setDialog] = useState<PersonDialog | null>(null);
  const action = useAction();

  const list: Person[] | null = res.data;
  if (!list) {
    return res.error ? <LoadError message={errorMessage(t, res.error)} onRetry={res.reload} /> : <PageSkeleton />;
  }

  const addButton = (
    <button type="button" class="btn btn--primary" onClick={() => setAdding(true)}>
      {t("people.add")}
    </button>
  );

  return (
    <>
      <PageHead eyebrow={t("people.eyebrow")} title={t("people.title")} lead={t("people.lead")} actions={
          <>
            <RefreshButton busy={res.refreshing} onClick={() => void res.refresh()} />
            {list.length > 0 ? addButton : null}
          </>
        } />
      <ErrorNote error={action.error} />

      {list.length === 0 ? (
        <div class="card">
          <div class="empty">
            <Icon name="users" size={28} />
            <h3>{t("people.emptyTitle")}</h3>
            <p>{t("people.emptyText")}</p>
            {addButton}
          </div>
        </div>
      ) : (
        <div class="card card--table people-table">
          <div class="card__head">
            <div>
              <h2 class="card__title">{t("people.tableTitle")}</h2>
            </div>
          </div>
          <div class="table" role="table" aria-label={t("people.tableTitle")}>
            <div class="table__head" role="row">
              <span role="columnheader">{t("people.colName")}</span>
              <span role="columnheader">{t("people.colState")}</span>
              <span role="columnheader" class="cell--num">{t("people.colProfiles")}</span>
              <span role="columnheader" class="cell--num">{t("people.colSpace")}</span>
              <span role="columnheader">{t("people.colActivity")}</span>
              <span role="columnheader" />
            </div>
            {list.map((p) => (
              <div class="table__row" role="row" key={p.id}>
                <span role="cell" class="cell--name">
                  <Link to={`/people/${encodeURIComponent(p.id)}`} class="name-link" aria-label={t("people.open", { name: p.name })}>
                    {p.name}
                  </Link>
                </span>
                <span role="cell">
                  <StateBadge state={p.state} />
                </span>
                <span role="cell" class="cell--num" data-label={t("people.colProfiles")}>
                  {p.profiles}
                </span>
                <span role="cell" class="cell--num" data-label={t("people.colSpace")}>
                  <Size bytes={p.bytes} />
                </span>
                <span role="cell" data-label={t("people.colActivity")}>
                  <LastActivity at={p.lastActivity} />
                </span>
                <span role="cell" class="cell--actions">
                  <PersonActions
                    person={p}
                    busy={action.busy}
                    onDialog={setDialog}
                    onUnblock={async () => {
                      if ((await action.run(() => unblock(p))).ok) res.reload();
                    }}
                  />
                </span>
              </div>
            ))}
          </div>
          <div class="table__foot">
            <span>{t("people.foot")}</span>
          </div>
        </div>
      )}

      {adding ? <AddPersonModal onClose={() => setAdding(false)} onCreated={res.reload} /> : null}
      <PersonDialogs dialog={dialog} onClose={() => setDialog(null)} onChanged={res.reload} onDeleted={res.reload} />
    </>
  );
}
