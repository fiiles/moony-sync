// Housekeeping and deletion of blob files and records.

import { existsSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { startHousekeeping } from "../src/housekeeping.js";
import { ORPHAN_SNAPSHOT_AGE_SECONDS } from "../src/limits.js";
import { createVaults } from "../src/vaults.js";
import {
  auth,
  blobFiles,
  newBlobId,
  newVault,
  newVaultId,
  setupAdmin,
  testApp,
  uploadBlob,
  type TestApp,
} from "./helpers.js";

const rows = (t: TestApp): number => (t.db.prepare("SELECT COUNT(*) AS n FROM blobs").get() as { n: number }).n;
const pending = (t: TestApp): number =>
  (t.db.prepare("SELECT COUNT(*) AS n FROM pending_wipes").get() as { n: number }).n;
const blobDir = (t: TestApp, id: string): string => join(t.dataDir, "blobs", id);

/** Writes a file into a blob directory and dates its mtime. */
function plant(dir: string, name: string, mtime: number): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), "x");
  utimesSync(join(dir, name), mtime, mtime);
}

describe("housekeep", () => {
  it("removes blob files without a record once they are an hour old, and only those", async () => {
    const t = testApp();
    const real = Math.floor(Date.now() / 1000); // file mtimes are real file-system time
    t.clock.now = real;
    const v = await newVault(t);
    const kept = newBlobId();
    expect((await uploadBlob(t, v, kept, "recorded")).status).toBe(201);
    const oldOrphan = newBlobId();
    const freshOrphan = newBlobId();
    plant(blobDir(t, v.id), oldOrphan, real - ORPHAN_SNAPSHOT_AGE_SECONDS - 10);
    plant(blobDir(t, v.id), freshOrphan, real);
    plant(blobDir(t, v.id), "notes.txt", real - ORPHAN_SNAPSHOT_AGE_SECONDS - 10);

    t.stores.blobs.housekeep(v.id);

    expect(blobFiles(t, v)).toEqual([kept, freshOrphan, "notes.txt"].sort());
    expect(rows(t)).toBe(1);
  });

  it("drops a record whose file is gone, so the blob can be uploaded again", async () => {
    const t = testApp();
    const v = await newVault(t);
    const id = newBlobId();
    expect((await uploadBlob(t, v, id, "content")).status).toBe(201);
    rmSync(join(blobDir(t, v.id), id));

    t.stores.blobs.housekeep(v.id);

    expect(rows(t)).toBe(0);
    const list = await t.call("GET", `/v1/vaults/${v.id}/blobs`, { headers: auth(v) });
    expect((await list.json()).blobs).toEqual([]);
    const again = await uploadBlob(t, v, id, "content");
    expect([again.status, await again.json()]).toEqual([201, { created: true }]);
  });

  it("does nothing for a vault without a record", () => {
    const t = testApp();
    const real = Math.floor(Date.now() / 1000);
    t.clock.now = real;
    const ghost = newVaultId();
    const orphan = newBlobId();
    plant(blobDir(t, ghost), orphan, real - ORPHAN_SNAPSHOT_AGE_SECONDS - 10);
    t.stores.blobs.housekeep(ghost);
    expect(existsSync(join(blobDir(t, ghost), orphan))).toBe(true);
  });
});

describe("sweep", () => {
  it("removes old blob directories of unknown vaults, keeps fresh ones", () => {
    const t = testApp();
    const real = Math.floor(Date.now() / 1000);
    t.clock.now = real;
    const old = newVaultId();
    const fresh = newVaultId();
    mkdirSync(blobDir(t, old), { recursive: true });
    mkdirSync(blobDir(t, fresh), { recursive: true });
    const past = real - ORPHAN_SNAPSHOT_AGE_SECONDS - 10;
    utimesSync(blobDir(t, old), past, past);

    t.stores.blobs.sweep();

    expect(existsSync(blobDir(t, old))).toBe(false);
    expect(existsSync(blobDir(t, fresh))).toBe(true);
  });

  it("leaves the directory of a pending wipe to the vault sweep", () => {
    const t = testApp();
    const real = Math.floor(Date.now() / 1000);
    t.clock.now = real;
    const id = newVaultId();
    mkdirSync(blobDir(t, id), { recursive: true });
    const past = real - ORPHAN_SNAPSHOT_AGE_SECONDS - 10;
    utimesSync(blobDir(t, id), past, past);
    t.db.prepare("INSERT INTO pending_wipes (vault_id) VALUES (?)").run(id);
    t.stores.blobs.sweep();
    expect(existsSync(blobDir(t, id))).toBe(true);
  });
});

