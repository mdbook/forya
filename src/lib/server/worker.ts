// Background generation worker (0.5/M4) — the phase that turns posters/metadata
// ON. It generates a video's metadata + poster lazily so ffmpeg NEVER competes
// with serving:
//   - concurrency 1: one ffmpeg at a time (the `running` flag + serial loop)
//   - single-flight by output key (name+mtime): a duplicate enqueue is a no-op
//   - bounded: drop new jobs past MAX_QUEUE (backpressure)
//   - fire-and-forget: `enqueueGeneration` returns immediately; generation runs
//     OFF any request path (the ffmpeg spawn is never awaited in a handler)
//   - lazy: kicked by /api/poster on a cache MISS — there is NO boot bulk-encode
//   - no-op when POSTERS is off (0.8.0: the feature gate, not the bare volume)
import { config } from './config';
import { generateMeta, readMeta, type ProbeRunner } from './probe';
import { generatePoster, readPoster, type PosterRunner } from './poster';

interface GenOpts {
	dataDir?: string;
	/** Override the POSTERS-feature gate (default `config.posters`) — for tests. */
	postersEnabled?: boolean;
	metaRunner?: ProbeRunner;
	posterRunner?: PosterRunner;
}

interface Job {
	key: string;
	name: string;
	mtimeMs: number;
	filePath: string;
	opts: GenOpts;
}

const queue: Job[] = [];
const pending = new Set<string>();
let running = false;
let pumpPromise: Promise<void> = Promise.resolve();
const MAX_QUEUE = 256;

const jobKey = (name: string, mtimeMs: number) => `${name} ${mtimeMs}`;

/**
 * Ensure metadata + poster exist for a video. Fire-and-forget: returns
 * immediately (never awaited on a request path). Idempotent + single-flight by
 * (name, mtime); bounded; no-op/false when disabled. Returns true if a new job
 * was enqueued. `opts` is for tests (explicit dataDir + mock runners).
 */
export function enqueueGeneration(
	name: string,
	mtimeMs: number,
	filePath: string,
	opts: GenOpts = {}
): boolean {
	// Gate on the POSTERS FEATURE (0.8.0), not the bare volume: a feed with a
	// DATA_DIR only for `starred` (POSTERS off) must never generate posters/meta. In
	// production /api/poster already 204s before reaching here when posters are off;
	// this is the defence-in-depth backstop (and the unit-test seam).
	const postersEnabled = opts.postersEnabled ?? config.posters;
	if (!postersEnabled) return false;
	const key = jobKey(name, mtimeMs);
	if (pending.has(key) || queue.length >= MAX_QUEUE) return false;
	pending.add(key);
	queue.push({ key, name, mtimeMs, filePath, opts });
	pump();
	return true;
}

function pump(): void {
	if (running) return;
	running = true;
	pumpPromise = (async () => {
		let job: Job | undefined;
		while ((job = queue.shift())) {
			const { name, mtimeMs, filePath, opts } = job;
			const dataDir = opts.dataDir ?? config.dataDir;
			try {
				if (!(await readMeta(name, mtimeMs, dataDir))) {
					await generateMeta(name, mtimeMs, filePath, opts.metaRunner, dataDir);
				}
				if (!(await readPoster(name, mtimeMs, dataDir))) {
					await generatePoster(name, mtimeMs, filePath, opts.posterRunner, dataDir);
				}
			} catch {
				/* best-effort — a failed job just stays un-generated until next kick */
			} finally {
				pending.delete(job.key);
			}
		}
		running = false;
	})();
}

/** Test seam: resolves when the queue has drained and the worker is idle. */
export function _whenIdle(): Promise<void> {
	return pumpPromise;
}

/** Test seam: clear all worker state. */
export function _resetWorker(): void {
	queue.length = 0;
	pending.clear();
	running = false;
	pumpPromise = Promise.resolve();
}
