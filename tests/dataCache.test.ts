// dataCache (0.5 M1) — the optional generated-artifact cache. The load-bearing
// test is the DEFAULT-OFF HARD-PROOF: with the feature disabled, the cache makes
// ZERO filesystem calls, even with a writable data dir present — containment
// keys on the env var (config.dataDir), never on whether /data exists.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { cacheEnabled, cachePath, readCache, writeCache } from '../src/lib/server/dataCache';

// In the test env `DATA_DIR` is unset, so the real config.dataDir is '' — i.e.
// the default-off path is what readCache/writeCache hit unless we pass an
// explicit dataDir. (config reads process.env at import; we don't fight that —
// the path core is pure and takes dataDir explicitly.)

describe('cacheEnabled / cachePath (pure)', () => {
	it('disabled (dataDir empty) → not enabled, null path', () => {
		expect(cacheEnabled('')).toBe(false);
		expect(cachePath('', 'posters', 'clip.mp4', 123, 'jpg')).toBeNull();
	});

	it('enabled → a path under dataDir/kind, mtime + ext in the filename', () => {
		const p = cachePath('/data', 'posters', 'clip.mp4', 1700000000123, 'jpg');
		expect(p).not.toBeNull();
		expect(p!.startsWith(path.resolve('/data', 'posters') + path.sep)).toBe(true);
		expect(p!.endsWith('.1700000000123.jpg')).toBe(true);
	});

	it('a changed source mtime yields a different cache path (self-invalidation)', () => {
		const a = cachePath('/data', 'meta', 'clip.mp4', 1, 'json');
		const b = cachePath('/data', 'meta', 'clip.mp4', 2, 'json');
		expect(a).not.toBe(b);
	});

	it('never escapes dataDir/kind even for a hostile name (hex-encoded)', () => {
		const p = cachePath('/data', 'posters', '../../etc/passwd', 1, 'jpg');
		expect(p).not.toBeNull();
		expect(path.dirname(p!)).toBe(path.resolve('/data', 'posters'));
	});
});

describe('dataCache — DEFAULT-OFF HARD-PROOF (M1 containment)', () => {
	it('disabled cache makes ZERO fs calls even with a writable data dir present', async () => {
		// A writable "/data" exists on disk...
		const present = await fsp.mkdtemp(path.join(os.tmpdir(), 'forya-data-present-'));
		// ...but the feature is OFF (config.dataDir === '' in the test env), so the
		// cache must touch NOTHING — not `present`, not anywhere.
		const spies = {
			mkdir: vi.spyOn(fsp, 'mkdir'),
			writeFile: vi.spyOn(fsp, 'writeFile'),
			rename: vi.spyOn(fsp, 'rename'),
			readFile: vi.spyOn(fsp, 'readFile'),
			rm: vi.spyOn(fsp, 'rm')
		};
		try {
			await writeCache('posters', 'clip.mp4', 123, 'jpg', Buffer.from('poster-bytes'));
			expect(await readCache('posters', 'clip.mp4', 123, 'jpg')).toBeNull();
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

describe('dataCache — enabled round-trip (explicit dataDir)', () => {
	let dir: string;
	beforeEach(async () => {
		dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'forya-data-'));
	});
	afterEach(async () => {
		await fsp.rm(dir, { recursive: true, force: true });
	});

	it('writes atomically (no leftover tmp) and reads back', async () => {
		await writeCache('meta', 'clip.mp4', 5, 'json', Buffer.from('{"d":1}'), undefined, dir);
		const got = await readCache('meta', 'clip.mp4', 5, 'json', dir);
		expect(got?.toString()).toBe('{"d":1}');
		const files = await fsp.readdir(path.join(dir, 'meta'));
		expect(files.every((f) => !f.includes('.tmp.'))).toBe(true); // atomic publish
	});

	it('a changed source mtime misses the stale entry', async () => {
		await writeCache('posters', 'clip.mp4', 1, 'jpg', Buffer.from('old'), undefined, dir);
		expect(await readCache('posters', 'clip.mp4', 2, 'jpg', dir)).toBeNull();
	});

	it('never publishes an empty buffer or one that fails validate', async () => {
		await writeCache('posters', 'a.mp4', 1, 'jpg', Buffer.alloc(0), undefined, dir);
		expect(await readCache('posters', 'a.mp4', 1, 'jpg', dir)).toBeNull();
		await writeCache('posters', 'b.mp4', 1, 'jpg', Buffer.from('x'), () => false, dir);
		expect(await readCache('posters', 'b.mp4', 1, 'jpg', dir)).toBeNull();
		await writeCache('posters', 'c.mp4', 1, 'jpg', Buffer.from('ok'), (b) => b.length > 0, dir);
		expect((await readCache('posters', 'c.mp4', 1, 'jpg', dir))?.toString()).toBe('ok');
	});

	it('a 0-byte cache file reads back as null (corrupt → regenerate)', async () => {
		const p = cachePath(dir, 'meta', 'z.mp4', 9, 'json')!;
		await fsp.mkdir(path.dirname(p), { recursive: true });
		await fsp.writeFile(p, Buffer.alloc(0));
		expect(await readCache('meta', 'z.mp4', 9, 'json', dir)).toBeNull();
	});
});
