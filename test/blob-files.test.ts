import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createBlobFiles } from "../src/blob-files.js";
import { isBlobId } from "../src/encoding.js";
import { BodyStreamError } from "../src/files.js";
import { MAX_BLOB_BYTES } from "../src/limits.js";
import { blobFiles, newBlobId, newVault, newVaultId, stream, testApp } from "./helpers.js";
import { randomUUID } from "node:crypto";

const bytes = (n: number): Uint8Array => new Uint8Array(n).fill(7);

describe("blob limits and ids", () => {
  it("MAX_BLOB_BYTES is 100 MiB sealed by the app's stream", () =>
    expect(MAX_BLOB_BYTES).toBe(104_883_275));
  it("isBlobId takes only the canonical lowercase UUID", () => {
    expect(isBlobId("0f8fad5b-d9cb-469f-a165-70867728950e")).toBe(true);
    for (const bad of [
      "0F8FAD5B-D9CB-469F-A165-70867728950E",
      "0f8fad5bd9cb469fa16570867728950e",
      "../x",
      "",
      "0f8fad5b-d9cb-469f-a165-70867728950e/",
      5,
    ])
      expect([bad, isBlobId(bad)]).toEqual([bad, false]);
  });
});

describe("blob files", () => {
  it("writeTemp + publish stores the bytes under the blob id, mode 0600, no temp left", async () => {
    const t = testApp();
    const vid = newVaultId();
    const id = newBlobId();
    const w = await t.stores.blobFiles.writeTemp(vid, id, stream(bytes(70_000)), 1e6);
    expect(blobFiles(t, { id: vid })).toEqual([(w as { tmp: string }).tmp]);
    t.stores.blobFiles.publish(vid, id, (w as { tmp: string }).tmp);
    expect(blobFiles(t, { id: vid })).toEqual([id]);
    expect(statSync(join(t.dataDir, "blobs", vid, id)).mode & 0o777).toBe(0o600);
    expect(t.stores.blobFiles.size(vid, id)).toBe(70_000);
  });

  it("writeTemp past maxBytes is too_large and leaves nothing", async () => {
    const t = testApp();
    const vid = newVaultId();
    const w = await t.stores.blobFiles.writeTemp(vid, newBlobId(), stream(bytes(40)), 39);
    expect(w).toBe("too_large");
    expect(blobFiles(t, { id: vid })).toEqual([]);
  });

  it("a body stream error rethrows BodyStreamError and leaves nothing", async () => {
    const t = testApp();
    const vid = newVaultId();
    let sent = false;
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        if (!sent) {
          sent = true;
          c.enqueue(bytes(10));
        } else c.error(new Error("client gone"));
      },
    });
    await expect(t.stores.blobFiles.writeTemp(vid, newBlobId(), body, 1e6)).rejects.toBeInstanceOf(
      BodyStreamError,
    );
    expect(blobFiles(t, { id: vid })).toEqual([]);
  });

  it("an idle body throws BodyIdleError and leaves nothing", async () => {
    const t = testApp();
    const vid = newVaultId();
    const body = new ReadableStream<Uint8Array>({ pull: () => new Promise(() => undefined) });
    await expect(t.stores.blobFiles.writeTemp(vid, newBlobId(), body, 1e6, 20)).rejects.toThrow(
      "body_idle",
    );
    expect(blobFiles(t, { id: vid })).toEqual([]);
  });

  it("open streams the stored bytes; remove deletes them", async () => {
    const t = testApp();
    const vid = newVaultId();
    const id = newBlobId();
    const w = (await t.stores.blobFiles.writeTemp(vid, id, stream(bytes(123)), 1e6)) as { tmp: string };
    t.stores.blobFiles.publish(vid, id, w.tmp);
    const o = t.stores.blobFiles.open(vid, id)!;
    expect(o.size).toBe(123);
    expect((await new Response(o.stream).arrayBuffer()).byteLength).toBe(123);
    t.stores.blobFiles.remove(vid, id);
    expect(t.stores.blobFiles.open(vid, id)).toBeNull();
    expect(t.stores.blobFiles.size(vid, id)).toBeNull();
  });

  it("never touches the disk for malformed ids", () => {
    const t = testApp();
    const f = createBlobFiles(join(t.dataDir, "blobs"));
    expect(f.open(newVaultId(), "../../moony-sync.db")).toBeNull();
    expect(f.open("../x", newBlobId())).toBeNull();
    expect(() => f.publish(newVaultId(), "../evil", "x.tmp")).toThrow("invalid_id");
    expect(existsSync(join(t.dataDir, "blobs"))).toBe(false);
  });

  it("sweepTemp removes *.tmp only; listFiles lists blob ids only", async () => {
    const t = testApp();
    const vid = newVaultId();
    const id = newBlobId();
    const dir = join(t.dataDir, "blobs", vid);
    mkdirSync(dir, { recursive: true });
    const tmp = `${randomUUID()}.${randomUUID()}.tmp`;
    writeFileSync(join(dir, tmp), "x");
    writeFileSync(join(dir, id), "y");
    writeFileSync(join(dir, "notes.txt"), "z");
    expect(t.stores.blobFiles.listFiles(vid).map((f) => f.blobId)).toEqual([id]);
    t.stores.blobFiles.sweepTemp();
    expect(blobFiles(t, { id: vid })).toEqual([id, "notes.txt"].sort());
    expect(t.stores.blobFiles.listVaultDirs().map((d) => d.vaultId)).toEqual([vid]);
  });

  it("a vault wipe removes its blob directory", async () => {
    const t = testApp();
    const v = await newVault(t);
    const id = newBlobId();
    const w = (await t.stores.blobFiles.writeTemp(v.id, id, stream(bytes(5)), 100)) as { tmp: string };
    t.stores.blobFiles.publish(v.id, id, w.tmp);
    t.stores.vaults.wipe(v.id);
    expect(existsSync(join(t.dataDir, "blobs", v.id))).toBe(false);
    expect((t.db.prepare("SELECT COUNT(*) AS n FROM pending_wipes").get() as { n: number }).n).toBe(0);
  });

  it("a leftover blob .tmp is gone when the app starts", () => {
    const vid = newVaultId();
    const t = testApp({}, (dir) => {
      const d = join(dir, "blobs", vid);
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, `${randomUUID()}.${randomUUID()}.tmp`), "x");
    });
    expect(blobFiles(t, { id: vid })).toEqual([]);
  });

  it("migration 6 creates blob records that cascade with the vault", async () => {
    const t = testApp();
    const v = await newVault(t);
    t.db.prepare("INSERT INTO blobs (vault_id, blob_id, size, created_at) VALUES (?, ?, 1, 1)").run(v.id, newBlobId());
    t.stores.vaults.wipe(v.id);
    expect((t.db.prepare("SELECT COUNT(*) AS n FROM blobs").get() as { n: number }).n).toBe(0);
  });
});
