// feedWindow — the lazy-load/mount window. The load-bearing property is
// active-always-live (a jump to any index force-mounts + plays it; never a
// placeholder active card), in BOTH scroll directions. Plus window bounds, the
// direction bias, and the preload gradient.
import { describe, expect, it } from 'vitest';
import { feedWindow } from '../src/lib/window';

const CFG = { preloadAhead: 3, preloadBehind: 2 };

describe('feedWindow', () => {
	it('keeps the active card live in either direction (the virtualization invariant)', () => {
		for (const dir of [1, -1]) {
			for (const active of [0, 5, 100, 11877]) {
				const ws = feedWindow(active, active, dir, CFG);
				expect(ws.live).toBe(true);
				expect(ws.preload).toBe('auto');
			}
		}
	});

	it('scrolling down: live across [active − behind, active + ahead], dead outside', () => {
		const active = 50;
		// behind = 2, ahead = 3
		expect(feedWindow(active - 2, active, 1, CFG).live).toBe(true);
		expect(feedWindow(active + 3, active, 1, CFG).live).toBe(true);
		expect(feedWindow(active - 3, active, 1, CFG).live).toBe(false);
		expect(feedWindow(active + 4, active, 1, CFG).live).toBe(false);
		expect(feedWindow(active - 3, active, 1, CFG).preload).toBe('none');
		expect(feedWindow(active + 4, active, 1, CFG).preload).toBe('none');
	});

	it('scrolling up swaps ahead/behind (direction bias)', () => {
		const active = 50;
		// dir = -1 → ahead = preloadBehind (2), behind = preloadAhead (3)
		expect(feedWindow(active - 3, active, -1, CFG).live).toBe(true);
		expect(feedWindow(active + 2, active, -1, CFG).live).toBe(true);
		expect(feedWindow(active - 4, active, -1, CFG).live).toBe(false);
		expect(feedWindow(active + 3, active, -1, CFG).live).toBe(false);
	});

	it('preload gradient: active + immediate-direction neighbour are auto, rest metadata', () => {
		const active = 50;
		// down: immediate neighbour is +1
		expect(feedWindow(active + 1, active, 1, CFG).preload).toBe('auto');
		expect(feedWindow(active + 2, active, 1, CFG).preload).toBe('metadata');
		expect(feedWindow(active - 1, active, 1, CFG).preload).toBe('metadata');
		// up: immediate neighbour is −1
		expect(feedWindow(active - 1, active, -1, CFG).preload).toBe('auto');
		expect(feedWindow(active + 1, active, -1, CFG).preload).toBe('metadata');
	});

	it('honours a zero-width window (only the active card live)', () => {
		const active = 10;
		const ws0 = feedWindow(active, active, 1, { preloadAhead: 0, preloadBehind: 0 });
		expect(ws0.live).toBe(true);
		expect(feedWindow(active + 1, active, 1, { preloadAhead: 0, preloadBehind: 0 }).live).toBe(
			false
		);
		expect(feedWindow(active - 1, active, 1, { preloadAhead: 0, preloadBehind: 0 }).live).toBe(
			false
		);
	});
});
