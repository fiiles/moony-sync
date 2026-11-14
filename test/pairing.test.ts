// Pairing mailboxes. Time rules are tested by moving the clock,
// each run with and without housekeeping in between: every time rule must also hold when
// housekeep() never ran. The per-IP limit test lives in ratelimit.test.ts.

import { describe, expect, it, vi } from "vitest";
import { startHousekeeping } from "../src/housekeeping.js";
import { DAY, MAILBOX_TOMBSTONE_SECONDS, MAILBOX_TTL_SECONDS, MAX_MAILBOX_SLOT_BYTES, MAX_MAILBOX_TOTAL_BYTES } from "../src/limits.js";
import { createHash } from "node:crypto";
import { createMailboxes } from "../src/mailboxes.js";
import { MAX_MAILBOX_CLIENT_BYTES } from "../src/limits.js";
import { newVaultId, testApp, type TestApp } from "./helpers.js";

const newMailbox = newVaultId; // same format: 22 chars base64url
const bytes = (...n: number[]) => new Uint8Array(n);

function setup() {
  const t = testApp();
  const put = (id: string, slot: string | number, body: BodyInit | null) =>
    t.call("PUT", `/v1/pairing/${id}/${slot}`, { body });
  const get = (id: string, slot: string | number) => t.call("GET", `/v1/pairing/${id}/${slot}`);
  const burn = (id: string) => t.call("DELETE", `/v1/pairing/${id}`);
  return { t, put, get, burn };
}

const count = (t: TestApp, table: string): number =>
  (t.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
const mailboxRows = (t: TestApp): number => count(t, "mailboxes") + count(t, "mailbox_slots");
const slotsOf = (t: TestApp, id: string): number =>
  (t.db.prepare("SELECT COUNT(*) AS n FROM mailbox_slots WHERE mailbox_id = ?").get(id) as { n: number }).n;
const slotBytes = (t: TestApp): number =>
  (t.db.prepare("SELECT COALESCE(SUM(LENGTH(data)), 0) AS n FROM mailbox_slots").get() as { n: number }).n;

describe("pairing mailbox: validation", () => {
  const { t, put, get, burn } = setup();

  it("rejects malformed mailbox IDs and slots", async () => {
    for (const bad of ["short", "x".repeat(23), "has space in it!!!!!!!"]) {
      const r = await put(bad, 1, bytes(1));
      expect(r.status).toBe(400);
      expect(await r.json()).toEqual({ error: "bad_mailbox" });
    }
    expect(await (await get("short", 1)).json()).toEqual({ error: "bad_mailbox" });
    expect(await (await burn("short")).json()).toEqual({ error: "bad_mailbox" });

    for (const slot of ["0", "4", "x", "01"]) {
      const r = await put(newMailbox(), slot, bytes(1));
      expect(r.status).toBe(400);
      expect(await r.json()).toEqual({ error: "bad_slot" });
    }
    expect(await (await get(newMailbox(), "4")).json()).toEqual({ error: "bad_slot" });
  });

  it("takes 1 byte to 64 KiB", async () => {
    const id = newMailbox();
    const empty = await put(id, 1, bytes());
    expect(empty.status).toBe(400);
    expect(await empty.json()).toEqual({ error: "empty_body" });

    const big = await put(id, 1, new Uint8Array(MAX_MAILBOX_SLOT_BYTES + 1));
    expect(big.status).toBe(413);
    expect(await big.json()).toEqual({ error: "body_too_large" });
    expect(mailboxRows(t)).toBe(0); // refused writes store nothing

    expect((await put(id, 1, new Uint8Array(MAX_MAILBOX_SLOT_BYTES))).status).toBe(204);
    expect((await put(id, 2, bytes(7))).status).toBe(204);
  });

  it("refuses a chunked body over 64 KiB that has no Content-Length", async () => {
    const t2 = testApp();
    const id = newMailbox();
    const chunk = new Uint8Array(16 * 1024);
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        if (sent >= 6) return c.close();
        sent++;
        c.enqueue(chunk);
      },
    });
    const r = await t2.call("PUT", `/v1/pairing/${id}/1`, {
      body: stream,
      // @ts-expect-error Node streaming request bodies
      duplex: "half",
    });
    expect(r.status).toBe(413);
    expect(mailboxRows(t2)).toBe(0);
  });
});

