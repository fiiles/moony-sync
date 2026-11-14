// Blob routes: upload, download and HEAD.

import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { setBlobQuotaBytes } from "../src/blobs.js";
import { FREE_SPACE_FLOOR_BYTES, MAX_BLOB_BYTES } from "../src/limits.js";
import {
  auth,
  b64,
  blobFiles,
  countingBody,
  heldBlobUpload,
  newBlobId,
  newToken,
  newVault,
  newVaultId,
  testApp,
  uploadBlob,
  type TestApp,
  type Vault,
} from "./helpers.js";

function fill(n: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i += 65536) crypto.getRandomValues(out.subarray(i, Math.min(n, i + 65536)));
  return out;
}

async function rotate(t: TestApp, v: Vault): Promise<Vault> {
  const next = newToken();
  const rot = await t.call("POST", `/v1/vaults/${v.id}/token`, {
    headers: auth(v, { "content-type": "application/json" }),
    body: JSON.stringify({ token: next, rekey: b64("bundle") }),
  });
  expect(rot.status).toBe(200);
  return { ...v, token: next };
}

const blobUrl = (v: { id: string }, id: string): string => `/v1/vaults/${v.id}/blobs/${id}`;
const get = (t: TestApp, v: Vault, id: string, method = "GET") =>
  t.call(method, blobUrl(v, id), { headers: auth(v) });
const rows = (t: TestApp): number => (t.db.prepare("SELECT COUNT(*) AS n FROM blobs").get() as { n: number }).n;

/** A body of `chunks` 64 KiB pieces the server pulls one at a time, for the "before the body" checks. */
function putCounting(t: TestApp, v: { id: string }, token: string, id: string, chunks = 40, length?: number) {
  const { state, body } = countingBody(chunks);
  const response = t.call("PUT", blobUrl(v, id), {
    headers: { authorization: `Bearer ${token}`, "content-length": String(length ?? chunks * 65536) },
    body,
    duplex: "half",
  } as RequestInit);
  return { state, response };
}

describe("upload and download", () => {
  it("round trip: 201 created, GET returns the exact bytes, file is blobs/<vault>/<id>", async () => {
    const t = testApp();
    const v = await newVault(t);
    const id = newBlobId();
    const data = fill(200_000);
    const put = await uploadBlob(t, v, id, data);
    expect([put.status, await put.json()]).toEqual([201, { created: true }]);
    const res = await get(t, v, id);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("content-length")).toBe("200000");
    expect(Buffer.from(await res.arrayBuffer()).equals(Buffer.from(data))).toBe(true);
    expect(blobFiles(t, v)).toEqual([id]);
  });

  it("re-upload of an existing id is 200 created:false without reading the body or checking the length", async () => {
    const t = testApp();
    const v = await newVault(t);
    const id = newBlobId();
    await uploadBlob(t, v, id, "first");
    const { state, body } = countingBody(40);
    const res = await t.call("PUT", blobUrl(v, id), { headers: auth(v), body, duplex: "half" } as RequestInit);
    expect([res.status, await res.json()]).toEqual([200, { created: false }]);
    expect(state.pulled).toBeLessThanOrEqual(1);
    expect(await (await get(t, v, id)).text()).toBe("first");
  });

  it("two uploads of the same id at once: 201 and 200, one record, one file, no temp", async () => {
    const t = testApp();
    const v = await newVault(t);
    const id = newBlobId();
    const a = heldBlobUpload(t, v, id, "aaaaaaaaaa");
    const b = heldBlobUpload(t, v, id, "bbbbbbbbbb");
    await a.started();
    await vi.waitFor(() => expect(blobFiles(t, v).filter((f) => f.endsWith(".tmp"))).toHaveLength(2));
    a.finish();
    b.finish();
    const statuses = [(await a.response).status, (await b.response).status].sort();
    expect(statuses).toEqual([200, 201]);
    expect(blobFiles(t, v)).toEqual([id]);
    expect(rows(t)).toBe(1);
    expect(["aaaaaaaaaa", "bbbbbbbbbb"]).toContain(await (await get(t, v, id)).text());
  });

  it("HEAD: 200 with Content-Length and Moony-Blob-Size and no body; 404 says which", async () => {
    const t = testApp();
    const v = await newVault(t);
    const id = newBlobId();
    await uploadBlob(t, v, id, fill(1234));
    const head = await get(t, v, id, "HEAD");
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe("1234");
    expect(head.headers.get("moony-blob-size")).toBe("1234");
    expect(await head.text()).toBe("");
    const missing = await get(t, v, newBlobId(), "HEAD");
    expect(missing.status).toBe(404);
    expect(missing.headers.get("moony-error")).toBe("blob_not_found");
    const other = await t.call("HEAD", `/v1/vaults/${newVaultId()}/blobs/${id}`, { headers: auth(v) });
    expect(other.status).toBe(404);
    expect(other.headers.get("moony-error")).toBe("vault_not_found");
  });

  it("GET of a missing blob is 404 blob_not_found; a record whose file is gone is 404 too, never an empty 200", async () => {
    const t = testApp();
    const v = await newVault(t);
    const none = await get(t, v, newBlobId());
    expect([none.status, await none.json(), none.headers.get("moony-error")]).toEqual([
      404,
      { error: "blob_not_found" },
      "blob_not_found",
    ]);
    const id = newBlobId();
    await uploadBlob(t, v, id, "content");
    rmSync(join(t.dataDir, "blobs", v.id, id));
    const res = await get(t, v, id);
    expect([res.status, await res.json(), res.headers.get("moony-error")]).toEqual([
      404,
      { error: "blob_not_found" },
      "blob_not_found",
    ]);
    expect((await get(t, v, id, "HEAD")).status).toBe(404);
  });
});

