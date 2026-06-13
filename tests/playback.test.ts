// playback (0.5.1) — the pure retry-on-playable decision. Guards the self-heal
// that fixes the two pre-existing 0.4.x autoplay residuals: a settled-but-not-
// yet-buffered active card, and an isolated first-play() rejection. The truth
// table here is the whole policy surface; the component just wires it to
// canplay/loadeddata and guards the attempt with its generation token.
import { describe, expect, it } from 'vitest';
import { shouldRetryOnPlayable } from '../src/lib/playback';

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
