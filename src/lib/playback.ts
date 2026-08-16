// Pure playback-retry decision (0.5.1). Extracted from VideoCard so the policy is
// unit-testable (no component-test framework here — same pattern as window.ts /
// fit.ts). The component wires this to the `<video>`'s `canplay`/`loadeddata`
// events: a muted-autoplay attempt can transiently reject before the media is
// buffered (a freshly-mounted card the feed just scrolled to, over a slow CIFS
// origin), and the 0.4.0 single-rAF retry window (~16ms) is far too short for
// that first buffer — so the card would go permanently dark with no self-heal.
// When the element later reports it CAN play, we re-attempt — but only if the
// card still wants to be playing.

export interface PlaybackState {
	/** This card is the active (visible) one — only the active card auto-plays. */
	active: boolean;
	/** The user explicitly paused — respect that, never auto-resume over them. */
	paused: boolean;
	/** Already reached `playing` and revealed — nothing to recover. */
	hasPlayed: boolean;
	/** A genuine media/decode `error` fired (decoder released) — don't loop on a
	 *  broken source; recovery there is a tap or re-activation, not `canplay`. */
	errored: boolean;
}

/**
 * Should an active card re-attempt `play()` now that its media reports it can
 * play? True when the card still wants playback and nothing else (user pause,
 * already-playing, hard error) holds it back. The re-attempt is ALWAYS a MUTED
 * play (the caller's tryPlayActive forces `muted` on a fresh/paused start), so it
 * is cure-safe pre-bless: the 0.6.1 model muted-autoplays the active card from
 * load (reverting 0.6.0's start-paused), and this self-heal recovers a cold card
 * whose first muted-autoplay rejected before its buffer arrived. Audible output is
 * gated separately — only a blessed, gesture-unmuted element is ever unmuted — so a
 * `blessed` check here would merely suppress the muted recovery, not protect the
 * cure (0.6.0's M2.5 gate was only needed while pre-bless was start-paused). Pure —
 * the caller still guards the actual attempt with its generation token.
 */
export function shouldRetryOnPlayable(s: PlaybackState): boolean {
	return s.active && !s.paused && !s.hasPlayed && !s.errored;
}

/** `HTMLMediaElement.readyState` value: at least the current frame is decoded. */
export const HAVE_CURRENT_DATA = 2;

// ── Hold-to-speed (0.16) ──────────────────────────────────────────────────────
// Press-and-hold the LEFT THIRD of a card → the video plays fast; release → normal.
// The zone test is pure so the "which third" boundary is pinned by a test rather than
// living only in a component; VideoCard owns the timers and Feed owns the element.

/** Playback rate while held. 2× is the TikTok/YouTube hold-to-speed standard; the
 *  operator's ticket didn't name a number, so this ONE constant is the dial. */
export const HOLD_SPEED = 2;

/** How long a press must last before it counts as a hold rather than a tap. Long
 *  enough that a normal play/pause tap never blips the speed. */
export const HOLD_MS = 200;

/** Movement (px) that reclassifies a press as a scroll and cancels the pending hold.
 *  Touch scrolling usually fires `pointercancel` too, but not before this timer on a
 *  slow drag — so the slop is the one that actually holds on iOS. */
export const HOLD_SLOP = 10;

/** Fraction of the card's width that is the speed zone. */
export const SPEED_ZONE = 1 / 3;

/** Is this press inside the left-third speed zone? `clientX` and the card's own
 *  bounding rect, so it follows the card on any viewport (no hardcoded px). */
export function inSpeedZone(clientX: number, rectLeft: number, rectWidth: number): boolean {
	if (!(rectWidth > 0)) return false;
	return clientX - rectLeft < rectWidth * SPEED_ZONE;
}

/** Has the finger moved far enough from the press origin to be a scroll, not a hold? */
export function movedTooFar(dx: number, dy: number): boolean {
	return Math.hypot(dx, dy) > HOLD_SLOP;
}

/**
 * Is the media already playable (has current data) at the moment a `play()`
 * attempt rejected? If so the rejection was a transient decoder-handover race,
 * NOT a buffering gap — `canplay`/`loadeddata` already fired and won't re-fire,
 * so the event-driven self-heal can't catch it; the caller schedules one bounded
 * delayed re-attempt instead. A not-yet-buffered card (readyState below this)
 * is left to the `canplay` path, which fires when its buffer arrives.
 */
export function isMediaReady(readyState: number): boolean {
	return readyState >= HAVE_CURRENT_DATA;
}
