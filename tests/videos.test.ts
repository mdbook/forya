// Scan filters (extensions + hidden/.partial), mime mapping, mtime-desc order,
// path-traversal rejection, and deterministic seeded shuffle (SPEC §3).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
	clearScanCache,
	getFeed,
	isVideoFile,
	mimeFromExt,
	safeMediaPath,
	scanVideos,
	seededShuffle
} from '../src/lib/server/videos';

let dir: string;

beforeEach(async () => {
	clearScanCache();
	dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'forya-videos-'));
});

afterEach(async () => {
	await fsp.rm(dir, { recursive: true, force: true });
});

async function write(name: string, bytes = 10) {
	await fsp.writeFile(path.join(dir, name), Buffer.alloc(bytes));
}

describe('mimeFromExt', () => {
	it('maps the four supported extensions', () => {
		expect(mimeFromExt('a.mp4')).toBe('video/mp4');
		expect(mimeFromExt('a.MOV')).toBe('video/quicktime');
		expect(mimeFromExt('a.webm')).toBe('video/webm');
		expect(mimeFromExt('a.m4v')).toBe('video/x-m4v');
	});

	it('maps image-gallery frame extensions (Contract A)', () => {
		expect(mimeFromExt('7_01.jpg')).toBe('image/jpeg');
		expect(mimeFromExt('7_01.JPEG')).toBe('image/jpeg');
		expect(mimeFromExt('7_01.png')).toBe('image/png');
		expect(mimeFromExt('7_01.webp')).toBe('image/webp');
	});

	it('maps gallery soundtrack extensions (round-3 audio)', () => {
		expect(mimeFromExt('7.m4a')).toBe('audio/mp4');
		expect(mimeFromExt('7.M4A')).toBe('audio/mp4');
		expect(mimeFromExt('7.mp3')).toBe('audio/mpeg');
	});

	it('falls back for unknown extensions', () => {
		expect(mimeFromExt('a.txt')).toBe('application/octet-stream');
	});
});

describe('isVideoFile', () => {
	it('accepts supported, rejects others (case-insensitive)', () => {
		expect(isVideoFile('clip.MP4')).toBe(true);
		expect(isVideoFile('clip.mov')).toBe(true);
		expect(isVideoFile('note.txt')).toBe(false);
		expect(isVideoFile('clip.mp4.partial')).toBe(false);
	});
});

describe('scanVideos', () => {
	it('keeps only supported video extensions', async () => {
		await write('a.mp4');
		await write('b.mov');
		await write('c.webm');
		await write('d.m4v');
		await write('note.txt');
		await write('image.jpg');
		const items = await scanVideos(dir, true);
		expect(items.map((i) => i.name).sort()).toEqual(['a.mp4', 'b.mov', 'c.webm', 'd.m4v']);
	});

	it('excludes dotfiles and .partial when ignoreHidden', async () => {
		await write('visible.mp4');
		await write('.hidden.mp4');
		await write('downloading.mp4.partial');
		await write('.another.partial');
		const items = await scanVideos(dir, true);
		expect(items.map((i) => i.name)).toEqual(['visible.mp4']);
	});

	it('includes dotfiles when ignoreHidden is false (but still ext-filtered)', async () => {
		await write('visible.mp4');
		await write('.hidden.mp4');
		await write('downloading.mp4.partial');
		const items = await scanVideos(dir, false);
		// .partial is still not a video extension, so it stays out
		expect(items.map((i) => i.name).sort()).toEqual(['.hidden.mp4', 'visible.mp4']);
	});

	it('cheap path (no DATA_DIR): name-asc order, url/type, and NO size/mtime', async () => {
		await write('b-new.mp4', 200);
		await write('a-old.mp4', 100);
		// cheap path is the default (config.dataDir === '' in the test env): Approach B
		// does a readdir-only scan and drops the per-file stat entirely.
		const items = await scanVideos(dir, true);
		// name-asc (a stable total order), NOT mtime — the per-file stat is gone.
		expect(items.map((i) => i.name)).toEqual(['a-old.mp4', 'b-new.mp4']);
		const first = items[0];
		expect(first.url).toBe('/api/media/a-old.mp4');
		expect(first.type).toBe('video/mp4');
		expect(first.size).toBeUndefined();
		expect(first.mtime).toBeUndefined();
	});

	it('full path (cheap=false, poster feed): includes size + mtime, still name-asc', async () => {
		await write('b.mp4', 200);
		await write('a.mp4', 100);
		const items = await scanVideos(dir, true, false);
		expect(items.map((i) => i.name)).toEqual(['a.mp4', 'b.mp4']);
		const a = items[0];
		expect(a.url).toBe('/api/media/a.mp4');
		expect(a.size).toBe(100);
		expect(a.type).toBe('video/mp4');
		expect(typeof a.mtime).toBe('number');
	});

	it('encodes special characters in the media url', async () => {
		await write('a b & c.mp4');
		const items = await scanVideos(dir, true);
		expect(items[0].url).toBe(`/api/media/${encodeURIComponent('a b & c.mp4')}`);
	});

	it('missing dir → empty feed, no throw', async () => {
		const items = await scanVideos(path.join(dir, 'does-not-exist'), true);
		expect(items).toEqual([]);
	});
});

