// Vault creation, ops, entitlement and snapshots.

import { describe, expect, it } from "vitest";
import { DAY, MAX_OP_BYTES, MAX_PULL_BYTES, MAX_OPS_PER_PUSH, MAX_VAULT_OP_BYTES, OP_OVERHEAD_BYTES } from "../src/limits.js";
import {
  addPerson,
  auth,
  b64,
  newToken,
  newBlobId,
  newVault,
  newVaultId,
  pull,
  push,
  snapshotFiles,
  testApp,
  unb64,
  uploadBlob,
  uploadSnapshot,
  type PullBody,
  type TestApp,
  type Vault,
} from "./helpers.js";

const ops = (prefix: string, n: number) =>
  Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i}`, ct: b64(`${prefix}-cipher-${i}`) }));

async function pullAll(t: TestApp, v: Vault, after = 0): Promise<PullBody> {
  const res = await pull(t, v, after);
  expect(res.status).toBe(200);
  return (await res.json()) as PullBody;
}

describe("vault creation", () => {
  it("needs an active person", async () => {
    const t = testApp();
    const p = addPerson(t);
    t.stores.people.setState(p.id, "blocked");
    const res = await t.call("PUT", `/v1/vaults/${newVaultId()}`, {
      headers: { authorization: `Bearer ${newToken()}`, "moony-account": p.account },
    });
    expect(res.status).toBe(402);
    expect(await res.json()).toEqual({ error: "payment_required" });
  });

  it("refuses an unknown account", async () => {
    const t = testApp();
    const res = await t.call("PUT", `/v1/vaults/${newVaultId()}`, {
      headers: { authorization: `Bearer ${newToken()}`, "moony-account": "1234567890123456" },
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "account_not_found" });
  });

  it("is idempotent for the same account and token, and refuses anyone else", async () => {
    const t = testApp();
    const v = await newVault(t);
    const again = await t.call("PUT", `/v1/vaults/${v.id}`, {
      headers: { authorization: `Bearer ${v.token}`, "moony-account": v.account },
    });
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ created: false });

    const other = await t.call("PUT", `/v1/vaults/${v.id}`, {
      headers: { authorization: `Bearer ${newToken()}`, "moony-account": v.account },
    });
    expect(other.status).toBe(409);
  });

  it("refuses a vault ID that differs from an existing one only by letter case", async () => {
    const t = testApp();
    const account = addPerson(t).account;
    const v: Vault = { account, id: "AbCdEfGhIjKlMnOpQrStUv", token: newToken() };
    const created = await t.call("PUT", `/v1/vaults/${v.id}`, {
      headers: { authorization: `Bearer ${v.token}`, "moony-account": account },
    });
    expect(created.status).toBe(201);
    expect((await uploadSnapshot(t, v, 0, "snapshot-one")).status).toBe(201);
    const blobId = newBlobId();
    expect((await uploadBlob(t, v, blobId, "blob-one")).status).toBe(201);

    for (const id of [v.id.toLowerCase(), v.id.toUpperCase()]) {
      const res = await t.call("PUT", `/v1/vaults/${id}`, {
        headers: { authorization: `Bearer ${newToken()}`, "moony-account": account },
      });
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: "vault_exists" });
    }
    // The same token with a differently cased ID is refused too (the folded check comes first).
    const sameToken = await t.call("PUT", `/v1/vaults/${v.id.toLowerCase()}`, {
      headers: { authorization: `Bearer ${v.token}`, "moony-account": account },
    });
    expect(sameToken.status).toBe(409);
    expect(await sameToken.json()).toEqual({ error: "vault_exists" });
    expect(t.db.prepare("SELECT COUNT(*) AS n FROM vaults").get()).toEqual({ n: 1 });

    const snap = await t.call("GET", `/v1/vaults/${v.id}/snapshot`, { headers: auth(v) });
    expect(snap.status).toBe(200);
    expect(await snap.text()).toBe("snapshot-one");
    const blob = await t.call("GET", `/v1/vaults/${v.id}/blobs/${blobId}`, { headers: auth(v) });
    expect(blob.status).toBe(200);
    expect(await blob.text()).toBe("blob-one");
  });

  it("treats a pending deletion ignoring case", async () => {
    const t = testApp();
    const account = addPerson(t).account;
    t.db.prepare("INSERT INTO pending_wipes (vault_id) VALUES (?)").run("AbCdEfGhIjKlMnOpQrStUv");
    const res = await t.call("PUT", `/v1/vaults/abcdefghijklmnopqrstuv`, {
      headers: { authorization: `Bearer ${newToken()}`, "moony-account": account },
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "vault_deleting" });
  });

  it("caps vaults per account", async () => {
    const t = testApp();
    const account = addPerson(t).account;
    for (let i = 0; i < 5; i++) await newVault(t, account);
    const res = await t.call("PUT", `/v1/vaults/${newVaultId()}`, {
      headers: { authorization: `Bearer ${newToken()}`, "moony-account": account },
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "vault_limit_reached" });
    const me = await t.call("GET", "/v1/accounts/me", { headers: { "moony-account": account } });
    expect(((await me.json()) as { vaults: number }).vaults).toBe(5);
  });

  it("rejects malformed vault IDs and missing tokens", async () => {
    const t = testApp();
    expect(
      (await t.call("GET", "/v1/vaults/short", { headers: { authorization: "Bearer x" } })).status,
    ).toBe(400);
    expect((await t.call("GET", `/v1/vaults/${newVaultId()}`)).status).toBe(401);
  });
});

describe("ops", () => {
  it("assigns sequence numbers in arrival order and returns the ciphertext untouched", async () => {
    const t = testApp();
    const v = await newVault(t);
    const first = await push(t, v, ops("a", 3));
    expect(await first.json()).toEqual({ head: 3, accepted: 3 });
    await push(t, v, ops("b", 2));

    const body = await pullAll(t, v);
    expect(body.head).toBe(5);
    expect(body.more).toBe(false);
    expect(body.ops.map((o) => [o.seq, o.id])).toEqual([
      [1, "a0"],
      [2, "a1"],
      [3, "a2"],
      [4, "b0"],
      [5, "b1"],
    ]);
    expect(unb64(body.ops[4]!.ct)).toBe("b-cipher-1");

    const since = await pullAll(t, v, 3);
    expect(since.ops.map((o) => o.seq)).toEqual([4, 5]);
  });

  it("ignores op IDs it already has, so retries are safe", async () => {
    const t = testApp();
    const v = await newVault(t);
    await push(t, v, ops("x", 3));
    const retry = await push(t, v, [...ops("x", 3), { id: "y0", ct: b64("new") }]);
    expect(await retry.json()).toEqual({ head: 4, accepted: 1 });
    expect((await pullAll(t, v)).ops).toHaveLength(4);
  });

  it("pages with limit and more", async () => {
    const t = testApp();
    const v = await newVault(t);
    await push(t, v, ops("p", 7));
    const page = (await (await pull(t, v, 0, 3)).json()) as PullBody;
    expect(page.ops.map((o) => o.seq)).toEqual([1, 2, 3]);
    expect(page.more).toBe(true);
    const rest = (await (await pull(t, v, 6, 3)).json()) as PullBody;
    expect(rest.ops.map((o) => o.seq)).toEqual([7]);
    expect(rest.more).toBe(false);
  });

  it("rejects a wrong token", async () => {
    const t = testApp();
    const v = await newVault(t);
    const res = await pull(t, { ...v, token: newToken() });
    expect(res.status).toBe(401);
  });

  it("validates op batches", async () => {
    const t = testApp();
    const v = await newVault(t);
    const bad = async (body: unknown) =>
      (
        await t.call("POST", `/v1/vaults/${v.id}/ops`, {
          headers: auth(v, { "content-type": "application/json" }),
          body: JSON.stringify(body),
        })
      ).status;

    expect(await bad({ ops: [] })).toBe(400);
    expect(await bad({ ops: [{ id: "a", ct: "not base64!" }] })).toBe(400);
    expect(await bad({ ops: [{ id: "has space", ct: b64("x") }] })).toBe(400);
    expect(await bad({ ops: ops("m", MAX_OPS_PER_PUSH + 1) })).toBe(400);
    expect(MAX_OP_BYTES).toBe(192 * 1024);
    const tooBig = btoa("a".repeat(MAX_OP_BYTES + 1));
    expect(await bad({ ops: [{ id: "big", ct: tooBig }] })).toBe(400);
    const justFits = btoa("a".repeat(MAX_OP_BYTES));
    expect(await bad({ ops: [{ id: "fits", ct: justFits }] })).toBe(200);
  });

  it("refuses a push over the per-vault quota (new coverage)", async () => {
    const t = testApp();
    const v = await newVault(t);
    t.db.prepare("UPDATE vaults SET bytes = ? WHERE vault_id = ?").run(MAX_VAULT_OP_BYTES - 5, v.id);
    const res = await push(t, v, [{ id: "q", ct: b64("123456") }]);
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "quota_exceeded" });
  });
});

describe("op quota charge", () => {
  it("charges each op its ciphertext plus 128 bytes, in the quota and in the reported bytes", async () => {
    const t = testApp();
    const v = await newVault(t);
    const info = async () => (await (await t.call("GET", `/v1/vaults/${v.id}`, { headers: auth(v) })).json()) as { bytes: number };
    expect((await push(t, v, [{ id: "a", ct: b64("abc") }, { id: "b", ct: b64("de") }])).status).toBe(200);
    expect((await info()).bytes).toBe(3 + 2 + 2 * OP_OVERHEAD_BYTES);
    // A tiny op that fits only without the overhead is refused; one that fits with it is accepted.
    t.db.prepare("UPDATE vaults SET bytes = ? WHERE vault_id = ?").run(MAX_VAULT_OP_BYTES - 3 - OP_OVERHEAD_BYTES + 1, v.id);
    expect((await push(t, v, [{ id: "c", ct: b64("xyz") }])).status).toBe(413);
    t.db.prepare("UPDATE vaults SET bytes = ? WHERE vault_id = ?").run(MAX_VAULT_OP_BYTES - 3 - OP_OVERHEAD_BYTES, v.id);
    expect((await push(t, v, [{ id: "c", ct: b64("xyz") }])).status).toBe(200);
    expect((await info()).bytes).toBe(MAX_VAULT_OP_BYTES);
  });
});

describe("entitlement", () => {
  it("keeps a lapsed vault readable for the grace period but refuses writes", async () => {
    const t = testApp();
    const v = await newVault(t);
    await push(t, v, ops("g", 2));
    const person = t.stores.people.byAccount(v.account)!;
    t.clock.now += 5 * DAY;
    t.stores.people.setState(person.id, "blocked");
    t.clock.now += DAY;

    const write = await push(t, v, ops("h", 1));
    expect(write.status).toBe(402);
    expect(await write.json()).toEqual({ error: "payment_required" });
    expect((await pull(t, v)).status).toBe(200);

    t.clock.now += 30 * DAY;
    const lapsed = await pull(t, v);
    expect(lapsed.status).toBe(402);
    expect(await lapsed.json()).toEqual({ error: "payment_required" });
  });

  it("picks up a renewal", async () => {
    // Unblocking restores the far-future entitlement at once; there is no cache to refresh.
    const t = testApp();
    const v = await newVault(t);
    const person = t.stores.people.byAccount(v.account)!;
    t.stores.people.setState(person.id, "blocked");
    t.clock.now += DAY;
    expect((await push(t, v, ops("r", 1))).status).toBe(402);
    t.stores.people.setState(person.id, "active");
    expect((await push(t, v, ops("r", 1))).status).toBe(200);
  });

  it("answers a blocked person's vault, blocked for 31 days, with the lapsed read error, and unblocking restores it", async () => {
    const t = testApp();
    const v = await newVault(t);
    const person = t.stores.people.byAccount(v.account)!;
    t.stores.people.setState(person.id, "blocked");
    t.clock.now += 31 * DAY;
    const refused = await pull(t, v);
    expect(refused.status).toBe(402);
    expect(await refused.json()).toEqual({ error: "payment_required" });
    t.stores.people.setState(person.id, "active");
    expect((await pull(t, v)).status).toBe(200);
  });

  it("does not let one account's block touch another account's vault", async () => {
    const t = testApp();
    const v = await newVault(t);
    const stranger = addPerson(t, "Stranger");
    t.stores.people.setState(stranger.id, "blocked");
    t.clock.now += DAY;
    expect((await push(t, v, ops("z", 1))).status).toBe(200);
  });

  it("reports paidUntil in the vault info", async () => {
    const t = testApp();
    const v = await newVault(t);
    const res = await t.call("GET", `/v1/vaults/${v.id}`, { headers: auth(v) });
    expect(await res.json()).toMatchObject({
      head: 0,
      floor: 0,
      snapshotSeq: null,
      paidUntil: 253402300799,
      bytes: 0,
      rotation: 0,
      kit: null,
    });
  });
});

describe("snapshots", () => {
  it("stores, serves and keeps only the two newest", async () => {
    const t = testApp();
    const v = await newVault(t);
    await push(t, v, ops("s", 5));

    expect((await uploadSnapshot(t, v, 9, "ahead")).status).toBe(400);
    expect((await uploadSnapshot(t, v, 2, "snap-2")).status).toBe(201);
    expect((await uploadSnapshot(t, v, 4, "snap-4")).status).toBe(201);
    expect((await uploadSnapshot(t, v, 5, "snap-5")).status).toBe(201);
    expect((await uploadSnapshot(t, v, 3, "older")).status).toBe(409);

    const res = await t.call("GET", `/v1/vaults/${v.id}/snapshot`, { headers: auth(v) });
    expect(res.status).toBe(200);
    expect(res.headers.get("moony-snapshot-seq")).toBe("5");
    expect(res.headers.get("content-length")).toBe("6");
    expect(await res.text()).toBe("snap-5");

    // Files on disk: exactly the two newest (seq 4 and 5), no temporary leftovers.
    expect(snapshotFiles(t, v).map((f) => f.split("-")[0])).toEqual(["4", "5"]);
  });

  it("says when there is no snapshot", async () => {
    const t = testApp();
    const v = await newVault(t);
    const res = await t.call("GET", `/v1/vaults/${v.id}/snapshot`, { headers: auth(v) });
    expect(res.status).toBe(404);
  });

  it("needs a length and refuses an oversized declaration", async () => {
    const t = testApp();
    const v = await newVault(t);
    const noLength = await t.call("PUT", `/v1/vaults/${v.id}/snapshot?seq=0`, {
      headers: auth(v),
    });
    expect(noLength.status).toBe(411);
    const huge = await t.call("PUT", `/v1/vaults/${v.id}/snapshot?seq=0`, {
      headers: auth(v, { "content-length": String(100 * 1024 * 1024 + 1) }),
      body: "x",
    });
    expect(huge.status).toBe(413);
    expect(await huge.json()).toEqual({ error: "snapshot_too_large" });
    expect(snapshotFiles(t, v)).toEqual([]);
  });
});

describe("a pull reads only what it sends", () => {
  it("cuts the page by sizes before it reads any ciphertext", async () => {
    const t = testApp();
    const v = await newVault(t);
    const ct = 150 * 1024;
    const body = (i: number) => ({ id: `big-${i}`, ct: b64("x".repeat(ct - 8) + String(i).padStart(8, "0")) });
    for (let batch = 0; batch < 6; batch++) {
      const res = await push(t, v, Array.from({ length: 10 }, (_, i) => body(batch * 10 + i)));
      expect(res.status).toBe(200);
    }
    const perOp = ct + OP_OVERHEAD_BYTES;
    const fit = Math.floor(MAX_PULL_BYTES / perOp);
    t.stores.vaults.stats.opBytesRead = 0;
    const res = await pull(t, v, 0, 1000);
    const page = (await res.json()) as PullBody;
    expect(page.ops.map((o) => o.seq)).toEqual(Array.from({ length: fit }, (_, i) => i + 1));
    expect(page.ops.map((o) => o.id)).toEqual(Array.from({ length: fit }, (_, i) => `big-${i}`));
    expect(page.head).toBe(60);
    expect(page.more).toBe(true);
    expect(t.stores.vaults.stats.opBytesRead).toBe(fit * ct);
    expect(t.stores.vaults.stats.opBytesRead).toBeLessThanOrEqual(MAX_PULL_BYTES + ct);
  });

  it("cuts a page at limit and says there is more", async () => {
    const t = testApp();
    const v = await newVault(t);
    const res = await push(t, v, Array.from({ length: 5 }, (_, i) => ({ id: `s-${i}`, ct: b64(`op-${i}`) })));
    expect(res.status).toBe(200);
    const page = (await (await pull(t, v, 0, 3)).json()) as PullBody;
    expect(page.ops.map((o) => o.seq)).toEqual([1, 2, 3]);
    expect(page.more).toBe(true);
    const rest = (await (await pull(t, v, 3, 3)).json()) as PullBody;
    expect(rest.ops.map((o) => o.seq)).toEqual([4, 5]);
    expect(rest.more).toBe(false);
  });
});
