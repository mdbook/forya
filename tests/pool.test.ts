// pool (0.6) — the pure slot↔card assignment for the persistent-`<video>` pool that
// carries sound across cards on iOS. These guard the recycle math: which physical element
// shows which card as the active index moves, preserving bindings (no needless reload) and
// using every slot. The DOM/iOS side lives in Feed.svelte; this is the testable core.
import { describe, expect, it } from 'vitest';
import { coverage, poolRadius, reassignPool } from '../src/lib/pool';

describe('poolRadius', () => {
	it('n=3 → radius 1 (prev/cur/next)', () => expect(poolRadius(3)).toBe(1));
	it('n=5 → radius 2 (±2)', () => expect(poolRadius(5)).toBe(2));
	it('n=2 → radius 0 (cur + one neighbour)', () => expect(poolRadius(2)).toBe(0));
	it('n=1 → radius 0', () => expect(poolRadius(1)).toBe(0));
});

describe('coverage (the cards that should carry an element)', () => {
	it('centres on the active card mid-feed (n=3 → prev/cur/next)', () => {
		expect(coverage(5, 3, 20)).toEqual([4, 5, 6]);
	});

	it('biases inward at the top so no slot is wasted (active=0, n=3 → 0,1,2)', () => {
		expect(coverage(0, 3, 20)).toEqual([0, 1, 2]);
	});

	it('biases inward at the bottom (active=last, n=3 → last-2..last)', () => {
		expect(coverage(19, 3, 20)).toEqual([17, 18, 19]);
	});

	it('always contains the active index', () => {
		for (let a = 0; a < 20; a++) expect(coverage(a, 3, 20)).toContain(a);
		for (let a = 0; a < 20; a++) expect(coverage(a, 5, 20)).toContain(a);
	});

	it('n=5 covers ±2 mid-feed', () => {
		expect(coverage(10, 5, 50)).toEqual([8, 9, 10, 11, 12]);
	});

	it('clamps the window size to the feed when total < n', () => {
		expect(coverage(0, 3, 2)).toEqual([0, 1]);
		expect(coverage(1, 3, 2)).toEqual([0, 1]);
	});

	it('single-item feed → just [0]', () => {
		expect(coverage(0, 3, 1)).toEqual([0]);
	});

	it('empty feed → []', () => {
		expect(coverage(0, 3, 0)).toEqual([]);
	});
});

describe('reassignPool (preserve covered bindings, recycle the rest)', () => {
	it('cold start: assigns the initial coverage to free slots', () => {
		const next = reassignPool([null, null, null], [0, 1, 2], 3);
		// every target covered exactly once
		expect([...next].sort((a, b) => (a! - b!))).toEqual([0, 1, 2]);
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
		expect([...next].sort((a, b) => (a! - b!))).toEqual([14, 15, 16]);
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
});
