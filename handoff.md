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
    dedupes by name). **Edge:** the ~10s scan memo means if `VIDEO_DIR` changes
    mid-session the continuing order could shift (dupes/gaps); acceptable for a
    homelab feed and fully stabilised by **0.3.2**'s persistent scan. The cold
    ~9s scan on the biggest feed is the other half of the slow-load and is the
    0.3.2 target (a `videos.ts` change → full Range re-gate).
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

## iOS autoplay rule (the short version)

A video autoplays on iOS only if it is **`muted`** AND **`playsinline`**, and you
don't fight the browser by decoding many at once. So: both attributes on every
`<video>`, only the active card plays, and `.play()` returns a Promise whose
`.catch()` surfaces a tap-to-play overlay when iOS still refuses.

**Autoplay / first-frame handling** (the deterministic half; iOS-specific tuning
is operator-on-device, criterion 3):

- **Muted autoplay is never gated.** The active card always attempts
  `muted`+`playsinline` autoplay with no tap. On rejection it **retries once on
  the next frame, still muted and NOT gated on `playback.unlocked`** (0.3.1 — a
  freshly-mounted/scrolled-to card can transiently reject before it's ready;
  gating the retry was the best-tt "scroll needs a manual tap" regression). Only
  if the retry also fails does the manual play button show. `playback.unlocked`
  (`stores/playback.svelte.ts`) governs the unmuted path only — keep it out of
  the muted-autoplay path.
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
  interrupted the active card's pending `play()`.

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
- **Poster endpoint** — none in v1 (`<video preload="metadata">` shows the first
  frame). If first frames are often black, an ffmpeg poster endpoint with an
  on-disk cache keyed `name`+`mtime` is the planned fix (no ffmpeg in the image
  today).
- **Brand icons** — the PWA icons in `static/` are placeholders (gradient tile +
  glyph); final brand icons are polish.
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
