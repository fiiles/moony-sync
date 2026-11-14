import { LANGUAGES, useI18n } from "../i18n";

export function LangSwitch() {
  const { lang, setLang, t } = useI18n();
  return (
    <div class="seg" role="group" aria-label={t("common.language")}>
      {LANGUAGES.map((l) => (
        <button key={l} type="button" class={`seg__btn${l === lang ? " is-active" : ""}`} aria-pressed={l === lang} onClick={() => setLang(l)}>
          {t(`lang.${l}`)}
        </button>
      ))}
    </div>
  );
}
