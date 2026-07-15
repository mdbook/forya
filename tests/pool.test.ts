// pool (0.6) — the pure slot↔card assignment for the persistent-`<video>` pool that
// carries sound across cards on iOS. These guard the recycle math: which physical element
// shows which card as the active index moves, preserving bindings (no needless reload) and
// using every slot. The DOM/iOS side lives in Feed.svelte; this is the testable core.
import { describe, expect, it } from 'vitest';
import { nearestVideos, reassignPool } from '../src/lib/pool';

const allVideos = () => true;

describe('nearestVideos: pure-video feed == the old centred ±window (no behavior change)', () => {
	it('centres on the active card mid-feed (n=3 → {prev,cur,next})', () => {
		expect(nearestVideos(5, allVideos, 20, 3).sort((a, b) => a - b)).toEqual([4, 5, 6]);
	});

	it('biases inward at the top so no slot is wasted (active=0, n=3 → 0,1,2)', () => {
		expect(nearestVideos(0, allVideos, 20, 3).sort((a, b) => a - b)).toEqual([0, 1, 2]);
	});

	it('biases inward at the bottom (active=last, n=3 → last-2..last)', () => {
		expect(nearestVideos(19, allVideos, 20, 3).sort((a, b) => a - b)).toEqual([17, 18, 19]);
	});

	it('n=5 covers ±2 mid-feed', () => {
		expect(nearestVideos(10, allVideos, 50, 5).sort((a, b) => a - b)).toEqual([8, 9, 10, 11, 12]);
	});

	it('always includes the active index (when it is a video)', () => {
		for (let a = 0; a < 20; a++) expect(nearestVideos(a, allVideos, 20, 3)).toContain(a);
		for (let a = 0; a < 20; a++) expect(nearestVideos(a, allVideos, 20, 5)).toContain(a);
	});

	it('nearest-first order: active video first, then closest outward', () => {
		expect(nearestVideos(5, allVideos, 20, 3)).toEqual([5, 4, 6]);
	});

	it('clamps to the feed when it has fewer videos than n', () => {
		expect(nearestVideos(0, allVideos, 2, 3).sort((a, b) => a - b)).toEqual([0, 1]);
		expect(nearestVideos(1, allVideos, 2, 3).sort((a, b) => a - b)).toEqual([0, 1]);
	});

	it('single-item feed → [0]; empty feed → []', () => {
		expect(nearestVideos(0, allVideos, 1, 3)).toEqual([0]);
		expect(nearestVideos(0, allVideos, 0, 3)).toEqual([]);
	});
});

describe('nearestVideos: gallery-aware (the #1417 regression fix)', () => {
	const isVideo = (vids: number[]) => (i: number) => vids.includes(i);

	it('active is a GALLERY: excludes it, pools the nearest videos around it', () => {
		// feed [G,G,V(2),G,V(4),G]; active on gallery 3 → nearest videos = 2 and 4 (gallery not pooled)
		expect(nearestVideos(3, isVideo([2, 4]), 6, 3).sort((a, b) => a - b)).toEqual([2, 4]);
	});

	it('keeps the nearest videos WARM across a run of galleries (was: pool torn down → cold blank)', () => {
		// 12 items, videos only at 0 and 11; active deep in galleries at 5 → still pools 0 and 11
		expect(nearestVideos(5, isVideo([0, 11]), 12, 3).sort((a, b) => a - b)).toEqual([0, 11]);
	});

	it('active video with galleries adjacent: pools itself FIRST + the nearest other videos', () => {
		// [V(0),G,G,V(3),G,V(5)]; active on V=3 → self first, then nearest videos 5 and 0
		const got = nearestVideos(3, isVideo([0, 3, 5]), 6, 3);
		expect(got[0]).toBe(3); // active video pooled first (it must play)
		expect(got.sort((a, b) => a - b)).toEqual([0, 3, 5]);
	});

	it('no videos at all → [] (all-gallery feed: pool stays empty, zero bleed)', () => {
		expect(nearestVideos(4, () => false, 10, 3)).toEqual([]);
	});

	it('one lone video among galleries → just that one, wherever the active card sits', () => {
		expect(nearestVideos(2, isVideo([7]), 10, 3)).toEqual([7]);
	});
});

