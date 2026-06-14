import type { ServerInit } from '@sveltejs/kit';
import { config } from '$lib/server/config';
import { scanVideos } from '$lib/server/videos';
import { warmHidden } from '$lib/server/hidden';

// Warm-on-boot (0.8.0) — eagerly kick the 0.7.0 background feed scan at SERVER START
// so the first visitor after a container restart hits an already-warm (or
// warming-in-progress) feed instead of being the scan trigger. (Operator ask: the
// ~24s POSTERS=true full-stat scan shouldn't be deferred until someone loads the
// page; a visit within seconds of boot still sees the graceful warming screen, which
// is fine.)
//
// Why the `init` hook and not a module-level side-effect: `init` runs ONCE at server
// start and NOT during build/prerender, so there is no CIFS scan at image build by
// construction (a bare module side-effect would run on import → build-unsafe).
//
// ⚠️ FIRE-AND-FORGET (load-bearing): SvelteKit AWAITS `init` before it serves any
// request, so we must NEVER await the scan here — awaiting a ~24s full-stat scan
// would block server-ready, the exact opposite of the goal. We `void` it and
// `.catch()` so a boot-time scan failure can't crash startup or spew. This mirrors
// scheduleRevalidate's pattern (videos.ts).
//
// It reuses scanVideos' existing single-flight: a first request that races the boot
// scan shares it (gets `warming:true`), so there is no double-scan. `cheap =
// !config.posters` (0.8.0) → a POSTERS-off feed boot-warms cheap; a POSTERS=true feed
// boot-warms full-stat (warming `liked`'s ~24s so its first visitor isn't the trigger).
export const init: ServerInit = () => {
	void scanVideos(config.videoDir, config.ignoreHidden, !config.posters).catch(() => {
		/* a failed boot scan keeps the empty manifest; the first request retries via SWR */
	});
	// Warm the server-side hidden set (0.8.3) so the FIRST feed request can exclude
	// hidden names synchronously (the feed consumers read `hiddenSetSync` with no fs).
	// Fire-and-forget for the same reason as the scan: `init` is awaited before serving,
	// and this must not block server-ready. No-op + zero fs when DATA_DIR is unset.
	void warmHidden().catch(() => {
		/* a failed warm leaves an empty set; the first /api/hidden or write repopulates it */
	});
};
