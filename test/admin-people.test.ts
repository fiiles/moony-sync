import { existsSync } from "node:fs";
import { OP_OVERHEAD_BYTES } from "../src/limits.js";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { decodeConnectionCode } from "../src/connection-code.js";
import { blobQuotaBytes } from "../src/blobs.js";
import { ADMIN_PASSWORD, adminSession, newBlobId, newVault, pull, push, setupAdmin, snapshotFiles, testApp, uploadBlob, uploadSnapshot } from "./helpers.js";
import type { TestApp } from "./helpers.js";

const ADDRESS = "https://sync.example";
const json = async (r: Response) => r.json() as Promise<any>;

async function ready(overrides = {}) {
  const t = testApp(overrides);
  const s = await setupAdmin(t);
  return { t, s };
}

async function withAddress(s: Awaited<ReturnType<typeof setupAdmin>>) {
  const r = await s.call("PUT", "settings", { publicUrl: ADDRESS });
  expect(r.status).toBe(200);
}

async function create(s: Awaited<ReturnType<typeof setupAdmin>>, name = "Anna") {
  const r = await s.call("POST", "people", { name });
  expect(r.status).toBe(201);
  return (await json(r)) as { person: { id: string }; connectionCode: string };
}

describe("guard", () => {
  it("every new route needs a session", async () => {
    const { t } = await ready();
    const anon = adminSession(t, "");
    const routes: [string, string][] = [
      ["GET", "overview"], ["GET", "people"], ["POST", "people"], ["GET", "people/x"], ["PATCH", "people/x"],
      ["POST", "people/x/connection-code"], ["DELETE", "people/x"], ["DELETE", "people/x/vaults/y"],
      ["GET", "settings"], ["PUT", "settings"], ["GET", "backup"], ["GET", "backup/size"],
    ];
    for (const [m, p] of routes) expect([m, p, (await anon.call(m, p, m === "GET" ? undefined : {})).status]).toEqual([m, p, 401]);
  });

  it("a session that must still enrol 2FA reaches none of them", async () => {
    const { t } = await ready({ require2fa: true });
    const s = await (await import("./helpers.js")).login(t);
    for (const [m, p] of [["GET", "people"], ["GET", "overview"], ["GET", "backup"], ["PUT", "settings"]] as const) {
      const r = await s.call(m, p, m === "PUT" ? { publicUrl: null } : undefined);
      expect([p, r.status, await json(r)]).toEqual([p, 403, { error: "enrol_2fa" }]);
    }
  });
});

describe("space figures", () => {
  it("space figures include blobs; the profile shows its file count", async () => {
    const { t, s } = await ready();
    const person = t.stores.people.create("Anna");
    const v = await newVault(t, person.account);
    await push(t, v, [{ id: "a", ct: btoa("12345") }]);
    expect((await uploadBlob(t, v, newBlobId(), new Uint8Array(1000))).status).toBe(201);
    const people = await json(await s.call("GET", "people"));
    expect(people[0].bytes).toBe(5 + OP_OVERHEAD_BYTES + 1000);
    expect((await json(await s.call("GET", "overview"))).bytesUsed).toBe(5 + OP_OVERHEAD_BYTES + 1000);
    const detail = await json(await s.call("GET", `people/${person.id}`));
    expect(detail.vaults[0]).toEqual({
      id: v.id, shortId: v.id.slice(0, 6), bytes: 5 + 128 + 1000, files: 1, lastActivity: expect.any(Number),
    });
  });
});

