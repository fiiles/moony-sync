// The Recovery Kit: an opaque envelope per vault, read with its own token (never a vault token),
// replaced at every key change, and a retired Kit token answering 410 for as long as it is kept.

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { DAY, MAX_KIT_RETIRED_KEPT } from "../src/limits.js";
import {
  auth,
  b64,
  countingBody,
  newToken,
  newVault,
  newVaultId,
  setupAdmin,
  testApp,
  unb64,
  type TestApp,
  type Vault,
} from "./helpers.js";

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

const putKit = (t: TestApp, v: Vault, body: unknown, token = v.token): Promise<Response> =>
  t.call("PUT", `/v1/vaults/${v.id}/kit`, {
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const getKit = (t: TestApp, vaultId: string, kitToken: string, clientAddress = "192.0.2.1"): Promise<Response> =>
  t.call("GET", `/v1/vaults/${vaultId}/kit`, {
    headers: { authorization: `Bearer ${kitToken}` },
    clientAddress,
  });

const rotate = (t: TestApp, v: Vault, body: Record<string, unknown>): Promise<Response> =>
  t.call("POST", `/v1/vaults/${v.id}/token`, {
    headers: auth(v, { "content-type": "application/json" }),
    body: JSON.stringify({ rekey: b64("bundle"), ...body }),
  });

type KitBody = { envelope: string; since: number; updatedAt: number };
type Info = { rotation: number; kit: { since: number; lastRead: number | null } | null };

const infoOf = async (t: TestApp, v: Vault): Promise<Info> =>
  (await (await t.call("GET", `/v1/vaults/${v.id}`, { headers: auth(v) })).json()) as Info;

const row = (t: TestApp, id: string) =>
  t.db.prepare("SELECT * FROM kits WHERE vault_id = ?").get(id) as
    | { token_hash: string; envelope: Buffer; since: number; updated_at: number; last_read: number | null }
    | undefined;
const count = (t: TestApp, table: string, id: string): number =>
  (t.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE vault_id = ?`).get(id) as { n: number }).n;

/** A vault with a Kit set up through PUT. */
async function vaultWithKit(t: TestApp, envelope = "envelope-1") {
  const v = await newVault(t);
  const kit = newToken();
  const r = await putKit(t, v, { token: kit, envelope: b64(envelope) });
  if (r.status !== 201) throw new Error(`kit put failed: ${r.status} ${await r.text()}`);
  return { v, kit };
}

describe("PUT /v1/vaults/:id/kit", () => {
  it("stores the Kit (201), and a retry with the same token replaces the envelope (200)", async () => {
    const t = testApp();
    const v = await newVault(t);
    const kit = newToken();
    const first = await putKit(t, v, { token: kit, envelope: b64("one") });
    expect(first.status).toBe(201);
    expect(await first.json()).toEqual({ created: true });
    const since = t.clock.now;

    t.clock.now += 120;
    const retry = await putKit(t, v, { token: kit, envelope: b64("two") });
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual({ created: false });

    const read = await getKit(t, v.id, kit);
    expect(read.status).toBe(200);
    const body = (await read.json()) as KitBody;
    expect(unb64(body.envelope)).toBe("two");
    expect(body.since).toBe(since);
    expect(body.updatedAt).toBe(t.clock.now);
    // Only the hash of the Kit token is stored.
    expect(row(t, v.id)!.token_hash).toBe(sha256(kit));
  });

  it("refuses a second Kit with another token: 409 kit_exists", async () => {
    const t = testApp();
    const { v, kit } = await vaultWithKit(t, "first");
    const r = await putKit(t, v, { token: newToken(), envelope: b64("second") });
    expect(r.status).toBe(409);
    expect(await r.json()).toEqual({ error: "kit_exists" });
    expect(unb64(((await (await getKit(t, v.id, kit)).json()) as KitBody).envelope)).toBe("first");
  });

  it("needs the current vault token; no entitlement", async () => {
    const t = testApp();
    const v = await newVault(t);
    const body = { token: newToken(), envelope: b64("e") };
    expect((await putKit(t, v, body, newToken())).status).toBe(401);
    expect((await putKit(t, { ...v, id: newVaultId() }, body)).status).toBe(404);

    const next = newToken();
    expect((await rotate(t, v, { token: next })).status).toBe(200);
    const old = await putKit(t, v, body);
    expect(old.status).toBe(403);
    expect(await old.json()).toEqual({ error: "token_read_only" });

    t.stores.people.setState(t.stores.people.byAccount(v.account)!.id, "blocked");
    t.clock.now += 60 * DAY;
    expect((await putKit(t, { ...v, token: next }, body)).status).toBe(201);
  });

  it("judges the vault token before reading the body", async () => {
    const t = testApp();
    const v = await newVault(t);
    const { state, body } = countingBody();
    const r = await t.app.fetch(
      new Request(`http://localhost/v1/vaults/${v.id}/kit`, {
        method: "PUT",
        headers: { authorization: `Bearer ${newToken()}`, "content-type": "application/json" },
        body,
        duplex: "half",
      } as RequestInit),
    );
    expect(r.status).toBe(401);
    expect(state.pulled).toBeLessThanOrEqual(1);
  });

  it("validates the Kit token and the envelope", async () => {
    const t = testApp();
    const v = await newVault(t);
    const expectError = async (body: unknown, status: number, error: string) => {
      const r = await putKit(t, v, body);
      expect([JSON.stringify(body).slice(0, 60), r.status, await r.json()]).toEqual([
        JSON.stringify(body).slice(0, 60),
        status,
        { error },
      ]);
    };
    await expectError({ envelope: b64("e") }, 400, "invalid_kit_token");
    await expectError({ token: "short", envelope: b64("e") }, 400, "invalid_kit_token");
    await expectError({ token: v.token, envelope: b64("e") }, 400, "invalid_kit_token");
    await expectError({ token: newToken() }, 400, "invalid_kit");
    await expectError({ token: newToken(), envelope: "" }, 400, "invalid_kit");
    await expectError({ token: newToken(), envelope: "not base64!" }, 400, "invalid_kit");
    await expectError({ token: newToken(), envelope: 7 }, 400, "invalid_kit");
    await expectError({ token: newToken(), envelope: btoa("a".repeat(256 * 1024 + 1)) }, 413, "kit_too_large");
    expect(row(t, v.id)).toBeUndefined();

    // Exactly 256 KiB fits.
    expect((await putKit(t, v, { token: newToken(), envelope: btoa("a".repeat(256 * 1024)) })).status).toBe(201);
  });

  it("refuses a Kit token that is or was a vault token, or a retired Kit token", async () => {
    const t = testApp();
    const { v, kit } = await vaultWithKit(t);
    const retiredVaultToken = v.token;
    const next = newToken();
    const nextKit = newToken();
    expect((await rotate(t, v, { token: next, kit: { envelope: b64("e2"), token: nextKit } })).status).toBe(200);
    const v2 = { ...v, token: next };

    // A fresh vault with no Kit yet, to try the tokens of the first one against its own history.
    const w = await newVault(t);
    const wNext = newToken();
    expect((await rotate(t, w, { token: wNext })).status).toBe(200);
    for (const token of [wNext, w.token]) {
      const r = await putKit(t, { ...w, token: wNext }, { token, envelope: b64("e") });
      expect(r.status).toBe(400);
      expect(await r.json()).toEqual({ error: "invalid_kit_token" });
    }
    // The retired Kit token of v cannot become v's Kit again (it cannot: v has a Kit, but the
    // retired check comes first and says why).
    const again = await putKit(t, v2, { token: kit, envelope: b64("e") });
    expect(again.status).toBe(400);
    expect(await again.json()).toEqual({ error: "invalid_kit_token" });
    const asVault = await putKit(t, v2, { token: retiredVaultToken, envelope: b64("e") });
    expect(asVault.status).toBe(400);
    expect(await asVault.json()).toEqual({ error: "invalid_kit_token" });
  });
});

