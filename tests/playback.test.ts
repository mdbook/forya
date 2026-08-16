// playback (0.5.1) — the pure retry-on-playable decision. Guards the self-heal
// that fixes the two pre-existing 0.4.x autoplay residuals: a settled-but-not-
// yet-buffered active card, and an isolated first-play() rejection. The truth
// table here is the whole policy surface; the component just wires it to
// canplay/loadeddata and guards the attempt with its generation token.
import { describe, expect, it } from 'vitest';
import {
	HAVE_CURRENT_DATA,
	HOLD_SLOP,
	HOLD_SPEED,
	inSpeedZone,
	isMediaReady,
	movedTooFar,
	shouldRetryOnPlayable
} from '../src/lib/playback';

const base = { active: true, paused: false, hasPlayed: false, errored: false };

describe('shouldRetryOnPlayable', () => {
	it('retries an active, fresh, un-paused, un-errored card (the recovery case)', () => {
		expect(shouldRetryOnPlayable(base)).toBe(true);
	});

	it('does NOT retry an inactive card (only the active card auto-plays)', () => {
		expect(shouldRetryOnPlayable({ ...base, active: false })).toBe(false);
	});

	it('does NOT retry over an explicit user pause', () => {
		expect(shouldRetryOnPlayable({ ...base, paused: true })).toBe(false);
	});

	it('does NOT retry once it has already played (nothing to recover)', () => {
		expect(shouldRetryOnPlayable({ ...base, hasPlayed: true })).toBe(false);
	});

	it('does NOT retry after a genuine media error (would loop on a broken source)', () => {
		expect(shouldRetryOnPlayable({ ...base, errored: true })).toBe(false);
	});

	it('retries pre-bless too — the 0.6.1 model muted-autoplays the active card from load, and the retry is always a MUTED play (audible output is gated separately), so the self-heal must recover a cold pre-bless card', () => {
		// Regression guard for the M2.5 `blessed` gate REMOVAL (0.6.1): a fresh active card that
		// has not yet been blessed must still self-heal its muted autoplay on canplay.
		expect(
			shouldRetryOnPlayable({ active: true, paused: false, hasPlayed: false, errored: false })
		).toBe(true);
	});

	it('requires ALL conditions — any single disqualifier blocks the retry', () => {
		expect(
			shouldRetryOnPlayable({
				active: false,
				paused: true,
				hasPlayed: true,
				errored: true
			})
		).toBe(false);
	});
});

describe('isMediaReady (decoder-handover-race vs late-buffer)', () => {
	it('treats HAVE_CURRENT_DATA and above as ready (race → schedule a delayed retry)', () => {
		expect(isMediaReady(HAVE_CURRENT_DATA)).toBe(true); // HAVE_CURRENT_DATA (2)
		expect(isMediaReady(3)).toBe(true); // HAVE_FUTURE_DATA
		expect(isMediaReady(4)).toBe(true); // HAVE_ENOUGH_DATA
	});

	it('treats below HAVE_CURRENT_DATA as not-yet-buffered (leave it to canplay)', () => {
		expect(isMediaReady(0)).toBe(false); // HAVE_NOTHING
		expect(isMediaReady(1)).toBe(false); // HAVE_METADATA
	});
});

// Hold-to-speed (0.16): the left-third zone is the whole reason the gesture doesn't collide
// with the rest of the card (right/centre stay free for other gestures), so pin the boundary
// and the scroll-vs-hold slop here rather than trusting a component to keep the thirds right.
describe('inSpeedZone (left third only)', () => {
	const L = 100; // a card offset from the viewport origin — the zone is rect-relative
	const W = 300; // → boundary at x = 200

	it('accepts a press in the left third', () => {
		expect(inSpeedZone(L, L, W)).toBe(true); // the very left edge
		expect(inSpeedZone(L + 99, L, W)).toBe(true);
	});

	it('rejects the centre and right thirds (free for other gestures)', () => {
		expect(inSpeedZone(L + 150, L, W)).toBe(false);
		expect(inSpeedZone(L + W - 1, L, W)).toBe(false);
	});

	it('puts the boundary exactly at one third — the third itself is exclusive', () => {
		expect(inSpeedZone(L + 100, L, W)).toBe(false);
		expect(inSpeedZone(L + 99.9, L, W)).toBe(true);
	});

	it('scales with the card, not with hardcoded pixels (rotate/desktop)', () => {
		expect(inSpeedZone(300, 0, 1200)).toBe(true); // wide viewport: third = 400
		expect(inSpeedZone(300, 0, 600)).toBe(false); // narrow: third = 200
	});

	it('rejects a zero/unmeasured rect instead of speeding on every press', () => {
		expect(inSpeedZone(0, 0, 0)).toBe(false);
	});
});

describe('movedTooFar (a drag is a scroll, not a hold)', () => {
	it('tolerates the small jitter of a stationary finger', () => {
		expect(movedTooFar(0, 0)).toBe(false);
		expect(movedTooFar(HOLD_SLOP - 1, 0)).toBe(false);
	});

	it('cancels once the press travels past the slop, in any direction', () => {
		expect(movedTooFar(0, HOLD_SLOP + 1)).toBe(true); // the vertical feed scroll
		expect(movedTooFar(-(HOLD_SLOP + 1), 0)).toBe(true);
		expect(movedTooFar(HOLD_SLOP, HOLD_SLOP)).toBe(true); // diagonal: hypot, not per-axis
	});
});

describe('HOLD_SPEED', () => {
	// The operator's ticket did not name a multiplier; 2x is the TikTok/YouTube standard and
	// is pending confirmation. This asserts the DEFAULT, and that the rate is a real speed-up
	// — if the operator picks another number, this line is the only test to touch.
	it('defaults to 2x', () => {
		expect(HOLD_SPEED).toBe(2);
	});

	it('is a speed-UP (a rate below 1 would slow the video down instead)', () => {
		expect(HOLD_SPEED).toBeGreaterThan(1);
	});
});