describe("pairing mailbox: slots", () => {
  const { t, put, get, burn } = setup();

  it("hands the bytes over once", async () => {
    const id = newMailbox();
    expect(await (await get(id, 1)).json()).toEqual({ error: "empty" });
    expect((await get(id, 1)).status).toBe(404);

    const payload = bytes(0, 1, 2, 250, 255);
    expect((await put(id, 1, payload)).status).toBe(204);
    const res = await get(id, 1);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(payload);

    const again = await get(id, 1);
    expect(again.status).toBe(410);
    expect(await again.json()).toEqual({ error: "consumed" });
    expect(slotBytes(t)).toBe(0);
  });

  it("is write-once per slot, even after the slot was read", async () => {
    const id = newMailbox();
    expect((await put(id, 1, bytes(1))).status).toBe(204);
    const second = await put(id, 1, bytes(2));
    expect(second.status).toBe(409);
    expect(await second.json()).toEqual({ error: "slot_taken" });
    expect(new Uint8Array(await (await get(id, 1)).arrayBuffer())).toEqual(bytes(1));
    expect((await put(id, 1, bytes(3))).status).toBe(409);
    // The other slot is independent.
    expect(await (await get(id, 2)).json()).toEqual({ error: "empty" });
    expect((await put(id, 2, bytes(9))).status).toBe(204);
    expect(new Uint8Array(await (await get(id, 2)).arrayBuffer())).toEqual(bytes(9));
  });

  it("slot 3 is write-once and read-once", async () => {
    const id = newMailbox();
    expect((await put(id, 3, bytes(4))).status).toBe(204);
    const second = await put(id, 3, bytes(5));
    expect(second.status).toBe(409);
    expect(await second.json()).toEqual({ error: "slot_taken" });
    const first = await get(id, 3);
    expect(first.status).toBe(200);
    expect(new Uint8Array(await first.arrayBuffer())).toEqual(bytes(4));
    const again = await get(id, 3);
    expect(again.status).toBe(410);
    expect(await again.json()).toEqual({ error: "consumed" });
  });

  it("a burn erases slot 3", async () => {
    const id = newMailbox();
    await put(id, 3, bytes(6));
    expect((await burn(id)).status).toBe(204);
    const r = await get(id, 3);
    expect(r.status).toBe(410);
    expect(await r.json()).toEqual({ error: "mailbox_gone" });
  });

  it("needs no credentials", async () => {
    const id = newMailbox();
    const r = await put(id, 1, bytes(5));
    expect(r.status).toBe(204);
  });

  it("keeps mailboxes apart", async () => {
    const a = newMailbox();
    const b = newMailbox();
    await put(a, 1, bytes(1));
    expect(await (await get(b, 1)).json()).toEqual({ error: "empty" });
    expect((await put(b, 1, bytes(2))).status).toBe(204);
    expect(new Uint8Array(await (await get(a, 1)).arrayBuffer())).toEqual(bytes(1));
    expect(new Uint8Array(await (await get(b, 1)).arrayBuffer())).toEqual(bytes(2));
  });
});

