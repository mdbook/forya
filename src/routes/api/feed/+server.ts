import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { config } from '$lib/server/config';
import { scanVideos, seededShuffle } from '$lib/server/videos';

// GET /api/feed → { feed, items: [...] } (SPEC §3).
// Default order is mtime-desc (from the scan). `?shuffle=1&seed=N` returns a
// deterministic seeded shuffle so client paging stays stable across requests.
// Stateless; no-cache (the ~10s scan memo lives server-side in videos.ts).
export const GET: RequestHandler = async ({ url }) => {
	const items = await scanVideos();

	let ordered = items;
	if (url.searchParams.get('shuffle') === '1') {
		const seed = Number.parseInt(url.searchParams.get('seed') ?? '0', 10);
		ordered = seededShuffle(items, Number.isFinite(seed) ? seed : 0);
	}

	return json(
		{ feed: config.feedName, items: ordered },
		{ headers: { 'cache-control': 'no-cache' } }
	);
};
