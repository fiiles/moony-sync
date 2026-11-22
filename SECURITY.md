# Security policy

The Moony sync server stores people's encrypted financial data and the credentials that reach
it, so security reports are taken seriously. It is maintained by one person; the timelines below
are best-effort commitments, not a service level.

## Supported versions

Releases are numbered and tagged ([CHANGELOG.md](CHANGELOG.md)), but no image is published: you
build the server from this repository. Only the **latest release** receives security fixes; a fix
ships as a new release, and older releases get no backports. If you run an older release, update
first (README, "Update") and check whether the problem still exists.

## Reporting a vulnerability

**Please do not open a public issue or pull request for a security problem.**

Use **GitHub private vulnerability reporting**: on the repository open *Security → Report a
vulnerability* (<https://github.com/fiiles/moony-sync/security/advisories/new>). Only the
maintainer can read what you submit there. If you cannot use that form, open an issue with the
**Question** form that says just "security report, please contact me" without any detail, and
the maintainer will arrange a private channel.

A useful report contains:

- what is affected (the release or commit you built from, how you run the server, the reverse proxy) and
  what an attacker gains;
- steps to reproduce, or a proof of concept (an HTTP request, a crafted backup archive …);
- whether you have shared the details with anyone else.

Please test only against a server you run yourself, and never include a real connection code,
account number, token or backup archive.

## What to expect

| Step | Target |
| --- | --- |
| Acknowledgement of your report | within 7 days |
| First assessment (confirmed, needs more information, or not a vulnerability) | within 14 days |
| Fix or mitigation for a confirmed issue | within 90 days, usually much sooner |
| Public disclosure | after a fix is released, or after 90 days, whichever comes first; earlier or later by agreement with you |

Confirmed vulnerabilities are published as a GitHub security advisory and noted under
*Security* in [CHANGELOG.md](CHANGELOG.md). You are credited by name or handle unless you prefer
to stay anonymous.

## Scope

The server is built on the assumption that it is **untrusted**: it holds ciphertext and never a
key, and the apps detect a server that drops, replays or rolls back data
([DESIGN.md](DESIGN.md), "Principles"). A report is in scope when it breaks what the server
itself promises:

- **The admin**: setup code, login, sessions, the second factor, `reset-admin`, the origin
  check and the content security policy of the admin page.
- **The sync API**: reading or writing a profile without its token, reaching another person's
  data, getting past a block, a quota or a rate limit in a way that harms other people on the
  server, and the pairing mailboxes.
- **Storage and files**: path traversal or a file written outside `DATA_DIR`, the backup
  archive, snapshot and document files.
- **Logging**: an account number, token, ID, file path or client address in the log.
- **Outbound connections**: any way to make the server call out.
- **Supply chain**: the Dockerfile, the workflow and the way dependencies are pinned.

Out of scope:

- An attacker who already controls the machine, the container or the data folder, or who has
  the admin's password and second factor.
- What plain `http://` exposes on the network, and the missing Host allowlist. Both are
  documented in [README.md](README.md) ("Plain http", "Known limits"), so they are not new
  findings.
- The encryption itself, key handling on the devices and what the apps do with a misbehaving
  server: that is the Moony app, reported at <https://github.com/fiiles/Moony/security/policy>.
- Vulnerabilities in dependencies with no demonstrable effect on the server; please report them
  upstream. Reports that only restate the output of an automated scanner are also out of scope.

## Safe harbour

Good-faith research that stays within this policy is welcome. Test only against your own
server, do not access or destroy other people's data, and give a reasonable time to fix a
problem before you go public.

## How dependencies are kept in check

- `npm audit --omit=dev --audit-level=high` runs in CI and blocks the build
  ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)).
- Dependabot opens security-update pull requests for npm, the Docker base image and GitHub
  Actions ([`.github/dependabot.yml`](.github/dependabot.yml)).
- The image is built from `package-lock.json` with `npm ci`; nothing is copied in from the
  host's `node_modules`.
