import { useState } from "preact/hooks";
import { api } from "../api";
import { EnrolFlow } from "../components/EnrolFlow";
import { ErrorNote } from "../components/ErrorNote";
import { Field } from "../components/Field";
import { LangSwitch } from "../components/LangSwitch";
import { Modal } from "../components/Modal";
import { LoadError, PageHead } from "../components/bits";
import { useApp } from "../context";
import { errorMessage, useAction, useResource } from "../hooks";
import { useI18n } from "../i18n";

function AddressCard() {
  const { t } = useI18n();
  const res = useResource(() => api.overview());
  const { busy, error, run } = useAction();
  const [value, setValue] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const o = res.data;
  if (!o) return res.error ? <LoadError message={errorMessage(t, res.error)} onRetry={res.reload} /> : <div class="skeleton skeleton--card" />;
  const current = value ?? o.address ?? o.addressSuggestion;
  return (
    <form
      class="card card--flat"
      noValidate
      onSubmit={async (e) => {
        e.preventDefault();
        setSaved(false);
        const r = await run(() => api.saveAddress(current));
        if (r.ok) {
          setValue(r.value.publicUrl);
          setSaved(true);
        }
      }}
    >
      <div class="card__body">
        <h2 class="card__title">{t("settings.addressTitle")}</h2>
        <p class="card__sub card__sub--text">{t("settings.addressText")}</p>
        <Field label={t("settings.addressTitle")} value={current} onValue={(v) => { setValue(v); setSaved(false); }} mono inputMode="url" autocapitalize="off" spellcheck={false} required />
        <ErrorNote error={error} />
        {saved ? <p class="ok-note" role="status">{t("settings.addressSaved")}</p> : null}
        <button type="submit" class="btn" disabled={busy}>
          {t("settings.addressSave")}
        </button>
      </div>
    </form>
  );
}

function PasswordCard() {
  const { t } = useI18n();
  const { state } = useApp();
  const { busy, error, run } = useAction();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [mismatch, setMismatch] = useState(false);
  const [saved, setSaved] = useState(false);
  return (
    <form
      class="card card--flat"
      noValidate
      onSubmit={async (e) => {
        e.preventDefault();
        setSaved(false);
        if (next !== again) {
          setMismatch(true);
          return;
        }
        setMismatch(false);
        if ((await run(() => api.changePassword(current, next))).ok) {
          setCurrent("");
          setNext("");
          setAgain("");
          setSaved(true);
        }
      }}
    >
      <div class="card__body">
        <h2 class="card__title">{t("settings.passwordTitle")}</h2>
        {state.name ? <p class="card__sub card__sub--text">{t("settings.signedIn", { name: state.name })}</p> : null}
        <Field label={t("settings.current")} type="password" value={current} onValue={setCurrent} autocomplete="current-password" required />
        <Field label={t("settings.new")} type="password" value={next} onValue={setNext} autocomplete="new-password" hint={t("setup.passwordHint")} required />
        <Field label={t("settings.new2")} type="password" value={again} onValue={setAgain} autocomplete="new-password" invalid={mismatch} required />
        <ErrorNote error={error} extra={mismatch ? t("setup.mismatch") : null} />
        {saved ? <p class="ok-note" role="status">{t("settings.passwordSaved")}</p> : null}
        <button type="submit" class="btn" disabled={busy}>
          {t("settings.passwordSubmit")}
        </button>
      </div>
    </form>
  );
}

