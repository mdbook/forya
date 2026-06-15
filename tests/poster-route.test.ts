// #3 (0.8.5): the poster route must key GENERATION on the file's AUTHORITATIVE mtime
// (the lstat `mtimeMs`), NOT the client-supplied `?v=`. The scan/probe path reads
// meta+poster back under the file's real mtime (probe.ts → readMeta(name, it.mtime)),
// so generating under a stale `?v=` (a re-encoded / re-synced clip) writes under the
// wrong key → permanent read-miss → CLS + imageless share cards. config reads env once
// at import, so we stub env + re-import the route per case (the gating.test.ts pattern).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { RequestHandler } from '@sveltejs/kit';

describe('poster route #3 — generation keys on the authoritative file mtime, not ?v=', () => {
	let dataDir: string;
	let videoDir: string;

	beforeEach(async () => {
		dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'forya-poster-data-'));
		videoDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'forya-poster-vids-'));
	});
	afterEach(async () => {
		vi.unstubAllEnvs();
		vi.resetModules();
		await fsp.rm(dataDir, { recursive: true, force: true });
		await fsp.rm(videoDir, { recursive: true, force: true });
	});

	function ev(name: string, v: number) {
		return {
			params: { name },
			url: new URL(`http://localhost/api/poster/${name}?v=${v}`)
		} as unknown as Parameters<RequestHandler>[0];
	}

	it('passes the file mtimeMs (NOT the stale client ?v=) to enqueueGeneration on a miss', async () => {
		// a real video file → a real lstat mtime that differs from the stale ?v=
		const file = path.join(videoDir, 'clip.mp4');
		await fsp.writeFile(file, Buffer.alloc(10));
		const realMtime = (await fsp.stat(file)).mtimeMs;

		vi.stubEnv('DATA_DIR', dataDir); // POSTERS feature needs a volume…
		vi.stubEnv('POSTERS', '1'); // …and the explicit opt-in
		vi.stubEnv('VIDEO_DIR', videoDir);
		vi.resetModules();

		// Spy on the worker's enqueueGeneration (no real ffmpeg). The route imports it
		// as a live ESM binding, so the spy on the module namespace is what it calls.
		const worker = await import('../src/lib/server/worker');
		const spy = vi.spyOn(worker, 'enqueueGeneration').mockReturnValue(false);

		const { GET } = await import('../src/routes/api/poster/[name]/+server');
		const staleV = 1; // a client `?v=` from an OLD manifest (≠ the re-encoded file's mtime)
		const res = await (GET as RequestHandler)(ev('clip.mp4', staleV));

		expect(res.status).toBe(204); // cache miss → placeholder (no poster yet)
		expect(spy).toHaveBeenCalledTimes(1);
		const [name, passedKey, passedPath] = spy.mock.calls[0];
		expect(name).toBe('clip.mp4');
		expect(passedKey).toBe(realMtime); // ★ the fix: generate under the authoritative file mtime
		expect(passedKey).not.toBe(staleV); // ★ NOT the stale client ?v= (the #3 bug)
		expect(passedPath).toBe(file);
	});
});
