// Unauthenticated bodies are never read: the token is checked first, and the bodies being
// buffered at once share one budget.

import { describe, expect, it, vi } from "vitest";
import { countingBody, newToken, newVault, newVaultId, testApp, type Vault } from "./helpers.js";

function post(t: ReturnType<typeof testApp>, path: string, token: string, body: ReadableStream<Uint8Array>) {
  return t.app.fetch(
    new Request(`http://localhost${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body,
      duplex: "half",
    } as RequestInit),
  );
}

describe("token before body", () => {
  const t = testApp();

  for (const sub of ["ops", "token"]) {
    it(`${sub}: unknown vault answers 404 without reading the body`, async () => {
      const { state, body } = countingBody();
      const r = await post(t, `/v1/vaults/${newVaultId()}/${sub}`, newToken(), body);
      expect(r.status).toBe(404);
      expect(await r.json()).toEqual({ error: "vault_not_found" });
      expect(state.pulled).toBeLessThanOrEqual(1);
    });

    it(`${sub}: wrong token answers 401 without reading the body`, async () => {
      const v = await newVault(t);
      const { state, body } = countingBody();
      const r = await post(t, `/v1/vaults/${v.id}/${sub}`, newToken(), body);
      expect(r.status).toBe(401);
      expect(state.pulled).toBeLessThanOrEqual(1);
    });
  }

  it("a retired (read-only) token answers 403 token_read_only before the body", async () => {
    const v = await newVault(t);
    const next = newToken();
    const rot = await t.call("POST", `/v1/vaults/${v.id}/token`, {
      headers: { authorization: `Bearer ${v.token}`, "content-type": "application/json" },
      body: JSON.stringify({ token: next, rekey: btoa("rekey-bundle") }),
    });
    expect(rot.status).toBe(200);
    for (const sub of ["ops", "token"]) {
      const { state, body } = countingBody();
      const r = await post(t, `/v1/vaults/${v.id}/${sub}`, v.token, body);
      expect(r.status).toBe(403);
      expect(await r.json()).toEqual({ error: "token_read_only" });
      expect(state.pulled).toBeLessThanOrEqual(1);
    }
  });

  it("a blocked person's push answers the lapsed error before the body", async () => {
    const v: Vault = await newVault(t);
    const person = t.stores.people.byAccount(v.account)!;
    t.stores.people.setState(person.id, "blocked");
    t.clock.now += 1;
    const { state, body } = countingBody();
    const r = await post(t, `/v1/vaults/${v.id}/ops`, v.token, body);
    expect(r.status).toBe(402);
    expect(await r.json()).toEqual({ error: "payment_required" });
    expect(state.pulled).toBeLessThanOrEqual(1);
  });

  it("check() is side-effect free", async () => {
    const v = await newVault(t);
    const before = t.db.prepare("SELECT last_activity FROM vaults WHERE vault_id = ?").get(v.id);
    t.clock.now += 3600;
    expect(t.stores.vaults.check(v.id, v.token, "write")).toEqual({ ok: true });
    expect(t.db.prepare("SELECT last_activity FROM vaults WHERE vault_id = ?").get(v.id)).toEqual(before);
  });
});

/** A body that is held open: it may deliver `first` bytes at once and then nothing until ended. */
function heldBody(first = 0) {
  let ctl!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      ctl = c;
      if (first > 0) c.enqueue(new Uint8Array(first).fill(0x20));
    },
  });
  return { body, end: () => ctl.error(new Error("client gone")) };
}

describe("in-flight body budget", () => {
  it("answers 503 busy once 64 MiB of body bytes have actually arrived and are being buffered", async () => {
    const t = testApp();
    const v = await newVault(t);
    const held = Array.from({ length: 16 }, () => heldBody(4 * 1024 * 1024));
    const pending = held.map((h) => post(t, `/v1/vaults/${v.id}/ops`, v.token, h.body));
    await new Promise((r) => setTimeout(r, 100)); // let every request read its first chunk
    const extra = heldBody(1);
    const r = await post(t, `/v1/vaults/${v.id}/ops`, v.token, extra.body);
    expect(r.status).toBe(503);
    expect(await r.json()).toEqual({ error: "busy" });
    // Everything is given back when the bodies end.
    for (const h of held) h.end();
    await Promise.allSettled(pending);
    const { body } = countingBody(1);
    expect((await post(t, `/v1/vaults/${v.id}/ops`, v.token, body)).status).not.toBe(503);
  });

  it("4,097 idle logins that declared 16 KiB and sent nothing hold no budget: a push still works", async () => {
    const t = testApp();
    const v = await newVault(t);
    const held = Array.from({ length: 4097 }, () => heldBody());
    const logins = held.map((h) =>
      t.app.fetch(
        new Request("http://localhost/admin/api/login", {
          method: "POST",
          headers: { origin: "http://localhost", "content-type": "application/json", "content-length": "16384" },
          body: h.body,
          duplex: "half",
        } as RequestInit),
      ),
    );
    await new Promise((r) => setTimeout(r, 200));
    const ok = await t.call("POST", `/v1/vaults/${v.id}/ops`, {
      headers: { authorization: `Bearer ${v.token}`, "content-type": "application/json" },
      body: JSON.stringify({ ops: [{ id: "a".repeat(22), ct: "AAAA" }] }),
    });
    expect(ok.status).toBe(200);
    for (const h of held) h.end();
    await Promise.allSettled(logins);
  }, 30_000);
});

describe("per-client share of the body budget", () => {
  const login = (t: ReturnType<typeof testApp>, address: string, body: ReadableStream<Uint8Array>) =>
    t.app.fetch(
      new Request("http://localhost/admin/api/login", {
        method: "POST",
        headers: { origin: "http://localhost", "content-type": "application/json" },
        body,
        duplex: "half",
      } as RequestInit),
      address,
    );

  it("one address holding 8 MiB of half-sent bodies gets 503 busy; other addresses are unaffected; the share is released", async () => {
    const t = testApp();
    const v = await newVault(t);
    const held = Array.from({ length: 512 }, () => heldBody(16 * 1024)); // 512 x 16 KiB = 8 MiB
    const pending = held.map((h) => login(t, "203.0.113.9", h.body));
    await new Promise((r) => setTimeout(r, 200));
    const extra = heldBody(1);
    const r = await login(t, "203.0.113.9", extra.body);
    expect(r.status).toBe(503);
    expect(await r.json()).toEqual({ error: "busy" });
    // A different address (and a different IPv6 /64) still gets through.
    const push = (address: string) =>
      t.call("POST", `/v1/vaults/${v.id}/ops`, {
        headers: { authorization: `Bearer ${v.token}`, "content-type": "application/json" },
        body: JSON.stringify({ ops: [{ id: "a".repeat(22), ct: "AAAA" }] }),
        clientAddress: address,
      });
    expect((await push("203.0.113.10")).status).toBe(200);
    // The same address is refused on the sync API too (the share is per client, not per route).
    const samePush = await t.app.fetch(
      new Request(`http://localhost/v1/vaults/${v.id}/ops`, {
        method: "POST",
        headers: { authorization: `Bearer ${v.token}`, "content-type": "application/json" },
        body: JSON.stringify({ ops: [{ id: "b".repeat(22), ct: "AAAA" }] }),
      }),
      "203.0.113.9",
    );
    expect(samePush.status).toBe(503);
    // ...and gets its share back once the held bodies abort.
    for (const h of held) h.end();
    await Promise.allSettled(pending);
    const again = await login(t, "203.0.113.9", countingBody(1).body);
    expect(again.status).not.toBe(503);
  }, 30_000);
});

