# Cursus

Cursus is a study app that runs entirely in the browser: courses, sources, notes (fiches) and flashcards
scheduled with FSRS. It works offline, keeps its data on the device, and synchronises through storage you
already own. There is no Cursus server and no account.

- App: <https://maxgfr.github.io/cursus/>
- Interface languages: English, German, French.

## Install

Install the app before you start adding content. A Safari tab and the installed app are two separate
copies (replicas) of your library with separate storage: what you write in one only reaches the other
through a sync destination.

- **iPhone and iPad**: open the app in Safari, tap Share, then *Add to Home Screen*. Open Cursus from the
  Home Screen icon from then on.
- **Mac**: in Safari, *File > Add to Dock*; in Chrome or Edge, the install icon in the address bar.

After installing, open *Settings > Data* and use *Protect storage* so the browser does not evict the library
when space runs low. Keep at least one destination configured either way.

### Custom subdomain (recommended)

Browser storage belongs to an origin. `maxgfr.github.io` is shared by every site the author publishes on
GitHub Pages, so any of them could read or clear the storage of Cursus served from there. If you rely on
Cursus, deploy your own fork on a domain or subdomain of your own (for example `cursus.example.com` with a
GitHub Pages custom domain) and install the app from that address. Moving to another origin later means
syncing the library through a destination, since local storage does not follow.

## Destinations

A destination is where the library is synchronised and backed up. You can use several at once; the app
reports a library as protected only when everything is confirmed on at least one of them.

| Destination | Setup |
|---|---|
| S3-compatible storage (Cloudflare R2, AWS S3, Backblaze B2, MinIO) | [docs/setup-s3.md](docs/setup-s3.md) |
| Google Drive | [docs/setup-google-drive.md](docs/setup-google-drive.md) |
| Dropbox | [docs/setup-dropbox.md](docs/setup-dropbox.md) |
| Microsoft OneDrive | [docs/setup-onedrive.md](docs/setup-onedrive.md) |
| iCloud (CloudKit) | [docs/setup-icloud.md](docs/setup-icloud.md) |
| Folder on this device, including an iCloud Drive folder | Chrome or Edge on a Mac or PC; synced while the tab is open |
| Nearby device | pairing copies destinations and keys between two devices directly |
| Backup file | export and import under *Data*, works everywhere; on iPhone and iPad *Save backup…* opens the share sheet (*Save to Files*) |

Each provider uses your own app or bucket credentials, kept only on the device. A destination can be
sealed with a passphrase: objects are then encrypted on the device with AES-256-GCM before upload. Without
the passphrase on a new device, nothing can be read or uploaded there. Objects are never rewritten or
deleted on a destination; the format is specified in [docs/sync-format.md](docs/sync-format.md).

Automatic folder sync is not available in Safari or on iPad (no File System Access API), and nothing syncs
while the app is closed.

## AI features (on this device or your own key)

Understanding a source, generating and improving cards, explanations, quizzes, answer grading and the chat
can use a language model, in one of two ways:

- **On this device**: a model (Gemma 4 E2B where the device has room for it) downloads once and runs in the browser through
  WebGPU. It is free, works offline, and nothing leaves the device.
- **Your own key** for a provider that can be called from a browser (for example OpenAI, Anthropic, Google
  or OpenRouter); requests go directly from the device to that provider. The key stays on the device and is
  never synchronised. Usage and estimated cost are recorded per month. Local servers such as Ollama or LM
  Studio work from Chrome on the same Mac, not from an iPad (mixed content is blocked).

The chat opens beside any screen (its icon, ⌘J / Ctrl+J, or « Ask about this » in the command palette). It
knows what the screen shows (a course, a section, a source, a card, a quiz question), answers from the
course's sources with citations, and never gives a card's answer before it is revealed. Conversations are
kept on the device, per course, and are not synchronised.

## Anki

Cursus imports `.apkg` and `.colpkg` files and exports courses as `.apkg`. See
[docs/setup-anki.md](docs/setup-anki.md). There is no AnkiWeb sync.

