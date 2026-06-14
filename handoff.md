# handoff.md — forya

Gotchas, decisions, and load-bearing context that aren't obvious from the code.
Add to this when you discover something painful so the next agent doesn't
re-derive it.

## Why this rewrite exists

forya replaces `erin` (`mosswill/erin`, a Caddy file-server + React feed) which
was buggy on iOS Safari. Every bug was in the feed/serving layer:

- **No `muted` + `playsinline`** → iOS rejects autoplay outright.
- **`100vh`** instead of `100dvh`/`100svh` → layout breaks under Safari's
  dynamic toolbar (content hidden behind it / a gap appears).
- **Scroll-snap + play/pause mis-orchestrated** → many videos decoding at once,
  jank, audio bleed.
- **HTTP Range mishandled** → scrubbing/seek fails.

So forya is fundamentally **an iOS-tuned feed UI over a thin, Range-correct
serving backend.** The upstream importer that fills `VIDEO_DIR` is unchanged —
forya only replaces the serving/feed layer, so the old feed stays a hot
rollback.

## Load-bearing decisions

- **HTTP Range is the whole point.** `src/lib/server/videos.ts` keeps the byte
  math in a pure `resolveRange(header, size)` so it's unit-testable; the
  `/api/media/[name]` route is a thin wrapper that streams via
  `fs.createReadStream(path, { start, end })` (inclusive `end`, matches HTTP).
  `tests/range.test.ts` guards both the pure resolver and the real HTTP
  contract. **A Range request must never be served as a full `200`.**
- **HEAD mirrors GET.** The acceptance probe is `curl -sI -r 0-1`, which is a
  **HEAD** with a Range — it must return `206` + `Content-Range` (no body), not
  a `200`. The first implementation had HEAD ignoring Range; the live probe
  caught it (the unit tests, which only ranged GET, did not). Lesson: probe the
  real HTTP contract, not just the pure function.
- **adapter-node, not adapter-static.** One Node process serves UI + bytes. The
  runtime Docker stage **must** copy `node_modules` (adapter-node needs them);
  don't "optimize" that away. Runs non-root (`USER node`).
- **Healthchecks/probes must target `127.0.0.1`, not `localhost`.** The runtime
  image has busybox `wget`, so a compose healthcheck can use it — but busybox
  resolves `localhost` to `::1` (IPv6) first, while adapter-node binds IPv4
  `0.0.0.0` only, so `wget http://localhost:3000/api/healthz` gets connection
  refused _inside the container_. Use `http://127.0.0.1:3000/api/healthz`. (Same
  trap for any IPv6-preferring probe client.)
