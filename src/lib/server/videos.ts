// The workhorse (SPEC §3). Dir scan → feed manifest, mime-from-ext, the
// safe-path resolver, a deterministic seeded shuffle, and — the load-bearing
// piece — the pure HTTP Range resolver that `tests/range.test.ts` guards.
//
// Keep the Range logic pure and side-effect free: the route handler in
// routes/api/media/[name]/+server.ts is a thin wrapper that does fs I/O and
// streams; all the byte math lives here so it can never silently regress.
import fsp from 'node:fs/promises';
import path from 'node:path';
import { config } from './config';
import type { FeedItem, MediaFrame } from '$lib/types';

export const VIDEO_EXTENSIONS = ['.mp4', '.mov', '.webm', '.m4v'] as const;

const MIME_BY_EXT: Record<string, string> = {
	'.mp4': 'video/mp4',
	'.mov': 'video/quicktime',
	'.webm': 'video/webm',
	'.m4v': 'video/x-m4v',
	// Image-gallery frames (TikTok photo posts): served by the SAME /api/media Range endpoint,
	// so this table is where their content-type comes from — without these a frame would serve
	// as application/octet-stream and the browser would download it instead of rendering. Videos
	// are unaffected (their four types are unchanged). Contract A allows jpg/jpeg/png/webp.
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.png': 'image/png',
	'.webp': 'image/webp',
	// Gallery soundtracks (TikTok photo-post audio, round-3): a photo post can carry a music track
	// saved as a bare `<id>.{m4a,mp3}` beside its `<id>_NN.*` frames. Served by the SAME /api/media
	// Range endpoint (iOS seeks/streams audio via Range too), so its content-type belongs here
	// alongside the video + frame types — without it the track would serve as
	// application/octet-stream and iOS wouldn't play it. Videos/frames unaffected.
	'.m4a': 'audio/mp4',
	'.mp3': 'audio/mpeg'
};

/** MIME type from a filename's extension (SPEC §3 table). */
export function mimeFromExt(name: string): string {
	return MIME_BY_EXT[path.extname(name).toLowerCase()] ?? 'application/octet-stream';
}

/** True if the filename has a supported video extension. */
export function isVideoFile(name: string): boolean {
	return (VIDEO_EXTENSIONS as readonly string[]).includes(path.extname(name).toLowerCase());
}

/** Contract A gallery frame: `<id>_NN.<ext>` — pure-digit post id, 2-digit zero-pad carousel
 *  index (01-based), image ext. LOCKED shape (design #1380 / gate #1381): `_NN` is ALWAYS
 *  present (a 1-image post is `<id>_01.jpg`), so grouping is unambiguous and a bare `<id>.jpg`
 *  is NOT a gallery. STRICT — a name that isn't exactly this (`7_1.jpg`, `7_001.jpg`, `7.jpg`,
 *  `foo_01.jpg`) is rejected, never best-effort grouped (gate AC-3 reject-nonmatching). The id
 *  is pure digits (validated on the tiktok-sync WRITE side too, I2), so the only `_` is the
 *  frame separator and a crafted id can't smuggle a `_NN`. */
const FRAME_RE = /^(\d+)_(\d{2})\.(jpg|jpeg|png|webp)$/i;

/** Contract A gallery soundtrack: a bare pure-digit-id audio file `<id>.{m4a,mp3}` (round-3) —
 *  the same `<id>` stem as the post's `<id>_NN.*` frames. It is gallery-audio IFF matching frames
 *  exist (the disambiguator vs a stray audio file), which is enforced by only attaching it to an
 *  emitted gallery item (an id with no frames never becomes a gallery, so its audio is dropped).
 *  The id is pure digits (validated on the tiktok-sync WRITE side too, I2), disjoint from a
 *  video's `<id>.{mp4,…}` (different ext) and from a gallery's bare `<id>` name (has an ext). */
const AUDIO_RE = /^(\d+)\.(m4a|mp3)$/i;

/** Dotfiles and `.partial` (tiktok-sync's mid-download files) — mirrors erin's
 *  IGNORE_HIDDEN_PATHS. */
export function isHidden(name: string): boolean {
	return name.startsWith('.') || name.endsWith('.partial');
}

