import type { PageServerLoad } from './$types';
import { config } from '$lib/server/config';
import { getFeed } from '$lib/server/videos';
import { hiddenSetSync } from '$lib/server/hidden';
import { enrichItems } from '$lib/server/probe';
import { readStarredOrdered } from '$lib/server/starred';

// The favorites VIEW (0.9.0): the same <Feed> player over ONLY the clips the user has starred,
// NEWEST-LIKED-FIRST. Sources entirely from the in-memory manifest + the small starred.json
// (readStarredOrdered) — ZERO new CIFS scan / per-file stat / poster-gen on the request path
// (AC-3, latency-neutral; the cheap-scan path is untouched). A starred clip absent from the
// manifest (deleted / not-yet-scanned) simply doesn't appear — self-cleaning, mirroring "a
// star of a since-deleted clip is harmless". Hidden clips are excluded too. The whole list is
// sent up front (no lazy paging), so the client passes total = items.length and never calls
// /api/feed (which would serve the MAIN feed, not this subset).
export const load: PageServerLoad = async () => {
	// readStarredOrdered = oldest→newest insertion order; reverse for newest-liked-first. [] when
	// the feature is off → empty view (inert, mirrors the rail-heart gating).
	const starred = config.starred ? await readStarredOrdered() : [];
	const { items, warming } = getFeed();
	const hidden = hiddenSetSync();
	const byName = new Map(items.map((it) => [it.name, it]));
	const liked = [];
	for (let i = starred.length - 1; i >= 0; i--) {
		const it = byName.get(starred[i]);
		if (it && !hidden.has(it.name)) liked.push(it);
	}
	return {
		feed: config.feedName,
		warming,
		// Enrich only the favorites (bounded, cache-read-only); identity when DATA_DIR/POSTERS off.
		items: await enrichItems(liked),
		// SSR-seed so the on-card hearts paint filled on the first frame (every clip here IS starred).
		starred,
		settings: {
			allowHide: config.allowHide,
			preloadAhead: config.preloadAhead,
			preloadBehind: config.preloadBehind,
			autoAdvance: config.autoAdvance,
			posters: config.posters,
			starred: config.starred,
			hidden: config.hidden,
			shareBase: config.shareBase,
			debugPlayback: config.debugPlayback,
			buildSha: config.buildSha
		}
	};
};
