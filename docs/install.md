# Install guide

The [README quick start](../README.md#quick-start) gets you running with Docker Compose. This page covers what comes next: who can reach forya, where it keeps its data, and how to update it.

## Requirements

- Docker with the Compose v2 plugin.
- A folder of `.mp4`, `.mov`, `.webm` or `.m4v` files, plus optional photo galleries (see [architecture](architecture.md#media-layout)).
- A browser that can decode your clips. forya serves files as they are and does not convert anything.

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

## Data and backups

`VIDEO_DIR` is read-only input. forya never writes, renames, or deletes source
media. The Compose named volume at `/data` inherits the image's non-root ownership
and stores favorites, hidden items, share records, and optional generated caches.
These are shared feed state, not per-user accounts. Back up this volume to keep
them across reinstalls. Stop the container before copying its data for a backup.

To use a host directory instead, replace `forya-data:/data` in `compose.yaml` with
`/path/to/data:/data`. Create the directory first and make it writable by UID/GID
1000:1000 (`chown 1000:1000 /path/to/data` on Linux). This is not needed for a fresh
named volume. Never point `/data` at your source video folder.

## Updating

Download or pull the newer source, then run `docker compose up -d --build` again. Your favorites stay in the `forya-data` volume. `docker compose down` keeps that volume. `docker compose down -v` deletes it.

## Troubleshooting an empty feed

Check `VIDEOS_PATH`, the file extensions, and that UID 1000 can read the folder and its files. Compose refuses to start when `VIDEOS_PATH` is missing, rather than quietly serving an empty library. A clip that shows up but will not play probably uses a codec your browser cannot decode. `docker compose logs -f` shows startup output.
