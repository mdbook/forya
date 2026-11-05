# forya

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

A phone-friendly, vertical feed for your own videos and photo galleries.
Point it at a folder, then watch in your browser. Your source files stay read-only.

## Run with Docker Compose

You need **Docker with Compose v2**, an internet connection for the first build,
and a folder containing `.mp4`, `.mov`, `.webm`, or `.m4v` files. Playback depends
on your browser's codec support; forya does not convert videos.

**Image availability:** there is not yet a verified public image to recommend.
Compose builds the included Dockerfile locally, with no registry login or local
Node installation. The first build can take several minutes.

1. [Download the source ZIP](https://github.com/mdbook/forya/archive/refs/heads/main.zip)
   and extract it, or clone [the repository](https://github.com/mdbook/forya).
   Open a terminal in the extracted repository folder.
2. Create a file named `.env` in that folder with your editor. Add these settings,
   replacing the video path with your **existing** folder's absolute path:

```dotenv
VIDEOS_PATH="/path/to/your/videos"
FEED_NAME="My feed"
```

Keep quotes around paths containing spaces. On Docker Desktop, allow Docker
access to that folder if prompted.

3. Start it:

```bash
docker compose up -d --build
```

Open <http://localhost:3000>. You should see your clips after the initial scan.
Compose keeps favorites in a named volume, without changing your video folder.
The default only accepts connections from this computer, since forya has no login.
For phone access or hosting, see [access and authentication](docs/guide.md#access-and-authentication).

**Empty feed?** Check `VIDEOS_PATH`, file extensions, and that the container's
user (UID 1000) can read the folder and files. Missing folders stop Compose rather
than silently creating an empty library. A clip that appears but will not play may
use a codec your browser cannot decode.

Use `docker compose logs -f` to inspect startup and `docker compose down` to stop.
Stopping preserves favorites; **`docker compose down -v` deletes the data volume**.
After downloading updated source, run the same start command to rebuild.

## Configuration

The settings most people need:

| Setting       | Default       | What it does                                                        |
| ------------- | ------------- | ------------------------------------------------------------------- |
| `VIDEOS_PATH` | Required      | Host folder mounted read-only by Compose. Set it in `.env`.         |
| `VIDEO_DIR`   | `/srv/videos` | Folder inside the container. Compose sets this; leave it alone.     |
| `FEED_NAME`   | `feed`        | Feed title and home-screen name. Set it in `.env`.                  |
| `DATA_DIR`    | `/data`       | Compose's writable volume for favorites and other saved feed state. |

Outside Compose, `DATA_DIR` is unset by default, disabling saved state. Posters
also need `POSTERS=true`; a data volume alone does not generate them.
If you replace the named `/data` volume with a host bind mount, that folder must
be writable by UID/GID **1000:1000** (`chown 1000:1000 /path/to/data` on Linux).

See the [guide](docs/guide.md) for tuning, posters, photo naming, endpoints,
backups, and development. Changes to `.env` take effect when you run the start
command again.

## Features

- Swipe through a freshly shuffled feed, with one clip playing at a time.
- Play, pause, seek, mute, or move to the next clip with on-screen controls.
- Browse photo galleries alongside videos, including galleries with music.
- Save favorites and open them at `/liked`.
- Add the feed to your iPhone home screen with Share > Add to Home Screen.

## Help and source

[Report a bug on GitHub](https://github.com/mdbook/forya/issues/new) with your
browser, setup, and steps to reproduce. Do not attach private media or credentials.
Source is available on [GitHub](https://github.com/mdbook/forya) and
[GitLab](https://gitlab.mdbook.me/mikayla/forya).

## License

[MIT](./LICENSE) © Mikayla D. Burke
