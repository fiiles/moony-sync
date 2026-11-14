import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { startHousekeeping } from "../src/housekeeping.js";
import { DAY, ORPHAN_SNAPSHOT_AGE_SECONDS } from "../src/limits.js";
import {
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
  type Vault,
} from "./helpers.js";

const count = (t: ReturnType<typeof testApp>, sql: string): number =>
  (t.db.prepare(sql).get() as { n: number }).n;

const rotate = (t: ReturnType<typeof testApp>, v: Vault, next: string) =>
  t.call("POST", `/v1/vaults/${v.id}/token`, {
    headers: auth(v, { "content-type": "application/json" }),
    body: JSON.stringify({ token: next, rekey: b64("bundle") }),
  });

describe("startHousekeeping", () => {
  it("runOnce burns expired mailboxes, drops tombstones, forgets old tokens and bundles, prunes ops, removes orphan files", async () => {
    const t = testApp();
    const hk = startHousekeeping({ log: () => {} }, t.stores);

    // Mailboxes: one past its TTL, one tombstone past its day.
    const open = newVaultId();
    const tomb = newVaultId();
    await t.call("PUT", `/v1/pairing/${open}/1`, { body: new Uint8Array([1]) });
    await t.call("PUT", `/v1/pairing/${tomb}/1`, { body: new Uint8Array([1]) });
    await t.call("DELETE", `/v1/pairing/${tomb}`);

    // Vault: a rotation (previous token + bundle), covered old ops, an orphan file.
    const v = await newVault(t);
    const next = newToken();
    expect((await rotate(t, v, next)).status).toBe(200);
    const v2 = { ...v, token: next };
    await push(t, v2, [{ id: "00000000-0000-4000-8000-0000000000a1", ct: b64("ct") }]);
    await uploadSnapshot(t, v2, 1, "snap");
    const dir = join(t.dataDir, "snapshots", v.id);
    const orphan = join(dir, "0-00000000-0000-4000-8000-000000000001");
    writeFileSync(orphan, "x");
    t.clock.now += 40 * DAY;
    utimesSync(orphan, t.clock.now - ORPHAN_SNAPSHOT_AGE_SECONDS - 10, t.clock.now - ORPHAN_SNAPSHOT_AGE_SECONDS - 10);
    // A directory nobody owns.
    const ghost = newVaultId();
    mkdirSync(join(t.dataDir, "snapshots", ghost));
    const ghostFile = join(t.dataDir, "snapshots", ghost, "0-00000000-0000-4000-8000-000000000002");
    writeFileSync(ghostFile, "x");
    utimesSync(ghostFile, t.clock.now - 2 * 3600, t.clock.now - 2 * 3600);
    t.db.prepare("UPDATE ops SET created_at = ?").run(t.clock.now - 31 * DAY);

    hk.runOnce();
    hk.stop();

    expect(count(t, "SELECT COUNT(*) AS n FROM prev_tokens")).toBe(0);
    expect(count(t, "SELECT COUNT(*) AS n FROM rekeys")).toBe(0);
    expect(count(t, "SELECT COUNT(*) AS n FROM ops")).toBe(0);
    expect(snapshotFiles(t, v)).toHaveLength(1);
    expect(snapshotFiles(t, { id: ghost })).toEqual([]);
    expect(count(t, "SELECT COUNT(*) AS n FROM mailbox_slots")).toBe(0);
    expect(count(t, "SELECT COUNT(*) AS n FROM mailboxes")).toBe(0); // tombstone (a day old) gone too
  });

  it("an old token is 401 one second past 30 days without runOnce()", async () => {
    const t = testApp();
    const v = await newVault(t);
    const next = newToken();
    expect((await rotate(t, v, next)).status).toBe(200);
    t.clock.now += 30 * DAY - 1;
    expect((await pull(t, v)).status).toBe(200);
    t.clock.now += 2;
    expect((await pull(t, v)).status).toBe(401);
    expect((await pull(t, { ...v, token: next })).status).toBe(200);
  });

  it("survives an exception in one vault and logs without IDs", async () => {
    const t = testApp();
    const a = await newVault(t);
    const b = await newVault(t);
    const seen: string[] = [];
    const logs: string[] = [];
    const vaults = {
      ...t.stores.vaults,
      listIds: () => [a.id, b.id],
      housekeep(id: string) {
        seen.push(id);
        if (id === a.id) throw new Error(`boom ${id}`);
      },
    };
    const hk = startHousekeeping({ log: (l) => logs.push(l) }, { vaults, mailboxes: t.stores.mailboxes });
    hk.stop();
    seen.length = 0;
    logs.length = 0;
    hk.runOnce();
    expect(seen).toEqual([a.id, b.id]);
    expect(logs).toHaveLength(1);
    expect(logs[0]).not.toContain(a.id);
  });

  it("runs sweep() and once at start", async () => {
    const t = testApp();
    const sweep = vi.fn();
    const hk = startHousekeeping(
      { log: () => {} },
      { vaults: { ...t.stores.vaults, sweep }, mailboxes: t.stores.mailboxes },
    );
    expect(sweep).toHaveBeenCalledTimes(1);
    hk.runOnce();
    expect(sweep).toHaveBeenCalledTimes(2);
    hk.stop();
  });
});
