# Changelog

All notable changes to the Moony sync server are documented in this file. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- **The first public version of the server.** One Node process with a SQLite database and a data
  folder, run from a Docker image you build yourself.
- **Sync API, protocol 3.** Encrypted change records and snapshots per profile, token rotation
  with rekey bundles, pairing mailboxes for adding a device, encrypted documents and photos with
  a quota per profile, and the Recovery Kit. `GET /v1/server` answers `protocol: 3` and lists the
  features `blobs` and `kit`; `DESIGN.md` has a Compatibility section with the rules for how the
  protocol may change. After a device is removed, the old token can read
  only the profile's info and the key changes for 30 days; everything else needs the new token.
- **Web admin** in Czech and English: add, block and delete people, show a person's connection
  code, see the space used, change settings and download a backup. Login with a password and an
  optional second factor; `reset-admin` for a lost password.
- **Limits and housekeeping**: rate limits per client address, a free-space floor of 1 GiB,
  daily clean-up, and no outbound connections.
- **Proxy mistakes are visible.** The admin overview warns when forwarding headers arrive while
  `TRUST_PROXY` is off, or when a request reaches the port without them while it is on; the
  server logs each once, without any address. `compose.yml` and the README show the loopback
  binding for a reverse proxy on the same machine, and the image's health check now uses `/health`.
- **`moony-sync unlock-admin` clears the admin login lockout** of a running server (`reset-admin`
  does too), and a signed-in admin's password re-check is no longer refused because strangers
  filled the shared counter.
- **A pull reads only what it sends.** The server picks the page by stored sizes and reads the ciphertext of those ops only (the same for key changes), so one request no longer loads up to 190 MiB into memory.
- **Vault IDs are unique ignoring letter case**, so two profiles can never share a folder on a
  file system that ignores case. A database that already holds two such IDs stops the server at
  start-up with one line (no IDs in it).
