// Runtime configuration, read once from the environment (SPEC §3).
//
// The image is built once and configured per-container at run time (VIDEO_DIR /
// FEED_NAME differ across the three homelab instances), so this must be read at
// runtime, never baked at build. We read process.env directly: with
// adapter-node, process.env IS the runtime env source that $env/dynamic/private
// proxies — reading it here is equivalent at runtime and stays testable (the
// $env/dynamic/private virtual module is a build-time snapshot under vitest).
// Never hardcode a video path or the feed name where an env var belongs.
const env = process.env;

function parseBool(value: string | undefined, fallback: boolean): boolean {
	if (value === undefined || value === '') return fallback;
	return !['0', 'false', 'no', 'off'].includes(value.toLowerCase());
}

function parseInt10(value: string | undefined, fallback: number): number {
	const n = Number.parseInt(value ?? '', 10);
	return Number.isFinite(n) ? n : fallback;
}

export const config = {
	/** `:ro` input dir scanned for videos. */
	videoDir: env.VIDEO_DIR ?? '/srv/videos',
	/** Drives title/branding, PWA name, and client storage keys. */
	feedName: env.FEED_NAME ?? 'feed',
	/** Hide dotfiles + `.partial` (tiktok-sync's mid-download files). */
	ignoreHidden: parseBool(env.IGNORE_HIDDEN, true),
	/** Surface the per-card hide ("trash") control. Hiding is client-side only
	 *  (localStorage) — it never touches disk, so the `:ro` VIDEO_DIR contract
	 *  holds. Default OFF: instances opt in per-deployment. */
	allowHide: parseBool(env.ALLOW_HIDE, false),
	/** Lazy-load window: how many cards ahead of / behind the active one carry a
	 *  real `<video src>` (caps simultaneous iOS decoders). */
	preloadAhead: parseInt10(env.PRELOAD_AHEAD, 3),
	preloadBehind: parseInt10(env.PRELOAD_BEHIND, 2),
	/** Initial value for the client's autoplay-next preference (advance to the
	 *  next card when a video ends, instead of looping). Client can toggle. */
	autoAdvance: parseBool(env.AUTO_ADVANCE, false),
	// PORT/HOST are consumed natively by adapter-node at startup; surfaced here
	// for completeness and any app-level use.
	port: parseInt10(env.PORT, 3000),
	host: env.HOST ?? '0.0.0.0'
} as const;

export type Config = typeof config;
