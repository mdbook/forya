// Object-fit decision for a clip in the feed. Pure so it's unit-testable.
//
// `cover` (fill, edge-to-edge) only while cropping ≤ MAX_COVER_CROP of the media;
// past that we `contain` (letterbox, ZERO crop) and paint a blurred background-fill
// behind it (VideoCard / ImageCarousel) so a letterboxed clip reads like a TikTok/IG
// reel, not black bars. Guards BOTH crop directions:
//   - a landscape clip on a portrait phone   → side-cropped       → contain
//   - a portrait clip on a landscape display  → top/bottom-cropped → contain
// A near-aspect clip (within the cap) still fills; only genuinely off-aspect media
// letterboxes.
//
// THE CROP MATH (what the bound test in tests/fit.test.ts proves). `cover` scales the
// media to fill the box and crops the overflow. With r = mediaAR / viewportAR the
// cropped fraction is 1 − min(r, 1/r) — all width when r>1, all height when r<1. It's
// 0 at r=1 and rises monotonically with |log r|. So "crop ≤ cap" ⇔ min(r,1/r) ≥ 1−cap
// ⇔ r ∈ [1−cap, 1/(1−cap)]. We gate with a single symmetric ratio R = 1/(1−cap) (the
// tighter, r>1 bound) and test 1/R ≤ r ≤ R: at EITHER boundary the crop is exactly
// `cap`, so `cover` NEVER crops more than the cap.

/** THE tunable: max fraction of a clip/photo that `cover` may crop before we
 *  letterbox (+ blur-fill) instead. Operator rule (2026-07-28): up to ~10%. One knob
 *  for BOTH the video pool and the gallery (the old 1.8/1.4 split collapsed to this —
 *  a single cap is what the operator wants, and gallery photos are no longer harmed by
 *  the video default because there IS no separate video default anymore). Device-
 *  tunable: dial 0.05–0.15 to taste; everything downstream derives from this. */
export const MAX_COVER_CROP = 0.1;

/** Ratio threshold for a crop cap: R = 1/(1−cap). `cover` iff 1/R ≤ r ≤ R. */
export function ratioForCropCap(crop: number): number {
	return 1 / (1 - crop);
}

/** Default ratio threshold, derived from MAX_COVER_CROP. Was a hand-tuned 1.8 (video,
 *  ~44% max crop) / 1.4 (gallery, ~28%) through round-3; now pinned to the 10% crop
 *  cap ⇒ ≈1.111. Kept exported (and as pickFit's default) so call sites are unchanged. */
export const MAX_COVER_RATIO = ratioForCropCap(MAX_COVER_CROP);

/** Fraction of the media `cover` WOULD crop at these dims (0 = none). `contain` crops
 *  nothing, so this only bites when pickFit returns 'cover'. Exposed for the bound test
 *  and for callers that want to decide whether to paint the blur-fill. */
export function coverCropFraction(
	videoWidth: number,
	videoHeight: number,
	viewportAR: number
): number {
	if (!videoWidth || !videoHeight || !viewportAR) return 0;
	const r = videoWidth / videoHeight / viewportAR;
	return 1 - Math.min(r, 1 / r);
}

export function pickFit(
	videoWidth: number,
	videoHeight: number,
	viewportAR: number,
	maxCoverRatio: number = MAX_COVER_RATIO
): 'cover' | 'contain' {
	if (!videoWidth || !videoHeight || !viewportAR) return 'cover';
	const r = videoWidth / videoHeight / viewportAR;
	return r > maxCoverRatio || r < 1 / maxCoverRatio ? 'contain' : 'cover';
}