describe("GET /v1/vaults/:id/kit", () => {
  it("answers the envelope to the Kit token, records the read minute, leaves last activity alone", async () => {
    const t = testApp();
    const { v, kit } = await vaultWithKit(t, "sealed");
    const activity = (t.db.prepare("SELECT last_activity FROM vaults WHERE vault_id = ?").get(v.id) as {
      last_activity: number;
    }).last_activity;
    expect(row(t, v.id)!.last_read).toBeNull();

    t.clock.now += 3 * 3600 + 17;
    const r = await getKit(t, v.id, kit);
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    const body = (await r.json()) as KitBody;
    expect(Object.keys(body).sort()).toEqual(["envelope", "since", "updatedAt"]);
    expect(unb64(body.envelope)).toBe("sealed");
    expect(row(t, v.id)!.last_read).toBe(t.clock.now - (t.clock.now % 60));
    expect(
      (t.db.prepare("SELECT last_activity FROM vaults WHERE vault_id = ?").get(v.id) as { last_activity: number })
        .last_activity,
    ).toBe(activity);
  });

  it("never accepts a vault token, and a Kit token is never a vault token", async () => {
    const t = testApp();
    const { v, kit } = await vaultWithKit(t);
    const r = await getKit(t, v.id, v.token);
    expect(r.status).toBe(401);
    expect(await r.json()).toEqual({ error: "unauthorized" });
    expect((await t.call("GET", `/v1/vaults/${v.id}`, { headers: { authorization: `Bearer ${kit}` } })).status).toBe(
      401,
    );
    expect(
      (await t.call("GET", `/v1/vaults/${v.id}/ops?after=0`, { headers: { authorization: `Bearer ${kit}` } })).status,
    ).toBe(401);
    expect(row(t, v.id)!.last_read).toBeNull();
  });

  it("answers 401 on a vault without a Kit, 404 on an unknown vault, 401 without a bearer", async () => {
    const t = testApp();
    const v = await newVault(t);
    expect((await getKit(t, v.id, newToken())).status).toBe(401);
    const missing = await getKit(t, newVaultId(), newToken());
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "vault_not_found" });
    expect((await t.call("GET", `/v1/vaults/${v.id}/kit`)).status).toBe(401);
    expect((await getKit(t, "bad", newToken())).status).toBe(400);
  });

  it("answers 410 kit_replaced with replacedAt for a retired Kit token", async () => {
    const t = testApp();
    const { v, kit } = await vaultWithKit(t, "old");
    t.clock.now += 500;
    const newKit = newToken();
    expect((await rotate(t, v, { token: newToken(), kit: { envelope: b64("new"), token: newKit } })).status).toBe(200);
    const replacedAt = t.clock.now;

    t.clock.now += 3600;
    const old = await getKit(t, v.id, kit);
    expect(old.status).toBe(410);
    expect(await old.json()).toEqual({ error: "kit_replaced", replacedAt });
    const fresh = (await (await getKit(t, v.id, newKit)).json()) as KitBody;
    expect(unb64(fresh.envelope)).toBe("new");
    expect(fresh.since).toBe(replacedAt);
  });

  it("reads within 30 days of a block, then answers 402", async () => {
    const t = testApp();
    const { v, kit } = await vaultWithKit(t);
    t.stores.people.setState(t.stores.people.byAccount(v.account)!.id, "blocked");
    t.clock.now += 29 * DAY;
    expect((await getKit(t, v.id, kit)).status).toBe(200);
    t.clock.now += 2 * DAY;
    const lapsed = await getKit(t, v.id, kit);
    expect(lapsed.status).toBe(402);
    expect(await lapsed.json()).toEqual({ error: "payment_required" });
  });

  it("per client, only failures count: junk and token-less calls never make the right token fail", async () => {
    const t = testApp();
    const { v, kit } = await vaultWithKit(t);
    const ip = "198.51.100.7";
    const statuses: number[] = [];
    for (let i = 0; i < 25; i++) {
      statuses.push((await getKit(t, v.id, newToken(), ip)).status);
      statuses.push((await t.call("GET", `/v1/vaults/${v.id}/kit`, { clientAddress: ip })).status);
      statuses.push(
        (await t.call("GET", `/v1/vaults/${v.id}/kit`, { headers: { authorization: "Bearer junk!" }, clientAddress: ip }))
          .status,
      );
      statuses.push((await getKit(t, newVaultId(), newToken(), ip)).status);
    }
    // Ten failures a minute per client, then failures answer 429.
    expect(statuses.slice(0, 10).every((s) => s === 401 || s === 404)).toBe(true);
    expect(statuses.slice(10).every((s) => s === 429)).toBe(true);
    const r = await getKit(t, v.id, kit, ip);
    expect(r.status).toBe(200);
  });

  it("kitRead: a backstop of 120 a minute per client, counting every call before the token", async () => {
    const t = testApp();
    const { v, kit } = await vaultWithKit(t);
    const ip = "198.51.100.9";
    for (let i = 0; i < 120; i++) expect((await getKit(t, v.id, kit, ip)).status).toBe(200);
    const limited = await getKit(t, v.id, kit, ip);
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ error: "rate_limited" });
    expect((await getKit(t, v.id, kit, "198.51.100.10")).status).toBe(200);
    t.clock.now += 60;
    expect((await getKit(t, v.id, kit, ip)).status).toBe(200);
  });

  it("a wrong token gets 429 after 30 failures in the hour, from one client over several minutes", async () => {
    const t = testApp();
    const { v, kit } = await vaultWithKit(t);
    t.clock.now -= t.clock.now % 3600; // the start of an hour window
    const ip = "198.51.100.11";
    for (let minute = 0; minute < 3; minute++) {
      for (let i = 0; i < 10; i++) expect((await getKit(t, v.id, newToken(), ip)).status).toBe(401);
      t.clock.now += 60;
    }
    const over = await getKit(t, v.id, newToken(), ip);
    expect(over.status).toBe(429);
    expect(await over.json()).toEqual({ error: "rate_limited" });
    expect((await getKit(t, v.id, kit, ip)).status).toBe(200);
    t.clock.now += 3600;
    expect((await getKit(t, v.id, newToken(), ip)).status).toBe(401);
  });

  it("the per-vault limit counts only failures: 100 wrong tokens, then the right token still reads", async () => {
    const t = testApp();
    const { v, kit } = await vaultWithKit(t);
    const statuses: number[] = [];
    for (let i = 0; i < 100; i++) statuses.push((await getKit(t, v.id, newToken(), `203.0.113.${i}`)).status);
    expect(statuses.slice(0, 30).every((s) => s === 401)).toBe(true);
    expect(statuses.slice(30).every((s) => s === 429)).toBe(true);

    const r = await getKit(t, v.id, kit, "203.0.113.200");
    expect(r.status).toBe(200);
    // Successes are not counted: many reads in a row all succeed.
    for (let i = 0; i < 40; i++) expect((await getKit(t, v.id, kit, `198.18.0.${i}`)).status).toBe(200);
    // Other vaults are unaffected; the window is an hour.
    const other = await vaultWithKit(t);
    expect((await getKit(t, other.v.id, newToken(), "203.0.113.201")).status).toBe(401);
    t.clock.now += 3600;
    expect((await getKit(t, v.id, newToken(), "203.0.113.202")).status).toBe(401);
  });

  it("a replaced Kit always reads 410: it is not counted and never turned into 429", async () => {
    const t = testApp();
    const { v, kit } = await vaultWithKit(t);
    const newKit = newToken();
    expect((await rotate(t, v, { token: newToken(), kit: { envelope: b64("n"), token: newKit } })).status).toBe(200);
    const ip = "203.0.113.50";
    for (let i = 0; i < 60; i++) expect((await getKit(t, v.id, kit, ip)).status).toBe(410);
    // Neither the client's nor the vault's failure budget was used.
    for (let i = 0; i < 10; i++) expect((await getKit(t, v.id, newToken(), ip)).status).toBe(401);
    expect((await getKit(t, v.id, newToken(), ip)).status).toBe(429);
    expect((await getKit(t, v.id, kit, ip)).status).toBe(410);
    expect((await getKit(t, v.id, newKit, ip)).status).toBe(200);
  });
});

