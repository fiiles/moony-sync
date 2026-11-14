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
  reload(): void;
  set(data: T): void;
}

/** Loads something once (and again on reload()); `deps` restarts it. */
export function useResource<T>(load: () => Promise<T>, deps: unknown[] = []): Resource<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => {
    let live = true;
    setLoading(true);
    loadRef.current().then(
      (d) => {
        if (!live) return;
        setData(d);
        setError(null);
        setLoading(false);
      },
      (e: unknown) => {
        if (!live) return;
        setError(e);
        setLoading(false);
      },
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, ...deps]);
  const reload = useCallback(() => setTick((n) => n + 1), []);
  return { data, error, loading, reload, set: setData };
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
