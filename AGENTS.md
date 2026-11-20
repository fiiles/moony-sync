# AGENTS.md

Guidance for AI coding agents working in this repository (Claude Code reads it through
`CLAUDE.md`; other agents read it directly). The rules below are non-negotiable; everything else
is in `README.md` (running the server) and `DESIGN.md` (protocol, storage, limits).

## Project overview

The Moony sync server: one Node process (Hono, SQLite through better-sqlite3) with one data
folder, a web admin (Preact, built with Vite) and the sync API the Moony apps talk to. It stores
and forwards ciphertext it cannot read. The code says "relay" in places; that is the internal
name from when it was a hosted service.

## Commands

```bash
npm ci
npm test            # Vitest: server tests (node) and admin interface tests (jsdom)
npm run typecheck   # server and admin interface
npm run build       # admin interface (admin-ui/dist) and server (dist/)
npm start           # node dist/main.js
npm run dev:ui      # Vite dev server for the admin interface
```

Run `npm run typecheck && npm test` before every commit.

## The rules (non-negotiable)

1. **Zero knowledge.** The server never parses, decrypts or inspects an op, a snapshot, a blob
   or a Kit envelope. No change may give it a key or readable content → `DESIGN.md` "Principles"
2. **No outbound connections.** No e-mail, analytics, telemetry, update check or webhook call.
3. **Nothing identifying in the log.** No account number, token, profile or mailbox ID, file
   path or client address; errors are logged by name only → `README.md` "What it stores"
4. **Migrations are append-only** in `src/db.ts`: add the next entry, never edit an applied one.
5. **Limits and time rules are constants** in `src/limits.ts`, and each is also checked at
   request time, not only by housekeeping.
6. **Every admin interface text is in both languages** (`admin-ui/src/i18n/cs.ts`, `en.ts`) and
   says "sync server", never "relay"; `admin-ui/test/i18n.test.ts` checks it.
7. **`admin-ui/src/styles/tokens.css` and `moony.css` are unchanged copies** of the Moony design
   system. Admin-specific layout goes in `app.css`.
8. **A change in behaviour updates `README.md` and `DESIGN.md` in the same commit.** `DESIGN.md`
   is authoritative for the sync API; the app is built against it.
9. **A sync API change that an older app cannot work with** needs a new protocol number or a
   `features` entry in `GET /v1/server`, never a silent change.
10. **Nothing personal in the repository.** Tests and documents use `sync.example.com`, made-up
    names and private or documentation address ranges; no real server address, account number,
    token or data folder is ever committed.

## Testing

- Server tests call the app in-process through `testApp()` in `test/helpers.ts`: a temporary data
  directory and a clock the test moves by hand. Never sleep and never read the real time.
- A bug fix starts with a test that fails without it.
- Admin interface tests opt into jsdom with `// @vitest-environment jsdom`.

## Where things are

| Path | Contents |
|---|---|
| `src/` | The server: `sync-api.ts`, `vaults.ts`, `blobs.ts`, `kits.ts`, `mailboxes.ts`, `people.ts`, `limits.ts`, `db.ts` |
| `src/admin/` | Admin authentication, admin API, backup |
| `admin-ui/` | The admin web interface |
| `test/`, `admin-ui/test/` | Tests |
| `DESIGN.md` | Protocol, storage, admin, limits, what the server knows |
| `README.md` | The manual for the person who runs the server |

## Commits

[Conventional Commits](https://www.conventionalcommits.org/), small and focused. User-visible
changes get an entry under *Unreleased* in `CHANGELOG.md`.
