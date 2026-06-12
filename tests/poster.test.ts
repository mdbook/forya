// poster generation (0.5/M3). ffmpeg is behind a mockable runner so CI needs no
// binary. Posters are validated as real JPEGs (SOI..EOI) before they're ever
// cached or served, and nothing spawns/writes when the feature is off.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { generatePoster, isJpeg, readPoster, type PosterRunner } from '../src/lib/server/poster';

const JPEG = Buffer.concat([
	Buffer.from([0xff, 0xd8]),
	Buffer.from('frame'),
	Buffer.from([0xff, 0xd9])
]);

describe('isJpeg (pure)', () => {
	it('accepts a SOI..EOI buffer, rejects others', () => {
		expect(isJpeg(JPEG)).toBe(true);
		expect(isJpeg(Buffer.from('not a jpeg'))).toBe(false);
		expect(isJpeg(Buffer.from([0xff, 0xd8]))).toBe(false); // too short / no EOI
		expect(isJpeg(Buffer.alloc(0))).toBe(false);
	});
});

describe('generatePoster + readPoster (mocked runner, explicit dataDir)', () => {
	let dir: string;
	beforeEach(async () => {
		dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'forya-poster-'));
	});
	afterEach(async () => {
		await fsp.rm(dir, { recursive: true, force: true });
	});

	it('generates, caches, and reads back a JPEG', async () => {
		const runner: PosterRunner = vi.fn(async () => JPEG);
		expect(await generatePoster('clip.mp4', 3, '/srv/videos/clip.mp4', runner, dir)).toBe(true);
		expect(runner).toHaveBeenCalledOnce();
		const got = await readPoster('clip.mp4', 3, dir);
		expect(got && isJpeg(got)).toBe(true);
		// changed source mtime → cache miss
		expect(await readPoster('clip.mp4', 4, dir)).toBeNull();
	});

	it('disabled (dataDir empty) → no spawn, false', async () => {
		const runner: PosterRunner = vi.fn(async () => JPEG);
		expect(await generatePoster('clip.mp4', 3, '/x', runner, '')).toBe(false);
		expect(runner).not.toHaveBeenCalled();
	});

	it('a runner failure → false, nothing cached', async () => {
		const runner: PosterRunner = vi.fn(async () => {
			throw new Error('ffmpeg missing');
		});
		expect(await generatePoster('clip.mp4', 3, '/x', runner, dir)).toBe(false);
		expect(await readPoster('clip.mp4', 3, dir)).toBeNull();
	});

	it('a non-JPEG payload is never cached (validate-before-publish)', async () => {
		const runner: PosterRunner = async () => Buffer.from('garbage');
		expect(await generatePoster('clip.mp4', 3, '/x', runner, dir)).toBe(false);
		expect(await readPoster('clip.mp4', 3, dir)).toBeNull();
	});
});
