// Pairing mailboxes: short-lived, three-slot drop boxes (1 scanner to shower, 2 holder to
// joiner, 3 shower to scanner) for the key exchange that pairs a new device. Slots hold public
// keys or sealed blobs only; the server cannot read either. Each slot is written once and read
// once, the whole mailbox lives 10 minutes from its first write, and once it has expired or been
// deleted its ID is burnt: a content-free tombstone answers 410 for 24 hours.
//
// The mailboxes live in shared tables keyed by mailbox id. Both time rules are
// checked on every call (`load`), so answers are the same whether or not housekeep() has run;
// housekeep() only frees rows. Each call is synchronous and each mutation runs in a transaction,
// which means no interleaving and no half-done burn.
// Nothing is stored for an ID until a valid first put.

import { createHash } from "node:crypto";
import type { Clock } from "./clock.js";
import type { Db } from "./db.js";
import { fail, type Result } from "./http.js";
import { MAILBOX_TOMBSTONE_SECONDS, MAILBOX_TTL_SECONDS, MAX_MAILBOX_CLIENT_BYTES, MAX_MAILBOX_TOTAL_BYTES } from "./limits.js";

export type Slot = 1 | 2 | 3;

export interface Mailboxes {
  /** `clientKey` is the limiter's key for the writer; only its hash is stored. */
  put(id: string, slot: Slot, body: Uint8Array, clientKey: string): Result;
  /** Returns the slot's bytes and erases them: each slot is read once. */
  take(id: string, slot: Slot): Result<{ data: Uint8Array }>;
  /** Burns the mailbox. An ID nobody wrote to is left alone (nothing is stored for it). */
  burn(id: string): void;
  /** Burns mailboxes past 10 minutes (their slot contents are erased) and drops tombstones past
   *  24 hours. Runs every minute, so contents outlive their expiry by a minute at most. */
  housekeep(): void;
  /** The running byte totals in open slots (all, and per client-key hash). Diagnostics and tests. */
  stats(): { total: number; perClient: Record<string, number> };
}

interface Row {
  created_at: number;
  state: "open" | "gone";
  gone_at: number | null;
}

