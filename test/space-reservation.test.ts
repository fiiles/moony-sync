// Uploads in progress count against the free-space floor, blob and snapshot uploads together.

import { describe, expect, it, vi } from "vitest";
import { FREE_SPACE_FLOOR_BYTES } from "../src/limits.js";
import { auth, heldBlobUpload, newBlobId, newVault, testApp, uploadBlob, uploadSnapshot, type TestApp, type Vault } from "./helpers.js";

const FLOOR = FREE_SPACE_FLOOR_BYTES;
const fill = (n: number): Uint8Array => new Uint8Array(n).fill(7);

/** A snapshot upload the test ends by hand; `started` resolves once the server read its first bytes. */
function heldSnapshotUpload(t: TestApp, v: Vault, seq: number, size: number) {
  let ctl!: ReadableStreamDefaultController<Uint8Array>;
  let reading!: () => void;
  const read = new Promise<void>((r) => (reading = r));
  let pulls = 0;
  const body = new ReadableStream<Uint8Array>(
    {
      start(c) {
        ctl = c;
      },
      pull(c) {
        pulls += 1;
        if (pulls === 1) c.enqueue(fill(2));
        else reading();
        return pulls === 1 ? undefined : new Promise(() => {});
      },
    },
    { highWaterMark: 0 },
  );
  const response = t.call("PUT", `/v1/vaults/${v.id}/snapshot?seq=${seq}`, {
    headers: auth(v, { "content-length": String(size) }),
    body,
    duplex: "half",
  } as RequestInit);
  return {
    response,
    started: () => read,
    finish() {
      ctl.enqueue(fill(size - 2));
      ctl.close();
    },
  };
}

const status = async (r: Promise<Response>): Promise<[number, unknown]> => {
  const res = await r;
  return [res.status, await res.json()];
};

describe("free-space floor counts uploads in progress", () => {
  it("a second blob upload that would cross the floor together with a held one is 507; it fits after the first ends", async () => {
    const t = testApp();
    const v = await newVault(t);
    t.disk.free = FLOOR + 150;
    const a = heldBlobUpload(t, v, newBlobId(), fill(100));
    await a.started();
    expect(await status(uploadBlob(t, v, newBlobId(), fill(100)))).toEqual([507, { error: "server_full" }]);
    a.finish();
    expect((await a.response).status).toBe(201);
    expect((await uploadBlob(t, v, newBlobId(), fill(100))).status).toBe(201);
  });

  it("a snapshot upload and a blob upload reserve against the same counter", async () => {
    const t = testApp();
    const v = await newVault(t);
    t.disk.free = FLOOR + 150;
    const blob = heldBlobUpload(t, v, newBlobId(), fill(100));
    await blob.started();
    expect(await status(uploadSnapshot(t, v, 0, "x".repeat(100)))).toEqual([507, { error: "server_full" }]);
    blob.finish();
    expect((await blob.response).status).toBe(201);

    const snap = heldSnapshotUpload(t, v, 0, 100);
    await snap.started();
    expect(await status(uploadBlob(t, v, newBlobId(), fill(100)))).toEqual([507, { error: "server_full" }]);
    snap.finish();
    expect((await snap.response).status).toBe(201);
    expect((await uploadBlob(t, v, newBlobId(), fill(100))).status).toBe(201);
  });

  it("a failed upload (body ends early) and a refused one (429) release their reservation", async () => {
    const t = testApp();
    const v = await newVault(t);
    t.disk.free = FLOOR + 150;
    // Failed: declares 100, delivers 10.
    for (const send of [
      () => t.call("PUT", `/v1/vaults/${v.id}/blobs/${newBlobId()}`, {
        headers: auth(v, { "content-length": "100" }),
        body: fill(10) as BodyInit,
      }),
      () => t.call("PUT", `/v1/vaults/${v.id}/snapshot?seq=0`, {
        headers: auth(v, { "content-length": "100" }),
        body: fill(10) as BodyInit,
      }),
    ]) {
      expect((await send()).status).toBe(400);
    }
    expect((await uploadBlob(t, v, newBlobId(), fill(100))).status).toBe(201);

    // Refused after the reservation: the vault already has two uploads running.
    const a = heldBlobUpload(t, v, newBlobId(), fill(50));
    const b = heldBlobUpload(t, v, newBlobId(), fill(50));
    await b.started(2);
    expect(await status(uploadBlob(t, v, newBlobId(), fill(40)))).toEqual([429, { error: "too_many_uploads" }]);
    a.finish();
    expect((await a.response).status).toBe(201);
    // 50 held by b; had the refused 40 leaked, only 60 would be left here.
    expect((await uploadBlob(t, v, newBlobId(), fill(100))).status).toBe(201);
    b.finish();
    expect((await b.response).status).toBe(201);
  });

  it("an upload whose file store throws releases its reservation", async () => {
    const t = testApp();
    const v = await newVault(t);
    t.disk.free = FLOOR + 150;
    const real = t.stores.blobFiles.writeTemp;
    t.stores.blobFiles.writeTemp = () => Promise.reject(new Error("disk on fire"));
    try {
      expect((await uploadBlob(t, v, newBlobId(), fill(100))).status).toBe(500);
    } finally {
      t.stores.blobFiles.writeTemp = real;
    }
    expect((await uploadBlob(t, v, newBlobId(), fill(100))).status).toBe(201);
  });
});

describe("a failing blob route answers with the header", () => {
  it("a disk error on a blob upload is 500 internal_error with Moony-Error, and logs no ids", async () => {
    const t = testApp();
    const v = await newVault(t);
    const id = newBlobId();
    t.stores.blobFiles.writeTemp = () => Promise.reject(new Error(`boom ${v.id} ${v.token}`));
    const res = await uploadBlob(t, v, id, "x");
    expect([res.status, await res.json()]).toEqual([500, { error: "internal_error" }]);
    expect(res.headers.get("moony-error")).toBe("internal_error");
    const log = t.logs.join("\n");
    expect(log).toContain("unhandled error");
    expect(log).not.toContain(v.id);
    expect(log).not.toContain(v.token);
    expect(log).not.toContain(id);
    vi.restoreAllMocks();
  });
});
