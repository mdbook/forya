import { error } from '@sveltejs/kit';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { Readable } from 'node:stream';
import type { RequestHandler } from './$types';
import { config } from '$lib/server/config';
import { mimeFromExt, resolveRange, safeMediaPath, weakETag } from '$lib/server/videos';

// GET|HEAD /api/media/[name] — the Range-correct serving endpoint (SPEC §3).
// iOS will not play or seek without proper 206 + Content-Range + Accept-Ranges,
// so the byte math lives in videos.ts (resolveRange, unit-tested) and this
// handler is a thin wrapper: safe-resolve → stat → resolve range → stream.
//
// HEAD mirrors what GET would return for the same request (same status +
// headers, no body): a HEAD probe without Range → 200 full; a HEAD with Range
// → 206 + Content-Range (this is what `curl -sI -r 0-1` hits — criterion 1).
// A Range request is NEVER collapsed into a full 200.

async function statFile(name: string) {
	const full = safeMediaPath(name, config.videoDir);
	if (full === null) error(404, 'not found'); // traversal / bad name → no leak
	let st: fs.Stats;
	try {
		st = await fsp.stat(full);
	} catch {
		error(404, 'not found');
	}
	if (!st.isFile()) error(404, 'not found');
	return { full, st };
}

function baseHeaders(name: string, st: fs.Stats): Record<string, string> {
	return {
		'accept-ranges': 'bytes',
		'content-type': mimeFromExt(name),
		'last-modified': st.mtime.toUTCString(),
		etag: weakETag(st.size, st.mtimeMs)
	};
}

async function serve(name: string, rangeHeader: string | null, method: 'GET' | 'HEAD') {
	const { full, st } = await statFile(name);
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

export const GET: RequestHandler = ({ params, request }) =>
	serve(params.name, request.headers.get('range'), 'GET');

export const HEAD: RequestHandler = ({ params, request }) =>
	serve(params.name, request.headers.get('range'), 'HEAD');
