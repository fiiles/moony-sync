// Blob records: (vault, blob ID, size, upload time). The contents live in blob files; the record
// is what makes a blob exist. The file is published (renamed) inside the transaction that inserts
// the record, so a record never points at a missing file and a vault wiped meanwhile leaves nothing.

import type { BlobFiles } from "./blob-files.js";
import type { Clock } from "./clock.js";
import type { Db } from "./db.js";
import { fail, type Result } from "./http.js";
import type { Vaults } from "./vaults.js";

export type BlobRecord = { id: string; size: number; createdAt: number };

export interface Blobs {
  /** Side-effect free, before any body byte: vaults.check(write), then whether the record exists. */
  check(vaultId: string, token: string, blobId: string): Result<{ exists: boolean }>;
  /** One transaction: vaults.authorize(write); record exists → { created: false } (publish NOT
   *  called); else publish() (the rename) and insert (vault_id, blob_id, size, clock()). A throw
   *  from publish rolls back and propagates. */
  commit(
    vaultId: string,
    token: string,
    blobId: string,
    size: number,
    publish: () => void,
  ): Result<{ created: boolean }>;
  /** vaults.authorize(read), then the record; 404 blob_not_found without one. */
  find(vaultId: string, token: string, blobId: string): Result<{ size: number; createdAt: number }>;
}

export function createBlobs(db: Db, clock: Clock, vaults: Vaults, _files: BlobFiles): Blobs {
  const q = {
    one: db.prepare("SELECT size, created_at FROM blobs WHERE vault_id = ? AND blob_id = ?"),
    insert: db.prepare(
      "INSERT INTO blobs (vault_id, blob_id, size, created_at) VALUES (?, ?, ?, ?)",
    ),
  };
  const row = (vaultId: string, blobId: string) =>
    q.one.get(vaultId, blobId) as { size: number; created_at: number } | undefined;

  const doCommit = db.transaction(
    (
      vaultId: string,
      token: string,
      blobId: string,
      size: number,
      publish: () => void,
    ): Result<{ created: boolean }> => {
      const auth = vaults.authorize(vaultId, token, "write");
      if (!auth.ok) return auth;
      if (row(vaultId, blobId)) return { ok: true, created: false };
      publish();
      q.insert.run(vaultId, blobId, size, clock());
      return { ok: true, created: true };
    },
  );

  return {
    check(vaultId, token, blobId) {
      const allowed = vaults.check(vaultId, token, "write");
      if (!allowed.ok) return allowed;
      return { ok: true, exists: row(vaultId, blobId) !== undefined };
    },

    commit: (vaultId, token, blobId, size, publish) =>
      doCommit(vaultId, token, blobId, size, publish),

    find(vaultId, token, blobId) {
      const auth = vaults.authorize(vaultId, token, "read");
      if (!auth.ok) return auth;
      const r = row(vaultId, blobId);
      return r ? { ok: true, size: r.size, createdAt: r.created_at } : fail(404, "blob_not_found");
    },
  };
}