describe("settings and the address", () => {
  it("saves a normalised address, clears it with null, refuses a bad one", async () => {
    const { s } = await ready();
    expect(await json(await s.call("GET", "settings"))).toEqual({ publicUrl: null, blobQuotaBytes: 10737418240 });
    const put = await s.call("PUT", "settings", { publicUrl: "HTTPS://Sync.Example:443/" });
    expect([put.status, await json(put)]).toEqual([200, { publicUrl: ADDRESS }]);
    expect(await json(await s.call("GET", "settings"))).toEqual({ publicUrl: ADDRESS, blobQuotaBytes: 10737418240 });
    for (const bad of ["ftp://x.example", "https://x.example/path", "nonsense", 5]) {
      const r = await s.call("PUT", "settings", { publicUrl: bad });
      expect([bad, r.status, await json(r)]).toEqual([bad, 400, { error: "invalid_address" }]);
    }
    expect((await s.call("PUT", "settings", {})).status).toBe(400);
    expect((await s.call("PUT", "settings", [])).status).toBe(400);
    const cleared = await s.call("PUT", "settings", { publicUrl: null });
    expect(await json(cleared)).toEqual({ publicUrl: null });
    expect(await json(await s.call("GET", "settings"))).toEqual({ publicUrl: null, blobQuotaBytes: 10737418240 });
  });

  it("blob quota setting: default, save, validation, effect", async () => {
    const { t, s } = await ready();
    expect(await json(await s.call("GET", "settings"))).toEqual({ publicUrl: null, blobQuotaBytes: 10737418240 });
    const put = await s.call("PUT", "settings", { blobQuotaBytes: 5 * 1024 ** 3 });
    expect([put.status, await json(put)]).toEqual([200, { blobQuotaBytes: 5368709120 }]);
    expect(blobQuotaBytes(t.db)).toBe(5368709120);
    expect((await json(await s.call("GET", "settings"))).blobQuotaBytes).toBe(5368709120);
    for (const bad of [-1, 1.5, "10", null, true, 2 ** 50 + 1]) {
      const r = await s.call("PUT", "settings", { blobQuotaBytes: bad });
      expect([bad, r.status, await json(r)]).toEqual([bad, 400, { error: "invalid_quota" }]);
    }
    for (const ok of [0, 2 ** 50]) expect((await s.call("PUT", "settings", { blobQuotaBytes: ok })).status).toBe(200);
    for (const body of [{ publicUrl: ADDRESS, blobQuotaBytes: 1 }, {}, [], { other: 1 }, { blobQuotaBytes: 1, other: 1 }]) {
      const r = await s.call("PUT", "settings", body);
      expect([body, r.status, await json(r)]).toEqual([body, 400, { error: "invalid_request" }]);
    }
    expect((await s.call("PUT", "settings", { blobQuotaBytes: 10 })).status).toBe(200);
    const v = await newVault(t);
    const r = await uploadBlob(t, v, newBlobId(), new Uint8Array(11));
    expect([r.status, await json(r)]).toEqual([413, { error: "quota_exceeded" }]);
  });


  it("POST people needs an address: 409 address_not_set until saved; PUBLIC_URL counts", async () => {
    const { s } = await ready();
    const r = await s.call("POST", "people", { name: "Anna" });
    expect([r.status, await json(r)]).toEqual([409, { error: "address_not_set" }]);
    await withAddress(s);
    expect((await s.call("POST", "people", { name: "Anna" })).status).toBe(201);
    const env = await ready({ publicUrl: "https://env.example/" });
    const c = await create(env.s);
    expect(decodeConnectionCode(c.connectionCode)!.url).toBe("https://env.example");
  });

  it("overview: address, suggestion, insecure", async () => {
    const { t, s } = await ready();
    let o = await json(await s.call("GET", "overview"));
    expect(o).toMatchObject({ address: null, addressSuggestion: "http://localhost", insecure: false, version: "1.0.0" });
    await withAddress(s);
    expect((await json(await s.call("GET", "overview"))).address).toBe(ADDRESS);
    // plain http from a host other than localhost / 127.0.0.1 is insecure; https is not
    const at = (url: string, headers: Record<string, string> = {}) =>
      t.app.fetch(new Request(url, { headers: { cookie: s.cookie, ...headers } })).then(json);
    expect((await at("http://sync.example/admin/api/overview")).insecure).toBe(true);
    expect((await at("http://192.168.1.5:8787/admin/api/overview")).insecure).toBe(true);
    expect((await at("http://127.0.0.1:8787/admin/api/overview")).insecure).toBe(false);
    expect((await at("http://[::1]:8787/admin/api/overview")).insecure).toBe(false);
    expect((await at("http://[::1]/admin/api/overview")).insecure).toBe(false);
    expect((await at("https://sync.example/admin/api/overview")).insecure).toBe(false);
    // behind a proxy that is not trusted the forwarded scheme is ignored
    expect((await at("http://sync.example/admin/api/overview", { "x-forwarded-proto": "https" })).insecure).toBe(true);
    const p = await ready({ trustProxy: true });
    const via = await p.t.app.fetch(
      new Request("http://sync.example/admin/api/overview", {
        headers: { cookie: p.s.cookie, "x-forwarded-proto": "https", "x-forwarded-host": "sync.example" },
      }),
    );
    expect(await json(via)).toMatchObject({ insecure: false, addressSuggestion: "https://sync.example" });
    o = await json(await s.call("GET", "overview"));
    expect(typeof o.bytesFree).toBe("number");
    expect(o.bytesFree).toBeGreaterThan(0);
  });
});

