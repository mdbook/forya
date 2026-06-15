// Share-link store (0.8.4, scheme B) — the security-critical capability store. Mirrors
// hidden/starred's load-bearing proofs (default-off containment, serialized write-queue,
// atomic write, persistence, never-throws) PLUS the share-specific security properties:
// CSPRNG unguessable tokens, lookup-resolve that returns null on miss (uniform-404 source),
// owner-scoped dedup (the ownership scaffold), and proper per-link revoke.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
	clearShareCache,
	mintShare,
	resolveShare,
	revokeShare,
	readShares,
	shareEnabled,
	sharePath,
	warmShare
} from '../src/lib/server/share';
import { SHARED_OWNER } from '../src/lib/server/owner';

afterEach(() => clearShareCache());

describe('shareEnabled / sharePath (pure)', () => {
	it('disabled (dataDir empty) → not enabled, null path', () => {
		expect(shareEnabled('')).toBe(false);
		expect(sharePath('')).toBeNull();
	});
	it('enabled → share.json directly under dataDir', () => {
		expect(shareEnabled('/data')).toBe(true);
		expect(sharePath('/data')).toBe(path.join(path.resolve('/data'), 'share.json'));
	});
});

describe('share store — DEFAULT-OFF HARD-PROOF (containment)', () => {
	it('disabled store makes ZERO fs calls even with a writable data dir present', async () => {
		const present = await fsp.mkdtemp(path.join(os.tmpdir(), 'forya-share-present-'));
		const spies = {
			mkdir: vi.spyOn(fsp, 'mkdir'),
			writeFile: vi.spyOn(fsp, 'writeFile'),
			rename: vi.spyOn(fsp, 'rename'),
			readFile: vi.spyOn(fsp, 'readFile'),
			rm: vi.spyOn(fsp, 'rm')
		};
		try {
			expect(await mintShare('clip.mp4')).toBe(''); // disabled → '' (no token)
			expect(await resolveShare('anything')).toBeNull();
			expect(await revokeShare('anything')).toBe(false);
			await warmShare();
			for (const [name, spy] of Object.entries(spies)) {
				expect(spy, `fsp.${name} must not run when disabled`).not.toHaveBeenCalled();
			}
			expect(await fsp.readdir(present)).toEqual([]);
		} finally {
			vi.restoreAllMocks();
			await fsp.rm(present, { recursive: true, force: true });
		}
	});
});

describe('share store — mint / resolve / dedup / revoke', () => {
	let dir: string;
	beforeEach(async () => {
		dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'forya-share-'));
		clearShareCache();
	});
	afterEach(async () => {
		await fsp.rm(dir, { recursive: true, force: true });
	});

	it('mint → resolve round-trip (token resolves to the exact name + shared owner)', async () => {
		const tok = await mintShare('clip.mp4', SHARED_OWNER, dir);
		expect(tok).not.toBe('');
		expect(await resolveShare(tok, dir)).toEqual({ name: 'clip.mp4', owner: SHARED_OWNER });
		const files = await fsp.readdir(dir);
		expect(files).toContain('share.json');
		expect(files.every((f) => !f.includes('.tmp.'))).toBe(true); // atomic publish
	});

	it('tokens are unguessable CSPRNG: ≥256-bit base64url, distinct per clip', async () => {
		const a = await mintShare('a.mp4', SHARED_OWNER, dir);
		const b = await mintShare('b.mp4', SHARED_OWNER, dir);
		expect(a).not.toBe(b);
		// 32 random bytes → 43 base64url chars; assert ample entropy + url-safe charset.
		expect(a.length).toBeGreaterThanOrEqual(43);
		expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
	});

	it('dedup: re-minting the same (name, owner) returns the SAME token (durable link)', async () => {
		const t1 = await mintShare('clip.mp4', SHARED_OWNER, dir);
		const t2 = await mintShare('clip.mp4', SHARED_OWNER, dir);
		expect(t2).toBe(t1);
		expect((await readShares(SHARED_OWNER, dir)).length).toBe(1); // not duplicated
	});

	it('owner-scoped: the SAME name under different owners → different tokens (scaffold)', async () => {
		const shared = await mintShare('clip.mp4', SHARED_OWNER, dir);
		const alice = await mintShare('clip.mp4', 'alice', dir);
		expect(alice).not.toBe(shared);
		expect(await resolveShare(alice, dir)).toEqual({ name: 'clip.mp4', owner: 'alice' });
		expect((await readShares('alice', dir)).map((r) => r.name)).toEqual(['clip.mp4']);
		expect((await readShares(SHARED_OWNER, dir)).map((r) => r.name)).toEqual(['clip.mp4']);
	});

	it('resolve of an unknown token → null (uniform-404 source, no oracle)', async () => {
		expect(await resolveShare('totally-made-up-token', dir)).toBeNull();
		expect(await resolveShare('', dir)).toBeNull();
	});

	it('revoke: per-link, immediate, proper — the token resolves null afterward', async () => {
		const tok = await mintShare('clip.mp4', SHARED_OWNER, dir);
		expect(await revokeShare(tok, dir)).toBe(true);
		expect(await resolveShare(tok, dir)).toBeNull();
		expect(await revokeShare(tok, dir)).toBe(false); // already gone → no-op
		// a fresh mint after revoke yields a NEW token (the old one stays dead)
		const tok2 = await mintShare('clip.mp4', SHARED_OWNER, dir);
		expect(tok2).not.toBe(tok);
	});

	it('persists across a cache drop (reload from disk); corrupt/missing → empty, never throws', async () => {
		const tok = await mintShare('persist.mp4', SHARED_OWNER, dir);
		clearShareCache();
		expect(await resolveShare(tok, dir)).toEqual({ name: 'persist.mp4', owner: SHARED_OWNER });
		clearShareCache();
		await fsp.writeFile(path.join(dir, 'share.json'), '{ not valid json');
		expect(await resolveShare(tok, dir)).toBeNull(); // corrupt → empty store, no throw
	});

	it('serialized write-queue: concurrent mints of distinct names all survive', async () => {
		const names = Array.from({ length: 20 }, (_, i) => `clip${i}.mp4`);
		const toks = await Promise.all(names.map((n) => mintShare(n, SHARED_OWNER, dir)));
		expect(new Set(toks).size).toBe(20); // all distinct, none lost
		clearShareCache();
		const back = await Promise.all(toks.map((t) => resolveShare(t, dir)));
		expect(back.map((r) => r?.name).sort()).toEqual([...names].sort());
	});

	it('a mint racing the boot warm is not clobbered (adversarial #4 compare-and-set)', async () => {
		await mintShare('seed.mp4', SHARED_OWNER, dir);
		clearShareCache();
		const warm = warmShare(dir);
		const tok = await mintShare('raced.mp4', SHARED_OWNER, dir);
		await warm;
		expect(await resolveShare(tok, dir)).toEqual({ name: 'raced.mp4', owner: SHARED_OWNER });
		clearShareCache();
		expect((await readShares(SHARED_OWNER, dir)).map((r) => r.name).sort()).toEqual([
			'raced.mp4',
			'seed.mp4'
		]);
	});
});
