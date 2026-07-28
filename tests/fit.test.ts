// object-fit decision (pickFit) + the crop-cap bound it enforces.
//
// Contract (2026-07-28): `cover` is chosen ONLY when the crop it causes is ≤ MAX_COVER_CROP
// (~10%); anything that would crop more letterboxes (`contain`, zero crop) with a blurred
// bg-fill behind it. One cap for video AND gallery (the old 1.8/1.4 split collapsed).
import { describe, expect, it } from 'vitest';
import {
	pickFit,
	coverCropFraction,
	ratioForCropCap,
	MAX_COVER_RATIO,
	MAX_COVER_CROP
} from '../src/lib/fit';

// Representative aspect ratios (w/h).
const PHONE = 9 / 19.5; // ~0.46, tall portrait phone
const DESKTOP = 16 / 9; // ~1.78, landscape display
const V_PORTRAIT = 9 / 16; // ~0.5625, vertical clip
const V_LANDSCAPE = 16 / 9; // ~1.78, horizontal clip

function dims(ar: number): [number, number] {
	return [Math.round(ar * 1000), 1000];
}

// FP slop for the boundary (r === R gives crop === cap exactly, modulo float rounding).
const EPS = 1e-9;

describe('pickFit — the ≤MAX_COVER_CROP bound (THE proof)', () => {
	// Sweep a dense grid of media aspect ratios × viewport aspect ratios and assert the core
	// guarantee in BOTH directions:
	//   (a) whenever pickFit picks 'cover', the crop it causes is ≤ the cap;
	//   (b) whenever the crop WOULD exceed the cap, pickFit picks 'contain'.
	// This is the operator's hard rule ("at most ~10% of any clip is ever cropped") turned into
	// an executable invariant. Runs against the shipped default AND an explicit tighter cap to
	// prove the derivation (not the constant) is what holds.
	const media = Array.from({ length: 240 }, (_, i) => 0.2 + i * 0.02); // 0.20 … ~5.0
	const viewports = [PHONE, 0.75, 1, 1.33, DESKTOP, 2.1];

	for (const cap of [MAX_COVER_CROP, 0.05, 0.02]) {
		const ratio = ratioForCropCap(cap);
		it(`cover ⟹ crop ≤ ${(cap * 100).toFixed(0)}%, and crop > cap ⟹ contain`, () => {
			for (const a of media) {
				for (const v of viewports) {
					const [w, h] = dims(a);
					const fit = pickFit(w, h, v, ratio);
					const crop = coverCropFraction(w, h, v);
					if (fit === 'cover') {
						expect(crop).toBeLessThanOrEqual(cap + EPS);
					} else {
						// contain crops nothing; and it must be chosen for anything over the cap.
						expect(crop).toBeGreaterThan(cap - EPS);
					}
					// Restated as the pure implication (b): over-cap ⇒ never cover.
					if (crop > cap + EPS) expect(fit).toBe('contain');
				}
			}
		});
	}

	it('at the exact cap boundary it still fills (cover), just at the cap', () => {
		// r = R = 1/(1−cap): crop is exactly the cap → the inclusive side is 'cover'. Use the raw
		// float ratio (not the integer-rounded dims()) so the boundary is exact.
		expect(pickFit(MAX_COVER_RATIO, 1, 1, MAX_COVER_RATIO)).toBe('cover');
		expect(coverCropFraction(MAX_COVER_RATIO, 1, 1)).toBeCloseTo(MAX_COVER_CROP, 6);
	});
});

