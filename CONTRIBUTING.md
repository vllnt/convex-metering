# Contributing to @vllnt/convex-metering

Thanks for your interest in contributing!

## Development Setup

```bash
pnpm install
pnpm build
pnpm typecheck
pnpm lint
pnpm test:coverage
```

Use `pnpm build:codegen` only when you need to regenerate checked-in Convex `_generated` files and
have access to the selected Convex project.

## Testing

Tests use [`convex-test`](https://docs.convex.dev/testing) with the `@edge-runtime/vm` environment:

```bash
pnpm test           # single run
pnpm test:watch     # watch mode
pnpm test:coverage  # enforced 100% on covered files
```

Coverage is gated at 100% (`vitest.config.mts`). Every public method needs a happy-path test **and**
at least one adversarial test (invalid input, not-found, boundary).

## Code Style

- Prettier + ESLint (run `pnpm lint` before submitting)
- `@vllnt/eslint-config/convex` enforces: namespace separation, snake_case filenames, no bare
  `v.any()`, require returns validators, no N+1 queries
- No `any` — use `unknown` + type guards
- Explicit return types on public APIs
- Mutations in `mutations.ts`, queries in `queries.ts`, validators in `validators.ts`

## Pull Requests

- Target `main`
- One logical change per PR
- Include tests for new behavior or bug fixes
- Ensure all checks pass: `pnpm typecheck && pnpm lint && pnpm test:coverage && pnpm build && pnpm test:package && pnpm check:docs`
  (`pnpm test:coverage` type-checks every test file first via `pnpm typecheck:tests`; CI also runs
  `bash scripts/test-check-package-contents.sh`)

## Releases

Maintainers only. Every publish runs in `.github/workflows/publish.yml` with npm trusted
publishing and provenance; nothing is published from a local machine.

- Canary (`@canary`): every push to `main` that changes the package or its shipped docs
  publishes one under the `canary` dist-tag (never `latest`); a manual run on `main` also
  publishes one.
- Stable (`@latest`): merge a PR that sets `package.json` `version` and adds a matching
  `## [X.Y.Z]` entry to `CHANGELOG.md`, then push the tag `vX.Y.Z` on that `main` commit.

## Reporting Issues

Use [GitHub Issues](https://github.com/vllnt/convex-metering/issues). For security vulnerabilities,
see [SECURITY.md](./SECURITY.md).
