# Changelog

All notable changes to this project are documented here. Versions follow
[Semantic Versioning](https://semver.org/). `package.json` `version` is
canonical and `VERSION` mirrors it; bump both in the same commit.

## 0.6.1 — first-card two-tap fix (muted-autoplay + in-gesture unmute)

The 0.6.0 first card sometimes needed **two taps** to start with sound. Unmuting a
paused, fully-buffered idle `<video>` via an in-gesture `pause()→muted=false→play()`
is the "start audible from a buffered paused element" transition WebKit refuses (a
cold element one-tapped only incidentally — its `play()` _is_ the load WebKit
blesses). Fixed by switching to the canonical iOS tap-to-unmute shape: the active
card now **muted-autoplays continuously** and the first tap just flips `muted=false`
**synchronously in the gesture** on the already-playing element — which WebKit
grants because there's no separate "start audible from paused" decision. Verified
on device (iOS 26.5.1): one tap → sound.

This **reverts the 0.6.0 "start-paused" model** back to muted-autoplay. The always-
muted cure is unchanged as a hard invariant: **no `<video>` ever does an ungestured
unmuted `play()`** — every `play()` is muted, and the only unmute is a flip on an
already-playing element (off-gesture only once the pool is blessed + the element is
confirmed playing). The sound-on carry (card→card + across auto-advance) is
unaffected.

### Changed

- **Active card muted-autoplays on load** instead of sitting paused on its poster;
  the rail's muted icon is the "tap to unmute" affordance. The pool's neighbours
  also play muted continuously, so the bless gesture only ever flips `muted=false`
  on already-playing elements.
- **`blessPool` is now a bare synchronous `muted=false` flip** (no `pause()` /
  `play()` / `await`), re-muting neighbours in the same loop.
- **Reverted the 0.6.0 `blessed` gate on `shouldRetryOnPlayable`** — the `canplay`
  self-heal again recovers a cold pre-bless muted-autoplay; the retry is always a
  _muted_ play (audible output is gated separately), so it stays cure-safe.

### Added

- **`ua=` in the DEBUG overlay** — `navigator.userActivation.isActive` captured at
  the bless flip, to read gesture-liveness on device.

## 0.6.0 — sound-on carry via a pooled `<video>` rearchitecture

The headline feature: **turn sound on once and it carries** — across scrolls
**and** across programmatic auto-advance — which the old fresh-`<video>`-per-card
design could never do on iOS. Root insight (harness-proven on iOS 26.5.1): iOS's
"may-play-unmuted" grant is **per-element, durable, and survives `src` swaps**. So
`Feed` now owns a small fixed **pool** of persistent `<video>` elements
(`POOL_SIZE = 3`, prev/cur/next) and reparents + `src`-recycles them across cards
instead of mounting one per card. A pool blessed once in a gesture carries sound
through every later card and auto-advance. Decoder count is bounded by the pool
(3) — fewer than the old windowed ~6.

The always-muted cure (0.5.5) is preserved as a hard invariant: **no `<video>`
ever does an ungestured unmuted `play()`.** The feed starts "paused-but-unmuted" —
the first tap is a genuine in-gesture play that mints the per-element grant.

### Added

- **Pooled `<video>` play machine** — pure, tested coverage/recycle math in
  `src/lib/pool.ts`; `Feed.svelte` owns the elements. `VideoCard` is now a
  presentation shell (poster / reveal / seek / tap), no `<video>`.
- **Sound carries card→card and across auto-advance** after one sound-on tap.
- **First-MB prewarm** — a side-channel `Range: bytes=0-1048575` fetch warms each
  covered card's moov + first GOPs into the HTTP cache (faster first paint,
  notably on slower links); superseded prewarms abort on a fast flick.
- **Desktop a11y** — keyboard `:focus-visible` rings, `prefers-reduced-motion`
  honored (scroll + cross-fades + spinner), the global Space handler no longer
  shadows a focused control, and the seek slider announces a time readout.
