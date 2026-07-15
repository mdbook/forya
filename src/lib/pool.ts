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

/**
 * The nearest `n` VIDEO card indices to `activeIndex`, scanning OUTWARD past non-video (image
 * gallery) items — nearest-first, `activeIndex` included when it is itself a video. This is the
 * pool's coverage on a feed that mixes videos and galleries. Galleries are never pooled (no
 * `<video>`, no decoder), so a positional ±window would, on a gallery-heavy feed, come back all-
 * galleries and leave the pool EMPTY — tearing down every nearby video's decoder so the next
 * video you scroll to cold-starts blank (the round-1 regression). Instead we keep the closest
 * `n` VIDEOS warm no matter how many galleries sit between them, so a video is always pre-rolling
 * before you reach it (the same warm-neighbour guarantee a pure-video feed has).
 *
 * `isVideo(i)` = whether `visible[i]` is a video (not a gallery). On a PURE-VIDEO feed this
 * returns the SAME SET as a centred ±window (`coverage` did): the nearest n videos to
 * `activeIndex` ARE `active ± floor((n-1)/2)` clamped — so the pool behaves byte-identically
 * where there are no galleries. Result length ≤ n (fewer only when the feed has < n videos
 * total). Order is nearest-first; `reassignPool` is set-based for kept slots, so order only
 * picks which physical slot a freshly-covered video lands in (slots are interchangeable).
 */
export function nearestVideos(
	activeIndex: number,
	isVideo: (i: number) => boolean,
	total: number,
	n: number
): number[] {
	const out: number[] = [];
	if (total <= 0 || n <= 0) return out;
	// Defensive clamp: a stale/out-of-range activeIndex must not silently empty the pool (it's
	// clamped by every caller today, but the contract shouldn't depend on that). Center the scan
	// on the nearest in-range index.
	const a = Math.max(0, Math.min(total - 1, activeIndex));
	const consider = (i: number) => {
		if (out.length >= n || i < 0 || i >= total) return;
		if (isVideo(i)) out.push(i);
	};
	consider(a);
	for (let d = 1; d < total && out.length < n; d++) {
		consider(a - d);
		consider(a + d);
	}
	return out;
}

/** Reassign `n` physical slots to cover `targetCards`, PRESERVING a slot's current binding
 *  when that target stays covered (so we don't needlessly `src`-swap / reparent / reload an
 *  element that's already showing the right clip), and recycling the freed slots to the
 *  newly-covered targets. Pure: takes the previous slot→target map, returns the new one.
 *
 *  Generic over the target key `T` (0.6.2 #1): the logic is pure Set-membership + equality,
 *  so it's identity-agnostic — Feed keys the pool by clip NAME (string) now, but the math is
 *  unchanged and the original number-keyed (index) tests still hold. `prev[s]` = the target
 *  slot `s` currently shows, or null if unused. The returned array has length `n`; entries
 *  are targets or null (null only when `targetCards` has fewer than `n` entries, i.e.
 *  `total < n`). Slots whose target leaves coverage are the ones Feed will `src`-swap. */
export function reassignPool<T>(prev: (T | null)[], targetCards: T[], n: number): (T | null)[] {
	const next: (T | null)[] = new Array(n).fill(null);
	const targets = new Set(targetCards);
	const claimed = new Set<T>(); // targets already kept by some slot

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
