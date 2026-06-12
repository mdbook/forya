import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { config } from '$lib/server/config';
import { scanVideos, seededShuffle } from '$lib/server/videos';

// GET /api/feed → { feed, items: [...] } (SPEC §3).
// Default order is mtime-desc (from the scan). `?shuffle=1&seed=N` returns a
// deterministic seeded shuffle so client paging stays stable across requests.
// `?offset=O&limit=L` (0.3.1, additive) paginates AFTER ordering — the page
// feed lazy-loads with these, threading the same `seed` so each page continues
// the same shuffled order. No params → the full list (the original contract).
// Stateless; no-cache (the ~10s scan memo lives server-side in videos.ts).
export const GET: RequestHandler = async ({ url }) => {
	const items = await scanVideos();

	let ordered = items;
	if (url.searchParams.get('shuffle') === '1') {
		const seed = Number.parseInt(url.searchParams.get('seed') ?? '0', 10);
		ordered = seededShuffle(items, Number.isFinite(seed) ? seed : 0);
	}

	const offsetParam = url.searchParams.get('offset');
	const limitParam = url.searchParams.get('limit');
	let page = ordered;
	if (offsetParam !== null || limitParam !== null) {
		const offset = Math.max(0, Number.parseInt(offsetParam ?? '0', 10) || 0);
		const limit = Number.parseInt(limitParam ?? '', 10);
		const end = Number.isFinite(limit) && limit > 0 ? offset + limit : undefined;
		page = ordered.slice(offset, end);
	}

	return json({ feed: config.feedName, items: page }, { headers: { 'cache-control': 'no-cache' } });
};
