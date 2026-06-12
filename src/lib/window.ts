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
 * Window membership + preload hint for `index`, relative to `activeIndex` and
 * the travel direction `dir` (+1 down, −1 up).
 *
 * - active (`d === 0`) and the immediate neighbour in the travel direction →
 *   `auto` (buffer aggressively); rest of the window → `metadata`.
 * - outside `[active − behind, active + ahead]` → not live, `none`.
 */
export function feedWindow(
	index: number,
	activeIndex: number,
	dir: number,
	{ preloadAhead, preloadBehind }: WindowConfig
): WindowState {
	const ahead = dir < 0 ? preloadBehind : preloadAhead;
	const behind = dir < 0 ? preloadAhead : preloadBehind;
	const d = index - activeIndex;
	if (d < -behind || d > ahead) return { live: false, preload: 'none' };
	const immediate = dir < 0 ? -1 : 1;
	return { live: true, preload: d === 0 || d === immediate ? 'auto' : 'metadata' };
}