// ---------------------------------------------------------------------------
// Dir scan + serve-stale-while-revalidate manifest (0.7.0)
//
// The request path must NEVER block on a CIFS scan: the 11.9k-file feed cold-
// scanned in ~24s because it did one `fsp.stat` PER FILE (measured 23.7s; a bare
// `readdir` of the same dir is 1.21s — SMB returns dir attrs inline, so the
// per-file stats are the antipattern). So `getFeed()` (the REQUEST path) serves
// the last-known-good manifest from memory INSTANTLY and only ever schedules a
// revalidate in the background. A fresh/restarted container with no manifest yet
// serves empty + `warming:true`; the client polls until the first background
// scan lands (~1-2s) — never a blocking 24s request, and no persistence needed.
//
// The background scan is cheap (Approach B): on feeds with POSTERS off (the big
// liked/favorite feeds — which may still have a DATA_DIR for `starred`, 0.8.0) it
// is one `readdir` with NO per-file stat, dropping `size`/`mtime` that nothing
// there consumes (posters off → no cache key; the UI shuffles → mtime order
// discarded; `size` is lazy-fetched for the single open info card). On a POSTERS
// feed (best) we keep the full stat — `mtime` is the poster/meta cache key. Base
// order is by NAME (a
// stable total order over unique filenames) so SSR + /api/feed seeded-shuffle
// paging stay coherent WITHOUT depending on mtime.
// ---------------------------------------------------------------------------

interface ScanCache {
	key: string;
	items: FeedItem[];
	/** Directory mtime (ms) the items were scanned at. A dir's mtime bumps on entry
	 *  add/remove/rename (incl. `.partial` → final), so a background revalidate
	 *  re-walks only when it moved and otherwise just costs one dir-stat — and that
	 *  stat is on the BACKGROUND path, never a request. */
	dirMtimeMs: number;
	/** When the last background revalidate was kicked (ms) — throttles routine
	 *  revalidation to once per REVALIDATE_INTERVAL_MS so a busy feed doesn't
	 *  re-scan on every request. */
	checkedAt: number;
}

/** Eventual-consistency window: a viewed feed revalidates in the background at
 *  most once per this interval, so new/removed clips appear within ~this long.
 *  The revalidate is cheap (Approach B) and never blocks a request (SWR). */
const REVALIDATE_INTERVAL_MS = 30_000;

let scanCache: ScanCache | null = null;
// Single-flight: concurrent revalidates for the same dir share one in-progress
// scan instead of each launching their own (which stacked badly on the single-
// connection mount). Registered SYNCHRONOUSLY in scanVideos — before the first
// `await` — so two concurrent callers can't both slip past the check.
let inflight: { key: string; promise: Promise<FeedItem[]> } | null = null;

/** Clear the scan cache and any in-flight scan — test seam. */
export function clearScanCache(): void {
	scanCache = null;
	inflight = null;
}

/** Directory mtime in ms, or -1 if missing/unreadable (→ empty feed, cached like
 *  any other state so we don't re-stat-fail every request). */
async function dirMtimeMs(videoDir: string): Promise<number> {
	try {
		return (await fsp.stat(videoDir)).mtimeMs;
	} catch {
		return -1;
	}
}

/** The directory walk → manifest items, name-asc. Missing/unreadable dir → empty
 *  feed (not an error; stateless serving). When `cheap`, does NOT stat per file
 *  (Approach B): `size`/`mtime` are left undefined. */
