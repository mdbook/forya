import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { config } from '$lib/server/config';
import { getFeed, seededShuffle } from '$lib/server/videos';
import { enrichItems } from '$lib/server/probe';

// GET /api/feed → { feed, items: [...], warming } (SPEC §3).
// Default order is name-asc (a stable total order; 0.7.0 dropped the per-file
// stat that mtime-desc needed). `?shuffle=1&seed=N` returns a deterministic
// seeded shuffle so client paging stays stable across requests. `?offset=O&limit=L`
// (0.3.1, additive) paginates AFTER ordering — the page feed lazy-loads with
// these, threading the same `seed` so each page continues the same shuffled order.
// No params → the full list (the original contract).
// Stateless; no-cache. The manifest is served-stale-while-revalidate from memory
// (getFeed never blocks on a CIFS scan); `warming` is true only on a cold start.
export const GET: RequestHandler = async ({ url }) => {
	const { items, warming } = getFeed();

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

	// Additive metadata enrichment on the returned page only (0.5/M2); identity
	// when DATA_DIR is off, so the response is byte-identical without the feature.
	const enriched = await enrichItems(page);

	return json(
		{ feed: config.feedName, items: enriched, warming },
		{ headers: { 'cache-control': 'no-cache' } }
	);
};
