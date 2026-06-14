import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { config } from '$lib/server/config';
import { safeMediaPath } from '$lib/server/videos';
import { hiddenEnabled, setHidden } from '$lib/server/hidden';

// PUT    /api/hidden/<name> → hide a video from the feed → { name, hidden: true }
// DELETE /api/hidden/<name> → unhide it                  → { name, hidden: false }
//
// Idempotent PUT/DELETE (the client sends intent, so a retried request can't
// double-flip) — same shape as /api/starred, chosen over a bare POST toggle for
// that retry-safety. DATA_DIR off → 404 (feature absent — mirrors /api/poster's
// gated-off behaviour; the client then falls back to its local-only hide). The name
// is traversal-guarded by the same `safeMediaPath` as the media/poster/starred
// routes; an out-of-dir name → 404. We do NOT stat VIDEO_DIR to confirm the clip
// exists — hiding a since-deleted clip is harmless and keeps the toggle off the CIFS
// path, fully decoupled from the feed scan.
async function setMark(name: string, hide: boolean): Promise<Response> {
	if (!hiddenEnabled(config.dataDir)) return new Response(null, { status: 404 });
	if (safeMediaPath(name, config.videoDir) === null) return new Response(null, { status: 404 });
	return json({ name, hidden: await setHidden(name, hide) });
}

export const PUT: RequestHandler = ({ params }) => setMark(params.name, true);
export const DELETE: RequestHandler = ({ params }) => setMark(params.name, false);
