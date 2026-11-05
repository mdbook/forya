# forya guide

[Quick start](../README.md#run-with-docker-compose)

## Access and authentication

forya has **no built-in authentication**. Anyone who can reach it can read your
media and change shared favorites or hidden items. There are no separate user
libraries. Compose binds to `127.0.0.1` by default.

For a trusted LAN, set `BIND_ADDRESS` in `.env` to your computer's LAN IPv4 address
and rerun the start command. Open `http://<that-address>:3000` on your phone. This
allows other devices on that network to access the feed without a password.
Do not forward port 3000 from the internet.

For remote access, keep the loopback binding and put an HTTPS reverse proxy with
authentication in front of **all** routes. For example, with Caddy installed on
the same host, point a domain you own to that host and allow ports 80/443 for TLS.
Generate a password hash with `caddy hash-password`, then replace the domain and
hash placeholder in this Caddyfile snippet:

```caddyfile
feed.example.com {
	basic_auth {
		viewer <paste-password-hash-here>
	}
	reverse_proxy 127.0.0.1:3000
}
```

Reload Caddy after editing. The proxy must run on the host for this loopback
upstream to work, not in a separate container. Protect API and share routes too;
share links do not bypass this authentication. For SvelteKit form submissions
behind a proxy, set `ORIGIN` to the external HTTPS URL in the Compose service's
`environment` and recreate the container.

## Storage and posters

`VIDEO_DIR` is read-only input. forya never writes, renames, or deletes source
media. The Compose named volume at `/data` inherits the image's non-root ownership
and stores favorites, hidden items, share records, and optional generated caches.
These are shared feed state, not per-user accounts. Back up this volume to keep
them across reinstalls. Stop the container before copying its data for a backup.

To use a host directory instead, replace `forya-data:/data` in `compose.yaml` with
`/path/to/data:/data`. Create the directory first and make it writable by UID/GID
1000:1000 (`chown 1000:1000 /path/to/data` on Linux). This is not needed for a fresh
named volume. Never point `/data` at your source video folder.

For thumbnails and width/height/duration metadata, set `POSTERS=true` in `.env`
and rerun the start command. ffmpeg and ffprobe are included in the image.
Generation is lazy, one job at a time with low priority: the first view may have
no poster, while later views do. To disable generation again, set `POSTERS=false`.
Favorites still work. Outside Compose, generation requires both `DATA_DIR` and
`POSTERS=true`; neither is enabled by the Dockerfile alone.

## Tuning

These are server environment variables. Except for `POSTERS`, add them to the
Compose service's `environment` mapping if needed; merely adding them to `.env`
does not pass them into the container. The values below are application defaults.

| Variable            | Default   | Purpose                                                     |
| ------------------- | --------- | ----------------------------------------------------------- |
| `IGNORE_HIDDEN`     | `true`    | Skip dotfiles and unfinished `*.partial` files.             |
| `ALLOW_HIDE`        | `false`   | Show the hide control; saved across devices with DATA_DIR.  |
| `PRELOAD_AHEAD`     | `3`       | Number of upcoming video cards kept ready.                  |
| `PRELOAD_BEHIND`    | `2`       | Number of previous video cards kept ready.                  |
| `AUTO_ADVANCE`      | `false`   | Start in next-on-end mode instead of looping.               |
| `MAX_COVER_CROP`    | `0.1`     | Maximum fraction cropped before using letterboxing.         |
| `POSTERS`           | `false`   | Generate posters and metadata when DATA_DIR is set.         |
| `PUBLIC_SHARE_BASE` | Unset     | External base URL for share links; requires DATA_DIR.       |
| `DEBUG_PLAYBACK`    | `false`   | Show a diagnostic playback overlay.                         |
| `PORT`              | `3000`    | Container listen port; keep aligned with port mapping.      |
| `HOST`              | `0.0.0.0` | Container listen address, not the host's published address. |

For several independent feeds, use separate containers, video mounts, data
volumes, feed names, and host ports.

## Media layout and playback

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

## Development

The server uses SvelteKit, Svelte 5, TypeScript, and the Node adapter. Use a
supported Node version matching the Dockerfile and npm. From the source folder:

```bash
npm ci
npm run dev
```

Set `VIDEO_DIR` in your shell to an existing media folder for local development.
Checks used by CI are `npm run check`, `npm run lint`, `npm run format:check`, and
`npm test` (Vitest). `npm run build` creates `build/`; `node build` runs it.

## Background

forya replaced a separate file server and React feed to address iOS Safari
autoplay, dynamic toolbar sizing, seeking, and excessive simultaneous decoding.
It now serves the UI and media from a single non-root container, without a
database. See [CHANGELOG.md](../CHANGELOG.md) for version history.
