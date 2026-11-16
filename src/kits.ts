// The Recovery Kit: per vault one opaque envelope (the apps seal every vault key to the Kit) and
// the SHA-256 of the Kit's own token. The Kit token reads the envelope and nothing else; a vault
// token never reads it. The envelope is set up with PUT /kit and replaced at every token
// rotation (vaults.ts), in the rotation's transaction. A replaced Kit token is remembered as a
// hash (the newest 256 per vault) so it answers 410 kit_replaced instead of 401.

import { createHash } from "node:crypto";
import type { Clock } from "./clock.js";
import type { Db } from "./db.js";
import { base64DecodedLength, decodeBase64, encodeBase64, timingSafeEqualStr } from "./encoding.js";
import { fail, type Failure, type Result } from "./http.js";
import { MAX_KIT_ENVELOPE_BYTES, MAX_KIT_RETIRED_KEPT, READ_GRACE_SECONDS } from "./limits.js";
import type { People } from "./people.js";
import type { Vaults } from "./vaults.js";

export const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");
const asBuffer = (u: Uint8Array): Buffer => Buffer.from(u.buffer, u.byteOffset, u.byteLength);

export interface KitRow {
  token_hash: string;
  envelope: Buffer;
  since: number;
  updated_at: number;
  last_read: number | null;
}

/** The Kit as vault info reports it. */
export type KitInfo = { since: number; lastRead: number | null };

/** The Kit's rows. Every call runs on the caller's connection and joins its transaction. */
export function kitRows(db: Db) {
  const q = {
    get: db.prepare("SELECT token_hash, envelope, since, updated_at, last_read FROM kits WHERE vault_id = ?"),
    retired: db.prepare("SELECT retired_at FROM kits_retired WHERE vault_id = ? AND token_hash = ?"),
    insert: db.prepare(
      "INSERT INTO kits (vault_id, token_hash, envelope, since, updated_at, last_read) VALUES (?, ?, ?, ?, ?, NULL)",
    ),
    setEnvelope: db.prepare("UPDATE kits SET envelope = ?, updated_at = ? WHERE vault_id = ?"),
    setKit: db.prepare(
      "UPDATE kits SET token_hash = ?, envelope = ?, since = ?, updated_at = ?, last_read = NULL WHERE vault_id = ?",
    ),
    retire: db.prepare("INSERT INTO kits_retired (vault_id, token_hash, retired_at) VALUES (?, ?, ?)"),
    pruneRetired: db.prepare(
      `DELETE FROM kits_retired WHERE vault_id = ? AND rowid NOT IN (
         SELECT rowid FROM kits_retired WHERE vault_id = ? ORDER BY retired_at DESC, rowid DESC LIMIT ?)`,
    ),
    markRead: db.prepare("UPDATE kits SET last_read = ? WHERE vault_id = ?"),
    // Any token the vault has had and still remembers, whatever its age: a Kit token may never
    // be one of them.
    vaultToken: db.prepare(
      `SELECT 1 FROM vaults WHERE vault_id = ? AND token_hash = ?
       UNION ALL SELECT 1 FROM prev_tokens WHERE vault_id = ? AND token_hash = ? LIMIT 1`,
    ),
  };
  return {
    get: (vaultId: string): KitRow | null => (q.get.get(vaultId) as KitRow | undefined) ?? null,
    retiredAt(vaultId: string, tokenHash: string): number | null {
      const r = q.retired.get(vaultId, tokenHash) as { retired_at: number } | undefined;
      return r ? r.retired_at : null;
    },
    info(vaultId: string): KitInfo | null {
      const k = q.get.get(vaultId) as KitRow | undefined;
      return k ? { since: k.since, lastRead: k.last_read } : null;
    },
    /** True when the hash is the current Kit token's or a remembered replaced one's. */
    isKitHash(vaultId: string, tokenHash: string): boolean {
      const k = q.get.get(vaultId) as KitRow | undefined;
      if (k && timingSafeEqualStr(k.token_hash, tokenHash)) return true;
      return q.retired.get(vaultId, tokenHash) !== undefined;
    },
    isVaultHash: (vaultId: string, tokenHash: string): boolean =>
      q.vaultToken.get(vaultId, tokenHash, vaultId, tokenHash) !== undefined,
    insert(vaultId: string, tokenHash: string, envelope: Uint8Array, now: number): void {
      q.insert.run(vaultId, tokenHash, asBuffer(envelope), now, now);
    },
    replaceEnvelope(vaultId: string, envelope: Uint8Array, now: number): void {
      q.setEnvelope.run(asBuffer(envelope), now, vaultId);
    },
    /** A new Kit: the old token hash (if any) is retired, the newest 256 retired hashes kept. */
    replaceKit(vaultId: string, tokenHash: string, envelope: Uint8Array, now: number): void {
      const old = q.get.get(vaultId) as KitRow | undefined;
      if (!old) {
        q.insert.run(vaultId, tokenHash, asBuffer(envelope), now, now);
        return;
      }
      q.retire.run(vaultId, old.token_hash, now);
      q.pruneRetired.run(vaultId, vaultId, MAX_KIT_RETIRED_KEPT);
      q.setKit.run(tokenHash, asBuffer(envelope), now, now, vaultId);
    },
    markRead(vaultId: string, minute: number): void {
      q.markRead.run(minute, vaultId);
    },
  };
}