describe("people", () => {
  it("creates a person and returns the connection code", async () => {
    const { t, s } = await ready();
    await withAddress(s);
    const r = await s.call("POST", "people", { name: "  Anna  " });
    expect(r.status).toBe(201);
    const b = await json(r);
    expect(b.person).toEqual({
      id: expect.any(String), name: "Anna", state: "active", profiles: 0, bytes: 0, lastActivity: null, createdAt: t.clock.now,
    });
    const stored = t.stores.people.get(b.person.id)!;
    expect(decodeConnectionCode(b.connectionCode)).toEqual({ url: ADDRESS, account: stored.account });
    for (const bad of [{}, { name: "" }, { name: "x".repeat(81) }, { name: 3 }]) {
      const e = await s.call("POST", "people", bad);
      expect([e.status, await json(e)]).toEqual([400, { error: "invalid_name" }]);
    }
    expect((await s.call("POST", "people", [])).status).toBe(400);
  });

  it("lists people with profiles, bytes (ops + snapshots) and last activity", async () => {
    const { t, s } = await ready();
    await withAddress(s);
    const a = await create(s, "Anna");
    const b = await create(s, "Bob");
    const anna = t.stores.people.get(a.person.id)!;
    const v1 = await newVault(t, anna.account);
    const v2 = await newVault(t, anna.account);
    await push(t, v1, [{ id: "a", ct: btoa("12345") }]);
    await uploadSnapshot(t, v1, 1, "snap-12");
    t.clock.now += 600;
    await pull(t, v2);
    const list = await json(await s.call("GET", "people"));
    expect(list.map((p: any) => p.name)).toEqual(["Anna", "Bob"]);
    expect(list[0]).toEqual({
      id: a.person.id, name: "Anna", state: "active", profiles: 2, bytes: 5 + OP_OVERHEAD_BYTES + 7,
      lastActivity: Math.floor(t.clock.now / 60) * 60, createdAt: anna.createdAt,
    });
    expect(list[1]).toMatchObject({ id: b.person.id, profiles: 0, bytes: 0, lastActivity: null });
    const o = await json(await s.call("GET", "overview"));
    expect(o).toMatchObject({ people: 2, profiles: 2, bytesUsed: 12 + OP_OVERHEAD_BYTES, lastActivity: list[0].lastActivity });
    const empty = await ready();
    expect(await json(await empty.s.call("GET", "overview"))).toMatchObject({ people: 0, profiles: 0, bytesUsed: 0, lastActivity: null });
  });

  it("GET people/:id adds the vaults with a 6-character short id", async () => {
    const { t, s } = await ready();
    await withAddress(s);
    const a = await create(s);
    const v = await newVault(t, t.stores.people.get(a.person.id)!.account);
    await push(t, v, [{ id: "a", ct: btoa("123") }]);
    const r = await json(await s.call("GET", `people/${a.person.id}`));
    expect(r).toMatchObject({ id: a.person.id, name: "Anna", profiles: 1, bytes: 3 + OP_OVERHEAD_BYTES });
    expect(r.vaults).toEqual([{ id: v.id, shortId: v.id.slice(0, 6), bytes: 3 + OP_OVERHEAD_BYTES, files: 0, lastActivity: expect.any(Number) }]);
    const none = await s.call("GET", "people/nope");
    expect([none.status, await json(none)]).toEqual([404, { error: "person_not_found" }]);
  });

  it("PATCH takes exactly one of name or state", async () => {
    const { t, s } = await ready();
    await withAddress(s);
    const a = await create(s);
    const p = t.stores.people.get(a.person.id)!;
    const patch = (body: unknown) => s.call("PATCH", `people/${a.person.id}`, body);
    expect(await json(await patch({ name: " Anja " }))).toMatchObject({ id: a.person.id, name: "Anja" });
    for (const bad of [{}, { name: "x", state: "blocked" }, { state: "paused" }, { state: 1 }, { foo: 1 }, { name: "x", foo: 1 }, []]) {
      const r = await patch(bad);
      expect([JSON.stringify(bad), r.status, await json(r)]).toEqual([JSON.stringify(bad), 400, { error: "invalid_request" }]);
    }
    const e = await patch({ name: "" });
    expect([e.status, await json(e)]).toEqual([400, { error: "invalid_name" }]);
    const v = await newVault(t, p.account);
    t.clock.now += 100;
    expect(await json(await patch({ state: "blocked" }))).toMatchObject({ state: "blocked" });
    const me = await t.call("GET", "/v1/accounts/me", { headers: { "moony-account": p.account } });
    expect(await json(me)).toMatchObject({ active: false });
    expect((await push(t, v, [{ id: "z", ct: btoa("1") }])).status).toBe(402);
    expect(await json(await patch({ state: "active" }))).toMatchObject({ state: "active" });
    expect((await push(t, v, [{ id: "z", ct: btoa("1") }])).status).toBe(200);
    for (const [m, path] of [["PATCH", "people/nope"], ["DELETE", "people/nope"], ["POST", "people/nope/connection-code"], ["DELETE", "people/nope/vaults/x"]]) {
      const r = await s.call(m!, path!, m === "DELETE" ? undefined : { name: "x", password: ADMIN_PASSWORD });
      expect([path, r.status, await json(r)]).toEqual([path, 404, { error: "person_not_found" }]);
    }
  });
});