describe("access", () => {
  it("a previous (rotated) token reads with GET and HEAD, and gets 403 token_read_only for PUT", async () => {
    const t = testApp();
    const v = await newVault(t);
    const id = newBlobId();
    await uploadBlob(t, v, id, "content");
    await rotate(t, v);
    expect(await (await get(t, v, id)).text()).toBe("content");
    expect((await get(t, v, id, "HEAD")).status).toBe(200);
    const put = await uploadBlob(t, v, newBlobId(), "more");
    expect([put.status, await put.json()]).toEqual([403, { error: "token_read_only" }]);
    expect(put.headers.get("moony-error")).toBe("token_read_only");
  });

  it("a blocked person reads inside the 30-day grace and is 402 after it", async () => {
    const t = testApp();
    const v = await newVault(t);
    const id = newBlobId();
    await uploadBlob(t, v, id, "content");
    t.stores.people.setState(t.stores.people.byAccount(v.account)!.id, "blocked");
    t.clock.now += 86_400;
    expect((await get(t, v, id)).status).toBe(200);
    t.clock.now += 30 * 86_400;
    const res = await get(t, v, id);
    expect([res.status, await res.json()]).toEqual([402, { error: "payment_required" }]);
  });

  it("token before body: unknown vault 404, wrong token 401, read-only 403, blocked 402, none reads the body", async () => {
    const t = testApp();
    const v = await newVault(t);
    const cases: [string, number, () => { state: { pulled: number }; response: Promise<Response> }][] = [
      ["unknown vault", 404, () => putCounting(t, { id: newVaultId() }, newToken(), newBlobId())],
      ["wrong token", 401, () => putCounting(t, v, newToken(), newBlobId())],
    ];
    for (const [, status, run] of cases) {
      const c = run();
      expect((await c.response).status).toBe(status);
      expect(c.state.pulled).toBeLessThanOrEqual(1);
    }
    const old = { ...v };
    const rotated = await rotate(t, v);
    const ro = putCounting(t, old, old.token, newBlobId());
    expect((await ro.response).status).toBe(403);
    expect(ro.state.pulled).toBeLessThanOrEqual(1);
    t.stores.people.setState(t.stores.people.byAccount(v.account)!.id, "blocked");
    t.clock.now += 1;
    const blocked = putCounting(t, rotated, rotated.token, newBlobId());
    expect((await blocked.response).status).toBe(402);
    expect(blocked.state.pulled).toBeLessThanOrEqual(1);
    expect(existsSync(join(t.dataDir, "blobs"))).toBe(false);
  });
});

