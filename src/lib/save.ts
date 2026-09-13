// Save-to-device target selection (save-to-photos, #122) — the pure "which media do we save,
// and under what filename/type" decision, extracted here (not inlined in Feed.svelte) so the
// whole policy is a truth table a test can pin, mirroring gallery.ts / pool.ts: pure logic in
// $lib, the component only wires it to fetch + navigator.share.
//
// WHY A DEDICATED ACTION: forya's existing share() (0.8.4) deliberately shares a LINK
// (`navigator.share({ url })`) for the rich OG preview — the native "Save Image/Video"
// share-sheet option only appears when you share a FILE instead. So save() fetches the
// already-served media bytes and hands navigator.share a File; this module only picks WHAT to
// fetch.
import type { FeedItem } from '$lib/types';

/** The concrete media the Save action should persist. */
export interface SaveTarget {
	/** Media URL to fetch — the same Range endpoint (`/api/media/<name>`) that already serves it. */
	url: string;
	/** Basename to save under (Contract A `<id>_NN.<ext>` for a gallery frame, `<id>.<ext>` for a video). */
	name: string;
	/** MIME type of the media, so the shared File is typed correctly for iOS Save-to-Photos. */
	type: string;
}

/** Pick what to save for the active item:
 *  - a VIDEO item (no `media[]`) saves itself (`frameIndex` ignored);
 *  - a photo-post GALLERY saves its CURRENTLY-VISIBLE frame (#122 — bulk "save every frame" is
 *    a deliberate later follow-up), falling back to the cover frame (index 0) if the reported
 *    index is out of range (e.g. a stale index after the frame count changed).
 *
 *  Pure + structurally simple so `tests/save.test.ts` pins every branch. */
export function pickSaveTarget(item: FeedItem, frameIndex = 0): SaveTarget {
	const frames = item.media;
	if (frames && frames.length > 0) {
		const frame = frames[frameIndex] ?? frames[0];
		return { url: frame.url, name: frame.name, type: frame.type };
	}
	return { url: item.url, name: item.name, type: item.type };
}