- **Auto-advance skips an errored card** (404 / decode-fail) instead of dead-
  ending, capped (3 consecutive, reset on a successful play) so an all-broken feed
  can't cascade.

### Fixed / changed

- Rotation/resize now re-fits already-parked pooled videos (was: only on a
  `src`-swap), so a portrait clip no longer stays mis-letterboxed after rotate.

### Removed

- Dead code: `src/lib/window.ts` + `feedWindow` (superseded by `pool.ts`
  coverage), `loadMute` (the feed starts unmuted by design), and the unused
  `shouldGestureUnlock` export (its logic lives inline in `Feed.onTouchEnd`).

### Known issues

- **First-card two-tap (tracked for 0.6.1).** Turning sound on for the very first
  (cold) card can need a second tap while it buffers. It's a **documented WebKit
  policy** — unmuting a paused, fully-buffered idle element off gesture-driven
  playback is refused; on the LAN the element is ~always buffered at tap (a
  prewarm-off A/B confirmed prewarm is not the cause). Sound carries cleanly once
  started. The fix (muted-play-then-unmute in-gesture) is a core-bless rewrite
  needing on-device confirmation — deferred. See `two-tap-investigation.md`.
- **Silent/ringer switch.** On iOS the hardware silent switch mutes inline video
  audio regardless of a valid unmute — a platform constraint, not a bless bug.

## 0.5.5 — always-muted autoplay (fixes the residual iOS autoplay break)

Root-caused the residual every-~8-videos autoplay break: it was **unmuted
autoplay**. iOS Safari only grants gesture-free autoplay to a **muted** element;
once the user turned sound on, the persisted preference was applied to every
card's autoplay (`v.muted = muted`), so each fresh card did an _unmuted_ `play()`
→ `NotAllowedError` → autoplay revoked document-wide until a gesture. (Confirmed
on-device: a muted feed scrolls infinitely with zero breaks; the instrumentation
overlay pinned the reject as `NotAllowedError`, not decode/resource/readiness.)

### Fixed

- **Autoplay is now ALWAYS muted** (`VideoCard.tryPlay` sets `v.muted = true`
  unconditionally), so it's gesture-free and never trips `NotAllowedError`. The
  persisted sound preference no longer reaches a fresh autoplay — restoring the
  criterion-3 gesture-free-muted-autoplay contract.
- **Sound-on is honored by unmuting only the ACTIVE card, inside a gesture**
  (`toggleMute`, and the `touchend` handler so sound carries across scrolls) — a
  property set on an already-playing element, never a `play()`, so it can't
  re-trip the gate. The mute `$effect` no longer reactively unmutes.

## 0.5.4 — gesture-unlock two-tap fix + playback instrumentation

Fixes the two-tap regression 0.5.3 introduced, and adds a dark-by-default
diagnostic overlay used to chase the residual iOS autoplay break. Frontend only;
the serving layer is byte-untouched.

### Fixed

- **Two-tap recovery regression (0.5.3):** the gesture-unlock listener fired on a
  stationary tap as well as a scroll, so a tap would `play()` (via `touchend`) and
  then the synthesized `click` → `togglePlay` would immediately `pause()` it —
  needing a second tap. The unlock now fires only on a real scroll-drag
  (`touchMoved` > 10px); a tap is handled solely by `togglePlay` (which already
  plays in-gesture). The redundant container `click` listener is dropped.
  `shouldGestureUnlock` now takes `{ activeBlocked, moved }` (pure + tested).

### Added

- **`DEBUG_PLAYBACK` diagnostic overlay (default OFF, inert in prod):** when set,
  surfaces a live `<video>`/readyState count + a rolling per-card play-event log
  (attempt / reject + `err.name` / error + code / playing) and the build SHA
  (`build=<sha8>`, baked via the Dockerfile `BUILD_SHA` arg ← CI). A diagnostic
  aid for the autoplay investigation; never enabled on a release deploy.

## 0.5.3 — gesture-unlock autoplay recovery + poster cross-fade

