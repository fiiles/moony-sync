# Changelog

All notable changes to the Moony sync server are documented in this file. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [1.0.0] - 2026-11-22

The first public version. It works with Moony 1.4.1 and newer.

### Added

- **One small server you run yourself**: a Node process with a SQLite database and one data
  folder, built into a Docker image from this repository, with `compose.yml`, a health check on
  `GET /health` and no outbound connections of any kind.
- **Sync API, protocol 3.** Encrypted change records and snapshots per profile; token rotation
  with rekey bundles when a device is removed (the old token then reads only the profile's info
  and the key changes, for 30 days); pairing mailboxes for adding a device; encrypted documents
  and photos with a quota per profile; and the Recovery Kit. `GET /v1/server` answers
  `protocol: 3` with the features `blobs` and `kit`. `DESIGN.md` describes the protocol, the
  limits, what the server knows, and the rules for how the protocol may change.
- **Web admin** in Czech and English: add, rename, block and delete people, show a person's
  connection code (as text and QR code), see the space used, change the address apps use and the
  space for documents and photos, and download a backup while the server runs.
- **Admin security**: password login with an optional second factor (authenticator app and
  backup codes, mandatory with `REQUIRE_2FA=1`), a one-time setup code from the log, attempt
  limits, strict cookies, an origin check and a content security policy.
  `moony-sync reset-admin` recovers a lost password and `moony-sync unlock-admin` clears a login
  lockout.
- **Reverse proxy support** with `TRUST_PROXY=1`, and a warning on the admin overview when the
  proxy setting and the way requests arrive do not match.
- **Limits and housekeeping**: rate limits per client address, a shared budget for request
  bodies, a 30-second idle timeout for uploads, a free-space floor of 1 GiB, and a daily clean-up
  that is also enforced on every request.
- **Privacy by construction**: the server stores only ciphertext and token hashes, the log never
  contains account numbers, tokens, IDs, file paths or client addresses, and the database is
  readable by the server's user only.

[Unreleased]: https://github.com/fiiles/moony-sync/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/fiiles/moony-sync/releases/tag/v1.0.0
