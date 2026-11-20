import { describe, expect, it } from "vitest";
import { clientKey, fixedWindow } from "../src/ratelimit.js";
import { newToken, newVaultId, testApp } from "./helpers.js";

describe("fixedWindow", () => {
  it("allows the limit, refuses beyond it, and starts over in the next window", () => {
    let now = 1000;
    const l = fixedWindow(3, 60, () => now);
    expect([l.hit("a"), l.hit("a"), l.hit("a"), l.hit("a")]).toEqual([false, false, false, true]);
    expect(l.hit("b")).toBe(false);
    now += 60;
    expect(l.hit("a")).toBe(false);
  });
});

describe("fixedWindow.clear", () => {
  it("forgets every count in the current window", () => {
    const l = fixedWindow(1, 60, () => 1000);
    l.hit("a");
    l.hit("b");
    expect([l.over("a"), l.over("b")]).toEqual([true, true]);
    l.clear();
    expect([l.over("a"), l.over("b")]).toEqual([false, false]);
    expect(l.reserve("a")).not.toBeNull();
  });
});

describe("fixedWindow.reserve", () => {
  it("counts before the work, refuses past the limit, and refunds in the same window only", () => {
    let now = 1000;
    const l = fixedWindow(2, 60, () => now);
    const a = l.reserve("k")!;
    const b = l.reserve("k")!;
    expect(l.reserve("k")).toBeNull();
    a();
    expect(l.over("k")).toBe(false);
    const c = l.reserve("k")!;
    expect(c).not.toBeNull();
    expect(l.reserve("k")).toBeNull();
    now += 60;
    const d = l.reserve("k")!;
    b(); // a refund from the earlier window must not touch this one
    expect(l.reserve("k")).not.toBeNull();
    expect(l.reserve("k")).toBeNull();
    d();
  });
});

describe("fixedWindow.over", () => {
  it("reports an used-up quota without counting, and resets with the window", () => {
    let now = 1000;
    const l = fixedWindow(2, 60, () => now);
    expect([l.over("a"), l.over("a")]).toEqual([false, false]);
    l.hit("a");
    l.hit("a");
    expect(l.over("a")).toBe(true);
    expect(l.over("b")).toBe(false);
    now += 60;
    expect(l.over("a")).toBe(false);
  });
});

describe("clientKey", () => {
  const req = (h: Record<string, string> = {}) => new Request("http://x/", { headers: h });
  it("ignores X-Forwarded-For unless the proxy is trusted", () => {
    const r = req({ "x-forwarded-for": "198.51.100.9, 10.0.0.1" });
    expect(clientKey(r, "192.0.2.1", false)).toBe("192.0.2.1");
    expect(clientKey(r, "192.0.2.1", true)).toBe("10.0.0.1");
  });
  it("keys an IPv6 address by its /64, an IPv4-mapped one as the IPv4", () => {
    const key = (a: string) => clientKey(req(), a, false);
    expect(key("2001:db8:1:2:aaaa:bbbb:cccc:dddd")).toBe(key("2001:db8:1:2::1"));
    expect(key("2001:db8:1:2::1")).not.toBe(key("2001:db8:1:3::1"));
    expect(key("2001:DB8:1:2:0:0:0:9")).toBe(key("2001:db8:1:2::"));
    expect(key("::ffff:192.0.2.7")).toBe("192.0.2.7");
    expect(key("192.0.2.7")).toBe("192.0.2.7");
    expect(key("fe80::1%eth0")).toBe(key("fe80::2"));
    expect(clientKey(req({ "x-forwarded-for": "10.0.0.1, 2001:db8:1:2::5" }), "192.0.2.1", true)).toBe(key("2001:db8:1:2::1"));
  });
  it("falls back to the socket address, then to 'local'", () => {
    expect(clientKey(req(), "192.0.2.1", true)).toBe("192.0.2.1");
    expect(clientKey(req(), undefined, false)).toBe("local");
    expect(clientKey(req({ "x-forwarded-for": "  " }), undefined, true)).toBe("local");
  });
});

