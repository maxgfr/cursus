# Cursus

Offline-first study PWA (TypeScript, Bun, Vite, React), hosted on GitHub Pages, no server.

## Commands

- `bun run dev` / `bun run build` / `bun run preview`
- `bun run typecheck`, `bun run lint`, `bun run test` (unit, property, contract)
- `bun run test:coverage` (>= 90 % lines on `src/core/{log,sync,crypto,srs}`), `bun run test:deep` (`FC_RUNS=5000`)
- `bun run test:s3` (S3 emulator via Docker), `bun run test:anki` (official Anki engine via `uv`), `bun run test:e2e` (Playwright)
- `bun run test:live` (real services, not in gates; each suite skipped unless its `LIVE_*` vars are set, see README), `bun run catalog`, `bun run size` (initial JS <= 200 KB gzip)
- `bun run check` = typecheck + lint + test + build + size; `bun run check:all` = check + coverage + s3 + anki + e2e

## Rules

- `src/core/**` is pure TypeScript: no React, no DOM. Tested with `bun test`; UI is tested with Playwright.
- Every user-facing string goes through i18n (en default, de, fr).
- Yjs rules: top-level collections only, random ULID ids, nested `Y.Text` created in the entity's creation
  transaction, no pre-seeded content, one entity = one `Y.Map` of scalars, trash via `deletedAt`/`purgedAt` only,
  reviews are an append-only `Y.Array` of events. `Workspace` is the only module that touches Yjs.
- Never delete or rewrite a remote segment or any immutable remote key (only `mirror/` and an explicitly requested
  plaintext-root removal are exceptions).
- Gates are frozen: never skip, weaken or delete a test, never lower thresholds, no suppression comments.
- `dangerouslySetInnerHTML` is allowed only in the sanitised renderer.
- Sync format v1 (`docs/sync-format.md`, `tests/fixtures/v1`) is frozen: a change needs a new version and new
  fixtures, never edited v1 fixtures. Keep that doc in step with `src/core/{log,sync,crypto}`.
- Docs are in English, factual, without tool or assistant attribution.
