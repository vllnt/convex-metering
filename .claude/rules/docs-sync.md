# Docs Sync (BLOCKING)

Docs are part of the change, not an afterthought. **Every commit** that alters
behavior, public API, config, license, naming, schema, or versions MUST update
the related docs **in the same commit**, and you VERIFY no stale reference
survives **before** committing.

## What to update (same commit)

| Changed | Update |
|---------|--------|
| License (`package.json` / `LICENSE`) | README badges + License section, `llms.txt`, `llms-full.txt`, any `specs/`/`docs/` mention |
| Public API (client methods, args, returns, error codes) | README usage + API table, `docs/API.md`, `llms.txt` + `llms-full.txt` |
| Config points / options | README config section, `docs/API.md` |
| Schema / tables / indexes | README Architecture, `docs/API.md` |
| Version | `CHANGELOG.md` entry, version badges |
| Dependency range (`peerDependencies.convex`) | the `convex@^X.Y.Z` line in `llms.txt` + the `**Compatibility:**` line in `docs/API.md` + README peer-dep note (grep the old range → zero stale hits) |
| Naming (package, repo, exports, ids) | README, `package.json`, llms, `AGENTS.md` (+ `CLAUDE.md` mirror) |
| New file / capability / `./react` entry | README, `llms.txt` index, regenerate `llms-full.txt` |

## Verify before commit (BLOCKING)

1. If README/docs/source changed, run `pnpm generate:llms` so `llms-full.txt` is current.
2. **Grep the OLD value** you changed across the repo and confirm zero stale hits:
   - License: `git grep -i 'apache'` (or the old SPDX) → empty.
   - Rename: `git grep '<old-name>'` → empty (except deliberate history).
   - Value/limit/flag change: grep the old number/string → empty.
3. Trace test: every doc claim still matches the code. A doc that describes
   behavior you changed is part of THIS commit — fix it now, not "later".

## Why

Cautionary case: relicensing `convex-api-keys` updated `package.json` + `LICENSE`
but left `Apache-2.0` in README, `llms.txt`, `llms-full.txt`, and a `specs/` file —
a visible, shipped inconsistency. Step 2 (grep the old value) catches exactly this.

## Anti-patterns (NEVER)

- NEVER change behavior/license/API/naming without updating its docs in the same commit.
- NEVER leave `llms-full.txt` stale after a README/source change — regenerate it.
- NEVER defer doc updates to "a follow-up" — stale docs rot on contact and mislead consumers.
