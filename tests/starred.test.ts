// starred (0.8.0) — the forya-internal favorite-mark store. Two load-bearing
// proofs mirror dataCache's discipline: (1) DEFAULT-OFF containment — disabled, the
// store makes ZERO fs calls even with a writable data dir present (gates on the env
// var, not on whether the dir exists); (2) the serialized write-queue never loses a
// concurrent toggle. Plus atomic-write, idempotency, and persistence round-trips.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
	clearStarredCache,
	readStarred,
	setStarred,
	starredEnabled,
	starredPath
} from '../src/lib/server/starred';

// In the test env DATA_DIR is unset, so config.dataDir is '' — the default-off path
// is what setStarred/readStarred hit unless we pass an explicit dataDir.
afterEach(() => clearStarredCache());

describe('starredEnabled / starredPath (pure)', () => {
	it('disabled (dataDir empty) → not enabled, null path', () => {
		expect(starredEnabled('')).toBe(false);
		expect(starredPath('')).toBeNull();
	});

	it('enabled → starred.json directly under dataDir', () => {
		expect(starredEnabled('/data')).toBe(true);
		const p = starredPath('/data');
		expect(p).toBe(path.join(path.resolve('/data'), 'starred.json'));
		expect(path.dirname(p!)).toBe(path.resolve('/data'));
	});
});

describe('starred — DEFAULT-OFF HARD-PROOF (containment)', () => {
	it('disabled store makes ZERO fs calls even with a writable data dir present', async () => {
		// A writable "/data" exists on disk...
		const present = await fsp.mkdtemp(path.join(os.tmpdir(), 'forya-starred-present-'));
		// ...but the feature is OFF (config.dataDir === '' in the test env), so the
		// store must touch NOTHING — not `present`, not anywhere.
		const spies = {
			mkdir: vi.spyOn(fsp, 'mkdir'),
			writeFile: vi.spyOn(fsp, 'writeFile'),
			rename: vi.spyOn(fsp, 'rename'),
			readFile: vi.spyOn(fsp, 'readFile'),
			rm: vi.spyOn(fsp, 'rm')
		};
		try {
			expect(await setStarred('clip.mp4', true)).toBe(false); // disabled → no-op false
			expect(await readStarred()).toEqual([]);
			for (const [name, spy] of Object.entries(spies)) {
				expect(spy, `fsp.${name} must not be called when disabled`).not.toHaveBeenCalled();
			}
			expect(await fsp.readdir(present)).toEqual([]); // nothing written anywhere
		} finally {
			vi.restoreAllMocks();
			await fsp.rm(present, { recursive: true, force: true });
		}
	});
});

describe('starred — enabled round-trip (explicit dataDir)', () => {
	let dir: string;
	beforeEach(async () => {
		dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'forya-starred-'));
		clearStarredCache();
	});
	afterEach(async () => {
		await fsp.rm(dir, { recursive: true, force: true });
	});

	it('marks, persists atomically (no leftover tmp), and reads back sorted', async () => {
		expect(await setStarred('b.mov', true, dir)).toBe(true);
		expect(await setStarred('a.mp4', true, dir)).toBe(true);
		expect(await readStarred(dir)).toEqual(['a.mp4', 'b.mov']); // sorted
		const files = await fsp.readdir(dir);
		expect(files).toContain('starred.json');
		expect(files.every((f) => !f.includes('.tmp.'))).toBe(true); // atomic publish
	});

	it('unmark removes; PUT/DELETE are idempotent (no double-flip, no throw)', async () => {
		await setStarred('x.mp4', true, dir);
		expect(await setStarred('x.mp4', true, dir)).toBe(true); // re-mark = idempotent
		expect(await readStarred(dir)).toEqual(['x.mp4']); // still one entry
		expect(await setStarred('x.mp4', false, dir)).toBe(false); // unmark
		expect(await setStarred('x.mp4', false, dir)).toBe(false); // re-unmark = no-op
		expect(await readStarred(dir)).toEqual([]);
	});

	it('the serialized write-queue never loses a concurrent toggle', async () => {
		const names = Array.from({ length: 25 }, (_, i) => `clip${i}.mp4`);
		// Fire all marks concurrently — a naive read-modify-write would clobber, but
		// the single write-queue serializes them so every mark survives.
		await Promise.all(names.map((n) => setStarred(n, true, dir)));
		clearStarredCache(); // force a fresh load from disk
		expect((await readStarred(dir)).sort()).toEqual([...names].sort());
	});

	it('survives a cache drop — the set is read back from disk', async () => {
		await setStarred('persist.mp4', true, dir);
		clearStarredCache();
		expect(await readStarred(dir)).toEqual(['persist.mp4']);
	});

	it('a missing or corrupt starred.json reads back as [] (never throws)', async () => {
		expect(await readStarred(dir)).toEqual([]); // missing file
		clearStarredCache();
		await fsp.writeFile(path.join(dir, 'starred.json'), '{ not valid json');
		expect(await readStarred(dir)).toEqual([]); // corrupt → empty, no throw
	});
});
