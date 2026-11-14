import type { ComponentChildren } from "preact";
import { api } from "../api";
import { useApp } from "../context";
import { useAction } from "../hooks";
import { useI18n } from "../i18n";
import type { Key } from "../i18n/en";
import { Link } from "../router";
import { LangSwitch } from "./LangSwitch";

const NAV: { to: string; label: Key }[] = [
  { to: "/", label: "nav.overview" },
  { to: "/people", label: "nav.people" },
  { to: "/backup", label: "nav.backup" },
  { to: "/settings", label: "nav.settings" },
];

function Brand() {
  const { t } = useI18n();
  return (
    <div class="brand">
      <i class="moon" />
      <div>
        <b>{t("brand.name")}</b>
        <small>{t("brand.subtitle")}</small>
      </div>
    </div>
  );
}

const isActive = (path: string, to: string): boolean => (to === "/" ? path === "/" : path === to || path.startsWith(`${to}/`));

/** The app shell: sidebar (a top bar below 820 px), top bar with the crumb and the status. */
export function Shell({ path, crumb, children }: { path: string; crumb: string; children: ComponentChildren }) {
  const { t } = useI18n();
  const { state, refresh } = useApp();
  const { busy, run } = useAction();
  const logout = async () => {
    const r = await run(() => api.logout());
    // Even when the call fails the state read shows whether the session is still there.
    await refresh();
    return r;
  };
  return (
    <div class="app">
      <aside class="sidebar">
        <Brand />
        <div class="sidebar__scroll">
          <nav class="nav" aria-label={t("nav.aria")}>
            {NAV.map((n) => {
              const active = isActive(path, n.to);
              return (
                <Link key={n.to} to={n.to} class={`nav__item${active ? " is-active" : ""}`} aria-current={active ? "page" : undefined}>
                  {t(n.label)}
                </Link>
              );
            })}
          </nav>
        </div>
        <div class="sidebar__foot">
          {state.name ? <div class="sidebar__user">{t("nav.signedIn", { name: state.name })}</div> : null}
          <div class="nav">
            <button type="button" class="nav__item" onClick={logout} disabled={busy}>
              {t("nav.logout")}
            </button>
          </div>
        </div>
      </aside>
      <main class="page">
        <div class="topbar">
          <div class="crumb">
            <b>{crumb}</b>
          </div>
          <span class="status status--fresh">{t("status.running")}</span>
        </div>
        {children}
      </main>
    </div>
  );
}

/** A centred card for the screens shown before the app: setup, login, forced enrolment. */
export function AuthFrame({ children, wide }: { children: ComponentChildren; wide?: boolean }) {
  return (
    <div class="auth">
      <div class={`auth__card${wide ? " auth__card--wide" : ""}`}>
        <div class="auth__top">
          <Brand />
          <LangSwitch />
        </div>
        {children}
      </div>
    </div>
  );
}
