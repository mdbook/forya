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
