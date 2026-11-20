import { describe, expect, it } from "vitest";
import { createProxyWatch } from "../src/proxy-watch.js";

const req = (path: string, headers: Record<string, string> = {}) => new Request(`http://localhost${path}`, { headers });

describe("proxy watch", () => {
  it("stays quiet on a clean server", () => {
    const lines: string[] = [];
    const w = createProxyWatch(false, (l) => lines.push(l));
    w.see(req("/v1/server"));
    w.see(req("/admin/api/overview"));
    expect(w.warning()).toBeNull();
    expect(lines).toEqual([]);
    const on = createProxyWatch(true, (l) => lines.push(l));
    on.see(req("/v1/server", { "x-forwarded-for": "203.0.113.5" }));
    expect(on.warning()).toBeNull();
  });

  it("TRUST_PROXY off and a forwarding header: forwarded_untrusted, logged once", () => {
    for (const header of ["x-forwarded-for", "forwarded"]) {
      const lines: string[] = [];
      const w = createProxyWatch(false, (l) => lines.push(l));
      w.see(req("/v1/server", { [header]: "203.0.113.5" }));
      w.see(req("/v1/server", { [header]: "203.0.113.6" }));
      expect(w.warning()).toBe("forwarded_untrusted");
      expect(lines).toEqual(["proxy: forwarding headers seen while TRUST_PROXY is off; all clients share one rate limit"]);
    }
  });

  it("TRUST_PROXY on and no forwarding header: direct_client, logged once", () => {
    const lines: string[] = [];
    const w = createProxyWatch(true, (l) => lines.push(l));
    w.see(req("/admin/api/state"));
    w.see(req("/v1/server"));
    expect(w.warning()).toBe("direct_client");
    expect(lines).toEqual(["TRUST_PROXY is on: only your reverse proxy may reach this port", "proxy: a request arrived without forwarding headers while TRUST_PROXY is on; bind the port to the proxy only"]);
  });

  it("/health is not looked at", () => {
    const off = createProxyWatch(false, () => {});
    off.see(req("/health", { "x-forwarded-for": "203.0.113.5" }));
    expect(off.warning()).toBeNull();
    const on = createProxyWatch(true, () => {});
    on.see(req("/health"));
    expect(on.warning()).toBeNull();
  });

  it("the warning stays once set", () => {
    const w = createProxyWatch(true, () => {});
    w.see(req("/v1/server"));
    w.see(req("/v1/server", { "x-forwarded-for": "203.0.113.5" }));
    expect(w.warning()).toBe("direct_client");
  });

  it("says once at start that TRUST_PROXY is on, only then", () => {
    const lines: string[] = [];
    createProxyWatch(true, (l) => lines.push(l));
    expect(lines).toEqual(["TRUST_PROXY is on: only your reverse proxy may reach this port"]);
    const none: string[] = [];
    createProxyWatch(false, (l) => none.push(l));
    expect(none).toEqual([]);
  });
});
