// Scan filters (extensions + hidden/.partial), mime mapping, mtime-desc order,
// path-traversal rejection, and deterministic seeded shuffle (SPEC §3).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
	clearScanCache,
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

	it('returns items with url/size/type and mtime-desc order', async () => {
		await write('old.mp4', 100);
		await write('new.mp4', 200);
		const oldPath = path.join(dir, 'old.mp4');
		const newPath = path.join(dir, 'new.mp4');
		await fsp.utimes(oldPath, new Date(1_000_000), new Date(1_000_000));
		await fsp.utimes(newPath, new Date(2_000_000), new Date(2_000_000));
		const items = await scanVideos(dir, true);
		expect(items.map((i) => i.name)).toEqual(['new.mp4', 'old.mp4']);
		const first = items[0];
		expect(first.url).toBe('/api/media/new.mp4');
		expect(first.size).toBe(200);
		expect(first.type).toBe('video/mp4');
		expect(typeof first.mtime).toBe('number');
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
