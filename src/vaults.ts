// Vaults: an append-only log of opaque ciphertext ops with server-assigned sequence numbers,
// plus pointers to snapshot files, in shared SQLite tables keyed
// by vault_id. The server never interprets an op. Every call runs synchronously against the
// database, so a check and the write that depends on it can never interleave with another
// request; the multi-statement mutations also run in one transaction, so a crash cannot leave
// them half done.

import { createHash } from "node:crypto";
import type { Clock } from "./clock.js";
import type { Db } from "./db.js";
import { encodeBase64, timingSafeEqualStr } from "./encoding.js";
import { fail, type Result } from "./http.js";
import {
  MAX_PULL_BYTES,
  OP_OVERHEAD_BYTES,
  MAX_REKEYS_KEPT,
  MAX_REKEY_BYTES,
  MAX_REKEY_PAGE_BYTES,
  MAX_VAULTS_PER_ACCOUNT,
  MAX_VAULT_OP_BYTES,
  OP_RETENTION_SECONDS,
  ORPHAN_SNAPSHOT_AGE_SECONDS,
  PREVIOUS_TOKEN_SECONDS,
  READ_GRACE_SECONDS,
  SNAPSHOTS_KEPT,
} from "./limits.js";
import type { People } from "./people.js";
import type { BlobFiles } from "./blob-files.js";
import type { Snapshots } from "./snapshots.js";

export type IncomingOp = { id: string; ct: Uint8Array };
export type StoredOp = { seq: number; id: string; ct: Uint8Array };
export type VaultInfo = {
  head: number;
  floor: number;
  snapshotSeq: number | null;
  paidUntil: number;
  bytes: number;
  rotation: number;
};
export type Rekey = { rotation: number; head: number; at: number; rekey: string };
export type SnapshotRef = { file: string; seq: number; size: number };

export interface Vaults {
  init(vaultId: string, account: string, token: string): Promise<Result<{ created: boolean }>>;
  info(vaultId: string, token: string): Promise<Result<VaultInfo>>;
  destroy(vaultId: string, token: string): Promise<Result>;
  push(
    vaultId: string,
    token: string,
    ops: IncomingOp[],
  ): Promise<Result<{ head: number; accepted: number }>>;
  pull(
    vaultId: string,
    token: string,
    after: number,
    limit: number,
  ): Promise<Result<{ ops: StoredOp[]; head: number; more: boolean }>>;
  /** The verdict `access` would get for this token, without side effects (no activity mark): the
   *  routes call it before reading a request body, the real call re-checks in its transaction. */
  check(vaultId: string, token: string, need: Access): Result;
  /** The verdict plus the activity mark; joins an outer transaction. For services that run their
   *  own transaction on the vault (blobs). */
  authorize(vaultId: string, token: string, access: Access): Result;
  /** Checks a snapshot upload may start; the route then streams the body to a file. */
  authorizeSnapshot(vaultId: string, token: string, seq: number): Promise<Result>;
  /** Records an uploaded snapshot. `stale` tells the route to delete the file it just wrote. */
  recordSnapshot(
    vaultId: string,
    token: string,
    ref: SnapshotRef,
  ): Promise<Result<{ stale: boolean }>>;
  latestSnapshot(vaultId: string, token: string): Promise<Result<SnapshotRef>>;
  rotateToken(
    vaultId: string,
    token: string,
    next: string,
    rekey: Uint8Array,
  ): Promise<Result<{ rotation: number; head: number }>>;
  rekeys(
    vaultId: string,
    token: string,
    after: number,
    limit: number,
  ): Promise<Result<{ rekeys: Rekey[]; more: boolean }>>;
  /** The daily per-vault work; finishes a pending wipe of this ID first. */
  housekeep(vaultId: string): void;
  /** Finishes every pending wipe and removes old snapshot directories no vault record owns. */
  sweep(): void;
  /** Vault IDs, for the housekeeping loop. */
  listIds(): string[];
  listByAccount(account: string): { vaultId: string; bytes: number; lastActivity: number | null }[];
  /** Unconditional delete (admin). */
  wipe(vaultId: string): void;
  /** Every vault with its stored bytes (ops + snapshot files) and last activity, oldest first. */
  usage(): { vaultId: string; account: string; bytes: number; files: number; lastActivity: number | null }[];
  /** Drops every vault row of the account at once (calls answer vault_not_found from here on) and
   *  returns the IDs; joins an outer transaction. Finish with `finishWipes`. */
  dropAccount(account: string): string[];
  /** Removes the files of vaults dropped by `dropAccount`; a failure stays pending for sweep. */
  finishWipes(vaultIds: string[]): void;
}