describe('pickFit — the fix is load-bearing (old thresholds VIOLATED the bound)', () => {
	it('the pre-fix 1.8 video threshold cover-crops a normal 9:16 clip ~18% (> the 10% cap)', () => {
		// 9:16 clip on a 9:19.5 phone: r ≈ 1.22. The old MAX_COVER_RATIO=1.8 kept this on 'cover',
		// cropping ~18% of the frame — exactly the over-cropping the operator hated. Assert the old
		// decision, the real crop it caused, and that the shipped cap now letterboxes it instead.
		const [w, h] = dims(V_PORTRAIT);
		expect(pickFit(w, h, PHONE, 1.8)).toBe('cover'); // OLD video decision
		expect(coverCropFraction(w, h, PHONE)).toBeGreaterThan(0.15); // ~18% cropped
		expect(coverCropFraction(w, h, PHONE)).toBeGreaterThan(MAX_COVER_CROP); // over the cap
		expect(pickFit(w, h, PHONE, MAX_COVER_RATIO)).toBe('contain'); // shipped: letterbox + blur-fill
	});

	it('the pre-fix 1.4 gallery threshold also cover-cropped 9:16 photos over the cap', () => {
		const [w, h] = dims(V_PORTRAIT);
		expect(pickFit(w, h, PHONE, 1.4)).toBe('cover'); // OLD gallery decision
		expect(coverCropFraction(w, h, PHONE)).toBeGreaterThan(MAX_COVER_CROP);
		expect(pickFit(w, h, PHONE, MAX_COVER_RATIO)).toBe('contain'); // shipped
	});
});

describe('pickFit — decisions', () => {
	it('fills (cover) an exact aspect match (0% crop)', () => {
		expect(pickFit(...dims(PHONE), PHONE, MAX_COVER_RATIO)).toBe('cover');
		expect(pickFit(...dims(DESKTOP), DESKTOP, MAX_COVER_RATIO)).toBe('cover');
	});

	it('fills a mild off-aspect within the cap (≤10% crop stays cover)', () => {
		// r = 1.08 → ~7.4% crop, under the 10% cap → cover.
		const [w, h] = dims(1.08);
		expect(coverCropFraction(w, h, 1)).toBeLessThan(MAX_COVER_CROP);
		expect(pickFit(w, h, 1, MAX_COVER_RATIO)).toBe('cover');
	});

	it('letterboxes a normal 9:16 clip on a portrait phone (~18% crop > cap)', () => {
		expect(pickFit(...dims(V_PORTRAIT), PHONE, MAX_COVER_RATIO)).toBe('contain');
	});

	it('letterboxes a horizontal clip on a portrait phone', () => {
		expect(pickFit(...dims(V_LANDSCAPE), PHONE, MAX_COVER_RATIO)).toBe('contain');
	});

	it('letterboxes a vertical clip on a landscape display (the middle-third bug)', () => {
		expect(pickFit(...dims(V_PORTRAIT), DESKTOP, MAX_COVER_RATIO)).toBe('contain');
	});

	it('fills (cover) a horizontal clip on a landscape display', () => {
		expect(pickFit(...dims(V_LANDSCAPE), DESKTOP, MAX_COVER_RATIO)).toBe('cover');
	});

	it('letterboxes a square clip on a tall phone', () => {
		expect(pickFit(1000, 1000, PHONE, MAX_COVER_RATIO)).toBe('contain');
	});

	it('letterboxes common photo aspects on a phone (4:5, 3:4, square) — whole photo shown', () => {
		expect(pickFit(...dims(4 / 5), PHONE, MAX_COVER_RATIO)).toBe('contain'); // r≈1.73
		expect(pickFit(...dims(3 / 4), PHONE, MAX_COVER_RATIO)).toBe('contain'); // r≈1.63
		expect(pickFit(1000, 1000, PHONE, MAX_COVER_RATIO)).toBe('contain'); // r≈2.17
	});

	it('defaults to cover when dimensions or viewport are unknown', () => {
		expect(pickFit(0, 0, PHONE, MAX_COVER_RATIO)).toBe('cover');
		expect(pickFit(1080, 1920, 0, MAX_COVER_RATIO)).toBe('cover');
	});
});

describe('crop-cap derivation', () => {
	it('MAX_COVER_RATIO is derived from the 10% cap (≈1.111)', () => {
		expect(MAX_COVER_CROP).toBe(0.1);
		expect(MAX_COVER_RATIO).toBeCloseTo(1 / 0.9, 6);
		expect(MAX_COVER_RATIO).toBe(ratioForCropCap(MAX_COVER_CROP));
	});

	it('coverCropFraction is symmetric and 0 at an exact match', () => {
		expect(coverCropFraction(1000, 1000, 1)).toBe(0);
		// r and 1/r crop the same amount (width-crop vs height-crop). Raw float dims for exactness.
		expect(coverCropFraction(1.5, 1, 1)).toBeCloseTo(coverCropFraction(1, 1.5, 1), 9);
	});
});
