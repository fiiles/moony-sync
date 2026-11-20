# Contributing to the Moony sync server

Thank you for your interest. This document describes how the project is developed and how you
can contribute. The server belongs to [Moony](https://github.com/fiiles/Moony) and follows the
same principles as that repository.

## How this project is developed

The server is maintained by a **solo maintainer working with AI agents**, with small, frequent
commits on `main`. There is no formal review queue; quality rests on tests and on the checks
below.

- **Gates**: `npm run typecheck`, `npm test` and `npm run build`. CI runs them on every push and
  pull request, on Node 22 and 24, together with `npm audit` for the production dependencies and
  a build of the Docker image.
- **Tests first** for a bug fix: a test that fails without the fix. Server tests call the server
  in-process on a temporary data directory, with a clock the test moves by hand
  (`test/helpers.ts`).
- **The documents are part of the change.** [`README.md`](README.md) is the manual for the
  person who runs the server; [`DESIGN.md`](DESIGN.md) is authoritative for the protocol, the
  storage, the limits and what the server knows. A change in behaviour updates them in the same
  commit.
- **Instructions for AI coding agents** live in [`AGENTS.md`](AGENTS.md) (`CLAUDE.md` imports
  it).

## How to contribute

External contributions are welcome, with the caveat that this is primarily a personal project:

- **Bug reports**, the most valuable contribution (see below)
- **Feature ideas**: open an issue for discussion before writing code
- **Documentation fixes**, for example a working configuration for another reverse proxy

If you want to submit code, open an issue first to align on the approach, then open a pull
request against `main`. The pull-request template asks what changed, why and how you tested it.
Add an entry under *Unreleased* in [`CHANGELOG.md`](CHANGELOG.md) for changes the person who
runs the server will notice.

A change to the sync API needs the app as well. The server and the app agree on a protocol
number (`GET /v1/server`); a change that an older app cannot work with is discussed in an issue
first.

Please follow Moony's
[Code of Conduct](https://github.com/fiiles/Moony/blob/main/CODE_OF_CONDUCT.md). Security
problems go through [`SECURITY.md`](SECURITY.md), not a public issue.

## Licensing of contributions

The server is licensed under the **GNU Affero General Public License v3.0** (see
[LICENSE](LICENSE)). By submitting a contribution you agree that:

1. Your contribution is licensed under the AGPL-3.0, the same terms as the rest of the project.
2. You additionally grant Filip Král a perpetual, worldwide, non-exclusive, royalty-free,
   irrevocable license to use, modify, and redistribute your contribution **under other license
   terms as well**, including proprietary or commercial licenses.

Point 2 keeps dual licensing possible. Without it, every past contributor would have to be asked
for permission before the server could ever be offered under terms other than the AGPL.

## Development setup

You need Node 22 or newer. Docker is only needed to build the image.

```bash
npm ci
npm test            # Vitest: the server called in-process, plus the admin interface (jsdom)
npm run typecheck   # server and admin interface
npm run build       # admin interface (admin-ui/dist) and server (dist/)
DATA_DIR=./data npm start   # the built server on http://localhost:8787
npm run dev:ui      # Vite dev server for the admin interface
```

`./data` is ignored by git. Never commit a data folder, a backup archive or an environment file.

## Code style

- **TypeScript**, strict, ES modules. There is no linter or formatter yet: match the file you are
  in (two spaces, double quotes, semicolons, lines up to about 100 characters).
- **Limits and time rules** are constants in `src/limits.ts`, never numbers in the code.
- **Migrations** are append-only: the next entry in `src/db.ts`. An applied migration is never
  edited.
- **Admin interface texts** are in both `admin-ui/src/i18n/cs.ts` and `en.ts`;
  `admin-ui/test/i18n.test.ts` fails otherwise. They say "sync server", never "relay".
- **Logs** never contain an account number, a token, an ID, a file path or a client address.

## Commit message guidelines

We follow the [Conventional Commits](https://www.conventionalcommits.org/) specification:

```
<type>(<scope>): <description>
```

Types: `feat`, `fix`, `docs`, `style`, `refactor`, `test`, `chore`, `build`, `ci`.

Keep commits small and focused: one logical change per commit.

## Reporting bugs

Use the **Bug report** form when you open an issue. It asks for:

1. **The version**: the commit you built from (`git rev-parse --short HEAD`)
2. **How you run it**: Docker with `compose.yml` or Node, and the reverse proxy in front
3. **Steps to reproduce**, the expected and the actual behaviour, with the exact error text
4. **The server log**: the relevant lines of `docker compose logs moony-sync`

Never paste a connection code, an account number, a token, a setup code, the admin password or
a backup archive, and replace your server's address with `sync.example.com`. A problem in the
Moony app itself belongs in the [Moony repository](https://github.com/fiiles/Moony/issues).