describe("connection code reveal", () => {
  it("needs the admin password, with the login attempt limit", async () => {
    const { t, s } = await ready();
    await withAddress(s);
    const a = await create(s);
    const reveal = (password: unknown, clientAddress = "203.0.113.9") =>
      s.call("POST", `people/${a.person.id}/connection-code`, { password }, { clientAddress });
    const ok = await reveal(ADMIN_PASSWORD);
    expect([ok.status, await json(ok)]).toEqual([200, { connectionCode: a.connectionCode }]);
    for (const bad of ["wrong password!", 5, undefined]) {
      const r = await reveal(bad);
      expect([r.status, await json(r)]).toEqual([401, { error: "bad_credentials" }]);
    }
    for (let i = 0; i < 2; i++) await reveal("wrong password!");
    const locked = await reveal("wrong password!");
    expect([locked.status, await json(locked)]).toEqual([429, { error: "rate_limited" }]);
    expect((await reveal(ADMIN_PASSWORD)).status).toBe(429);
    t.clock.now += 16 * 60;
    expect((await reveal(ADMIN_PASSWORD)).status).toBe(200);
  });
});

describe("deleting", () => {
  it("a person: vault calls answer vault_not_found at once, the account is gone, files too", async () => {
    const { t, s } = await ready();
    await withAddress(s);
    const a = await create(s);
    const p = t.stores.people.get(a.person.id)!;
    const v = await newVault(t, p.account);
    await push(t, v, [{ id: "a", ct: btoa("1") }]);
    await uploadSnapshot(t, v, 1, "snap");
    const other = await newVault(t);
    expect(snapshotFiles(t, v)).toHaveLength(1);

    const r = await s.call("DELETE", `people/${a.person.id}`);
    expect(r.status).toBe(204);
    expect(await json(await t.call("GET", "/v1/accounts/me", { headers: { "moony-account": p.account } }))).toEqual({ error: "account_not_found" });
    const pulled = await pull(t, v);
    expect([pulled.status, await json(pulled)]).toEqual([404, { error: "vault_not_found" }]);
    const pushed = await push(t, v, [{ id: "b", ct: btoa("1") }]);
    expect([pushed.status, (await json(pushed)).error]).toEqual([404, "vault_not_found"]);
    expect((await uploadSnapshot(t, v, 1, "x")).status).toBe(404);
    expect(existsSync(join(t.dataDir, "snapshots", v.id))).toBe(false);
    expect(t.db.prepare("SELECT COUNT(*) AS n FROM pending_wipes").get()).toEqual({ n: 0 });
    expect((await pull(t, other)).status).toBe(200); // somebody else is untouched
    expect((await s.call("GET", `people/${a.person.id}`)).status).toBe(404);
    expect((await s.call("DELETE", `people/${a.person.id}`)).status).toBe(404);
  });

  it("a person whose snapshot upload is in flight: the upload is refused and its file removed", async () => {
    const { t, s } = await ready();
    await withAddress(s);
    const a = await create(s);
    const v = await newVault(t, t.stores.people.get(a.person.id)!.account);
    const enc = new TextEncoder();
    let step = 0;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (step++ === 0) return controller.enqueue(enc.encode("first-half-"));
        // authorizeSnapshot is behind us and the first chunk is on disk: delete the person now
        expect((await s.call("DELETE", `people/${a.person.id}`)).status).toBe(204);
        controller.enqueue(enc.encode("second-half"));
        controller.close();
      },
    });
    const length = "first-half-second-half".length;
    const res = await t.call("PUT", `/v1/vaults/${v.id}/snapshot?seq=0`, {
      headers: { authorization: `Bearer ${v.token}`, "content-length": String(length), "content-type": "application/octet-stream" },
      body,
      // @ts-expect-error Node's fetch needs duplex for a stream body
      duplex: "half",
    });
    expect([res.status, await json(res)]).toEqual([404, { error: "vault_not_found" }]);
    expect(snapshotFiles(t, v)).toEqual([]);
    expect(t.db.prepare("SELECT COUNT(*) AS n FROM snapshots").get()).toEqual({ n: 0 });
  });

  it("one vault of a person; the person and the others stay", async () => {
    const { t, s } = await ready();
    await withAddress(s);
    const a = await create(s);
    const acc = t.stores.people.get(a.person.id)!.account;
    const v1 = await newVault(t, acc);
    const v2 = await newVault(t, acc);
    await uploadSnapshot(t, v1, 0, "s");
    const stranger = await newVault(t);
    // a vault of another person is not found under this person
    const wrong = await s.call("DELETE", `people/${a.person.id}/vaults/${stranger.id}`);
    expect([wrong.status, await json(wrong)]).toEqual([404, { error: "vault_not_found" }]);
    expect((await s.call("DELETE", `people/${a.person.id}/vaults/${v1.id}`)).status).toBe(204);
    expect((await pull(t, v1)).status).toBe(404);
    expect(snapshotFiles(t, v1)).toEqual([]);
    expect((await pull(t, v2)).status).toBe(200);
    expect((await pull(t, stranger)).status).toBe(200);
    expect((await json(await s.call("GET", `people/${a.person.id}`))).profiles).toBe(1);
    expect((await s.call("DELETE", `people/${a.person.id}/vaults/${v1.id}`)).status).toBe(404);
  });
});

