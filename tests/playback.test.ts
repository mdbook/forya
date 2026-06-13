// playback (0.5.1) — the pure retry-on-playable decision. Guards the self-heal
// that fixes the two pre-existing 0.4.x autoplay residuals: a settled-but-not-
// yet-buffered active card, and an isolated first-play() rejection. The truth
// table here is the whole policy surface; the component just wires it to
// canplay/loadeddata and guards the attempt with its generation token.
import { describe, expect, it } from 'vitest';
import {
	canStartPlayback,
	HAVE_CURRENT_DATA,
	HAVE_FUTURE_DATA,
	isMediaReady,
	shouldGestureUnlock,
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

	it('requires ALL conditions — any single disqualifier blocks the retry', () => {
		expect(
			shouldRetryOnPlayable({ active: false, paused: true, hasPlayed: true, errored: true })
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

describe('canStartPlayback (0.5.4 — safe muted-autoplay threshold)', () => {
	it('requires HAVE_FUTURE_DATA (3) or above — can play FORWARD, not just one frame', () => {
		expect(canStartPlayback(HAVE_FUTURE_DATA)).toBe(true); // 3
		expect(canStartPlayback(4)).toBe(true); // HAVE_ENOUGH_DATA
	});

	it('rejects HAVE_CURRENT_DATA (2) and below — one frame can still policy-reject', () => {
		expect(canStartPlayback(HAVE_CURRENT_DATA)).toBe(false); // 2 — the key case
		expect(canStartPlayback(1)).toBe(false); // HAVE_METADATA
		expect(canStartPlayback(0)).toBe(false); // HAVE_NOTHING
	});
});

describe('shouldGestureUnlock (0.5.3/0.5.4 — document-wide iOS autoplay re-grant)', () => {
	it('fires on a real scroll-drag when the active card is autoplay-blocked', () => {
		expect(shouldGestureUnlock({ activeBlocked: true, moved: true })).toBe(true);
	});

	it('does NOT fire when the active card is playing fine (no permission revoked)', () => {
		expect(shouldGestureUnlock({ activeBlocked: false, moved: true })).toBe(false);
	});

	it('does NOT fire on a stationary tap (0.5.4 — togglePlay owns taps; firing here double-drives → the two-tap regression)', () => {
		expect(shouldGestureUnlock({ activeBlocked: true, moved: false })).toBe(false);
	});

	it('requires BOTH blocked and moved', () => {
		expect(shouldGestureUnlock({ activeBlocked: false, moved: false })).toBe(false);
	});
});
