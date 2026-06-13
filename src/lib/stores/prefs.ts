// Client-side preferences (mute, info-overlay). Server stays stateless (SPEC
// §4) — all persistence is localStorage, keyed per FEED_NAME so the three
// instances don't clobber each other's settings on a shared origin.
import { browser } from '$app/environment';

const muteKey = (feedName: string) => `forya:${feedName}:mute`;
const infoKey = (feedName: string) => `forya:${feedName}:info`;
const autoAdvanceKey = (feedName: string) => `forya:${feedName}:autoadvance`;

// NOTE (0.6.1): there is no loadMute — Feed starts every session muted-autoplaying
// (onMount sets muted=true; the active card autoplays muted and the first tap flips
// muted=false in-gesture to bless + play with sound), so a persisted mute pref is never
// read back. saveMute is kept only so the toggle's runtime state is written (harmless);
// honoring it on load is a deferred behavior choice, not a bug.

/** Persist the mute preference. */
export function saveMute(feedName: string, muted: boolean): void {
	if (!browser) return;
	try {
		localStorage.setItem(muteKey(feedName), muted ? '1' : '0');
	} catch {
		/* localStorage unavailable (private mode / quota) — non-fatal */
	}
}

/** Load the info-overlay preference (defaults off). */
export function loadInfo(feedName: string): boolean {
	if (!browser) return false;
	return localStorage.getItem(infoKey(feedName)) === '1';
}

/** Persist the info-overlay preference. */
export function saveInfo(feedName: string, on: boolean): void {
	if (!browser) return;
	try {
		localStorage.setItem(infoKey(feedName), on ? '1' : '0');
	} catch {
		/* localStorage unavailable — non-fatal */
	}
}

/** Load the autoplay-next preference, falling back to the instance default
 *  (AUTO_ADVANCE) when the user hasn't set one. */
export function loadAutoAdvance(feedName: string, fallback: boolean): boolean {
	if (!browser) return fallback;
	const v = localStorage.getItem(autoAdvanceKey(feedName));
	return v === null ? fallback : v === '1';
}

/** Persist the autoplay-next preference. */
export function saveAutoAdvance(feedName: string, on: boolean): void {
	if (!browser) return;
	try {
		localStorage.setItem(autoAdvanceKey(feedName), on ? '1' : '0');
	} catch {
		/* localStorage unavailable — non-fatal */
	}
}
