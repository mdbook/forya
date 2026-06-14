import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { config } from '$lib/server/config';
import { hiddenEnabled, readHidden } from '$lib/server/hidden';

// GET /api/hidden → { enabled, hidden: string[] }. The client fetches this once on
// load to seed its in-memory hidden Set (so a freshly-hidden clip stays gone across
// devices, not just in this browser's localStorage). DATA_DIR off → { enabled:false,
// hidden:[] } (the client falls back to its local-only hide). The SERVER already
// excludes hidden names from /api/feed; this endpoint just lets the client know the
// authoritative set (e.g. to offer an unhide affordance later).
export const GET: RequestHandler = async () => {
	if (!hiddenEnabled(config.dataDir)) {
		return json({ enabled: false, hidden: [] }, { headers: { 'cache-control': 'no-cache' } });
	}
	return json(
		{ enabled: true, hidden: await readHidden() },
		{ headers: { 'cache-control': 'no-cache' } }
	);
};
