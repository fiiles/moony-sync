// Test helpers: a mocked fetch for /admin/api and a render of the whole app.
import { cleanup, render } from "@testing-library/preact";
import { afterEach, beforeEach, vi } from "vitest";
import { App } from "../src/App";
import { LangProvider, type Lang } from "../src/i18n";
import { createElement } from "preact";

export interface Reply {
  status?: number;
  json?: unknown;
}
export type Handler = (body: any, call: { method: string; path: string }) => Reply | Promise<Reply>;

export interface Mock {
  routes: Record<string, Handler>;
  calls: { method: string; path: string; body: any }[];
}

/** Installs a fetch that answers "METHOD path" (path below /admin/api) from `routes`. */
export function installMock(routes: Record<string, Handler>): Mock {
  const mock: Mock = { routes, calls: [] };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? "GET";
      const path = String(url).replace(/^\/admin\/api\//, "");
      const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
      mock.calls.push({ method, path, body });
      const handler = mock.routes[`${method} ${path}`];
      if (!handler) return new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
      const r = await handler(body, { method, path });
      const status = r.status ?? (r.json === undefined ? 204 : 200);
      return new Response(r.json === undefined ? null : JSON.stringify(r.json), { status });
    }),
  );
  return mock;
}

export const loggedIn = { setupNeeded: false, authenticated: true, name: "Alex", twoFactor: false, require2fa: false, mustEnrol2fa: false };

export function overviewBody(over: Record<string, unknown> = {}) {
  return {
    address: "https://sync.example.com",
    addressSuggestion: "http://localhost:8791",
    people: 1,
    profiles: 2,
    bytesUsed: 41 * 1024 * 1024,
    bytesFree: 1.6 * 1024 ** 4,
    lastActivity: Math.floor(Date.now() / 1000) - 240,
    version: "1.0.0",
    insecure: false,
    ...over,
  };
}

export function person(over: Record<string, unknown> = {}) {
  return { id: "p1", name: "Anna", state: "active", profiles: 1, bytes: 3 * 1024 * 1024, lastActivity: null, createdAt: 1_800_000_000, ...over };
}

export function openApp(path = "/", lang: Lang = "en") {
  window.history.replaceState(null, "", path);
  return render(createElement(LangProvider, { initial: lang, children: createElement(App, {}) }));
}

export function setupDom() {
  beforeEach(() => {
    window.scrollTo = () => undefined;
    localStorage.clear();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });
}
