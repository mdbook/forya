# Changelog

All notable changes to this project are documented here. Versions follow
[Semantic Versioning](https://semver.org/). `package.json` `version` is
canonical and `VERSION` mirrors it; bump both in the same commit.

## 0.3.2 — kill the cold-scan stall (dir-mtime cache + single-flight)

Serving-layer perf fix for the large-feed cold load. Pre-existing (0.3.0 had it
under the black screen), surfaced once 0.3.1 cleared everything else. The HTTP
Range contract and the rest of `videos.ts` are byte-unchanged — only the
scan/cache block changed.

### Fixed

- **~9s cold page load on the largest feed (11.9k files).** The directory scan
  is now cached and **invalidated by the directory's mtime** instead of a short
  wall-clock TTL (which was shorter than the scan itself, so it re-scanned almost
  every request). A stable feed directory scans **once**, then serves instantly;
  it re-scans only when the directory actually changes (a dir mtime bumps on
  entry add/remove/rename — exactly when the manifest changes).
- **Concurrent-request stacking.** Concurrent scans of the same directory now
  **single-flight** — they share one in-progress scan instead of each launching
  their own (a 3× burst had stacked to 35–41s).

### Notes

- In-memory only — no new env vars, no writable volume, no `/docker` change; the
  image stays stateless (clean watchtower swap). A single cold scan per deploy is
  expected and acceptable.
- Edge: a file changed in place without an add/remove/rename won't bump the dir
  mtime, so its updated sort position could be stale until the next entry change
  — negligible for write-once downloads (documented in `handoff.md`, with a
  readdir-fingerprint fallback noted as the escape hatch).

## 0.3.1 — regression hotfix (black screen, scroll autoplay, slow load)

Hotfix for regressions the operator's on-device iPhone smoke found in 0.3.0.
Entirely frontend / page-load — the serving layer (Range resolver, media route,
server config) is byte-unchanged.

### Fixed

- **Black screen on large feeds** (liked/favorite, 8k–12k files): the feed used
  to mount a full `<video>` component for _every_ item; now only the cards inside
  the lazy-load window mount a player (off-window cards are a cheap placeholder),
  capping live decoders regardless of feed size. Removed the 0.3.0 first-frame
  `currentTime` nudge (which painted a black frame under memory pressure) in
  favour of a **reveal-gate**: the `<video>` only becomes visible once it has
  actually started playing, so a blocked/pre-play card shows the placeholder, not
  black.
- **Scroll-to-next autoplay** (best): a freshly-active card now retries its muted
  autoplay once on rejection (still gesture-free — not gated on the unlock flag),
  so scrolling reliably autoplays instead of needing a manual tap.

### Changed

- **Slimmer first load**: the page no longer inlines the entire manifest into the
  SSR payload (6.7MB for liked). It sends a small first page plus the shuffle
  `seed` + `total`; the client lazy-loads the rest via `/api/feed` threading the
  same seed, so the randomized order continues with no dupes/re-shuffle.
- `/api/feed` gains additive `offset` / `limit` params (the no-param default
  contract — full mtime-desc list — is unchanged).

### Notes

- No new env vars (clean watchtower swap).
- The pre-existing cold directory-scan cost (~9s on the largest feed) is **not**
  addressed here; a persistent/longer-memo scan is queued as **0.3.2** (a
  serving-layer change with a full Range re-gate).

## 0.3.0 — randomized feed + control consolidation + autoplay polish

Feed-UI/player batch from operator feedback after 0.2.0 went live. Entirely
client/UI + page-load order — the serving layer (Range resolver, media route,
server config) is byte-unchanged.

### Frontend

- **Randomized feed (default on)**: the page feed is now shuffled server-side
  with a fresh seed per request, so every refresh yields a new order. SSR'd, so
  no reorder flash; server stays stateless. The `/api/feed` endpoint keeps its
  mtime-desc default and opt-in `?shuffle=1&seed=N` — only the page default
  changed. **Resume-to-last-index was removed** (a saved index is meaningless
  when the order reshuffles each load) — an intentional change from the SPEC §4
  resume behaviour and the §3 mtime-desc page default.
- **One control rail**: mute, loop/next, share, info, and hide now all live on a
  single right-side rail (previously split across the corners). The loop/next
  button shows the **current mode as a label** ("Loop" / "Next") plus a lit
  active state, with a brief confirmation toast on toggle.
- **Landscape fit**: object-fit is now symmetric — a portrait clip on a
  landscape display letterboxes instead of showing only its middle third (fixes
  the inverse of the 0.2.0 one-directional crop). Pure `pickFit`, guarded by
  `fit.test`; portrait-on-portrait still fills edge-to-edge.
- **Autoplay / first-frame polish**: the buffering spinner and the manual play
  button are now mutually exclusive (no more spinner behind the play glyph); a
  first-frame nudge coaxes a poster frame so a scrolled-to card never shows
  blank black; a session "playback unlocked" flag retries a transiently-rejected
  play instead of re-prompting. Muted autoplay-on-load stays gesture-free
  (criterion 3). _iOS-specific tuning verified on-device by the operator._
- **Share icon** swapped to the more visually-centered `share` glyph.

### Config

- No new env vars (clean watchtower swap — no recreate needed).

## 0.2.0 — feed UX + curation

Feature batch over the 0.1.0 base. All client-side except an additive caching
header — the `/srv/videos` read-only contract and the Range contract are
unchanged.

### Frontend

- **Lucide icons** replace all emoji glyphs (per-icon imports, tree-shaken,
  bundled at build → still offline-safe).
- **Hide from feed** ("trash"): per-card control (env-gated `ALLOW_HIDE`,
  default off) that hides a video client-side (localStorage), with an Undo
  toast. Never touches disk. _TODO: an auth-gated panel to manage hidden videos._
- **Windowed lazy-loading**: only a direction-biased window around the active
  card carries a real `<video src>` (caps simultaneous iOS decoders); the active
  card is always loaded. Smooth bidirectional scroll — buffers ahead, keeps the
  last few warm, and reloads previous cards on sustained back-scroll. Tunable via
  `PRELOAD_AHEAD` / `PRELOAD_BEHIND`.
- **Share / save** (Web Share API, download fallback), a **seek bar** on the
  active card (scrub → Range seek), an **autoplay-next** toggle (advance on end
  vs. loop; `AUTO_ADVANCE` default, persisted), and a **filename/info overlay**
  toggle — surfaced via a right-side action rail.
- **Adaptive object-fit**: off-aspect (wider-than-viewport) clips letterbox
  instead of middle-cropping; portrait content still fills edge-to-edge.

### Backend

- Additive `Cache-Control: private, max-age=3600` on `/api/media/<name>` so the
  windowed feed reuses bytes on scroll-back. Purely additive — the
  `206`/`Content-Range`/`416`/HEAD Range contract is byte-identical (guarded by a
  new `range.test` case).

### Config

- New env: `ALLOW_HIDE`, `PRELOAD_AHEAD` (3), `PRELOAD_BEHIND` (2),
  `AUTO_ADVANCE` — all optional with documented defaults.

## 0.1.0 — initial release

First cut: an iOS-first vertical video feed serving UI + video bytes from one
self-contained adapter-node image.

### Backend

- Range-correct `GET|HEAD /api/media/<name>` — `206` + `Content-Range` +
  `Accept-Ranges`, `416` on unsatisfiable, suffix/open/closed ranges, HEAD
  mirrors GET with no body. Streamed (never buffered); path-traversal safe.
- `GET /api/feed` — directory-scan manifest (`name`/`url`/`size`/`mtime`/`type`),
  mtime-desc, deterministic `?shuffle=1&seed=N`, ~10s scan memoization.
- `GET /api/healthz`, templated `GET /manifest.webmanifest` (branded by
  `FEED_NAME`).
- Env config (`VIDEO_DIR`, `FEED_NAME`, `IGNORE_HIDDEN`, `PORT`, `HOST`);
  dotfile/`.partial` filtering; `.mp4/.mov/.webm/.m4v`.
- Unit tests guarding the Range resolver, the HTTP contract, the scan filters,
  and path-traversal rejection.

### Frontend

- Svelte 5 iOS feed: `muted`+`playsinline` autoplay, `100dvh`/`100svh`
  scroll-snap (no `100vh`), single IntersectionObserver one-at-a-time playback,
  tap-to-play fallback, reactive preload window, mute toggle with audio unlock,
  optional resume, desktop keyboard controls.
- Installable PWA (standalone, portrait, per-instance home-screen name);
  placeholder icons.

### Build / CI

- Multi-stage `node:20-alpine` Dockerfile (adapter-node, non-root, `VOLUME
/srv/videos`).
- GitLab CI: `verify → build → notification`; Kaniko build with branch tagging
  (`main` → `:latest`/`:$VERSION`/`:$SHA`, `dev` → `:dev`/`:$SHA`); version-tag
  guard; Discord notifications.
