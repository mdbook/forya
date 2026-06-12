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
 *  (in either direction) before we letterbox instead of fill. */
export const MAX_COVER_RATIO = 1.8;

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
