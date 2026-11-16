import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { ApiError } from "./api";
import { en, type Key } from "./i18n/en";
import type { T } from "./i18n";

/** The message for any error: the server's error name translated, or a generic one. Never raw JSON. */
export function errorMessage(t: T, err: unknown): string {
  if (err instanceof ApiError) {
    const key = `err.${err.code}` as Key;
    if (key in en) return t(key);
  }
  return t("err.generic");
}

export interface Resource<T> {
  data: T | null;
  error: unknown;
  loading: boolean;
  /** True while a quiet refresh (refresh(), timer or focus) is running. Never set by reload(). */
  refreshing: boolean;
  reload(): void;
  /** Fetches again without a loading state; old data stays on screen and a failure is ignored. */
  refresh(): Promise<void>;
  set(data: T): void;
}

export interface ResourceOptions {
  /** Refresh quietly this often while the page is visible (never while hidden). */
  refreshEveryMs?: number;
  /** Refresh quietly when the window gets focus or the tab becomes visible again. */
  refreshOnFocus?: boolean;
}

/** Loads something once (and again on reload()); `deps` restarts it. Opt-in quiet refreshing via `options`. */
export function useResource<T>(load: () => Promise<T>, deps: unknown[] = [], options: ResourceOptions = {}): Resource<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [tick, setTick] = useState(0);
  const loadRef = useRef(load);
  loadRef.current = load;
  // Bumped whenever the main load restarts or the hook unmounts: older replies are dropped.
  const generation = useRef(0);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => void (mounted.current = false);
  }, []);
  useEffect(() => {
    const mine = ++generation.current;
    inFlight.current = false;
    setLoading(true);
    loadRef.current().then(
      (d) => {
        if (mine !== generation.current) return;
        setData(d);
        setError(null);
        setLoading(false);
      },
      (e: unknown) => {
        if (mine !== generation.current) return;
        setError(e);
        setLoading(false);
      },
    );
    return () => {
      generation.current++;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, ...deps]);
  const reload = useCallback(() => setTick((n) => n + 1), []);
  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    const mine = generation.current;
    setRefreshing(true);
    try {
      const d = await loadRef.current();
      if (mine === generation.current && mounted.current) {
        setData(d);
        setError(null);
      }
    } catch {
      // Keep what is on screen; the next refresh tries again.
    } finally {
      if (mine === generation.current) inFlight.current = false;
      if (mounted.current) setRefreshing(false);
    }
  }, []);
  const { refreshEveryMs, refreshOnFocus } = options;
  useEffect(() => {
    if (!refreshEveryMs && !refreshOnFocus) return;
    const visible = () => document.visibilityState !== "hidden";
    const onShow = () => {
      if (visible()) void refresh();
    };
    let timer: ReturnType<typeof setInterval> | undefined;
    if (refreshEveryMs) timer = setInterval(onShow, refreshEveryMs);
    if (refreshOnFocus) {
      window.addEventListener("focus", onShow);
      document.addEventListener("visibilitychange", onShow);
    }
    return () => {
      if (timer) clearInterval(timer);
      window.removeEventListener("focus", onShow);
      document.removeEventListener("visibilitychange", onShow);
    };
  }, [refresh, refreshEveryMs, refreshOnFocus]);
  return { data, error, loading, refreshing, reload, refresh, set: setData };
}

export type Outcome<R> = { ok: true; value: R } | { ok: false; error: unknown };

/** One request at a time: `busy` while it runs, `error` after it fails (also in the outcome). */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const mounted = useRef(true);
  // A ref, not the busy state: two calls in the same tick must still make one request.
  const inFlight = useRef(false);
  useEffect(() => () => void (mounted.current = false), []);
  const run = useCallback(async <R,>(fn: () => Promise<R>): Promise<Outcome<R>> => {
    if (inFlight.current) return { ok: false, error: null };
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const value = await fn();
      return { ok: true, value };
    } catch (e) {
      if (mounted.current) setError(e);
      return { ok: false, error: e };
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  }, []);
  const clear = useCallback(() => setError(null), []);
  return { busy, error, run, clear };
}