describe('scanVideos image galleries (Contract A: <id>_NN.<ext> grouping)', () => {
	it('groups N frames of one post into ONE gallery item, media[] in carousel order', async () => {
		// Out-of-order on disk + a 2-digit boundary (09→10) to prove numeric-correct ordering.
		await write('700_02.jpg');
		await write('700_10.jpg');
		await write('700_01.jpg');
		await write('700_09.jpg');
		const items = await scanVideos(dir, true);
		expect(items).toHaveLength(1);
		const g = items[0];
		expect(g.name).toBe('700'); // one post = one unit, keyed by the bare id
		expect(g.media?.map((m) => m.name)).toEqual([
			'700_01.jpg',
			'700_02.jpg',
			'700_09.jpg',
			'700_10.jpg'
		]);
		expect(g.media?.map((m) => m.type)).toEqual([
			'image/jpeg',
			'image/jpeg',
			'image/jpeg',
			'image/jpeg'
		]);
		expect(g.media?.[0].url).toBe('/api/media/700_01.jpg');
		expect(g.url).toBe('/api/media/700_01.jpg'); // representative (share/info fallback) = frame 1
		expect(g.type).toBe('image/jpeg');
		// A gallery carries no per-file size/mtime (no poster/cache key).
		expect(g.size).toBeUndefined();
		expect(g.mtime).toBeUndefined();
	});

	it('_NN is ALWAYS present: a 1-image post is a 1-frame gallery, NOT a bare file', async () => {
		await write('42_01.jpg');
		const items = await scanVideos(dir, true);
		expect(items).toHaveLength(1);
		expect(items[0].name).toBe('42');
		expect(items[0].media?.map((m) => m.name)).toEqual(['42_01.jpg']);
	});

	it('preserves real image ext per frame (jpg/jpeg/png/webp)', async () => {
		await write('9_01.png');
		await write('9_02.webp');
		const items = await scanVideos(dir, true);
		expect(items[0].media?.map((m) => m.type)).toEqual(['image/png', 'image/webp']);
	});

	it('REJECTS non-conforming names (no best-effort grouping) — gate AC-3', async () => {
		await write('7_1.jpg'); // 1-digit index → not a frame
		await write('7_001.jpg'); // 3-digit index → not a frame
		await write('7.jpg'); // bare image, no _NN → not a gallery
		await write('foo_01.jpg'); // non-digit id → not a frame
		await write('7_01.gif'); // unsupported ext → not a frame
		const items = await scanVideos(dir, true);
		expect(items).toEqual([]); // every one ignored, none grouped or guessed
	});

	it('videos and galleries coexist; the video FeedItem shape is unchanged', async () => {
		await write('100.mp4');
		await write('200_01.jpg');
		await write('200_02.jpg');
		const items = await scanVideos(dir, true);
		// A video keeps its full filename as `name` (`100.mp4`); a gallery uses the bare id
		// (`200`) — never colliding (a gallery name has no extension). name-asc: '1' < '2'.
		expect(items.map((i) => i.name)).toEqual(['100.mp4', '200']);
		const vid = items.find((i) => i.name === '100.mp4')!;
		expect(vid.media).toBeUndefined(); // video: no media[] (identical to pre-galleries)
		expect(vid.url).toBe('/api/media/100.mp4');
		expect(vid.type).toBe('video/mp4');
		const gal = items.find((i) => i.name === '200')!;
		expect(gal.media).toHaveLength(2);
	});

	it('separate posts stay separate galleries', async () => {
		await write('11_01.jpg');
		await write('22_01.jpg');
		await write('22_02.jpg');
		const items = await scanVideos(dir, true);
		expect(items.map((i) => i.name)).toEqual(['11', '22']);
		expect(items.find((i) => i.name === '11')!.media).toHaveLength(1);
		expect(items.find((i) => i.name === '22')!.media).toHaveLength(2);
	});

	it('safeMediaPath resolves a frame name (I2 read-side, served via /api/media)', () => {
		expect(safeMediaPath('700_01.jpg', dir)).toBe(path.join(path.resolve(dir), '700_01.jpg'));
	});
});

