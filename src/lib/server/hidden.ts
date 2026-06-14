// Hidden (0.8.3) — a forya-internal "hide from feed" mark: a flat set of video
// filenames the user hid, persisted as a single JSON doc under `DATA_DIR`. The
// EXACT mirror of `starred` (same containment, atomic-write, write-queue, and
// in-mem-cache discipline) — the one feature difference is that hidden names are
// EXCLUDED from the feed (server-side), whereas a star is a purely additive mark.
//
//   - `DATA_DIR` unset → `config.dataDir === ''` → every function here is an inert
//     no-op that touches the filesystem ZERO times, even if a writable volume is
//     mounted. Containment keys on the ENV VAR, never on whether the dir exists.
//   - `DATA_DIR` set   → forya reads/writes ONLY `dataDir/hidden.json`, never the
//     `:ro` VIDEO_DIR.
//
// Like `starred` (and unlike the POSTERS cache), this is a SINGLE small doc gated
// on the raw volume (`dataDir !== ''`) — no generation, no ffmpeg — so it works on
// every feed that has a volume regardless of POSTERS.
//
// THE FEED EXCLUSION is sync-read (`hiddenSetSync`): the feed consumers run on the
// ~30ms cheap-scan path and must NOT add an fs hop, so they read the in-memory set
// only. The set is warmed at boot (`warmHidden`, hooks.server.ts) and refreshed
// synchronously on every write, so a hide reflects on the next feed read without a
// rescan. (This DOES change `/api/feed` output by design — it is NOT part of the
// byte-identical serving-four; see the route consumers.)
//
// Writes are atomic (tmp + rename) and serialized through ONE in-process queue so a
// read-modify-write can't interleave (no lost toggle); an in-memory Set caches the
// set after the first load. Nothing here ever throws — a failure degrades to "the
// last-known set", same best-effort contract as starred/dataCache.
import fsp from 'node:fs/promises';
import path from 'node:path';
import { config } from './config';

const HIDDEN_FILE = 'hidden.json';
const HIDDEN_VERSION = 1;

// One shared empty set for the disabled/not-yet-warmed sync read — callers only
// `.has()` it, so sharing a single instance avoids a per-request allocation on the
// hot feed path. Frozen-by-convention: never mutate it.
const EMPTY_SET: ReadonlySet<string> = new Set<string>();

/** Feature on? Keys SOLELY on the (env-derived) config volume — never on fs state.
 *  A single small JSON doc with no generation, so it needs only DATA_DIR (the raw
 *  volume), NOT the POSTERS feature. (Mirrors `starredEnabled`.) */
export function hiddenEnabled(dataDir: string = config.dataDir): boolean {
	return dataDir !== '';
}

/**
 * Resolve `hidden.json` under `dataDir`, or `null` when disabled. Pure. The
 * filename is fixed (the video name lives INSIDE the doc, never in the path — so
 * there's no traversal vector here; the API layer still `safeMediaPath`-guards the
 * route param). Asserted to stay directly under `dataDir` (defence in depth).
 */
export function hiddenPath(dataDir: string): string | null {
	if (dataDir === '') return null;
	const dir = path.resolve(dataDir);
	const full = path.join(dir, HIDDEN_FILE);
	if (path.dirname(full) !== dir) return null; // never escape dataDir
	return full;
}

// In-memory cache of the hidden set, keyed by the dataDir it was loaded from (a
// single container serves one dataDir; the key guards tests that use temp dirs).
let cache: { dir: string; set: Set<string> } | null = null;
// Single write-queue: every mutation chains onto this so concurrent toggles run
// strictly sequentially (read-modify-write can't interleave → no lost update).
let writeChain: Promise<unknown> = Promise.resolve();
let tmpSeq = 0;

/** Test seam: drop the in-memory cache + reset the write queue. */
export function clearHiddenCache(): void {
	cache = null;
	writeChain = Promise.resolve();
}

/** Pure: parse OUR stored hidden JSON → string[] of names, or [] if unusable. */
function parseHidden(json: string): string[] {
	let data: unknown;
	try {
		data = JSON.parse(json);
	} catch {
		return [];
	}
	if (!data || typeof data !== 'object') return [];
	const arr = (data as { hidden?: unknown }).hidden;
	if (!Array.isArray(arr)) return [];
	return arr.filter((n): n is string => typeof n === 'string');
}

/** Load the hidden set (from the in-mem cache or disk). Empty Set when disabled or
 *  missing/corrupt. Never throws; ZERO fs calls when disabled. */
