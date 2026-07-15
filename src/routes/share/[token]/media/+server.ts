import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { config } from '$lib/server/config';
import { resolveShare } from '$lib/server/share';
import { getFeed } from '$lib/server/videos';
import { serve } from '$lib/server/mediaServe';

// GET|HEAD /share/<token>/media[?f=<frame>] — UNAUTH bytes for a shared item (the `/share/*`
// Caddy bypass). resolve token → name → `serve()` — the SAME Range-correct path as `/api/media`,
// which `safeMediaPath`s the name AND lstat-rejects symlinks. The lstat guard is LOAD-BEARING
// here: this surface is unauthenticated, so the 0.8.3 #1 symlink-escape would be internet-facing
// without it. Uniform 404 for any token miss (no oracle); serving-four byte-identical.
//
// Image galleries (photo posts): the token resolves to the bare `<id>` (not a file). `?f=<frame>`
// serves a specific gallery frame — validated to be one of THIS gallery's own frames (the warm
// manifest's `media[]` is the allowlist), so a token for gallery X can only ever serve X's
// frames, never an arbitrary path. No `?f` on a gallery → the cover frame (OG default). A video/
// single token has no `media[]` → the `?f` branch never fires and it serves its name exactly as
// before (byte-identical to pre-galleries).
async function handle(
	token: string,
	frame: string | null,
	rangeHeader: string | null,
	method: 'GET' | 'HEAD'
) {
	const resolved = await resolveShare(token, config.dataDir);
	if (!resolved) error(404, 'not found');

	const item = getFeed().items.find((i) => i.name === resolved.name);
	if (item?.media) {
		// Gallery: serve a frame from the token's OWN gallery only (allowlist = its media[]).
		const allow = new Set(item.media.map((m) => m.name));
		if (frame !== null) {
			if (!allow.has(frame)) error(404, 'not found'); // not this gallery's frame → no serve
			return serve(frame, rangeHeader, method);
		}
		return serve(item.media[0].name, rangeHeader, method); // no frame → cover
	}

	// Video / single clip — unchanged: pass only the resolved name (never the token) to the byte path.
	return serve(resolved.name, rangeHeader, method);
}

export const GET: RequestHandler = ({ params, url, request }) =>
	handle(params.token, url.searchParams.get('f'), request.headers.get('range'), 'GET');

export const HEAD: RequestHandler = ({ params, url, request }) =>
	handle(params.token, url.searchParams.get('f'), request.headers.get('range'), 'HEAD');