describe("POST /v1/vaults/:id/token with a Kit", () => {
  it("refuses a rotation without `kit` on a vault that has a Kit: 400 kit_required", async () => {
    const t = testApp();
    const { v } = await vaultWithKit(t);
    const r = await rotate(t, v, { token: newToken() });
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ error: "kit_required" });
    expect((await infoOf(t, v)).rotation).toBe(0);
  });

  it("replaces the envelope with the rotation, keeping the Kit token and since", async () => {
    const t = testApp();
    const { v, kit } = await vaultWithKit(t, "epoch-0");
    const since = t.clock.now;
    t.clock.now += 600;
    const r = await rotate(t, v, { token: newToken(), kit: { envelope: b64("epoch-1") } });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ rotation: 1, head: 0 });
    const body = (await (await getKit(t, v.id, kit)).json()) as KitBody;
    expect(unb64(body.envelope)).toBe("epoch-1");
    expect(body.since).toBe(since);
    expect(body.updatedAt).toBe(t.clock.now);
  });

  it("a failed rotation leaves the old envelope and the old Kit token", async () => {
    const t = testApp();
    const { v, kit } = await vaultWithKit(t, "kept");
    const before = row(t, v.id)!;

    // Refused inside the transaction: the new Kit token was a vault token.
    const r = await rotate(t, v, { token: newToken(), kit: { envelope: b64("lost"), token: v.token } });
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ error: "invalid_kit_token" });
    // Refused at the 32-bundle cap, after every other check passed.
    const now = t.clock.now;
    const insert = t.db.prepare("INSERT INTO rekeys (vault_id, rotation, head, at, rekey) VALUES (?, ?, 0, ?, ?)");
    for (let i = 1; i <= 32; i++) insert.run(v.id, 1000 + i, now, Buffer.from("x"));
    const capped = await rotate(t, v, { token: newToken(), kit: { envelope: b64("lost"), token: newToken() } });
    expect(capped.status).toBe(409);

    expect(row(t, v.id)).toEqual(before);
    expect(count(t, "kits_retired", v.id)).toBe(0);
    expect(unb64(((await (await getKit(t, v.id, kit)).json()) as KitBody).envelope)).toBe("kept");
    expect((await infoOf(t, v)).rotation).toBe(0);
  });

  it("with kit.token retires the old Kit token and starts a new Kit", async () => {
    const t = testApp();
    const { v, kit } = await vaultWithKit(t);
    await getKit(t, v.id, kit);
    expect(row(t, v.id)!.last_read).not.toBeNull();
    t.clock.now += 900;
    const newKit = newToken();
    expect((await rotate(t, v, { token: newToken(), kit: { envelope: b64("k2"), token: newKit } })).status).toBe(200);

    const r = row(t, v.id)!;
    expect(r.token_hash).toBe(sha256(newKit));
    expect(r.since).toBe(t.clock.now);
    expect(r.last_read).toBeNull();
    expect(t.db.prepare("SELECT token_hash, retired_at FROM kits_retired WHERE vault_id = ?").all(v.id)).toEqual([
      { token_hash: sha256(kit), retired_at: t.clock.now },
    ]);
  });

  it("gives a vault without a Kit one by rotation; a plain rotation still works without one", async () => {
    const t = testApp();
    const v = await newVault(t);
    const t1 = newToken();
    expect((await rotate(t, v, { token: t1 })).status).toBe(200);
    expect((await infoOf(t, { ...v, token: t1 })).kit).toBeNull();

    const v1 = { ...v, token: t1 };
    // An envelope with no Kit token has nothing to belong to.
    const orphan = await rotate(t, v1, { token: newToken(), kit: { envelope: b64("e") } });
    expect(orphan.status).toBe(400);
    expect(await orphan.json()).toEqual({ error: "invalid_kit" });

    const kit = newToken();
    const t2 = newToken();
    expect((await rotate(t, v1, { token: t2, kit: { envelope: b64("by-rotation"), token: kit } })).status).toBe(200);
    expect((await infoOf(t, { ...v, token: t2 })).kit).toEqual({ since: t.clock.now, lastRead: null });
    expect(unb64(((await (await getKit(t, v.id, kit)).json()) as KitBody).envelope)).toBe("by-rotation");
    expect(count(t, "kits_retired", v.id)).toBe(0);
  });

  it("validates `kit`", async () => {
    const t = testApp();
    const { v, kit } = await vaultWithKit(t);
    const expectError = async (body: Record<string, unknown>, status: number, error: string) => {
      const r = await rotate(t, v, { token: newToken(), ...body });
      expect([JSON.stringify(body).slice(0, 60), r.status, await r.json()]).toEqual([
        JSON.stringify(body).slice(0, 60),
        status,
        { error },
      ]);
    };
    await expectError({ kit: "envelope" }, 400, "invalid_kit");
    await expectError({ kit: null }, 400, "invalid_kit");
    await expectError({ kit: {} }, 400, "invalid_kit");
    await expectError({ kit: { envelope: "" } }, 400, "invalid_kit");
    await expectError({ kit: { envelope: "%%%%" } }, 400, "invalid_kit");
    await expectError({ kit: { envelope: btoa("a".repeat(256 * 1024 + 1)) } }, 413, "kit_too_large");
    await expectError({ kit: { envelope: b64("e"), token: "short" } }, 400, "invalid_kit_token");
    await expectError({ kit: { envelope: b64("e"), token: kit } }, 400, "invalid_kit_token");
    await expectError({ kit: { envelope: b64("e"), token: v.token } }, 400, "invalid_kit_token");

    const same = newToken();
    const r = await rotate(t, v, { token: same, kit: { envelope: b64("e"), token: same } });
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ error: "invalid_kit_token" });
    // The new vault token may not be the Kit token either.
    const asVault = await rotate(t, v, { token: kit, kit: { envelope: b64("e") } });
    expect(asVault.status).toBe(400);
    expect(await asVault.json()).toEqual({ error: "invalid_token" });
    expect((await infoOf(t, v)).rotation).toBe(0);
  });

  it("a previous (read-only) vault token cannot rotate with a kit", async () => {
    const t = testApp();
    const { v, kit } = await vaultWithKit(t, "kept");
    const t1 = newToken();
    expect((await rotate(t, v, { token: t1, kit: { envelope: b64("e1") } })).status).toBe(200);
    for (const kitPart of [{ envelope: b64("x") }, { envelope: b64("x"), token: newToken() }]) {
      const r = await rotate(t, v, { token: newToken(), kit: kitPart });
      expect(r.status).toBe(403);
      expect(await r.json()).toEqual({ error: "token_read_only" });
    }
    expect(unb64(((await (await getKit(t, v.id, kit)).json()) as KitBody).envelope)).toBe("e1");
  });

  it("refuses a kit.token equal to the new vault token", async () => {
    const t = testApp();
    const { v, kit } = await vaultWithKit(t);
    const same = newToken();
    const r = await rotate(t, v, { token: same, kit: { envelope: b64("e"), token: same } });
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ error: "invalid_kit_token" });
    expect((await infoOf(t, v)).rotation).toBe(0);
    expect((await getKit(t, v.id, kit)).status).toBe(200);
  });

  it("a retired Kit token can never become the vault token", async () => {
    const t = testApp();
    const { v, kit } = await vaultWithKit(t);
    const t1 = newToken();
    expect((await rotate(t, v, { token: t1, kit: { envelope: b64("e"), token: newToken() } })).status).toBe(200);
    const r = await rotate(t, { ...v, token: t1 }, { token: kit, kit: { envelope: b64("e") } });
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ error: "invalid_token" });
  });

  it("carries a 256 KiB bundle and a 256 KiB envelope in one body", async () => {
    const t = testApp();
    const { v, kit } = await vaultWithKit(t);
    const big = btoa("b".repeat(256 * 1024));
    const r = await rotate(t, v, { token: newToken(), rekey: big, kit: { envelope: big, token: newToken() } });
    expect(r.status).toBe(200);
    expect((await getKit(t, v.id, kit)).status).toBe(410);
  });

  it(`keeps the newest ${MAX_KIT_RETIRED_KEPT} retired Kit hashes; an older Kit token reads 401`, async () => {
    const t = testApp();
    const { v, kit } = await vaultWithKit(t);
    // 256 retired Kits already, the oldest first.
    const old = Array.from({ length: MAX_KIT_RETIRED_KEPT }, () => newToken());
    const insert = t.db.prepare("INSERT INTO kits_retired (vault_id, token_hash, retired_at) VALUES (?, ?, ?)");
    old.forEach((tok, i) => insert.run(v.id, sha256(tok), t.clock.now - 10_000 + i));
    expect((await getKit(t, v.id, old[0]!, "192.0.2.10")).status).toBe(410);

    expect((await rotate(t, v, { token: newToken(), kit: { envelope: b64("e"), token: newToken() } })).status).toBe(200);
    expect(count(t, "kits_retired", v.id)).toBe(MAX_KIT_RETIRED_KEPT);
    expect((await getKit(t, v.id, old[0]!, "192.0.2.11")).status).toBe(401);
    expect((await getKit(t, v.id, old[1]!, "192.0.2.12")).status).toBe(410);
    expect((await getKit(t, v.id, kit, "192.0.2.13")).status).toBe(410);
  });
});