describe("path safety", () => {
  it("a non-UUID or traversal blob id is 400 invalid_blob_id for PUT, GET and HEAD, and nothing is created", async () => {
    const t = testApp();
    const v = await newVault(t);
    const bad = [
      "not-a-uuid",
      "0F8FAD5B-D9CB-469F-A165-70867728950E",
      "..%2F..%2Fmoony-sync.db",
      "0f8fad5b-d9cb-469f-a165-70867728950",
      "0f8fad5b-d9cb-469f-a165-70867728950eX",
    ];
    for (const id of bad) {
      for (const method of ["PUT", "GET", "HEAD"]) {
        const res = await t.call(method, blobUrl(v, id), {
          headers: auth(v, method === "PUT" ? { "content-length": "3" } : {}),
          body: method === "PUT" ? "abc" : undefined,
        });
        expect(res.status).toBe(400);
        expect(res.headers.get("moony-error")).toBe("invalid_blob_id");
        if (method !== "HEAD") expect(await res.json()).toEqual({ error: "invalid_blob_id" });
      }
    }
    expect(existsSync(join(t.dataDir, "blobs"))).toBe(false);
  });

  it("an extra path segment is 404 not_found", async () => {
    const t = testApp();
    const v = await newVault(t);
    const res = await t.call("GET", `${blobUrl(v, newBlobId())}/x`, { headers: auth(v) });
    expect([res.status, await res.json()]).toEqual([404, { error: "not_found" }]);
    expect(res.headers.get("moony-error")).toBe("not_found");
  });

  it("a trailing slash after /blobs is 404 not_found with the Moony-Error header", async () => {
    const t = testApp();
    const v = await newVault(t);
    const res = await t.call("GET", `/v1/vaults/${v.id}/blobs/`, { headers: auth(v) });
    expect([res.status, await res.json()]).toEqual([404, { error: "not_found" }]);
    expect(res.headers.get("moony-error")).toBe("not_found");
  });
});

