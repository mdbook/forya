// The pure feed-filter behind the hide ("trash") control. Storage load/save is
// browser-only (localStorage) and untested here, mirroring prefs/seen; the pure
// filter is what the feed renders through, so that's what we guard.
import { describe, expect, it } from 'vitest';
import { applyHidden } from '../src/lib/stores/hidden';
import type { FeedItem } from '../src/lib/types';

function item(name: string): FeedItem {
	return { name, url: `/api/media/${name}`, size: 1, mtime: 1, type: 'video/mp4' };
}

const items = [item('a.mp4'), item('b.mp4'), item('c.mp4')];

describe('applyHidden', () => {
	it('empty set returns the list unchanged (same reference)', () => {
		expect(applyHidden(items, new Set())).toBe(items);
	});

	it('drops hidden names, preserving order', () => {
		const out = applyHidden(items, new Set(['b.mp4']));
		expect(out.map((i) => i.name)).toEqual(['a.mp4', 'c.mp4']);
	});

	it('does not mutate the input', () => {
		applyHidden(items, new Set(['a.mp4']));
		expect(items.map((i) => i.name)).toEqual(['a.mp4', 'b.mp4', 'c.mp4']);
	});

	it('hiding everything yields an empty feed', () => {
		expect(applyHidden(items, new Set(['a.mp4', 'b.mp4', 'c.mp4']))).toEqual([]);
	});

	it('unknown hidden names are harmless', () => {
		const out = applyHidden(items, new Set(['ghost.mp4']));
		expect(out.map((i) => i.name)).toEqual(['a.mp4', 'b.mp4', 'c.mp4']);
	});
});
