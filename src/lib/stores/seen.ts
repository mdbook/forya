// Optional resume state: the last viewed index + seen filenames, persisted to
// localStorage keyed `forya:<FEED_NAME>:seen` (SPEC §4). Server stays stateless.
import { browser } from '$app/environment';

export interface SeenState {
	/** Last active card index. */
	index: number;
	/** Filenames already seen (bounded). */
	names: string[];
}

const MAX_NAMES = 2000;
const seenKey = (feedName: string) => `forya:${feedName}:seen`;

/** Load resume state, or null if none / unavailable. */
export function loadSeen(feedName: string): SeenState | null {
	if (!browser) return null;
	try {
		const raw = localStorage.getItem(seenKey(feedName));
		if (!raw) return null;
		const parsed: unknown = JSON.parse(raw);
		if (
			parsed &&
			typeof parsed === 'object' &&
			typeof (parsed as SeenState).index === 'number' &&
			Array.isArray((parsed as SeenState).names)
		) {
			return parsed as SeenState;
		}
	} catch {
		/* corrupt/unavailable — ignore, start fresh */
	}
	return null;
}

/** Persist resume state (names bounded to the most recent MAX_NAMES). */
export function saveSeen(feedName: string, state: SeenState): void {
	if (!browser) return;
	try {
		const bounded: SeenState = {
			index: state.index,
			names: state.names.slice(-MAX_NAMES)
		};
		localStorage.setItem(seenKey(feedName), JSON.stringify(bounded));
	} catch {
		/* localStorage unavailable — non-fatal */
	}
}
