# forya

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

An **iOS-first vertical video feed** (TikTok-style) that serves both the UI and
the video bytes — with correct HTTP Range support — from one self-contained
Docker image. Point it at a directory of videos and it just works:

```bash
docker run -p 3000:3000 -v /path/to/videos:/srv/videos registry.mdbook.me/mikayla/forya
```

Then open <http://localhost:3000>. On an iPhone, use **Share → Add to Home
Screen** to launch it full-screen like a native app.

> _No public demo — forya serves private video files. See [Configuration](#configuration) to run your own._

Built with SvelteKit (adapter-node) + Svelte 5 + TypeScript. No database, no
build step at runtime, no ffmpeg — one Node process scans the directory and
streams the files.

## Why

It's a focused rewrite of a Caddy-file-server + React feed that was buggy on iOS
Safari: autoplay rejected, `100vh` layout breaking under the dynamic toolbar,
many videos decoding at once, and broken seek/scrub from mishandled HTTP Range.
forya fixes those at the root — an iOS-tuned feed UI over a thin, **Range-correct**
serving backend. See [`handoff.md`](./handoff.md) for the full story.

## Features

- **Correct HTTP Range** (`206` / `Content-Range` / `Accept-Ranges`) so iOS
  plays and seeks — this is the whole point of the app.
- **iOS-correct feed**: `muted`+`playsinline` autoplay, `100dvh`/`100svh`
  scroll-snap (never `100vh`), one video playing at a time, tap-to-play
  fallback.
- **Randomized order**: the feed is shuffled fresh on every page load (server-
  side, so no reorder flash). Large feeds load a slim first page and lazy-load
  the rest as you scroll, continuing the same shuffled order.
- **Windowed lazy-loading**: only a small window around the active card holds a
  decoder; buffers ahead, caches recent, reloads on back-scroll.
- **Adaptive fit**: off-aspect clips letterbox instead of cropping — in either
  direction (landscape-on-portrait _and_ portrait-on-landscape).
- **One control rail**: mute, loop/next (labelled with the current mode),
  share/save, an info overlay, and an optional client-side hide control
  (`ALLOW_HIDE`) — all on a single right-side rail. Plus a seek bar on the
  active card.
- **Favorites** (needs `DATA_DIR`): double-tap a clip — or tap the rail heart —
  to favorite it; the heart fills on clips you've already liked. Long-press the
  heart to open a **Favorites view** (`/liked`): your liked clips as a feed,
  newest first. Persisted as a small `starred.json`; inert when no data volume.
- **Image galleries** (TikTok photo posts): multi-image posts render as swipeable
  carousels alongside videos — finger-follow drag, index dots/counter, double-tap
  to like, and a full-carousel share link. One photo post = one feed item (flat
  `<id>_NN.<ext>` frames grouped by id). Images-only; the gallery soundtrack is a
  follow-up. Galleries never touch the video decoder pool.
- **Installable PWA**: per-instance home-screen name, standalone portrait.
- **Self-contained**: serves UI + bytes from one image; runs non-root.
- Desktop fallback: ↑/↓ + `j`/`k` to move, Space to play/pause, `m` to mute.

## Configuration

All via environment variables:

| Variable         | Default       | Description                                                             |
| ---------------- | ------------- | ----------------------------------------------------------------------- |
| `VIDEO_DIR`      | `/srv/videos` | Directory scanned for videos (mount it read-only).                      |
| `FEED_NAME`      | `feed`        | Title / branding, PWA home-screen name, and client storage key prefix.  |
| `IGNORE_HIDDEN`  | `true`        | Hide dotfiles and `*.partial` (mid-download) files.                     |
| `ALLOW_HIDE`     | `false`       | Show the per-card hide ("trash") control. Hiding is client-side only.   |
| `PRELOAD_AHEAD`  | `3`           | Lazy-load window: cards ahead of the active one that carry a video src. |
| `PRELOAD_BEHIND` | `2`           | Lazy-load window: cards behind the active one kept warm.                |
| `AUTO_ADVANCE`   | `false`       | Default for autoplay-next (advance on end vs. loop); user can toggle.   |
| `DATA_DIR`       | _(unset)_     | Writable dir for generated posters/metadata (0.5). Unset = feature off. |
| `PORT`           | `3000`        | Listen port (adapter-node native).                                      |
| `HOST`           | `0.0.0.0`     | Listen host (adapter-node native).                                      |

### Posters & metadata (optional, `DATA_DIR`)

Set `DATA_DIR` to a writable dir and forya generates its own poster thumbnails +
video metadata (width/height/duration) with ffmpeg/ffprobe — no external tooling
needed. Metadata pre-sets object-fit (no fit-jump) and posters fill the loading
placeholder. **Off by default:** with `DATA_DIR` unset nothing is generated or
written and behaviour is identical to before. forya writes **only** under
`DATA_DIR`; `/srv/videos` stays read-only. The image declares `VOLUME /data`
(owned by `node`):

```bash
docker run -p 3000:3000 \
  -v /my/videos:/srv/videos:ro -v forya-data:/data -e DATA_DIR=/data \
  -e FEED_NAME=liked registry.mdbook.me/mikayla/forya
```

Generation is lazy (first view of a clip has no poster; later views do) and
bounded (one ffmpeg at a time, low priority) so it never competes with playback.

### The `/srv/videos` contract

forya treats `VIDEO_DIR` as **read-only input it does not own**. It only reads;
it never writes, renames, or deletes. Mount it `:ro`:

```bash
docker run -p 3000:3000 -v /my/videos:/srv/videos:ro \
  -e FEED_NAME=liked registry.mdbook.me/mikayla/forya
```

Supported extensions: **`.mp4` `.mov` `.webm` `.m4v`**. Dotfiles and `*.partial`
files are skipped when `IGNORE_HIDDEN=true` (the default), so a downloader
writing `clip.mp4.partial` won't surface a half-file. The **page feed is
randomized** — shuffled fresh on every load (since 0.3.0; there is no resume to a
previous position). The underlying scan is most-recently-modified first, which is
what the `/api/feed` endpoint still returns by default.

### Endpoints

- `GET /` — the feed UI.
- `GET /api/feed` — JSON manifest: `{ feed, items: [{ name, url, size, mtime, type }] }`. `?shuffle=1&seed=N` for a deterministic shuffle; `?offset=O&limit=L` to paginate (used by the page's lazy-load). No params → the full mtime-desc list. A photo-post **gallery** item additionally carries `media: [{ name, url, type }]` (its ordered frames); a video item has none.
- `GET|HEAD /api/media/<name>` — the video (or gallery-frame) bytes, with full Range support.
- `GET /api/poster/<name>?v=<mtime>` — the generated JPEG poster, or `204` when none yet (needs `DATA_DIR`).
- `GET /liked` — the favorites view (your liked clips as a feed, newest first; needs `DATA_DIR`).
- `GET /api/starred` — `{ enabled, starred: string[] }`; `PUT|DELETE /api/starred/<name>` toggles a favorite (needs `DATA_DIR`).
- `GET /api/healthz` — `200 ok` (healthcheck).
- `GET /manifest.webmanifest` — the PWA manifest, branded with `FEED_NAME`.

## Auth

forya ships **no built-in authentication** (v1). Gate it at your reverse proxy.
This homelab fronts the public domains with **Authentik forward-auth** and
leaves the LAN open. _TODO: optional in-app native OIDC._

## Multiple feeds

One image, one feed per container. To serve several feeds, run several
containers with different `VIDEO_DIR` + `FEED_NAME`. _Multi-feed within a single
instance is a future TODO, not built now._

## Development

```bash
npm install
npm run dev          # dev server
npm run check        # svelte-check
npm run lint         # eslint
npm run format:check # prettier
npm test             # vitest (Range + scan guards)
npm run build        # adapter-node build → ./build
node build           # run the built server
```

## Repository

The canonical repository is **GitLab** (`gitlab.mdbook.me/mikayla/forya`), which
runs CI and publishes the image. It **push-mirrors** to
[`github.com/mdbook/forya`](https://github.com/mdbook/forya) for public OSS
visibility. **Issues and pull requests on the GitHub mirror are not watched** —
please use GitLab.

## License

[MIT](./LICENSE) © Mikayla D. Burke