interface Meta {
  vault_id: string;
  account: string;
  token_hash: string;
  created_at: number;
  head: number;
  floor: number;
  snapshot_seq: number;
  bytes: number;
  rotation: number;
  last_activity: number | null;
}

/** read: pull, snapshot download, rekey bundles (allowed in the grace period, and for a token
 *  that was rotated away less than 30 days ago);
 *  write: needs entitlement and the current token;
 *  owner: the current token only (deleting your data or rotating the token never needs
 *  entitlement). */
export type Access = "read" | "write" | "owner";

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");
const asBuffer = (u: Uint8Array): Buffer => Buffer.from(u.buffer, u.byteOffset, u.byteLength);
const toBytes = (b: Buffer): Uint8Array => new Uint8Array(b.buffer, b.byteOffset, b.byteLength);

export function createVaults(
  db: Db,
  clock: Clock,
  people: People,
  snapshots: Snapshots,
  blobFiles: BlobFiles,
): Vaults {
  const q = {
    meta: db.prepare("SELECT * FROM vaults WHERE vault_id = ?"),
    countByAccount: db.prepare("SELECT COUNT(*) AS n FROM vaults WHERE account = ?"),
    insertVault: db.prepare(
      `INSERT INTO vaults (vault_id, account, token_hash, created_at, last_activity)
       VALUES (?, ?, ?, ?, ?)`,
    ),
    touch: db.prepare("UPDATE vaults SET last_activity = ? WHERE vault_id = ?"),
    pendingWipe: db.prepare("SELECT 1 FROM pending_wipes WHERE vault_id = ?"),
    pendingWipes: db.prepare("SELECT vault_id FROM pending_wipes"),
    addPendingWipe: db.prepare("INSERT OR IGNORE INTO pending_wipes (vault_id) VALUES (?)"),
    donePendingWipe: db.prepare("DELETE FROM pending_wipes WHERE vault_id = ?"),
    deleteVault: db.prepare("DELETE FROM vaults WHERE vault_id = ?"), // cascades to every child
    prevToken: db.prepare("SELECT rotated_at FROM prev_tokens WHERE vault_id = ? AND token_hash = ?"),
    insertOp: db.prepare(
      "INSERT OR IGNORE INTO ops (vault_id, seq, op_id, ct, size, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ),
    setHeadBytes: db.prepare("UPDATE vaults SET head = ?, bytes = ? WHERE vault_id = ?"),
    selectOps: db.prepare(
      "SELECT seq, op_id, ct, size FROM ops WHERE vault_id = ? AND seq > ? ORDER BY seq LIMIT ?",
    ),
    insertSnapshot: db.prepare(
      "INSERT INTO snapshots (vault_id, file, seq, size, created_at) VALUES (?, ?, ?, ?, ?)",
    ),
    setSnapshotSeq: db.prepare("UPDATE vaults SET snapshot_seq = ? WHERE vault_id = ?"),
    oldSnapshots: db.prepare(
      `SELECT file FROM snapshots WHERE vault_id = ?
       ORDER BY seq DESC, created_at DESC, rowid DESC LIMIT -1 OFFSET ?`,
    ),
    deleteSnapshot: db.prepare("DELETE FROM snapshots WHERE vault_id = ? AND file = ?"),
    snapshotFiles: db.prepare("SELECT file FROM snapshots WHERE vault_id = ?"),
    latestSnapshot: db.prepare(
      `SELECT file, seq, size FROM snapshots WHERE vault_id = ?
       ORDER BY seq DESC, created_at DESC, rowid DESC LIMIT 1`,
    ),
    countRekeys: db.prepare("SELECT COUNT(*) AS n FROM rekeys WHERE vault_id = ? AND at > ?"),
    forgetPrevToken: db.prepare("DELETE FROM prev_tokens WHERE vault_id = ? AND token_hash = ?"),
    insertPrevToken: db.prepare(
      "INSERT INTO prev_tokens (vault_id, token_hash, rotated_at) VALUES (?, ?, ?)",
    ),
    setToken: db.prepare("UPDATE vaults SET token_hash = ?, rotation = ? WHERE vault_id = ?"),
    insertRekey: db.prepare(
      "INSERT INTO rekeys (vault_id, rotation, head, at, rekey) VALUES (?, ?, ?, ?, ?)",
    ),
    selectRekeys: db.prepare(
      "SELECT rotation, head, at, rekey FROM rekeys WHERE vault_id = ? AND rotation > ? AND at > ? ORDER BY rotation LIMIT ?",
    ),
    moreRekeys: db.prepare("SELECT 1 FROM rekeys WHERE vault_id = ? AND rotation > ? AND at > ? LIMIT 1"),
    pruneMax: db.prepare(
      "SELECT MAX(seq) AS maxSeq FROM ops WHERE vault_id = ? AND seq <= ? AND created_at < ?",
    ),
    pruneSize: db.prepare("SELECT SUM(size) AS size FROM ops WHERE vault_id = ? AND seq <= ?"),
    pruneDelete: db.prepare("DELETE FROM ops WHERE vault_id = ? AND seq <= ?"),
    pruneMeta: db.prepare(
      "UPDATE vaults SET floor = MAX(floor, ?), bytes = bytes - ? WHERE vault_id = ?",
    ),
    forgetOldTokens: db.prepare("DELETE FROM prev_tokens WHERE vault_id = ? AND rotated_at <= ?"),
    forgetOldRekeys: db.prepare("DELETE FROM rekeys WHERE vault_id = ? AND at <= ?"),
    allIds: db.prepare("SELECT vault_id FROM vaults ORDER BY created_at, rowid"),
    usage: db.prepare(
      `SELECT v.vault_id, v.account, v.last_activity,
              v.bytes + COALESCE((SELECT SUM(s.size) FROM snapshots s WHERE s.vault_id = v.vault_id), 0)
                      + COALESCE((SELECT SUM(b.size) FROM blobs b WHERE b.vault_id = v.vault_id), 0) AS total,
              (SELECT COUNT(*) FROM blobs b WHERE b.vault_id = v.vault_id) AS files
       FROM vaults v ORDER BY v.created_at, v.rowid`,
    ),
    byAccount: db.prepare(
      "SELECT vault_id, bytes, last_activity FROM vaults WHERE account = ? ORDER BY created_at, rowid",
    ),
  };

  const meta = (vaultId: string): Meta | null => (q.meta.get(vaultId) as Meta | undefined) ?? null;

  /** Entitlement end of the vault's account; a vanished person counts as long expired. */
  const paidUntilOf = (m: Meta): number => people.paidUntil(m.account) ?? 0;

  function entitled(m: Meta, access: Access, now: number): boolean {
    if (access === "owner") return true;
    const paidUntil = paidUntilOf(m);
    return access === "write" ? paidUntil > now : paidUntil + READ_GRACE_SECONDS > now;
  }

  /** Who a token hash belongs to: the current token, a token rotated away less than 30 days ago
   *  (read-only), or nobody. */
  function roleOf(m: Meta, tokenHash: string, now: number): "current" | "previous" | null {
    if (timingSafeEqualStr(tokenHash, m.token_hash)) return "current";
    const row = q.prevToken.get(m.vault_id, tokenHash) as { rotated_at: number } | undefined;
    return row && row.rotated_at + PREVIOUS_TOKEN_SECONDS > now ? "previous" : null;
  }

  /** The verdict without side effects. */
  function verdict(vaultId: string, token: string, access: Access): Result<{ meta: Meta }> {
    const m = meta(vaultId);
    if (!m) return fail(404, "vault_not_found");
    const now = clock();
    const role = roleOf(m, sha256(token), now);
    if (!role) return fail(401, "unauthorized");
    if (role === "previous" && access !== "read") return fail(403, "token_read_only");
    if (!entitled(m, access, now)) return fail(402, "payment_required");
    return { ok: true, meta: m };
  }

  function authorize(vaultId: string, token: string, access: Access): Result<{ meta: Meta }> {
    const v = verdict(vaultId, token, access);
    if (!v.ok) return v;
    const m = v.meta;
    const now = clock();
    // Every authorised call counts as activity (unix seconds, rounded down to the minute).
    const minute = now - (now % 60);
    if (m.last_activity !== minute) q.touch.run(minute, vaultId);
    return { ok: true, meta: m };
  }

  /** Runs `fn` in one transaction (nested calls join the outer one). */
  const atomic = <A extends unknown[], T>(fn: (...args: A) => T) => db.transaction(fn);

  function removeFiles(vaultId: string, files: string[]): void {
    for (const file of files) {
      try {
        snapshots.remove(vaultId, file);
      } catch {
        // A file that cannot be removed now has no record; housekeeping removes it later.
      }
    }
  }

  /** Drops the vault's rows and notes the wipe as pending in one transaction (from here on every
   *  call answers vault_not_found), then removes the files. A failure there leaves the pending
   *  row, and housekeep/sweep finish the job. */
  const dropRows = atomic((vaultId: string) => {
    q.deleteVault.run(vaultId);
    q.addPendingWipe.run(vaultId);
  });

  function finishWipe(vaultId: string): void {
    try {
      snapshots.removeVault(vaultId);
      blobFiles.removeVault(vaultId);
      q.donePendingWipe.run(vaultId);
    } catch {
      // Stays pending; retried by the next housekeep/sweep.
    }
  }

  function wipe(vaultId: string): void {
    dropRows(vaultId);
    finishWipe(vaultId);
  }

  const doInit = atomic(
    (vaultId: string, account: string, token: string): Result<{ created: boolean }> => {
      // A deletion that failed half-way is still pending: re-creating now would be wiped by it.
      if (q.pendingWipe.get(vaultId)) return fail(409, "vault_deleting");
      const tokenHash = sha256(token);
      const existing = meta(vaultId);
      if (existing) {
        const same =
          existing.account === account && timingSafeEqualStr(existing.token_hash, tokenHash);
        return same ? { ok: true, created: false } : fail(409, "vault_exists");
      }
      const paidUntil = people.paidUntil(account);
      if (paidUntil === null) return fail(404, "account_not_found");
      if (paidUntil <= clock()) return fail(402, "payment_required");
      const owned = (q.countByAccount.get(account) as { n: number }).n;
      if (owned >= MAX_VAULTS_PER_ACCOUNT) return fail(403, "vault_limit_reached");
      const now = clock();
      q.insertVault.run(vaultId, account, tokenHash, now, now - (now % 60));
      return { ok: true, created: true };
    },
  );

  const doPush = atomic((vaultId: string, token: string, ops: IncomingOp[]) => {
    const auth = authorize(vaultId, token, "write");
    if (!auth.ok) return auth;
    const m = auth.meta;
    // Each op is charged its ciphertext plus a fixed overhead (row, index and op ID), so tiny
    // ops cannot grow the real disk use far beyond the quota. `size` and `bytes` hold the charge.
    const incoming = ops.reduce((n, op) => n + op.ct.byteLength + OP_OVERHEAD_BYTES, 0);
    if (m.bytes + incoming > MAX_VAULT_OP_BYTES) return fail(413, "quota_exceeded");
    const now = clock();
    let head = m.head;
    let bytes = m.bytes;
    let accepted = 0;
    for (const op of ops) {
      const charge = op.ct.byteLength + OP_OVERHEAD_BYTES;
      const r = q.insertOp.run(vaultId, head + 1, op.id, asBuffer(op.ct), charge, now);
      if (r.changes > 0) {
        head += 1;
        bytes += charge;
        accepted += 1;
      }
    }
    q.setHeadBytes.run(head, bytes, vaultId);
    return { ok: true as const, head, accepted };
  });

  const doRecordSnapshot = atomic(
    (vaultId: string, token: string, ref: SnapshotRef): Result<{ stale: boolean; drop: string[] }> => {
      const auth = authorize(vaultId, token, "write");
      if (!auth.ok) return auth;
      const m = auth.meta;
      if (ref.seq < m.snapshot_seq || ref.seq > m.head) return { ok: true, stale: true, drop: [] };
      q.insertSnapshot.run(vaultId, ref.file, ref.seq, ref.size, clock());
      q.setSnapshotSeq.run(ref.seq, vaultId);
      const old = (q.oldSnapshots.all(vaultId, SNAPSHOTS_KEPT) as { file: string }[]).map(
        (r) => r.file,
      );
      for (const file of old) q.deleteSnapshot.run(vaultId, file);
      return { ok: true, stale: false, drop: old };
    },
  );

  const doRotate = atomic(
    (vaultId: string, token: string, newToken: string, rekey: Uint8Array) => {
      const tokenHash = sha256(token);
      const newHash = sha256(newToken);
      const m = meta(vaultId);
      if (!m) return fail(404, "vault_not_found");
      const now = clock();
      const role = roleOf(m, tokenHash, now);
      if (!role) return fail(401, "unauthorized");
      if (role === "previous") return fail(403, "token_read_only");
      // A token that was ever the vault's (and is still remembered) cannot come back.
      if (roleOf(m, newHash, now)) return fail(400, "invalid_token");
      const kept = (q.countRekeys.get(vaultId, now - PREVIOUS_TOKEN_SECONDS) as { n: number }).n;
      if (kept >= MAX_REKEYS_KEPT) return fail(409, "too_many_rotations");

      const rotation = m.rotation + 1;
      // A token retired over 30 days ago may still have an unpruned row; it is current again.
      q.forgetPrevToken.run(vaultId, newHash);
      q.insertPrevToken.run(vaultId, m.token_hash, now);
      q.setToken.run(newHash, rotation, vaultId);
      q.insertRekey.run(vaultId, rotation, m.head, now, asBuffer(rekey));
      const minute = now - (now % 60);
      q.touch.run(minute, vaultId);
      return { ok: true as const, rotation, head: m.head };
    },
  );

  const prune = atomic((m: Meta, now: number) => {
    // Ops already inside a snapshot and older than the retention window are dropped.
    const { maxSeq } = q.pruneMax.get(m.vault_id, m.snapshot_seq, now - OP_RETENTION_SECONDS) as {
      maxSeq: number | null;
    };
    if (maxSeq !== null) {
      const { size } = q.pruneSize.get(m.vault_id, maxSeq) as { size: number | null };
      q.pruneDelete.run(m.vault_id, maxSeq);
      q.pruneMeta.run(maxSeq, size ?? 0, m.vault_id);
    }
    // Tokens rotated away more than 30 days ago, and their rekey bundles, are forgotten.
    const stale = now - PREVIOUS_TOKEN_SECONDS;
    q.forgetOldTokens.run(m.vault_id, stale);
    q.forgetOldRekeys.run(m.vault_id, stale);
  });

  /** Snapshot files under this vault with no snapshot row: an upload whose request died between
   *  the file write and the record. Old enough that no upload is still in flight. */
  function sweepOrphanFiles(vaultId: string, now: number): void {
    const known = new Set(
      (q.snapshotFiles.all(vaultId) as { file: string }[]).map((r) => r.file),
    );
    const cutoff = now - ORPHAN_SNAPSHOT_AGE_SECONDS;
    for (const f of snapshots.listFiles(vaultId)) {
      if (!known.has(f.file) && f.mtime < cutoff) removeFiles(vaultId, [f.file]);
    }
  }

  return {
    async init(vaultId, account, token) {
      return doInit(vaultId, account, token);
    },

    async info(vaultId, token) {
      const auth = authorize(vaultId, token, "read");
      if (!auth.ok) return auth;
      const m = auth.meta;
      return {
        ok: true,
        head: m.head,
        floor: m.floor,
        snapshotSeq: m.snapshot_seq >= 0 ? m.snapshot_seq : null,
        paidUntil: paidUntilOf(m),
        bytes: m.bytes,
        rotation: m.rotation,
      };
    },

    authorize(vaultId, token, access) {
      const a = authorize(vaultId, token, access);
      return a.ok ? { ok: true } : a;
    },

    check(vaultId, token, need) {
      const v = verdict(vaultId, token, need);
      return v.ok ? { ok: true } : v;
    },

    async push(vaultId, token, ops) {
      return doPush(vaultId, token, ops);
    },

    async pull(vaultId, token, after, limit) {
      const auth = authorize(vaultId, token, "read");
      if (!auth.ok) return auth;
      const m = auth.meta;
      if (after < m.floor) return fail(410, "snapshot_required");
      const rows = q.selectOps.all(vaultId, after, limit) as {
        seq: number;
        op_id: string;
        ct: Buffer;
        size: number;
      }[];
      const ops: StoredOp[] = [];
      let bytes = 0;
      for (const r of rows) {
        if (ops.length > 0 && bytes + r.size > MAX_PULL_BYTES) break;
        ops.push({ seq: r.seq, id: r.op_id, ct: toBytes(r.ct) });
        bytes += r.size;
      }
      const last = ops.length > 0 ? ops[ops.length - 1]!.seq : Math.max(after, m.floor);
      return { ok: true, ops, head: m.head, more: last < m.head };
    },

    async authorizeSnapshot(vaultId, token, seq) {
      const auth = authorize(vaultId, token, "write");
      if (!auth.ok) return auth;
      if (seq > auth.meta.head) return fail(400, "snapshot_ahead_of_head");
      if (seq < auth.meta.snapshot_seq) return fail(409, "snapshot_outdated");
      return { ok: true };
    },

    async recordSnapshot(vaultId, token, ref) {
      const r = doRecordSnapshot(vaultId, token, ref);
      if (!r.ok) return r;
      removeFiles(vaultId, r.drop);
      return { ok: true, stale: r.stale };
    },

    async latestSnapshot(vaultId, token) {
      const auth = authorize(vaultId, token, "read");
      if (!auth.ok) return auth;
      const row = q.latestSnapshot.get(vaultId) as SnapshotRef | undefined;
      return row ? { ok: true, ...row } : fail(404, "no_snapshot");
    },

    async rotateToken(vaultId, token, next, rekey) {
      if (rekey.byteLength === 0 || rekey.byteLength > MAX_REKEY_BYTES) {
        return fail(400, "invalid_rekey");
      }
      return doRotate(vaultId, token, next, rekey);
    },

    async rekeys(vaultId, token, after, limit) {
      const auth = authorize(vaultId, token, "read");
      if (!auth.ok) return auth;
      const rows = q.selectRekeys.all(vaultId, after, clock() - PREVIOUS_TOKEN_SECONDS, limit) as {
        rotation: number;
        head: number;
        at: number;
        rekey: Buffer;
      }[];
      const out: Rekey[] = [];
      let bytes = 0;
      for (const r of rows) {
        if (out.length > 0 && bytes + r.rekey.byteLength > MAX_REKEY_PAGE_BYTES) break;
        bytes += r.rekey.byteLength;
        out.push({ rotation: r.rotation, head: r.head, at: r.at, rekey: encodeBase64(toBytes(r.rekey)) });
      }
      const last = out.length > 0 ? out[out.length - 1]!.rotation : after;
      const more = q.moreRekeys.get(vaultId, last, clock() - PREVIOUS_TOKEN_SECONDS) !== undefined;
      return { ok: true, rekeys: out, more };
    },

    async destroy(vaultId, token) {
      const auth = authorize(vaultId, token, "owner");
      if (!auth.ok) return auth;
      wipe(vaultId);
      return { ok: true };
    },

    housekeep(vaultId) {
      if (q.pendingWipe.get(vaultId)) {
        finishWipe(vaultId);
        return;
      }
      const m = meta(vaultId);
      if (!m) return;
      const now = clock();
      // No lapse deletion here (spec 5.4): blocking never deletes data.
      prune(m, now);
      sweepOrphanFiles(vaultId, now);
    },

    sweep() {
      for (const r of q.pendingWipes.all() as { vault_id: string }[]) finishWipe(r.vault_id);
      const cutoff = clock() - ORPHAN_SNAPSHOT_AGE_SECONDS;
      for (const dir of snapshots.listVaultDirs()) {
        if (dir.mtime >= cutoff || meta(dir.vaultId) || q.pendingWipe.get(dir.vaultId)) continue;
        try {
          snapshots.removeVault(dir.vaultId);
        } catch {
          // Tried again on the next sweep.
        }
      }
    },

    listIds: () => (q.allIds.all() as { vault_id: string }[]).map((r) => r.vault_id),

    listByAccount: (account) =>
      (q.byAccount.all(account) as { vault_id: string; bytes: number; last_activity: number | null }[]).map(
        (r) => ({ vaultId: r.vault_id, bytes: r.bytes, lastActivity: r.last_activity }),
      ),

    wipe,

    usage: () =>
      (
        q.usage.all() as {
          vault_id: string;
          account: string;
          last_activity: number | null;
          total: number;
          files: number;
        }[]
      ).map((r) => ({
        vaultId: r.vault_id,
        account: r.account,
        bytes: r.total,
        files: r.files,
        lastActivity: r.last_activity,
      })),

    dropAccount: atomic((account: string) => {
      const ids = (q.byAccount.all(account) as { vault_id: string }[]).map((r) => r.vault_id);
      for (const id of ids) dropRows(id);
      return ids;
    }),

    finishWipes(vaultIds) {
      for (const id of vaultIds) finishWipe(id);
    },
  };
}
