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
