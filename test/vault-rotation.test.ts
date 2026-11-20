// Token rotation.

import { describe, expect, it } from "vitest";
import { DAY } from "../src/limits.js";
import {
  auth,
  b64,
  newToken,
  newVault,
  pull,
  push,
  testApp,
  unb64,
  uploadSnapshot,
  type PullBody,
  type TestApp,
  type Vault,
} from "./helpers.js";

const ops = (prefix: string, n: number) =>
  Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i}`, ct: b64(`${prefix}-cipher-${i}`) }));

const rekeyOf = (s: string): string => b64(s);

const rotate = (t: TestApp, v: Vault, next: string, rekey: string = rekeyOf("bundle-1")): Promise<Response> =>
  t.call("POST", `/v1/vaults/${v.id}/token`, {
    headers: auth(v, { "content-type": "application/json" }),
    body: JSON.stringify({ token: next, rekey }),
  });

type Info = { head: number; rotation: number };
const infoOf = (t: TestApp, v: Vault): Promise<Response> =>
  t.call("GET", `/v1/vaults/${v.id}`, { headers: auth(v) });
type Rekeys = { rekeys: { rotation: number; head: number; at: number; rekey: string }[] };
const rekeys = (t: TestApp, v: Vault, after?: number): Promise<Response> =>
  t.call("GET", `/v1/vaults/${v.id}/rekey${after === undefined ? "" : `?after=${after}`}`, {
    headers: auth(v),
  });
const rotationOf = async (t: TestApp, v: Vault) => ((await (await infoOf(t, v)).json()) as Info).rotation;
const count = (t: TestApp, table: string, id: string): number =>
  (t.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE vault_id = ?`).get(id) as { n: number }).n;