describe("envelope bytes", () => {
  it("come back byte for byte, in the same canonical base64", async () => {
    const t = testApp();
    const v = await newVault(t);
    const kit = newToken();
    const sizes = [1, 2, 3, 4, 5, 255, 256, 257, 256 * 1024];
    let first = true;
    for (const size of sizes) {
      const bytes = crypto.getRandomValues(new Uint8Array(Math.min(size, 65536)));
      const full = new Uint8Array(size);
      for (let i = 0; i < size; i += bytes.length) full.set(bytes.subarray(0, Math.min(bytes.length, size - i)), i);
      full[0] = 0x00;
      full[size - 1] = 0xff;
      const envelope = Buffer.from(full).toString("base64");
      const put = await putKit(t, v, { token: kit, envelope });
      expect(put.status).toBe(first ? 201 : 200);
      first = false;
      const got = (await (await getKit(t, v.id, kit, `192.0.2.${size % 250}`)).json()) as KitBody;
      expect(got.envelope).toBe(envelope);
      expect(Buffer.from(got.envelope, "base64").equals(Buffer.from(full))).toBe(true);
      expect(Buffer.from(row(t, v.id)!.envelope).equals(Buffer.from(full))).toBe(true);
    }
  });

  it("accepts non-canonical padding bits and answers the canonical encoding of the same bytes", async () => {
    const t = testApp();
    const v = await newVault(t);
    const kit = newToken();
    // "YR==" and "YQ==" both decode to "a"; the stored bytes are what count.
    expect((await putKit(t, v, { token: kit, envelope: "YR==" })).status).toBe(201);
    expect(((await (await getKit(t, v.id, kit)).json()) as KitBody).envelope).toBe("YQ==");
  });
});

