import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { config } from '$lib/server/config';
import { safeMediaPath } from '$lib/server/videos';
import { starredEnabled, setStarred } from '$lib/server/starred';

// PUT    /api/starred/<name> → mark a video as starred  → { name, starred: true }
// DELETE /api/starred/<name> → unmark it                → { name, starred: false }
//
// Idempotent (the client knows the desired state after a double-tap and sends
// intent, so a retried request can't double-flip). DATA_DIR off → 404 (feature
// absent — mirrors /api/poster's gated-off behaviour). The name is traversal-guarded
// by the same `safeMediaPath` as the media/poster routes; an out-of-dir name → 404.
// We do NOT stat VIDEO_DIR to confirm the clip exists — a star of a since-deleted
// clip is harmless (it self-cleans when the client filters), and skipping the stat
// keeps the toggle off the CIFS path and fully decoupled from the feed scan.
async function setMark(name: string, star: boolean): Promise<Response> {
	if (!starredEnabled(config.dataDir)) return new Response(null, { status: 404 });
	if (safeMediaPath(name, config.videoDir) === null) return new Response(null, { status: 404 });
	return json({ name, starred: await setStarred(name, star) });
}

export const PUT: RequestHandler = ({ params }) => setMark(params.name, true);
export const DELETE: RequestHandler = ({ params }) => setMark(params.name, false);