## Development

Requirements: [Bun](https://bun.sh). Docker for `test:s3` and `test:e2e`, `uv` for `test:anki`.

```sh
bun install
bun run dev          # Vite dev server
bun run build        # production build
bun run preview      # serve the build
```

| Command | What it runs |
|---|---|
| `bun run typecheck` | `tsc --noEmit` |
| `bun run lint` | Biome |
| `bun run test` | unit, property, simulation and provider contract tests |
| `bun run test:coverage` | coverage check (at least 90 % of lines in `src/core/{log,sync,crypto,srs}`) |
| `bun run test:deep` | the same tests with `FC_RUNS=5000` property runs |
| `bun run test:s3` | S3 integration tests against an emulator in Docker |
| `bun run test:anki` | Anki round-trip against the official Anki engine |
| `bun run test:e2e` | Playwright on Chromium and WebKit (desktop, iPhone, iPad) |
| `bun run test:live` | contract tests against real services (see below) |
| `bun run catalog` | rebuild the bundled AI model catalog |
| `bun run size` | initial JavaScript budget (200 KB gzip) |
| `bun run check` | typecheck, lint, test, build, size |
| `bun run check:all` | check, coverage, S3, Anki and e2e |

### Releases

Every push to `main` runs the blocking gates (`check`, coverage, S3, Anki); only when they are green does
[semantic-release](https://semantic-release.gitbook.io) read the commits since the last tag
([Conventional Commits](https://www.conventionalcommits.org): `fix:` → patch, `feat:` → minor,
`BREAKING CHANGE:` → major), tag `vX.Y.Z`, publish a GitHub release with its notes, and deploy that
version to GitHub Pages (`.github/workflows/release.yml`). Nothing is committed back: the build takes its
version from the tag, and Settings › General shows it with the commit, the build date and the sync data
format, plus a check for updates. The Playwright suite runs alongside in `e2e.yml`, one job per device
class: a red run is reported and fixed, but it does not hold back a release.

### Testing approach

- `src/core/**` is plain TypeScript without React or the DOM and is tested with `bun test`, including
  property tests (fast-check) and multi-device sync simulations with injected clock, randomness and
  faults.
- Every storage provider passes the same contract (`tests/contract/remote.contract.ts`) against an
  in-memory fake of its API; S3 also runs it against an emulator.
- The format is pinned by frozen fixtures in `tests/fixtures/v1`.
- The interface is tested with Playwright, including accessibility, offline use, updates and translations.
- What automation cannot cover is listed in [docs/manual-device-tests.md](docs/manual-device-tests.md).

### Live tests

`bun run test:live` runs the remote contract against real services, each under a unique random prefix
or folder. A suite runs only when all of its variables are set; otherwise it is skipped with the reason.
Live tests are not part of the gates and leave their test objects in place (nothing is deleted remotely).

| Service | Variables |
|---|---|
| S3 / R2 | `LIVE_S3_ENDPOINT`, `LIVE_S3_REGION`, `LIVE_S3_BUCKET`, `LIVE_S3_ACCESS_KEY`, `LIVE_S3_SECRET_KEY` |
| Google Drive | `LIVE_GDRIVE_CLIENT_ID`, `LIVE_GDRIVE_CLIENT_SECRET`, `LIVE_GDRIVE_REFRESH_TOKEN` |
| Dropbox | `LIVE_DROPBOX_TOKEN` (access token of an app-folder app) |
| CloudKit | `LIVE_CLOUDKIT_CONTAINER`, `LIVE_CLOUDKIT_API_TOKEN`, `LIVE_CLOUDKIT_WEB_AUTH_TOKEN`, optional `LIVE_CLOUDKIT_ENV` (`development` by default) |
| AI provider | `LIVE_AI_PROVIDER` (catalog id, e.g. `openai`), `LIVE_AI_MODEL`, `LIVE_AI_KEY` |

The S3 bucket must already exist. The Drive refresh token must come from an OAuth client with the
`drive.file` scope. Live runs create real objects and, for the AI test, a small billed request.