describe("no account numbers in admin answers", () => {
  it("never outside connectionCode", async () => {
    const { t, s } = await ready();
    await withAddress(s);
    const accounts: string[] = [];
    const texts: string[] = [];
    const take = async (r: Response) => {
      texts.push(await r.clone().text());
      return r;
    };
    const a = await create(s, "Anna");
    accounts.push(t.stores.people.get(a.person.id)!.account);
    const b = await take(await s.call("POST", "people", { name: "Bob" }));
    const bb = await json(b.clone());
    accounts.push(t.stores.people.get(bb.person.id)!.account);
    const v = await newVault(t, accounts[0]!);
    await push(t, v, [{ id: "a", ct: btoa("1") }]);
    for (const path of ["overview", "people", `people/${a.person.id}`, `people/${bb.person.id}`, "settings"]) await take(await s.call("GET", path));
    await take(await s.call("PATCH", `people/${a.person.id}`, { name: "Anja" }));
    await take(await s.call("PATCH", `people/${a.person.id}`, { state: "blocked" }));
    await take(await s.call("PUT", "settings", { publicUrl: ADDRESS }));
    await take(await s.call("POST", `people/${a.person.id}/connection-code`, { password: "wrong password!" }));
    await take(await s.call("POST", "people", { name: "" }));
    await take(await s.call("GET", "people/unknown"));
    await take(await s.call("DELETE", `people/${bb.person.id}`));
    const all = texts.join("\n");
    for (const acc of accounts) {
      // strip the connection codes that legitimately carry the number
      const stripped = all.replace(/"connectionCode":"[^"]*"/g, "");
      expect(stripped).not.toContain(acc);
    }
  });
});

export type { TestApp };

describe("PATCH people/:id name", () => {
  it("a name that is not a string is 400 invalid_name", async () => {
    const { s } = await ready();
    await withAddress(s);
    const { person } = await create(s);
    for (const name of [42, null, ["Anna"], { a: 1 }, true]) {
      const r = await s.call("PATCH", `people/${person.id}`, { name });
      expect([name, r.status, await json(r)]).toEqual([name, 400, { error: "invalid_name" }]);
    }
  });
});