describe("the Kit in vault info, features and deletion", () => {
  it("vault info carries kit: null, then {since, lastRead}", async () => {
    const t = testApp();
    const v = await newVault(t);
    expect((await infoOf(t, v)).kit).toBeNull();
    const kit = newToken();
    await putKit(t, v, { token: kit, envelope: b64("e") });
    const since = t.clock.now;
    expect((await infoOf(t, v)).kit).toEqual({ since, lastRead: null });
    t.clock.now += 3600 + 59;
    await getKit(t, v.id, kit);
    expect((await infoOf(t, v)).kit).toEqual({ since, lastRead: t.clock.now - (t.clock.now % 60) });
  });

  it("GET /v1/server lists the kit feature", async () => {
    const t = testApp();
    const body = (await (await t.call("GET", "/v1/server")).json()) as { features: string[]; protocol: number };
    expect(body.features).toEqual(["blobs", "kit"]);
    expect(body.protocol).toBe(2);
  });

  it("deleting the vault removes its Kit and retired Kit hashes", async () => {
    const t = testApp();
    const { v, kit } = await vaultWithKit(t);
    expect((await rotate(t, v, { token: newToken(), kit: { envelope: b64("e"), token: newToken() } })).status).toBe(200);
    expect(count(t, "kits", v.id)).toBe(1);
    expect(count(t, "kits_retired", v.id)).toBe(1);
    // The admin's "delete profile" path.
    t.stores.vaults.wipe(v.id);
    expect(count(t, "kits", v.id)).toBe(0);
    expect(count(t, "kits_retired", v.id)).toBe(0);
    expect((await getKit(t, v.id, kit)).status).toBe(404);
  });

  it("DELETE /v1/vaults/:id and deleting the person cascade to the Kit", async () => {
    const t = testApp();
    const a = await vaultWithKit(t);
    expect((await t.call("DELETE", `/v1/vaults/${a.v.id}`, { headers: auth(a.v) })).status).toBe(204);
    expect(count(t, "kits", a.v.id)).toBe(0);

    const s = await setupAdmin(t);
    const b = await vaultWithKit(t);
    const person = t.stores.people.byAccount(b.v.account)!;
    expect((await s.call("DELETE", `people/${person.id}`)).status).toBe(204);
    expect(count(t, "kits", b.v.id)).toBe(0);
    expect((await getKit(t, b.v.id, b.kit)).status).toBe(404);
  });
});