describe("bodies", () => {
  it("411 length_required without or with a zero Content-Length", async () => {
    const t = testApp();
    const v = await newVault(t);
    const none = await t.call("PUT", blobUrl(v, newBlobId()), { headers: auth(v), body: new Uint8Array(0) });
    expect([none.status, await none.json()]).toEqual([411, { error: "length_required" }]);
    const zero = await uploadBlob(t, v, newBlobId(), "");
    expect([zero.status, await zero.json()]).toEqual([411, { error: "length_required" }]);
    expect(zero.headers.get("moony-error")).toBe("length_required");
  });

  it("declared over 104,883,275 bytes is 413 blob_too_large before the body", async () => {
    const t = testApp();
    const v = await newVault(t);
    const c = putCounting(t, v, v.token, newBlobId(), 40, MAX_BLOB_BYTES + 1);
    const res = await c.response;
    expect([res.status, await res.json()]).toEqual([413, { error: "blob_too_large" }]);
    expect(c.state.pulled).toBeLessThanOrEqual(1);
  });

  it("declared exactly MAX_BLOB_BYTES passes the size gate (a short body then is 400 incomplete_body)", async () => {
    const t = testApp();
    const v = await newVault(t);
    const res = await putCounting(t, v, v.token, newBlobId(), 2, MAX_BLOB_BYTES).response;
    expect([res.status, await res.json()]).toEqual([400, { error: "incomplete_body" }]);
    expect(blobFiles(t, v)).toEqual([]);
  });

  it("an upload that ends early is 400 incomplete_body and leaves no file and no record", async () => {
    const t = testApp();
    const v = await newVault(t);
    const early = await t.call("PUT", blobUrl(v, newBlobId()), {
      headers: auth(v, { "content-length": "50" }),
      body: "0123456789",
    });
    expect([early.status, await early.json()]).toEqual([400, { error: "incomplete_body" }]);
    expect(early.headers.get("moony-error")).toBe("incomplete_body");
    const up = heldBlobUpload(t, v, newBlobId(), "0123456789");
    await up.started();
    up.fail();
    const res = await up.response;
    expect([res.status, await res.json()]).toEqual([400, { error: "incomplete_body" }]);
    expect(blobFiles(t, v)).toEqual([]);
    expect(rows(t)).toBe(0);
  });

  it("a body longer than declared is 413 blob_too_large, nothing left", async () => {
    const t = testApp();
    const v = await newVault(t);
    const res = await t.call("PUT", blobUrl(v, newBlobId()), {
      headers: auth(v, { "content-length": "5" }),
      body: new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode("0123456789"));
          c.close();
        },
      }),
      duplex: "half",
    } as RequestInit);
    expect([res.status, await res.json()]).toEqual([413, { error: "blob_too_large" }]);
    expect(blobFiles(t, v)).toEqual([]);
    expect(rows(t)).toBe(0);
  });

  it("a body idle for 30 s is 408 body_timeout and leaves no temp", async () => {
    const t = testApp();
    const v = await newVault(t);
    vi.useFakeTimers();
    try {
      const up = heldBlobUpload(t, v, newBlobId(), "0123456789");
      await up.started();
      await vi.advanceTimersByTimeAsync(29_000);
      await vi.advanceTimersByTimeAsync(2_000);
      const res = await up.response;
      expect([res.status, await res.json()]).toEqual([408, { error: "body_timeout" }]);
      expect(res.headers.get("moony-error")).toBe("body_timeout");
    } finally {
      vi.useRealTimers();
    }
    expect(blobFiles(t, v)).toEqual([]);
  });

  it("a 9 MiB upload succeeds while the same client already holds its whole 8 MiB body share (exempt from the budget)", async () => {
    const t = testApp();
    const v = await newVault(t);
    const ends: (() => void)[] = [];
    const login = (body: ReadableStream<Uint8Array>) =>
      t.app.fetch(
        new Request("http://localhost/admin/api/login", {
          method: "POST",
          headers: { origin: "http://localhost", "content-type": "application/json" },
          body,
          duplex: "half",
        } as RequestInit),
        "203.0.113.9",
      );
    const pending = Array.from({ length: 512 }, () => {
      let ctl!: ReadableStreamDefaultController<Uint8Array>;
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          ctl = c;
          c.enqueue(new Uint8Array(16 * 1024).fill(0x20));
        },
      });
      ends.push(() => ctl.error(new Error("client gone")));
      return login(body);
    });
    await new Promise((r) => setTimeout(r, 200));
    const extra = await login(
      new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new Uint8Array(1).fill(0x20));
        },
      }),
    );
    expect(extra.status).toBe(503);
    const data = fill(9 * 1024 * 1024);
    const res = await t.call("PUT", blobUrl(v, newBlobId()), {
      headers: auth(v, { "content-length": String(data.byteLength) }),
      body: data,
      clientAddress: "203.0.113.9",
    });
    expect(res.status).toBe(201);
    for (const end of ends) end();
    await Promise.allSettled(pending);
  }, 30_000);

  it("507 server_full when the upload would leave under 1 GiB, before the body", async () => {
    const t = testApp();
    const v = await newVault(t);
    t.disk.free = FREE_SPACE_FLOOR_BYTES + 100;
    const full = putCounting(t, v, v.token, newBlobId(), 2, 101);
    const res = await full.response;
    expect([res.status, await res.json()]).toEqual([507, { error: "server_full" }]);
    expect(res.headers.get("moony-error")).toBe("server_full");
    expect(full.state.pulled).toBeLessThanOrEqual(1);
    const ok = await uploadBlob(t, v, newBlobId(), fill(100));
    expect(ok.status).toBe(201);
  });
});

