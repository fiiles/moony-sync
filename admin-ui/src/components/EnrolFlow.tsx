import { useState } from "preact/hooks";
import { api } from "../api";
import { useAction } from "../hooks";
import { useI18n } from "../i18n";
import { CopyButton } from "./CopyButton";
import { ErrorNote } from "./ErrorNote";
import { Field } from "./Field";
import { Qr } from "./Qr";

type Step = { name: "password" } | { name: "scan"; secret: string; url: string } | { name: "codes"; codes: string[] };

/** Second factor setup in three steps: password, scan and confirm, save the backup codes.
 *  `onFinished` is called when the person leaves the last step. */
export function EnrolFlow({ forced, onFinished, onCodesShown, onConfirming }: { forced?: boolean; onFinished(): void; onCodesShown?(): void; onConfirming?(active: boolean): void }) {
  const { t } = useI18n();
  const { busy, error, run, clear } = useAction();
  const [step, setStep] = useState<Step>({ name: "password" });
  const [password, setPassword] = useState("");
  const [totp, setTotp] = useState("");

  const start = async (e: Event) => {
    e.preventDefault();
    const r = await run(() => api.enrol(password));
    if (r.ok) {
      setPassword("");
      setStep({ name: "scan", secret: r.value.secret, url: r.value.otpauthUrl });
    }
  };
  const confirm = async (e: Event) => {
    e.preventDefault();
    // From here on the factor may be on already: the dialog must not close before the codes.
    onConfirming?.(true);
    const r = await run(() => api.confirmTotp(totp.trim()));
    if (!r.ok) onConfirming?.(false);
    if (r.ok) {
      setTotp("");
      clear();
      setStep({ name: "codes", codes: r.value.backupCodes });
      onCodesShown?.();
      onConfirming?.(false);
    }
  };

  if (step.name === "password") {
    return (
      <form onSubmit={start} noValidate>
        {forced ? <p class="auth__lead">{t("enrol.forced")}</p> : null}
        <p class="enrol__text">{t("enrol.passwordStep")}</p>
        <Field label={t("common.password")} type="password" value={password} onValue={setPassword} autocomplete="current-password" data-autofocus required />
        <ErrorNote error={error} />
        <div class="actions actions--end">
          <button type="submit" class="btn btn--primary" disabled={busy}>
            {t("enrol.start")}
          </button>
        </div>
      </form>
    );
  }

  if (step.name === "scan") {
    return (
      <form onSubmit={confirm} noValidate>
        <p class="enrol__text">{t("enrol.scan")}</p>
        <div class="enrol__scan">
          <Qr text={step.url} label={t("enrol.qr")} />
          <div class="enrol__key">
            <div class="field__label">
              <span>{t("enrol.key")}</span>
            </div>
            <div class="code-box code-box--short" data-testid="totp-secret">
              {step.secret}
            </div>
          </div>
        </div>
        <Field label={t("enrol.code")} value={totp} onValue={setTotp} mono inputMode="numeric" autocomplete="one-time-code" maxLength={6} data-autofocus required />
        <ErrorNote error={error} />
        <div class="actions actions--end">
          <button type="submit" class="btn btn--primary" disabled={busy}>
            {t("enrol.confirm")}
          </button>
        </div>
      </form>
    );
  }

  const all = step.codes.join("\n");
  return (
    <div>
      <h3 class="enrol__title">{t("enrol.backupTitle")}</h3>
      <p class="enrol__text">{t("enrol.backupText")}</p>
      <ul class="backup-codes" data-testid="backup-codes">
        {step.codes.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ul>
      <p class="enrol__text">{t("enrol.otherSessions")}</p>
      <div class="actions actions--end">
        <CopyButton text={all} label={t("enrol.copyCodes")} />
        <button type="button" class="btn btn--primary" onClick={onFinished} data-autofocus>
          {t("enrol.finish")}
        </button>
      </div>
    </div>
  );
}
