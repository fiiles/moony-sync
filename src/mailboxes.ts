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

import type { Clock } from "./clock.js";
import type { Db } from "./db.js";
import { fail, type Result } from "./http.js";
import { MAILBOX_TOMBSTONE_SECONDS, MAILBOX_TTL_SECONDS, MAX_MAILBOX_TOTAL_BYTES } from "./limits.js";

export type Slot = 1 | 2 | 3;

export interface Mailboxes {
  put(id: string, slot: Slot, body: Uint8Array): Result;
  /** Returns the slot's bytes and erases them: each slot is read once. */
  take(id: string, slot: Slot): Result<{ data: Uint8Array }>;
  /** Burns the mailbox. An ID nobody wrote to is left alone (nothing is stored for it). */
  burn(id: string): void;
  /** Burns mailboxes past 10 minutes (their slot contents are erased) and drops tombstones past
   *  24 hours. Runs every minute, so contents outlive their expiry by a minute at most. */
  housekeep(): void;
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
    stored: db.prepare("SELECT COALESCE(SUM(LENGTH(data)), 0) AS n FROM mailbox_slots"),
    slot: db.prepare("SELECT data, consumed FROM mailbox_slots WHERE mailbox_id = ? AND slot = ?"),
    insertSlot: db.prepare("INSERT INTO mailbox_slots (mailbox_id, slot, data) VALUES (?, ?, ?)"),
    consume: db.prepare(
      "UPDATE mailbox_slots SET data = x'', consumed = 1 WHERE mailbox_id = ? AND slot = ?",
    ),
    expiredOpen: db.prepare("SELECT id, created_at FROM mailboxes WHERE state = 'open' AND created_at <= ?"),
    expiredTombstones: db.prepare("SELECT id FROM mailboxes WHERE state = 'gone' AND gone_at <= ?"),
  };

  /** Burns: slots erased, the row stays as a tombstone that started at `at`. */
  function burnAt(id: string, at: number): void {
    q.deleteSlots.run(id);
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

  const putTx = db.transaction((id: string, slot: Slot, body: Uint8Array): Result => {
    const m = load(id);
    if (m?.state === "gone") return fail(410, "mailbox_gone");
    if (m && q.slot.get(id, slot)) return fail(409, "slot_taken");
    // Bytes held in slots (read slots are empty) are capped across all mailboxes, so nobody can
    // fill the disk with pairings; refused before anything is stored.
    const stored = (q.stored.get() as { n: number }).n;
    if (stored + body.byteLength > MAX_MAILBOX_TOTAL_BYTES) return fail(503, "busy");
    // The first write creates the mailbox and starts its 10-minute clock.
    if (!m) q.insert.run(id, clock());
    q.insertSlot.run(id, slot, Buffer.from(body.buffer, body.byteOffset, body.byteLength));
    return { ok: true };
  });

  const takeTx = db.transaction((id: string, slot: Slot): Result<{ data: Uint8Array }> => {
    const m = load(id);
    if (!m) return fail(404, "empty");
    if (m.state === "gone") return fail(410, "mailbox_gone");
    const row = q.slot.get(id, slot) as { data: Buffer; consumed: number } | undefined;
    if (!row) return fail(404, "empty");
    if (row.consumed) return fail(410, "consumed");
    q.consume.run(id, slot);
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
      q.deleteSlots.run(m.id);
      q.deleteBox.run(m.id);
    }
  });

  return {
    put: (id, slot, body) => putTx(id, slot, body),
    take: (id, slot) => takeTx(id, slot),
    burn: (id) => burnTx(id),
    housekeep: () => housekeepTx(),
  };
}
