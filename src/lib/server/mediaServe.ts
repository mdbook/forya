// Range-correct media serving — the byte path, shared (0.8.4) by `/api/media/[name]` (authed)
// AND `/share/<token>/media` (unauth, after a token→name resolve). Extracted VERBATIM from the
// 0.8.3 media route so both surfaces get the identical contract: 206 + Content-Range +
// Accept-Ranges, HEAD-mirrors-GET, a Range NEVER collapsed into a 200, AND the load-bearing
// lstat symlink-reject (adversarial #1) — CRITICAL because `/share/*` is unauthenticated, so
// the symlink guard MUST apply there too or the escape becomes internet-facing.
//
// The byte MATH still lives in `videos.ts` (`resolveRange`, unit-tested) — serving-four stays
// byte-identical; this module only relocates the route-level `statFile`/`serve` wrappers.
import { error } from '@sveltejs/kit';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { Readable } from 'node:stream';
import { config } from './config';
import { mimeFromExt, resolveMediaCandidates, resolveRange, weakETag } from './videos';

/**
 * Layout-agnostic resolve (v0.14.0): probe the ordered candidate paths for `name` (root → `galleries/`-flat
 * → nested `galleries/<id>/` → `videos/`, from `resolveMediaCandidates`) and return the FIRST that is a real
 * regular (non-symlink) file, or `null` if none. Manifest-independent, so a cold/warming container still
 * serves (AC8). Shared by the byte serve (404 on null) and the poster routes (204 on null).
 *
 * The load-bearing symlink reject (adversarial #1) is PRESERVED and, if anything, stronger: a planted
 * symlink (`clip.mp4 -> /etc/passwd`) is `lstat`'d — `isSymbolicLink()` true → the candidate is SKIPPED
 * (never followed), and the probe moves on; if only the symlink exists, all candidates fail → the caller
 * 404s. `lstat` (not `stat`) also means a real regular file's `st` === `stat`, so the size/mtime feeding
 * resolveRange/weakETag stay byte-identical (serving-four unchanged; this is route-level resolution only).
 */
export async function lstatMediaFile(
	name: string,
	videoDir: string = config.videoDir
): Promise<{ full: string; st: fs.Stats } | null> {
	for (const full of resolveMediaCandidates(name, videoDir)) {
		let st: fs.Stats;
		try {
			st = await fsp.lstat(full);
		} catch {
			continue; // this candidate doesn't exist — try the next
		}
		if (st.isSymbolicLink() || !st.isFile()) continue; // symlink/dir/etc — never serve; try the next
		return { full, st };
	}
	return null;
}

export async function statFile(name: string, videoDir: string = config.videoDir) {
	const found = await lstatMediaFile(name, videoDir);
	if (found === null) error(404, 'not found'); // traversal / bad name / no candidate → no leak
	return found;
}

function baseHeaders(name: string, st: fs.Stats): Record<string, string> {
	return {
		'accept-ranges': 'bytes',
		'content-type': mimeFromExt(name),
		'last-modified': st.mtime.toUTCString(),
		etag: weakETag(st.size, st.mtimeMs),
		// Purely additive: lets the browser reuse already-fetched bytes when
		// scrolling back up (the windowed feed re-enters previous cards) without a
		// revalidation round-trip. `private` because instances sit behind per-user
		// forward-auth — never a shared proxy cache. The weak ETag/Last-Modified
		// still drive revalidation once stale. Does NOT influence the Range branch
		// logic below — the 206/Content-Range/Content-Length/416 contract is
		// computed solely from resolveRange().
		'cache-control': 'private, max-age=3600'
	};
}

/**
 * Serve `name` from `videoDir` with full Range support (the iOS-correct contract). Used by
 * both the authed `/api/media` route and the unauth `/share/<token>/media` route — the CALLER
 * resolves the name (route param, or token→name) and is responsible for any auth/owner logic;
 * this function does the safe-resolve + lstat-guard + Range stream identically for both.
 */
export async function serve(
	name: string,
	rangeHeader: string | null,
	method: 'GET' | 'HEAD',
	videoDir: string = config.videoDir
) {
	const { full, st } = await statFile(name, videoDir);
	const headers = baseHeaders(name, st);
	const isHead = method === 'HEAD';
	const range = resolveRange(rangeHeader, st.size);

	if (range.kind === 'unsatisfiable') {
		return new Response(null, {
			status: 416,
			headers: { ...headers, 'content-range': `bytes */${st.size}` }
		});
	}

	if (range.kind === 'partial') {
		headers['content-range'] = `bytes ${range.start}-${range.end}/${st.size}`;
		headers['content-length'] = String(range.length);
		const body = isHead
			? null
			: (Readable.toWeb(
					fs.createReadStream(full, { start: range.start, end: range.end })
				) as ReadableStream);
		return new Response(body, { status: 206, headers });
	}

	// full 200 — whole file streamed (never buffered into memory), or no body for HEAD
	headers['content-length'] = String(st.size);
	const body = isHead ? null : (Readable.toWeb(fs.createReadStream(full)) as ReadableStream);
	return new Response(body, { status: 200, headers });
}
