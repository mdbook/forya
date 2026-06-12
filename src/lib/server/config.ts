// Runtime configuration, read once from the environment (SPEC §3).
//
// We use $env/dynamic/private because the image is built once and configured
// per-container at run time (VIDEO_DIR / FEED_NAME differ across the three
// homelab instances). Never hardcode a video path or the feed name where an
// env var belongs.
import { env } from '$env/dynamic/private';

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
	// PORT/HOST are consumed natively by adapter-node at startup; surfaced here
	// for completeness and any app-level use.
	port: parseInt10(env.PORT, 3000),
	host: env.HOST ?? '0.0.0.0'
} as const;

export type Config = typeof config;
