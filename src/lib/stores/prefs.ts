// Client-side preferences (mute). Server stays stateless (SPEC §4) — all
// persistence is localStorage, keyed per FEED_NAME so the three instances don't
// clobber each other's settings on a shared origin.
import { browser } from '$app/environment';

const muteKey = (feedName: string) => `forya:${feedName}:mute`;

/** Load the persisted mute preference (defaults to muted — iOS autoplay rule). */
export function loadMute(feedName: string): boolean {
	if (!browser) return true;
	const v = localStorage.getItem(muteKey(feedName));
	return v === null ? true : v === '1';
}

/** Persist the mute preference. */
export function saveMute(feedName: string, muted: boolean): void {
	if (!browser) return;
	try {
		localStorage.setItem(muteKey(feedName), muted ? '1' : '0');
	} catch {
		/* localStorage unavailable (private mode / quota) — non-fatal */
	}
}
