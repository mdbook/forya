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
	resolveMediaCandidates,
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

// Write a file at a (possibly nested) subpath under the temp dir, creating parent dirs (v0.14.0).
async function writeIn(subpath: string, bytes = 10) {
	const full = path.join(dir, subpath);
	await fsp.mkdir(path.dirname(full), { recursive: true });
	await fsp.writeFile(full, Buffer.alloc(bytes));
}

describe('mimeFromExt', () => {
	it('maps the four supported extensions', () => {
		expect(mimeFromExt('a.mp4')).toBe('video/mp4');
		expect(mimeFromExt('a.MOV')).toBe('video/quicktime');
		expect(mimeFromExt('a.webm')).toBe('video/webm');
		expect(mimeFromExt('a.m4v')).toBe('video/x-m4v');
	});

	it('maps image-gallery frame extensions (Contract A + v0.13.0 gif)', () => {
		expect(mimeFromExt('7_01.jpg')).toBe('image/jpeg');
		expect(mimeFromExt('7_01.JPEG')).toBe('image/jpeg');
		expect(mimeFromExt('7_01.png')).toBe('image/png');
		expect(mimeFromExt('7_01.webp')).toBe('image/webp');
		expect(mimeFromExt('7_01.gif')).toBe('image/gif'); // v0.13.0 (reddit)
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
		// (a bare `image.jpg` is a single-frame gallery as of v0.13.0 — covered in the reddit
		// block below; here we only assert that non-media junk like `note.txt` is dropped.)
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

	it('still REJECTS malformed frame indices (v0.13.0: the index shape stays strict)', async () => {
		// v0.13.0 relaxed the id STEM to base36 (AC-1) and made bare images single-frame galleries
		// (AC-2) — but the frame INDEX stays strict `_\d{2}`. These have a `_` (so not a bare single
		// image) AND a non-2-digit index (so not a frame) → dropped, never best-effort grouped.
		// (`7.jpg`, `foo_01.jpg`, `7_01.gif` are now VALID — see the v0.13.0 block below.)
		await write('7_1.jpg'); // 1-digit index
		await write('7_001.jpg'); // 3-digit index
		const items = await scanVideos(dir, true);
		expect(items).toEqual([]);
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

describe('scanVideos reddit galleries (v0.13.0: base36 ids + single images + gif)', () => {
	it('AC-1: groups base36-id gallery frames (reddit ids contain letters)', async () => {
		await write('1ukez7v_01.png');
		await write('1ukez7v_02.png');
		const items = await scanVideos(dir, true);
		expect(items).toHaveLength(1);
		expect(items[0].name).toBe('1ukez7v');
		expect(items[0].media?.map((m) => m.name)).toEqual(['1ukez7v_01.png', '1ukez7v_02.png']);
	});

	it('AC-1 regression: numeric TikTok ids still group byte-identically (numeric ⊂ base36)', async () => {
		await write('700_01.jpg');
		await write('700_02.jpg');
		const items = await scanVideos(dir, true);
		expect(items).toHaveLength(1);
		expect(items[0].name).toBe('700');
		expect(items[0].media).toHaveLength(2);
	});

	it('AC-2: a bare <id>.<img-ext> (no _NN) is a single-frame gallery — base36 AND numeric', async () => {
		await write('11lmhmr.jpg'); // reddit base36 single
		await write('123.png'); // numeric single
		const items = await scanVideos(dir, true);
		expect(items).toHaveLength(2);
		const g1 = items.find((i) => i.name === '11lmhmr')!;
		expect(g1.media).toEqual([
			{ name: '11lmhmr.jpg', url: '/api/media/11lmhmr.jpg', type: 'image/jpeg' }
		]);
		const g2 = items.find((i) => i.name === '123')!;
		expect(g2.media).toEqual([{ name: '123.png', url: '/api/media/123.png', type: 'image/png' }]);
		// url/type mirror the one frame (share/info fallback), like a multi-frame gallery.
		expect(g1.url).toBe('/api/media/11lmhmr.jpg');
		expect(g1.type).toBe('image/jpeg');
	});

	it('AC-2: a single-frame gallery has NO audio field (reddit singles are silent)', async () => {
		await write('abc.jpg');
		const items = await scanVideos(dir, true);
		expect(items[0].media).toHaveLength(1);
		expect(items[0].audio).toBeUndefined();
	});

	it('AC-2 defensive: an id with BOTH _NN frames and a bare image → multi-frame wins, no dup', async () => {
		await write('dup_01.jpg');
		await write('dup_02.jpg');
		await write('dup.jpg'); // same id, bare — must NOT create a second item
		const items = await scanVideos(dir, true);
		expect(items).toHaveLength(1);
		expect(items[0].name).toBe('dup');
		expect(items[0].media).toHaveLength(2); // the multi-frame set, not the bare single
	});

	it('AC-3: .gif works as a gallery frame, a bare single image, and in MIME', async () => {
		expect(mimeFromExt('x.gif')).toBe('image/gif');
		await write('g_01.gif'); // gif frame, mixed with a jpg frame in one gallery
		await write('g_02.jpg');
		await write('solo.gif'); // bare gif → single-frame gallery
		const items = await scanVideos(dir, true);
		const g = items.find((i) => i.name === 'g')!;
		expect(g.media?.map((m) => m.type)).toEqual(['image/gif', 'image/jpeg']);
		const solo = items.find((i) => i.name === 'solo')!;
		expect(solo.media).toEqual([
			{ name: 'solo.gif', url: '/api/media/solo.gif', type: 'image/gif' }
		]);
	});

	it('regression: videos + junk unaffected; a bare non-image is not a false-positive gallery', async () => {
		await write('vid.mp4'); // video: unchanged, no media[]
		await write('note.txt'); // junk: not an image ext → dropped
		await write('7_1.jpg'); // malformed index (has `_`) → not a single image, dropped
		const items = await scanVideos(dir, true);
		expect(items.map((i) => i.name).sort()).toEqual(['vid.mp4']);
		expect(items.find((i) => i.name === 'vid.mp4')!.media).toBeUndefined();
	});

	it('base36 gallery frame flows through safeMediaPath (I2 read-side unchanged)', () => {
		expect(safeMediaPath('1ukez7v_01.png', dir)).toBe(
			path.join(path.resolve(dir), '1ukez7v_01.png')
		);
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

describe('scanVideos layout-agnostic (v0.14.0: flat + galleries/-flat + nested galleries/<id>/ + videos/)', () => {
	const byName = (items: Awaited<ReturnType<typeof scanVideos>>, name: string) =>
		items.find((i) => i.name === name);

	it('nested galleries/<id>/NN.<ext> → one item, frame names normalized to <id>_NN.<ext>', async () => {
		await writeIn('galleries/7/01.jpg');
		await writeIn('galleries/7/02.jpg');
		const items = await scanVideos(dir, true);
		expect(items).toHaveLength(1);
		expect(items[0].name).toBe('7');
		expect(items[0].media?.map((f) => f.name)).toEqual(['7_01.jpg', '7_02.jpg']);
		expect(items[0].media?.[0].url).toBe('/api/media/7_01.jpg');
		expect(items[0].media?.[0].type).toBe('image/jpeg');
	});

	it('galleries/-flat <id>_NN.<ext> → one gallery item', async () => {
		await writeIn('galleries/9_01.jpg');
		await writeIn('galleries/9_02.png');
		const items = await scanVideos(dir, true);
		expect(items).toHaveLength(1);
		expect(items[0].name).toBe('9');
		expect(items[0].media?.map((f) => f.name)).toEqual(['9_01.jpg', '9_02.png']);
	});

	it('videos/ subdir → video item keyed by full basename', async () => {
		await writeIn('videos/v1.mp4');
		const items = await scanVideos(dir, true);
		expect(items.map((i) => i.name)).toEqual(['v1.mp4']);
		expect(items[0].media).toBeUndefined();
	});

	it('AC6: a video + a same-<id> gallery are TWO distinct items (video keyed by <id>.<ext>, NOT re-keyed)', async () => {
		await write('7.mp4'); // flat video, identity 7.mp4
		await writeIn('galleries/7/01.jpg'); // nested gallery, identity bare 7
		const items = await scanVideos(dir, true);
		expect(items.map((i) => i.name).sort()).toEqual(['7', '7.mp4']);
		expect(byName(items, '7.mp4')?.media).toBeUndefined();
		expect(byName(items, '7')?.media).toHaveLength(1);
	});

	it('AC9: union across layouts — root <id>_NN + nested <id>/NN merge into ONE deduped gallery', async () => {
		await write('8_01.jpg'); // root frame 01
		await writeIn('galleries/8/02.jpg'); // nested frame 02
		const items = await scanVideos(dir, true);
		expect(items).toHaveLength(1);
		expect(items[0].name).toBe('8');
		expect(items[0].media?.map((f) => f.name)).toEqual(['8_01.jpg', '8_02.jpg']);
	});

	it('AC9: same index in two layouts dedups nested-wins (ONE frame at that index)', async () => {
		await write('8_01.jpg'); // root frame 01 (jpg)
		await writeIn('galleries/8/01.png'); // nested frame 01 (png) — SAME index
		const items = await scanVideos(dir, true);
		expect(items).toHaveLength(1);
		expect(items[0].media).toHaveLength(1); // deduped to one frame at index 01
		expect(items[0].media?.[0].name).toBe('8_01.png'); // nested-wins → the .png
	});

	it('nested soundtrack galleries/<id>/<id>.m4a attaches IFF frames', async () => {
		await writeIn('galleries/13/01.jpg');
		await writeIn('galleries/13/13.m4a');
		const items = await scanVideos(dir, true);
		expect(items).toHaveLength(1);
		expect(items[0].audio?.name).toBe('13.m4a');
		expect(items[0].audio?.type).toBe('audio/mp4');
	});

	it('frame-less orphan audio is DROPPED under both layouts (tiktok #1785 attach-iff-frames)', async () => {
		await write('12.m4a'); // flat orphan audio, no 12_NN frames
		await writeIn('galleries/11/11.m4a'); // nested orphan audio, no frames in the dir
		await writeIn('galleries/10/01.jpg'); // a real gallery (control)
		await writeIn('galleries/10/10.mp3');
		const items = await scanVideos(dir, true);
		expect(items.map((i) => i.name)).toEqual(['10']); // only the real gallery survives
		expect(byName(items, '10')?.audio?.name).toBe('10.mp3');
	});

	it('a nested subdir with a non-id name (ID_RE fail) is skipped', async () => {
		await writeIn('galleries/a.b/01.jpg'); // dot in id → ID_RE rejects
		const items = await scanVideos(dir, true);
		expect(items).toEqual([]);
	});

	it('AC13: a pure-flat library is unaffected (no galleries//videos/ → pre-v0.14.0 behavior)', async () => {
		await write('a.mp4');
		await write('7_01.jpg');
		await write('7_02.jpg');
		const items = await scanVideos(dir, true);
		expect(items.map((i) => i.name).sort()).toEqual(['7', 'a.mp4']);
	});
});

describe('resolveMediaCandidates (v0.14.0 layout-agnostic serve resolution)', () => {
	const R = () => path.resolve(dir);

	it('frame name → root, galleries-flat, nested (probe order: root first)', () => {
		expect(resolveMediaCandidates('7_01.jpg', dir)).toEqual([
			path.join(R(), '7_01.jpg'),
			path.join(R(), 'galleries', '7_01.jpg'),
			path.join(R(), 'galleries', '7', '01.jpg')
		]);
	});

	it('video name → root, videos/', () => {
		expect(resolveMediaCandidates('7.mp4', dir)).toEqual([
			path.join(R(), '7.mp4'),
			path.join(R(), 'videos', '7.mp4')
		]);
	});

	it('soundtrack name → root, galleries-flat, nested-in-dir', () => {
		expect(resolveMediaCandidates('7.m4a', dir)).toEqual([
			path.join(R(), '7.m4a'),
			path.join(R(), 'galleries', '7.m4a'),
			path.join(R(), 'galleries', '7', '7.m4a')
		]);
	});

	it('single image name → root, galleries-flat', () => {
		expect(resolveMediaCandidates('7.jpg', dir)).toEqual([
			path.join(R(), '7.jpg'),
			path.join(R(), 'galleries', '7.jpg')
		]);
	});

	it('AC4/M1: rejects separators / traversal / NUL → [] (no candidate)', () => {
		expect(resolveMediaCandidates('../../etc/passwd', dir)).toEqual([]);
		expect(resolveMediaCandidates('a/b.jpg', dir)).toEqual([]);
		expect(resolveMediaCandidates('a\\b.jpg', dir)).toEqual([]);
		expect(resolveMediaCandidates('..', dir)).toEqual([]);
		expect(resolveMediaCandidates('foo\0.jpg', dir)).toEqual([]);
		expect(resolveMediaCandidates('', dir)).toEqual([]);
	});

	it('AC4: every candidate stays strictly under the root', () => {
		const root = path.resolve(dir);
		for (const name of ['7_01.jpg', '7.mp4', '7.m4a', '7.jpg', 'abc123.webm', 'note.txt']) {
			for (const c of resolveMediaCandidates(name, dir)) {
				expect(c === root || c.startsWith(root + path.sep)).toBe(true);
			}
		}
	});

	it('unknown shape → root candidate only', () => {
		expect(resolveMediaCandidates('note.txt', dir)).toEqual([path.join(R(), 'note.txt')]);
	});
});
