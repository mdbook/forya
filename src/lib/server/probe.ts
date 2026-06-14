// ffprobe-backed video metadata (0.5/M2). The actual ffprobe spawn lives behind
// an injectable `ProbeRunner` seam, so unit tests mock it and CI never needs a
// real ffmpeg/ffprobe binary. `parseProbe` is pure (JSON → metadata). GENERATION
// (spawning ffprobe) is the M4 worker's job and is NEVER on the SSR/Range path;
// the request path only ever does `enrichItems`, which is cache-READ-only and an
// identity no-op when the DATA_DIR feature is off (manifest stays byte-identical).
import { config } from './config';
import { cacheEnabled, readCache, writeCache } from './dataCache';
import { nicedExecFile } from './nicedExec';
import type { FeedItem } from '$lib/types';

export interface VideoMeta {
	width: number;
	height: number;
	/** Seconds; 0 if ffprobe didn't report a usable duration. */
	duration: number;
}

/** Runs ffprobe on `filePath`, resolving its stdout (JSON). Injectable seam. */
export type ProbeRunner = (filePath: string) => Promise<string>;

const PROBE_TIMEOUT_MS = 30_000;

/** Default runner: ffprobe → JSON of the first video stream's dims + duration,
 *  spawned at low priority (M4). Rejects on spawn/timeout/nonzero. Only the M4
 *  worker calls this — never a request hot path. */
export const ffprobeRunner: ProbeRunner = async (filePath) =>
	(await nicedExecFile(
		'ffprobe',
		[
			'-v',
			'error',
			'-select_streams',
			'v:0',
			'-show_entries',
			'stream=width,height:format=duration',
			'-of',
			'json',
			filePath
		],
		{ timeout: PROBE_TIMEOUT_MS, maxBuffer: 1 << 20 }
	)) as string;

/** Pure: map ffprobe JSON → VideoMeta, or null if unusable (no/zero dims). */
export function parseProbe(json: string): VideoMeta | null {
	let data: unknown;
	try {
		data = JSON.parse(json);
	} catch {
		return null;
	}
	if (!data || typeof data !== 'object') return null;
	const d = data as {
		streams?: Array<{ width?: number; height?: number }>;
		format?: { duration?: string };
	};
	const width = Number(d.streams?.[0]?.width);
	const height = Number(d.streams?.[0]?.height);
	const duration = Number(d.format?.duration);
	if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
	return { width, height, duration: Number.isFinite(duration) && duration > 0 ? duration : 0 };
}

/** Pure: parse + validate OUR stored meta JSON (the shape we persist). */
function parseStored(json: string): VideoMeta | null {
	let data: unknown;
	try {
		data = JSON.parse(json);
	} catch {
		return null;
	}
	if (!data || typeof data !== 'object') return null;
	const m = data as Record<string, unknown>;
	const width = Number(m.width);
	const height = Number(m.height);
	const duration = Number(m.duration);
	if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
	return { width, height, duration: Number.isFinite(duration) && duration > 0 ? duration : 0 };
}

/** Read cached metadata for an item, or null. Cache-READ-only — never spawns
 *  ffprobe; null when disabled. */
export async function readMeta(
	name: string,
	mtimeMs: number,
	dataDir: string = config.dataDir
): Promise<VideoMeta | null> {
	const buf = await readCache('meta', name, mtimeMs, 'json', dataDir);
	return buf ? parseStored(buf.toString('utf8')) : null;
}

/** Probe + cache metadata for a file (spawns ffprobe via `runner`). The M4
 *  worker calls this OFF any request path. No-op/null when disabled. */
export async function generateMeta(
	name: string,
	mtimeMs: number,
	filePath: string,
	runner: ProbeRunner = ffprobeRunner,
	dataDir: string = config.dataDir
): Promise<VideoMeta | null> {
	if (!cacheEnabled(dataDir)) return null;
	let raw: string;
	try {
		raw = await runner(filePath); // the only throwing step (spawn/timeout)
	} catch {
		return null;
	}
	const meta = parseProbe(raw); // pure, never throws
	if (!meta) return null;
	await writeCache(
		'meta',
		name,
		mtimeMs,
		'json',
		Buffer.from(JSON.stringify(meta), 'utf8'),
		(b) => parseStored(b.toString('utf8')) !== null,
		dataDir
	);
	return meta;
}

/**
 * ADDITIVELY enrich a page of feed items with cached metadata
 * (`width`/`height`/`duration`). Disabled (POSTERS off) → returns the SAME array
 * unchanged (identity, ZERO cache access) so the manifest is byte-identical.
 * Cache-READ-only: never spawns ffprobe, safe on the SSR/feed path. Bounded —
 * call on the PAGE being sent, not the whole library.
 *
 * 0.8.0: gates on `postersEnabled` (the POSTERS feature), NOT the bare DATA_DIR
 * volume — so a feed with a volume for `starred` but POSTERS off keeps `enrichItems`
 * as an identity no-op (no meta-cache read), and its feed payload stays byte-
 * identical to the 0.7.0 cheap-scan output. `config.posters` implies a volume, so
 * the `readMeta(dataDir)` path below only runs when `dataDir` is present.
 */
export async function enrichItems(
	items: FeedItem[],
	dataDir: string = config.dataDir,
	postersEnabled: boolean = config.posters
): Promise<FeedItem[]> {
	if (!postersEnabled) return items; // posters off → byte-identical
	// Only reached when POSTERS is ON — the full-stat scan path, where `mtime` is
	// always present (it's the cache key). `?? 0` is just the type guard for the
	// now-optional field (0.7.0); it never fires on this path.
	return Promise.all(
		items.map(async (it) => {
			const meta = await readMeta(it.name, it.mtime ?? 0, dataDir);
			return meta ? { ...it, width: meta.width, height: meta.height, duration: meta.duration } : it;
		})
	);
}