describe('scanVideos gallery soundtracks (round-3: <id>.{m4a,mp3} audio, IFF frames exist)', () => {
	it('attaches a bare <id>.m4a soundtrack to the gallery item (audio field)', async () => {
		await write('700_01.jpg');
		await write('700_02.jpg');
		await write('700.m4a');
		const items = await scanVideos(dir, true);
		expect(items).toHaveLength(1);
		const g = items[0];
		expect(g.name).toBe('700');
		expect(g.media).toHaveLength(2); // the .m4a is NOT a frame
		expect(g.audio).toEqual({
			name: '700.m4a',
			url: '/api/media/700.m4a',
			type: 'audio/mp4'
		});
	});

	it('supports an .mp3 soundtrack too', async () => {
		await write('8_01.jpg');
		await write('8.mp3');
		const items = await scanVideos(dir, true);
		expect(items[0].audio).toEqual({
			name: '8.mp3',
			url: '/api/media/8.mp3',
			type: 'audio/mpeg'
		});
	});

	it('DISAMBIGUATOR: a bare <id>.{m4a,mp3} with NO frames is NOT a gallery and is dropped', async () => {
		await write('999.m4a'); // no 999_NN frames
		await write('888.mp3'); // no 888_NN frames
		const items = await scanVideos(dir, true);
		expect(items).toEqual([]); // audio without frames never becomes a feed item
	});

	it('an audioless gallery has NO audio field (byte-identical to pre-round-3)', async () => {
		await write('55_01.jpg');
		await write('55_02.jpg');
		const items = await scanVideos(dir, true);
		expect(items[0].media).toHaveLength(2);
		expect(items[0].audio).toBeUndefined();
	});

	it('prefers .m4a (AAC) over .mp3 when a post somehow has both (deterministic)', async () => {
		await write('70_01.jpg');
		await write('70.mp3');
		await write('70.m4a');
		const items = await scanVideos(dir, true);
		expect(items[0].audio?.name).toBe('70.m4a');
		expect(items[0].audio?.type).toBe('audio/mp4');
	});

	it('a soundtrack binds only to its OWN gallery; a nearby video is untouched', async () => {
		await write('100.mp4'); // video — never treated as audio
		await write('200_01.jpg');
		await write('200.m4a'); // binds to gallery 200 only
		await write('300_01.jpg'); // audioless gallery
		const items = await scanVideos(dir, true);
		const vid = items.find((i) => i.name === '100.mp4')!;
		expect(vid.audio).toBeUndefined();
		expect(vid.media).toBeUndefined();
		expect(items.find((i) => i.name === '200')!.audio?.name).toBe('200.m4a');
		expect(items.find((i) => i.name === '300')!.audio).toBeUndefined();
	});
});

describe('scanVideos caching (0.3.2: dir-mtime invalidation + single-flight)', () => {
	it('reuses the cache for an unchanged directory (same reference, no re-scan)', async () => {
		await write('a.mp4');
		const first = await scanVideos(dir, true);
		const second = await scanVideos(dir, true);
		expect(second).toBe(first); // same array ref → served from cache
	});

	it('re-scans when the directory changes (mtime bump)', async () => {
		await write('a.mp4');
		const first = await scanVideos(dir, true);
		await write('b.mp4');
		// Force the dir mtime forward so the bump is unambiguous regardless of
		// filesystem timestamp granularity.
		const bump = new Date(Date.now() + 10_000);
		await fsp.utimes(dir, bump, bump);
		const second = await scanVideos(dir, true);
		expect(second).not.toBe(first);
		expect(second.map((i) => i.name).sort()).toEqual(['a.mp4', 'b.mp4']);
	});

	it('single-flights concurrent scans into one shared result', async () => {
		await write('a.mp4');
		const [a, b] = await Promise.all([scanVideos(dir, true), scanVideos(dir, true)]);
		expect(b).toBe(a); // both awaited the same in-flight scan
	});

	it('keys the cache on `cheap` → no cross-shape bleed for one dir (no clearScanCache between)', async () => {
		await write('a.mp4', 100);
		// cheap=true → readdir-only shape: no per-file stat, so size/mtime are absent.
		const cheapItems = await scanVideos(dir, true, true);
		expect(cheapItems[0].size).toBeUndefined();
		expect(cheapItems[0].mtime).toBeUndefined();
		// SAME dir, cheap=false, WITHOUT clearing the cache. The #2 bug: the key omitted
		// `cheap`, so this hit the cached cheap entry and returned the wrong (cheap) SHAPE.
		// With `cheap` in the key it's a distinct entry → a real full-stat scan runs.
		const fullItems = await scanVideos(dir, true, false);
		expect(fullItems).not.toBe(cheapItems); // distinct cache entry, not the cheap one
		expect(fullItems[0].size).toBe(100); // full shape: size present
		expect(typeof fullItems[0].mtime).toBe('number'); // full shape: mtime present
		// re-requesting the cheap shape still yields the cheap shape (no bleed back either way)
		const cheapAgain = await scanVideos(dir, true, true);
		expect(cheapAgain[0].size).toBeUndefined();
	});
});

