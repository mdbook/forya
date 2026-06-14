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

// DATA_DIR is the writable-volume signal — the PREREQUISITE for any persisted
// feature (posters, meta, starred), but on its own it implies NONE of them. We
// derive it once here so the feature gates below can key off it. (0.8.0 decoupled
// "has a volume" from "generate posters" so adding a volume for `starred` can't
// silently turn on 20k-clip poster-gen NOR flip the 0.7.0 cheap-scan to full-stat.)
const dataDir = env.DATA_DIR ?? '';

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
	 *  real `<video src>` (caps simultaneous iOS decoders). Clamped ≥ 0 so a
	 *  nonsensical negative can never shrink the window past the active card. */
	preloadAhead: Math.max(0, parseInt10(env.PRELOAD_AHEAD, 3)),
	preloadBehind: Math.max(0, parseInt10(env.PRELOAD_BEHIND, 2)),
	/** Initial value for the client's autoplay-next preference (advance to the
	 *  next card when a video ends, instead of looping). Client can toggle. */
	autoAdvance: parseBool(env.AUTO_ADVANCE, false),
	/** Optional writable dir forya OWNS for its generated poster/metadata cache
	 *  (0.5). Empty/unset = the feature is OFF: no ffmpeg/ffprobe ever spawns and
	 *  nothing is written anywhere, so the response surface is byte-identical to a
	 *  build without it (the source `VIDEO_DIR` stays `:ro` regardless). Set = forya
	 *  generates + caches posters/metadata under here, writing ONLY here. */
	dataDir,
	/** Poster + metadata GENERATION/serving (0.5; RE-GATED 0.8.0). On iff there's a
	 *  volume AND explicit opt-in: `DATA_DIR` set AND `POSTERS` truthy (default OFF).
	 *  Default-off is fail-safe — a feed that gains `DATA_DIR` only for `starred`
	 *  never auto-storms ffmpeg over its library, and the 0.7.0 cheap-scan stays cheap
	 *  (the scan keys `cheap = !config.posters`, NOT on the bare volume). `best` opts
	 *  in with `POSTERS=1`; `liked`/`favorite` get a volume without it. */
	posters: dataDir !== '' && parseBool(env.POSTERS, false),
	/** The `starred` (favorite-mark) feature (0.8.0). A single small JSON doc with no
	 *  generation, so it gates on the raw volume ALONE — works on every feed that has
	 *  a `DATA_DIR`, independent of `POSTERS`. */
	starred: dataDir !== '',
	/** The SERVER-SIDE `hidden` (hide-from-feed) feature (0.8.3). Mirrors `starred`:
	 *  a single small JSON doc gated on the raw volume ALONE (DATA_DIR set), no
	 *  generation. When on, the feed EXCLUDES hidden names server-side (cross-device);
	 *  when off, the client keeps its local-only (localStorage) hide. Distinct from
	 *  `allowHide` (whether the hide BUTTON is shown) and `ignoreHidden` (skip
	 *  dotfiles in the scan) — three independent concerns that happen to share names. */
	hidden: dataDir !== '',
	/** Diagnostic playback overlay (0.5.4 instrumentation). Default OFF → entirely
	 *  inert in prod (the overlay is gated client-side on this flag and emits no
	 *  events when off). Set `DEBUG_PLAYBACK=1` on an instance to surface a live
	 *  `<video>`/readyState count + a rolling per-card play-event log (attempt /
	 *  reject+err.name / error+code / playing) — to pin the every-~8 autoplay break
	 *  mechanism on-device. Diagnostic only; never enabled on a release deploy. */
	debugPlayback: parseBool(env.DEBUG_PLAYBACK, false),
	/** Build commit SHA, baked at image build (Dockerfile ARG ← CI `--build-arg
	 *  BUILD_SHA=$CI_COMMIT_SHA`). Empty for a plain local build. Surfaced ONLY in
	 *  the DEBUG_PLAYBACK overlay (`build=<sha8>`) so a diagnostic deploy is
	 *  unambiguous about which build is running — never shown in normal use. */
	buildSha: env.BUILD_SHA ?? '',
	// PORT/HOST are consumed natively by adapter-node at startup; surfaced here
	// for completeness and any app-level use.
	port: parseInt10(env.PORT, 3000),
	host: env.HOST ?? '0.0.0.0'
} as const;

export type Config = typeof config;