async function loadSet(dataDir: string): Promise<Set<string>> {
	if (dataDir === '') return new Set();
	if (cache && cache.dir === dataDir) return cache.set;
	const full = hiddenPath(dataDir);
	if (!full) return new Set();
	let set: Set<string>;
	try {
		set = new Set(parseHidden(await fsp.readFile(full, 'utf8')));
	} catch {
		set = new Set(); // missing/unreadable → empty (not an error)
	}
	// Compare-and-set (concurrency, adversarial #4): `loadSet` is check-then-set with an
	// `await` in the middle, and the boot `warmHidden` lane is NOT serialized with the
	// `setHidden` write-queue. If a hide landed while we were reading OLD bytes off disk,
	// the cache now holds a FRESHER set — overwriting it with our stale snapshot would
	// not only make `hiddenSetSync` miss the just-hidden clip, it would DURABLY drop the
	// name: the next `setHidden` reads the clobbered (non-null) cache without re-reading
	// disk and persists the gap. So never overwrite an already-populated cache for this
	// dir — adopt it. (Either ordering is now safe: if a write set the cache before this
	// re-check we keep it; if after, the write's own assignment wins.)
	if (cache && cache.dir === dataDir) return cache.set;
	cache = { dir: dataDir, set };
	return set;
}

/** Atomically write the set to `dataDir/hidden.json` (tmp + rename). No-op when
 *  disabled; never throws; writes ONLY under `dataDir`, never the `:ro` source. */
async function persist(dataDir: string, set: Set<string>): Promise<void> {
	const full = hiddenPath(dataDir);
	if (!full) return;
	const body = JSON.stringify({ version: HIDDEN_VERSION, hidden: [...set].sort() });
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

/** The hidden names (sorted), or [] when disabled. Never throws; ZERO fs when
 *  disabled; cache-read after the first load. */
export async function readHidden(dataDir: string = config.dataDir): Promise<string[]> {
	if (dataDir === '') return [];
	return [...(await loadSet(dataDir))].sort();
}

/**
 * SYNCHRONOUS read of the in-memory hidden set, for the FEED EXCLUSION path. The
 * feed consumers (`/api/feed`, `+page.server`) run on the ~30ms cheap-scan path, so
 * they must read the cached set with ZERO fs/await. Returns the cached set, or an
 * EMPTY set when disabled or not-yet-warmed — best-effort: a feed request that
 * races the boot-warm shows the unfiltered feed exactly once, then the cache is
 * populated (`warmHidden` makes this window vanishingly small). Never touches disk.
 */
export function hiddenSetSync(dataDir: string = config.dataDir): ReadonlySet<string> {
	if (dataDir === '') return EMPTY_SET;
	if (cache && cache.dir === dataDir) return cache.set;
	return EMPTY_SET;
}

/** Populate the in-memory cache from disk once (best-effort), so the first feed
 *  request can exclude hidden items synchronously. No-op + ZERO fs when disabled;
 *  never throws. Called fire-and-forget at server boot (hooks.server.ts). */
export async function warmHidden(dataDir: string = config.dataDir): Promise<void> {
	if (dataDir === '') return;
	// Already warmed by a read or a write? Don't reload — re-reading would re-open the
	// `loadSet` boot-race window (adversarial #4) for no benefit. With the cache present,
	// `loadSet` returns it immediately (no disk read), so this is the cheap fast-path.
	if (cache && cache.dir === dataDir) return;
	await loadSet(dataDir);
}

/**
 * Hide (`hide=true`) or unhide (`hide=false`) `name`, persisted atomically.
 * Idempotent (PUT/DELETE semantics — the client sends the intended state, so a
 * retried request can't double-flip). Serialized through the one write-queue so
 * concurrent toggles can't lose an update. Updates the in-mem cache synchronously
 * inside the chain so the NEXT `hiddenSetSync` feed read reflects it. Returns the
 * resulting state (`hide`); a no-op returning `false` when disabled. Never throws.
 */
export async function setHidden(
	name: string,
	hide: boolean,
	dataDir: string = config.dataDir
): Promise<boolean> {
	if (dataDir === '') return false;
	const run = writeChain.then(async () => {
		// Work on a COPY of the cached set so the cache only advances to a state we
		// actually attempted to persist (persist swallows its own errors).
		const set = new Set(await loadSet(dataDir));
		if (hide) set.add(name);
		else set.delete(name);
		await persist(dataDir, set);
		cache = { dir: dataDir, set };
		return hide;
	});
	// Keep the chain alive even if a run rejects (it shouldn't — persist never
	// throws), so one failure can't wedge every later toggle.
	writeChain = run.catch(() => {});
	return run;
}