describe("pairing mailbox: lifetime", () => {
  const { t, put, get, burn } = setup();

  it("burns the ID when deleted", async () => {
    const id = newMailbox();
    await put(id, 1, bytes(1));
    await put(id, 2, bytes(2));
    expect((await burn(id)).status).toBe(204);

    for (const r of [await put(id, 1, bytes(1)), await put(id, 2, bytes(1)), await get(id, 1), await get(id, 2)]) {
      expect(r.status).toBe(410);
      expect(await r.json()).toEqual({ error: "mailbox_gone" });
    }
    expect((await burn(id)).status).toBe(204); // deleting twice is fine
    expect(slotsOf(t, id)).toBe(0);
  });

  for (const housekeeping of [true, false]) {
    const label = housekeeping ? "with housekeeping" : "without housekeeping ever running";

    it(`burns the ID 10 minutes after the first write, ${label}`, async () => {
      const id = newMailbox();
      expect(MAILBOX_TTL_SECONDS).toBe(600);
      await put(id, 1, bytes(1));

      t.clock.now += MAILBOX_TTL_SECONDS - 1;
      expect((await put(id, 2, bytes(2))).status).toBe(204); // still open one second before

      t.clock.now += 1;
      if (housekeeping) t.stores.mailboxes.housekeep();
      for (const r of [await put(id, 3, bytes(1)), await get(id, 1), await get(id, 2)]) {
        expect(r.status).toBe(410);
        expect(await r.json()).toEqual({ error: "mailbox_gone" });
      }
      expect(slotsOf(t, id)).toBe(0);

      // The tombstone is dropped 24 h later; the ID is then fresh again.
      t.clock.now += MAILBOX_TOMBSTONE_SECONDS - 1;
      if (housekeeping) t.stores.mailboxes.housekeep();
      expect((await get(id, 1)).status).toBe(410); // 24 h after the burn is not over yet
      t.clock.now += 1;
      if (housekeeping) {
        t.stores.mailboxes.housekeep();
        expect(t.db.prepare("SELECT 1 FROM mailboxes WHERE id = ?").get(id)).toBeUndefined();
      }
      expect((await get(id, 1)).status).toBe(404);
      expect((await put(id, 1, bytes(1))).status).toBe(204);
    });
  }

  it("a tombstone lives 24 hours from the burn, not from the first write", async () => {
    const id = newMailbox();
    await put(id, 1, bytes(1));
    t.clock.now += 300;
    expect((await burn(id)).status).toBe(204);
    t.clock.now += DAY - 1;
    t.stores.mailboxes.housekeep();
    expect((await get(id, 1)).status).toBe(410);
    t.clock.now += 1;
    t.stores.mailboxes.housekeep();
    expect(t.db.prepare("SELECT 1 FROM mailboxes WHERE id = ?").get(id)).toBeUndefined();
  });

  it("does not extend the lifetime on later writes or reads", async () => {
    const id = newMailbox();
    await put(id, 1, bytes(1));
    const created = () => (t.db.prepare("SELECT created_at AS c FROM mailboxes WHERE id = ?").get(id) as { c: number }).c;
    const c0 = created();
    t.clock.now += 300;
    await put(id, 2, bytes(2));
    await put(id, 1, bytes(3)); // refused
    await get(id, 1);
    await get(id, 2);
    expect(created()).toBe(c0);
    t.clock.now += 300; // 600 after the first write
    expect((await get(id, 2)).status).toBe(410);
  });

  it("stores nothing for IDs nobody wrote to", async () => {
    const t2 = testApp();
    const id = newMailbox();
    expect((await t2.call("GET", `/v1/pairing/${id}/1`)).status).toBe(404);
    expect((await t2.call("GET", `/v1/pairing/${id}/2`)).status).toBe(404);
    expect((await t2.call("DELETE", `/v1/pairing/${id}`)).status).toBe(204);
    expect(mailboxRows(t2)).toBe(0);
    // Deleting an unknown ID does not burn it.
    expect((await t2.call("PUT", `/v1/pairing/${id}/1`, { body: bytes(1) })).status).toBe(204);
  });

  it("answers other methods with 405", async () => {
    const t2 = testApp();
    const id = newMailbox();
    expect((await t2.call("POST", `/v1/pairing/${id}/1`, { body: bytes(1) })).status).toBe(405);
    expect((await t2.call("GET", `/v1/pairing/${id}`)).status).toBe(405);
    expect(mailboxRows(t2)).toBe(0);
  });
});

