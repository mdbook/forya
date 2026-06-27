// Starred (0.8.0) — a forya-internal "favorite" mark: a flat set of video
// filenames the user double-tapped, persisted as a single JSON doc under
// `DATA_DIR`. Like `dataCache`, the WHOLE feature is gated on `config.dataDir`:
//
//   - `DATA_DIR` unset → `config.dataDir === ''` → every function here is an inert
//     no-op that touches the filesystem ZERO times, even if a writable volume is
//     mounted. Containment keys on the ENV VAR, never on whether the dir exists.
//   - `DATA_DIR` set   → forya reads/writes ONLY `dataDir/starred.json`, never the
//     `:ro` VIDEO_DIR.
//
// Unlike `dataCache` (a per-artifact poster/meta cache keyed on name+mtime, gated
// on the POSTERS feature), starred is a SINGLE small doc gated on the raw volume
// (`dataDir !== ''`) — no generation, no ffmpeg, so it works on every feed that has
// a volume regardless of POSTERS. It is fully DECOUPLED from the 0.7.0 SWR feed
// scan: a mark never touches the manifest, and the client overlays the set onto the
// feed client-side, so a toggle reflects instantly with no rescan.
//
// Writes are atomic (tmp + rename) and serialized through ONE in-process queue so a
// read-modify-write can't interleave (no lost toggle); an in-memory Set caches the
// set after the first load. Nothing here ever throws — a failure degrades to "the
// last-known set", same best-effort contract as dataCache.
import fsp from 'node:fs/promises';
import path from 'node:path';
import { config } from './config';

const STARRED_FILE = 'starred.json';
const STARRED_VERSION = 1;

/** Feature on? Keys SOLELY on the (env-derived) config volume — never on fs state.
 *  A single small JSON doc with no generation, so it needs only DATA_DIR (the raw
 *  volume), NOT the POSTERS feature. */
export function starredEnabled(dataDir: string = config.dataDir): boolean {
	return dataDir !== '';
}

/**
 * Resolve `starred.json` under `dataDir`, or `null` when disabled. Pure. The
 * filename is fixed (the video name lives INSIDE the doc, never in the path — so
 * there's no traversal vector here; the API layer still `safeMediaPath`-guards the
 * route param). Asserted to stay directly under `dataDir` (defence in depth).
 */
export function starredPath(dataDir: string): string | null {
	if (dataDir === '') return null;
	const dir = path.resolve(dataDir);
	const full = path.join(dir, STARRED_FILE);
	if (path.dirname(full) !== dir) return null; // never escape dataDir
	return full;
}

// In-memory cache of the starred set, keyed by the dataDir it was loaded from (a
// single container serves one dataDir; the key guards tests that use temp dirs).
let cache: { dir: string; set: Set<string> } | null = null;
// Single write-queue: every mutation chains onto this so concurrent toggles run
// strictly sequentially (read-modify-write can't interleave → no lost update).
let writeChain: Promise<unknown> = Promise.resolve();
let tmpSeq = 0;

/** Test seam: drop the in-memory cache + reset the write queue. */
export function clearStarredCache(): void {
	cache = null;
	writeChain = Promise.resolve();
}

/** Pure: parse OUR stored starred JSON → string[] of names, or [] if unusable. */
function parseStarred(json: string): string[] {
	let data: unknown;
	try {
		data = JSON.parse(json);
	} catch {
		return [];
	}
	if (!data || typeof data !== 'object') return [];
	const arr = (data as { starred?: unknown }).starred;
	if (!Array.isArray(arr)) return [];
	return arr.filter((n): n is string => typeof n === 'string');
}

/** Load the starred set (from the in-mem cache or disk). Empty Set when disabled or
 *  missing/corrupt. Never throws; ZERO fs calls when disabled. */
async function loadSet(dataDir: string): Promise<Set<string>> {
	if (dataDir === '') return new Set();
	if (cache && cache.dir === dataDir) return cache.set;
	const full = starredPath(dataDir);
	if (!full) return new Set();
	let set: Set<string>;
	try {
		set = new Set(parseStarred(await fsp.readFile(full, 'utf8')));
	} catch {
		set = new Set(); // missing/unreadable → empty (not an error)
	}
	cache = { dir: dataDir, set };
	return set;
}

/** Atomically write the set to `dataDir/starred.json` (tmp + rename). No-op when
 *  disabled; never throws; writes ONLY under `dataDir`, never the `:ro` source. */
async function persist(dataDir: string, set: Set<string>): Promise<void> {
	const full = starredPath(dataDir);
	if (!full) return;
	// Preserve Set INSERTION order on disk (newest-marked last) — the favorites view (0.9.0)
	// reads it via readStarredOrdered() and reverses for newest-liked-first. readStarred() still
	// sorts for the GET seed (order-agnostic there). A re-mark of an existing name is a Set no-op
	// (keeps its original position), so an idempotent re-PUT never reorders.
	const body = JSON.stringify({ version: STARRED_VERSION, starred: [...set] });
	const tmp = `${full}.tmp.${process.pid}.${tmpSeq++}`;
	try {
		await fsp.mkdir(path.dirname(full), { recursive: true });
		await fsp.writeFile(tmp, body);
		await fsp.rename(tmp, full); // atomic publish
	} catch {
		try {
			await fsp.rm(tmp, { force: true });
		} catch {
			/* ignore */
		}
	}
}

/** The starred names (sorted), or [] when disabled. Never throws; ZERO fs when
 *  disabled; cache-read after the first load. */
export async function readStarred(dataDir: string = config.dataDir): Promise<string[]> {
	if (dataDir === '') return [];
	return [...(await loadSet(dataDir))].sort();
}

/** The starred names in INSERTION order (oldest-marked first), or [] when disabled. The
 *  favorites view (0.9.0) reverses this for newest-liked-first. Never throws; ZERO fs when
 *  disabled; cache-read after the first load. (readStarred sorts; this preserves order.) */
export async function readStarredOrdered(dataDir: string = config.dataDir): Promise<string[]> {
	if (dataDir === '') return [];
	return [...(await loadSet(dataDir))];
}

/**
 * Mark (`star=true`) or unmark (`star=false`) `name`, persisted atomically.
 * Idempotent (PUT/DELETE semantics — the client sends the intended state, so a
 * retried request can't double-flip). Serialized through the one write-queue so
 * concurrent toggles can't lose an update. Returns the resulting state (`star`);
 * a no-op returning `false` when disabled. Never throws.
 */
export async function setStarred(
	name: string,
	star: boolean,
	dataDir: string = config.dataDir
): Promise<boolean> {
	if (dataDir === '') return false;
	const run = writeChain.then(async () => {
		// Work on a COPY of the cached set so the cache only advances to a state we
		// actually attempted to persist (persist swallows its own errors).
		const set = new Set(await loadSet(dataDir));
		if (star) set.add(name);
		else set.delete(name);
		await persist(dataDir, set);
		cache = { dir: dataDir, set };
		return star;
	});
	// Keep the chain alive even if a run rejects (it shouldn't — persist never
	// throws), so one failure can't wedge every later toggle.
	writeChain = run.catch(() => {});
	return run;
}
