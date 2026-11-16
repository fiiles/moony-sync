import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";

export type Db = Database.Database;

/** Append-only. MIGRATIONS[i] is schema version i + 1; never edit an entry once released. */
export const MIGRATIONS: readonly string[] = [
  // 1: people (one row per account holder; the account number is the login).
  `CREATE TABLE people (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('active', 'blocked')),
    account TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    blocked_at INTEGER
  )`,
  // 2: vaults and everything a vault owns. Vault data lives in
  // shared tables keyed by vault_id; deleting a vault row cascades to its children. Snapshot
  // contents live in files (snapshots/<vault id>/<file>); `snapshots` holds their records.
  // pending_wipes remembers a deletion whose files could not be removed yet.
  `CREATE TABLE vaults (
    vault_id TEXT PRIMARY KEY,
    account TEXT NOT NULL,
    token_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    head INTEGER NOT NULL DEFAULT 0,
    floor INTEGER NOT NULL DEFAULT 0,
    snapshot_seq INTEGER NOT NULL DEFAULT -1,
    bytes INTEGER NOT NULL DEFAULT 0,
    rotation INTEGER NOT NULL DEFAULT 0,
    last_activity INTEGER
  );
  CREATE INDEX vaults_by_account ON vaults (account);
  CREATE TABLE ops (
    vault_id TEXT NOT NULL REFERENCES vaults (vault_id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    op_id TEXT NOT NULL,
    ct BLOB NOT NULL,
    size INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (vault_id, seq),
    UNIQUE (vault_id, op_id)
  );
  CREATE TABLE prev_tokens (
    vault_id TEXT NOT NULL REFERENCES vaults (vault_id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL,
    rotated_at INTEGER NOT NULL,
    PRIMARY KEY (vault_id, token_hash)
  );
  CREATE TABLE rekeys (
    vault_id TEXT NOT NULL REFERENCES vaults (vault_id) ON DELETE CASCADE,
    rotation INTEGER NOT NULL,
    head INTEGER NOT NULL,
    at INTEGER NOT NULL,
    rekey BLOB NOT NULL,
    PRIMARY KEY (vault_id, rotation)
  );
  CREATE TABLE snapshots (
    vault_id TEXT NOT NULL REFERENCES vaults (vault_id) ON DELETE CASCADE,
    file TEXT NOT NULL,
    seq INTEGER NOT NULL,
    size INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (vault_id, file)
  );
  CREATE TABLE pending_wipes (vault_id TEXT PRIMARY KEY)`,
  // 3: pairing mailboxes. A row exists only after a valid first write. state 'gone' is the
  // tombstone (no slots, gone_at says when the 24 hours started).
  `CREATE TABLE mailboxes (
    id TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('open', 'gone')),
    gone_at INTEGER
  );
  CREATE TABLE mailbox_slots (
    mailbox_id TEXT NOT NULL REFERENCES mailboxes (id) ON DELETE CASCADE,
    slot INTEGER NOT NULL CHECK (slot IN (1, 2, 3)),
    data BLOB NOT NULL,
    consumed INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (mailbox_id, slot)
  )`,
  // 4: the admin. At most one admin row (id is always 1). totp_secret is the active second
  // factor, totp_pending a secret being enrolled, totp_step the newest step already accepted
  // (a code cannot be used twice). Sessions and backup codes are stored as SHA-256 only.
  // settings is the home of small server-wide values: the setup code `reset-admin` writes,
  // and the settings the admin edits later.
  `CREATE TABLE admin (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    totp_secret TEXT,
    totp_pending TEXT,
    totp_step INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE admin_sessions (
    token_hash TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    last_used INTEGER NOT NULL
  );
  CREATE TABLE backup_codes (code_hash TEXT PRIMARY KEY);
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  // 5: who wrote a pairing slot, as a SHA-256 of the client key (never the address), so one
  // client's share of the slots can be capped. Cleared when the slot is read or burnt.
  `ALTER TABLE mailbox_slots ADD COLUMN client TEXT`,
  // 6: blob (attachment) records; contents in blobs/<vault id>/<blob id>.
  `CREATE TABLE blobs (
    vault_id TEXT NOT NULL REFERENCES vaults (vault_id) ON DELETE CASCADE,
    blob_id TEXT NOT NULL,
    size INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (vault_id, blob_id)
  )`,
  // 7: the Recovery Kit. One Kit per vault: the SHA-256 of its token (never the token) and the
  // envelope the apps seal to it (opaque). Replaced Kit tokens are remembered as hashes, the
  // newest 256 per vault, so they can answer "replaced" instead of "unknown".
  `CREATE TABLE kits (
    vault_id TEXT PRIMARY KEY REFERENCES vaults (vault_id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL,
    envelope BLOB NOT NULL,
    since INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    last_read INTEGER
  );
  CREATE TABLE kits_retired (
    vault_id TEXT NOT NULL REFERENCES vaults (vault_id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL,
    retired_at INTEGER NOT NULL,
    PRIMARY KEY (vault_id, token_hash)
  )`,
];

/** Opens (creating it if needed) the database in `dataDir`, migrates it to the current
 *  schema, and refuses one written by a newer server. */
export function openDb(dataDir: string): Db {
  mkdirSync(dataDir, { recursive: true });
  const db = new Database(`${dataDir}/moony-sync.db`);
  try {
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    db.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY)");
    const row = db.prepare("SELECT MAX(version) AS v FROM schema_version").get() as {
      v: number | null;
    };
    const current = row.v ?? 0;
    if (current > MIGRATIONS.length) throw new Error("database_newer_than_server");
    for (let v = current + 1; v <= MIGRATIONS.length; v++) {
      db.transaction(() => {
        db.exec(MIGRATIONS[v - 1]!);
        db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(v);
      })();
    }
  } catch (e) {
    db.close();
    throw e;
  }
  return db;
}