describe("pairing mailbox: expired contents are swept within a minute", () => {
  it("the mailbox timer empties an expired slot long before the daily run", async () => {
    const { t, put } = setup();
    vi.useFakeTimers();
    const hk = startHousekeeping({ log: () => {} }, t.stores);
    try {
      const id = newMailbox();
      expect((await put(id, 1, bytes(1, 2, 3))).status).toBe(204);
      expect(slotsOf(t, id)).toBe(1);
      t.clock.now += MAILBOX_TTL_SECONDS + 60;
      vi.advanceTimersByTime(60_000); // one mailbox tick, far short of a day
      expect(slotsOf(t, id)).toBe(0);
    } finally {
      hk.stop();
      vi.useRealTimers();
    }
  });
});

describe("pairing mailbox: global byte cap", () => {
  it("a PUT that would pass 64 MiB answers 503 busy and stores nothing", async () => {
    const { t, put } = setup();
    // Fill the open slots to just under the cap straight in the table.
    const id = newMailbox();
    expect((await put(id, 1, bytes(1))).status).toBe(204);
    t.db
      .prepare("UPDATE mailbox_slots SET data = zeroblob(?) WHERE mailbox_id = ?")
      .run(MAX_MAILBOX_TOTAL_BYTES - 10, id);
    t.db.prepare("UPDATE mailbox_slots SET client = NULL WHERE mailbox_id = ?").run(id);
    t.stores.mailboxes.housekeep(); // recounts the running totals from the table
    const other = newMailbox();
    const r = await put(other, 1, new Uint8Array(11));
    expect(r.status).toBe(503);
    expect(await r.json()).toEqual({ error: "busy" });
    expect(slotsOf(t, other)).toBe(0);
    expect(t.db.prepare("SELECT COUNT(*) AS n FROM mailboxes WHERE id = ?").get(other)).toEqual({ n: 0 });
    // Exactly at the cap still fits; consumed slots free their bytes.
    expect((await put(other, 1, new Uint8Array(10))).status).toBe(204);
    expect((await t.call("GET", `/v1/pairing/${id}/1`)).status).toBe(200);
    expect((await put(newMailbox(), 1, new Uint8Array(1000))).status).toBe(204);
  });
});

/** The stored writer value of a mailbox's slot (an HMAC under a per-process key). */
const storedClient = (t: TestApp, id: string, slot = 1): string | null =>
  (t.db.prepare("SELECT client FROM mailbox_slots WHERE mailbox_id = ? AND slot = ?").get(id, slot) as { client: string | null }).client;

describe("pairing mailbox: one client's share", () => {
  it("a client holding 8 MiB in open slots gets 503 busy; others and later writes are fine", async () => {
    const { t } = setup();
    const from = (address: string, id: string, n: number, slot = 1) =>
      t.call("PUT", `/v1/pairing/${id}/${slot}`, { body: new Uint8Array(n), clientAddress: address });
    const a = newMailbox();
    expect((await from("203.0.113.1", a, 1)).status).toBe(204);
    t.db
      .prepare("UPDATE mailbox_slots SET data = zeroblob(?), client = ? WHERE mailbox_id = ?")
      .run(MAX_MAILBOX_CLIENT_BYTES - 10, storedClient(t, a), a);
    t.stores.mailboxes.housekeep();
    const b = newMailbox();
    const over = await from("203.0.113.1", b, 11);
    expect(over.status).toBe(503);
    expect(await over.json()).toEqual({ error: "busy" });
    expect(slotsOf(t, b)).toBe(0);
    expect((await from("203.0.113.2", b, 11)).status).toBe(204); // another client is unaffected
    expect((await from("203.0.113.1", newMailbox(), 10)).status).toBe(204); // exact fit
    // Reading the big slot gives the share back.
    expect((await t.call("GET", `/v1/pairing/${a}/1`)).status).toBe(200);
    expect((await from("203.0.113.1", newMailbox(), 1000)).status).toBe(204);
  });

  it("stores a keyed hash of the client key, never the address, and drops it when the slot is read or burnt", async () => {
    const { t } = setup();
    const id = newMailbox();
    await t.call("PUT", `/v1/pairing/${id}/1`, { body: bytes(1, 2), clientAddress: "198.51.100.77" });
    await t.call("PUT", `/v1/pairing/${id}/2`, { body: bytes(3), clientAddress: "198.51.100.77" });
    const rows = () => t.db.prepare("SELECT client FROM mailbox_slots WHERE mailbox_id = ?").all(id) as { client: string | null }[];
    const h = storedClient(t, id)!;
    expect(rows().map((r) => r.client)).toEqual([h, h]);
    expect(JSON.stringify(rows())).not.toContain("198.51.100.77");
    await t.call("GET", `/v1/pairing/${id}/1`);
    expect(rows().map((r) => r.client)).toEqual([null, h]);
    await t.call("DELETE", `/v1/pairing/${id}`);
    expect(rows()).toEqual([]);
  });
});

