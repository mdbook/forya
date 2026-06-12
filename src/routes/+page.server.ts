import type { PageServerLoad } from './$types';
import { config } from '$lib/server/config';
import { scanVideos, seededShuffle } from '$lib/server/videos';

// Load the initial feed server-side (SPEC §4) so the first paint has items
// without a client round-trip. As of 0.3.0 the page feed is RANDOMIZED: a fresh
// seed per request shuffles the scan, so every refresh yields a new order. The
// shuffle is server-side, so the SSR'd HTML and the hydrated client agree (no
// reorder flash) and the server stays stateless. (The `/api/feed` endpoint keeps
// its mtime-desc default + opt-in `?shuffle=1&seed=N` for API consumers.)
// `settings` carries the client-relevant runtime config (hide control,
// preload-window sizes, autoplay-next default) — the client never reads env.
export const load: PageServerLoad = async () => {
	const items = seededShuffle(await scanVideos(), Math.floor(Math.random() * 2 ** 31));
	return {
		feed: config.feedName,
		items,
		settings: {
			allowHide: config.allowHide,
			preloadAhead: config.preloadAhead,
			preloadBehind: config.preloadBehind,
			autoAdvance: config.autoAdvance
		}
	};
};
