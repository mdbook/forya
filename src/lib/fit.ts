// Object-fit decision for a clip in the feed. Pure so it's unit-testable.
//
// `cover` (fill, edge-to-edge) while the clip's aspect is close to the
// viewport's; `contain` (letterbox) once they diverge far enough that `cover`
// would crop a big chunk — in EITHER direction:
//   - a landscape clip on a portrait phone   → side-cropped   → contain
//   - a portrait clip on a landscape display  → top/bottom-cropped → contain
// A normal 9:16 clip on a phone (ratio ~1.2) stays `cover`; clearly-off aspects
// (16:9 → ~3.9, 9:16-on-desktop → ~0.32) letterbox.

/** Default ratio threshold: how far the clip/viewport aspect ratio may diverge
 *  (in either direction) before we letterbox instead of fill. Tuned for VIDEO —
 *  TikTok clips are near-always 9:16, so at ~1.8 a normal clip fills and only a
 *  genuinely off-aspect one letterboxes. At the threshold, `cover` crops up to
 *  ~1-1/1.8 ≈ 44% of the long edge. */
export const MAX_COVER_RATIO = 1.8;

/** Tighter threshold for GALLERY photo frames (round-3 crop fix, #1526). Photo
 *  posts carry varied aspects (3:4, 4:5, square, landscape) — not the uniform 9:16
 *  of videos — so the video default over-crops them ("cuts out a lot of the image"):
 *  a 4:5 photo on a tall phone is r≈1.74 → still `cover` at 1.8 → ~42% cropped. At
 *  1.4 it letterboxes instead, capping cover-crop at ~1-1/1.4 ≈ 28% (users would
 *  rather see the whole photo than lose a third of it — the TikTok/IG photo default).
 *  Applied ONLY by ImageCarousel via pickFit's maxCoverRatio param; the video pool
 *  keeps MAX_COVER_RATIO untouched. Device-tunable. */
export const GALLERY_MAX_COVER_RATIO = 1.4;

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