describe("pairing mailbox: running totals", () => {
  it("match the table after put, take, burn and expiry (without a sweep)", async () => {
    const { t } = setup();
    const fromTable = () => {
      const total = (t.db.prepare("SELECT COALESCE(SUM(LENGTH(data)),0) AS n FROM mailbox_slots").get() as { n: number }).n;
      const per: Record<string, number> = {};
      for (const r of t.db
        .prepare("SELECT client, SUM(LENGTH(data)) AS n FROM mailbox_slots WHERE client IS NOT NULL GROUP BY client HAVING n > 0")
        .all() as { client: string; n: number }[]) per[r.client] = r.n;
      return { total, perClient: per };
    };
    const put = (id: string, slot: number, n: number, address: string) =>
      t.call("PUT", `/v1/pairing/${id}/${slot}`, { body: new Uint8Array(n).fill(1), clientAddress: address });
    const [m1, m2, m3] = [newMailbox(), newMailbox(), newMailbox()];
    await put(m1, 1, 100, "192.0.2.1");
    await put(m1, 2, 50, "192.0.2.2");
    await put(m2, 1, 10, "192.0.2.1");
    await put(m3, 1, 7, "192.0.2.3");
    expect(t.stores.mailboxes.stats()).toEqual(fromTable());
    expect(t.stores.mailboxes.stats().total).toBe(167);
    await t.call("GET", `/v1/pairing/${m1}/1`);
    expect(t.stores.mailboxes.stats()).toEqual(fromTable());
    await t.call("DELETE", `/v1/pairing/${m2}`);
    expect(t.stores.mailboxes.stats()).toEqual(fromTable());
    t.clock.now += MAILBOX_TTL_SECONDS + 1;
    await t.call("GET", `/v1/pairing/${m1}/2`); // lazy expiry burns m1 on this call
    expect(t.stores.mailboxes.stats()).toEqual(fromTable());
    t.stores.mailboxes.housekeep(); // sweep burns m3
    expect(t.stores.mailboxes.stats()).toEqual({ total: 0, perClient: {} });
    expect(fromTable()).toEqual({ total: 0, perClient: {} });
  });
});

describe("pairing mailbox: the stored writer value is keyed", () => {
  it("differs between two app instances for one address and is not the plain SHA-256", async () => {
    const one = setup().t;
    const two = setup().t;
    const id = newMailbox();
    for (const t of [one, two]) await t.call("PUT", `/v1/pairing/${id}/1`, { body: bytes(1), clientAddress: "198.51.100.77" });
    const a = storedClient(one, id)!;
    const b = storedClient(two, id)!;
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
    const plain = createHash("sha256").update("198.51.100.77").digest("hex");
    expect([a, b]).not.toContain(plain);
  });

  it("after a restart old values match nobody: cleared, counted globally only", async () => {
    const { t } = setup();
    const id = newMailbox();
    await t.call("PUT", `/v1/pairing/${id}/1`, { body: new Uint8Array(100), clientAddress: "198.51.100.77" });
    const again = createMailboxes(t.db, () => t.clock.now); // a new process on the same database
    expect(again.stats()).toEqual({ total: 100, perClient: {} });
    expect(storedClient(t, id)).toBeNull();
  });
});