describe('reassignPool (preserve covered bindings, recycle the rest)', () => {
	it('cold start: assigns the initial coverage to free slots', () => {
		const next = reassignPool([null, null, null], [0, 1, 2], 3);
		// every target covered exactly once
		expect([...next].sort((a, b) => a! - b!)).toEqual([0, 1, 2]);
	});

	it('scroll down by one: keeps the two still-covered cards, recycles only the dropped slot', () => {
		// slots show [4,5,6]; active moves 5→6 so coverage becomes [5,6,7].
		const prev = [4, 5, 6];
		const next = reassignPool(prev, [5, 6, 7], 3);
		// 5 and 6 stay on their existing slots (indices 1,2); slot 0 (was 4) recycles to 7.
		expect(next[1]).toBe(5);
		expect(next[2]).toBe(6);
		expect(next[0]).toBe(7);
	});

	it('scroll up by one: symmetric — only the dropped slot recycles', () => {
		const prev = [5, 6, 7]; // coverage was [5,6,7], active 6→5 → [4,5,6]
		const next = reassignPool(prev, [4, 5, 6], 3);
		expect(next[0]).toBe(5); // kept
		expect(next[1]).toBe(6); // kept
		expect(next[2]).toBe(4); // slot that held 7 recycles to 4
	});

	it('only ONE slot changes its card on a single-step scroll (minimal reloads)', () => {
		const prev = [4, 5, 6];
		const next = reassignPool(prev, [5, 6, 7], 3);
		let changed = 0;
		for (let s = 0; s < 3; s++) if (next[s] !== prev[s]) changed++;
		expect(changed).toBe(1);
	});

	it('multi-card jump: cards outside the new coverage all recycle', () => {
		// active jumps far (flick) — coverage [4,5,6] → [14,15,16], nothing reusable.
		const prev = [4, 5, 6];
		const next = reassignPool(prev, [14, 15, 16], 3);
		expect([...next].sort((a, b) => a! - b!)).toEqual([14, 15, 16]);
	});

	it('every target card ends up covered exactly once (no dup, no drop)', () => {
		const prev = [8, 9, 10];
		const next = reassignPool(prev, [9, 10, 11], 3);
		const cards = next.filter((c) => c !== null);
		expect(new Set(cards).size).toBe(cards.length); // no duplicates
		expect(new Set(cards)).toEqual(new Set([9, 10, 11]));
	});

	it('leaves trailing slots null when total < n', () => {
		const next = reassignPool([null, null, null], [0, 1], 3);
		const nonNull = next.filter((c) => c !== null);
		expect(new Set(nonNull)).toEqual(new Set([0, 1]));
		expect(next.filter((c) => c === null).length).toBe(1);
	});

	it('generic over identity: name-keyed keep/recycle (prev [A,B,C] → targets [B,C,D])', () => {
		// 0.6.2 #1: the pool now keys slot→NAME, not slot→index. reassignPool is generic and
		// identity-agnostic (pure Set-membership + equality), so the same keep/recycle holds
		// for string keys — B and C stay on their slots, A's slot recycles to the newly-covered
		// D. (Hide/undo re-indexes `visible`, but a clip's NAME is stable, so its slot binding
		// survives the reorder — the whole point of the re-key.)
		const next = reassignPool(['A', 'B', 'C'], ['B', 'C', 'D'], 3);
		expect(next[1]).toBe('B'); // kept in place
		expect(next[2]).toBe('C'); // kept in place
		expect(next[0]).toBe('D'); // slot that held A recycles to D
	});
});
