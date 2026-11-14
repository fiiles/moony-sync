// Vault housekeeping, deletion, races, and the snapshot-file cases (SQLite rows + files).

import { mkdirSync, utimesSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { DAY, OP_OVERHEAD_BYTES, ORPHAN_SNAPSHOT_AGE_SECONDS } from "../src/limits.js";
import { createSnapshots, type Snapshots } from "../src/snapshots.js";
import { createVaults } from "../src/vaults.js";
import {
  addPerson,
  auth,
  b64,
  newToken,
  newVault,
  newVaultId,
  pull,
  push,
  snapshotFiles,
  testApp,
  uploadSnapshot,
  type PullBody,
  type TestApp,
  type Vault,
} from "./helpers.js";

const ops = (prefix: string, n: number) =>
  Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i}`, ct: b64(`${prefix}-cipher-${i}`) }));

const VAULT_TABLES = ["vaults", "ops", "prev_tokens", "rekeys", "snapshots", "pending_wipes"];
const rowCount = (t: TestApp, table: string): number =>
  (t.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
const putVault = (t: TestApp, account: string, id: string, token = newToken()) =>
  t.call("PUT", `/v1/vaults/${id}`, {
    headers: { authorization: `Bearer ${token}`, "moony-account": account },
  });

/** A second vault store over the same database whose snapshot directory removal fails `n` times. */
function flakyVaults(t: TestApp, n: number) {
  let left = n;
  const real = t.stores.snapshots;
  const snapshots: Snapshots = {
    ...real,
    removeVault(id) {
      if (left-- > 0) throw new Error("disk unavailable");
      real.removeVault(id);
    },
  };
  return createVaults(t.db, () => t.clock.now, t.stores.people, snapshots, t.stores.blobFiles);
}

describe("housekeeping", () => {
  it("prunes old ops covered by a snapshot and sends stale devices to the snapshot", async () => {
    const t = testApp();
    const v = await newVault(t);
    await push(t, v, ops("o", 4));
    await uploadSnapshot(t, v, 3, "snap-3");
    await push(t, v, ops("n", 1));
    t.db.prepare("UPDATE ops SET created_at = ? WHERE vault_id = ?").run(t.clock.now - 40 * DAY, v.id);

    t.stores.vaults.housekeep(v.id);

    const gone = await pull(t, v, 0);
    expect(gone.status).toBe(410);
    expect(await gone.json()).toEqual({ error: "snapshot_required" });
    const fromSnapshot = (await (await pull(t, v, 3)).json()) as PullBody;
    expect(fromSnapshot.ops.map((o) => o.seq)).toEqual([4, 5]);

    const info = (await (
      await t.call("GET", `/v1/vaults/${v.id}`, { headers: auth(v) })
    ).json()) as { floor: number; head: number; snapshotSeq: number; bytes: number };
    expect(info).toMatchObject({ floor: 3, head: 5, snapshotSeq: 3 });
    expect(info.bytes).toBe(new TextEncoder().encode("o-cipher-3n-cipher-0").byteLength + 2 * OP_OVERHEAD_BYTES);
  });

  it("keeps recent ops even when a snapshot covers them", async () => {
    const t = testApp();
    const v = await newVault(t);
    await push(t, v, ops("k", 2));
    await uploadSnapshot(t, v, 2, "snap");
    t.stores.vaults.housekeep(v.id);
    expect(((await (await pull(t, v, 0)).json()) as PullBody).ops).toHaveLength(2);
  });

  it("never deletes a vault for a lapse: blocked for 400 days, housekeep, the vault is still there", async () => {
    // Replaces "deletes a vault 90 days after the subscription lapsed" (spec 5.4).
    const t = testApp();
    const v = await newVault(t);
    await push(t, v, ops("d", 1));
    await uploadSnapshot(t, v, 1, "snap");
    const person = t.stores.people.byAccount(v.account)!;
    t.stores.people.setState(person.id, "blocked");
    t.clock.now += 400 * DAY;

    t.stores.vaults.housekeep(v.id);

    expect(rowCount(t, "vaults")).toBe(1);
    expect(snapshotFiles(t, v)).toHaveLength(1);
    expect((await pull(t, v)).status).toBe(402); // lapsed read error, but the data is there
    t.stores.people.setState(person.id, "active");
    // Housekeeping did its normal pruning (the op is old and inside the snapshot), nothing more.
    expect((await pull(t, v, 0)).status).toBe(410);
    const back = await pull(t, v, 1);
    expect(back.status).toBe(200);
    expect(((await back.json()) as PullBody).head).toBe(1);
    expect((await t.call("GET", `/v1/vaults/${v.id}/snapshot`, { headers: auth(v) })).status).toBe(200);
  });

  it("removes snapshot files with no record once they are old enough, and only those", async () => {
    const t = testApp();
    const v = await newVault(t);
    await uploadSnapshot(t, v, 0, "recorded");
    const dir = join(t.dataDir, "snapshots", v.id);
    const old = join(dir, "0-00000000-0000-4000-8000-000000000001");
    const fresh = join(dir, "0-00000000-0000-4000-8000-000000000002");
    writeFileSync(old, "x");
    writeFileSync(fresh, "x");
    utimesSync(old, t.clock.now - ORPHAN_SNAPSHOT_AGE_SECONDS - 10, t.clock.now - ORPHAN_SNAPSHOT_AGE_SECONDS - 10);
    utimesSync(fresh, t.clock.now, t.clock.now);

    t.stores.vaults.housekeep(v.id);

    const left = snapshotFiles(t, v);
    expect(left).toHaveLength(2);
    expect(left).toContain("0-00000000-0000-4000-8000-000000000002");
    expect((await t.call("GET", `/v1/vaults/${v.id}/snapshot`, { headers: auth(v) })).status).toBe(200);
  });
});

describe("deletion", () => {
  it("wipes ops and snapshots even without a live subscription", async () => {
    const t = testApp();
    const v = await newVault(t);
    await push(t, v, ops("w", 2));
    await uploadSnapshot(t, v, 2, "snap");
    t.stores.people.setState(t.stores.people.byAccount(v.account)!.id, "blocked");
    t.clock.now += 60 * DAY;

    const res = await t.call("DELETE", `/v1/vaults/${v.id}`, { headers: auth(v) });
    expect(res.status).toBe(204);
    expect(snapshotFiles(t, v)).toEqual([]);
    expect((await pull(t, v)).status).toBe(404);
    for (const table of VAULT_TABLES) expect(rowCount(t, table)).toBe(0);
  });

  it("a wipe whose snapshot delete fails once finishes on the next housekeep and the account slot is free at once", async () => {
    // The account slot is the vault row itself, which is dropped in the same transaction as the
    // wipe starts.
    const t = testApp();
    const account = addPerson(t).account;
    const v = await newVault(t, account);
    for (let i = 0; i < 4; i++) await newVault(t, account); // the account is now full (5 vaults)
    await push(t, v, ops("w", 2));
    await uploadSnapshot(t, v, 2, "snap");

    const flaky = flakyVaults(t, 1);
    expect((await flaky.destroy(v.id, v.token)).ok).toBe(true);

    // Meanwhile the vault is gone for every caller, but its snapshot file is still on disk.
    expect((await pull(t, v)).status).toBe(404);
    expect(snapshotFiles(t, v)).toHaveLength(1);
    expect(rowCount(t, "pending_wipes")).toBe(1);
    expect((await putVault(t, account, newVaultId())).status).toBe(201); // slot is free

    t.stores.vaults.housekeep(v.id);
    expect(snapshotFiles(t, v)).toEqual([]);
    for (const table of VAULT_TABLES) expect(rowCount(t, table)).toBe(table === "vaults" ? 4 + 1 : 0);
  });

  it("retries a wipe that fails twice in a row, then finishes", async () => {
    const t = testApp();
    const v = await newVault(t);
    await uploadSnapshot(t, v, 0, "snap");
    const flaky = flakyVaults(t, 2);
    expect((await flaky.destroy(v.id, v.token)).ok).toBe(true);
    flaky.housekeep(v.id); // the second failure; housekeeping never throws into its loop
    expect(snapshotFiles(t, v)).toHaveLength(1);
    expect(rowCount(t, "pending_wipes")).toBe(1);
    flaky.housekeep(v.id); // third attempt succeeds
    expect(snapshotFiles(t, v)).toEqual([]);
    expect(rowCount(t, "pending_wipes")).toBe(0);
    expect(existsSync(join(t.dataDir, "snapshots", v.id))).toBe(false);
  });

  it("finishes pending wipes and sweeps old directories of unknown vaults in sweep()", async () => {
    // Replaces "resumes a wipe whose account unregister failed" (no separate account store now).
    const t = testApp();
    const v = await newVault(t);
    await uploadSnapshot(t, v, 0, "snap");
    const flaky = flakyVaults(t, 1);
    await flaky.destroy(v.id, v.token);
    expect(rowCount(t, "pending_wipes")).toBe(1);

    // A directory no record knows (a crash between rows and files, or a restored backup).
    const ghost = newVaultId();
    const ghostDir = join(t.dataDir, "snapshots", ghost);
    mkdirSync(ghostDir, { recursive: true });
    const ghostFile = join(ghostDir, "0-00000000-0000-4000-8000-000000000003");
    writeFileSync(ghostFile, "x");
    const old = t.clock.now - ORPHAN_SNAPSHOT_AGE_SECONDS - 10;
    utimesSync(ghostFile, old, old);
    const fresh = newVaultId();
    mkdirSync(join(t.dataDir, "snapshots", fresh), { recursive: true });
    writeFileSync(join(t.dataDir, "snapshots", fresh, "0-00000000-0000-4000-8000-000000000004"), "x");
    utimesSync(join(t.dataDir, "snapshots", fresh, "0-00000000-0000-4000-8000-000000000004"), t.clock.now, t.clock.now);

    t.stores.vaults.sweep();

    expect(rowCount(t, "pending_wipes")).toBe(0);
    expect(snapshotFiles(t, v)).toEqual([]);
    expect(snapshotFiles(t, { id: ghost })).toEqual([]);
    expect(snapshotFiles(t, { id: fresh })).toHaveLength(1);
  });

  it("sweep() removes an empty vault directory left by a destroy that raced an upload, once it is an hour old", () => {
    const t = testApp();
    const real = Math.floor(Date.now() / 1000); // directory mtimes are real file-system time
    t.clock.now = real;
    const ghost = newVaultId();
    const dir = join(t.dataDir, "snapshots", ghost);
    mkdirSync(dir, { recursive: true });
    t.stores.vaults.sweep();
    expect(existsSync(dir)).toBe(true); // fresh: an upload could still be about to write into it
    const old = real - ORPHAN_SNAPSHOT_AGE_SECONDS - 10;
    utimesSync(dir, old, old);
    t.stores.vaults.sweep();
    expect(existsSync(dir)).toBe(false);
  });

  it("an old snapshot file with no record inside a live vault is removed by housekeep(), not by sweep()", async () => {
    const t = testApp();
    const v = await newVault(t);
    const orphan = join(t.dataDir, "snapshots", v.id, "7-00000000-0000-4000-8000-000000000009");
    mkdirSync(join(t.dataDir, "snapshots", v.id), { recursive: true });
    writeFileSync(orphan, "x");
    const real = Math.floor(Date.now() / 1000);
    t.clock.now = real;
    utimesSync(orphan, real - ORPHAN_SNAPSHOT_AGE_SECONDS - 10, real - ORPHAN_SNAPSHOT_AGE_SECONDS - 10);
    utimesSync(join(t.dataDir, "snapshots", v.id), real, real);
    t.stores.vaults.sweep();
    expect(existsSync(orphan)).toBe(true); // sweep() only looks at vaults without a record
    t.stores.vaults.housekeep(v.id);
    expect(existsSync(orphan)).toBe(false);
  });

  it("sweep() ignores a plain file with a vault-ID-like name in the snapshots directory", () => {
    const t = testApp();
    mkdirSync(join(t.dataDir, "snapshots"), { recursive: true });
    const odd = join(t.dataDir, "snapshots", newVaultId());
    writeFileSync(odd, "not a directory");
    expect(() => t.stores.vaults.sweep()).not.toThrow();
    expect(existsSync(odd)).toBe(true);
  });

  it("wipes at once when the admin asks (wipe)", async () => {
    const t = testApp();
    const v = await newVault(t);
    await push(t, v, ops("a", 1));
    await uploadSnapshot(t, v, 1, "snap");
    t.stores.vaults.wipe(v.id);
    expect((await pull(t, v)).status).toBe(404);
    expect(snapshotFiles(t, v)).toEqual([]);
    for (const table of VAULT_TABLES) expect(rowCount(t, table)).toBe(0);
  });

  it("refuses to re-create a vault while its wipe is pending", async () => {
    const t = testApp();
    const account = addPerson(t).account;
    const v = await newVault(t, account);
    await uploadSnapshot(t, v, 0, "snap");
    await flakyVaults(t, 1).destroy(v.id, v.token);
    const again = await putVault(t, account, v.id, v.token);
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({ error: "vault_deleting" });
    expect(rowCount(t, "vaults")).toBe(0);
    t.stores.vaults.housekeep(v.id);
    expect(rowCount(t, "pending_wipes")).toBe(0);
    expect((await putVault(t, account, v.id, v.token)).status).toBe(201);
  });

  it("stores nothing for requests to vaults that do not exist", async () => {
    const t = testApp();
    const ghost = { account: "", id: newVaultId(), token: newToken() };
    expect((await pull(t, ghost)).status).toBe(404);
    for (const table of VAULT_TABLES) expect(rowCount(t, table)).toBe(0);
    expect(existsSync(join(t.dataDir, "snapshots", ghost.id))).toBe(false);
  });
});

describe("races", () => {
  it("lets only one account claim a new vault ID", async () => {
    const t = testApp();
    const [a, b] = [addPerson(t, "A").account, addPerson(t, "B").account];
    const id = newVaultId();
    const statuses = (await Promise.all([putVault(t, a, id), putVault(t, b, id)]))
      .map((r) => r.status)
      .sort();
    expect(statuses).toEqual([201, 409]);
    const counts = await Promise.all(
      [a, b].map(async (acc) => {
        const res = await t.call("GET", "/v1/accounts/me", { headers: { "moony-account": acc } });
        return ((await res.json()) as { vaults: number }).vaults;
      }),
    );
    expect(counts.sort()).toEqual([0, 1]);
  });
});

describe("last activity", () => {
  it("is set on every authorised call, rounded down to the minute", async () => {
    const t = testApp();
    const v = await newVault(t);
    const list = () => t.stores.vaults.listByAccount(v.account);
    const minute = (s: number) => Math.floor(s / 60) * 60;
    expect(list()).toEqual([{ vaultId: v.id, bytes: 0, lastActivity: minute(t.clock.now) }]);
    t.clock.now += 3 * 60 + 17;
    // A refused call changes nothing.
    await pull(t, { ...v, token: newToken() });
    expect(list()[0]!.lastActivity).toBe(minute(t.clock.now - 3 * 60 - 17));
    await pull(t, v);
    expect(list()[0]!.lastActivity).toBe(minute(t.clock.now));
    await push(t, v, ops("l", 2));
    expect(list()[0]!.bytes).toBe(2 * ("l-cipher-0".length + OP_OVERHEAD_BYTES));
  });
});

/** An upload whose body the test finishes by hand, so something can happen between the start
 *  of the stream (authorisation done, file open) and the record. */
function heldUpload(t: TestApp, v: Vault, seq: number, content: string) {
  const bytes = new TextEncoder().encode(content);
  let ctl!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      ctl = c;
      c.enqueue(bytes.subarray(0, 2));
    },
  });
  const response = t.call("PUT", `/v1/vaults/${v.id}/snapshot?seq=${seq}`, {
    headers: auth(v, { "content-length": String(bytes.byteLength) }),
    body,
    duplex: "half",
  } as RequestInit);
  return {
    response,
    started: () => vi.waitFor(() => expect(snapshotFiles(t, v).some((f) => f.endsWith(".tmp"))).toBe(true)),
    finish() {
      ctl.enqueue(bytes.subarray(2));
      ctl.close();
    },
  };
}

describe("snapshot files (review focus 1)", () => {
  it("recordSnapshot failing leaves no file", async () => {
    const t = testApp();
    const v = await newVault(t);
    const up = heldUpload(t, v, 0, "snapshot-body");
    await up.started();
    // The token is rotated away while the body is still streaming: the record is refused.
    const next = newToken();
    const rot = await t.call("POST", `/v1/vaults/${v.id}/token`, {
      headers: auth(v, { "content-type": "application/json" }),
      body: JSON.stringify({ token: next, rekey: b64("bundle") }),
    });
    expect(rot.status).toBe(200);
    up.finish();
    const res = await up.response;
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "token_read_only" });
    expect(snapshotFiles(t, v)).toEqual([]);
    expect(rowCount(t, "snapshots")).toBe(0);
  });

  it("a stale record (a newer snapshot landed meanwhile) answers 409 and leaves no file", async () => {
    const t = testApp();
    const v = await newVault(t);
    await push(t, v, ops("s", 5));
    const up = heldUpload(t, v, 3, "older-snapshot");
    await up.started();
    expect((await uploadSnapshot(t, v, 5, "newer")).status).toBe(201);
    up.finish();
    const res = await up.response;
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "snapshot_outdated" });
    expect(snapshotFiles(t, v)).toHaveLength(1);
    expect(snapshotFiles(t, v)[0]!.startsWith("5-")).toBe(true);
  });

  it("a destroy racing the upload answers 404 vault_not_found and leaves no file", async () => {
    const t = testApp();
    const v = await newVault(t);
    const up = heldUpload(t, v, 0, "snapshot-body");
    await up.started();
    expect((await t.call("DELETE", `/v1/vaults/${v.id}`, { headers: auth(v) })).status).toBe(204);
    up.finish();
    const res = await up.response;
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "vault_not_found" });
    expect(snapshotFiles(t, v)).toEqual([]);
    expect(rowCount(t, "snapshots")).toBe(0);
  });

  it("a client stream error mid-upload is 400 incomplete_body and leaves no file", async () => {
    const t = testApp();
    const v = await newVault(t);
    let ctl!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        ctl = c;
        c.enqueue(new Uint8Array(2));
      },
    });
    const response = t.call("PUT", `/v1/vaults/${v.id}/snapshot?seq=0`, {
      headers: auth(v, { "content-length": "10" }),
      body,
      duplex: "half",
    } as RequestInit);
    await vi.waitFor(() => expect(snapshotFiles(t, v).some((f) => f.endsWith(".tmp"))).toBe(true));
    ctl.error(new Error("client reset"));
    const res = await response;
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "incomplete_body" });
    expect(snapshotFiles(t, v)).toEqual([]);
  });

  it("a disk error while writing is 500 internal_error, not a client error", async () => {
    const t = testApp();
    const v = await newVault(t);
    const real = t.stores.snapshots.write;
    t.stores.snapshots.write = async () => {
      throw Object.assign(new Error("no space"), { code: "ENOSPC" });
    };
    const res = await uploadSnapshot(t, v, 0, "snap");
    t.stores.snapshots.write = real;
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "internal_error" });
    expect(rowCount(t, "snapshots")).toBe(0);
  });

  it("a leftover .tmp file is gone after sweepTemp()", () => {
    const t = testApp();
    const id = newVaultId();
    const dir = join(t.dataDir, "snapshots", id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "4-00000000-0000-4000-8000-000000000005.tmp"), "half");
    writeFileSync(join(dir, "4-00000000-0000-4000-8000-000000000006"), "whole");
    t.stores.snapshots.sweepTemp();
    expect(snapshotFiles(t, { id })).toEqual(["4-00000000-0000-4000-8000-000000000006"]);
  });

  it("sweeps leftover .tmp files when the app starts", () => {
    const id = newVaultId();
    const t = testApp({}, (dataDir) => {
      const dir = join(dataDir, "snapshots", id);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "1-00000000-0000-4000-8000-000000000007.tmp"), "half");
    });
    expect(snapshotFiles(t, { id })).toEqual([]);
  });

  it("a body longer than Content-Length is 413 and leaves no file", async () => {
    const t = testApp();
    const v = await newVault(t);
    const res = await t.call("PUT", `/v1/vaults/${v.id}/snapshot?seq=0`, {
      headers: auth(v, { "content-length": "5" }),
      body: "0123456789",
    });
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "snapshot_too_large" });
    expect(snapshotFiles(t, v)).toEqual([]);
    expect(rowCount(t, "snapshots")).toBe(0);
  });

  it("a body shorter than Content-Length is refused and leaves no file", async () => {
    const t = testApp();
    const v = await newVault(t);
    const res = await t.call("PUT", `/v1/vaults/${v.id}/snapshot?seq=0`, {
      headers: auth(v, { "content-length": "50" }),
      body: "0123456789",
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "incomplete_body" });
    expect(snapshotFiles(t, v)).toEqual([]);
  });

  it("Snapshots.write stops at maxBytes: too_large, nothing left behind", async () => {
    const t = testApp();
    const id = newVaultId();
    const body = () =>
      new ReadableStream<Uint8Array>({
        start(c) {
          for (let i = 0; i < 4; i++) c.enqueue(new Uint8Array(10));
          c.close();
        },
      });
    expect(await t.stores.snapshots.write(id, 0, body(), 39)).toBe("too_large");
    expect(snapshotFiles(t, { id })).toEqual([]);
    const ok = await t.stores.snapshots.write(id, 0, body(), 40);
    expect(ok).toMatchObject({ size: 40 });
    expect(snapshotFiles(t, { id })).toEqual([(ok as { file: string }).file]);
  });

  it("only serves a real, well-named file of that vault", () => {
    const t = testApp();
    expect(t.stores.snapshots.open(newVaultId(), "../../moony-sync.db")).toBeNull();
    expect(t.stores.snapshots.open("../x", "0-00000000-0000-4000-8000-000000000008")).toBeNull();
    expect(t.stores.snapshots.open(newVaultId(), "0-00000000-0000-4000-8000-000000000008")).toBeNull();
  });
});
