# AGENTS.md — forya

The canonical agent guide for this repository. Read this first when you pick up
forya cold.

## What this repo is

forya is an iOS-first vertical video feed built with SvelteKit (adapter-node),
Svelte 5, and TypeScript, packaged as one self-contained Docker image that
serves both the UI and the video bytes (with correct HTTP Range). It replaces a
buggy Caddy+React feed (`erin`) on iOS Safari. See [`README.md`](./README.md)
for the user-facing story and [`handoff.md`](./handoff.md) for the rewrite
rationale and load-bearing decisions.

## Scope — what this repo owns vs. doesn't

**Owns:** the image and the app — app code, tests, `Dockerfile`,
`.gitlab-ci.yml`, this docs trio, `VERSION`, `CHANGELOG.md`.

**Does NOT own:**

- **Runtime/deploy config** lives in the homelab `/docker` repo (the media
  compose stack, Caddy routing, the fleet roster). Containers there consume the
  pre-built image by tag and inject `VIDEO_DIR` / `FEED_NAME` per instance.
- **Auth** — there is none in-app (v1). Forward-auth is configured at the
  reverse proxy (Authentik), outside this repo.
- **The video files** — `VIDEO_DIR` is read-only input this app does not own
  (a separate importer writes it).

## Reading order

1. **`AGENTS.md`** (this file) — scope, conventions, constraints.
2. **`handoff.md`** — why it's built this way; gotchas; the acceptance criteria.
3. **`src/lib/server/videos.ts`** — the workhorse: dir scan, mime, the pure
   HTTP Range resolver. This is the load-bearing module.
4. **`src/lib/components/Feed.svelte`** — the iOS feed orchestration (single
   IntersectionObserver, one-at-a-time playback, preload window).

## Stack + scripts

SvelteKit (adapter-node) + Svelte 5 (runes) + TypeScript; `npm`
(`package-lock.json` committed). Scripts: `dev`, `build`, `preview` (`node
build`), `check` (svelte-check), `lint` (eslint), `format` / `format:check`
(prettier), `test` (vitest). **CI runs `check && lint && format:check && test`**
— all must pass locally before you push.

## Versioning + release

- `package.json` `version` is canonical; **`VERSION` mirrors it** (one line).
  **Bump both in the same commit**, and add a `CHANGELOG.md` entry. CI's
  `verify` job fails if they disagree.
- The CI `version_guard` job (main only) fails the pipeline if the
  `:$VERSION` image tag is already published — so every release must bump.
- Tagging: a push to **`dev`** publishes `:dev` + `:$CI_COMMIT_SHA`; a push to
  **`main`** publishes `:latest` + `:$VERSION` + `:$CI_COMMIT_SHA`.

## Commit / push policy

- All milestone/feature work on a **`dev`** branch; CI builds `:dev`. `main` is
  cut via a reviewed `dev → main` merge; CI then publishes `:latest`.
- Commit style: single imperative, scope-led line, **no** conventional-commit
  prefix, **no** `Co-Authored-By` (mirror the existing log). Prefer explicit
  pathspecs.
- This is a public OSS tree mirrored to GitHub — keep `.gitignore` /
  `.dockerignore` clean (no local scratch, no secrets, no homelab-only paths).

## Load-bearing constraints (don't quietly change these)

- **`/srv/videos` is read-only input.** Read only — never write/rename/delete.
  Honor `VIDEO_DIR`; never hardcode a path. Same for `FEED_NAME` — never
  hardcode `forya`/a feed name where the env var belongs. The hide ("trash")
  control (`ALLOW_HIDE`, 0.2.0) is **client-side only** — it stashes filenames in
  localStorage and filters the feed; it does **not** delete or move files, so
  this contract holds. Don't turn it into a server-side disk mutation without an
  explicit decision to drop the `:ro` mount.
- **HTTP Range correctness is the entire reason this app exists.** The pure
  resolver in `videos.ts` (`resolveRange`) and the `/api/media/[name]` route are
  guarded by **`tests/range.test.ts`** — both the byte math AND the real HTTP
  contract (`206` + `Content-Range` + `Content-Length`, `416` on unsatisfiable,
  HEAD mirrors GET with no body). **Never collapse a Range request into a
  full-buffer `200`**, and never read a whole file into memory — stream with
  `fs.createReadStream(path, { start, end })`. If you touch serving, run the
  Range tests and the live `curl -sI -r 0-1` probe.
- **Hidden-file ignore** mirrors the upstream importer's behavior: dotfiles and
  `*.partial` are skipped when `IGNORE_HIDDEN=true`. Don't surface partials.
- **The image runs non-root** (`USER node`) and adapter-node needs
  `node_modules` in the runtime stage — don't switch to adapter-static.
- **iOS feed techniques are load-bearing** (see `handoff.md`): `muted` +
  `playsinline`, `100dvh`/`100svh` (never `100vh`), a single IntersectionObserver
  playing one video at a time. `grep -rn '100vh' src` must stay empty.
- **The page feed is randomized and has no resume (intentional, 0.3.0).** The
  `/` page shuffles the scan with a fresh server-side seed per request, so order
  changes every load and there is no resume-to-last-index. This is a deliberate
  deviation from the SPEC §4 resume behaviour and the §3 mtime-desc page default
  — don't "restore" resume thinking it regressed. `/api/feed` is unchanged
  (mtime-desc default, opt-in `?shuffle`); only the page default differs. The
  shuffle reuses `seededShuffle` from `videos.ts` by import — it does **not**
  modify the serving layer.
