// Background generation worker (0.5/M4). Tests the queue/single-flight/disabled
// logic with mocked runners + an explicit dataDir — no real ffmpeg, no flakiness.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { _resetWorker, _whenIdle, enqueueGeneration } from '../src/lib/server/worker';
import { readMeta, type ProbeRunner } from '../src/lib/server/probe';
import { readPoster, type PosterRunner } from '../src/lib/server/poster';

const PROBE_JSON = JSON.stringify({
	streams: [{ width: 1080, height: 1920 }],
	format: { duration: '5' }
});
const JPEG = Buffer.concat([
	Buffer.from([0xff, 0xd8]),
	Buffer.from('x'),
	Buffer.from([0xff, 0xd9])
]);

describe('worker — enqueueGeneration', () => {
	let dir: string;
	beforeEach(async () => {
		_resetWorker();
		dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'forya-worker-'));
	});
	afterEach(async () => {
		await fsp.rm(dir, { recursive: true, force: true });
	});

	it('disabled (posters off) → no enqueue, no generation', async () => {
		const m: ProbeRunner = vi.fn(async () => PROBE_JSON);
		// Gated on the POSTERS feature now (0.8.0), not the bare volume — so even with a
		// DATA_DIR present, POSTERS off → no enqueue, no ffmpeg.
		expect(
			enqueueGeneration('a.mp4', 1, '/x', { dataDir: dir, postersEnabled: false, metaRunner: m })
		).toBe(false);
		expect(m).not.toHaveBeenCalled();
	});

	it('generates metadata + poster for a video', async () => {
		const m: ProbeRunner = vi.fn(async () => PROBE_JSON);
		const p: PosterRunner = vi.fn(async () => JPEG);
		expect(
			enqueueGeneration('a.mp4', 1, '/srv/a.mp4', {
				dataDir: dir,
				postersEnabled: true,
				metaRunner: m,
				posterRunner: p
			})
		).toBe(true);
		await _whenIdle();
		expect(await readMeta('a.mp4', 1, dir)).toEqual({ width: 1080, height: 1920, duration: 5 });
		expect(await readPoster('a.mp4', 1, dir)).not.toBeNull();
		expect(m).toHaveBeenCalledOnce();
		expect(p).toHaveBeenCalledOnce();
	});

	it('single-flights duplicate enqueues for the same key (one generation)', async () => {
		const m: ProbeRunner = vi.fn(async () => PROBE_JSON);
		const p: PosterRunner = vi.fn(async () => JPEG);
		const opts = { dataDir: dir, postersEnabled: true, metaRunner: m, posterRunner: p };
		expect(enqueueGeneration('a.mp4', 1, '/x', opts)).toBe(true);
		expect(enqueueGeneration('a.mp4', 1, '/x', opts)).toBe(false); // already pending
		await _whenIdle();
		expect(m).toHaveBeenCalledOnce();
		expect(p).toHaveBeenCalledOnce();
	});

	it('a changed mtime is a distinct job, not deduped', async () => {
		const m: ProbeRunner = vi.fn(async () => PROBE_JSON);
		const p: PosterRunner = vi.fn(async () => JPEG);
		const opts = { dataDir: dir, postersEnabled: true, metaRunner: m, posterRunner: p };
		enqueueGeneration('a.mp4', 1, '/x', opts);
		enqueueGeneration('a.mp4', 2, '/x', opts);
		await _whenIdle();
		expect(p).toHaveBeenCalledTimes(2);
		expect(await readPoster('a.mp4', 1, dir)).not.toBeNull();
		expect(await readPoster('a.mp4', 2, dir)).not.toBeNull();
	});

	it('processes multiple distinct videos serially', async () => {
		const m: ProbeRunner = vi.fn(async () => PROBE_JSON);
		const p: PosterRunner = vi.fn(async () => JPEG);
		const opts = { dataDir: dir, postersEnabled: true, metaRunner: m, posterRunner: p };
		enqueueGeneration('a.mp4', 1, '/a', opts);
		enqueueGeneration('b.mp4', 1, '/b', opts);
		await _whenIdle();
		expect(await readPoster('a.mp4', 1, dir)).not.toBeNull();
		expect(await readPoster('b.mp4', 1, dir)).not.toBeNull();
		expect(p).toHaveBeenCalledTimes(2);
	});
});
