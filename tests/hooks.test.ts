// Warm-on-boot (0.8.0) — the SvelteKit `init` server hook. The two load-bearing
// properties (review's hard conditions): it is FIRE-AND-FORGET (returns void
// synchronously — never awaits the scan, so it can't block server-ready) and its
// boot scan is CONTAINED (a failure can't throw out of init or crash startup).
import { afterEach, describe, expect, it } from 'vitest';
import { init } from '../src/hooks.server';
import { clearScanCache } from '../src/lib/server/videos';

describe('warm-on-boot (hooks.server init)', () => {
	afterEach(() => clearScanCache());

	it('returns void synchronously — fire-and-forget, never blocks server-ready', () => {
		// If init awaited the (potentially ~24s) scan it would return a Promise that
		// SvelteKit blocks server-ready on; a synchronous void return proves it doesn't.
		const ret = init();
		expect(ret).toBeUndefined();
	});

	it('does not throw even when the boot scan runs against a missing VIDEO_DIR', async () => {
		// In the test env config.videoDir is the default /srv/videos (absent) → the
		// scan rejects/empties internally; init must swallow it, not propagate.
		expect(() => init()).not.toThrow();
		await new Promise((r) => setTimeout(r, 0)); // let the background scan settle
	});
});