export type KitRows = ReturnType<typeof kitRows>;

/** An envelope from a request: padded standard base64, 1 byte to 256 KiB decoded. The size is
 *  judged from the string alone, so nothing oversized is decoded. */
export function parseEnvelope(value: unknown): Uint8Array | "invalid" | "too_large" {
  if (typeof value !== "string" || value.length === 0 || value.length % 4 !== 0) return "invalid";
  if (base64DecodedLength(value) > MAX_KIT_ENVELOPE_BYTES) return "too_large";
  const bytes = decodeBase64(value);
  return bytes && bytes.length > 0 ? bytes : "invalid";
}

export type KitRead = { envelope: string; since: number; updatedAt: number };
export type KitReplaced = Failure & { error: "kit_replaced"; replacedAt: number };

export interface Kits {
  /** PUT /kit: the current vault token sets the Kit up (201), or replaces the envelope of the
   *  same Kit token (a retried setup, 200). */
  put(vaultId: string, vaultToken: string, kitToken: string, envelope: Uint8Array): Result<{ created: boolean }>;
  /** GET /kit with the Kit token. Never looks at vault tokens. */
  read(vaultId: string, kitToken: string): Result<KitRead> | KitReplaced;
}

export function createKits(db: Db, clock: Clock, people: People, vaults: Vaults): Kits {
  const rows = kitRows(db);
  const accountOf = db.prepare("SELECT account FROM vaults WHERE vault_id = ?");

  const put = db.transaction(
    (vaultId: string, vaultToken: string, kitToken: string, envelope: Uint8Array): Result<{ created: boolean }> => {
      const auth = vaults.authorize(vaultId, vaultToken, "owner");
      if (!auth.ok) return auth;
      const now = clock();
      const hash = sha256(kitToken);
      const current = rows.get(vaultId);
      if (current && timingSafeEqualStr(current.token_hash, hash)) {
        rows.replaceEnvelope(vaultId, envelope, now);
        return { ok: true, created: false };
      }
      if (rows.isVaultHash(vaultId, hash) || rows.retiredAt(vaultId, hash) !== null) {
        return fail(400, "invalid_kit_token");
      }
      if (current) return fail(409, "kit_exists");
      rows.insert(vaultId, hash, envelope, now);
      return { ok: true, created: true };
    },
  );

  return {
    put: (vaultId, vaultToken, kitToken, envelope) => put(vaultId, vaultToken, kitToken, envelope),

    read(vaultId, kitToken) {
      const vault = accountOf.get(vaultId) as { account: string } | undefined;
      if (!vault) return fail(404, "vault_not_found");
      const now = clock();
      const hash = sha256(kitToken);
      const kit = rows.get(vaultId);
      if (!kit || !timingSafeEqualStr(kit.token_hash, hash)) {
        const replacedAt = rows.retiredAt(vaultId, hash);
        if (replacedAt !== null) return { ok: false, status: 410, error: "kit_replaced", replacedAt };
        return fail(401, "unauthorized");
      }
      // The read rule of vaults: until 30 days after the entitlement ended.
      const paidUntil = people.paidUntil(vault.account) ?? 0;
      if (paidUntil + READ_GRACE_SECONDS <= now) return fail(402, "payment_required");
      const minute = now - (now % 60);
      if (kit.last_read !== minute) rows.markRead(vaultId, minute);
      return {
        ok: true,
        envelope: encodeBase64(new Uint8Array(kit.envelope.buffer, kit.envelope.byteOffset, kit.envelope.byteLength)),
        since: kit.since,
        updatedAt: kit.updated_at,
      };
    },
  };
}
