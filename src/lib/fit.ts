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

/** Ratio threshold for the DEFAULT crop cap. Was a hand-tuned 1.8 (video, ~44% max crop) /
 *  1.4 (gallery, ~28%) through round-3; now derived from MAX_COVER_CROP ⇒ ≈1.111.
 *
 *  ⚠️ THIS IS THE FALLBACK DEFAULT, NEVER THE EFFECTIVE VALUE. Since the crop cap became an
 *  operator dial (MAX_COVER_CROP → config → settings), the live threshold is whatever Feed
 *  derives from settings and threads to each call site. Use this only where no settings are
 *  reachable (tests, a default for a fresh config) — never as "the" ratio. It used to be the
 *  truth; it is now a build-time snapshot of one particular cap. */
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
	/** REQUIRED ON PURPOSE (review #2269). It defaulted to MAX_COVER_RATIO while that constant
	 *  was the truth; once the cap became an operator dial, a defaulted arg meant a new call
	 *  site would silently pin itself to 0.10 forever and NOTHING would fail — not tsc, not
	 *  svelte-check, not the suite. Requiring it makes tsc enforce the threading, so the
	 *  guarantee belongs to the compiler instead of to whoever remembers this comment. */
	maxCoverRatio: number
): 'cover' | 'contain' {
	if (!videoWidth || !videoHeight || !viewportAR) return 'cover';
	const r = videoWidth / videoHeight / viewportAR;
	return r > maxCoverRatio || r < 1 / maxCoverRatio ? 'contain' : 'cover';
}