async function doScan(
	videoDir: string,
	ignoreHidden: boolean,
	cheap: boolean
): Promise<FeedItem[]> {
	let entries;
	try {
		entries = await fsp.readdir(videoDir, { withFileTypes: true });
	} catch {
		return [];
	}

	const items: FeedItem[] = [];
	// Gallery frames accumulate here by post id (Contract A grouping): one photo post = N
	// flat `<id>_NN.<ext>` frames → ONE gallery FeedItem (design #1380, gate AC-3). Plain
	// object; ids are pure digits (FRAME_RE). Frames never per-file stat — a gallery carries
	// no poster/mtime cache key, so it stays cheap even on the full-stat (poster) path.
	const galleries: Record<string, { name: string; idx: string }[]> = {};
	// Gallery soundtracks accumulate here by post id (round-3): a bare `<id>.{m4a,mp3}` beside the
	// frames. Attached to the gallery item below ONLY for ids that also have frames (the
	// disambiguator) — a stray audio whose id has no frames falls through unused, never a feed
	// item. Never per-file stats (a gallery carries no cache key), so it stays cheap.
	const audioById: Record<string, MediaFrame> = {};
	for (const ent of entries) {
		if (!ent.isFile()) continue;
		const name = ent.name;
		if (ignoreHidden && isHidden(name)) continue;
		// Gallery frame FIRST: a strict `<id>_NN.<ext>` groups; anything else falls through.
		// A frame is an IMAGE, so it never matched isVideoFile — pre-galleries these were
		// silently dropped; now they group. (`.part` mid-downloads fail FRAME_RE → excluded.)
		const fm = FRAME_RE.exec(name);
		if (fm) {
			(galleries[fm[1]] ??= []).push({ name, idx: fm[2] });
			continue;
		}
		// Gallery soundtrack: a bare `<id>.{m4a,mp3}`. Accumulate by id; the gallery emit below
		// attaches it IFF that id has frames. Prefer `.m4a` (AAC) if a post somehow has both —
		// deterministic + best iOS support. (An audio file is never a standalone feed item.)
		const am = AUDIO_RE.exec(name);
		if (am) {
			const prev = audioById[am[1]];
			if (!prev || (am[2].toLowerCase() === 'm4a' && prev.type === 'audio/mpeg')) {
				audioById[am[1]] = {
					name,
					url: `/api/media/${encodeURIComponent(name)}`,
					type: mimeFromExt(name)
				};
			}
			continue;
		}
		if (!isVideoFile(name)) continue;
		const item: FeedItem = {
			name,
			url: `/api/media/${encodeURIComponent(name)}`,
			type: mimeFromExt(name)
		};
		// Approach B: on the cheap path skip the per-file stat entirely (readdir-
		// only — the whole point of 0.7.0). `size`/`mtime` stay undefined; nothing
		// on a poster-off feed reads them. A file that vanished between readdir and
		// serve just 404s at the media endpoint (the manifest is advisory).
		if (!cheap) {
			let st;
			try {
				st = await fsp.stat(path.join(videoDir, name));
			} catch {
				continue;
			}
			item.size = st.size;
			item.mtime = st.mtimeMs;
		}
		items.push(item);
	}

	// Emit one gallery FeedItem per post id: frames ordered by the 2-digit `NN` (zero-padded,
	// so lexicographic === carousel order). `name` = the bare `<id>` (one post = one unit for
	// starred/hidden/share/manifest keying — a gallery name has no extension, so it can never
	// collide with a video's `<id>.<ext>`). `url`/`type` mirror the first frame (share/info
	// fallback); the carousel itself reads `media[]`. No size/mtime — a gallery needs neither.
	for (const id in galleries) {
		const frames = galleries[id].sort((a, b) => (a.idx < b.idx ? -1 : a.idx > b.idx ? 1 : 0));
		const media = frames.map((f) => ({
			name: f.name,
			url: `/api/media/${encodeURIComponent(f.name)}`,
			type: mimeFromExt(f.name)
		}));
		const item: FeedItem = { name: id, url: media[0].url, type: media[0].type, media };
		// Attach the soundtrack IFF this id (which HAS frames → is a gallery) also has a bare
		// `<id>.{m4a,mp3}`. This presence-check is the "gallery-audio IFF frames exist"
		// disambiguator: an audio file whose id has no frames never reaches this loop, so it's
		// dropped. Absent field ⇒ audioless gallery (silent) — byte-identical to pre-round-3.
		if (audioById[id]) item.audio = audioById[id];
		items.push(item);
	}

	// Name-asc: a stable, deterministic total order over unique filenames so SSR +
	// /api/feed seeded-shuffle paging stay coherent without mtime. Code-unit compare
	// (not localeCompare) so it's environment-independent. The UI always shuffles,
	// so this base order is never user-visible — it only has to be stable + total.
	items.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
	return items;
}

/** Canonical in-process scan-cache / single-flight key. MUST include `cheap`: it
 *  selects the output SHAPE (readdir-only vs full-stat), so two scans of the same
 *  dir with different `cheap` are DIFFERENT cache entries — omitting it would let a
 *  cheap scan serve a poster feed's full-stat manifest (or vice versa). All three
 *  cache touchpoints (scanVideos / scheduleRevalidate / getFeed) key through here so
 *  they can never drift apart. */
function scanKey(videoDir: string, ignoreHidden: boolean, cheap: boolean): string {
	return `${videoDir} ${ignoreHidden} ${cheap}`;
}