describe("races", () => {
  it("vault deleted while the body streams: 404 vault_not_found, no file, no record", async () => {
    const t = testApp();
    const v = await newVault(t);
    const up = heldBlobUpload(t, v, newBlobId(), "0123456789");
    await up.started();
    expect((await t.call("DELETE", `/v1/vaults/${v.id}`, { headers: auth(v) })).status).toBe(204);
    up.finish();
    const res = await up.response;
    expect([res.status, await res.json()]).toEqual([404, { error: "vault_not_found" }]);
    expect(blobFiles(t, v)).toEqual([]);
    expect(rows(t)).toBe(0);
  });

  it("token rotated mid-upload: 403 token_read_only, no file, no record, no temp", async () => {
    const t = testApp();
    const v = await newVault(t);
    const up = heldBlobUpload(t, v, newBlobId(), "0123456789");
    await up.started();
    const rot = await t.call("POST", `/v1/vaults/${v.id}/token`, {
      headers: auth(v, { "content-type": "application/json" }),
      body: JSON.stringify({ token: newToken(), rekey: b64("bundle") }),
    });
    expect(rot.status).toBe(200);
    up.finish();
    const res = await up.response;
    expect([res.status, await res.json()]).toEqual([403, { error: "token_read_only" }]);
    expect(blobFiles(t, v)).toEqual([]);
    expect(rows(t)).toBe(0);
  });
});

const listUrl = (v: { id: string }, query = ""): string => `/v1/vaults/${v.id}/blobs${query}`;
const list = (t: TestApp, v: Vault, query = "") => t.call("GET", listUrl(v, query), { headers: auth(v) });

describe("list", () => {
  it("pages by id: limit, after (exclusive), more; entries are id, size, createdAt", async () => {
    const t = testApp();
    const v = await newVault(t);
    const ids = Array.from({ length: 5 }, newBlobId).sort();
    const entries = [];
    for (const [i, id] of ids.entries()) {
      t.clock.now += 10;
      expect((await uploadBlob(t, v, id, "x".repeat(i + 1))).status).toBe(201);
      entries.push({ id, size: i + 1, createdAt: t.clock.now });
    }
    expect(await (await list(t, v, "?limit=2")).json()).toEqual({ blobs: entries.slice(0, 2), more: true });
    expect(await (await list(t, v, `?after=${ids[1]}&limit=2`)).json()).toEqual({
      blobs: entries.slice(2, 4),
      more: true,
    });
    expect(await (await list(t, v, `?after=${ids[3]}`)).json()).toEqual({ blobs: [entries[4]], more: false });
  });

  it("defaults and bounds: no params lists all; limit=0 is 400 invalid_limit; limit=5000 clamps; bad after is 400 invalid_blob_id", async () => {
    const t = testApp();
    const v = await newVault(t);
    for (let i = 0; i < 3; i++) await uploadBlob(t, v, newBlobId(), "a");
    expect(((await (await list(t, v)).json()) as { blobs: unknown[] }).blobs).toHaveLength(3);
    const zero = await list(t, v, "?limit=0");
    expect([zero.status, await zero.json()]).toEqual([400, { error: "invalid_limit" }]);
    expect(zero.headers.get("moony-error")).toBe("invalid_limit");
    const big = await list(t, v, "?limit=5000");
    expect([big.status, ((await big.json()) as { more: boolean }).more]).toEqual([200, false]);
    expect(((await (await list(t, v, "?limit=abc")).json()) as { blobs: unknown[] }).blobs).toHaveLength(3);
    for (const after of ["nope", "0F8FAD5B-D9CB-469F-A165-70867728950E", ""]) {
      const bad = await list(t, v, `?after=${after}`);
      expect([bad.status, await bad.json()]).toEqual([400, { error: "invalid_blob_id" }]);
      expect(bad.headers.get("moony-error")).toBe("invalid_blob_id");
    }
  });

  it("an empty vault lists nothing; another vault's blobs are never listed; a previous token can list", async () => {
    const t = testApp();
    const v = await newVault(t);
    const other = await newVault(t);
    expect(await (await list(t, v)).json()).toEqual({ blobs: [], more: false });
    const id = newBlobId();
    await uploadBlob(t, other, id, "other");
    expect(await (await list(t, v)).json()).toEqual({ blobs: [], more: false });
    await uploadBlob(t, v, id, "mine");
    await rotate(t, v);
    const res = await list(t, v);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { blobs: { id: string }[] }).blobs.map((b) => b.id)).toEqual([id]);
  });
});

