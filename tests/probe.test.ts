// probe / metadata enrichment (0.5/M2). The ffprobe spawn is behind a mockable
// runner, so these tests never touch a real ffprobe and CI can't flake on it.
// The load-bearing guarantee: enrichItems is ADDITIVE and an identity no-op when
// the DATA_DIR feature is off (manifest byte-identical).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
	enrichItems,
	generateMeta,
	parseProbe,
	readMeta,
	type ProbeRunner
} from '../src/lib/server/probe';
import type { FeedItem } from '../src/lib/types';

const PROBE_JSON = JSON.stringify({
	streams: [{ width: 1080, height: 1920 }],
	format: { duration: '12.5' }
});

function item(name: string, mtime = 1): FeedItem {
	return { name, url: `/api/media/${name}`, size: 10, mtime, type: 'video/mp4' };
}

describe('parseProbe (pure)', () => {
	it('maps a valid ffprobe payload', () => {
		expect(parseProbe(PROBE_JSON)).toEqual({ width: 1080, height: 1920, duration: 12.5 });
	});
	it('returns null on bad JSON / missing or zero dims', () => {
		expect(parseProbe('not json')).toBeNull();
		expect(parseProbe('{}')).toBeNull();
		expect(parseProbe(JSON.stringify({ streams: [{ width: 0, height: 0 }] }))).toBeNull();
	});
	it('defaults a missing/unusable duration to 0', () => {
		expect(parseProbe(JSON.stringify({ streams: [{ width: 9, height: 16 }] }))).toEqual({
			width: 9,
			height: 16,
			duration: 0
		});
	});
});

describe('generateMeta + readMeta (mocked runner, explicit dataDir)', () => {
	let dir: string;
	beforeEach(async () => {
		dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'forya-meta-'));
	});
	afterEach(async () => {
		await fsp.rm(dir, { recursive: true, force: true });
	});

	it('probes, caches, and reads back', async () => {
		const runner: ProbeRunner = vi.fn(async () => PROBE_JSON);
		const meta = await generateMeta('clip.mp4', 7, '/srv/videos/clip.mp4', runner, dir);
		expect(meta).toEqual({ width: 1080, height: 1920, duration: 12.5 });
		expect(runner).toHaveBeenCalledOnce();
		expect(await readMeta('clip.mp4', 7, dir)).toEqual(meta);
		// a changed source mtime misses the stale cache
		expect(await readMeta('clip.mp4', 8, dir)).toBeNull();
	});

	it('disabled (dataDir empty) → no spawn, null', async () => {
		const runner: ProbeRunner = vi.fn(async () => PROBE_JSON);
		expect(await generateMeta('clip.mp4', 7, '/x', runner, '')).toBeNull();
		expect(runner).not.toHaveBeenCalled();
	});

	it('a runner failure degrades to null, writes nothing', async () => {
		const runner: ProbeRunner = vi.fn(async () => {
			throw new Error('ffprobe missing');
		});
		expect(await generateMeta('clip.mp4', 7, '/x', runner, dir)).toBeNull();
		expect(await readMeta('clip.mp4', 7, dir)).toBeNull();
	});
});

describe('enrichItems — additive + identity-when-disabled', () => {
	let dir: string;
	beforeEach(async () => {
		dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'forya-enrich-'));
	});
	afterEach(async () => {
		await fsp.rm(dir, { recursive: true, force: true });
	});

	it('disabled → returns the SAME array unchanged (byte-identical manifest)', async () => {
		const items = [item('a.mp4'), item('b.mp4')];
		const out = await enrichItems(items, '');
		expect(out).toBe(items); // identity — zero cache access, manifest untouched
	});

	it('enabled → ADDS width/height/duration for probed items only', async () => {
		const runner: ProbeRunner = async () => PROBE_JSON;
		await generateMeta('a.mp4', 1, '/x', runner, dir);
		const out = await enrichItems([item('a.mp4', 1), item('b.mp4', 1)], dir);
		// a.mp4 was probed → enriched; b.mp4 not → unchanged base shape
		expect(out[0]).toMatchObject({ name: 'a.mp4', width: 1080, height: 1920, duration: 12.5 });
		expect(out[1].width).toBeUndefined();
		expect(out[1].height).toBeUndefined();
		expect(out[1].duration).toBeUndefined();
		// existing fields never replaced/reordered
		expect(out[0]).toMatchObject({
			url: '/api/media/a.mp4',
			size: 10,
			mtime: 1,
			type: 'video/mp4'
		});
	});
});
