// Gallery auto-cycle (GIF-pause/gallery-autoscroll milestone) — the pure "what should the
// dwell timer do next" decision for a photo-post carousel. Extracted here (not inlined in
// ImageCarousel's $effect) so the whole policy surface is a truth table a test can pin,
// mirroring `playback.ts`'s retry decision and `pool.ts`'s slot math: pure logic in $lib,
// the component only wires it to a setTimeout.
//
// WHY THIS SHAPE: before this milestone the carousel's dwell advanced the FEED after an idle
// period, which meant feed-autoscroll could leave a gallery having shown only its cover. The
// operator's requirement — "in feed-autoscroll mode, do NOT advance to the next post until
// the current gallery has cycled through ALL its images" — is satisfied BY CONSTRUCTION here
// rather than by a separate rule: `feed` is reachable only from the LAST frame, so there is no
// path that leaves a gallery early. No counter, no "has cycled" flag, no extra state.

/** Per-image dwell before auto-advancing to the next FRAME. Device-tunable (see the carousel's
 *  other gesture/timing constants — real cadence is a feel judgement, not derivable here). */
export const IMAGE_DWELL_MS = 3500;

/** Dwell on the LAST frame before auto-advancing the FEED. Longer than the per-image dwell so
 *  the final image gets a real look before the post scrolls away. This is the pre-milestone
 *  dwell value, preserved so single-image posts behave exactly as they did before. */
export const FEED_DWELL_MS = 8000;

/** MIME of an animated GIF frame. v0.13.0 made a bare `<id>.gif` a single-frame gallery
 *  (reddit's shape), rendered as a plain `<img>` — there is no transcode and no `<video>`. */
export const GIF_MIME = 'image/gif';

/** Does this gallery contain a GIF frame?
 *
 *  Load-bearing for the pause TRIGGER, not just for rendering: a GIF post is usually
 *  audioless, so gating "tap = pause" on a soundtrack alone leaves the tap dead on exactly
 *  the content the feature was asked for (review #2199). Structurally typed so this module
 *  stays dependency-free. */
export function hasGifFrame(frames: readonly { type: string }[] | undefined): boolean {
	return !!frames?.some((f) => f.type === GIF_MIME);
}

export interface GalleryStepInput {
	/** This card is the active (in-viewport) one. Only the active gallery ever auto-cycles. */
	active: boolean;
	/** Feed's auto-advance ("Autoplay next") mode — gates FEED advance only, never frame advance. */
	autoAdvance: boolean;
	/** This post is HELD by the user ⇒ neither frames nor the feed advance.
	 *
	 *  NOTE (design gate §3, pending review): what the component feeds this is exactly the open
	 *  question. Under the recommended "one paused concept per post" it is the existing
	 *  `galleryPaused` (tap = pause the post: soundtrack + GIF + cycle). Under the alternatives
	 *  it stays `false` and pausing the soundtrack leaves the images cycling. Either way the
	 *  DECISION below is unchanged — only the wiring differs, which is why this milestone's
	 *  logic could be built before that call is made. */
	held: boolean;
	/** Current frame index (0-based). */
	index: number;
	/** Number of frames in this gallery. */
	frameCount: number;
}

/** What the dwell timer should do next, and after how long. `none` ⇒ arm no timer at all. */
export type GalleryStep =
	| { kind: 'frame'; delayMs: number }
	| { kind: 'feed'; delayMs: number }
	| { kind: 'none' };

const NONE: GalleryStep = { kind: 'none' };

/**
 * Decide the next auto-cycle step for a gallery card.
 *
 * Order matters: inactive / empty / held all short-circuit before any advance is considered,
 * so a held or off-screen gallery arms nothing (the component's effect teardown then clears
 * any in-flight timer).
 */
export function nextGalleryStep(input: GalleryStepInput): GalleryStep {
	const { active, autoAdvance, held, index, frameCount } = input;

	if (!active || frameCount <= 0 || held) return NONE;

	// `>=` not `===`: a stale/out-of-range index (a frame list that shrank under a re-scan)
	// counts as "at the end" rather than falling through to an endless frame-advance.
	const atLastFrame = index >= frameCount - 1;

	// Not at the end ⇒ step to the next IMAGE. Never touches the feed, so this happens in both
	// manual and autoscroll mode — the operator asked for galleries to cycle on a timer, and the
	// separate "in feed-autoscroll mode…" clause only constrains when the FEED may move.
	if (!atLastFrame) return { kind: 'frame', delayMs: IMAGE_DWELL_MS };

	// At the end: the feed moves on ONLY in autoscroll mode. In manual mode we stop here rather
	// than looping back to the cover — a reader who scrolled to a photo post shouldn't be cycled
	// at forever, and looping would also re-arm the timer indefinitely on a parked card.
	return autoAdvance ? { kind: 'feed', delayMs: FEED_DWELL_MS } : NONE;
}
