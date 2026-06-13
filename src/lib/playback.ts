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
	/** The pool has been blessed — the user turned sound on at least once this session
	 *  (0.6 pooled model). The `canplay` self-heal is a POST-bless recovery: pre-bless the
	 *  active card must stay genuinely IDLE (start-paused) so the first gesture's play()
	 *  mints iOS's per-element audible-output grant. Muted-autoplaying it pre-bless leaves
	 *  it mid-muted-autoplay, which can't then be cleanly blessed in the gesture → the
	 *  first-bless-pause / two-tap. A prewarm-accelerated `canplay` can land in the brief
	 *  window where the IO callback has cleared `paused` but driveActive hasn't re-set it
	 *  yet, so guarding on `paused` alone is racy — this gate closes it. (Pre-0.6 single-
	 *  element builds had no bless step and are always blessed by construction.) */
	blessed: boolean;
}

/**
 * Should an active card re-attempt `play()` now that its media reports it can
 * play? True only when the pool is blessed AND the card still wants playback and
 * nothing else (user pause, already-playing, hard error) holds it back. The
 * `blessed` gate is the cure-shape boundary (0.6): pre-bless the active card stays
 * idle for the initiating gesture, so the self-heal must never muted-autoplay it.
 * Pure — the caller still guards the actual attempt with its generation token.
 */
export function shouldRetryOnPlayable(s: PlaybackState): boolean {
	return s.blessed && s.active && !s.paused && !s.hasPlayed && !s.errored;
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

/**
 * Should Feed's gesture handler fire a synchronous `play()` on the active card?
 *
 * On iOS a single muted-`play()` rejection (the ~1/8 trigger) revokes autoplay
 * permission for the WHOLE document until a real user gesture — after which every
 * programmatic `play()` rejects, INCLUDING the 0.5.1 self-heal (the block is
 * gesture-level, not buffer-level). The only cure is a `play()` call running
 * SYNCHRONOUSLY inside a user gesture's call stack, which re-grants permission
 * document-wide; the active card then plays and every later card autoplays again
 * ("one tap unlocks all"). This decides whether to fire that in-gesture retry:
 * only when the active card is currently autoplay-`blocked`.
 *
 * Deliberately NOT keyed on a user pause — `blocked` (autoplay rejected) is a
 * distinct flag from `paused` (the user tapped to pause), so the gesture-unlock
 * can never fight an intentional pause. Pure; the caller still performs the
 * actual in-gesture `play()` (a later microtask/$effect would NOT be in the
 * gesture stack and iOS would still reject).
 *
 * `moved` (0.5.4): the gesture must have been a real scroll-drag, NOT a stationary
 * tap. A discrete tap is already handled by VideoCard's `togglePlay` (which itself
 * plays in-gesture); firing the unlock on a tap too double-drives the play() and
 * the tap's synthesized `click` → `togglePlay` then PAUSES it (the 0.5.3 two-tap
 * regression). So the unlock fires only on a touch that actually moved — the
 * scroll-recovery case it exists for.
 */
export function shouldGestureUnlock(s: { activeBlocked: boolean; moved: boolean }): boolean {
	return s.activeBlocked && s.moved;
}
