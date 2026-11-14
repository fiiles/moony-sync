// Unauthenticated bodies are never read: the token is checked first, and the bodies being
// buffered at once share one budget.

import { describe, expect, it } from "vitest";
import { newToken, newVault, newVaultId, testApp, type Vault } from "./helpers.js";

/** A body that counts the chunks the server pulled; each chunk is 64 KiB, `chunks` in all. */
function countingBody(chunks = 40) {
  const state = { pulled: 0 };
  const chunk = new Uint8Array(64 * 1024).fill(0x20);
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (state.pulled >= chunks) return controller.close();
        state.pulled += 1;
        controller.enqueue(chunk);
      },
    },
    { highWaterMark: 0 },
  );
  return { state, body };
}

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

describe("in-flight body budget", () => {
  it("answers 503 busy once 64 MiB of bodies are being buffered", async () => {
    const t = testApp();
    const v = await newVault(t);
    const open: ReadableStreamDefaultController<Uint8Array>[] = [];
    const hanging = () =>
      new ReadableStream<Uint8Array>({
        start(c) {
          open.push(c);
        },
      });
    const pending = Array.from({ length: 16 }, () => post(t, `/v1/vaults/${v.id}/ops`, v.token, hanging()));
    await new Promise((r) => setTimeout(r, 50)); // let every request reach its body read
    const r = await post(t, `/v1/vaults/${v.id}/ops`, v.token, hanging());
    expect(r.status).toBe(503);
    expect(await r.json()).toEqual({ error: "busy" });
    // The budget is given back when the bodies end.
    for (const c of open) c.error(new Error("client gone"));
    await Promise.allSettled(pending);
    const { body } = countingBody(1);
    const ok = await post(t, `/v1/vaults/${v.id}/ops`, v.token, body);
    expect(ok.status).not.toBe(503);
  });
});
