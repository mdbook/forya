// Shared feed types (client + server). Populated by the dir scan in
// src/lib/server/videos.ts (milestone 02).

/** A single playable item in the feed manifest. */
export interface FeedItem {
	/** Original filename (basename) under VIDEO_DIR. */
	name: string;
	/** Media URL: `/api/media/<encoded name>`. */
	url: string;
	/** File size in bytes. */
	size: number;
	/** Last-modified time, epoch ms. */
	mtime: number;
	/** MIME type, e.g. `video/mp4`. */
	type: string;
	// Optional probed metadata (0.5/M2), present only when the DATA_DIR feature is
	// on AND this item has been probed. ADDITIVE — older clients ignore them and
	// the manifest is byte-identical without DATA_DIR. `width`/`height` let the
	// client pre-set object-fit before the <video> loads (kills the fit-jump);
	// `duration` seeds the seek bar before load.
	/** Intrinsic video width in px. */
	width?: number;
	/** Intrinsic video height in px. */
	height?: number;
	/** Duration in seconds. */
	duration?: number;
}

/** The `/api/feed` response shape. */
export interface Feed {
	/** FEED_NAME — title/branding for this instance. */
	feed: string;
	items: FeedItem[];
}

/** Client-relevant runtime settings, surfaced from `config` via the page load
 *  (the server stays the source of truth; the client never reads env). */
export interface FeedSettings {
	/** Show the per-card hide ("trash") control (ALLOW_HIDE). */
	allowHide: boolean;
	/** Lazy-load window sizes (PRELOAD_AHEAD / PRELOAD_BEHIND). */
	preloadAhead: number;
	preloadBehind: number;
	/** Initial autoplay-next preference (AUTO_ADVANCE). */
	autoAdvance: boolean;
	/** Whether generated posters are available (DATA_DIR set, 0.5). When false the
	 *  client never requests `/api/poster`, so a disabled instance makes no extra
	 *  requests. */
	posters: boolean;
	/** Diagnostic playback overlay (DEBUG_PLAYBACK, 0.5.4). Default false → the
	 *  overlay never renders and VideoCard emits no debug events. */
	debugPlayback: boolean;
	/** Build commit SHA (0.5.4), shown in the debug overlay so a diagnostic deploy
	 *  is unambiguous about which build is live. Empty for a local build. */
	buildSha: string;
}