export function createMailboxes(db: Db, clock: Clock): Mailboxes {
  const q = {
    row: db.prepare("SELECT created_at, state, gone_at FROM mailboxes WHERE id = ?"),
    insert: db.prepare("INSERT INTO mailboxes (id, created_at, state) VALUES (?, ?, 'open')"),
    markGone: db.prepare("UPDATE mailboxes SET state = 'gone', gone_at = ? WHERE id = ?"),
    deleteSlots: db.prepare("DELETE FROM mailbox_slots WHERE mailbox_id = ?"),
    deleteBox: db.prepare("DELETE FROM mailboxes WHERE id = ?"),
    totals: db.prepare("SELECT client, COALESCE(SUM(LENGTH(data)), 0) AS n FROM mailbox_slots GROUP BY client"),
    slotSizes: db.prepare("SELECT client, LENGTH(data) AS n FROM mailbox_slots WHERE mailbox_id = ?"),
    slot: db.prepare("SELECT data, consumed, client FROM mailbox_slots WHERE mailbox_id = ? AND slot = ?"),
    insertSlot: db.prepare("INSERT INTO mailbox_slots (mailbox_id, slot, data, client) VALUES (?, ?, ?, ?)"),
    consume: db.prepare(
      "UPDATE mailbox_slots SET data = x'', consumed = 1, client = NULL WHERE mailbox_id = ? AND slot = ?",
    ),
    expiredOpen: db.prepare("SELECT id, created_at FROM mailboxes WHERE state = 'open' AND created_at <= ?"),
    expiredTombstones: db.prepare("SELECT id FROM mailboxes WHERE state = 'gone' AND gone_at <= ?"),
  };

  // Bytes held in open slots, kept in step with the table by every path that changes it, and
  // recomputed from the table at start and in each sweep (and after any failed transaction).
  let total = 0;
  let perClient = new Map<string, number>();
  function recount(): void {
    total = 0;
    perClient = new Map();
    for (const r of q.totals.all() as { client: string | null; n: number }[]) {
      total += r.n;
      if (r.client !== null && r.n > 0) perClient.set(r.client, r.n);
    }
  }
  function release(client: string | null, n: number): void {
    total = Math.max(0, total - n);
    if (client === null) return;
    const left = (perClient.get(client) ?? 0) - n;
    if (left > 0) perClient.set(client, left);
    else perClient.delete(client);
  }
  recount();

  /** Erases the mailbox's slots and takes their bytes off the totals. */
  function dropSlots(id: string): void {
    for (const r of q.slotSizes.all(id) as { client: string | null; n: number }[]) release(r.client, r.n);
    q.deleteSlots.run(id);
  }

  /** Burns: slots erased, the row stays as a tombstone that started at `at`. */
  function burnAt(id: string, at: number): void {
    dropSlots(id);
    q.markGone.run(at, id);
  }

  /** The mailbox as it is now: an open one past its 10 minutes is burnt first (the tombstone
   *  starts when the time ran out, not when somebody noticed), and a tombstone past 24 hours is
   *  forgotten, so the ID is unknown again. Call inside a transaction. */
  function load(id: string): Row | null {
    const m = q.row.get(id) as Row | undefined;
    if (!m) return null;
    const now = clock();
    if (m.state === "open") {
      const expiresAt = m.created_at + MAILBOX_TTL_SECONDS;
      if (expiresAt > now) return m;
      burnAt(id, expiresAt);
      m.state = "gone";
      m.gone_at = expiresAt;
    }
    if (m.gone_at! + MAILBOX_TOMBSTONE_SECONDS <= now) {
      q.deleteBox.run(id);
      return null;
    }
    return m;
  }

  const putTx = db.transaction((id: string, slot: Slot, body: Uint8Array, client: string): Result => {
    const m = load(id);
    if (m?.state === "gone") return fail(410, "mailbox_gone");
    if (m && q.slot.get(id, slot)) return fail(409, "slot_taken");
    // Bytes held in slots (read slots are empty) are capped across all mailboxes, so nobody can
    // fill the disk with pairings; refused before anything is stored.
    // One client may hold only a share of that, so a single address cannot take it all.
    if (total + body.byteLength > MAX_MAILBOX_TOTAL_BYTES) return fail(503, "busy");
    if ((perClient.get(client) ?? 0) + body.byteLength > MAX_MAILBOX_CLIENT_BYTES) return fail(503, "busy");
    // The first write creates the mailbox and starts its 10-minute clock.
    if (!m) q.insert.run(id, clock());
    q.insertSlot.run(id, slot, Buffer.from(body.buffer, body.byteOffset, body.byteLength), client);
    total += body.byteLength;
    perClient.set(client, (perClient.get(client) ?? 0) + body.byteLength);
    return { ok: true };
  });

  const takeTx = db.transaction((id: string, slot: Slot): Result<{ data: Uint8Array }> => {
    const m = load(id);
    if (!m) return fail(404, "empty");
    if (m.state === "gone") return fail(410, "mailbox_gone");
    const row = q.slot.get(id, slot) as { data: Buffer; consumed: number; client: string | null } | undefined;
    if (!row) return fail(404, "empty");
    if (row.consumed) return fail(410, "consumed");
    q.consume.run(id, slot);
    release(row.client, row.data.length);
    return { ok: true, data: new Uint8Array(row.data) };
  });

  const burnTx = db.transaction((id: string): void => {
    if (load(id)?.state === "open") burnAt(id, clock());
  });

  const housekeepTx = db.transaction((): void => {
    const now = clock();
    for (const m of q.expiredOpen.all(now - MAILBOX_TTL_SECONDS) as { id: string; created_at: number }[]) {
      burnAt(m.id, m.created_at + MAILBOX_TTL_SECONDS);
    }
    for (const m of q.expiredTombstones.all(now - MAILBOX_TOMBSTONE_SECONDS) as { id: string }[]) {
      dropSlots(m.id);
      q.deleteBox.run(m.id);
    }
    recount();
  });

  /** Runs a mutation; the in-memory totals are rebuilt from the table if it throws. */
  const guarded = <A extends unknown[], T>(fn: (...args: A) => T) => (...args: A): T => {
    try {
      return fn(...args);
    } catch (e) {
      recount();
      throw e;
    }
  };

  return {
    // Only a hash of the client key is stored: the server keeps no client address at rest.
    put: guarded((id, slot, body, clientKey) =>
      putTx(id, slot, body, createHash("sha256").update(clientKey).digest("hex")),
    ),
    take: guarded((id, slot) => takeTx(id, slot)),
    burn: guarded((id) => burnTx(id)),
    housekeep: guarded(() => housekeepTx()),
    stats: () => ({ total, perClient: Object.fromEntries(perClient) }),
  };
}