- **`config.ts` reads `process.env`, not `$env/dynamic/private`.** With
  adapter-node, `process.env` _is_ the runtime source that `$env/dynamic/private`
  proxies — equivalent at runtime, still read-at-runtime (not baked at build).
  We use `process.env` because `$env/dynamic/private` is a build-time snapshot
  under vitest, which made the `/api/media` route impossible to integration-test
  (couldn't set `VIDEO_DIR`). Reading `process.env` keeps the load-bearing Range
  route fully integration-tested — which is exactly what caught the HEAD trap
  above. Don't "fix" it back to `$env` without solving the test-env problem.
- **The feed is source-virtualized by a windowed loader (0.2.0).**
  `Feed.windowState` keeps a real `<video src>` only on cards inside a
  direction-biased window `[active − behind, active + ahead]` (defaults 2/3,
  tunable via `PRELOAD_BEHIND`/`PRELOAD_AHEAD`); off-window cards are srcless
  placeholders and `VideoCard` calls `video.load()` on exit to **release the iOS
  decoder**. The active card (`d === 0`) is _always_ live, so a `j`/`k` jump or
  fast scroll to any index force-loads and plays it — never a srcless active
  card. Scrolling up swaps ahead/behind so sustained back-scroll loads the
  previously-uncached cards. Preload gradient inside the window: active + the
  immediate neighbour in the travel direction get `auto`, the rest `metadata`.
  (Superseded the 0.1.0 `preloadFor` "+1 warmer" metadata window.)
  - **0.3.1 — virtualized at the MOUNT level, not just `src`.** The window logic
    moved to a pure `src/lib/window.ts` `feedWindow()` (guarded by
    `tests/window.test.ts`, incl. the active-always-live invariant). `Feed` now
    only **mounts** the heavy `VideoCard` for `live` cards; off-window cards
    render a cheap `.card-rest` placeholder (no `<video>`, no effects). This was
    the black-screen fix: the old code mounted a `<video>` component for _every_
    item, so a 12k-file feed instantiated ~12k players and blew mobile Safari's
    memory. Leaving the window now **unmounts** the player (removing the
    `<video>` releases the decoder; `VideoCard.onDestroy` also pause+load()s to
    make it explicit) — which **supersedes the 0.3.0 `src`/decoder hysteresis**
    (removed). The `preloadBehind` window (default 2) is the back-scroll buffer
    now. `.card` cells still always render (100dvh, `data-index`, IO-observed) so
    scroll height + the single IO are intact.
- **The page feed is randomized per load; resume was removed (0.3.0).**
  `+page.server.ts` shuffles the scan with a fresh server-side seed each request
  (`seededShuffle`, reused from `videos.ts` — that file is _not_ modified). SSR'd,
  so no reorder flash; server stays stateless. This is an **intentional deviation
  from SPEC §4** (which lists a resume-to-last-index) and the **§3 page default**
  (mtime-desc): a saved index is meaningless once the order reshuffles each visit,
  so `stores/seen.ts` and the resume/`saveSeen` wiring were deleted, not left
  dangling. **`/api/feed` is unchanged** — still mtime-desc by default with opt-in
  `?shuffle=1&seed=N`; only the page default changed. `hidden.ts` filters by
  filename, so hides still work post-shuffle.
  - **0.3.1 lazy-load.** The page no longer inlines the whole manifest (6.7MB on
    liked) into the SSR payload — it sends only the first page (`FIRST_PAGE` = 24)
    plus `seed` + `total`. `Feed` lazy-loads the rest near the scroll tail via
    `/api/feed?shuffle=1&seed=<same>&offset&limit` (additive params; the no-param
    default contract is untouched). Threading the **same seed** makes
    `seededShuffle` deterministic, so each page continues the same order (client
    dedupes by name). **Edge:** the scan cache (see below) re-scans only when the
    dir changes, so within a stable dir the continuing order is consistent; an
    add/remove mid-session re-scans and could shift the tail (dupes/gaps) —
    acceptable for a homelab feed.
- **Scan cache: dir-mtime invalidation + single-flight (0.3.2).** `scanVideos`
  caches the directory walk in-process and invalidates it by the **directory's
  mtime**, not a wall-clock TTL. The old ~10s TTL was _shorter_ than the largest
  feed's ~9–13s scan, so it was born expired and re-scanned almost every request
  (liked's ~9s cold load). A directory's mtime bumps on entry add/remove/rename —
  exactly when the manifest changes, including the `.partial → final` rename — so
  a stable dir scans **once** then serves instantly; a cheap `stat` per request
  validates freshness. Concurrent requests **single-flight** (shared `inflight`
  promise, registered synchronously before the first `await`, cleared on settle
  so a failed scan retries rather than poisons) — a 3× burst no longer stacks to
  35–41s. **In-memory only** — no new env, no writable volume, stateless image
  (one cold scan per deploy is fine). **Edge:** a file changed in place _without_
  an add/remove/rename won't bump the dir mtime → stale sort order until the next
  entry change; negligible for write-once downloads. **Escape hatch** if a mount
  ever fails to propagate entry changes to the dir mtime: swap the mtime key for
  a names-only readdir fingerprint (count + hash, mtime-independent) — not built,
  but the drop-in replacement. The `resolveRange`/Range surface of `videos.ts` is
  untouched by all of this (0.3.2 changed only the scan/cache block).
  - **0.7.0 — serve-stale feed + readdir-only scan (supersedes the request-path
    scan above).** Cold `/api/feed` on liked was ~24s because the scan did one
    `fsp.stat` **per file** (12k files × a CIFS round-trip), on the request path. A
    bare `readdir` of the same dir is ~1.2s (SMB returns dir attrs inline with the
    enumeration), so the per-file stats were the whole cost. Three things changed,
    **all in the scan subsystem of `videos.ts` — the Range/byte-serve functions
    stayed byte-identical** (review verified per-function sha256):
    - **The request path never scans.** New `getFeed()` is what `/api/feed` and SSR
      call (NOT `scanVideos` — that's now the background worker). It returns the
      last-known-good manifest from memory instantly and only schedules a background
      revalidate when due (still single-flight; throttled to `REVALIDATE_INTERVAL_MS`
      = 30s). A cold container with no manifest returns `{ items: [], warming: true }`;
      `+page.svelte` renders a brief warming screen and `invalidateAll()`-polls until
      the first background scan lands (~1–2s). **No persistence, no `DATA_DIR`, no
      compose change** — warming makes restart-cold a ~1s screen, not a 24s block.
    - **Readdir-only on poster-off feeds (Approach B).** `doScan(..., cheap)` skips
      the per-file stat when `config.dataDir === ''` (the big liked/favorite feeds):
      `size`/`mtime` are left undefined. Nothing there reads them — posters are off
      (no meta cache key) and the UI always shuffles (mtime order is discarded). The
      poster feed (best, `DATA_DIR` set) keeps the full stat because `mtime` IS its
      poster cache key. `FeedItem.size`/`mtime` are now **optional**.
    - **Base order is name-asc, not mtime-desc** (the per-file stat that mtime-desc
      needed is gone). A stable total order over unique filenames keeps SSR +
      `/api/feed` seeded-shuffle paging coherent. Updates the 0.3.0 note above:
      `/api/feed`'s default order is now name-asc (it's our API; no external
      consumer depends on mtime-desc).
    - **Info-overlay size is lazy.** With `size` off the manifest on the big feeds,
      the info panel fetches it for the **single open card** via `HEAD /api/media`
      (`Content-Length` = file size) — one request, on demand, never a scan
      (`Feed.svelte` `ensureInfoSize`). The poster feed keeps the manifest `size`.
- **Posters + metadata: forya's FIRST writable state, fully opt-in (0.5).** The
  whole subsystem is gated on **`DATA_DIR`**: unset (`config.dataDir === ''`) →
  no ffmpeg/ffprobe ever spawns, nothing is written anywhere, the manifest +
  every `/api` response is byte-identical, and `/api/poster` 204s. Containment
  keys on the **env var**, never on whether `/data` exists — proved by a
  hard-test (`tests/dataCache.test.ts`: spies assert zero fs calls when disabled
  even with a writable data dir present). forya writes **only** under `DATA_DIR`;
  `/srv/videos` stays `:ro`. Pieces: `dataCache.ts` (atomic tmp+rename, name+mtime
  key like the scan cache, validate-before-serve, never an empty/0-byte artifact);
  `probe.ts` (ffprobe → width/height/duration, additively enriched onto the sent
  PAGE only — `enrichItems` is identity when off, layered ON TOP of `scanVideos`,
  so the Range core is byte-unchanged); `poster.ts` (ffmpeg → one ~0.5s mjpeg
  frame, `isJpeg` SOI..EOI validate); `worker.ts` (the generator — concurrency 1,
  single-flight by name+mtime, bounded, **fire-and-forget so ffmpeg is NEVER
  awaited on a request/Range path**, kicked lazily by `/api/poster` on a cache
  miss, no boot bulk-encode); `nicedExec.ts` (`nice -n 19` + best-effort
  `ionice -c3` that **degrades to nice-only** if ionice is absent — no util-linux
  dep). ffprobe/ffmpeg are behind injectable runner seams so tests mock them
  (CI needs no ffmpeg). The ONLY serving-four touch is the additive `DATA_DIR`
  read in `config.ts`. Image: `apk add ffmpeg` (resolved **ffmpeg 8.0.1** at the
  digest-pinned base), `VOLUME /data` owned by `node` (named volume inherits it;
  a bind mount is chowned 1000:1000 by the operator). Deploy sets `DATA_DIR` +
  the volume via `update.sh` (a new env var → recreate, not a watchtower swap).
- **Object-fit is symmetric (0.3.0).** `src/lib/fit.ts` `pickFit(vw, vh,
viewportAR)` is pure (guarded by `tests/fit.test.ts`): it letterboxes
  (`contain`) once the clip/viewport aspect ratios diverge past `MAX_COVER_RATIO`
  (1.8) in **either** direction — landscape-on-portrait _and_ portrait-on-
  landscape (the latter was the 0.3.0 "middle-third on a desktop" bug; the 0.2.0
  rule only caught the former). Normal portrait-on-portrait stays `cover`.
  `VideoCard` derives `fit` reactively from intrinsic dims + a `viewportAR` prop
  that `Feed` updates on resize/orientation, so it re-fits on rotate.
- **Hiding ("trash") is client-side only — `VIDEO_DIR` stays `:ro`.** The hide
  control (`ALLOW_HIDE`, default off) adds the filename to a per-`FEED_NAME`
  localStorage set (`stores/hidden.ts`); `Feed` renders through the pure
  `applyHidden` filter. It **never deletes, moves, or writes** anything — the
  read-only input contract is intact, no `:rw` remount needed. Reversible via the
  Undo toast (so no confirm dialog). The hidden set is per-device.
- **Media responses carry `Cache-Control: private, max-age=3600` (0.2.0).**
  Additive only — it lets the windowed feed reuse already-fetched bytes on
  scroll-back without a revalidation round-trip. It does **not** touch the Range
  branch logic; `private` because instances sit behind per-user forward-auth
  (never a shared proxy cache). A `range.test` case asserts it doesn't perturb
  the 206/200/HEAD responses.
- **One IntersectionObserver, one active video.** `Feed.svelte` owns the only
  IO (threshold ~0.6, root = the scroll container). The entering card becomes
  `activeIndex`; cards receive `active={i === activeIndex}` and play/pause off
  that — they never observe themselves. `grep -rn 'new IntersectionObserver'
src` should return exactly one hit.
- **`forya` is operator-overridable.** The name isn't load-bearing anywhere
  `FEED_NAME` belongs. A rename is a find/replace; don't hardcode `forya` into
  serving/feed logic.

## 0.8.3 — server-side hide (hidden.json, mirror of starred) + media symlink guard

- **`src/lib/server/hidden.ts` is a faithful mirror of `starred.ts`** (single
  `hidden.json` under `DATA_DIR`, atomic tmp+rename, one serialized write-queue,
  in-memory Set cache, env-gated so it's zero-fs + no-op when `DATA_DIR` is unset,
  never throws). It adds two feed-exclusion exports: `hiddenSetSync()` (synchronous,
  zero-fs in-memory read) and `warmHidden()` (boot populate, fire-and-forget in
  `hooks.server.ts` alongside the scan).
- **The feed exclusion is CONSUMER-side, not in `videos.ts`.** `/api/feed` and
  `+page.server` filter `getFeed()`'s result through `hiddenSetSync()` before
  ordering — so `videos.ts` (serving-four AND `getFeed`) stays byte-identical and the
  cheap-scan path does zero extra filesystem work. A `.size` guard returns the same
  `items` reference when nothing is hidden, keeping the no-hidden response
  byte-identical. Changing `/api/feed` output for hidden items is BY DESIGN (it is
  NOT part of serving-four byte-identity).
- **`loadSet` is compare-and-set — load-bearing (adversarial #4).** `loadSet` does a
  check → `await readFile` → cache-set, and the boot `warmHidden` lane is NOT in the
  `setHidden` write-queue. Without the post-`await` re-check, a hide landing in the
  boot read-window could be clobbered by warm's stale disk snapshot, and the next
  `setHidden` (reading the clobbered cache without re-reading disk) would DURABLY drop
  the name. The fix: `loadSet` never overwrites an already-populated cache for the dir
  (adopts it), and `warmHidden` pre-checks the cache. `starred.ts` shares the same
  check-then-set shape but has no sync feed consumer (smaller blast radius) — apply the
  same guard there if it ever gains one.
- **Three independent "hidden" concerns — don't conflate.** `config.hidden`
  (= `DATA_DIR` set → server-side hide on) vs `allowHide` (`ALLOW_HIDE` → show the
  hide button) vs `ignoreHidden` (`IGNORE_HIDDEN` → skip dotfiles in the scan).
- **The client `persistHidden()` is fire-and-forget with NO rollback** (a failed
  write reappears on reload; rolling back would surprise-unhide) — the same
  best-effort contract as the starred optimistic write. The local-only localStorage
  hide (`stores/hidden.ts` + `applyHidden`) stays as the fallback when the feature is
  off, and the client seeds the set from `GET /api/hidden` on mount (clamping
  `activeIndex` if the seed shrinks the feed).
- **`hidden.json` accumulates names not validated against the feed** (a hide of a
  since-deleted / not-in-feed clip persists; by-design — keeps the toggle off the CIFS
  path). It needs periodic reconciliation against the live manifest, or the seed
  endpoint could intersect with it so dead names self-prune. (adversarial #12, deferred)
- **`/api/media` `lstat`s, never `stat`s — symlink guard (adversarial #1, security).**
  `safeMediaPath` is a purely LEXICAL guard; `stat` FOLLOWS a symlink, so a
  `clip.mp4 -> /etc/passwd` planted in `VIDEO_DIR` (in-dir name, escaping target) would
  have streamed the out-of-dir file with Range support. `statFile` now `lstat`s and
  rejects `isSymbolicLink() || !isFile()` → 404. For a regular file `lstat === stat`, so
  the Range byte math is unchanged (serving-four byte-identical; route-level guard).
  Mirrors the poster route's F7 guard. **`/share/<token>/media` (0.8.4) reuses this byte
  path on an UNAUTH surface — the guard MUST stay; it's a hard 0.8.4 prereq.** The live
  `:ro` library can't be symlink-planted, so `tests/range.test.ts`'s planted-symlink→404
  case is the only regression guard — keep it.

## 0.8.2 — portrait-clip cropping fix (fit from element dims)

- **`applyFit` reads the pooled `<video>`'s own `videoWidth`/`videoHeight` first
  (manifest dims as fallback) and re-fits on `loadedmetadata`.** The 0.7.0 cheap-scan
  feeds carry no intrinsic dims in the manifest, so a manifest-only `pickFit(0, 0, …)`
  hit the unknown-dims guard (`fit.ts:21`) and returned `cover`, top/bottom-cropping a
  portrait clip on a landscape/desktop viewport. At src-swap the element's `videoWidth`
  is still 0, so the fit re-applies once `loadedmetadata` fires (same shape as the
  existing rotation re-fit `$effect`). `fit.ts`/`pickFit` unchanged; the change is
  fit-class-only — zero play-state contact, cure-seven + serving-four byte-identical.
- **Headless can't verify this for H.264 feeds.** Playwright's bundled chromium has no
  H.264 codec, so favorite/liked never fire `loadedmetadata` headlessly (`readyState`
  0, `videoWidth` 0) — the fit-flip is unobservable there. The letterbox lands when
  dims are present (verified on `best`, which has poster-derived dims); favorite/liked
  efficacy needs a real-browser (H.264) eyeball or device check. A `<video>` object-fit
  gate can't be closed by codec-free headless chromium.

## 0.8.1 — play/pause flicker fix (iOS tap-highlight)

- **`-webkit-tap-highlight-color: transparent` on `.tap` is load-bearing — don't
  drop it.** The full-bleed tap target is a `<button>`, so without it iOS Safari
  paints a translucent-black tap-highlight over the _whole card_ on every press: a
  ~7% whole-video dim on each tap (the long-hunted "flicker"). It rides the active
  touch, not the play/pause state, so it fired on every tap and is invisible to a
  JS tap-handler read. Don't re-introduce a default highlight on any full-bleed
  press target.
- **Lesson (capture-first).** Three source-guessed CSS fixes were falsified on
  device before a 60fps capture + per-region luma pinned the real layer. Decider:
  the dim is _uniform_ across the whole video (the far-left strip dims the same as
  the center, ~×0.74 toward `#000`) → a full-bleed overlay, not a glyph-local
  scrim behind the ▶. Demand a device capture / luma trace before a second blind
  CSS guess on a visual bug.

## 0.8.0 — starred favorites + POSTERS/DATA_DIR decoupling + warm-on-boot

- **`POSTERS` is now decoupled from `DATA_DIR` — load-bearing; updates the
  "Posters + metadata gated on `DATA_DIR`" note above.** `DATA_DIR` now means only
  "a writable volume is present" (the prerequisite for any persisted feature).
  Poster/metadata **generation** is gated by a new `POSTERS` env (`config.posters =
dataDir !== '' && parseBool(POSTERS, false)`, default **off**); favorites are
  gated by the volume alone (`config.starred = dataDir !== ''`). The 0.7.0
  cheap-scan moved from `cheap = config.dataDir === ''` to **`cheap =
!config.posters`** — so a feed with a volume (for favorites) but `POSTERS` off
  STAYS readdir-only/~30ms. A naive "add `DATA_DIR` ⇒ full stat" would have
  silently undone 0.7.0 (cold `/api/feed` back to ~24s) and triggered a bulk
  poster encode. **The cheap-scan tripwire is measured on a POSTERS-off feed
  (favorite), not on best (POSTERS=true = full stat by design).**
- **Chokepoint gating + a PROTECTED-FIXTURE forward-rule.** The `POSTERS` gate
  sits ONLY at the chokepoints: `/api/poster` (204 on `!posters` — the worker's
  ONLY trigger ⇒ zero ffmpeg on a posters-off feed), `enrichItems` (identity when
  off ⇒ byte-identical payload), and `worker.enqueueGeneration` (injectable
  `postersEnabled`). The **leaf** generators (`generatePoster`/`generateMeta`/
  `dataCache`) stay volume-gated (`cacheEnabled(dataDir)`) and byte-unchanged —
  reachable only through the now-posters-gated worker. ⚠️ **`tests/gating.test.ts`
  is a protected fixture: any NEW caller of `generatePoster` / `generateMeta` /
  `enqueueGeneration` MUST route through the `POSTERS` gate, or the
  zero-ffmpeg-when-`POSTERS`-off invariant breaks silently.** Don't push the gate
  down into the leaves (it mutates byte-identical generators for an unreachable
  path = a net regression).
- **Favorites (`starred`) — forya's second writable subsystem, mirrors the
  posters discipline.** A single `starred.json` under `DATA_DIR` (`starred.ts`):
  atomic tmp+rename, all writes serialized through one in-process queue (no
  lost-update under concurrent toggles), in-memory `SvelteSet` cache, gated on
  `dataDir !== ''` (no throw / zero fs when disabled). API: `GET /api/starred`
  (`{enabled, starred[]}`), `PUT`/`DELETE /api/starred/<name>` (idempotent,
  `safeMediaPath`-guarded, 404 when disabled). Fully decoupled from the scan
  manifest — a mark never rescans or touches the pooled `<video>` machine. The
  client mirrors it in a `SvelteSet` (optimistic toggle, rolled back on a failed
  write).
- **Double-tap gesture is additive over the cure machine.** `onTapGesture` wraps
  `tapActive()` (called first, synchronous, byte-identical — the in-gesture bless
  is untouched): single-tap = play/pause; a 2nd tap within 300ms on the same card
  = TOGGLE the star + reconcile play/pause to the pre-gesture state (net-no-op via
  the existing `v.pause()`/`tryPlayActive`, no new play path) + a tap-point heart;
  taps 3+ = heart-only (no re-toggle, no play/pause). The cure-seven functions +
  `onTouchStart` are byte-identical to main; serving-four untouched.
  `touch-action: manipulation` on `.tap` kills the iOS double-tap-zoom.
- **Warm-on-boot.** `src/hooks.server.ts` `export const init: ServerInit` fires a
  **fire-and-forget** `void scanVideos(...).catch(()=>{})` at server start —
  NEVER awaited (init IS awaited by SvelteKit before it serves, so awaiting the
  ~24s cold scan would block server-ready). Reuses the 0.7.0 single-flight
  (idempotent vs the first request); build-safe (init doesn't run at `vite
build`). So the first post-restart visitor gets a warm feed.
- **⚠️ Deploy (per-feed, cutover-critical).** Since `DATA_DIR` no longer implies
  posters: feeds that want posters (best, liked) MUST carry `POSTERS=true` in prod
  or they silently lose posters; a favorites-only feed (favorite) sets `DATA_DIR`
  alone → cheap-scan ~30ms + starred.
- **Known: rail black-flicker on tap is PRE-EXISTING (→ 0.8.1).** A brief black
  flash on a play/pause tap reproduces on 0.7.1 prod (`b71fcc1`), so it is NOT a
  0.8.0 regression. Three source-only guesses were all FALSIFIED on device (a
  double-`play()` reconcile, a `.pool-video` GPU-layer pin, and dropping the
  `.rail-btn` `backdrop-filter` — the last proven false by a private-tab test:
  zero `backdrop-filter` in the served CSS, still flashed). Deferred to 0.8.1,
  **capture-first** (iOS screen-record → is the black frame whole-screen or only
  the video rectangle?) — no more blind CSS.

## 0.6.0 / 0.6.1 / 0.6.2 — pooled `<video>` + sound-on carry + first-card two-tap fix + identity-keyed slots (the CURRENT play machine; supersedes the per-card model below)

**What changed.** `Feed.svelte` no longer mounts one `<video>` per card. It owns a
small fixed **pool** of persistent `<video>` elements (`POOL_SIZE = 3` =
prev/cur/next) and reparents + `src`-recycles them across cards as the active
index moves. `VideoCard` is now a presentation **shell** (poster / reveal / seek /
tap) — it holds no `<video>`. Coverage/recycle math is pure + tested in
`src/lib/pool.ts`. **`src/lib/window.ts`/`feedWindow` is removed** — the pool's
fixed prev/cur/next coverage replaces the windowed loader (the active-always-live
idea lives on as the pool window). Decoder count is bounded by the pool (3), fewer
than the old windowed ~6.

**Why.** iOS's "may-play-unmuted" grant is **per-element, durable, and survives
`src` swaps** (harness-proven on iOS 26.5.1). A fresh-`<video>`-per-card design can
never carry sound (every card is a new, unblessed element). Reusing a blessed pool
element via `src`-swap lets **sound carry across scrolls AND across programmatic
auto-advance** after one sound-on tap — the headline 0.6 win.

**Cure-shape invariant (load-bearing — do NOT regress).** The always-muted cure
(0.5.5) is preserved: **no `<video>` ever does an ungestured unmuted `play()`.**
Concretely (0.6.1 model — reverted 0.6.0's start-paused, see the two-tap note
below): every pool element **muted-autoplays continuously** from load (onMount sets
`muted = true`, so the rail shows the muted "tap to unmute" icon; there is no
`loadMute`). The **first tap** (`tapActive`/`toggleMute` → `blessPool`) is a **bare
synchronous `muted = false` flip** on the already-playing pool elements (neighbours
re-muted in the same loop) — iOS grants it because each element is already playing
_in_ the gesture, minting the durable per-element grant for the whole pool. After
that, a becoming-active card is a D-safe off-gesture `muted = false` on an already-
playing blessed element (never a pause→play→unmute). `assertActiveAudio`
(`muted = !(blessed && !muted)`) forces muted pre-bless even on the playing active
card, so audible output is gated entirely on the gesture-minted bless. The `canplay`
self-heal (`shouldRetryOnPlayable`) recovers a cold muted-autoplay; the retry is
always a _muted_ play, so it is cure-safe pre-bless (0.6.0's `blessed` gate was only
needed while pre-bless was start-paused, and was removed in 0.6.1).

**First-card two-tap — FIXED in 0.6.1.** 0.6.0 sometimes needed a second tap to
start the very first (cold/buffered) card with sound. Root cause (**documented
WebKit policy**, not a forya bug): WebKit grants an unmute only on an element whose
playback the gesture is _driving_; a **paused, fully-buffered idle element** —
0.6.0's start-paused active card at tap time — is exactly the case it refuses (a
cold element one-tapped only incidentally, since its `play()` _is_ the load WebKit
blesses; on the LAN `v.load()` + native preload buffer fast, and a prewarm-off A/B
confirmed prewarm was not the cause). The fix (canonical video.js / YouTube / FB
shape) is the **muted-autoplay + in-gesture `muted = false` flip** described in the
cure-shape note above: it **reverts the start-paused model (#472)** back to muted-
autoplaying the active card (still muted → the no-audible-autoplay guarantee holds),
with the bless reduced to a bare synchronous unmute of an already-playing element.
**Verified one-tap on device (iOS 26.5.1).** The `DEBUG_PLAYBACK` overlay's `ua=`
field (`navigator.userActivation.isActive`, captured at the bless flip) reads
gesture-liveness if it ever regresses.

**iOS silent/ringer switch (NOT a bug).** With the hardware silent switch on, iOS
mutes inline `<video>` audio regardless of a valid unmute (`snd=1` in the
`DEBUG_PLAYBACK` overlay yet inaudible). Don't chase a "no sound but bless looks
right" field report as a regression — check the physical switch first.

**First-MB prewarm (kept; not causal for the two-tap).** As a card enters the pool
window, a side-channel `fetch(url, { headers: { Range: 'bytes=0-1048575' } })`
warms its moov + first GOPs into the HTTP cache (faster first paint, esp. on slower
links). Safari reuses the partial for the `<video>`'s own range requests (overlay
`rs` climbs before tap). Superseded prewarms are aborted on a fast flick so they
can't queue ahead of the active card's own load. A `fetch()` is **not** a `play()`,
so the cure-shape is untouched — and it's deduped per-url, never the serving-four.

**0.6.2 — slots keyed by clip IDENTITY, not index.** The pool's three persistent
maps (slot→clip, reveal flags, fresh-arrival tracking) were keyed by **visible
index**; on a hide/undo the `visible` list re-indexes, so a kept element could
strand under a stale index (wrong clip in the cell, stale reveal, a promoted clip
not restarted to `t=0`). They're now keyed by the **stable clip name** —
`slotToName` / `revealedByName` / `lastDrivenName`, mirroring `cardSlotByName` (the
slot-`<div>` map, which was always name-keyed). `coverage()` and `activeIndex` stay
**positional** (the IO drives `activeIndex` off `data-index`); the index→name
translation happens once at the `syncPool` boundary, and `activeSlot()` (active clip
→ its physical slot, by name) replaces every former `slotForCard(activeIndex)`
lookup — **including the cure-critical bless flip in `blessPool`**, where a mis-keyed
slot would unmute the wrong element. `reassignPool` is generic over the key type (the
recycle math is identity-agnostic; the index-keyed tests still hold). Hide is
**active-card-only** (the single global ActionRail button targets `activeItem`;
there's no off-screen-card hide gesture), so the only reachable re-index is hiding
the active card — exactly the case this fixes (device-verified on the ALLOW_HIDE
feeds).

**0.6.2 — foreground re-drive (`onForeground`).** iOS pauses inline `<video>` on
background; on return, `visibilitychange` (visible) + `pageshow` (iOS bfcache) re-
drive the pool via the existing `driveActive()` — **no new play path**. `activeIndex`
is unchanged so `fresh=false` → no `t=0` restart (you keep your spot); audio resumes
on focus (the D-safe off-gesture unmute on the already-playing blessed element — the
muted-only fallback is one branch away if a future iOS revokes the bless on
background, but on-device the grant survived). All drive plays stay muted; cure-shape
intact.

**What the pool supersedes in the sections below.** The per-card cascade guards,
readiness-gated `feedWindow` preload, `VideoCard.onDestroy` decoder release, and the
`shouldGestureUnlock` helper are now **historical**. The iOS _lessons_ they encode
still hold and the pool inherits them (always-muted autoplay, one active card,
decoder discipline, in-gesture recovery — now inline in `Feed.onTouchEnd`), but the
_code_ moved into the pool machine: `shouldGestureUnlock` was deleted (logic inline
in `onTouchEnd`), and the cascade/readiness mechanics now act on the pooled active
element via `tryPlayActive`. Read the sections below for the iOS rationale; read
`Feed.svelte` + `src/lib/pool.ts` for the current implementation.

## iOS autoplay rule (the short version)

A video autoplays on iOS only if it is **`muted`** AND **`playsinline`**, and you
don't fight the browser by decoding many at once. So: both attributes on every
`<video>`, only the active card plays, and `.play()` returns a Promise whose
`.catch()` surfaces a tap-to-play overlay when iOS still refuses.

**Autoplay / first-frame handling** (the deterministic half; iOS-specific tuning
is operator-on-device, criterion 3):

- **Muted autoplay is never gated.** The active card always attempts
  `muted`+`playsinline` autoplay with no tap. On rejection it **retries once on
  the next frame, still muted** (a freshly-mounted/scrolled-to card can
  transiently reject before it's ready). Only if the retry also fails does the
  manual play button show. (0.4 removed the old `playback.unlocked` flag — it had
  no readers once the retry became unconditional.)
- **Autoplay is ALWAYS muted (0.5.5) — the persisted sound pref must NEVER reach a
  fresh autoplay.** `tryPlay` sets `v.muted = true` unconditionally. This was the
  root cause of the long-hunted "every-~8-videos" autoplay break: iOS Safari grants
  gesture-free autoplay ONLY to a muted element, so once the user turned sound on,
  the old `v.muted = muted` made each fresh card do an _unmuted_ `play()` →
  `NotAllowedError` → autoplay revoked document-wide until a gesture (confirmed
  on-device: a muted feed scrolls infinitely clean; the `DEBUG_PLAYBACK` overlay
  pinned the reject as `NotAllowedError`). Sound-on is honoured by unmuting **only
  the active card, inside a user gesture** (`Feed.toggleMute`, and the `touchend`
  handler so sound carries across scrolls) — that's a property set on an
  already-playing element, never a `play()`, so it can't re-trip the gate. The mute
  `$effect` only ever (re)mutes; it never reactively unmutes. **Never set
  `v.muted = false` outside a gesture, and never feed the mute pref into a `play()`
  path.** This is the prevention that superseded chasing it via gesture-unlock
  recovery (the 0.5.3 gesture-unlock stays as a belt-and-suspenders for any residual
  transient reject).
- **Self-heal on playable (0.5.1) — the rAF retry isn't the last word.** The
  `<video>`'s `canplay`/`loadeddata` re-attempt play via the pure
  `shouldRetryOnPlayable` (`src/lib/playback.ts`, guarded by
  `tests/playback.test.ts`): for the active card these fire when the media is
  finally buffered, which is typically AFTER the ~16ms rAF retry already gave up
  on a freshly-scrolled-to card over a slow CIFS origin — so the card plays the
  moment it can instead of sitting dark. `tryPlay` bumps `playGen`, so stale fires
  no-op and a success (`hasPlayed`) short-circuits further retries; the predicate
  requires `active && !paused && !hasPlayed && !errored`, so it never overrides a
  user pause or loops on a hard error. **Plus a complementary race path:** if a
  `play()` rejection happens when the media is ALREADY playable
  (`isMediaReady(el.readyState)` — a lost decoder-handover race, where
  `canplay`/`loadeddata` already fired and won't re-fire), `tryPlay` schedules ONE
  bounded gen-guarded delayed re-attempt (~250ms, not polling). The two paths are
  mutually exclusive by `readyState`: a not-yet-buffered card waits on `canplay`,
  an already-buffered one gets the delayed retry. Together these fixed the two
  pre-existing 0.4.x on-device residuals (fast-scroll-settled card dark; isolated
  rejection on a conformant clip).
- **Gesture-unlock (0.5.3) — the document-wide revocation, a THIRD axis.** On iOS a
  single muted-`play()` rejection (~1/8 cards) revokes autoplay for the **whole
  document**: thereafter every programmatic `play()` rejects, including all of the
  0.5.1 self-heal — the block is **gesture-level, not buffer-level**, so retrying in
  code is futile. The cure is a `play()` call running **synchronously inside a user
  gesture's call stack**, which re-grants permission document-wide ("one tap unlocks
  all"). `Feed` adds two **passive** listeners on the scroll container — `touchend`
  (NOT `pointerup`: a scroll-fling fires `pointercancel` and stops pointer events,
  exactly the failing case) — that call `activeVideo().play()` only when the active
  card is `blocked` AND the touch actually moved (the `activeBlocked && moved` check —
  0.6.0 inlined this into `Feed.onTouchEnd` and removed the old `shouldGestureUnlock`
  pure helper). **0.5.4 fixed a two-tap regression here:** the original
  also keyed a container `click`, so a stationary tap fired the unlock's `play()`
  (via `touchend`) and then the synthesized `click` → `togglePlay` paused it again →
  two taps to recover. The fix gates the unlock on real scroll movement (>10px) and
  drops the `click` arm, so taps go through `togglePlay` alone (one tap) and the
  unlock is purely the scroll-recovery path. `VideoCard` reports its blocked state up
  via a new `onblocked` callback (emitted only while active); `Feed` tracks
  `activeBlocked`, **reset to false on every active-index change** so a stale
  scrolled-past `blocked` can't mis-fire. Active-card-only by design — the in-gesture
  `play()` re-activates the doc and the normal per-card IO autoplay resumes for all
  following cards, so there's NO play-all-visible (which would re-introduce the
  0.2.0 scrolled-past replay). The asymmetry the operator saw — auto-advance never
  fails, manual scroll does — fits this exactly: programmatic auto-advance only fires
  after a clip played to completion (a non-revoked doc by construction), while a slow
  manual drag fires the new card's `play()` mid-drag (finger still down, outside a
  completed gesture) into a possibly-revoked doc. Root cause of the regression: 0.4.0
  deleted the session-scoped `playback.svelte.ts` gesture-unlock store; 0.5.3 is the
  active-`play()` replacement (stronger than the old passive flag, which couldn't
  re-grant iOS permission on its own).
- **Cascade guards (0.4) — a failed autoplay must not break the NEXT card.**
  `VideoCard` has three guards, all in the play path: (1) **generation token**
  `playGen` — every attempt takes `gen = ++playGen`; the rAF retry + both
  `.then/.catch` no-op if `gen !== playGen || !active`. Going inactive and
  `onDestroy` bump `playGen`, so a scrolled-past / unmounted card can't keep
  replaying its decode on top of the next card's startup. `AbortError`
  (pause/load-interrupted play) is treated as benign — never marks `blocked`. (2)
  **decoder release on a real error** — `released = true` drops `src`
  (`src={released ? undefined : item.url}`) to free the iOS decoder so a bad clip
  can't poison the next; a tap (`togglePlay`, with `flushSync` to re-attach `src`
  inside the gesture) or re-activation clears it and retries. **As of 0.5.1 this
  is reserved for a genuine media `error` (or unmount), NOT a transient play()
  rejection** — a rejection now just shows tap-to-play and keeps `src` so the
  `canplay` self-heal above can fire (dropping `src` would have killed its own
  recovery). (3) **`onerror`** handles a `MediaError` (release + `errored` +
  tap-to-play) instead of an eternal spinner; `errored` also stops the self-heal
  from looping on a broken source. Root cause was an
  un-cancelled retry + a never-released failed element + an eager `preload=auto`
  neighbour decoding during the failure — see the readiness gate next.
- **Readiness-gated preload (0.4) — load the current video first.** `feedWindow`
  takes an `activeReady` arg: until the active card reaches `playing`, ONLY it
  fetches (`preload:auto`); every other in-window card stays **mounted but
  `preload:none`**. `Feed` tracks `activeReady` ($state, reset to `false` in the
  IO callback on every active-index change, set `true` by the active card's
  `onready` fired from `onplaying`). Effect: a cold/slow start pulls one stream;
  on scroll the new active card is instantly the sole fetch (about-to-play
  priority); and a failing active never has an eager neighbour decoding alongside
  it (kills the cascade's overlap). The mount window + active-always-live are
  unchanged — only the `preload` HINT is gated. Guarded by `tests/window.test.ts`
  (`activeReady` cases + active-always-live in both states).
- **Spinner and play button are mutually exclusive.** `VideoCard` shows the play
  glyph only when `active && (blocked || paused)` (autoplay refused _or_ the user
  tapped pause) and the buffering spinner only when no play glyph is up — so the
  spinner can never render behind the play button. A normally-autoplaying card
  flashes neither.
- **Reveal-gate, not a nudge (0.3.1).** The `<video>` only becomes visible
  (`opacity: 1`) once it has actually reached `playing` (`hasPlayed`); until then
  the gradient + filename placeholder shows. So a blocked / pre-gesture / still-
  buffering card shows the placeholder, **never a black `<video>`**, and a user-
  paused card (already `hasPlayed`) shows its real painted frame. This replaced
  the 0.3.0 first-frame `currentTime` nudge, which forced a seek that painted a
  black frame under memory pressure (the liked/favorite black-screen) and
  interrupted the active card's pending `play()`. **As of 0.5.3 the placeholder
  cross-fades** rather than hard-cutting: it stays mounted and fades its opacity to
  0 over the same 0.25s the `<video>` fades in (`.placeholder.revealed`,
  `pointer-events:none` so taps still reach the tap target), so the black `.media`
  background never shows through for a frame on reveal. Gated purely on `hasPlayed`,
  so an errored card (never paints) simply keeps the poster up — no stuck-poster
  edge case.

## Future TODOs (not built in v1)

- **Manage-hidden panel** — hiding (0.2.0) only stashes filenames in
  per-device localStorage; there's no way to review or restore hides except
  the transient Undo toast. Planned: an auth-gated panel listing hidden videos
  with restore, likely backed by server-side persistence (which would be the
  first piece of app-owned writable state — keep it out of `VIDEO_DIR`).
- **Multi-feed per instance** — today it's one feed per container
  (`VIDEO_DIR` + `FEED_NAME`); serving several feeds from one instance is a
  future enhancement.
- **In-app native OIDC** — v1 ships no auth; gate at the proxy. Optional in-app
  auth is a TODO.
- **Brand icons** — `static/` ships a minimal gradient-tile "f" mark
  (`apple-touch-icon` + 192/512 PWA icons + favicon); a richer brand mark is polish.
- **Static demo build** — deferred; forya is a server app needing private video
  files, so no GitHub Pages demo (unlike static siblings).

## Acceptance criteria (durable record)

The six observables this project is gated on (also pinned at kickoff; recorded
here so they outlive the chat):

1. **Range** — `curl -sI -r 0-1 .../api/media/<name>` → `206` +
   `Content-Range: bytes 0-1/<size>` + `Content-Length: 2` +
   `Accept-Ranges: bytes`. _(owner: dev · verifier: review)_
2. **Feed** — `curl -s .../api/feed | jq '.items[0]'` has non-null
   `url`/`size`/`type`; dotfiles and `.partial` excluded. _(owner: dev ·
   verifier: review)_
3. **iOS** — real iPhone Safari: autoplay-muted, one-per-screen snap with no
   `100vh` gap, scrub works, add-to-home-screen launches standalone. _(owner:
   dev · verifier: operator, on-device)_
4. **Image** — CI green on `main`; `docker pull registry.mdbook.me/mikayla/forya:latest`
   succeeds. _(owner: dev · verifier: infra)_
5. **Ingress + auth** — public domain → Authentik login → feed; LAN open; both
   TLS; `X-Robots-Tag: noindex` present. _(owner: infra · verifier: review)_
6. **Rollback-ready** — the old feed recoverable from git history;
   `mosswill/erin:latest` still pullable; videos + importer untouched. _(owner:
   infra)_