Fixes the **document-wide** iOS autoplay break the operator reproduced on-device
(#287): a single muted-`play()` rejection (~1 in 8 cards) doesn't just stall one
card — it revokes autoplay permission for the **whole document**, so every later
card also stops autoplaying until a real user gesture restores it ("one tap
unlocks all"). This is a different axis from 0.4.0 (decoder cascade) and 0.5.1
(per-card buffer/race), and it's why 0.5.1's self-heal couldn't catch it — the
block is gesture-level, not buffer-level. Root cause: 0.4.0 removed the
session-scoped gesture-unlock path (`playback.svelte.ts`), leaving no recovery.
Frontend only; the serving layer is byte-untouched and the cascade guard /
single-IntersectionObserver invariants are intact.

### Fixed

- **Document-wide autoplay revocation:** Feed now re-attempts `play()` on the
  active card **synchronously inside the next user gesture** (`touchend` + `click`,
  both passive) whenever that card is autoplay-`blocked`. Running the call in the
  gesture's stack is what re-grants iOS's document-wide permission; the active
  card plays and every subsequent card autoplays again via its normal path. The
  retry fires only when blocked — never over an intentional pause, and a no-op on
  a healthy card. `touchend` (not `pointerup`) because a scroll-fling fires
  `pointercancel` and stops pointer events, exactly the case being recovered.
  Decision extracted to the pure `shouldGestureUnlock` (unit-tested); VideoCard
  reports its blocked state to Feed via a new `onblocked` callback. The 0.5.1
  self-heal is kept — it still catches the non-revoked buffer/handover cases.
- **Poster → video black flash:** the placeholder (gradient + poster) now stays
  mounted and cross-fades out over the same 0.25s the `<video>` fades in, instead
  of hard-cutting on first paint — so the black `<video>` background no longer
  shows through for a frame on reveal.

## 0.5.2 — tap-to-copy clip ID (debugging aid)

A small operator-requested hotfix to unblock cataloguing which clips still
mis-autoplay: the info panel's clip ID is now tap-to-copy. Frontend only; the
serving layer is byte-untouched.

### Added

- **Copy clip ID:** tapping the ID in the info panel copies the `/api/media`
  filename via `navigator.clipboard` (works on iOS Safari over HTTPS) with a
  brief "Copied ID ✓" toast. If the clipboard API is unavailable/blocked the ID
  is `user-select:text`, so a long-press → Copy still works.

## 0.5.1 — autoplay self-heal + worker key cleanup

Fixes two pre-existing (0.4.x) iOS autoplay residuals the operator hit on-device:
a fast-scroll-settled card that stayed dark, and an isolated `play()` rejection
on an otherwise-conformant clip. Both traced to the same root — the 0.4.0
single-`requestAnimationFrame` retry (~16ms) is far too short for a freshly-
mounted card's first buffer over a slow origin, after which the card released its
decoder with no way to recover. Frontend only; the serving layer (Range/media/
config/scan) is byte-untouched, and the 0.4.0 cascade guard is intact.

### Fixed

- **Autoplay self-heal:** the active `<video>` now re-attempts play on
  `canplay`/`loadeddata` (when the media reports it can play) via the pure,
  tested `shouldRetryOnPlayable` (`src/lib/playback.ts`) — so a settled-but-not-
  yet-buffered card plays the moment it's ready instead of going dark. For the
  complementary case — an already-buffered clip that lost a decoder-handover race
  (where `canplay` already fired and won't re-fire) — a single bounded,
  generation-guarded delayed re-attempt fires when `isMediaReady(readyState)` at
  rejection time. The two paths are mutually exclusive by `readyState`.
- **Release only on real errors:** a transient `play()` rejection now surfaces
  tap-to-play but keeps `src` (so the self-heal can fire). Dropping `src` to free
  the decoder is reserved for a genuine media `error` (the actual cascade case)
  and for unmount — unchanged.
- **Worker job key:** the single-flight key separator was a literal NUL byte,
  which flagged `worker.ts` as binary to git; switched to a space (no behaviour
  change).

## 0.5.0 — self-generated posters + metadata (opt-in via DATA_DIR)

forya now generates its OWN posters and video metadata, so the public project
stands on its own given just a library dir — no external importer needed.
**Entirely opt-in:** with `DATA_DIR` unset (the default) the feature is fully
dark — no ffmpeg ever spawns, nothing is written anywhere, and every response is
byte-identical to before. The read-only `/srv/videos` contract is unchanged;
forya writes only under `DATA_DIR`.

### Added

- **`DATA_DIR`** (new, optional): a writable dir forya owns for its generated
  poster/metadata cache. Unset → feature off. The image declares `VOLUME /data`
  (owned by `node`); enable with `-e DATA_DIR=/data -v forya-data:/data`.
- **Metadata** (ffprobe): each video's width/height/duration, cached and added
  **additively** to the feed manifest. The client uses width/height to **pre-set
  object-fit before the video loads — killing the fit-jump** on off-aspect clips.
- **Posters** (ffmpeg): a thumbnail (~0.5s frame) per video, served from the new
  `GET /api/poster/<name>?v=<mtime>` route and shown in the placeholder until the
  video reveals. The route is path-guarded (`safeMediaPath` + `lstat`, no symlink
  escape), reads the cache only, and **degrades to `204` → the gradient
  placeholder** when there's no poster yet (never 500s, never stalls).
- **Background worker**: generation runs lazily and bounded so ffmpeg never
  competes with serving — concurrency 1, single-flight per `name+mtime`, queued,
  kicked on a poster cache-miss (no boot-time bulk encode), spawned at low
  priority (`nice` + best-effort `ionice`). The ffmpeg spawn is never on a request
  or Range path.

### Build

- Runtime image adds `ffmpeg`/`ffprobe` (~80MB, alpine; only used when
  `DATA_DIR` is set). Base image is now **digest-pinned** (ffmpeg floats within
  the alpine branch). Resolved at build: **ffmpeg 8.0.1**.

### Notes

- The serving core (`resolveRange`, the scan, `safeMediaPath`) is byte-unchanged;
  the only serving-four edit is the additive `DATA_DIR` read in `config.ts`.

## 0.4.0 — playback resilience (autoplay cascade + load priority)

Operator on-device found that a per-video iOS muted-autoplay rejection (some
source clips are oddly encoded — a transcode/normalization concern, separate)
also broke the **next** preloaded video. Root-caused (with a complete code
review) to three missing guards in the client playback state machine; all three
fixed here. Frontend-only — the serving layer is untouched.

### Fixed

- **Autoplay cascade.** A failed autoplay used to (a) keep retrying on a card the
  user had already scrolled past, (b) never release its decoder, and (c) sit
  beside an eagerly-preloading neighbour — so one bad clip poisoned the next.
  Now: the play retry is **generation-guarded** (a stale/scrolled-past/destroyed
  attempt no-ops; `AbortError` is treated as benign, not a failure), a
  **definitively-failed video releases its decoder** (drops `src`, re-attached on
  tap — the placeholder already covers it visually), and a `MediaError` is
  handled (`onerror`) instead of leaving an eternal spinner. One bad video now
  shows only its own tap-to-play and never breaks the next.
- **Load priority (slow connections).** Preload is now **readiness-gated**: until
  the currently-showing video actually reaches `playing`, it is the _only_ card
  fetching (neighbours stay mounted but idle). The feed loads the current video
  first instead of pulling several at once on a cold start, and on scroll the
  about-to-play card immediately becomes the priority. This also removes the
  decode contention that fed the cascade.

### Changed

- Removed the now-dead `playback.unlocked` flag (0.3.1's unconditional retry left
  it with no readers).

### Notes

- No new env vars (clean watchtower swap). The muted+playsinline autoplay-on-load
  is still gesture-free; the single IntersectionObserver and mount-window are
  unchanged (only the `preload` hint is priority-gated).
- The _reason_ some clips reject autoplay (inconsistent fps/colorspace) is a
  separate source-normalization effort; 0.4 makes the player resilient to it.

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
