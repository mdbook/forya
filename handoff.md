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
- **Preload window is one card warmer than the spec's literal wording.**
  `Feed.preloadFor` returns `metadata` for `[activeIndex-1 .. activeIndex+2]`
  (the spec says "active + next 1–2"). The extra previous card is a deliberate
  choice for smooth back-scroll; everything else is `preload="none"` so iOS
  isn't decoding the whole feed.
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

## Future TODOs (not built in v1)

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
