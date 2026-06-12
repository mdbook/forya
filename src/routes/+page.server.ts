import type { PageServerLoad } from './$types';
import { config } from '$lib/server/config';
import { scanVideos } from '$lib/server/videos';

// Load the initial feed server-side (SPEC §4) so the first paint has items
// without a client round-trip. Default order is mtime-desc (from the scan).
// `settings` carries the client-relevant runtime config (hide control,
// preload-window sizes, autoplay-next default) — the client never reads env.
export const load: PageServerLoad = async () => {
	const items = await scanVideos();
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
