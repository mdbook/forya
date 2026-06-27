import type { PageServerLoad } from './$types';
import { config } from '$lib/server/config';
import { getFeed, seededShuffle } from '$lib/server/videos';
import { hiddenSetSync } from '$lib/server/hidden';
import { enrichItems } from '$lib/server/probe';
import { readStarred } from '$lib/server/starred';

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
	// SWR: getFeed() returns the in-memory manifest INSTANTLY (never blocks on a
	// CIFS scan). On a cold start it returns empty + warming:true; the page renders
	// a brief warming state and re-runs this load until the first background scan
	// lands (see +page.svelte). seededShuffle([]) is [], so warming SSR is coherent.
	const { items, warming } = getFeed();
	// Server-side hide (0.8.3): exclude hidden names before shuffle/slice so the SSR
	// page, `total`, and the client's seeded paging all agree on the VISIBLE set.
	// Zero-fs in-memory read (warmed at boot); `.size` guard keeps the no-hidden
	// payload byte-identical to pre-0.8.3.
	const hidden = hiddenSetSync();
	const visible = hidden.size ? items.filter((it) => !hidden.has(it.name)) : items;
	const shuffled = seededShuffle(visible, seed);
	return {
		feed: config.feedName,
		seed,
		total: shuffled.length,
		warming,
		// SSR-seed the starred set so the client paints filled hearts on the FIRST frame (no
		// empty→filled flash on reload). readStarred is a cached in-mem read = latency-neutral
		// (AC-3); [] when the feature is off so the payload stays byte-identical pre-0.9.0. 0.9.0.
		starred: config.starred ? await readStarred() : [],
		// Enrich only the page we send (bounded, cache-read-only); identity when
		// DATA_DIR is off, so the payload stays byte-identical (0.5/M2).
		items: await enrichItems(shuffled.slice(0, FIRST_PAGE)),
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
