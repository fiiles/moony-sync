import { useState } from "preact/hooks";
import { EnrolFlow } from "../components/EnrolFlow";
import { AuthFrame } from "../components/Shell";
import { api } from "../api";
import { useApp } from "../context";
import { useI18n } from "../i18n";

/** REQUIRE_2FA: right after the first login nothing else is reachable until a second factor exists. */
export function ForcedEnrol() {
  const { t } = useI18n();
  const { refresh } = useApp();
  const [codesShown, setCodesShown] = useState(false);
  return (
    <AuthFrame wide>
      <h1 class="auth__title">{t("enrol.title")}</h1>
      <EnrolFlow forced onCodesShown={() => setCodesShown(true)} onFinished={() => void refresh()} />
      {codesShown ? null : (
      <div class="auth__foot">
        <button
          type="button"
          class="link"
          onClick={async () => {
            try {
              await api.logout();
            } catch {
              /* the state read below shows where we are */
            }
            await refresh();
          }}
        >
          {t("nav.logout")}
        </button>
      </div>
      )}
    </AuthFrame>
  );
}