/**
 * Scan `videoDir` → manifest items (name-asc), updating the in-process cache.
 * This is the BACKGROUND revalidate worker (and the test seam): it blocks on the
 * scan and returns the items. Request handlers must use `getFeed()` instead (which
 * never awaits a CIFS scan). Single-flight: concurrent callers share one scan; a
 * stable directory (unchanged mtime) reuses the cache without re-walking.
 * `cheap` defaults to "poster feature off" (`!config.posters`) — the readdir-only
 * path. NOTE (0.8.0): the gate is the POSTERS feature, NOT the bare DATA_DIR volume.
 * A feed can have a `DATA_DIR` (for `starred`) yet `POSTERS` off → it STAYS cheap,
 * so adding a volume for `starred` can't silently undo the 0.7.0 cheap-scan win.
 * Full stat only where posters need the `mtime` cache key (`config.posters`).
 */
export async function scanVideos(
	videoDir: string = config.videoDir,
	ignoreHidden: boolean = config.ignoreHidden,
	cheap: boolean = !config.posters
): Promise<FeedItem[]> {
	const key = scanKey(videoDir, ignoreHidden, cheap);

	// Single-flight: if a scan for this dir is already running, await it. Checked
	// before any `await` so concurrent callers can't both start a scan.
	if (inflight && inflight.key === key) return inflight.promise;

	// `inflight` is assigned synchronously from this IIFE's returned promise — the
	// body runs up to its first `await` and suspends, but the assignment below has
	// already happened by the time any other caller runs. Cache validity needs the
	// dir mtime (one cheap stat); a matching mtime reuses the cached items.
	const promise = (async () => {
		const mtime = await dirMtimeMs(videoDir);
		if (scanCache && scanCache.key === key && scanCache.dirMtimeMs === mtime) {
			scanCache.checkedAt = Date.now();
			return scanCache.items;
		}
		const items = await doScan(videoDir, ignoreHidden, cheap);
		scanCache = { key, items, dirMtimeMs: mtime, checkedAt: Date.now() };
		return items;
	})();

	// Clear on SETTLE (not just resolve) so a failed scan retries, not poisons.
	inflight = { key, promise };
	promise.finally(() => {
		if (inflight?.promise === promise) inflight = null;
	});
	return promise;
}

// ---------------------------------------------------------------------------
// Serve-stale-while-revalidate request path (0.7.0)
// ---------------------------------------------------------------------------

/** What the request path gets back from `getFeed()`. */
export interface FeedResult {
	items: FeedItem[];
	/** True only when there is NO manifest yet (fresh/restarted container, first
	 *  request before the first background scan lands). The client shows a brief
	 *  warming state and polls; never a blocking scan. */
	warming: boolean;
}

/** Kick a background revalidate if due — never awaited, never throws into the
 *  request. Cold (no manifest for this key) → always schedule (single-flight in
 *  scanVideos dedups the concurrent cold-start polls); warm → throttled to once
 *  per REVALIDATE_INTERVAL_MS. */
function scheduleRevalidate(videoDir: string, ignoreHidden: boolean, cheap: boolean): void {
	const key = scanKey(videoDir, ignoreHidden, cheap);
	const warm = scanCache !== null && scanCache.key === key;
	if (warm && Date.now() - scanCache!.checkedAt < REVALIDATE_INTERVAL_MS) return;
	// Mark the throttle window NOW (before the await suspends) so concurrent requests
	// in the same tick don't each schedule; scanVideos' single-flight is the backstop.
	if (warm) scanCache!.checkedAt = Date.now();
	void scanVideos(videoDir, ignoreHidden, cheap).catch(() => {
		/* a failed background scan keeps the last-known-good manifest; getFeed never
		   rejects and the next due request retries. */
	});
}

/**
 * Serve-stale-while-revalidate feed read for the REQUEST path. Returns the
 * last-known-good manifest from memory INSTANTLY (zero CIFS I/O) and schedules a
 * background revalidate when due. With no manifest yet, returns empty +
 * `warming:true`. `/api/feed` and the SSR load call this — never `scanVideos`
 * directly (which would block on the CIFS scan).
 */
