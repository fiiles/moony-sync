// Blob quota and the two-upload limit.

import { describe, expect, it, vi } from "vitest";
import { createUploadGate } from "../src/blob-api.js";
import { blobQuotaBytes, setBlobQuotaBytes } from "../src/blobs.js";
import {
  auth,
  blobFiles,
  countingBody,
  heldBlobUpload,
  newBlobId,
  newVault,
  testApp,
  uploadBlob,
  type TestApp,
  type Vault,
} from "./helpers.js";

const blobUrl = (v: { id: string }, id: string): string => `/v1/vaults/${v.id}/blobs/${id}`;
const rows = (t: TestApp): number => (t.db.prepare("SELECT COUNT(*) AS n FROM blobs").get() as { n: number }).n;
const bytes = (n: number): Uint8Array => new Uint8Array(n).fill(7);

function putCounting(t: TestApp, v: Vault, id: string, chunks: number, length: number) {
  const { state, body } = countingBody(chunks);
  const response = t.call("PUT", blobUrl(v, id), {
    headers: auth(v, { "content-length": String(length) }),
    body,
    duplex: "half",
  } as RequestInit);
  return { state, response };
}

describe("quota", () => {
  it("defaults to 10 GiB", () => expect(blobQuotaBytes(testApp().db)).toBe(10_737_418_240));

  it("refuses an upload past the quota before its body; exactly at the quota is allowed", async () => {
    const t = testApp();
    const v = await newVault(t);
    setBlobQuotaBytes(t.db, 1000);
    expect((await uploadBlob(t, v, newBlobId(), bytes(600))).status).toBe(201);
    const c = putCounting(t, v, newBlobId(), 7, 401);
    const res = await c.response;
    expect([res.status, await res.json()]).toEqual([413, { error: "quota_exceeded" }]);
    expect(res.headers.get("moony-error")).toBe("quota_exceeded");
    expect(c.state.pulled).toBeLessThanOrEqual(1);
    expect((await uploadBlob(t, v, newBlobId(), bytes(400))).status).toBe(201);
  });

  it("an empty body to a vault over quota is 400 empty_body, not 413", async () => {
    const t = testApp();
    const v = await newVault(t);
    setBlobQuotaBytes(t.db, 10);
    const res = await t.call("PUT", blobUrl(v, newBlobId()), { headers: auth(v, { "content-length": "100" }) });
    expect([res.status, await res.json()]).toEqual([400, { error: "empty_body" }]);
  });

  it("the commit re-checks: two uploads that each fit alone end as one 201 and one 413", async () => {
    const t = testApp();
    const v = await newVault(t);
    setBlobQuotaBytes(t.db, 1000);
    const a = heldBlobUpload(t, v, newBlobId(), bytes(600));
    const b = heldBlobUpload(t, v, newBlobId(), bytes(600));
    await a.started();
    a.finish();
    b.finish();
    const statuses = [(await a.response).status, (await b.response).status].sort();
    expect(statuses).toEqual([201, 413]);
    expect(rows(t)).toBe(1);
    expect(blobFiles(t, v).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("is per vault", async () => {
    const t = testApp();
    const a = await newVault(t);
    const b = await newVault(t);
    setBlobQuotaBytes(t.db, 1000);
    expect((await uploadBlob(t, a, newBlobId(), bytes(1000))).status).toBe(201);
    expect((await uploadBlob(t, a, newBlobId(), bytes(1))).status).toBe(413);
    expect((await uploadBlob(t, b, newBlobId(), bytes(1000))).status).toBe(201);
  });

  it("lowered below use: reads and re-uploads of existing ids work, new uploads are 413", async () => {
    const t = testApp();
    const v = await newVault(t);
    const id = newBlobId();
    expect((await uploadBlob(t, v, id, bytes(600))).status).toBe(201);
    setBlobQuotaBytes(t.db, 100);
    expect((await t.call("GET", blobUrl(v, id), { headers: auth(v) })).status).toBe(200);
    const again = await uploadBlob(t, v, id, bytes(600));
    expect([again.status, await again.json()]).toEqual([200, { created: false }]);
    expect((await uploadBlob(t, v, newBlobId(), bytes(10))).status).toBe(413);
  });

  it("an unparsable setting falls back to the default", () => {
    const t = testApp();
    t.db.prepare("INSERT INTO settings (key, value) VALUES ('blob_quota_bytes', 'lots')").run();
    expect(blobQuotaBytes(t.db)).toBe(10_737_418_240);
  });
});

describe("two uploads per vault", () => {
  it("a third concurrent upload to the same vault is 429 too_many_uploads before its body; other vaults are not affected", async () => {
    const t = testApp();
    const v = await newVault(t);
    const other = await newVault(t);
    const a = heldBlobUpload(t, v, newBlobId(), "aaaaaaaaaa");
    const b = heldBlobUpload(t, v, newBlobId(), "bbbbbbbbbb");
    await b.started(2);
    const c = putCounting(t, v, newBlobId(), 7, 7 * 65536);
    const res = await c.response;
    expect([res.status, await res.json()]).toEqual([429, { error: "too_many_uploads" }]);
    expect(res.headers.get("moony-error")).toBe("too_many_uploads");
    expect(c.state.pulled).toBeLessThanOrEqual(1);
    expect((await uploadBlob(t, other, newBlobId(), "x")).status).toBe(201);
    a.finish();
    expect((await a.response).status).toBe(201);
    expect((await uploadBlob(t, v, newBlobId(), "y")).status).toBe(201);
    b.finish();
    expect((await b.response).status).toBe(201);
  });

  it("a failed upload gives its slot back", async () => {
    const t = testApp();
    const v = await newVault(t);
    const a = heldBlobUpload(t, v, newBlobId(), "aaaaaaaaaa");
    const b = heldBlobUpload(t, v, newBlobId(), "bbbbbbbbbb");
    await b.started(2);
    a.fail();
    b.fail();
    expect([(await a.response).status, (await b.response).status]).toEqual([400, 400]);
    expect((await uploadBlob(t, v, newBlobId(), "x")).status).toBe(201);
    expect((await uploadBlob(t, v, newBlobId(), "y")).status).toBe(201);
  });

  it("an upload that ends with 408 body_timeout gives its slot back", async () => {
    const t = testApp();
    const v = await newVault(t);
    vi.useFakeTimers();
    try {
      const a = heldBlobUpload(t, v, newBlobId(), "aaaaaaaaaa");
      const b = heldBlobUpload(t, v, newBlobId(), "bbbbbbbbbb");
      await b.started(2);
      await vi.advanceTimersByTimeAsync(31_000);
      expect([(await a.response).status, (await b.response).status]).toEqual([408, 408]);
    } finally {
      vi.useRealTimers();
    }
    const c = heldBlobUpload(t, v, newBlobId(), "cccccccccc");
    const d = heldBlobUpload(t, v, newBlobId(), "dddddddddd");
    await d.started(2);
    c.finish();
    d.finish();
    expect([(await c.response).status, (await d.response).status]).toEqual([201, 201]);
  });

  it("an upload that ends with 500 gives its slot back", async () => {
    const t = testApp();
    const v = await newVault(t);
    const real = t.stores.blobFiles.writeTemp;
    t.stores.blobFiles.writeTemp = () => Promise.reject(new Error("disk on fire"));
    try {
      expect((await uploadBlob(t, v, newBlobId(), "x")).status).toBe(500);
      expect((await uploadBlob(t, v, newBlobId(), "y")).status).toBe(500);
    } finally {
      t.stores.blobFiles.writeTemp = real;
    }
    const c = heldBlobUpload(t, v, newBlobId(), "cccccccccc");
    const d = heldBlobUpload(t, v, newBlobId(), "dddddddddd");
    await d.started(2);
    c.finish();
    d.finish();
    expect([(await c.response).status, (await d.response).status]).toEqual([201, 201]);
  });

  it("re-uploading an existing id is answered while two uploads run", async () => {
    const t = testApp();
    const v = await newVault(t);
    const id = newBlobId();
    await uploadBlob(t, v, id, "first");
    const a = heldBlobUpload(t, v, newBlobId(), "aaaaaaaaaa");
    const b = heldBlobUpload(t, v, newBlobId(), "bbbbbbbbbb");
    await b.started(2);
    const again = await uploadBlob(t, v, id, "first");
    expect([again.status, await again.json()]).toEqual([200, { created: false }]);
    a.finish();
    b.finish();
    await a.response;
    await b.response;
  });

  it("the gate's release is idempotent and the entry is dropped at zero", () => {
    const gate = createUploadGate(1);
    const release = gate.tryEnter("v")!;
    expect(gate.tryEnter("v")).toBeNull();
    release();
    release();
    const again = gate.tryEnter("v");
    expect(again).not.toBeNull();
    expect(gate.tryEnter("v")).toBeNull();
  });
});

describe("Content-Length and activity of an upload", () => {
  it.each(["1e3", "0x10", "+5", "5.0"])("Content-Length %j is 411 length_required", async (value) => {
    const t = testApp();
    const v = await newVault(t);
    const res = await t.call("PUT", blobUrl(v, newBlobId()), {
      headers: auth(v, { "content-length": value }),
      body: bytes(5) as BodyInit,
    });
    expect([res.status, await res.json()]).toEqual([411, { error: "length_required" }]);
  });

  it("an upload answered 200 created:false marks the vault's activity", async () => {
    const t = testApp();
    const v = await newVault(t);
    const id = newBlobId();
    await uploadBlob(t, v, id, "first");
    t.db.prepare("UPDATE vaults SET last_activity = 0 WHERE vault_id = ?").run(v.id);
    expect((await uploadBlob(t, v, id, "first")).status).toBe(200);
    const row = t.db.prepare("SELECT last_activity AS a FROM vaults WHERE vault_id = ?").get(v.id) as { a: number };
    expect(row.a).toBeGreaterThan(0);
  });
});