describe("delete", () => {
  const del = (t: TestApp, v: Vault, id: string, token = v.token) =>
    t.call("DELETE", blobUrl(v, id), { headers: { authorization: `Bearer ${token}` } });

  it("current token: 204, then GET 404 blob_not_found, file and record gone; a second DELETE is 204 too", async () => {
    const t = testApp();
    const v = await newVault(t);
    const id = newBlobId();
    await uploadBlob(t, v, id, "content");
    expect(blobFiles(t, v)).toEqual([id]);
    expect((await del(t, v, id)).status).toBe(204);
    const res = await get(t, v, id);
    expect([res.status, await res.json()]).toEqual([404, { error: "blob_not_found" }]);
    expect(blobFiles(t, v)).toEqual([]);
    expect(rows(t)).toBe(0);
    expect((await del(t, v, id)).status).toBe(204);
  });

  it("a previous token is 403 token_read_only; a wrong token 401; an unknown vault 404 vault_not_found; a bad id 400", async () => {
    const t = testApp();
    const v = await newVault(t);
    const id = newBlobId();
    await uploadBlob(t, v, id, "content");
    const rotated = await rotate(t, v);
    const old = await del(t, v, id);
    expect([old.status, await old.json()]).toEqual([403, { error: "token_read_only" }]);
    expect(old.headers.get("moony-error")).toBe("token_read_only");
    expect((await del(t, rotated, id, newToken())).status).toBe(401);
    const unknown = await del(t, { ...v, id: newVaultId() }, id);
    expect([unknown.status, await unknown.json()]).toEqual([404, { error: "vault_not_found" }]);
    expect((await del(t, rotated, "not-a-uuid")).status).toBe(400);
    expect(rows(t)).toBe(1);
    expect(blobFiles(t, v)).toEqual([id]);
  });

  it("delete then upload of the same id is 201 created:true", async () => {
    const t = testApp();
    const v = await newVault(t);
    const id = newBlobId();
    await uploadBlob(t, v, id, "one");
    await del(t, v, id);
    const again = await uploadBlob(t, v, id, "two");
    expect([again.status, await again.json()]).toEqual([201, { created: true }]);
    expect(await (await get(t, v, id)).text()).toBe("two");
  });

  it("a blocked person past the grace: GET, HEAD and list are 402, DELETE is 204", async () => {
    const t = testApp();
    const v = await newVault(t);
    const id = newBlobId();
    await uploadBlob(t, v, id, "content");
    t.stores.people.setState(t.stores.people.byAccount(v.account)!.id, "blocked");
    t.clock.now += 31 * 86_400;
    expect((await get(t, v, id)).status).toBe(402);
    expect((await get(t, v, id, "HEAD")).status).toBe(402);
    expect((await list(t, v)).status).toBe(402);
    expect((await del(t, v, id)).status).toBe(204);
    expect(rows(t)).toBe(0);
  });

  it("frees quota: with the quota lowered below use, deleting makes room again", async () => {
    const t = testApp();
    setBlobQuotaBytes(t.db, 1000);
    const v = await newVault(t);
    const big = newBlobId();
    expect((await uploadBlob(t, v, big, fill(600))).status).toBe(201);
    setBlobQuotaBytes(t.db, 500);
    const refused = await uploadBlob(t, v, newBlobId(), fill(100));
    expect([refused.status, await refused.json()]).toEqual([413, { error: "quota_exceeded" }]);
    expect((await del(t, v, big)).status).toBe(204);
    expect((await uploadBlob(t, v, newBlobId(), fill(100))).status).toBe(201);
  });
});