export function getFeed(
	videoDir: string = config.videoDir,
	ignoreHidden: boolean = config.ignoreHidden,
	cheap: boolean = !config.posters
): FeedResult {
	const key = scanKey(videoDir, ignoreHidden, cheap);
	scheduleRevalidate(videoDir, ignoreHidden, cheap);
	if (scanCache && scanCache.key === key) {
		return { items: scanCache.items, warming: false };
	}
	return { items: [], warming: true };
}

// ---------------------------------------------------------------------------
// Deterministic seeded shuffle (stable client paging across requests)
// ---------------------------------------------------------------------------

/** mulberry32 — small deterministic PRNG. */
function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** Fisher-Yates shuffle seeded by `seed` — deterministic for a given (input, seed). */
export function seededShuffle<T>(items: readonly T[], seed: number): T[] {
	const out = items.slice();
	const rand = mulberry32(seed >>> 0);
	for (let i = out.length - 1; i > 0; i--) {
		const j = Math.floor(rand() * (i + 1));
		[out[i], out[j]] = [out[j], out[i]];
	}
	return out;
}

// ---------------------------------------------------------------------------
// Safe path resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a request's media name to an absolute path under `videoDir`, or
 * `null` if it escapes (separators, `..`, NUL). `name` is the already-decoded
 * route param. Path-traversal probes must never resolve or leak.
 */
export function safeMediaPath(name: string, videoDir: string = config.videoDir): string | null {
	if (name.includes('\0') || name.includes('/') || name.includes('\\')) return null;
	const base = path.basename(name);
	if (base !== name || base === '' || base === '.' || base === '..') return null;
	const dir = path.resolve(videoDir);
	const full = path.join(dir, base);
	if (path.dirname(full) !== dir) return null;
	return full;
}

// ---------------------------------------------------------------------------
// HTTP Range resolver — THE load-bearing piece (SPEC §3, tests/range.test.ts)
// ---------------------------------------------------------------------------

export type RangeResolution =
	| { kind: 'full'; status: 200; length: number }
	| { kind: 'partial'; status: 206; start: number; end: number; length: number }
	| { kind: 'unsatisfiable'; status: 416 };

/**
 * Resolve a `Range` header against a known file `size`.
 *
 * - no/invalid header → full 200 (RFC permits ignoring a malformed Range)
 * - `bytes=s-e` (closed), `bytes=s-` (open), `bytes=-N` (suffix) → 206
 * - start past EOF, end<start, zero-length suffix → 416
 *
 * `end` is the INCLUSIVE last byte (matches HTTP and fs.createReadStream); the
 * caller computes Content-Length as `end - start + 1` from `length`.
 */
export function resolveRange(
	rangeHeader: string | null | undefined,
	size: number
): RangeResolution {
	const full: RangeResolution = { kind: 'full', status: 200, length: size };
	if (!rangeHeader) return full;

	const m = /^bytes=(.+)$/.exec(rangeHeader.trim());
	if (!m) return full;

	// We support a single range; take the first if a list is sent.
	const spec = m[1].split(',')[0].trim();
	const dash = spec.indexOf('-');
	if (dash === -1) return full;

	const startStr = spec.slice(0, dash).trim();
	const endStr = spec.slice(dash + 1).trim();

	let start: number;
	let end: number;

	if (startStr === '') {
		// suffix: bytes=-N (last N bytes)
		if (endStr === '') return full; // "bytes=-" is malformed
		const n = Number(endStr);
		if (!Number.isInteger(n) || n < 0) return full;
		if (n === 0 || size === 0) return { kind: 'unsatisfiable', status: 416 };
		start = Math.max(0, size - n);
		end = size - 1;
	} else {
		const s = Number(startStr);
		if (!Number.isInteger(s) || s < 0) return full;
		start = s;
		if (endStr === '') {
			end = size - 1; // open: bytes=s-
		} else {
			const e = Number(endStr);
			if (!Number.isInteger(e) || e < 0) return full;
			end = e;
		}
		if (size === 0 || start >= size) return { kind: 'unsatisfiable', status: 416 };
		if (end >= size) end = size - 1; // clamp to EOF
		if (end < start) return { kind: 'unsatisfiable', status: 416 };
	}

	return { kind: 'partial', status: 206, start, end, length: end - start + 1 };
}

/** Weak ETag from size + mtime (SPEC §3). */
export function weakETag(size: number, mtimeMs: number): string {
	return `W/"${size.toString(16)}-${Math.floor(mtimeMs).toString(16)}"`;
}
