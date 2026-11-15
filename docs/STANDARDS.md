# Code standards

The rules this repo already follows. Where the code is inconsistent, the dominant pattern
is the rule and the outlier is listed under "Known drift". Follow the rule in new code; fix
drift in its own change.

## Stack

- Node 24, npm, `package-lock.json` committed. `.npmrc` sets `engine-strict=true`.
- SvelteKit with `@sveltejs/adapter-node`, Svelte 5 in runes mode (`$props`, `$state`,
  `$derived`, `$effect`), TypeScript in `strict` mode. Every component uses
  `<script lang="ts">`.
- One runtime dependency: `@lucide/svelte` for icons. Do not add a dependency for what a
  few lines of code do.
- Do not switch to `adapter-static`. The server serves both the UI and the media bytes.

## Layout

| Path                      | What goes there                                                                                             |
| ------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `src/routes/`             | Pages (`+page.svelte`, `+page.server.ts`) and endpoints (`+server.ts`). Keep handlers thin.                 |
| `src/routes/api/<thing>/` | JSON and byte endpoints. Per-item routes are `api/<thing>/[name]/+server.ts`.                               |
| `src/lib/server/`         | Server-only modules: config, scanning, Range serving, the `DATA_DIR` stores, ffmpeg work.                   |
| `src/lib/*.ts`            | Pure, client-safe logic (`fit`, `gallery`, `playback`, `pool`, `save`, `volume`). No DOM globals at import. |
| `src/lib/components/`     | Svelte components, one per file.                                                                            |
| `src/lib/stores/`         | Client-side stores (`localStorage`-backed preferences and hidden set).                                      |
| `src/lib/types.ts`        | Types shared between server and client.                                                                     |
| `src/app.css`             | Global base styles and the scroll-snap feed layout only. Component styles stay scoped.                      |
| `tests/`                  | Vitest suites, one file per module or route group. `tests/setup.ts` sets the test env.                      |
| `docs/`                   | User docs (`install`, `configuration`, `architecture`) plus these standards.                                |

## Naming

- Components: `PascalCase.svelte` (`VideoCard.svelte`).
- Modules: `camelCase.ts` (`dataCache.ts`, `mediaServe.ts`).
- Functions and variables: `camelCase`. Constants that act as tunables: `UPPER_SNAKE`.
- Component callback props: lowercase `on<event>` (`onmute`, `onshare`), matching Svelte 5
  DOM event props.
- Env vars: `UPPER_SNAKE`, read in one place (see Config).

## Config

- Read every env var in `src/lib/server/config.ts`, once, from `process.env`. Nothing else
  touches `process.env`.
- Parse with the existing helpers (`parseBool`, `parseInt10`, `parseFloat10`). A blank or
  invalid value falls back to the default; numeric knobs are clamped to a safe range.
- Configure at run time, never at build time. One image serves every instance.
- Never hardcode the video path or the feed name. Use `config.videoDir` and
  `config.feedName`.
- Optional features default off and gate on the env var, not on whether a directory
  exists. `DATA_DIR` unset means no writes and no ffmpeg, anywhere.
- A new user-facing setting gets a row in `docs/configuration.md` in the same change.

## Data and files

- `VIDEO_DIR` is read-only input. Never write, rename or delete there.
- Write only under `DATA_DIR`. Write JSON stores atomically: write a temp file
  (`<file>.tmp.<pid>.<seq>`), then `rename` over the target. Serialize writers to the same
  store through its queue.
- Resolve every client-supplied name through `safeMediaPath` before touching disk.
- Never read a media file into memory. Stream it with
  `fs.createReadStream(path, { start, end })`.
- Keep ffmpeg and other slow work off the request path. Background workers are
  fire-and-forget and run through `nicedExec`.

## HTTP and errors

- Range handling is the core of the app: `206` with `Content-Range` and `Content-Length`,
  `416` when unsatisfiable, `HEAD` mirrors `GET` with no body. Never answer a Range request
  with a full `200`.
- A disabled feature, a bad name, or a missing item returns `404` with no detail. Use
  `error(404, 'not found')` from `@sveltejs/kit` (dominant form).
- Byte responses send `X-Content-Type-Options: nosniff` with the exact MIME type.
- Expected filesystem failures are caught and turned into a safe fallback (empty list,
  `404`, cache miss). Every empty `catch {}` carries a one-line comment saying what the
  fallback is.
- No server logging. The app writes nothing to stdout in normal operation; diagnostics go
  through the opt-in `DEBUG_PLAYBACK` overlay.
