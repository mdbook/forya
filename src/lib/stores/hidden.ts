// Client-side "hidden from feed" set (the trash control). Hiding is purely a
// localStorage operation — it NEVER touches disk, so VIDEO_DIR stays read-only
// input (the load-bearing `:ro` contract holds). Keyed per FEED_NAME so the
// three instances on a shared origin don't clobber each other.
//
// TODO (out of scope, future): an auth-gated "manage hidden videos" panel to
// review/restore hides — would likely move this set to server-side persistence.
import { browser } from '$app/environment';
import type { FeedItem } from '$lib/types';

const hiddenKey = (feedName: string) => `forya:${feedName}:hidden`;
const MAX_HIDDEN = 5000; // bound storage growth (oldest dropped)

/** Load the persisted hidden-name set, or an empty set if none / unavailable. */
export function loadHidden(feedName: string): Set<string> {
	if (!browser) return new Set();
	try {
		const raw = localStorage.getItem(hiddenKey(feedName));
		if (!raw) return new Set();
		const parsed: unknown = JSON.parse(raw);
		if (Array.isArray(parsed)) {
			return new Set(parsed.filter((x): x is string => typeof x === 'string'));
		}
	} catch {
		/* corrupt/unavailable — ignore, start empty */
	}
	return new Set();
}

/** Persist the hidden-name set (bounded to the most recent MAX_HIDDEN). */
export function saveHidden(feedName: string, hidden: ReadonlySet<string>): void {
	if (!browser) return;
	try {
		const arr = Array.from(hidden).slice(-MAX_HIDDEN);
		localStorage.setItem(hiddenKey(feedName), JSON.stringify(arr));
	} catch {
		/* localStorage unavailable (private mode / quota) — non-fatal */
	}
}

/**
 * Drop hidden items from a feed list, preserving order and without mutating the
 * input. Pure (no browser API) so it's unit-testable in the node test env.
 */
export function applyHidden(items: FeedItem[], hidden: ReadonlySet<string>): FeedItem[] {
	if (hidden.size === 0) return items;
	return items.filter((it) => !hidden.has(it.name));
}
