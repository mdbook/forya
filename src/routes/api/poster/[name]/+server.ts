import fsp from 'node:fs/promises';
import type { RequestHandler } from './$types';
import { config } from '$lib/server/config';
import { safeMediaPath } from '$lib/server/videos';
import { readPoster } from '$lib/server/poster';
import { enqueueGeneration } from '$lib/server/worker';

// GET /api/poster/<name>?v=<mtimeMs> → the cached JPEG poster for a video, or
// **204 No Content** when there's no poster yet (the client then falls back to
// the gradient placeholder). NEW route — NOT one of the serving-four; it never
// touches the Range path. Generation is the M4 worker's job; this handler only
// READS the cache, so it can't stall serving or spawn ffmpeg.
//
// Safety: POSTERS off (`!config.posters`) → the feature is off → 204 (identical to
// a build without it). 0.8.0: gates on the POSTERS feature, NOT the bare DATA_DIR
// volume — a feed with a volume only for `starred` (POSTERS off) 204s here and never
// reaches `enqueueGeneration`, so it spawns ZERO ffmpeg (this route is the worker's
// only trigger — there is no boot bulk-encode). The name is resolved with the same
// `safeMediaPath` guard as the media route (no traversal), then `lstat`'d so a
// symlink planted in VIDEO_DIR is rejected rather than followed out of the dir (F7).
// Any error degrades to 204 — never a 500, never a stall.
export const GET: RequestHandler = async ({ params, url }) => {
	if (!config.posters) return new Response(null, { status: 204 });

	const name = params.name;
	const full = safeMediaPath(name, config.videoDir);
	if (full === null) return new Response(null, { status: 204 });

	let mtimeMs: number;
	try {
		const st = await fsp.lstat(full); // lstat: never follow a symlink out of the dir
		if (!st.isFile()) return new Response(null, { status: 204 });
		mtimeMs = st.mtimeMs;
	} catch {
		return new Response(null, { status: 204 });
	}

	// `key` is the SERVE-attempt cache key: prefer the client-supplied manifest mtime
	// (`?v=`) so a fresh manifest hits its cached poster directly; fall back to the stat.
	const v = Number(url.searchParams.get('v'));
	const key = Number.isFinite(v) && v > 0 ? v : mtimeMs;

	const poster = await readPoster(name, key);
	if (!poster) {
		// Lazy generation: kick the worker (fire-and-forget, OFF this response) so the
		// poster is ready on a later request, then degrade to the placeholder.
		// #3 (0.8.5): GENERATE under the AUTHORITATIVE file mtime (`mtimeMs`), NOT the
		// client `?v=` (`key`). The scan/probe path reads meta+poster under the file's
		// real mtime (probe.ts → readMeta(name, it.mtime)), so generating under a stale
		// `?v=` (a re-encoded/re-synced clip) writes to the wrong key → permanent
		// read-miss (CLS + imageless share cards). Latency-neutral: `mtimeMs` is the
		// lstat above — no new I/O. The serve attempt still uses `key` (the fast path).
		enqueueGeneration(name, mtimeMs, full);
		return new Response(null, { status: 204 });
	}

	return new Response(new Uint8Array(poster), {
		status: 200,
		headers: {
			'content-type': 'image/jpeg',
			'content-length': String(poster.length),
			'cache-control': 'private, max-age=3600'
		}
	});
};