describe('getFeed (0.7.0 serve-stale-while-revalidate + warming)', () => {
	it('cold start: returns warming + empty, then serves the scanned manifest', async () => {
		await write('a.mp4');
		await write('b.mp4');
		const cold = getFeed(dir, true);
		expect(cold.warming).toBe(true);
		expect(cold.items).toEqual([]);
		// getFeed kicked a background scan; await the SAME in-flight scan (single-flight
		// keys on dir+ignoreHidden, so this joins it rather than starting a second).
		await scanVideos(dir, true);
		const warm = getFeed(dir, true);
		expect(warm.warming).toBe(false);
		expect(warm.items.map((i) => i.name)).toEqual(['a.mp4', 'b.mp4']);
	});

	it('serves the cached manifest synchronously, same ref, no re-scan', async () => {
		await write('a.mp4');
		const scanned = await scanVideos(dir, true);
		const first = getFeed(dir, true);
		const second = getFeed(dir, true);
		expect(first.warming).toBe(false);
		expect(first.items).toBe(scanned); // straight from the cache, no re-walk
		expect(second.items).toBe(first.items);
	});

	it('an empty/missing directory loads (not warming forever)', async () => {
		const missing = path.join(dir, 'nope');
		expect(getFeed(missing, true).warming).toBe(true);
		await scanVideos(missing, true); // background scan settles to []
		const res = getFeed(missing, true);
		expect(res.warming).toBe(false);
		expect(res.items).toEqual([]);
	});
});

describe('safeMediaPath (traversal)', () => {
	it('rejects separators, traversal, and NUL', () => {
		expect(safeMediaPath('../../etc/passwd', dir)).toBeNull();
		expect(safeMediaPath('..', dir)).toBeNull();
		expect(safeMediaPath('a/b.mp4', dir)).toBeNull();
		expect(safeMediaPath('a\\b.mp4', dir)).toBeNull();
		expect(safeMediaPath('foo\0.mp4', dir)).toBeNull();
		expect(safeMediaPath('', dir)).toBeNull();
		expect(safeMediaPath('.', dir)).toBeNull();
	});

	it('the decoded traversal probe does not resolve', () => {
		const probe = decodeURIComponent('..%2f..%2fetc%2fpasswd');
		expect(safeMediaPath(probe, dir)).toBeNull();
	});

	it('resolves a plain filename under the dir', () => {
		expect(safeMediaPath('clip.mp4', dir)).toBe(path.join(path.resolve(dir), 'clip.mp4'));
		expect(safeMediaPath('a b & c.mp4', dir)).toBe(path.join(path.resolve(dir), 'a b & c.mp4'));
	});
});

describe('seededShuffle', () => {
	const input = Array.from({ length: 50 }, (_, i) => i);

	it('is deterministic for a given seed', () => {
		expect(seededShuffle(input, 42)).toEqual(seededShuffle(input, 42));
	});

	it('different seeds generally differ', () => {
		expect(seededShuffle(input, 1)).not.toEqual(seededShuffle(input, 2));
	});

	it('is a permutation (no loss, no dupes) and does not mutate input', () => {
		const out = seededShuffle(input, 7);
		expect(out.slice().sort((a, b) => a - b)).toEqual(input);
		expect(input[0]).toBe(0); // input untouched
	});
});