- Fire-and-forget promises are `void`ed and end in `.catch()`, so a background failure can
  never crash the server or block startup.

## Client code

- `muted` plus `playsinline` on every `<video>`. One `IntersectionObserver` drives playback,
  one video plays at a time.
- Size full-screen elements with `100svh` then `100dvh`. `grep -rn '100vh' src` must stay
  empty.
- Respect `prefers-reduced-motion` (the global rule in `app.css` handles CSS; gate JS
  smooth scrolling and burst animations too).
- Every icon-only button has an `aria-label`; decorative icons get `aria-hidden="true"`.

## Comments

- Comment the why, not the what. Name the constraint a line protects.
- Tag a behavior change with the version that introduced it, in parentheses, e.g.
  `(0.8.0)`. This is how the existing comments cross-reference `CHANGELOG.md`.
- Keep comments and docs deployment-neutral: no hostnames, no specific instance names.

## Format and lint

- Prettier (`.prettierrc.json`): tabs, single quotes, no trailing commas, print width 100,
  `prettier-plugin-svelte`.
- ESLint flat config (`eslint.config.js`): `@eslint/js` recommended, `typescript-eslint`
  recommended, `eslint-plugin-svelte` recommended, then `eslint-config-prettier`.
- Type check with `svelte-check` against `tsconfig.json` (`strict: true`).

## Tests

Run all four before you push. CI runs the same commands and fails on any of them:

```bash
npm run check && npm run lint && npm run format:check && npm test
```

- Vitest, Node environment, no DOM. Files: `tests/**/*.test.ts` (and `src/**/*.test.ts`).
- `tests/setup.ts` sets `VIDEO_DIR`, `FEED_NAME` and friends before modules import.
- Put logic in pure functions in `src/lib/` so it can be tested without a browser.
- A behavior change ships with a test. Touching media serving means running
  `tests/range.test.ts` and a live `curl -sI -r 0-1` against a clip.
- Prove default-off containment: a gated feature's test shows zero filesystem calls when
  its env var is unset.

## Versioning and release

- `package.json` `version` is canonical. `VERSION` mirrors it. Bump both in the same commit
  and add a `CHANGELOG.md` entry. CI fails if they disagree.
- Every merge to `main` needs a new version: CI refuses to republish an existing
  `:<version>` image tag.

## Commits and merge requests

- Commit subject: one imperative line, optionally led by the area it touches
  (`fit: cap cover-crop at ~10%`, `Adopt image-hygiene: weekly rebuild + Trivy scan`).
  No conventional-commit type prefixes. No AI attribution trailers.
- Stage with explicit pathspecs, not `git add -A`.
- Work on a feature branch, open a merge request to `main`, merge after review. A release
  merge title names the version and a one-line summary.
- This is a public tree mirrored to GitHub. Never commit secrets, local scratch or
  deployment-specific paths. Keep `.gitignore` and `.dockerignore` clean.

## Build and deploy

- `Dockerfile`: two-stage `node:24.x-alpine` build. The runtime stage installs `ffmpeg`,
  copies `build/` and production `node_modules`, and runs `node build` as `USER node` on
  port 3000. Keep it non-root.
- CI (`.gitlab-ci.yml`) builds with Kaniko and tags by branch: `main` publishes `:latest`,
  `:<version>` and `:<sha>`; `dev` publishes `:dev` and `:<sha>`; release-candidate
  branches matching the CI rule publish `:<sha>` and `:<branch>`. A scheduled pipeline
  rebuilds and scans the published image.
- Self-hosters run `compose.yaml`: the video folder is bind-mounted read-only at
  `/srv/videos`, and a named volume backs `/data`.

## Known drift

1. CI's `verify` job runs on `node:20-alpine`, while the `Dockerfile` and
   `CONTRIBUTING.md` target Node 24.
2. `AGENTS.md` describes a `dev` to `main` release flow; recent history merges feature
   branches straight into `main`.
3. Commit subjects mix plain imperative lines, `area:` prefixes, `<version>:` prefixes and
   a few conventional prefixes (`docs:`, `chore:`, `test:`).
4. Gated-off `404`s use two forms: `error(404, 'not found')` and
   `new Response(null, { status: 404 })` (for example `api/starred/[name]`).
5. Test file names mix camelCase (`dataCache.test.ts`) and kebab-case
   (`hidden-server.test.ts`, `poster-route.test.ts`).
6. Code comments cite `SPEC §n` sections, but no spec file ships in the repo.
7. Some comments and docs name specific deployments or instances instead of staying
   deployment-neutral.
