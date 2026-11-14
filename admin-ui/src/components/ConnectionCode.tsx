import { useI18n } from "../i18n";
import { CopyButton } from "./CopyButton";
import { Qr } from "./Qr";

/** A connection code as selectable text, a QR code and a Copy button, with what to do with it. */
export function ConnectionCode({ code }: { code: string }) {
  const { t } = useI18n();
  return (
    <div class="code-panel">
      <div class="code-panel__main">
        <div class="field__label">
          <span id="code-label">{t("code.label")}</span>
        </div>
        <div class="code-box" role="textbox" aria-readonly="true" aria-labelledby="code-label" tabIndex={0} data-testid="connection-code">
          {code}
        </div>
        <div class="code-panel__copy">
          <CopyButton text={code} />
        </div>
        <p class="code-panel__how">{t("code.instruction")}</p>
        <p class="code-panel__warn">{t("code.credential")}</p>
      </div>
      <div class="code-panel__qr">
        <Qr text={code} label={t("code.qr")} />
      </div>
    </div>
  );
}
