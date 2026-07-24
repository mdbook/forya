// THE guard that must never regress (SPEC §3). Two layers:
//  1. resolveRange — the pure byte-math resolver.
//  2. the media route — the actual HTTP contract (status + headers + body),
//     proving a Range request is NEVER collapsed into a full 200, that
//     Accept-Ranges is always present, and HEAD returns headers with no body.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { RequestHandler } from '@sveltejs/kit';
import { resolveRange, weakETag } from '../src/lib/server/videos';

const SIZE = 1000;

describe('resolveRange (pure)', () => {
	it('no header → full 200', () => {
		expect(resolveRange(null, SIZE)).toEqual({ kind: 'full', status: 200, length: SIZE });
	});

	it('closed bytes=0-1 → 206, length 2', () => {
		expect(resolveRange('bytes=0-1', SIZE)).toEqual({
			kind: 'partial',
			status: 206,
			start: 0,
			end: 1,
			length: 2
		});
	});

	it('open bytes=500- → 206 to EOF', () => {
		expect(resolveRange('bytes=500-', SIZE)).toEqual({
			kind: 'partial',
			status: 206,
			start: 500,
			end: 999,
			length: 500
		});
	});

	it('suffix bytes=-100 → 206 last 100 bytes', () => {
		expect(resolveRange('bytes=-100', SIZE)).toEqual({
			kind: 'partial',
			status: 206,
			start: 900,
			end: 999,
			length: 100
		});
	});

	it('end past EOF is clamped', () => {
		expect(resolveRange('bytes=990-100000', SIZE)).toEqual({
			kind: 'partial',
			status: 206,
			start: 990,
			end: 999,
			length: 10
		});
	});

	it('suffix larger than file → whole file as 206', () => {
		expect(resolveRange('bytes=-5000', SIZE)).toEqual({
			kind: 'partial',
			status: 206,
			start: 0,
			end: 999,
			length: 1000
		});
	});

	it('start past EOF → 416', () => {
		expect(resolveRange('bytes=999999999999-', SIZE)).toEqual({
			kind: 'unsatisfiable',
			status: 416
		});
	});

	it('zero-length suffix bytes=-0 → 416', () => {
		expect(resolveRange('bytes=-0', SIZE)).toEqual({ kind: 'unsatisfiable', status: 416 });
	});

	it('malformed header → full 200 (RFC: ignore invalid Range)', () => {
		expect(resolveRange('bytes=abc', SIZE)).toEqual({ kind: 'full', status: 200, length: SIZE });
		expect(resolveRange('kbytes=0-1', SIZE)).toEqual({ kind: 'full', status: 200, length: SIZE });
		expect(resolveRange('bytes=-', SIZE)).toEqual({ kind: 'full', status: 200, length: SIZE });
	});

	it('empty file: any range → 416, no range → full 200/0', () => {
		expect(resolveRange('bytes=0-', 0)).toEqual({ kind: 'unsatisfiable', status: 416 });
		expect(resolveRange(null, 0)).toEqual({ kind: 'full', status: 200, length: 0 });
	});
});

// ---------------------------------------------------------------------------
// Media route — real HTTP contract against a temp fixture file
// ---------------------------------------------------------------------------

const VIDEO_DIR = path.join(process.cwd(), 'tests', '.tmp-videos');
const NAME = 'clip.mp4';

function event(name: string, headers: Record<string, string> = {}) {
	return {
		params: { name },
		request: new Request(`http://localhost/api/media/${name}`, { headers })
	} as unknown as Parameters<RequestHandler>[0];
}

