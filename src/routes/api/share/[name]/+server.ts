import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { config } from '$lib/server/config';
import { safeMediaPath } from '$lib/server/videos';
import { shareEnabled, mintShare } from '$lib/server/share';
import { currentOwner } from '$lib/server/owner';

// GET /api/share/<name> → { token, url }. AUTHED — stays behind the hub forward-auth like
// all of `/api` (only `/share/*` is bypassed). Mints (or reuses, dedup'd) a stored capability
// token for the clip and returns its public share URL. Order is load-bearing (review #967):
// `safeMediaPath(name)` FIRST (mintShare does ZERO validation), then mint under the request's
// owner (`__shared__` today via the seam). Feature off (no DATA_DIR) → 404, no store touched.
export const GET: RequestHandler = async (event) => {
	if (!shareEnabled(config.dataDir)) error(404, 'not found');
	const name = event.params.name;
	if (safeMediaPath(name, config.videoDir) === null) error(404, 'not found');

	const token = await mintShare(name, currentOwner(event));
	if (!token) error(404, 'not found'); // defensive: disabled between the gate and the write

	// Public base if configured (liked), else the request origin (LAN fallback). The client
	// only calls this when `settings.shareBase` is set, so the public base is normally present.
	const base = (config.shareBase || event.url.origin).replace(/\/+$/, '');
	return json(
		{ token, url: `${base}/share/${token}` },
		{ headers: { 'cache-control': 'private, no-store' } }
	);
};