describe("rate limits over HTTP", () => {
  it("limits account lookups to 60 a minute per address", async () => {
    const t = testApp();
    const lookup = (ip: string) =>
      t.call("GET", "/v1/accounts/me", { headers: { "moony-account": "1234567890123456" }, clientAddress: ip });
    for (let i = 0; i < 60; i++) expect((await lookup("203.0.113.1")).status).toBe(404);
    const over = await lookup("203.0.113.1");
    expect(over.status).toBe(429);
    expect(await over.json()).toEqual({ error: "rate_limited" });
    expect((await lookup("203.0.113.2")).status).toBe(404);
    t.clock.now += 60;
    expect((await lookup("203.0.113.1")).status).toBe(404);
  });

  it("shares the account-lookup limiter with GET /v1/server and POST /v1/accounts", async () => {
    const t = testApp();
    for (let i = 0; i < 30; i++) await t.call("GET", "/v1/server", { clientAddress: "203.0.113.3" });
    for (let i = 0; i < 30; i++) await t.call("POST", "/v1/accounts", { clientAddress: "203.0.113.3" });
    expect((await t.call("GET", "/v1/server", { clientAddress: "203.0.113.3" })).status).toBe(429);
    expect((await t.call("POST", "/v1/accounts", { clientAddress: "203.0.113.3" })).status).toBe(429);
  });

  it("uses X-Forwarded-For only with trustProxy", async () => {
    const trusting = testApp({ trustProxy: true });
    const plain = testApp();
    const hit = (t: typeof plain, who: string) =>
      t.call("GET", "/v1/server", { headers: { "x-forwarded-for": who }, clientAddress: "192.0.2.1" });
    for (let i = 0; i < 60; i++) {
      await hit(trusting, "198.51.100.1");
      await hit(plain, `198.51.100.${i}`);
    }
    expect((await hit(trusting, "198.51.100.1")).status).toBe(429);
    expect((await hit(trusting, "198.51.100.2")).status).toBe(200);
    expect((await hit(plain, "198.51.100.200")).status).toBe(429); // one key: the socket's
  });

  it("limits vault routes to 1200 a minute per address, 401s counted", async () => {
    const t = testApp();
    const id = newVaultId();
    const get = (ip: string) =>
      t.call("GET", `/v1/vaults/${id}`, { headers: { authorization: `Bearer ${newToken()}` }, clientAddress: ip });
    for (let i = 0; i < 1200; i++) expect((await get("203.0.113.4")).status).toBe(404);
    expect((await get("203.0.113.4")).status).toBe(429);
    expect((await get("203.0.113.5")).status).toBe(404);
  });

  it("limits per vault and token: 600 a minute, other tokens and other addresses of the same vault unaffected", async () => {
    const t = testApp();
    const id = newVaultId();
    const token = newToken();
    const get = (tok: string, ip: string) =>
      t.call("GET", `/v1/vaults/${id}`, { headers: { authorization: `Bearer ${tok}` }, clientAddress: ip });
    for (let i = 0; i < 600; i++) await get(token, `10.0.${i % 2}.1`);
    expect((await get(token, "10.9.9.9")).status).toBe(429);
    expect((await get(newToken(), "10.9.9.9")).status).toBe(404);
  });

  it("vault creation also counts against the account-lookup limit", async () => {
    const t = testApp();
    const create = () =>
      t.call("PUT", `/v1/vaults/${newVaultId()}`, {
        headers: { authorization: `Bearer ${newToken()}`, "moony-account": "1234567890123456" },
        clientAddress: "203.0.113.6",
      });
    for (let i = 0; i < 60; i++) expect((await create()).status).not.toBe(429);
    expect((await create()).status).toBe(429);
  });

  it("malformed mailbox IDs and slots do not count against the pairing limit", async () => {
    const t = testApp();
    const ip = "203.0.113.9";
    const id = newVaultId();
    for (let i = 0; i < 130; i++) {
      expect((await t.call("GET", "/v1/pairing/short/1", { clientAddress: ip })).status).toBe(400);
      expect((await t.call("GET", `/v1/pairing/${id}/9`, { clientAddress: ip })).status).toBe(400);
    }
    expect((await t.call("GET", `/v1/pairing/${id}/1`, { clientAddress: ip })).status).toBe(404);
  });

  it("limits pairing to 120 a minute per address", async () => {
    const t = testApp();
    const id = newVaultId();
    const get = (ip: string) => t.call("GET", `/v1/pairing/${id}/1`, { clientAddress: ip });
    for (let i = 0; i < 120; i++) expect((await get("203.0.113.7")).status).toBe(404);
    expect((await get("203.0.113.7")).status).toBe(429);
    expect((await get("203.0.113.8")).status).toBe(404);
  });
});