describe("token rotation", () => {
  it("makes the new token current and the old one read-only", async () => {
    const t = testApp();
    const v = await newVault(t);
    await push(t, v, ops("t", 3));
    await uploadSnapshot(t, v, 3, "snap-3");
    expect(await rotationOf(t, v)).toBe(0);

    const next = newToken();
    const res = await rotate(t, v, next);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ rotation: 1, head: 3 });

    const fresh = { ...v, token: next };
    expect((await pull(t, fresh)).status).toBe(200);
    expect((await push(t, fresh, ops("after", 1))).status).toBe(200);
    expect(await rotationOf(t, fresh)).toBe(1);

    // The old token reads only the vault info and the key changes.
    const info = (await (await infoOf(t, v)).json()) as Info;
    expect(info).toMatchObject({ rotation: 1, head: 4 });
    expect((await rekeys(t, v)).status).toBe(200);

    // Anything else is refused, pull and snapshot included.
    const refused = [
      await pull(t, v),
      await t.call("GET", `/v1/vaults/${v.id}/snapshot`, { headers: auth(v) }),
      await push(t, v, ops("late", 1)),
      await uploadSnapshot(t, v, 4, "snap-4"),
      await rotate(t, v, newToken()),
      await t.call("DELETE", `/v1/vaults/${v.id}`, { headers: auth(v) }),
    ];
    for (const r of refused) {
      expect(r.status).toBe(403);
      expect(await r.json()).toEqual({ error: "token_read_only" });
    }
    // The new token does all of it.
    expect(((await (await pull(t, fresh)).json()) as PullBody).ops).toHaveLength(4);
    const snap = await t.call("GET", `/v1/vaults/${fresh.id}/snapshot`, { headers: auth(fresh) });
    expect(await snap.text()).toBe("snap-3");
    expect((await rekeys(t, fresh)).status).toBe(200);
    expect((await infoOf(t, fresh)).status).toBe(200);
  });

  it("refuses a retired token on pull before looking at the floor", async () => {
    const t = testApp();
    const v = await newVault(t);
    await push(t, v, ops("o", 4));
    await uploadSnapshot(t, v, 3, "snap-3");
    t.db.prepare("UPDATE ops SET created_at = ? WHERE vault_id = ?").run(t.clock.now - 40 * DAY, v.id);
    t.stores.vaults.housekeep(v.id);
    const next = newToken();
    expect((await rotate(t, v, next)).status).toBe(200);

    const retired = await pull(t, v, 0);
    expect([retired.status, await retired.json()]).toEqual([403, { error: "token_read_only" }]);
    expect((await pull(t, { ...v, token: next }, 0)).status).toBe(410);
  });

  it("keeps the read grace of a blocked person for the current token", async () => {
    const t = testApp();
    const v = await newVault(t);
    await push(t, v, ops("g", 1));
    t.stores.people.setState(t.stores.people.byAccount(v.account)!.id, "blocked");
    t.clock.now += DAY;
    expect((await pull(t, v)).status).toBe(200);
    const write = await push(t, v, ops("h", 1));
    expect([write.status, await write.json()]).toEqual([402, { error: "payment_required" }]);
  });

  it("stores the rekey bundle with its rotation number, head and time", async () => {
    const t = testApp();
    const v = await newVault(t);
    await push(t, v, ops("r", 2));
    const t1 = newToken();
    const t2 = newToken();
    const before = t.clock.now;
    expect(await (await rotate(t, v, t1, rekeyOf("one"))).json()).toEqual({ rotation: 1, head: 2 });
    const v1 = { ...v, token: t1 };
    await push(t, v1, ops("s", 1));
    expect(await (await rotate(t, v1, t2, rekeyOf("two"))).json()).toEqual({ rotation: 2, head: 3 });

    // Current and previous tokens both read the bundles, oldest first.
    for (const reader of [{ ...v, token: t2 }, v1, v]) {
      const body = (await (await rekeys(t, reader)).json()) as Rekeys;
      expect(body.rekeys.map((r) => [r.rotation, r.head, unb64(r.rekey)])).toEqual([
        [1, 2, "one"],
        [2, 3, "two"],
      ]);
      expect(body.rekeys[0]!.at).toBeGreaterThanOrEqual(before);
    }
    const later = (await (await rekeys(t, { ...v, token: t2 }, 1)).json()) as Rekeys;
    expect(later.rekeys.map((r) => r.rotation)).toEqual([2]);
    expect(((await (await rekeys(t, { ...v, token: t2 }, 2)).json()) as Rekeys).rekeys).toEqual([]);
  });

  it("works for a blocked person, so a lost device can still be locked out", async () => {
    const t = testApp();
    const v = await newVault(t);
    t.stores.people.setState(t.stores.people.byAccount(v.account)!.id, "blocked");
    t.clock.now += 60 * DAY;
    const next = newToken();
    expect((await rotate(t, v, next)).status).toBe(200);
    expect((await rotate(t, { ...v, token: next }, newToken())).status).toBe(200);
  });

  it("validates the call", async () => {
    const t = testApp();
    const v = await newVault(t);
    const send = (body: unknown) =>
      t.call("POST", `/v1/vaults/${v.id}/token`, {
        headers: auth(v, { "content-type": "application/json" }),
        body: JSON.stringify(body),
      });

    expect((await send({ rekey: rekeyOf("x") })).status).toBe(400);
    expect(await (await send({ token: "short", rekey: rekeyOf("x") })).json()).toEqual({
      error: "invalid_token",
    });
    expect(await (await send({ token: newToken() })).json()).toEqual({ error: "invalid_rekey" });
    expect((await send({ token: newToken(), rekey: "not base64!" })).status).toBe(400);
    expect((await send({ token: newToken(), rekey: "" })).status).toBe(400);
    expect((await send({ token: v.token, rekey: rekeyOf("x") })).status).toBe(400);

    const big = await send({ token: newToken(), rekey: btoa("a".repeat(256 * 1024 + 1)) });
    expect(big.status).toBe(413);
    expect(await big.json()).toEqual({ error: "rekey_too_large" });

    // None of the refused calls rotated anything; a bundle of exactly 256 KiB fits.
    expect(await rotationOf(t, v)).toBe(0);
    expect((await send({ token: newToken(), rekey: btoa("a".repeat(256 * 1024)) })).status).toBe(200);
    expect(await rotationOf(t, v)).toBe(1);
  });

  it("refuses a wrong token", async () => {
    const t = testApp();
    const v = await newVault(t);
    expect((await rotate(t, { ...v, token: newToken() }, newToken())).status).toBe(401);
    expect(await rotationOf(t, v)).toBe(0);
  });

  it("lets only one of two concurrent rotations win", async () => {
    const t = testApp();
    const v = await newVault(t);
    const [a, b] = await Promise.all([rotate(t, v, newToken()), rotate(t, v, newToken())]);
    expect([a.status, b.status].sort()).toEqual([200, 403]);
    const loser = a.status === 403 ? a : b;
    expect(await loser.json()).toEqual({ error: "token_read_only" });
    expect(await rotationOf(t, v)).toBe(1);
  });

  it("forgets a previous token after 30 days and prunes old bundles in housekeeping", async () => {
    const t = testApp();
    const v = await newVault(t);
    const t1 = newToken();
    await rotate(t, v, t1, rekeyOf("old"));
    const v1 = { ...v, token: t1 };
    const t2 = newToken();
    await rotate(t, v1, t2, rekeyOf("new"));
    const v2 = { ...v, token: t2 };

    // Rotation 1 retired v's token 31 days ago; rotation 2 retired v1's just now.
    t.db.prepare("UPDATE rekeys SET at = ? WHERE vault_id = ? AND rotation = 1").run(
      t.clock.now - 31 * DAY,
      v.id,
    );
    t.db
      .prepare(
        "UPDATE prev_tokens SET rotated_at = ? WHERE rowid = (SELECT MIN(rowid) FROM prev_tokens WHERE vault_id = ?)",
      )
      .run(t.clock.now - 31 * DAY, v.id);
    expect((await rekeys(t, v)).status).toBe(401);
    expect((await rekeys(t, v1)).status).toBe(200);
    expect(count(t, "prev_tokens", v.id)).toBe(2);

    t.stores.vaults.housekeep(v.id);
    expect(count(t, "prev_tokens", v.id)).toBe(1);
    expect(count(t, "rekeys", v.id)).toBe(1);
    const left = (await (await rekeys(t, v2)).json()) as Rekeys;
    expect(left.rekeys.map((r) => r.rotation)).toEqual([2]);

    // Numbering carries on even though bundle 1 is gone.
    expect(await (await rotate(t, v2, newToken())).json()).toMatchObject({ rotation: 3 });
  });

  it("caps retained bundles at 32; housekeeping frees slots", async () => {
    const t = testApp();
    let v = await newVault(t);
    const first = v;
    for (let i = 1; i <= 32; i++) {
      const next = newToken();
      expect((await rotate(t, v, next)).status).toBe(200);
      v = { ...v, token: next };
    }
    const refused = await rotate(t, v, newToken());
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ error: "too_many_rotations" });
    expect(await rotationOf(t, v)).toBe(32);

    t.db
      .prepare("UPDATE rekeys SET at = ? WHERE vault_id = ? AND rotation <= 5")
      .run(t.clock.now - 31 * DAY, first.id);
    t.stores.vaults.housekeep(first.id);
    expect(await (await rotate(t, v, newToken())).json()).toMatchObject({ rotation: 33 });
  });

  it("enforces the 30-day bundle age at request time, with no housekeeping", async () => {
    const t = testApp();
    let v = await newVault(t);
    const first = v;
    for (let i = 1; i <= 32; i++) {
      const next = newToken();
      expect((await rotate(t, v, next, rekeyOf(`b${i}`))).status).toBe(200);
      v = { ...v, token: next };
    }
    // Bundle 1 is 30 days + 1 s old: neither served nor counted against the cap of 32.
    t.db
      .prepare("UPDATE rekeys SET at = ? WHERE vault_id = ? AND rotation = 1")
      .run(t.clock.now - 30 * DAY - 1, first.id);
    const served = (await (await rekeys(t, v)).json()) as Rekeys;
    expect(served.rekeys.map((r) => r.rotation)).not.toContain(1);
    expect(served.rekeys[0]!.rotation).toBe(2);
    expect(await (await rotate(t, v, newToken())).json()).toMatchObject({ rotation: 33 });
    // Exactly 30 days old is already forgotten by housekeeping (at <= now - 30 d), so also here.
    t.db.prepare("UPDATE rekeys SET at = ? WHERE vault_id = ? AND rotation = 2").run(t.clock.now - 30 * DAY, first.id);
    const page = (await (await rekeys(t, v, 0)).json()) as Rekeys;
    expect(page.rekeys.map((r) => r.rotation)).not.toContain(2);
  });

  it("pages /rekey with limit and more", async () => {
    const t = testApp();
    let v = await newVault(t);
    for (let i = 0; i < 10; i++) {
      const next = newToken();
      await rotate(t, v, next, rekeyOf(`b${i}`));
      v = { ...v, token: next };
    }
    const page = (await (await rekeys(t, v)).json()) as Rekeys & { more: boolean };
    expect(page.rekeys.map((r) => r.rotation)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(page.more).toBe(true);
    const rest = (await (await rekeys(t, v, 8)).json()) as Rekeys & { more: boolean };
    expect(rest.rekeys.map((r) => r.rotation)).toEqual([9, 10]);
    expect(rest.more).toBe(false);
    const small = await t.call("GET", `/v1/vaults/${v.id}/rekey?after=0&limit=3`, { headers: auth(v) });
    expect(((await small.json()) as Rekeys).rekeys).toHaveLength(3);
    const huge = await t.call("GET", `/v1/vaults/${v.id}/rekey?limit=500`, { headers: auth(v) });
    expect(((await huge.json()) as Rekeys).rekeys).toHaveLength(10);
    expect(
      (await t.call("GET", `/v1/vaults/${v.id}/rekey?limit=0`, { headers: auth(v) })).status,
    ).toBe(400);
  });

  it("cuts a /rekey page at about 4 MiB", async () => {
    const t = testApp();
    let v = await newVault(t);
    const big = btoa("a".repeat(256 * 1024));
    for (let i = 0; i < 20; i++) {
      const next = newToken();
      await rotate(t, v, next, big);
      v = { ...v, token: next };
    }
    const page = (await (
      await t.call("GET", `/v1/vaults/${v.id}/rekey?limit=32`, { headers: auth(v) })
    ).json()) as Rekeys & { more: boolean };
    expect(page.rekeys.length).toBeGreaterThanOrEqual(1);
    expect(page.rekeys.length).toBeLessThanOrEqual(17);
    expect(page.more).toBe(true);
  });

  it("lets a token retired long ago come back (no primary key collision)", async () => {
    const t = testApp();
    const v = await newVault(t);
    const t1 = newToken();
    await rotate(t, v, t1);
    t.db.prepare("UPDATE prev_tokens SET rotated_at = ?").run(t.clock.now - 31 * DAY);
    const v1 = { ...v, token: t1 };
    expect((await rotate(t, v1, v.token)).status).toBe(200);
    expect((await rotate(t, v, newToken())).status).toBe(200);
  });

  it("refuses an oversized body by Content-Length", async () => {
    const t = testApp();
    const v = await newVault(t);
    const res = await t.call("POST", `/v1/vaults/${v.id}/token`, {
      headers: auth(v, { "content-type": "application/json", "content-length": String(800 * 1024) }),
      body: "x".repeat(800 * 1024),
    });
    expect(res.status).toBe(413);
  });

  it("deletes the vault with the current token only", async () => {
    const t = testApp();
    const v = await newVault(t);
    const next = newToken();
    await rotate(t, v, next);
    expect((await t.call("DELETE", `/v1/vaults/${v.id}`, { headers: auth(v) })).status).toBe(403);
    const del = await t.call("DELETE", `/v1/vaults/${v.id}`, {
      headers: auth({ ...v, token: next }),
    });
    expect(del.status).toBe(204);
    for (const table of ["vaults", "ops", "prev_tokens", "rekeys", "snapshots"]) {
      expect(
        (t.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n,
      ).toBe(0);
    }
  });
});
