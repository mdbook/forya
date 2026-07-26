// Gallery auto-cycle — the pure dwell decision. This truth table IS the policy surface; the
// carousel only wires it to a setTimeout. The load-bearing property is the operator's
// requirement that feed-autoscroll must NOT leave a gallery before it has shown every image:
// here that is structural, not a rule — `feed` is unreachable from a non-last frame.
import { describe, expect, it } from 'vitest';
import {
	FEED_DWELL_MS,
	IMAGE_DWELL_MS,
	nextGalleryStep,
	type GalleryStepInput
} from '../src/lib/gallery';

// A 3-frame gallery sitting on its first frame, active, autoscroll on, not held.
const base: GalleryStepInput = {
	active: true,
	autoAdvance: true,
	held: false,
	index: 0,
	frameCount: 3
};

describe('nextGalleryStep', () => {
	it('steps to the next FRAME from a non-last frame', () => {
		expect(nextGalleryStep(base)).toEqual({ kind: 'frame', delayMs: IMAGE_DWELL_MS });
	});

	it('still steps frames on the middle frame', () => {
		expect(nextGalleryStep({ ...base, index: 1 })).toEqual({
			kind: 'frame',
			delayMs: IMAGE_DWELL_MS
		});
	});

	it('advances the FEED from the last frame when autoscroll is on', () => {
		expect(nextGalleryStep({ ...base, index: 2 })).toEqual({
			kind: 'feed',
			delayMs: FEED_DWELL_MS
		});
	});

	// THE REQUIREMENT: autoscroll may never leave a gallery early. Structural — there is no input
	// with a non-last index that yields `feed`, so this holds for every gallery size.
	it('NEVER advances the feed from a non-last frame (the do-not-leave-early guarantee)', () => {
		for (let frameCount = 1; frameCount <= 8; frameCount++) {
			for (let index = 0; index < frameCount - 1; index++) {
				expect(nextGalleryStep({ ...base, index, frameCount }).kind).toBe('frame');
			}
		}
	});

	it('cycles frames in MANUAL mode too (frame advance is not autoscroll-gated)', () => {
		expect(nextGalleryStep({ ...base, autoAdvance: false })).toEqual({
			kind: 'frame',
			delayMs: IMAGE_DWELL_MS
		});
	});

	it('STOPS on the last frame in manual mode (no loop, never touches the feed)', () => {
		expect(nextGalleryStep({ ...base, autoAdvance: false, index: 2 })).toEqual({ kind: 'none' });
	});

	it('arms nothing when the card is not active', () => {
		expect(nextGalleryStep({ ...base, active: false })).toEqual({ kind: 'none' });
	});

	it('arms nothing while the post is HELD, on any frame', () => {
		expect(nextGalleryStep({ ...base, held: true })).toEqual({ kind: 'none' });
		expect(nextGalleryStep({ ...base, held: true, index: 2 })).toEqual({ kind: 'none' });
	});

	it('arms nothing for an empty gallery', () => {
		expect(nextGalleryStep({ ...base, frameCount: 0 })).toEqual({ kind: 'none' });
	});

	// A single-image post is "at the last frame" immediately, so it keeps the PRE-milestone
	// behaviour exactly: dwell, then advance the feed under autoscroll. No regression for the
	// dominant reddit shape (a one-photo post).
	it('single-image post advances the feed under autoscroll (pre-milestone behaviour preserved)', () => {
		expect(nextGalleryStep({ ...base, frameCount: 1, index: 0 })).toEqual({
			kind: 'feed',
			delayMs: FEED_DWELL_MS
		});
	});

	it('single-image post arms nothing in manual mode', () => {
		expect(nextGalleryStep({ ...base, frameCount: 1, index: 0, autoAdvance: false })).toEqual({
			kind: 'none'
		});
	});

	// Defensive: a frame list that shrank under a re-scan leaves index past the end. Treat it as
	// "at the end" rather than falling through to an endless frame-advance on a missing frame.
	it('treats an out-of-range index as the last frame', () => {
		expect(nextGalleryStep({ ...base, index: 99 })).toEqual({
			kind: 'feed',
			delayMs: FEED_DWELL_MS
		});
	});
});
