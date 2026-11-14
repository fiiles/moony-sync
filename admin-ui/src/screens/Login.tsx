import { useState } from "preact/hooks";
import { api, ApiError } from "../api";
import { ErrorNote } from "../components/ErrorNote";
import { Field } from "../components/Field";
import { Icon } from "../components/Icon";
import { AuthFrame } from "../components/Shell";
import { useApp } from "../context";
import { useAction } from "../hooks";
import { useI18n } from "../i18n";

const LOCAL = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Plain http from a host that is not this machine: the password crosses the network in clear. */
export function isInsecurePage(loc: Pick<Location, "protocol" | "hostname"> = window.location): boolean {
  return loc.protocol === "http:" && !LOCAL.has(loc.hostname);
}

export function Login() {
  const { t } = useI18n();
  const { refresh } = useApp();
  const { busy, error, run, clear } = useAction();
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [totp, setTotp] = useState("");
  const [second, setSecond] = useState(false);

  const submit = async (e: Event) => {
    e.preventDefault();
    const r = await run(() => api.login({ name, password, ...(second ? { totp: totp.trim() } : {}) }));
    if (r.ok) {
      await refresh();
    } else if (!second && r.error instanceof ApiError && r.error.code === "totp_required") {
      // The server answers totp_required to a right name and password: that is the next step, not an error.
      setSecond(true);
      clear();
    }
  };

  return (
    <AuthFrame>
      <div class="eyebrow">{t("login.eyebrow")}</div>
      <h1 class="auth__title">{second ? t("login.totpTitle") : t("login.title")}</h1>
      <p class="auth__lead">{second ? t("login.totpLead") : t("login.lead")}</p>
      {isInsecurePage() ? (
        <div class="alert note">
          <Icon name="alert" />
          <div>
            <b>{t("http.title")}</b>
            {t("http.text")}
          </div>
        </div>
      ) : null}
      <form onSubmit={submit} noValidate>
        {second ? (
          <Field label={t("login.totp")} value={totp} onValue={setTotp} mono inputMode="text" autocomplete="one-time-code" autocapitalize="off" spellcheck={false} required />
        ) : (
          <>
            <Field label={t("login.name")} value={name} onValue={setName} autocomplete="username" required />
            <Field label={t("login.password")} type="password" value={password} onValue={setPassword} autocomplete="current-password" required />
          </>
        )}
        <ErrorNote error={error} />
        <button type="submit" class="btn btn--primary auth__submit" disabled={busy}>
          {second ? t("login.totpSubmit") : t("login.submit")}
        </button>
        {second ? (
          <button
            type="button"
            class="btn btn--ghost auth__submit"
            disabled={busy}
            onClick={() => {
              setSecond(false);
              setTotp("");
              clear();
            }}
          >
            {t("login.totpBack")}
          </button>
        ) : null}
      </form>
    </AuthFrame>
  );
}
