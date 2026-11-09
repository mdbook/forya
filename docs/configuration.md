# Configuration

forya reads its settings from environment variables when it starts. With Compose, put `VIDEOS_PATH`, `FEED_NAME`, `POSTERS` and `BIND_ADDRESS` in a `.env` file next to `compose.yaml`, then run `docker compose up -d --build` again after any change.

## Compose settings

| Variable       | Default     | What it does                                                                               |
| -------------- | ----------- | ------------------------------------------------------------------------------------------ |
| `VIDEOS_PATH`  | required    | Host folder mounted read-only at `/srv/videos`.                                            |
| `FEED_NAME`    | `feed`      | Feed title and home-screen name.                                                           |
| `POSTERS`      | `false`     | Turn on poster and metadata generation.                                                    |
| `BIND_ADDRESS` | `127.0.0.1` | Host address the port is published on. See [access](install.md#access-and-authentication). |

## Server settings

These are read by the app itself. Except for `POSTERS`, Compose does not pass them through from `.env`, so add them to the `environment` mapping of the service in `compose.yaml`.

| Variable            | Default   | Purpose                                                     |
| ------------------- | --------- | ----------------------------------------------------------- |
| `IGNORE_HIDDEN`     | `true`    | Skip dotfiles and unfinished `*.partial` files.             |
| `ALLOW_HIDE`        | `false`   | Show the hide control; saved across devices with DATA_DIR.  |
| `PRELOAD_AHEAD`     | `3`       | Number of upcoming video cards kept ready.                  |
| `PRELOAD_BEHIND`    | `2`       | Number of previous video cards kept ready.                  |
| `AUTO_ADVANCE`      | `false`   | Start in next-on-end mode instead of looping.               |
| `MAX_COVER_CROP`    | `0.1`     | Maximum fraction cropped before using letterboxing.         |
| `POSTERS`           | `false`   | Generate posters and metadata when `DATA_DIR` is set.       |
| `PUBLIC_SHARE_BASE` | Unset     | External base URL for share links; requires DATA_DIR.       |
| `DEBUG_PLAYBACK`    | `false`   | Show a diagnostic playback overlay.                         |
| `PORT`              | `3000`    | Container listen port; keep aligned with port mapping.      |
| `HOST`              | `0.0.0.0` | Container listen address, not the host's published address. |

For several independent feeds, use separate containers, video mounts, data
volumes, feed names, and host ports.

`DATA_DIR` turns on saved state (favorites, server-side hidden items, share links). Compose sets it to `/data`. Outside Compose it is unset, so those features are off.

## Posters

For thumbnails and width/height/duration metadata, set `POSTERS=true` in `.env`
and rerun the start command. ffmpeg and ffprobe are included in the image.
Generation is lazy, one job at a time with low priority: the first view may have
no poster, while later views do. To disable generation again, set `POSTERS=false`.
Favorites still work. Outside Compose, generation requires both `DATA_DIR` and
`POSTERS=true`; neither is enabled by the Dockerfile alone.
