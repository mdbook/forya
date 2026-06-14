import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { config } from '$lib/server/config';
import { starredEnabled, readStarred } from '$lib/server/starred';

// GET /api/starred → { enabled, starred: string[] }. The client fetches this once
// on load to seed an in-memory Set of starred names, then renders a filled heart on
// matching cards. DATA_DIR off → { enabled:false, starred:[] } (the client hides the
// heart UI and the double-tap is inert — no 404 to special-case). Decoupled from
// /api/feed: a mark reflects instantly client-side, never rescanning the SWR manifest.
export const GET: RequestHandler = async () => {
	if (!starredEnabled(config.dataDir)) {
		return json({ enabled: false, starred: [] }, { headers: { 'cache-control': 'no-cache' } });
	}
	return json(
		{ enabled: true, starred: await readStarred() },
		{ headers: { 'cache-control': 'no-cache' } }
	);
};
