# Moony sync server — design (protocol v1.1)

The sync server keeps Moony devices in sync. It **stores and forwards ciphertext it cannot read**.
Every Moony device keeps its own encrypted database; devices exchange encrypted change records
("ops") through the server, and a new device bootstraps from an encrypted snapshot.

You run it yourself (see `README.md`). It is one Node process with one data folder, a web admin
for the person who runs it, and the sync API the Moony apps talk to. User-facing wording is "sync
server"; "relay" is the internal name from when it was a hosted service and survives in the
repository name and some code.

`GET /v1/server` answers `protocol: 2`: the sync API of v1.1 below, plus the server-address
discovery and the changes in "Changes to the v1.1 API". An app that needs that protocol refuses an
older server.

## Principles

1. **Zero knowledge of content.** The server sees opaque bytes. Encryption, signatures, conflict
   resolution (per-column last-writer-wins on a hybrid logical clock) and integrity checks all live
   in the Moony client. The server never parses an op.
2. **Minimal metadata.** No e-mail, no device names, no analytics, no client addresses in logs or
   storage. What the server does hold is listed under *What the server knows*.
3. **The server is untrusted.** It can drop, delay, replay or roll back ops; clients must detect
   that (signed per-device sequence numbers and hash chains inside the ciphertext). The server's
   job is availability and ordering, not trust. Nothing here asks a device to trust it more.
4. **No outbound connections.** The server only answers requests.
5. **Boring.** One process, SQLite in WAL mode, snapshot files on disk, in-memory rate limits.

## Shape

One process, one port (default 8787):

| Path | What |
|---|---|
| `/v1/...` | The sync API for the apps (below). |
| `/admin/api/...` | The admin API, session cookie. |
| `/` | The admin web interface (static files built into the image), with a strict content security policy. |
| `/health` | `{"ok": true}`, no auth. |

### Storage layout

Everything is in `DATA_DIR` (`/data` in the image):

```
moony-sync.db            SQLite, WAL mode (+ moony-sync.db-wal, -shm), foreign keys on
snapshots/<vault id>/<seq>-<uuid>     snapshot files, up to 100 MiB, the newest two kept per vault
```

- The database holds the people, vaults (token hash, head, floor, rotation, last activity), ops,
  previous tokens, rekey bundles, snapshot records, pairing mailboxes and their slots, the admin,
  admin sessions, backup codes and settings. Deleting a vault row cascades to everything the vault
  owns. Timestamps are unix seconds.
- Schema changes are numbered, append-only migrations run at start. A server never starts on a
  database newer than it knows (`database_newer_than_server`).
- A snapshot upload streams to `<name>.tmp` in the vault's directory, is fsynced, then renamed,
  and the directory is fsynced; a crash never leaves a half file under a real name. If the
  directory sync fails after the rename the new file is removed again. The record for the file is
  written afterwards; a file without a record is an abandoned upload and housekeeping removes it
  once it is an hour old.
- Time comes from one injected clock (unix seconds); every time-based rule is enforced at request
  time as well as by housekeeping, so a stopped server misses nothing.

### Configuration

