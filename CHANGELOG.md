# Changelog

All notable changes to this project are documented here. Versions follow
[Semantic Versioning](https://semver.org/). `package.json` `version` is
canonical and `VERSION` mirrors it; bump both in the same commit.

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
