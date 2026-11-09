# How it works

forya is one SvelteKit app (Svelte 5, TypeScript, Node adapter) that serves both the UI and your media from a single non-root container. There is no database.

```
 your video folder (read-only)          browser (phone or desktop)
        |                                      |
        v                                      v
  /srv/videos --> scan --> /api/feed ----> shuffled feed UI
        |                                      |
        +-----> /api/media/<name> <--- Range requests (play, seek)

  /data (optional volume): favorites, hidden items, share links, posters
```

## Media layout

Videos can live directly in `VIDEO_DIR` or its `videos/` subdirectory. Supported
extensions are `.mp4`, `.mov`, `.webm`, and `.m4v`. Files are served as-is, so
browser codec support matters. Arbitrary nested video directories are not scanned.
Dotfiles and `*.partial` files are ignored by default.

Photo posts use an alphanumeric post ID, such as `abc123.jpg` for a single image
or `abc123_01.jpg`, `abc123_02.jpg` for an ordered gallery. Supported images are
`.jpg`, `.jpeg`, `.png`, `.webp`, and `.gif`. Gallery frames can also live under
`galleries/` or as `galleries/abc123/01.jpg`, `02.jpg`. A numeric-ID gallery can
have a looping soundtrack named `<id>.m4a` or `<id>.mp3` beside its frames.

The page shuffles on each load. It fetches a small first page, then more items
as you scroll. Only nearby videos hold active decoders; recent clips stay warm
for back-scrolling. Galleries use a separate shared audio element so at most one
element is audible. Off-aspect media letterboxes rather than being heavily cropped.

The media endpoint supports HTTP byte ranges (`206`, `Content-Range`, and
`Accept-Ranges`) so browsers can play and seek without fetching the whole file.
Keyboard controls: Up/Down or `j`/`k` to move, Space to play/pause, `m` to mute.

## Endpoints

| Path                           | Purpose                                                    |
| ------------------------------ | ---------------------------------------------------------- |
| `/`                            | Shuffled feed UI.                                          |
| `/liked`                       | Favorites feed, newest liked first; requires DATA_DIR.     |
| `/api/feed`                    | JSON feed, name-sorted by default.                         |
| `/api/media/<name>`            | GET/HEAD media bytes, with Range support.                  |
| `/api/poster/<name>?v=<mtime>` | Generated JPEG or 204 if unavailable; requires posters.    |
| `/api/starred`                 | GET favorites; PUT/DELETE `/api/starred/<name>` to toggle. |
| `/api/healthz`                 | Health check, returns 200 when serving.                    |
| `/manifest.webmanifest`        | Home-screen manifest branded with FEED_NAME.               |

`/api/feed` accepts `?shuffle=1&seed=N` for repeatable shuffling and
`?offset=O&limit=L` for pagination. Items have `name`, `url`, and `type`;
`size` and `mtime` may be absent with posters disabled. Gallery items also have
an ordered `media` array and optionally an `audio` object. A cold feed may report
`warming: true` while its initial background scan finishes.

## Background

forya replaced a separate file server and React feed to address iOS Safari
autoplay, dynamic toolbar sizing, seeking, and excessive simultaneous decoding.
It now serves the UI and media from a single non-root container, without a
database. See [CHANGELOG.md](../CHANGELOG.md) for version history.
