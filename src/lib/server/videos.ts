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
import type { FeedItem } from '$lib/types';

export const VIDEO_EXTENSIONS = ['.mp4', '.mov', '.webm', '.m4v'] as const;

const MIME_BY_EXT: Record<string, string> = {
	'.mp4': 'video/mp4',
	'.mov': 'video/quicktime',
	'.webm': 'video/webm',
	'.m4v': 'video/x-m4v',
	// Image-gallery frames (TikTok photo posts): served by the SAME /api/media Range endpoint,
	// so this table is where their content-type comes from — without these a frame would serve
	// as application/octet-stream and the browser would download it instead of rendering. Videos
	// are unaffected (their four types are unchanged). Contract A allows jpg/jpeg/png/webp;
	// v0.13.0 adds gif (reddit photo posts — browsers render it natively in <img>, no transcode).
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.png': 'image/png',
	'.webp': 'image/webp',
	'.gif': 'image/gif',
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

/** Contract A gallery frame: `<id>_NN.<ext>` — post id + 2-digit zero-pad carousel index
 *  (01-based) + image ext. `_NN` is ALWAYS present for a multi-image carousel; grouping is by id.
 *  The id STEM is `[a-z0-9]+` (v0.13.0): TikTok ids are numeric, reddit ids are base36 (letters),
 *  and numeric ⊂ base36 so TikTok grouping is byte-identical. The FRAME NUMBER stays pure-digit
 *  `\d{2}` — base36 has no `_`, so the `_NN` suffix is still an unambiguous separator (it, not the
 *  stem's digit-class, is what disambiguates a frame). STILL STRICT on the index: `7_1.jpg`
 *  (1-digit), `7_001.jpg` (3-digit) are rejected, never best-effort grouped. Path traversal is
 *  guarded independently by `safeMediaPath` — `[a-z0-9]` excludes `/`/`\`/`.`, so the id can't
 *  smuggle a separator. A bare `<id>.<img-ext>` (no `_NN`) is a SINGLE-image post — SINGLE_IMAGE_RE.
 *  Ext set incl. `.gif` (v0.13.0). */
const FRAME_RE = /^([a-z0-9]+)_(\d{2})\.(jpg|jpeg|png|webp|gif)$/i;

/** Contract A gallery soundtrack: a bare pure-digit-id audio file `<id>.{m4a,mp3}` (round-3) —
 *  the same `<id>` stem as the post's `<id>_NN.*` frames. It is gallery-audio IFF matching frames
 *  exist (the disambiguator vs a stray audio file), which is enforced by only attaching it to an
 *  emitted MULTI-frame gallery item (an id with no frames never becomes a gallery, so its audio is
 *  dropped). The id STAYS pure-digit `\d+` (v0.13.0 DECISION, not an oversight): only TikTok photo
 *  posts carry a soundtrack and TikTok ids are numeric — reddit galleries have no audio, so there
 *  is no base36 soundtrack to match. Disjoint from a video's `<id>.{mp4,…}` and a single image's
 *  `<id>.{jpg,…}` (different ext sets). */
const AUDIO_RE = /^(\d+)\.(m4a|mp3)$/i;

/** Reddit-style single-image post (v0.13.0): a bare `<id>.<img-ext>` with NO `_NN` frame suffix —
 *  reddit's dominant shape (a photo post is usually one image, not a carousel). Rendered as a
 *  gallery of ONE frame: forya already has the gallery item type + a carousel that draws a 1-frame
 *  gallery with no nav chrome, so this reuses all of it (no new item type). DISJOINT from FRAME_RE:
 *  a frame name has a `_NN`, and the `[a-z0-9]+` stem can't cross the `_`, so `<id>_01.jpg` never
 *  matches this and `<id>.jpg` never matches FRAME_RE. Also disjoint from a video (`<id>.<vid-ext>`)
 *  and a soundtrack (`<id>.{m4a,mp3}`) — different ext sets. Same image ext set as FRAME_RE incl.
 *  `.gif`. NOTE: this changes behavior for ANY bare image in ANY feed — safe because forya's posters
 *  live under DATA_DIR/posters (poster.ts), NOT the scanned `:ro` VIDEO_DIR, and TikTok never writes
 *  a bare image (always `_NN`), so no existing feed has stray bare images to newly surface. */
const SINGLE_IMAGE_RE = /^([a-z0-9]+)\.(jpg|jpeg|png|webp|gif)$/i;

/** Library-layout milestone (v0.14.0): the reader is layout-AGNOSTIC — it groups a gallery's frames by
 *  the bare `<id>` regardless of whether they live flat in the feed root (`<id>_NN.<ext>`), loose under a
 *  `galleries/` subdir, or nested per-post in `galleries/<id>/NN.<ext>`. `NESTED_FRAME_RE` matches a frame
 *  file *inside* a `galleries/<id>/` subdir, named just `NN.<ext>` (the id comes from the subdir name). Its
 *  public/manifest name is NORMALIZED to the flat form `<id>_NN.<ext>` so the URL + starred/hidden/share
 *  identity are layout-independent (a file moving flat→nested keeps the same public name); the serve-side
 *  `resolveMediaCandidates` probe maps that normalized name back to whichever physical location holds the bytes. */
const NESTED_FRAME_RE = /^(\d{2})\.(jpg|jpeg|png|webp|gif)$/i;

/** A `galleries/<id>/` subdir name must be a bare id (`[a-z0-9]+`, same charset as FRAME_RE's stem). This
 *  is the M1 (review #1777) charset guard: it runs at scan time AND is re-derived by the serve probe, so a
 *  subdir whose name carries a separator/`..`/dot can never be walked or joined into a served path. */
const ID_RE = /^[a-z0-9]+$/i;

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
	// Layout-agnostic accumulators (v0.14.0). A gallery's frames are grouped by the bare `<id>` across ALL
	// recognized layouts (root-flat `<id>_NN.<ext>` / `galleries/`-flat / nested `galleries/<id>/NN.<ext>`)
	// and deduped by the 2-digit index, with a source RANK so the same index found in two layouts resolves
	// deterministically (nested-wins). VIDEOS are keyed by full basename — NOT unioned by id — so identity
	// stays `<id>.<ext>` and a video + a same-`<id>` gallery are TWO distinct items (review #1777). Frames/
	// audio/singles never per-file stat (cheap on any path); only a video stats, at its real physical path.
	const RANK_ROOT = 0;
	const RANK_GALLERIES_FLAT = 1;
	const RANK_NESTED = 2;
	const galleries: Record<string, Map<string, { name: string; type: string; rank: number }>> = {};
	const audioById: Record<string, { name: string; type: string; rank: number }> = {};
	const singleImages: Record<string, { name: string; type: string; rank: number }> = {};
	const videos: Record<string, FeedItem> = {};

	// Accumulate a gallery frame under `id` at index `nn`, with public (normalized flat-form) name
	// `publicName` (ext case PRESERVED — physical files are case-sensitive). Higher rank wins a same-index
	// collision (nested > galleries-flat > root); cross-layout copies are byte-identical so this is a
	// determinism tiebreak, not a content choice.
	const addFrame = (id: string, nn: string, publicName: string, rank: number) => {
		const g = (galleries[id] ??= new Map());
		const prev = g.get(nn);
		if (!prev || rank > prev.rank)
			g.set(nn, { name: publicName, type: mimeFromExt(publicName), rank });
	};
	// Accumulate a gallery soundtrack under `id`. Prefer `.m4a` (AAC) over `.mp3` (as pre-v0.14.0); among
	// the same audio class, higher rank wins. Attached to the gallery ONLY if `id` has frames (emit below).
	const addAudio = (id: string, publicName: string, isM4a: boolean, rank: number) => {
		const prev = audioById[id];
		const prevM4a = prev?.type === 'audio/mp4';
		if (!prev || (isM4a && !prevM4a) || (isM4a === prevM4a && rank > prev.rank)) {
			audioById[id] = { name: publicName, type: mimeFromExt(publicName), rank };
		}
	};
	// Accumulate a bare single image under `id` (reddit's 1-image post → 1-frame gallery). Higher rank wins.
	const addSingle = (id: string, publicName: string, rank: number) => {
		const prev = singleImages[id];
		if (!prev || rank > prev.rank)
			singleImages[id] = { name: publicName, type: mimeFromExt(publicName), rank };
	};
	// Accumulate a video, keyed + identified by its full basename (deduped across root/`videos/` — same
	// bytes). Stats its REAL physical path on the poster (non-cheap) path only.
	const addVideo = async (name: string, physicalPath: string) => {
		if (videos[name]) return;
		const item: FeedItem = {
			name,
			url: `/api/media/${encodeURIComponent(name)}`,
			type: mimeFromExt(name)
		};
		if (!cheap) {
			try {
				const st = await fsp.stat(physicalPath);
				item.size = st.size;
				item.mtime = st.mtimeMs;
			} catch {
				return;
			}
		}
		videos[name] = item;
	};
	// Classify one FLAT-named file (root or `galleries/`-flat) into the accumulators at the given rank.
	// Same matcher order + semantics as pre-v0.14.0 (frame → audio → single → video → ignore); the public
	// name IS the physical basename here, so a flat file's URL/identity is byte-identical to before.
	const classifyFlat = async (fileName: string, rank: number, physicalPath: string) => {
		const fm = FRAME_RE.exec(fileName);
		if (fm) return void addFrame(fm[1], fm[2], fileName, rank);
		const am = AUDIO_RE.exec(fileName);
		if (am) return void addAudio(am[1], fileName, am[2].toLowerCase() === 'm4a', rank);
		const sm = SINGLE_IMAGE_RE.exec(fileName);
		if (sm) return void addSingle(sm[1], fileName, rank);
		if (isVideoFile(fileName)) await addVideo(fileName, physicalPath);
	};
	// 1. Root walk (flat — byte-identical classification to pre-v0.14.0) + detect the OPTIONAL typed
	//    subdirs. A pure-flat library has no `galleries/`/`videos/` dirents → the subdir walks below never
	//    fire → zero extra cost (AC13; the favorite cheap-scan tripwire holds).
	let hasGalleries = false;
	let hasVideos = false;
	for (const ent of entries) {
		const name = ent.name;
		if (ent.isDirectory()) {
			if (name === 'galleries') hasGalleries = true;
			else if (name === 'videos') hasVideos = true;
			continue; // typed subdirs walked below; any other subdir is ignored (as before)
		}
		if (!ent.isFile()) continue;
		if (ignoreHidden && isHidden(name)) continue;
		await classifyFlat(name, RANK_ROOT, path.join(videoDir, name));
	}

	// 2. `galleries/` subdir (auto-detected): its FILES are `galleries/`-flat frames/audio/singles
	//    (rank 1); its SUBDIRS are nested per-post galleries `galleries/<id>/NN.<ext>` (rank 2). readdir is
	//    cheap (no per-file stat); nesting's standing cost is O(#galleries) readdirs (§2.1), background-only.
	if (hasGalleries) {
		const gdir = path.join(videoDir, 'galleries');
		let gents: import('node:fs').Dirent[];
		try {
			gents = await fsp.readdir(gdir, { withFileTypes: true });
		} catch {
			gents = [];
		}
		for (const ent of gents) {
			const gname = ent.name;
			if (ent.isDirectory()) {
				// Nested per-post gallery. The subdir name IS the id — guard its charset (M1, review #1777):
				// `ID_RE` excludes separators/`..`/dots, so it can never be walked or joined into a served
				// path here OR re-derived by the serve probe. Frames inside are `NN.<ext>` (id from the dir)
				// or a flat-named `<id>_NN.<ext>`; the soundtrack is `<id>.{m4a,mp3}`. Public names are
				// NORMALIZED to the flat form so the manifest/URL/starred/hidden/share identity is
				// layout-independent (a frame moving flat↔nested keeps the same public name).
				const id = gname;
				if (!ID_RE.test(id)) continue;
				let nents;
				try {
					nents = await fsp.readdir(path.join(gdir, id), { withFileTypes: true });
				} catch {
					continue;
				}
				for (const nent of nents) {
					if (!nent.isFile()) continue;
					const fn = nent.name;
					if (ignoreHidden && isHidden(fn)) continue;
					const nfm = NESTED_FRAME_RE.exec(fn); // `NN.<ext>` → public `<id>_NN.<ext>`
					if (nfm) {
						addFrame(id, nfm[1], `${id}_${fn}`, RANK_NESTED);
						continue;
					}
					const ffm = FRAME_RE.exec(fn); // a flat-named frame that happens to live in the subdir
					if (ffm && ffm[1] === id) {
						addFrame(id, ffm[2], fn, RANK_NESTED);
						continue;
					}
					const nam = AUDIO_RE.exec(fn); // `<id>.{m4a,mp3}` soundtrack beside the frames
					if (nam && nam[1] === id) {
						addAudio(id, fn, nam[2].toLowerCase() === 'm4a', RANK_NESTED);
					}
				}
				continue;
			}
			if (!ent.isFile()) continue;
			if (ignoreHidden && isHidden(gname)) continue;
			await classifyFlat(gname, RANK_GALLERIES_FLAT, path.join(gdir, gname));
		}
	}

	// 3. `videos/` subdir (auto-detected): plain videos, deduped by basename against the root.
	if (hasVideos) {
		const vdir = path.join(videoDir, 'videos');
		let vents: import('node:fs').Dirent[];
		try {
			vents = await fsp.readdir(vdir, { withFileTypes: true });
		} catch {
			vents = [];
		}
		for (const ent of vents) {
			if (!ent.isFile()) continue;
			const vname = ent.name;
			if (ignoreHidden && isHidden(vname)) continue;
			if (isVideoFile(vname)) await addVideo(vname, path.join(vdir, vname));
		}
	}

	// Emit VIDEOS (deduped by basename; identity = full `<id>.<ext>`, unchanged from pre-v0.14.0).
	for (const name in videos) items.push(videos[name]);

	// Emit one gallery FeedItem per post id: frames ordered by the 2-digit `NN` (zero-padded → lexicographic
	// === carousel order), UNIONED across layouts + deduped by index (nested-wins) in `galleries[id]`.
	// `name` = the bare `<id>` (one post = one unit for starred/hidden/share/manifest keying; no extension,
	// so it can't collide with a video's `<id>.<ext>`). `url`/`type` mirror the first frame; the carousel
	// reads `media[]`. A frame's `name`/`url` is its NORMALIZED flat-form public name (`<id>_NN.<ext>`)
	// regardless of physical layout — `resolveMediaCandidates` maps it to the bytes. No size/mtime.
	for (const id in galleries) {
		const frames = [...galleries[id].entries()]
			.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
			.map(([, f]) => ({
				name: f.name,
				url: `/api/media/${encodeURIComponent(f.name)}`,
				type: f.type
			}));
		const item: FeedItem = { name: id, url: frames[0].url, type: frames[0].type, media: frames };
		// Attach the soundtrack IFF this id (which HAS frames → is a gallery) also has one. The
		// presence-check is the "gallery-audio IFF frames exist" disambiguator: a frame-less orphan audio
		// (tiktok #1785 — genuine music posts / yt-dlp leftovers) has no `galleries[id]`, so it never
		// reaches this loop and is dropped, under BOTH flat and nested. Absent field ⇒ silent gallery.
		const a = audioById[id];
		if (a)
			item.audio = { name: a.name, url: `/api/media/${encodeURIComponent(a.name)}`, type: a.type };
		items.push(item);
	}

	// Single-image posts → single-frame galleries. Reuses the gallery item type; bare `<id>` name. Skip an
	// id that already produced a multi-frame gallery (a post is single OR multi — multi wins, no duplicate).
	for (const id in singleImages) {
		if (galleries[id]) continue;
		const s = singleImages[id];
		const frame = { name: s.name, url: `/api/media/${encodeURIComponent(s.name)}`, type: s.type };
		items.push({ name: id, url: frame.url, type: frame.type, media: [frame] });
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

/**
 * Layout-agnostic serve resolution (v0.14.0). Given a media item's NORMALIZED public name (always a
 * separator-free flat-form basename — `<id>.<ext>`, `<id>_NN.<ext>`), return the ordered list of ABSOLUTE
 * candidate physical paths to try, so the byte path can serve the same item whether it lives flat in the
 * root or under `galleries/`/`galleries/<id>/`/`videos/`. The caller lstat-probes these in order and serves
 * the first regular (non-symlink) file (AC8 on-miss probe — manifest-independent, so a cold container still
 * serves). Order is ROOT FIRST so a pure-flat library hits on the first lstat = zero regression (AC13).
 *
 * SECURITY (AC4 / M1, review #1777): the incoming `name` is lexically guarded exactly as `safeMediaPath`
 * (reject `\0`/`/`/`\`/non-basename/`.`/`..`) so it can never carry a subpath; the `<id>` used to build a
 * `galleries/<id>/…` candidate is re-validated against `ID_RE` (charset excludes separators/`..`/dots); and
 * every candidate is containment-re-asserted (`resolve(...)` must stay strictly under the root) before it is
 * returned. Cross-layout copies are byte-identical, so root-first order is a cost choice, not a correctness
 * one. Returns `[]` for an invalid name (→ caller 404s).
 */
export function resolveMediaCandidates(name: string, videoDir: string = config.videoDir): string[] {
	if (name.includes('\0') || name.includes('/') || name.includes('\\')) return [];
	const base = path.basename(name);
	if (base !== name || base === '' || base === '.' || base === '..') return [];
	const dir = path.resolve(videoDir);

	const out: string[] = [];
	const add = (...segs: string[]) => {
		const full = path.resolve(dir, ...segs);
		if (full !== dir && full.startsWith(dir + path.sep)) out.push(full); // containment re-assert (AC4)
	};

	add(base); // ROOT first (flat — today's reality → 1 lstat, zero regression)

	const fm = FRAME_RE.exec(base);
	if (fm && ID_RE.test(fm[1])) {
		add('galleries', base); // galleries-flat: galleries/<id>_NN.<ext>
		add('galleries', fm[1], `${fm[2]}.${fm[3]}`); // nested: galleries/<id>/NN.<ext>
		return out;
	}
	const am = AUDIO_RE.exec(base);
	if (am && ID_RE.test(am[1])) {
		add('galleries', base); // galleries-flat: galleries/<id>.<audio>
		add('galleries', am[1], base); // nested: galleries/<id>/<id>.<audio>
		return out;
	}
	if (SINGLE_IMAGE_RE.test(base)) {
		add('galleries', base); // galleries-flat single image: galleries/<id>.<img>
		return out;
	}
	if (isVideoFile(base)) add('videos', base); // videos/<id>.<ext>
	return out;
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
