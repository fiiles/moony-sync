import { useCallback, useEffect, useMemo, useState } from "preact/hooks";
import { api, onAuthLost, type AuthState } from "./api";
import { LoadError } from "./components/bits";
import { Shell } from "./components/Shell";
import { Icon } from "./components/Icon";
import { AppCtx } from "./context";
import { errorMessage } from "./hooks";
import { useI18n } from "./i18n";
import { Link, usePath } from "./router";
import { Backup } from "./screens/Backup";
import { ForcedEnrol } from "./screens/ForcedEnrol";
import { Login } from "./screens/Login";
import { Overview } from "./screens/Overview";
import { People } from "./screens/People";
import { PersonDetail } from "./screens/PersonDetail";
import { Settings } from "./screens/Settings";
import { Setup } from "./screens/Setup";

function NotFound() {
  const { t } = useI18n();
  return (
    <div class="card">
      <div class="empty">
        <Icon name="alert" size={28} />
        <h3>{t("notfound.title")}</h3>
        <p>{t("notfound.text")}</p>
        <Link to="/" class="btn btn--primary">
          {t("notfound.action")}
        </Link>
      </div>
    </div>
  );
}

/** Which screen belongs to a path, and the breadcrumb for it. */
function Routes({ path }: { path: string }) {
  const { t } = useI18n();
  const person = /^\/people\/([^/]+)$/.exec(path);
  let crumb = t("nav.overview");
  let screen = <Overview />;
  if (path === "/people") {
    crumb = t("nav.people");
    screen = <People />;
  } else if (person) {
    crumb = t("nav.people");
    const id = decodeURIComponent(person[1]!);
    screen = <PersonDetail key={id} id={id} />;
  } else if (path === "/backup") {
    crumb = t("nav.backup");
    screen = <Backup />;
  } else if (path === "/settings") {
    crumb = t("nav.settings");
    screen = <Settings />;
  } else if (path !== "/") {
    crumb = t("notfound.title");
    screen = <NotFound />;
  }
  return (
    <Shell path={path} crumb={crumb}>
      {screen}
    </Shell>
  );
}

/** /admin/api/state decides the screen: setup, login, forced enrolment, or the app. */
export function App() {
  const { t } = useI18n();
  const path = usePath();
  const [state, setState] = useState<AuthState | null>(null);
  const [error, setError] = useState<unknown>(null);

  const refresh = useCallback(async () => {
    try {
      setState(await api.state());
      setError(null);
    } catch (e) {
      setError(e);
    }
  }, []);

  useEffect(() => {
    void refresh();
    onAuthLost(() => void refresh());
    return () => onAuthLost(null);
  }, [refresh]);

  const ctx = useMemo(() => (state ? { state, refresh } : null), [state, refresh]);

  if (!ctx) {
    return error ? (
      <div class="auth">
        <div class="auth__card">
          <LoadError message={errorMessage(t, error)} onRetry={() => void refresh()} />
        </div>
      </div>
    ) : (
      <div class="auth" aria-busy="true" aria-label={t("common.loading")} />
    );
  }
  return (
    <AppCtx.Provider value={ctx}>
      {ctx.state.setupNeeded ? <Setup /> : !ctx.state.authenticated ? <Login /> : ctx.state.mustEnrol2fa ? <ForcedEnrol /> : <Routes path={path} />}
    </AppCtx.Provider>
  );
}
