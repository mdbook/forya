import type { PageServerLoad } from './$types';
import { config } from '$lib/server/config';
import { scanVideos, seededShuffle } from '$lib/server/videos';
import { enrichItems } from '$lib/server/probe';

// First page of the feed, sized so a huge directory doesn't inline a multi-MB
// manifest into the SSR payload (0.3.1 — the dominant mobile load cost). The
// client lazy-loads the rest via /api/feed with the same seed.
const FIRST_PAGE = 24;

// Load the initial feed server-side (SPEC §4) so the first paint has items
// without a client round-trip. As of 0.3.0 the page feed is RANDOMIZED: a fresh
// seed per request shuffles the scan, so every refresh yields a new order. The
// shuffle is server-side, so the SSR'd HTML and the hydrated client agree (no
// reorder flash) and the server stays stateless. 0.3.1: we send only the first
// `FIRST_PAGE` items plus `seed` + `total`; the client continues the SAME order
// by threading `seed` to /api/feed (deterministic seededShuffle). (The
// `/api/feed` endpoint keeps its mtime-desc default + opt-in `?shuffle=1&seed=N`
// + additive `offset`/`limit` for API consumers.)
// `settings` carries the client-relevant runtime config (hide control,
// preload-window sizes, autoplay-next default) — the client never reads env.
export const load: PageServerLoad = async () => {
	const seed = Math.floor(Math.random() * 2 ** 31);
	const shuffled = seededShuffle(await scanVideos(), seed);
	return {
		feed: config.feedName,
		seed,
		total: shuffled.length,
		// Enrich only the page we send (bounded, cache-read-only); identity when
		// DATA_DIR is off, so the payload stays byte-identical (0.5/M2).
		items: await enrichItems(shuffled.slice(0, FIRST_PAGE)),
		settings: {
			allowHide: config.allowHide,
			preloadAhead: config.preloadAhead,
			preloadBehind: config.preloadBehind,
			autoAdvance: config.autoAdvance,
			posters: config.dataDir !== '',
			debugPlayback: config.debugPlayback,
			buildSha: config.buildSha
		}
	};
};
