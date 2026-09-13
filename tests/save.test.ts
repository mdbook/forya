// Save-to-device target selection (save-to-photos, #122) — the pure "which media do we save"
// decision. This truth table IS the policy surface; Feed.svelte only wires the chosen target to
// fetch + navigator.share. Load-bearing property: a VIDEO saves itself; a GALLERY saves the
// frame the user is CURRENTLY looking at, with a safe fall back to the cover frame.
import { describe, expect, it } from 'vitest';
import { pickSaveTarget } from '../src/lib/save';
import type { FeedItem } from '../src/lib/types';

const video: FeedItem = {
	name: 'clip.mp4',
	url: '/api/media/clip.mp4',
	type: 'video/mp4'
};

const gallery: FeedItem = {
	name: '7184',
	url: '/api/media/7184_01.jpg', // mirrors the FIRST frame (share/info fallback), per types.ts
	type: 'image/jpeg',
	media: [
		{ name: '7184_01.jpg', url: '/api/media/7184_01.jpg', type: 'image/jpeg' },
		{ name: '7184_02.jpg', url: '/api/media/7184_02.jpg', type: 'image/jpeg' },
		{ name: '7184_03.png', url: '/api/media/7184_03.png', type: 'image/png' }
	]
};

describe('pickSaveTarget', () => {
	it('saves a VIDEO item itself, ignoring the frame index', () => {
		expect(pickSaveTarget(video, 2)).toEqual({
			url: '/api/media/clip.mp4',
			name: 'clip.mp4',
			type: 'video/mp4'
		});
	});

	it('defaults a gallery to the cover frame (index 0)', () => {
		expect(pickSaveTarget(gallery)).toEqual({
			url: '/api/media/7184_01.jpg',
			name: '7184_01.jpg',
			type: 'image/jpeg'
		});
	});

	it('saves the CURRENTLY-VISIBLE gallery frame', () => {
		expect(pickSaveTarget(gallery, 1)).toEqual({
			url: '/api/media/7184_02.jpg',
			name: '7184_02.jpg',
			type: 'image/jpeg'
		});
		// A different frame can carry a different MIME (png vs jpeg) — the File must be typed
		// per-frame so iOS saves it correctly.
		expect(pickSaveTarget(gallery, 2).type).toBe('image/png');
	});

	it('falls back to the cover frame when the reported index is out of range', () => {
		expect(pickSaveTarget(gallery, 99)).toEqual({
			url: '/api/media/7184_01.jpg',
			name: '7184_01.jpg',
			type: 'image/jpeg'
		});
	});

	it('treats an empty media[] as a video (item itself)', () => {
		const emptyGallery: FeedItem = { ...video, media: [] };
		expect(pickSaveTarget(emptyGallery, 0).url).toBe('/api/media/clip.mp4');
	});
});
