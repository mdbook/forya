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
}
