import { createContext, type ComponentChildren } from "preact";
import { useCallback, useContext, useEffect, useMemo, useState } from "preact/hooks";
import { cs } from "./cs";
import { en, type Key } from "./en";

export const LANGUAGES = ["cs", "en"] as const;
export type Lang = (typeof LANGUAGES)[number];

export const dictionaries: Record<Lang, Record<Key, string>> = { cs, en };
const STORAGE_KEY = "moony-sync-lang";

export function isLang(v: unknown): v is Lang {
  return typeof v === "string" && (LANGUAGES as readonly string[]).includes(v);
}

/** The saved choice, else the browser language (Czech and Slovak speakers get Czech), else English. */
export function initialLang(): Lang {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (isLang(saved)) return saved;
  } catch {
    /* storage unavailable: fall through */
  }
  const nav = (typeof navigator !== "undefined" ? navigator.language : "") ?? "";
  return /^(cs|sk)\b/i.test(nav) ? "cs" : "en";
}

export type Params = Record<string, string | number>;

export function translate(lang: Lang, key: Key, params?: Params): string {
  const text = dictionaries[lang][key] ?? en[key];
  return params ? text.replace(/\{(\w+)\}/g, (m, name: string) => (name in params ? String(params[name]) : m)) : text;
}

export type T = (key: Key, params?: Params) => string;

interface I18n {
  lang: Lang;
  setLang(l: Lang): void;
  t: T;
}

const Context = createContext<I18n>({ lang: "en", setLang: () => undefined, t: (k, p) => translate("en", k, p) });

export function LangProvider({ children, initial }: { children: ComponentChildren; initial?: Lang }) {
  const [lang, setLangState] = useState<Lang>(initial ?? initialLang());
  const setLang = useCallback((l: Lang) => {
    setLangState(l);
    try {
      localStorage.setItem(STORAGE_KEY, l);
    } catch {
      /* not remembered */
    }
  }, []);
  useEffect(() => {
    document.documentElement.lang = lang;
    document.title = translate(lang, "doc.title");
  }, [lang]);
  const value = useMemo<I18n>(() => ({ lang, setLang, t: (key, params) => translate(lang, key, params) }), [lang, setLang]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export const useI18n = (): I18n => useContext(Context);
