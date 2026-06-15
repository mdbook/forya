// POSTERS / DATA_DIR decoupling (0.8.0) — the containment proof for the 0.7.0
// guard. The HARD invariant: a feed with a DATA_DIR (for `starred`) but POSTERS OFF
// must behave EXACTLY like a 0.7.0 cheap-scan feed plus starred — zero ffmpeg/
// ffprobe, identity feed payload, cheap readdir-only scan — so adding a volume for
// `starred` can NEVER silently undo the 0.7.0 perf win nor storm poster generation.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { _resetWorker, _whenIdle, enqueueGeneration } from '../src/lib/server/worker';
import { enrichItems, type ProbeRunner } from '../src/lib/server/probe';
import { clearScanCache, scanVideos } from '../src/lib/server/videos';
import type { PosterRunner } from '../src/lib/server/poster';
import type { FeedItem } from '../src/lib/types';

// config reads process.env ONCE at import — so to exercise the gate derivation we
// stub the env and re-import a fresh config module per case.
async function loadConfig(dataDir: string, posters: string) {
	vi.resetModules();
	vi.stubEnv('DATA_DIR', dataDir);
	vi.stubEnv('POSTERS', posters);
	return (await import('../src/lib/server/config')).config;
}

describe('config gate derivation — DATA_DIR is the volume, POSTERS is the opt-in', () => {
	afterEach(() => {
		vi.unstubAllEnvs();
		vi.resetModules();
	});

	it('DATA_DIR set + POSTERS unset → posters OFF, starred ON (the decoupling)', async () => {
		const config = await loadConfig('/data', '');
		expect(config.dataDir).toBe('/data');
		expect(config.posters).toBe(false); // a volume alone does NOT turn posters on
		expect(config.starred).toBe(true); // …but starred only needs the volume
	});

	it('DATA_DIR set + POSTERS truthy → posters ON', async () => {
		const config = await loadConfig('/data', '1');
		expect(config.posters).toBe(true);
		expect(config.starred).toBe(true);
	});

	it('DATA_DIR set + POSTERS explicitly off → posters OFF', async () => {
		expect((await loadConfig('/data', '0')).posters).toBe(false);
		expect((await loadConfig('/data', 'false')).posters).toBe(false);
		expect((await loadConfig('/data', 'off')).posters).toBe(false);
	});

	it('no DATA_DIR → posters OFF and starred OFF even if POSTERS is set (volume is the prereq)', async () => {
		const config = await loadConfig('', '1');
		expect(config.dataDir).toBe('');
		expect(config.posters).toBe(false); // POSTERS needs a volume to mean anything
		expect(config.starred).toBe(false);
	});
});

describe('config shareBase store-gating (0.8.4) — advertise minting only with an operational store', () => {
	afterEach(() => {
		vi.unstubAllEnvs();
		vi.resetModules();
	});

	async function loadShare(dataDir: string, shareBase: string) {
		vi.resetModules();
		vi.stubEnv('DATA_DIR', dataDir);
		vi.stubEnv('PUBLIC_SHARE_BASE', shareBase);
		return (await import('../src/lib/server/config')).config;
	}

	// Operator requirement (0.8.4): no persistent storage ⇒ `share()` falls back to the direct
	// (LAN) URL, NEVER a half-enabled mint. A `PUBLIC_SHARE_BASE` set without a `DATA_DIR` must
	// NOT make the client advertise minting against a disabled mint route.
	it('PUBLIC_SHARE_BASE set but NO DATA_DIR → share OFF + shareBase EMPTY (client stays on the direct URL)', async () => {
		const config = await loadShare('', 'https://share.example');
		expect(config.share).toBe(false);
		expect(config.shareBase).toBe('');
	});

	it('DATA_DIR + PUBLIC_SHARE_BASE → share ON + shareBase carries through (mint enabled)', async () => {
		const config = await loadShare('/data', 'https://share.example');
		expect(config.share).toBe(true);
		expect(config.shareBase).toBe('https://share.example');
	});

	it('DATA_DIR but NO PUBLIC_SHARE_BASE → share ON, shareBase empty (mint would use the request origin; client stays on the direct URL)', async () => {
		const config = await loadShare('/data', '');
		expect(config.share).toBe(true);
		expect(config.shareBase).toBe('');
	});
});

describe('POSTERS off + DATA_DIR present → 0.7.0 behaviour retained', () => {
	let dir: string;
	beforeEach(async () => {
		_resetWorker();
		clearScanCache();
		dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'forya-gating-'));
	});
	afterEach(async () => {
		await fsp.rm(dir, { recursive: true, force: true });
	});

	it('enqueueGeneration is a no-op → ZERO ffmpeg/ffprobe spawns', async () => {
		const m: ProbeRunner = vi.fn(async () => '{}');
		const p: PosterRunner = vi.fn(async () => Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
		// DATA_DIR present (dir) but POSTERS off → must not generate.
		expect(
			enqueueGeneration('a.mp4', 1, '/srv/a.mp4', {
				dataDir: dir,
				postersEnabled: false,
				metaRunner: m,
				posterRunner: p
			})
		).toBe(false);
		await _whenIdle();
		expect(m).not.toHaveBeenCalled();
		expect(p).not.toHaveBeenCalled();
	});

	it('enrichItems is identity → byte-identical feed payload (zero cache read)', async () => {
		const items: FeedItem[] = [{ name: 'a.mp4', url: '/api/media/a.mp4', type: 'video/mp4' }];
		// DATA_DIR present but POSTERS off → same array reference back, no meta read.
		expect(await enrichItems(items, dir, false)).toBe(items);
	});

	it('cheap scan retained → readdir-only, no per-file stat (size/mtime undefined)', async () => {
		await fsp.writeFile(path.join(dir, 'b.mp4'), Buffer.alloc(20));
		await fsp.writeFile(path.join(dir, 'a.mp4'), Buffer.alloc(10));
		// cheap = !postersEnabled; POSTERS off → cheap → the 0.7.0 readdir-only path.
		const items = await scanVideos(dir, true, true);
		expect(items.map((i) => i.name)).toEqual(['a.mp4', 'b.mp4']); // name-asc, no stat
		expect(items[0].size).toBeUndefined();
		expect(items[0].mtime).toBeUndefined();
	});
});
