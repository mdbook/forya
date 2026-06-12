// object-fit decision (pickFit) — guards both crop directions: a landscape clip
// on a portrait phone AND a portrait clip on a landscape display.
import { describe, expect, it } from 'vitest';
import { pickFit } from '../src/lib/fit';

// Representative aspect ratios (w/h).
const PHONE = 9 / 19.5; // ~0.46, tall portrait phone
const DESKTOP = 16 / 9; // ~1.78, landscape display
const V_PORTRAIT = 9 / 16; // ~0.5625, vertical clip
const V_LANDSCAPE = 16 / 9; // ~1.78, horizontal clip

function dims(ar: number): [number, number] {
	return [Math.round(ar * 1000), 1000];
}

describe('pickFit', () => {
	it('fills (cover) a vertical clip on a portrait phone', () => {
		expect(pickFit(...dims(V_PORTRAIT), PHONE)).toBe('cover');
	});

	it('letterboxes (contain) a horizontal clip on a portrait phone', () => {
		expect(pickFit(...dims(V_LANDSCAPE), PHONE)).toBe('contain');
	});

	it('letterboxes (contain) a vertical clip on a landscape display (the middle-third bug)', () => {
		expect(pickFit(...dims(V_PORTRAIT), DESKTOP)).toBe('contain');
	});

	it('fills (cover) a horizontal clip on a landscape display', () => {
		expect(pickFit(...dims(V_LANDSCAPE), DESKTOP)).toBe('cover');
	});

	it('fills (cover) an exact aspect match', () => {
		expect(pickFit(...dims(PHONE), PHONE)).toBe('cover');
		expect(pickFit(...dims(DESKTOP), DESKTOP)).toBe('cover');
	});

	it('letterboxes a square clip on a tall phone (heavy crop otherwise)', () => {
		expect(pickFit(1000, 1000, PHONE)).toBe('contain');
	});

	it('defaults to cover when dimensions or viewport are unknown', () => {
		expect(pickFit(0, 0, PHONE)).toBe('cover');
		expect(pickFit(1080, 1920, 0)).toBe('cover');
	});
});
