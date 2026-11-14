import { useState } from "preact/hooks";
import { api } from "../api";
import { ErrorNote } from "../components/ErrorNote";
import { Field } from "../components/Field";
import { AuthFrame } from "../components/Shell";
import { useApp } from "../context";
import { useAction } from "../hooks";
import { useI18n } from "../i18n";

/** First run: the setup code from the server's log, the administrator's name and password. */
export function Setup() {
  const { t } = useI18n();
  const { refresh } = useApp();
  const { busy, error, run } = useAction();
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [again, setAgain] = useState("");
  const [mismatch, setMismatch] = useState(false);

  const submit = async (e: Event) => {
    e.preventDefault();
    if (password !== again) {
      setMismatch(true);
      return;
    }
    setMismatch(false);
    if ((await run(() => api.setup({ code: code.trim(), name, password }))).ok) await refresh();
  };

  return (
    <AuthFrame>
      <div class="eyebrow">{t("setup.eyebrow")}</div>
      <h1 class="auth__title">{t("setup.title")}</h1>
      <p class="auth__lead">{t("setup.lead")}</p>
      <form onSubmit={submit} noValidate>
        <Field label={t("setup.code")} hint={t("setup.codeHint")} value={code} onValue={setCode} mono autocomplete="off" autocapitalize="off" spellcheck={false} required />
        <Field label={t("setup.name")} value={name} onValue={setName} autocomplete="username" required />
        <Field label={t("setup.password")} hint={t("setup.passwordHint")} type="password" value={password} onValue={setPassword} autocomplete="new-password" required />
        <Field label={t("setup.password2")} type="password" value={again} onValue={setAgain} autocomplete="new-password" invalid={mismatch} required />
        <ErrorNote error={error} extra={mismatch ? t("setup.mismatch") : null} />
        <button type="submit" class="btn btn--primary auth__submit" disabled={busy}>
          {t("setup.submit")}
        </button>
      </form>
    </AuthFrame>
  );
}
