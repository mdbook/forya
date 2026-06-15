import fsp from 'node:fs/promises';
import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { config } from '$lib/server/config';
import { safeMediaPath } from '$lib/server/videos';
import { resolveShare } from '$lib/server/share';
import { readPoster } from '$lib/server/poster';

// GET /share/<token>/poster — UNAUTH (the `/share/*` bypass) — the cached JPEG poster for the ONE
// clip the token authorizes, used as the player page's og:image so iOS renders a rich LINK CARD
// instead of offering the raw .mp4 file. The public /api/poster route is Authentik-gated (outside
// `^/share/`), so the unauthenticated iOS link crawler cannot reach it — hence this dedicated
// bypassed route.
//
// ★ CACHE-READ-ONLY by design: unlike /api/poster this NEVER calls enqueueGeneration. An
// unauthenticated surface must not be able to spawn ffmpeg — that would be a transcode-DoS
// vector. A cache MISS (no poster yet), POSTERS off, a token miss, or a name that fails
// safeMediaPath / lstat → uniform 404 (no oracle, degrades the card to no-image, never a 500).
// Exposes only a poster DERIVED FROM a clip whose bytes are ALREADY shareable unauth at
// /share/<token>/media — zero new information exposure. Not a serving-four route; no Range path.
async function handle(token: string): Promise<Response> {
	const resolved = await resolveShare(token, config.dataDir);
	if (!resolved || !config.posters) error(404, 'not found');

	const full = safeMediaPath(resolved.name, config.videoDir);
	if (full === null) error(404, 'not found');

	// lstat (never follow a symlink out of the dir) → the cache key is the file mtime, matching
	// how /api/poster keys the cache when the client sends no `?v=` manifest mtime.
	const st = await fsp.lstat(full).catch(() => null);
	if (!st || !st.isFile()) error(404, 'not found');

	const poster = await readPoster(resolved.name, st.mtimeMs);
	if (!poster) error(404, 'not found'); // cache-read-only: a miss never kicks generation

	return new Response(new Uint8Array(poster), {
		status: 200,
		headers: {
			'content-type': 'image/jpeg',
			'content-length': String(poster.length),
			'cache-control': 'private, no-store',
			'referrer-policy': 'no-referrer'
		}
	});
}

export const GET: RequestHandler = ({ params }) => handle(params.token);