Environment variables, all optional. Everything else is set in the admin and stored in the
database.

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8787` | Listening port (0–65535; anything else stops the server at start) |
| `DATA_DIR` | `/data` | Database and snapshots |
| `PUBLIC_URL` | unset | The address apps use; the address saved in the admin takes precedence |
| `TRUST_PROXY` | `0` | `1` behind one reverse proxy: the client address, scheme and host come from the **last** entry of `X-Forwarded-For` / `-Proto` / `-Host` |
| `REQUIRE_2FA` | `0` | `1` makes the admin's second factor mandatory |
| `SETUP_CODE` | random | Fixed first-run setup code; ignored once an admin exists |

`TRUST_PROXY` and `REQUIRE_2FA` accept `1`, `0`, `true`, `false` in any case; any other non-empty
value stops the server at start with a one-line message, because guessing what "yes" means could
silently leave a security setting off.

The client address (rate-limit key) is the socket address, or the last `X-Forwarded-For` entry
only when `TRUST_PROXY=1`. The last entry is the one a single trusted proxy appended itself; the
earlier ones are whatever the client sent. That is why exactly one proxy may stand in front.

### Logging

stdout: the start-up line (`moony-sync <version> listening on port <n>`), the setup code while no
admin exists, `housekeeping: <step> failed` (no IDs), `unhandled error: <error name>` (the name
only, never the message, which could carry a path), `shutdown: WAL checkpoint failed`, and the
HTTP library's note that a client aborted a request. A refused start (a bad setting, or a
database written by a newer server) prints one line to stderr and exits with status 1, without a
stack trace. Never account numbers, tokens, vault or mailbox IDs, file paths or client addresses.

### Shutdown

On SIGTERM or SIGINT the server stops housekeeping, finishes open requests (idle connections are
closed), checkpoints the WAL and exits; it leaves on its own after 10 seconds regardless.
Snapshot uploads may run up to 15 minutes (request timeout), headers must arrive within 30 seconds.

## People and accounts

- A **person** is a row the admin creates: a name (1–80 characters, counted in Unicode code
  points, trimmed), a state (`active` or `blocked`), a creation time, the time of the block, and
  exactly one **account number** generated by the server.
- The 16-digit account number is the credential the app sends (`Moony-Account`). A person's
  **connection code** is the server address plus that number.
- Apps cannot create accounts: `POST /v1/accounts` answers `403 registration_closed`. The admin
  creating the person is the admission.
- A vault belongs to an account. An account may own up to 5 vaults (profiles).
- The server stores per vault the time of the last authorised request, rounded down to the minute.
  Device names and counts stay invisible to it.

| Thing | Format | Who creates it | Secret? |
|---|---|---|---|
| Account number | 16 digits | the server, when the admin adds a person | yes — it is the account credential, stored in clear (the admin can show the connection code again) |
| Vault ID | 22 chars base64url (128 random bits) | client | no (routing key) |
| Vault token | 43 chars base64url (256 bits) | client, derived from the vault key | yes — the server stores only its SHA-256 |
| Op ID | 1–64 chars base64url | client | no (idempotency key) |
| Mailbox ID | 22 chars base64url | client | no (random routing key) |

A **vault** is one encrypted Moony profile. The **vault token** proves the caller holds the vault
key. Revoking a device = the client creates a new vault key epoch and calls
`POST /v1/vaults/:id/token` with the new token and a **rekey bundle** (opaque ciphertext the
server stores for the other devices). The retired token stays valid, read-only, for 30 days so
devices that have not noticed yet can still pull and fetch the bundle; then it is forgotten.

### Entitlement seam

`people.paidUntil(account)` is the single decision point for "until when is this account
entitled". Every rule below hangs on it, and it is the only place a different entitlement source
would plug in.

- `active` person → a far-future constant (year 9999, never expires).
- `blocked` person → the time of the block (a repeated block keeps the first time). Unblocking
  restores the constant. Unknown account → none (`404 account_not_found`).
- **Writes** (push ops, snapshots, creating a vault) need `paidUntil > now` and the current token:
  `402 payment_required` otherwise.
- **Reads** (pull ops, fetch snapshot, rekey bundles, vault info) are allowed until 30 days after
  `paidUntil`, so a blocked person's device can still be restored.
- **Token rotation and vault deletion** need the current token only, no entitlement. A previous
  (read-only) token can do neither.
- **Blocking never deletes.** There is no retention deletion by age: data goes when the admin
  deletes the person or a profile, or the app deletes its vault. After the 30 days, reads of a
  blocked person answer as for any lapsed account until the person is unblocked.
- **Deleting a person** removes the person, all their vault rows and then their snapshot files, in
  one step from the callers' point of view: from the commit on, vault calls answer
  `404 vault_not_found` (the app shows "the synced data were deleted") and the connection code
  answers `404 account_not_found`.

## Admin

### Authentication

- **First run.** With no admin in the database the server prints a setup code to the log at every
  start: a new random one each time (or `SETUP_CODE`), except that a code written by `reset-admin`
  stays valid across restarts until it is used. The web interface shows only the setup page: setup code, admin name, password (at
  least 10, at most 1024 characters). Until setup is done nothing else under `/admin/api`
  answers.
- **Login.** Name and password. The password is stored as an Argon2id hash. Session cookie
  `moony_admin`: `HttpOnly`, `SameSite=Strict`, `Secure` when the request came over https (the URL
  scheme, or `X-Forwarded-Proto` from a trusted proxy). The cookie value is stored only as SHA-256.
  A session ends after 12 hours without use, on logout, on "log out everywhere" and after reset.
- **CSRF.** Every state-changing admin call (anything but `GET`) needs an `Origin` header whose host
  is the host the request was sent to; otherwise `403 bad_origin`.
- **Second factor.** TOTP (RFC 6238) with 10 one-time backup codes shown once at enrolment.
  Enrolment and disabling ask for the password again. A code cannot be used twice. The secret is
  stored as it is (it has to be readable to check codes); only the database and its backups hold
  it. With `REQUIRE_2FA=1` a session can reach only the enrolment calls until a second factor
  exists (`403 enrol_2fa`), and it cannot be turned off.
- **Guessing.** Setup code, password and second-factor attempts are counted per client address (5
  per 15 minutes) and across all clients (50 per 15 minutes); beyond that `429 rate_limited`.
  Argon2 work is limited to 4 concurrent verifications. The counters live in memory: a lockout
  lasts up to 15 minutes or until restart.
- **Lost password or second factor.** `moony-sync reset-admin` (in the container:
  `docker exec <container> moony-sync reset-admin`) deletes the admin, all sessions and backup
  codes, stores a fresh setup code and prints it. A running server uses the new code on its next
  call. People, accounts and data are untouched. It does not clear the in-memory counters.
- One admin; no roles.
- Over plain http the admin password and session cookie cross the network in clear text; the
  overview reports `insecure` when the page was loaded over http from a host other than
  `localhost`, `127.0.0.1` or `[::1]`.

### Admin API

All bodies are JSON; errors are `{"error": "<code>"}`. Bodies are limited to 16 KiB. Account
numbers never appear in answers, except inside a connection code.

| Method | Path | Notes |
|---|---|---|
| `GET` | `/admin/api/state` | Public. `{setupNeeded, authenticated, name?, twoFactor, require2fa, mustEnrol2fa}` |
| `POST` | `/admin/api/setup` | Public. `{code, name, password}` → `204` and the session cookie. `401 bad_code`, `403 setup_done`, `400 weak_password` |
| `POST` | `/admin/api/login` | Public. `{name, password, totp?}` → `204` and the cookie. `401 bad_credentials` / `totp_required` / `bad_totp`. `totp` is a code or a backup code. |
| `POST` | `/admin/api/logout` | `204`; ends this session |
| `POST` | `/admin/api/logout-all` | `204`; ends every session |
| `POST` | `/admin/api/password` | `{current, next}` → `204`; ends the other sessions |
| `POST` | `/admin/api/2fa/enrol` | `{password}` → `{secret, otpauthUrl}` |
| `POST` | `/admin/api/2fa/confirm` | `{totp}` → `{backupCodes}` (shown once) |
| `POST` | `/admin/api/2fa/disable` | `{password}` → `204`; `403 required` when `REQUIRE_2FA=1` |
| `GET` | `/admin/api/overview` | `{address, addressSuggestion, people, profiles, bytesUsed, bytesFree, lastActivity, version, insecure}` |
| `GET` | `/admin/api/people` | `[{id, name, state, profiles, bytes, lastActivity, createdAt}]` |
| `POST` | `/admin/api/people` | `{name}` → `201 {person, connectionCode}`. `400 invalid_name`; `409 address_not_set` until an address is saved or `PUBLIC_URL` is set |
| `GET` | `/admin/api/people/:id` | The person plus `vaults: [{id, shortId, bytes, lastActivity}]` |
| `PATCH` | `/admin/api/people/:id` | Exactly one of `{name}` (`400 invalid_name`, also for a non-string) or `{state: "active" \| "blocked"}` |
| `POST` | `/admin/api/people/:id/connection-code` | `{password}` → `{connectionCode}`; the same password check and attempt limit as login |
| `DELETE` | `/admin/api/people/:id` | `204`; removes the person, their vaults and snapshot files |
| `DELETE` | `/admin/api/people/:id/vaults/:vaultId` | `204`; removes one profile of that person |
| `GET` | `/admin/api/settings` | `{publicUrl}` (the saved address or `null`) |
| `PUT` | `/admin/api/settings` | `{publicUrl: string \| null}` → the normalised value; `400 invalid_address` |
| `GET` | `/admin/api/backup` | `application/x-tar`, `moony-sync-backup-<YYYYMMDD-HHmm>.tar` (UTC) |

Every route except the three public ones needs a session (`401 unauthorized`).

### Address apps use

The server cannot know how it is reached from outside. The address in connection codes is, in
order: the value saved in Settings; else `PUBLIC_URL`; else none, and adding people answers
`409 address_not_set` until the admin confirms one (the page pre-fills the origin the browser is
using). The address is normalised as in the connection code. Changing it does not break joined
devices; they keep the address they have.

### Connection code

```
moony-sync1:<16-digit account>:<base64url, no padding, of the UTF-8 normalised server address>
```

The address: `http` or `https`, a host, no user, password, query, fragment or path (a trailing `/`
is dropped), lowercase host, default port dropped, no backslash anywhere, at most 256 characters.
A decoder accepts only the canonical encoding. The code is shown as text and as a QR code. It is
a credential: it lets whoever holds it create up to 5 profiles and fill the person's space; it
cannot read an existing profile (vault calls need the vault token) and cannot decrypt anything. It
is not single-use. Revocation is blocking or deleting the person.

### Backup

`GET /admin/api/backup` streams a ustar archive: `moony-sync.db` (an SQLite online-backup copy,
consistent while the server runs, taken into a temporary file in `DATA_DIR` that is removed when
the download ends, fails or is abandoned, and by the next start) and
`snapshots/<vault id>/<file>` for every snapshot file, streamed from disk, with directory entries
for `snapshots/` and each vault directory. Every entry is owned by uid/gid 1000 (the container's
`node` user), files are mode 0600 and directories 0700, so extracting as root still gives files the
container can use. `HEAD` answers the headers without building a copy. A single file of 8 GiB
or more is refused with an error instead of writing a corrupt header. The archive holds account
numbers and the second-factor secret in clear: keep it private. Restore is manual: stop the
server, replace the contents of `DATA_DIR`, start. Restoring an older archive makes every device
report that the sync server went back.

## Changes to the v1.1 API

The sync API is the v1.1 API (below) with these differences from the hosted relay it came from:

| Change | Detail |
|---|---|
| `GET /v1/server` | No auth. → `{"name": "moony-sync", "version": "<semver>", "protocol": 2, "mode": "self_hosted"}`. The app uses it to confirm an address is a Moony sync server. Rate-limited like account lookups. |
| `POST /v1/accounts` | `403 registration_closed`. |
| `POST /v1/accounts/me/checkout` | `409 self_hosted` (so older app builds keep working); `400 missing_account` without the header. |
| `DELETE /v1/accounts/me` | `403 managed_by_operator`: the admin owns the person record. |
| Webhooks | There are none; the paths answer `404 not_found`. |
| Rate-limit key | The socket address, or the last `X-Forwarded-For` entry with `TRUST_PROXY=1`. |

## HTTP API

All bodies are JSON unless noted. Errors are `{"error": "<code>"}` with a matching status.
Headers: `Moony-Account: <account number>` for account calls and vault creation;
`Authorization: Bearer <vault token>` for vault calls.

### Server and accounts

| Method | Path | Notes |
|---|---|---|
| `GET` | `/v1/server` | See above. |
| `POST` | `/v1/accounts` | `403 registration_closed`. Rate-limited per client. |
| `GET` | `/v1/accounts/me` | → `{"paidUntil": <unix s or null>, "active": bool, "vaults": n}`; `404 account_not_found`. `paidUntil` is the far-future constant for an active person, the time of the block for a blocked one. |
| `POST` | `/v1/accounts/me/checkout` | `409 self_hosted` |
| `DELETE` | `/v1/accounts/me` | `403 managed_by_operator` |

### Vaults

| Method | Path | Notes |
|---|---|---|
| `PUT` | `/v1/vaults/:vaultId` | Create (idempotent for the same account + token). Needs `Moony-Account` + `Authorization`; the person must be entitled (`402 payment_required` when blocked), at most 5 vaults (`403 vault_limit_reached`). → `201` / `200`. `409 vault_exists` for another account or token, `409 vault_deleting` while a deletion is unfinished. |
| `GET` | `/v1/vaults/:vaultId` | → `{"head", "floor", "snapshotSeq", "paidUntil", "bytes", "rotation"}`. `rotation` is the latest rotation number (0 = never rotated); a device that sees it rise fetches the rekey bundles. |
| `POST` | `/v1/vaults/:vaultId/ops` | Push. Body `{"ops": [{"id": "<op id>", "ct": "<base64>"}]}` → `{"head": n, "accepted": k}`. Duplicate op IDs are ignored (safe retries) while the op is still stored; after pruning the server no longer knows the ID, so clients must treat re-applying an op as harmless (per-column LWW already is). `413 quota_exceeded` past 256 MiB of op bytes, where each stored op is charged its ciphertext plus 128 bytes (the vault info `bytes` and the admin's space figures are this charge). |
| `GET` | `/v1/vaults/:vaultId/ops?after=<seq>&limit=<n>` | Pull. → `{"ops": [{"seq", "id", "ct"}], "head", "more"}`. `410 snapshot_required` when `after < floor`. |
| `PUT` | `/v1/vaults/:vaultId/snapshot?seq=<S>` | Raw `application/octet-stream` body with `Content-Length` (`411 length_required`, `413 snapshot_too_large` over 100 MiB). `S` = the op seq the snapshot includes (`400 snapshot_ahead_of_head`, `409 snapshot_outdated`). The body streams to disk; a body that ends early is `400 incomplete_body`. |
| `GET` | `/v1/vaults/:vaultId/snapshot` | Raw bytes; `Moony-Snapshot-Seq` header. `404 no_snapshot` when none. |
| `POST` | `/v1/vaults/:vaultId/token` | Rotate. Body `{"token": "<new 43-char token>", "rekey": "<base64, ≤ 256 KiB decoded>"}`. The **current** token authorises; no entitlement needed. One transaction: the current token's hash becomes a previous token (read-only for 30 days), the new hash becomes current, the bundle is stored with the next rotation number (1, 2, …), the vault head at that moment and the time. → `200 {"rotation": n, "head": h}`. A previous token gets `403 token_read_only` (so of two concurrent rotations the second fails); a wrong token `401 unauthorized`; a malformed or already-used new token `400 invalid_token`; a missing or malformed bundle `400 invalid_rekey`; a bundle over 256 KiB `413 rekey_too_large`; a vault already holding 32 bundles `409 too_many_rotations` (housekeeping frees slots). |
| `GET` | `/v1/vaults/:vaultId/rekey?after=<n>&limit=<k>` | Current or previous token. → `{"rekeys": [{"rotation", "head", "at", "rekey"}], "more": bool}` for rotations greater than `n` (default 0), oldest first; `limit` default 8, max 32, page cut at ~4 MiB of bundles (`more` says to ask again with the last `rotation`). Bundles older than 30 days are gone. |
| `DELETE` | `/v1/vaults/:vaultId` | Current token only. Wipes ops, snapshots and the vault record; frees the account slot. |

A previous token may `GET` the vault, pull ops, fetch the snapshot and fetch rekey bundles; every
other call gets `403 {"error": "token_read_only"}`. Thirty days after the rotation that retired it
a previous token is unknown (`401 unauthorized`) and housekeeping deletes it and its bundle. Ops
pushed with the current token after a rotation are accepted as usual; the server never parses ops.

### Pairing mailbox

For the key exchange that adds a device (the Moony client's pairing flow). No auth headers: slot
contents are public keys or sealed blobs and the 128-bit mailbox ID is random. IDs are never
logged, and nothing is stored for an ID until a valid first `PUT`. The limit is counted only for
well-formed requests, so malformed IDs and slots (`400`) cost nothing against it.

| Method | Path | Notes |
|---|---|---|
| `PUT` | `/v1/pairing/:mailboxId/:slot` | Mailbox ID = 22 chars base64url (`400 bad_mailbox` otherwise); slot `1`–`3` (`400 bad_slot` otherwise): slot 1 scanner → shower, slot 2 holder → joiner, slot 3 shower → scanner. Raw `application/octet-stream` body of 1 byte to 64 KiB (`400 empty_body`, `413 body_too_large`). → `204`. Write-once: a second write to the slot, even after it was read, is `409 slot_taken`. The first write creates the mailbox and starts its 10-minute lifetime. |
| `GET` | `/v1/pairing/:mailboxId/:slot` | → `200` raw bytes; `404 empty` when not written. Read once: the content is erased on a successful read and later reads are `410 consumed`. |
| `DELETE` | `/v1/pairing/:mailboxId` | → `204`; burns the mailbox (idempotent). For an ID nobody wrote to it is a no-op that stores nothing. |

Once a mailbox has expired or been deleted its ID is **burnt**: every `PUT` and `GET` answers
`410 mailbox_gone`. A tombstone row (no content) remembers that for 24 hours, then it is dropped
and the ID is unknown again. A mailbox refuses requests after its 10 minutes even if housekeeping
has not run yet, and its lifetime is never extended by later writes or reads. Slot contents are
erased by a sweep that runs every 60 seconds, so they exist at most about 11 minutes (10-minute
expiry plus the sweep); after that only the tombstone remains.

All open slots together may hold 64 MiB; a `PUT` that would pass that answers `503 busy` and
stores nothing. One client key (IPv4 address, or IPv6 /64) may hold at most 8 MiB in open
slots; beyond that its `PUT` answers `503 busy`, others are unaffected. The writer's key is stored
with the slot only as an HMAC-SHA-256 under a random key that exists only in the process's memory
(an IPv4 address cannot be recovered from it), and is cleared when the slot is read or burnt. After
a restart the old values match nobody: they are cleared at start, those slots count toward the
global total only and are gone within about 11 minutes.
The totals are kept in memory, updated by every put, read, burn and expiry, and recomputed from
the table at start and in each minute sweep.

## Sync flow (client view)

1. **First device:** the connection code gives the address and account → generate vault key,
   vault ID, vault token → `PUT /v1/vaults/:id` → upload a snapshot → push ops as they happen.
2. **New device:** receive vault key + IDs via QR pairing (or Recovery Kit) →
   `GET snapshot` → `GET ops?after=<snapshot seq>` until `more` is false.
3. **Steady state:** push local ops in batches; pull with the last seen `head`.
4. **Compaction:** any device may upload a snapshot. Ops covered by the latest snapshot and older
   than 30 days are pruned; `floor` rises. A device that was offline past `floor` gets
   `410 snapshot_required`, restores the snapshot, then re-applies and re-pushes its own unsent ops.

## Abuse limits

In-memory fixed windows of one minute, per process (they reset at a restart): account lookups
(and vault creation, which could probe account numbers) 60/min per client, vault calls 1200/min
per client and 600/min per vault + token, pairing mailbox calls 120/min per client. Admin guessing
limits are under *Authentication*. A client address is keyed as itself (IPv4), as the IPv4 for an
IPv4-mapped IPv6 address, and by its /64 prefix for any other IPv6 address. Request bodies are
read with a running byte count, so a missing or lying `Content-Length` cannot make the server
buffer more than the limit; snapshot uploads stream to disk. A push or token rotation is judged
by its token (unknown vault, wrong or read-only token, blocked person) **before** its body is
read. All bodies being buffered at once, on the sync and the admin API together, share 64 MiB.
A body reserves bytes as they arrive (never what it declares), so an idle connection holds
nothing, and one client key (IPv4 address or IPv6 /64, proxy-aware like the limiters) may have at
most 8 MiB of arrived-and-held bytes in flight, so one address cannot starve the rest by
trickling bodies; a chunk that does not fit answers `503 busy`. A body that delivers no bytes for 30
seconds is aborted with `408 {"error":"body_timeout"}`. Snapshot uploads stream to disk and are
exempt from both.

## Housekeeping

One in-process loop, once at start and then daily. It only reclaims space and finishes interrupted
work; every time rule is also enforced at request time.

- **Per vault:** prunes ops covered by a snapshot and older than 30 days (`floor` rises), forgets
  previous tokens and rekey bundles older than 30 days, removes snapshot files that have no record
  and are over an hour old (an upload whose request died between the file write and the record).
- **Mailboxes:** burns open mailboxes past their 10 minutes (deleting the slots) and drops
  tombstones older than 24 hours. This part also runs on its own every 60 seconds.
- **Sweep:** finishes pending deletions, and removes snapshot directories of vaults that have no
  record when nothing in them is newer than an hour (an empty directory left by a delete that
  raced an upload, or a restored backup's leftovers).
- **At start:** removes unfinished uploads (`*.tmp` in the snapshot directories) and leftover
  backup copies (`.backup-*.tmp` in `DATA_DIR`).

Deleting a vault is one transaction that drops its rows and notes a `pending_wipes` entry; from
then on every call answers `vault_not_found`, and creating the same ID answers
`409 vault_deleting`. Its files are removed right after; if that fails, the next sweep finishes
it. An upload that finishes after the vault is gone is refused and its file removed.

## Limits

| Limit | Value |
|---|---|
| Op ciphertext | 192 KiB |
| Ops per push | 500 |
| Push body | 4 MiB |
| Pull page | default 500 ops, max 1000, cut at ~4 MiB |
| Op bytes stored per vault | 256 MiB, each op charged ciphertext + 128 bytes |
| Snapshot | 100 MiB, 2 kept per vault |
| Rekey bundle | 256 KiB decoded, 32 kept per vault |
| Previous token (read-only) and rekey bundle | 30 days after the rotation |
| Read grace after a block | 30 days |
| Vaults per account | 5 |
| Pairing slot | 1 byte – 64 KiB, write-once, read-once |
| Pairing mailbox lifetime | 10 minutes (ID burnt 24 h more); contents swept within a minute after |
| Bytes in open pairing slots, all mailboxes | 64 MiB, then `503 busy` |
| Request bodies buffered at once (sync + admin) | 64 MiB of arrived bytes (8 MiB per client key), then `503 busy`; idle 30 s → `408 body_timeout` |
| Open pairing slots per client key | 8 MiB, then `503 busy` |
| Admin session | 12 hours without use |
| Admin request body | 16 KiB |

## What the server knows

- **People:** the name the admin typed (free text, shown only in the admin), the state, the
  creation time, the time of a block, and the 16-digit account number in clear.
- **Per vault:** the account it belongs to, the SHA-256 of the current token and of tokens rotated
  away in the last 30 days (with when), rekey bundles (opaque ciphertext) with their rotation
  number, head and time, op sizes, op IDs, the time each op arrived, snapshot sizes and times,
  and the **time of the last authorised request** (rounded to the minute), which the admin sees as
  a person's last activity.
- **Pairing mailboxes:** while one exists (at most 10 minutes), the slot contents, which are an
  ephemeral public key and a sealed credentials blob; afterwards only a content-free tombstone for
  24 hours. Slot contents are erased as soon as they are read.
- **Admin:** the name, an Argon2id hash of the password, the second-factor secret (in clear, it
  must be readable), SHA-256 of the session cookies and of the unused backup codes, the saved
  server address, and while it is pending a setup code.
- **Transiently, in memory only:** client addresses as rate-limit keys. Not stored, not logged.
- It never learns device names or counts, profile names, or anything inside an op or snapshot.
- There is no payer to link to a vault. The admin sees names, sizes and last-activity times,
  never content. A database
  or backup leak exposes the account numbers (credentials for creating profiles, not for reading
  existing ones) and the second-factor secret.

## Not built

- More than one admin, roles, e-mail of any kind.
- Server-side per-device keys. Device revocation is token rotation plus rekey bundles the
  clients build and seal to each other's keys; the server stores the bundles as opaque bytes.
- WebSocket push (clients poll).
- Blob (attachment) endpoints.
- A built-in HTTPS listener or certificates; use a reverse proxy.
