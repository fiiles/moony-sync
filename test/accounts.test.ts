import { describe, expect, it } from "vitest";
import { SELF_HOSTED_PAID_UNTIL } from "../src/limits.js";
import { addPerson, testApp } from "./helpers.js";

const me = (t: ReturnType<typeof testApp>, account?: string, method = "GET", path = "/v1/accounts/me") =>
  t.call(method, path, { headers: account ? { "moony-account": account } : {} });

describe("accounts", () => {
  it("POST /v1/accounts is closed", async () => {
    const t = testApp();
    const res = await t.call("POST", "/v1/accounts");
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "registration_closed" });
  });

  it("GET /v1/accounts/me without the header is 400 missing_account", async () => {
    const t = testApp();
    const res = await me(t);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "missing_account" });
  });

  it("unknown account is 404 account_not_found", async () => {
    const t = testApp();
    const res = await me(t, "1234567890123456");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "account_not_found" });
  });

  it("active person: paidUntil is the self-hosted constant", async () => {
    const t = testApp();
    const p = addPerson(t);
    const res = await me(t, p.account);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ paidUntil: 253402300799, active: true, vaults: 0 });
  });

  it("blocked person: paidUntil is the block time, inactive; unblocking restores it", async () => {
    const t = testApp();
    const p = addPerson(t);
    t.clock.now += 100;
    expect(t.stores.people.setState(p.id, "blocked").ok).toBe(true);
    expect(await (await me(t, p.account)).json()).toEqual({
      paidUntil: t.clock.now,
      active: false,
      vaults: 0,
    });
    t.clock.now += 50;
    expect(t.stores.people.paidUntil(p.account)).toBe(t.clock.now - 50);
    expect(t.stores.people.setState(p.id, "active").ok).toBe(true);
    expect(t.stores.people.paidUntil(p.account)).toBe(SELF_HOSTED_PAID_UNTIL);
    expect((await (await me(t, p.account)).json()) as object).toMatchObject({ active: true });
  });

  it("checkout, delete and a payment webhook route that does not exist", async () => {
    const t = testApp();
    const p = addPerson(t);
    const co = await me(t, p.account, "POST", "/v1/accounts/me/checkout");
    expect(co.status).toBe(409);
    expect(await co.json()).toEqual({ error: "self_hosted" });
    const del = await me(t, p.account, "DELETE");
    expect(del.status).toBe(403);
    expect(await del.json()).toEqual({ error: "managed_by_operator" });
    expect((await t.call("POST", "/v1/webhooks/payment")).status).toBe(404);
    expect((await t.call("POST", "/v1/dev/grant")).status).toBe(404);
    expect((await me(t, p.account, "PUT")).status).toBe(405);
  });
});

describe("people store", () => {
  it("creates unique 16-digit accounts and uuid ids", () => {
    const t = testApp();
    const accounts = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const p = addPerson(t, `P${i}`);
      expect(p.account).toMatch(/^[1-9][0-9]{15}$/);
      expect(p.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(p).toMatchObject({ state: "active", createdAt: t.clock.now, blockedAt: null });
      accounts.add(p.account);
    }
    expect(accounts.size).toBe(50);
  });

  it("validates names: trimmed, 1 to 80 characters", () => {
    const t = testApp();
    const { people } = t.stores;
    expect(people.create("  Ana  ").name).toBe("Ana");
    expect(() => people.create("   ")).toThrow("invalid_name");
    expect(() => people.create("x".repeat(81))).toThrow("invalid_name");
    expect(people.create("x".repeat(80)).name).toHaveLength(80);
    const p = people.create("Bob");
    expect(people.rename(p.id, " ")).toEqual({ ok: false, status: 400, error: "invalid_name" });
    expect(people.rename(p.id, " Bobby ").ok).toBe(true);
    expect(people.get(p.id)?.name).toBe("Bobby");
    expect(people.rename("nope", "X")).toEqual({ ok: false, status: 404, error: "person_not_found" });
  });

  it("lists, looks up, and removes", () => {
    const t = testApp();
    const { people } = t.stores;
    const a = people.create("A");
    t.clock.now += 1;
    const b = people.create("B");
    expect(people.list().map((p) => p.id)).toEqual([a.id, b.id]);
    expect(people.byAccount(b.account)?.id).toBe(b.id);
    expect(people.byAccount("0000000000000000")).toBeNull();
    expect(people.get("nope")).toBeNull();
    expect(people.paidUntil("0000000000000000")).toBeNull();
    expect(people.remove(a.id).ok).toBe(true);
    expect(people.remove(a.id)).toEqual({ ok: false, status: 404, error: "person_not_found" });
    expect(people.list()).toHaveLength(1);
    expect(people.setState("nope", "blocked").ok).toBe(false);
  });
});

describe("people rules", () => {
  it("the 1-80 name limit counts code points, not UTF-16 units", () => {
    const { people } = testApp().stores;
    const emoji80 = "\u{1F600}".repeat(80); // 160 UTF-16 units, 80 code points
    expect(people.create(emoji80).name).toBe(emoji80);
    expect(() => people.create("\u{1F600}".repeat(81))).toThrow("invalid_name");
    const p = people.create("x");
    expect(people.rename(p.id, emoji80).ok).toBe(true);
    expect(people.rename(p.id, "\u{1F600}".repeat(81))).toMatchObject({ ok: false, status: 400, error: "invalid_name" });
    expect(() => people.create("   ")).toThrow("invalid_name");
  });

  it("a repeated block keeps the first blockedAt", () => {
    const t = testApp();
    const p = t.stores.people.create("A");
    t.clock.now += 100;
    t.stores.people.setState(p.id, "blocked");
    const first = t.clock.now;
    t.clock.now += 500;
    t.stores.people.setState(p.id, "blocked");
    expect(t.stores.people.get(p.id)).toMatchObject({ state: "blocked", blockedAt: first });
  });

  it("POST /v1/accounts/me/checkout without the account header is 400 missing_account", async () => {
    const t = testApp();
    const res = await me(t, undefined, "POST", "/v1/accounts/me/checkout");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "missing_account" });
  });
});
