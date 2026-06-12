// The feed's lazy-load window decision, pure so it's unit-testable (guarded by
// tests/window.test.ts). Lifted out of Feed.svelte in 0.3.1 so the "active card
// is ALWAYS live" invariant — the thing the black-screen virtualization leans
// on — is provable, not just asserted in a comment.
//
// `live` decides BOTH whether the card carries a real `<video src>` AND (0.3.1)
// whether Feed mounts the heavy VideoCard at all; off-window cards render a cheap
// placeholder. The window follows the active card and is direction-biased:
// scrolling up (dir < 0) swaps ahead/behind so sustained back-scroll starts
// loading the previously-uncached cards.

export interface WindowConfig {
	preloadAhead: number;
	preloadBehind: number;
}

export interface WindowState {
	/** Inside the window → carries a real `<video src>` and mounts the heavy
	 *  VideoCard. The active card (d === 0) is ALWAYS live, in either direction. */
	live: boolean;
	preload: 'auto' | 'metadata' | 'none';
}

/**
 * Window membership + preload hint for `index`, relative to `activeIndex`, the
 * travel direction `dir` (+1 down, −1 up), and whether the active card is yet
 * playing (`activeReady`, 0.4).
 *
 * Mount window (`live`) is unchanged: `[active − behind, active + ahead]`, with
 * the active card always live. What changed is the PRELOAD hint, which is now
 * priority-gated:
 *
 * - The active card (`d === 0`) ALWAYS fetches (`auto`) — current-first, never
 *   starved, regardless of readiness.
 * - Until the active card reaches `playing` (`activeReady === false`), every
 *   OTHER in-window card stays mounted but `preload: 'none'` — so a cold/slow
 *   start pulls exactly one stream, and a failing active never has an eager
 *   neighbour decoding alongside it (the 0.4 cascade overlap). On scroll,
 *   `activeReady` resets, so the about-to-play card instantly becomes the sole
 *   fetch.
 * - Once the active card is playing (`activeReady === true`), neighbours escalate
 *   to the gradient: the immediate neighbour in the travel direction → `auto`,
 *   the rest of the window → `metadata`.
 * - Outside the window → not live, `none`.
 *
 * `activeReady` defaults to `true` (the steady-state gradient) so callers/tests
 * that don't thread readiness get the pre-0.4 behaviour.
 */
export function feedWindow(
	index: number,
	activeIndex: number,
	dir: number,
	{ preloadAhead, preloadBehind }: WindowConfig,
	activeReady: boolean = true
): WindowState {
	const ahead = dir < 0 ? preloadBehind : preloadAhead;
	const behind = dir < 0 ? preloadAhead : preloadBehind;
	const d = index - activeIndex;
	if (d < -behind || d > ahead) return { live: false, preload: 'none' };
	if (d === 0) return { live: true, preload: 'auto' }; // current-first, always
	if (!activeReady) return { live: true, preload: 'none' }; // defer neighbours
	const immediate = dir < 0 ? -1 : 1;
	return { live: true, preload: d === immediate ? 'auto' : 'metadata' };
}
