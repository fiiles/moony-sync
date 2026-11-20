<!--
Thanks for contributing. For anything larger than a small fix, please open an issue first
so we can agree on the approach (see CONTRIBUTING.md).
-->

## What and why

<!-- What changed, and what problem does it solve? Link the issue: "Fixes #123". -->

## How it was tested

<!-- Tests added, commands run, manual steps. Do not include codes, tokens or a real server address. -->

## Checklist

- [ ] **Gates are green locally**: `npm run typecheck && npm test && npm run build`
- [ ] **Tests** cover the change (a regression test for a bug fix)
- [ ] **Both languages**: every new or changed text of the admin interface is in `admin-ui/src/i18n/cs.ts` and `en.ts`
- [ ] **Migrations** (if the database changed): appended as the next number in `src/db.ts`; no applied migration is edited
- [ ] **Docs**: `README.md` (running it) and `DESIGN.md` (protocol, storage, limits) say what the code now does; `CHANGELOG.md` has an entry under *Unreleased*
- [ ] **Privacy**: the server still makes no outbound connection and logs or stores no new personal data, or `DESIGN.md` ("What the server knows") is updated to say so
- [ ] Commits follow [Conventional Commits](https://www.conventionalcommits.org/)

## Licensing

By submitting this pull request I agree to the terms in "Licensing of contributions" in
`CONTRIBUTING.md`: my contribution is licensed under the AGPL-3.0, and I additionally grant the
maintainer the right to relicense it under other terms (dual licensing).

- [ ] I agree
