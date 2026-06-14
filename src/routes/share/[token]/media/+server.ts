import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { config } from '$lib/server/config';
import { resolveShare } from '$lib/server/share';
import { serve } from '$lib/server/mediaServe';

// GET|HEAD /share/<token>/media — UNAUTH bytes for a shared clip (the `/share/*` Caddy bypass).
// resolve token → name → `serve()` — the SAME Range-correct path as `/api/media`, which
// `safeMediaPath`s the name AND lstat-rejects symlinks. The lstat guard is LOAD-BEARING here:
// this surface is unauthenticated, so the 0.8.3 #1 symlink-escape would be internet-facing
// without it. Uniform 404 for any token miss (no oracle); serving-four byte-identical.
async function handle(token: string, rangeHeader: string | null, method: 'GET' | 'HEAD') {
	const resolved = await resolveShare(token, config.dataDir);
	if (!resolved) error(404, 'not found');
	// `serve` does the safe-resolve + lstat-symlink-reject + Range stream (identical contract
	// to /api/media). We pass only the resolved name — never the token — into the byte path.
	return serve(resolved.name, rangeHeader, method);
}

export const GET: RequestHandler = ({ params, request }) =>
	handle(params.token, request.headers.get('range'), 'GET');

export const HEAD: RequestHandler = ({ params, request }) =>
	handle(params.token, request.headers.get('range'), 'HEAD');