describe("idle body timeout", () => {
  it("a body that delivers no bytes for 30 seconds is aborted with 408 body_timeout", async () => {
    const t = testApp();
    const v = await newVault(t);
    vi.useFakeTimers();
    try {
      const h = heldBody();
      const res = post(t, `/v1/vaults/${v.id}/ops`, v.token, h.body);
      await vi.advanceTimersByTimeAsync(29_000);
      await vi.advanceTimersByTimeAsync(2_000);
      const r = await res;
      expect(r.status).toBe(408);
      expect(await r.json()).toEqual({ error: "body_timeout" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("a body that keeps delivering is not cut off by the idle timer", async () => {
    const t = testApp();
    const v = await newVault(t);
    vi.useFakeTimers();
    try {
      let ctl!: ReadableStreamDefaultController<Uint8Array>;
      const body = new ReadableStream<Uint8Array>({ start: (c) => void (ctl = c) });
      const res = post(t, `/v1/vaults/${v.id}/ops`, v.token, body);
      const enc = new TextEncoder();
      ctl.enqueue(enc.encode('{"ops":'));
      await vi.advanceTimersByTimeAsync(25_000);
      ctl.enqueue(enc.encode(`[{"id":"${"a".repeat(22)}","ct":"AAAA"}]`));
      await vi.advanceTimersByTimeAsync(25_000);
      ctl.enqueue(enc.encode("}"));
      ctl.close();
      expect((await res).status).toBe(200);
    } finally {
      vi.useRealTimers();
    }
  });
});