describe('GET|HEAD /api/media/[name]', () => {
	let GET: RequestHandler;
	let HEAD: RequestHandler;

	beforeAll(async () => {
		await fsp.mkdir(VIDEO_DIR, { recursive: true });
		// 1000 bytes of known content (byte i === i % 251).
		const buf = Buffer.alloc(SIZE);
		for (let i = 0; i < SIZE; i++) buf[i] = i % 251;
		await fsp.writeFile(path.join(VIDEO_DIR, NAME), buf);
		const mod = await import('../src/routes/api/media/[name]/+server');
		GET = mod.GET as RequestHandler;
		HEAD = mod.HEAD as RequestHandler;
	});

	afterAll(async () => {
		await fsp.rm(VIDEO_DIR, { recursive: true, force: true });
	});

	it('closed range bytes=0-1 → 206 with exact headers and 2-byte body', async () => {
		const res = (await GET(event(NAME, { range: 'bytes=0-1' }))) as Response;
		expect(res.status).toBe(206);
		expect(res.headers.get('content-range')).toBe(`bytes 0-1/${SIZE}`);
		expect(res.headers.get('content-length')).toBe('2');
		expect(res.headers.get('accept-ranges')).toBe('bytes');
		expect(res.headers.get('content-type')).toBe('video/mp4');
		const body = new Uint8Array(await res.arrayBuffer());
		expect(body.length).toBe(2);
		expect(Array.from(body)).toEqual([0, 1]);
	});

	it('suffix bytes=-100 → 206 last 100 bytes', async () => {
		const res = (await GET(event(NAME, { range: 'bytes=-100' }))) as Response;
		expect(res.status).toBe(206);
		expect(res.headers.get('content-range')).toBe(`bytes 900-999/${SIZE}`);
		expect(res.headers.get('content-length')).toBe('100');
		expect(res.headers.get('accept-ranges')).toBe('bytes');
		expect((await res.arrayBuffer()).byteLength).toBe(100);
	});

	it('open bytes=500- → 206 to EOF', async () => {
		const res = (await GET(event(NAME, { range: 'bytes=500-' }))) as Response;
		expect(res.status).toBe(206);
		expect(res.headers.get('content-range')).toBe(`bytes 500-999/${SIZE}`);
		expect(res.headers.get('content-length')).toBe('500');
		expect(res.headers.get('accept-ranges')).toBe('bytes');
		expect((await res.arrayBuffer()).byteLength).toBe(500);
	});

	it('unsatisfiable → 416 + Content-Range: bytes */size', async () => {
		const res = (await GET(event(NAME, { range: 'bytes=999999999999-' }))) as Response;
		expect(res.status).toBe(416);
		expect(res.headers.get('content-range')).toBe(`bytes */${SIZE}`);
		expect(res.headers.get('accept-ranges')).toBe('bytes');
	});

	it('no Range → 200 full length, Accept-Ranges present', async () => {
		const res = (await GET(event(NAME))) as Response;
		expect(res.status).toBe(200);
		expect(res.headers.get('content-length')).toBe(String(SIZE));
		expect(res.headers.get('accept-ranges')).toBe('bytes');
		expect(res.headers.get('content-range')).toBeNull();
		expect((await res.arrayBuffer()).byteLength).toBe(SIZE);
	});

	it('HEAD without Range → 200 full headers, no body (iOS probe)', async () => {
		const res = (await HEAD(event(NAME))) as Response;
		expect(res.status).toBe(200);
		expect(res.headers.get('content-length')).toBe(String(SIZE));
		expect(res.headers.get('accept-ranges')).toBe('bytes');
		expect(res.headers.get('content-type')).toBe('video/mp4');
		expect((await res.arrayBuffer()).byteLength).toBe(0);
	});

	it('HEAD with Range → 206 + Content-Range, no body (criterion 1: curl -sI -r 0-1)', async () => {
		const res = (await HEAD(event(NAME, { range: 'bytes=0-1' }))) as Response;
		expect(res.status).toBe(206);
		expect(res.headers.get('content-range')).toBe(`bytes 0-1/${SIZE}`);
		expect(res.headers.get('content-length')).toBe('2');
		expect(res.headers.get('accept-ranges')).toBe('bytes');
		expect((await res.arrayBuffer()).byteLength).toBe(0);
	});

	it('a Range request is never silently a full 200', async () => {
		const res = (await GET(event(NAME, { range: 'bytes=0-9' }))) as Response;
		expect(res.status).toBe(206);
		expect(res.status).not.toBe(200);
		expect(res.headers.get('content-length')).toBe('10');
	});

	it('Cache-Control is additive and does not perturb the range responses', async () => {
		// 206 partial: header present, AND the range contract is byte-identical.
		const partial = (await GET(event(NAME, { range: 'bytes=0-1' }))) as Response;
		expect(partial.headers.get('cache-control')).toBe('private, max-age=3600');
		expect(partial.status).toBe(206);
		expect(partial.headers.get('content-range')).toBe(`bytes 0-1/${SIZE}`);
		expect(partial.headers.get('content-length')).toBe('2');
		expect(partial.headers.get('accept-ranges')).toBe('bytes');
		expect((await partial.arrayBuffer()).byteLength).toBe(2);

		// 200 full: header present, still a full-length 200.
		const full = (await GET(event(NAME))) as Response;
		expect(full.headers.get('cache-control')).toBe('private, max-age=3600');
		expect(full.status).toBe(200);
		expect(full.headers.get('content-length')).toBe(String(SIZE));
		expect(full.headers.get('content-range')).toBeNull();

		// HEAD+Range still 206 with no body; caching header doesn't change that.
		const head = (await HEAD(event(NAME, { range: 'bytes=0-1' }))) as Response;
		expect(head.headers.get('cache-control')).toBe('private, max-age=3600');
		expect(head.status).toBe(206);
		expect((await head.arrayBuffer()).byteLength).toBe(0);
	});

	it('traversal probe → 404, no leak', async () => {
		// mirrors what the router hands us once %2f is decoded
		const probe = decodeURIComponent('..%2f..%2fetc%2fpasswd');
		await expect(GET(event(probe))).rejects.toMatchObject({ status: 404 });
	});

	it('adversarial #1: a symlink in VIDEO_DIR → 404 (lstat-reject), never followed out of dir', async () => {
		// safeMediaPath is purely LEXICAL: an in-dir NAME (`evil.mp4`, no `..`/separator)
		// whose symlink TARGET escapes VIDEO_DIR passes it. The route must `lstat`-reject the
		// symlink so the byte path never streams the out-of-dir file with Range support. The
		// live `:ro` library can't be symlink-planted, so this fixture is the ONLY regression
		// guard (review #936 HARD gate).
		const outside = path.join(process.cwd(), 'tests', '.tmp-outside');
		await fsp.mkdir(outside, { recursive: true });
		const secret = path.join(outside, 'secret.txt');
		await fsp.writeFile(secret, 'TOP SECRET — must never be streamed');
		const link = path.join(VIDEO_DIR, 'evil.mp4'); // in-dir name, target escapes
		await fsp.symlink(secret, link);
		try {
			await expect(GET(event('evil.mp4'))).rejects.toMatchObject({ status: 404 });
			await expect(HEAD(event('evil.mp4'))).rejects.toMatchObject({ status: 404 });
		} finally {
			await fsp.rm(link, { force: true });
			await fsp.rm(outside, { recursive: true, force: true });
		}
	});

	it('v0.14.0: serves a NESTED galleries/<id>/NN.<ext> frame by its normalized name (probe)', async () => {
		const gdir = path.join(VIDEO_DIR, 'galleries', 'g1');
		await fsp.mkdir(gdir, { recursive: true });
		const buf = Buffer.alloc(SIZE);
		for (let i = 0; i < SIZE; i++) buf[i] = (i + 7) % 251;
		await fsp.writeFile(path.join(gdir, '01.jpg'), buf); // physical: galleries/g1/01.jpg
		try {
			// full 200 — the probe finds the nested file from the flat-form public name g1_01.jpg
			const full = (await GET(event('g1_01.jpg'))) as Response;
			expect(full.status).toBe(200);
			expect(full.headers.get('content-type')).toBe('image/jpeg');
			expect(full.headers.get('content-length')).toBe(String(SIZE));
			// Range 206 works through the probe-resolved nested path (Range contract intact)
			const part = (await GET(event('g1_01.jpg', { range: 'bytes=0-1' }))) as Response;
			expect(part.status).toBe(206);
			expect(part.headers.get('content-range')).toBe(`bytes 0-1/${SIZE}`);
			expect(Array.from(new Uint8Array(await part.arrayBuffer()))).toEqual([7, 8]);
		} finally {
			await fsp.rm(path.join(VIDEO_DIR, 'galleries'), { recursive: true, force: true });
		}
	});

	it('v0.14.0: a symlink at a NESTED candidate is lstat-rejected → 404 (AC4 nested guard)', async () => {
		const outside = path.join(process.cwd(), 'tests', '.tmp-outside2');
		await fsp.mkdir(outside, { recursive: true });
		const secret = path.join(outside, 'secret.txt');
		await fsp.writeFile(secret, 'must never stream');
		const gdir = path.join(VIDEO_DIR, 'galleries', 'g2');
		await fsp.mkdir(gdir, { recursive: true });
		await fsp.symlink(secret, path.join(gdir, '01.jpg')); // nested name, target escapes VIDEO_DIR
		try {
			await expect(GET(event('g2_01.jpg'))).rejects.toMatchObject({ status: 404 });
			await expect(HEAD(event('g2_01.jpg'))).rejects.toMatchObject({ status: 404 });
		} finally {
			await fsp.rm(path.join(VIDEO_DIR, 'galleries'), { recursive: true, force: true });
			await fsp.rm(outside, { recursive: true, force: true });
		}
	});

	// 0.7.0: the cheap (readdir-only) feed manifest now OMITS size/mtime on poster-
	// off feeds, so the byte-serve path must stay wholly independent of the manifest
	// — it computes every header from the file's OWN stat. These lock that contract
	// (the thing most at risk once the scan stopped statting) AND the lazy info-
	// overlay size source (a HEAD content-length read for the single active card).
	it('0.7.0: HEAD content-length equals the real on-disk size (lazy info-size source)', async () => {
		const onDisk = (await fsp.stat(path.join(VIDEO_DIR, NAME))).size;
		const res = (await HEAD(event(NAME))) as Response;
		expect(res.status).toBe(200);
		expect(Number(res.headers.get('content-length'))).toBe(onDisk);
		expect(onDisk).toBe(SIZE);
	});

	it('0.7.0: ETag/Last-Modified derive from the file stat, not the feed manifest', async () => {
		const st = await fsp.stat(path.join(VIDEO_DIR, NAME));
		const res = (await GET(event(NAME))) as Response;
		// weakETag(realSize, realMtime) — proves dropping size/mtime from the cheap
		// scan can't perturb the byte-serve contract (the endpoint stats the file).
		expect(res.headers.get('etag')).toBe(weakETag(st.size, st.mtimeMs));
		expect(res.headers.get('last-modified')).toBe(st.mtime.toUTCString());
	});
});
