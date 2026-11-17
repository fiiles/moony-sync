// Every tunable number of protocol v1 in one place. DESIGN.md mirrors this table.

export const DAY = 24 * 60 * 60;

export const MAX_OP_BYTES = 192 * 1024;
export const MAX_OPS_PER_PUSH = 500;
export const MAX_PUSH_BODY_BYTES = 4 * 1024 * 1024;
export const DEFAULT_PULL_LIMIT = 500;
export const MAX_PULL_LIMIT = 1000;
export const MAX_PULL_BYTES = 4 * 1024 * 1024;
/** Decoded size of a rekey bundle. */
export const MAX_REKEY_BYTES = 256 * 1024;
/** Rekey bundles a vault keeps at once; housekeeping frees slots after 30 days. */
export const MAX_REKEYS_KEPT = 32;
export const DEFAULT_REKEY_LIMIT = 8;
export const MAX_REKEY_LIMIT = 32;
/** A /rekey page is cut once its bundles add up to this many decoded bytes. */
export const MAX_REKEY_PAGE_BYTES = 4 * 1024 * 1024;
export const MAX_VAULT_OP_BYTES = 256 * 1024 * 1024;
export const MAX_SNAPSHOT_BYTES = 100 * 1024 * 1024;
export const SNAPSHOTS_KEPT = 2;
export const MAX_VAULTS_PER_ACCOUNT = 5;

/** Ops already covered by a snapshot are pruned once they are this old. */
export const OP_RETENTION_SECONDS = 30 * DAY;
/** A lapsed vault stays readable this long after `paid_until`. */
export const READ_GRACE_SECONDS = 30 * DAY;
/** A token that a rotation retired stays valid, read-only, this long; its rekey bundle is
 *  kept as long. */
export const PREVIOUS_TOKEN_SECONDS = 30 * DAY;
/** Self-hosted mode: `paid_until` of an account on the allow-list (year 9999, never expires). */
export const SELF_HOSTED_PAID_UNTIL = 253402300799;
/** How often the daily housekeeping runs. */
export const HOUSEKEEPING_INTERVAL_SECONDS = DAY;
/** A snapshot or blob file with no record this old is an abandoned upload. */
export const ORPHAN_SNAPSHOT_AGE_SECONDS = 60 * 60;

/** Pairing mailbox: a slot holds a public key or a sealed credentials blob. */
export const MAX_MAILBOX_SLOT_BYTES = 64 * 1024;
/** A mailbox is burnt this long after its first write. */
export const MAILBOX_TTL_SECONDS = 10 * 60;
/** A burnt mailbox keeps a tombstone (so its ID cannot be reused) this long. */
export const MAILBOX_TOMBSTONE_SECONDS = DAY;

/** Request bodies buffered in memory at once (sync + admin API); more answers 503 busy. */
export const MAX_INFLIGHT_BODY_BYTES = 64 * 1024 * 1024;
/** Bytes stored in open pairing mailbox slots; a PUT past it answers 503 busy. */
export const MAX_MAILBOX_TOTAL_BYTES = 64 * 1024 * 1024;
/** How often expired pairing mailboxes are emptied. */
export const MAILBOX_SWEEP_INTERVAL_SECONDS = 60;
/** A request body that delivers no bytes for this long is aborted (408 body_timeout). */
export const IDLE_BODY_SECONDS = 30;
/** Arrived-and-held request body bytes one client key may account for at once. */
export const MAX_INFLIGHT_BODY_CLIENT_BYTES = 8 * 1024 * 1024;
/** Bytes one client (IPv4 address or IPv6 /64) may hold in open pairing slots. */
export const MAX_MAILBOX_CLIENT_BYTES = 8 * 1024 * 1024;
/** Every stored op is charged its ciphertext plus this much against the vault's op quota. */
export const OP_OVERHEAD_BYTES = 128;
/** Uploads are refused (507 server_full) when they would leave less than this free on the data volume. */
export const FREE_SPACE_FLOOR_BYTES = 1024 ** 3;

/** Largest blob content the apps seal: 100 MiB. */
export const MAX_BLOB_CONTENT_BYTES = 100 * 1024 * 1024;
/** Largest stored blob: the app's stream format is a 59-byte header plus the content in 64 KiB
 *  chunks, each chunk (the last one included) carrying a 16-byte tag. = 104,883,275. */
export const MAX_BLOB_BYTES =
  MAX_BLOB_CONTENT_BYTES + 59 + 16 * (Math.floor(MAX_BLOB_CONTENT_BYTES / 65536) + 1);
/** Per-vault blob quota unless the admin changes the `blob_quota_bytes` setting. */
export const DEFAULT_BLOB_QUOTA_BYTES = 10 * 1024 ** 3;
export const MAX_BLOB_QUOTA_BYTES = 2 ** 50;
export const MAX_BLOB_UPLOADS_PER_VAULT = 2;
export const DEFAULT_BLOB_LIST_LIMIT = 500;
export const MAX_BLOB_LIST_LIMIT = 1000;

/** Decoded size of a Recovery Kit envelope (opaque ciphertext the apps seal to the Kit). */
export const MAX_KIT_ENVELOPE_BYTES = 256 * 1024;
/** Replaced Kit tokens a vault remembers (so they answer 410 kit_replaced); the oldest go first. */
export const MAX_KIT_RETIRED_KEPT = 256;
/** GET /kit calls per client key and minute, counted before the token is looked at: a generous
 *  backstop only, since behind a proxy without TRUST_PROXY every client shares one key. */
export const KIT_READS_PER_MINUTE = 120;
/** Failed GET /kit attempts (401, 404; never 410) per client key and minute; a right token is
 *  never refused by it. */
export const KIT_CLIENT_FAILURES_PER_MINUTE = 10;
/** Failed GET /kit attempts (401 only) per vault and hour; a right token is never refused by it. */
export const KIT_VAULT_FAILURES_PER_HOUR = 30;
