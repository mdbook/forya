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
	readStarredOrdered,
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

	it('preserves insertion order on disk (newest-first source); readStarred stays sorted', async () => {
		await setStarred('z.mp4', true, dir);
		await setStarred('a.mp4', true, dir);
		await setStarred('m.mp4', true, dir);
		// readStarredOrdered = insertion order — the 0.9.0 view reverses this for newest-first.
		expect(await readStarredOrdered(dir)).toEqual(['z.mp4', 'a.mp4', 'm.mp4']);
		// readStarred stays sorted (the GET seed is order-agnostic — a client Set).
		expect(await readStarred(dir)).toEqual(['a.mp4', 'm.mp4', 'z.mp4']);
		// order survives a cache drop (read back from disk, not just the in-mem Set).
		clearStarredCache();
		expect(await readStarredOrdered(dir)).toEqual(['z.mp4', 'a.mp4', 'm.mp4']);
	});

	it('idempotent re-mark does NOT bump order; unlike→re-like appends as newest', async () => {
		await setStarred('first.mp4', true, dir);
		await setStarred('second.mp4', true, dir);
		await setStarred('first.mp4', true, dir); // re-mark existing → Set no-op, no reorder
		expect(await readStarredOrdered(dir)).toEqual(['first.mp4', 'second.mp4']);
		await setStarred('first.mp4', false, dir);
		await setStarred('first.mp4', true, dir); // unlike→re-like → appended at the end
		expect(await readStarredOrdered(dir)).toEqual(['second.mp4', 'first.mp4']);
	});

	it('a read racing a write is NOT clobbered (adversarial #4 — no durable loss)', async () => {
		// Pre-existing on disk; cold cache (fresh process). starred has no boot-warm lane, so the
		// UNSERIALIZED reader here is readStarred (the SSR/GET seed) racing a setStarred write —
		// both enter loadSet with a null cache and read disk. We GATE the reader's disk read so it
		// captures the stale {keep} bytes but RESOLVES last, after the write has already persisted
		// {keep,raced} and populated the cache. Pre-fix, loadSet's unconditional `cache = {...}`
		// then overwrites the fresher cache with the stale snapshot, and the NEXT write persists
		// the gap (durable loss of 'raced'). Post-fix, the compare-and-set adopts the fresher cache.
		await setStarred('keep.mp4', true, dir); // disk = {keep}
		clearStarredCache();

		const realReadFile = fsp.readFile.bind(fsp) as (...a: unknown[]) => Promise<unknown>;
		let releaseReader!: () => void;
		const readerGate = new Promise<void>((r) => (releaseReader = r));
		let call = 0;
		const spy = vi.spyOn(fsp, 'readFile').mockImplementation((async (...args: unknown[]) => {
			call++;
			if (call === 1) {
				const stale = await realReadFile(...args); // read the current (stale {keep}) bytes NOW
				await readerGate; // ...but hold RESOLUTION until the write has landed
				return stale;
			}
			return realReadFile(...args);
		}) as typeof fsp.readFile);

		try {
			const read = readStarred(dir); // call 1 → reads stale {keep}, gated open
			const write = setStarred('raced.mp4', true, dir); // call 2 → {keep}+raced, persists, cache={keep,raced}
			await write; // writer fully done first (cache + disk hold raced)
			releaseReader(); // now let the stale reader resolve + do its `cache =` assignment
			await read;
		} finally {
			spy.mockRestore();
		}

		// In-mem cache must still hold BOTH (the reader must not have clobbered raced away).
		expect(await readStarred(dir)).toEqual(['keep.mp4', 'raced.mp4']);
		// Durable: a subsequent write must not have dropped the raced name from disk.
		await setStarred('after.mp4', true, dir);
		clearStarredCache();
		expect(await readStarred(dir)).toEqual(['after.mp4', 'keep.mp4', 'raced.mp4']);
	});

	it('a missing or corrupt starred.json reads back as [] (never throws)', async () => {
		expect(await readStarred(dir)).toEqual([]); // missing file
		clearStarredCache();
		await fsp.writeFile(path.join(dir, 'starred.json'), '{ not valid json');
		expect(await readStarred(dir)).toEqual([]); // corrupt → empty, no throw
	});
});
