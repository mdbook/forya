// object-fit decision (pickFit) — guards both crop directions: a landscape clip
// on a portrait phone AND a portrait clip on a landscape display.
import { describe, expect, it } from 'vitest';
import { pickFit, MAX_COVER_RATIO, GALLERY_MAX_COVER_RATIO } from '../src/lib/fit';

// Representative aspect ratios (w/h).
const PHONE = 9 / 19.5; // ~0.46, tall portrait phone
const DESKTOP = 16 / 9; // ~1.78, landscape display
const V_PORTRAIT = 9 / 16; // ~0.5625, vertical clip
const V_LANDSCAPE = 16 / 9; // ~1.78, horizontal clip

function dims(ar: number): [number, number] {
	return [Math.round(ar * 1000), 1000];
}

describe('pickFit', () => {
	it('fills (cover) a vertical clip on a portrait phone', () => {
		expect(pickFit(...dims(V_PORTRAIT), PHONE)).toBe('cover');
	});

	it('letterboxes (contain) a horizontal clip on a portrait phone', () => {
		expect(pickFit(...dims(V_LANDSCAPE), PHONE)).toBe('contain');
	});

	it('letterboxes (contain) a vertical clip on a landscape display (the middle-third bug)', () => {
		expect(pickFit(...dims(V_PORTRAIT), DESKTOP)).toBe('contain');
	});

	it('fills (cover) a horizontal clip on a landscape display', () => {
		expect(pickFit(...dims(V_LANDSCAPE), DESKTOP)).toBe('cover');
	});

	it('fills (cover) an exact aspect match', () => {
		expect(pickFit(...dims(PHONE), PHONE)).toBe('cover');
		expect(pickFit(...dims(DESKTOP), DESKTOP)).toBe('cover');
	});

	it('letterboxes a square clip on a tall phone (heavy crop otherwise)', () => {
		expect(pickFit(1000, 1000, PHONE)).toBe('contain');
	});

	it('defaults to cover when dimensions or viewport are unknown', () => {
		expect(pickFit(0, 0, PHONE)).toBe('cover');
		expect(pickFit(1080, 1920, 0)).toBe('cover');
	});
});

// Round-3 crop fix (#1526): GALLERY frames use a TIGHTER threshold than videos so photo posts
// (varied aspects, not the uniform 9:16 of video) letterbox instead of cover-cropping ~40% off.
// The video pool keeps MAX_COVER_RATIO; only ImageCarousel passes GALLERY_MAX_COVER_RATIO.
describe('pickFit — GALLERY_MAX_COVER_RATIO (photo frames letterbox sooner)', () => {
	const P_4x5 = 4 / 5; // 0.8 — common IG/TikTok portrait photo
	const P_3x4 = 3 / 4; // 0.75

	it('the gallery threshold is tighter than the video default', () => {
		expect(GALLERY_MAX_COVER_RATIO).toBeLessThan(MAX_COVER_RATIO);
	});

	it('a 4:5 photo COVERS at the video default but LETTERBOXES at the gallery threshold', () => {
		// r = 0.8/0.46 ≈ 1.73: under the 1.8 video default (cover, ~42% cropped) but over 1.4 (contain).
		expect(pickFit(...dims(P_4x5), PHONE)).toBe('cover'); // video default
		expect(pickFit(...dims(P_4x5), PHONE, GALLERY_MAX_COVER_RATIO)).toBe('contain'); // gallery
	});

	it('a 3:4 photo also letterboxes at the gallery threshold (was cover)', () => {
		expect(pickFit(...dims(P_3x4), PHONE)).toBe('cover');
		expect(pickFit(...dims(P_3x4), PHONE, GALLERY_MAX_COVER_RATIO)).toBe('contain');
	});

	it('a proper vertical (9:16) photo STILL fills at the gallery threshold (no over-letterboxing)', () => {
		// r ≈ 1.22 < 1.4 → stays cover: a real vertical photo fills, only off-aspect ones letterbox.
		expect(pickFit(...dims(V_PORTRAIT), PHONE, GALLERY_MAX_COVER_RATIO)).toBe('cover');
	});

	it('a square photo letterboxes under both (already contained at 1.8, still at the tighter one)', () => {
		expect(pickFit(1000, 1000, PHONE, GALLERY_MAX_COVER_RATIO)).toBe('contain');
	});
});
