// Pooled-element assignment math (0.6) — the pure core of the persistent-`<video>`
// pool that lets sound carry card→card on iOS.
//
// WHY A POOL: iOS grants "may-play-unmuted" as PER-ELEMENT, durable, gesture-granted
// state (proven on-device via the test harness: a blessed element stays audible across
// `src`-swaps, even after a 20s idle). forya used to mint a fresh `<video>` per card and
// release it on unmount, so every settled card was a virgin, unblessed element that iOS
// pauses the moment you unmute it off-gesture. A small fixed pool of persistent elements,
// blessed once in a user gesture and then reused via `src`-swap, keeps the blessing alive —
// so sound carries across scrolls AND programmatic auto-advance.
//
// This module is the PURE slot↔card bookkeeping (no DOM, no iOS), unit-tested like
// `window.ts`/`playback.ts`/`fit.ts`. `Feed.svelte` owns the actual elements and applies
// the assignment (src-swap + reparent + play/mute). Keeping the recycle math pure means the
// "which physical element shows which card" decision — the part that's easy to get subtly
// wrong — is testable in isolation.

/** The radius of the coverage window for a pool of `n` elements: how many cards on
 *  EACH side of the active card carry an element. n=3 → 1 (prev/cur/next); n=5 → 2. */
export function poolRadius(n: number): number {
	return Math.floor((Math.max(1, n) - 1) / 2);
}

/** The contiguous set of card indices the pool should cover for `activeIndex`, given `n`
 *  elements and `total` cards. A window of `min(n, total)` indices that ALWAYS contains
 *  `activeIndex`, centred on it but shifted to stay within `[0, total-1]` so every element
 *  is used (near the top/bottom we bias the window inward rather than waste a slot). */
export function coverage(activeIndex: number, n: number, total: number): number[] {
	if (total <= 0 || n <= 0) return [];
	const size = Math.min(n, total);
	const r = poolRadius(n);
	let start = activeIndex - r;
	if (start < 0) start = 0;
	let end = start + size - 1;
	if (end > total - 1) {
		end = total - 1;
		start = end - size + 1;
	}
	const out: number[] = [];
	for (let i = start; i <= end; i++) out.push(i);
	return out;
}

/** Reassign `n` physical slots to cover `targetCards`, PRESERVING a slot's current card
 *  binding when that card stays covered (so we don't needlessly `src`-swap / reparent /
 *  reload an element that's already showing the right clip), and recycling the freed slots
 *  to the newly-covered cards. Pure: takes the previous slot→card map, returns the new one.
 *
 *  `prev[s]` = the card index slot `s` currently shows, or null if unused. The returned
 *  array has length `n`; entries are card indices or null (null only when `targetCards` has
 *  fewer than `n` entries, i.e. `total < n`). Slots whose card leaves coverage are the ones
 *  Feed will `src`-swap to a new card. */
export function reassignPool(
	prev: (number | null)[],
	targetCards: number[],
	n: number
): (number | null)[] {
	const next: (number | null)[] = new Array(n).fill(null);
	const targets = new Set(targetCards);
	const claimed = new Set<number>(); // card indices already kept by some slot

	// Pass 1: keep slots that already show a still-covered card (no reload).
	for (let s = 0; s < n; s++) {
		const card = prev[s] ?? null;
		if (card !== null && targets.has(card) && !claimed.has(card)) {
			next[s] = card;
			claimed.add(card);
		}
	}
	// Pass 2: fill the freed slots with the not-yet-covered target cards (these reload).
	const uncovered = targetCards.filter((c) => !claimed.has(c));
	let u = 0;
	for (let s = 0; s < n && u < uncovered.length; s++) {
		if (next[s] === null) {
			next[s] = uncovered[u++];
			claimed.add(next[s]!);
		}
	}
	return next;
}
