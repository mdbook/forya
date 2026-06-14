// hidden (server, 0.8.3) — the forya-internal SERVER-SIDE hide store
// (`src/lib/server/hidden.ts`), distinct from the client localStorage filter tested
// in hidden.test.ts. Mirrors starred's load-bearing proofs: (1) DEFAULT-OFF
// containment — disabled, ZERO fs calls even with a writable data dir present (gates
// on the env var, not on dir existence); (2) the serialized write-queue never loses
// a concurrent toggle; plus atomic-write, idempotency, persistence round-trips. ADDS
// the feed-exclusion contract: the SYNC reader (`hiddenSetSync`) reflects writes + is
// warmable (`warmHidden`) with no fs on the read path — that's what keeps the ~30ms
// cheap-scan feed exclusion free.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
	clearHiddenCache,
	hiddenEnabled,
	hiddenPath,
	hiddenSetSync,
	readHidden,
	setHidden,
	warmHidden
} from '../src/lib/server/hidden';

// In the test env DATA_DIR is unset, so config.dataDir is '' — the default-off path
// is what setHidden/readHidden/hiddenSetSync hit unless we pass an explicit dataDir.
afterEach(() => clearHiddenCache());

describe('hiddenEnabled / hiddenPath (pure)', () => {
	it('disabled (dataDir empty) → not enabled, null path', () => {
		expect(hiddenEnabled('')).toBe(false);
		expect(hiddenPath('')).toBeNull();
	});

	it('enabled → hidden.json directly under dataDir', () => {
		expect(hiddenEnabled('/data')).toBe(true);
		const p = hiddenPath('/data');
		expect(p).toBe(path.join(path.resolve('/data'), 'hidden.json'));
		expect(path.dirname(p!)).toBe(path.resolve('/data'));
	});
});

describe('hidden (server) — DEFAULT-OFF HARD-PROOF (containment)', () => {
	it('disabled store makes ZERO fs calls even with a writable data dir present', async () => {
		// A writable "/data" exists on disk...
		const present = await fsp.mkdtemp(path.join(os.tmpdir(), 'forya-hidden-present-'));
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
			expect(await setHidden('clip.mp4', true)).toBe(false); // disabled → no-op false
			expect(await readHidden()).toEqual([]);
			await warmHidden(); // disabled warm must also touch nothing
			expect(hiddenSetSync().size).toBe(0); // disabled → empty set
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

describe('hidden (server) — enabled round-trip (explicit dataDir)', () => {
	let dir: string;
	beforeEach(async () => {
		dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'forya-hidden-'));
		clearHiddenCache();
	});
	afterEach(async () => {
		await fsp.rm(dir, { recursive: true, force: true });
	});

	it('hides, persists atomically (no leftover tmp), and reads back sorted', async () => {
		expect(await setHidden('b.mov', true, dir)).toBe(true);
		expect(await setHidden('a.mp4', true, dir)).toBe(true);
		expect(await readHidden(dir)).toEqual(['a.mp4', 'b.mov']); // sorted
		const files = await fsp.readdir(dir);
		expect(files).toContain('hidden.json');
		expect(files.every((f) => !f.includes('.tmp.'))).toBe(true); // atomic publish
	});

	it('unhide removes; PUT/DELETE are idempotent (no double-flip, no throw)', async () => {
		await setHidden('x.mp4', true, dir);
		expect(await setHidden('x.mp4', true, dir)).toBe(true); // re-hide = idempotent
		expect(await readHidden(dir)).toEqual(['x.mp4']); // still one entry
		expect(await setHidden('x.mp4', false, dir)).toBe(false); // unhide
		expect(await setHidden('x.mp4', false, dir)).toBe(false); // re-unhide = no-op
		expect(await readHidden(dir)).toEqual([]);
	});

	it('the serialized write-queue never loses a concurrent toggle', async () => {
		const names = Array.from({ length: 25 }, (_, i) => `clip${i}.mp4`);
		// Fire all hides concurrently — a naive read-modify-write would clobber, but
		// the single write-queue serializes them so every hide survives.
		await Promise.all(names.map((n) => setHidden(n, true, dir)));
		clearHiddenCache(); // force a fresh load from disk
		expect((await readHidden(dir)).sort()).toEqual([...names].sort());
	});

	it('survives a cache drop — the set is read back from disk', async () => {
		await setHidden('persist.mp4', true, dir);
		clearHiddenCache();
		expect(await readHidden(dir)).toEqual(['persist.mp4']);
	});

	it('a missing or corrupt hidden.json reads back as [] (never throws)', async () => {
		expect(await readHidden(dir)).toEqual([]); // missing file
		clearHiddenCache();
		await fsp.writeFile(path.join(dir, 'hidden.json'), '{ not valid json');
		expect(await readHidden(dir)).toEqual([]); // corrupt → empty, no throw
	});
});

describe('hidden (server) — sync feed-exclusion reader (hiddenSetSync / warmHidden)', () => {
	let dir: string;
	beforeEach(async () => {
		dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'forya-hidden-sync-'));
		clearHiddenCache();
	});
	afterEach(async () => {
		await fsp.rm(dir, { recursive: true, force: true });
	});

	it('reflects a write synchronously (the feed read sees the new hidden name)', async () => {
		expect(hiddenSetSync(dir).has('gone.mp4')).toBe(false); // not yet warmed → empty
		await setHidden('gone.mp4', true, dir);
		// setHidden advances the in-mem cache inside its write chain, so the SYNC
		// reader (what /api/feed + +page.server use) sees it with no fs/await.
		expect(hiddenSetSync(dir).has('gone.mp4')).toBe(true);
		await setHidden('gone.mp4', false, dir);
		expect(hiddenSetSync(dir).has('gone.mp4')).toBe(false);
	});

	it('warmHidden populates the sync set from disk (boot-warm path)', async () => {
		await setHidden('warm.mp4', true, dir);
		clearHiddenCache(); // simulate a fresh process: cache empty, file on disk
		expect(hiddenSetSync(dir).size).toBe(0); // cold sync read → empty (best-effort)
		await warmHidden(dir); // boot warm
		expect(hiddenSetSync(dir).has('warm.mp4')).toBe(true); // now reflected, no fs on read
	});

	it('a cold sync read for the wrong/unknown dir is an empty set (never throws)', () => {
		expect(hiddenSetSync('/some/other/data').size).toBe(0);
		expect(hiddenSetSync('').size).toBe(0);
	});
});
