// Volume (0.17). Storage load/save is browser-only (localStorage) and untested here,
// mirroring hidden/prefs — the pure clamp underneath it is what actually decides whether a
// junk or missing stored value can strand a feed silent or wedge an element at NaN, so
// that's what's guarded. `volumeIsSettable`'s real answer is a per-browser fact no node
// test can assert; what IS pinnable is that it stays false without a DOM.
import { describe, expect, it } from 'vitest';
import { clampVolume } from '../src/lib/stores/prefs';
import { volumeIsSettable } from '../src/lib/volume';

describe('clampVolume', () => {
	it('passes through a level already in range', () => {
		expect(clampVolume(0, 1)).toBe(0);
		expect(clampVolume(0.37, 1)).toBe(0.37);
		expect(clampVolume(1, 1)).toBe(1);
	});

	it('clamps a FINITE out-of-range level (an out-of-range assignment throws IndexSizeError)', () => {
		expect(clampVolume(1.5, 0.4)).toBe(1);
		expect(clampVolume(-0.2, 0.4)).toBe(0);
	});

	it('treats the infinities as junk, not as extremes — they come from arithmetic, not a user', () => {
		// Fallback deliberately differs from both ends so this asserts the branch rather than
		// coincidentally matching a clamp result.
		expect(clampVolume(Infinity, 0.4)).toBe(0.4);
		expect(clampVolume(-Infinity, 0.4)).toBe(0.4);
	});

	it('falls back on junk rather than returning NaN — a NaN volume wedges the element', () => {
		expect(clampVolume(NaN, 1)).toBe(1);
		expect(clampVolume(Number('not-a-level'), 0.4)).toBe(0.4);
	});

	it('uses the caller fallback, not a hardcoded one, so a bad slider event keeps the CURRENT level', () => {
		// setVolume passes the live volume as the fallback: a garbage input event must leave
		// the feed where it was, never jump it to full.
		expect(clampVolume(NaN, 0.25)).toBe(0.25);
	});

	it('does not treat 0 as junk — muting via the slider is a legitimate level', () => {
		// The bug this pins: `!v || !Number.isFinite(v)` would send 0 to the fallback and make
		// the bottom of the slider silently jump back to full.
		expect(clampVolume(0, 1)).toBe(0);
	});
});

describe('volumeIsSettable', () => {
	it('is false with no DOM (SSR) — the rail must not render a slider the server cannot probe', () => {
		expect(volumeIsSettable()).toBe(false);
	});
});