function TwoFactorCard() {
  const { t } = useI18n();
  const { state, refresh } = useApp();
  const [enrolling, setEnrolling] = useState(false);
  // Once the backup codes are on screen, 2FA is already on and the codes are shown only once.
  const [codesShown, setCodesShown] = useState(false);
  // While the confirm request runs the dialog is as unclosable as with the codes on screen.
  const [confirming, setConfirming] = useState(false);
  const [disabling, setDisabling] = useState(false);
  const off = useAction();
  const [password, setPassword] = useState("");
  const closeDisable = () => {
    setDisabling(false);
    setPassword("");
  };
  return (
    <div class="card card--flat">
      <div class="setting-row">
        <div>
          <b>
            {t("settings.tfaTitle")} <span class={`badge${state.twoFactor ? "" : " badge--outline"}`}>{state.twoFactor ? t("settings.tfaOn") : t("settings.tfaOff")}</span>
          </b>
          <small>{state.require2fa && state.twoFactor ? t("settings.tfaRequired") : t("settings.tfaText")}</small>
        </div>
        {state.twoFactor ? (
          state.require2fa ? null : (
            <button type="button" class="btn" onClick={() => setDisabling(true)}>
              {t("settings.tfaDisable")}
            </button>
          )
        ) : (
          <button type="button" class="btn" onClick={() => setEnrolling(true)}>
            {t("settings.tfaEnable")}
          </button>
        )}
      </div>
      {enrolling ? (
        <Modal
          title={t("enrol.title")}
          locked={codesShown}
          busy={confirming}
          onClose={() => {
            setEnrolling(false);
            void refresh();
          }}
        >
          <EnrolFlow
            onCodesShown={() => setCodesShown(true)}
            onConfirming={setConfirming}
            onFinished={() => {
              setEnrolling(false);
              setCodesShown(false);
              void refresh();
            }}
          />
        </Modal>
      ) : null}
      {disabling ? (
        <Modal
          title={t("tfa.disableTitle")}
          lead={t("tfa.disableText")}
          small
          busy={off.busy}
          onClose={closeDisable}
          onSubmit={async () => {
            if ((await off.run(() => api.disableTotp(password))).ok) {
              closeDisable();
              await refresh();
            }
          }}
          actions={
            <>
              <button type="button" class="btn" onClick={closeDisable} disabled={off.busy}>
                {t("common.cancel")}
              </button>
              <button type="submit" class="btn btn--destructive" disabled={off.busy}>
                {t("tfa.disableSubmit")}
              </button>
            </>
          }
        >
          <Field label={t("common.password")} type="password" value={password} onValue={setPassword} autocomplete="current-password" required />
          <ErrorNote error={off.error} />
        </Modal>
      ) : null}
    </div>
  );
}

function LogoutAllCard() {
  const { t } = useI18n();
  const { refresh } = useApp();
  const [asking, setAsking] = useState(false);
  const { busy, error, run } = useAction();
  return (
    <div class="card card--flat">
      <div class="setting-row">
        <div>
          <b>{t("settings.logoutTitle")}</b>
          <small>{t("settings.logoutText")}</small>
        </div>
        <button type="button" class="btn" onClick={() => setAsking(true)}>
          {t("settings.logoutSubmit")}
        </button>
      </div>
      {asking ? (
        <Modal
          title={t("settings.logoutConfirmTitle")}
          small
          busy={busy}
          onClose={() => setAsking(false)}
          onSubmit={async () => {
            if ((await run(() => api.logoutAll())).ok) await refresh();
          }}
          actions={
            <>
              <button type="button" class="btn" onClick={() => setAsking(false)} disabled={busy}>
                {t("common.cancel")}
              </button>
              <button type="submit" class="btn btn--destructive" disabled={busy}>
                {t("settings.logoutSubmit")}
              </button>
            </>
          }
        >
          <p class="modal__text">{t("settings.logoutConfirmText")}</p>
          <ErrorNote error={error} />
        </Modal>
      ) : null}
    </div>
  );
}

export function Settings() {
  const { t } = useI18n();
  return (
    <>
      <PageHead eyebrow={t("settings.eyebrow")} title={t("settings.title")} lead={t("settings.lead")} />
      <div class="settings-stack">
        <AddressCard />
        <PasswordCard />
        <TwoFactorCard />
        <LogoutAllCard />
        <div class="card card--flat">
          <div class="setting-row">
            <div>
              <b>{t("settings.languageTitle")}</b>
              <small>{t("settings.languageText")}</small>
            </div>
            <LangSwitch />
          </div>
        </div>
      </div>
    </>
  );
}
