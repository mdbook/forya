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
 * play? True only when the card still wants playback and nothing else (user
 * pause, already-playing, hard error) should hold it back. Pure — the caller
 * still guards the actual attempt with its generation token.
 */
export function shouldRetryOnPlayable(s: PlaybackState): boolean {
	return s.active && !s.paused && !s.hasPlayed && !s.errored;
}

/** `HTMLMediaElement.readyState` value: at least the current frame is decoded. */
export const HAVE_CURRENT_DATA = 2;

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