describe("startHousekeeping", () => {
  it("runOnce() runs both", async () => {
    const t = testApp();
    const real = Math.floor(Date.now() / 1000);
    t.clock.now = real;
    const v = await newVault(t);
    const orphan = newBlobId();
    const past = real - ORPHAN_SNAPSHOT_AGE_SECONDS - 10;
    plant(blobDir(t, v.id), orphan, past);
    const ghost = newVaultId();
    mkdirSync(blobDir(t, ghost), { recursive: true });
    utimesSync(blobDir(t, ghost), past, past);

    const hk = startHousekeeping({ log: () => {} }, t.stores);
    hk.stop();

    expect(existsSync(join(blobDir(t, v.id), orphan))).toBe(false);
    expect(existsSync(blobDir(t, ghost))).toBe(false);
  });
});

describe("deletion", () => {
  it("deleting a vault removes its blob files", async () => {
    const t = testApp();
    const v = await newVault(t);
    expect((await uploadBlob(t, v, newBlobId(), "content")).status).toBe(201);
    const r = await t.call("DELETE", `/v1/vaults/${v.id}`, { headers: auth(v) });
    expect(r.status).toBe(204);
    expect(existsSync(blobDir(t, v.id))).toBe(false);
    expect(rows(t)).toBe(0);
  });

  it("deleting a person (admin) removes every profile's blob files", async () => {
    const t = testApp();
    const s = await setupAdmin(t);
    expect((await s.call("PUT", "settings", { publicUrl: "https://sync.example" })).status).toBe(200);
    const made = (await (await s.call("POST", "people", { name: "Anna" })).json()) as { person: { id: string } };
    const account = t.stores.people.get(made.person.id)!.account;
    const a = await newVault(t, account);
    const b = await newVault(t, account);
    const other = await newVault(t);
    for (const v of [a, b, other]) expect((await uploadBlob(t, v, newBlobId(), "content")).status).toBe(201);

    expect((await s.call("DELETE", `people/${made.person.id}`)).status).toBe(204);

    expect(existsSync(blobDir(t, a.id))).toBe(false);
    expect(existsSync(blobDir(t, b.id))).toBe(false);
    expect(blobFiles(t, other)).toHaveLength(1);
    expect(rows(t)).toBe(1);
  });

  it("deleting one profile (admin) removes its blob files and leaves the other's", async () => {
    const t = testApp();
    const s = await setupAdmin(t);
    expect((await s.call("PUT", "settings", { publicUrl: "https://sync.example" })).status).toBe(200);
    const made = (await (await s.call("POST", "people", { name: "Anna" })).json()) as { person: { id: string } };
    const account = t.stores.people.get(made.person.id)!.account;
    const a = await newVault(t, account);
    const b = await newVault(t, account);
    for (const v of [a, b]) expect((await uploadBlob(t, v, newBlobId(), "content")).status).toBe(201);

    expect((await s.call("DELETE", `people/${made.person.id}/vaults/${a.id}`)).status).toBe(204);

    expect(existsSync(blobDir(t, a.id))).toBe(false);
    expect(blobFiles(t, b)).toHaveLength(1);
  });

  it("a wipe whose blob directory removal fails stays pending and finishes on the next housekeep", async () => {
    const t = testApp();
    const v = await newVault(t);
    expect((await uploadBlob(t, v, newBlobId(), "content")).status).toBe(201);
    let left = 1;
    const real = t.stores.blobFiles;
    const flaky = createVaults(t.db, () => t.clock.now, t.stores.people, t.stores.snapshots, {
      ...real,
      removeVault(id) {
        if (left-- > 0) throw new Error("disk unavailable");
        real.removeVault(id);
      },
    });

    expect((await flaky.destroy(v.id, v.token)).ok).toBe(true);
    expect(pending(t)).toBe(1);
    expect(existsSync(blobDir(t, v.id))).toBe(true);

    t.stores.vaults.housekeep(v.id);
    expect(existsSync(blobDir(t, v.id))).toBe(false);
    expect(pending(t)).toBe(0);
  });
});
