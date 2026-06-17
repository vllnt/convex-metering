# Git Workflow

Mirrors this repo's enforced GitHub settings (branch protection + the `owner-only-signed`
ruleset). Keep local habits aligned with them.

- **Branch from `main`** for every change; one focused change per branch. Conventional commits:
  `feat:`, `fix:`, `docs:`, `chore:`, `refactor:`, `test:`, `perf:`.
- **Signed + no-reply identity (enforced).** Every commit is SSH-signed (GitHub "Verified") and
  authored AND committed as the maintainer's GitHub **no-reply** address — the `owner-only-signed`
  ruleset rejects any other signature or email (see `commit-privacy.md`). Sign tags too
  (`git tag -s`).
- **Landing — direct signed commits (fleet default).** The ruleset rejects GitHub squash-merges
  (their committer is `noreply@github.com`), so changes land as **direct signed commits**: push
  `HEAD:main` from your feature branch (a non-`main` current branch is fine). There is no squash
  button to use.
  - *If a repo widens the ruleset's `committer_email_pattern` to also allow `noreply@github.com`,*
    PR **squash-merge** works there instead — write a clean squash title; it becomes the `main`
    entry. Check the repo's ruleset to know which mode applies.
- **Strict checks.** Keep your branch up to date with `main`; every required status check must pass
  (`Lint`, `Typecheck`, `Test`, `Build`, `Commit email privacy`). In PR mode, resolve all
  conversations before merge.
- **`main` is protected.** Force-push and deletion of `main` are blocked. Don't fight protection.
