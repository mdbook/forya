// Can this browser actually set media volume? (0.17)
//
// iOS/iPadOS Safari makes `HTMLMediaElement.volume` READ-ONLY: an assignment is silently
// ignored and the property reads back 1. Volume there belongs to the hardware side-buttons,
// by WebKit policy — there is no API to override it, and the only "workaround" (routing every
// pooled <video> through a Web Audio gain node) would break the per-element iOS bless model
// the entire play machine depends on. So on iOS a volume slider is furniture: it cannot move
// the audio, and a control that does nothing is worse than no control.
//
// This PROBES rather than sniffing the UA — a feature test can't go stale when Safari changes
// its mind, and it costs one detached element. A UA sniff would also wrongly hide the slider on
// the desktop browsers that spoof iOS strings. If WebKit ever makes volume settable, the probe
// starts returning true and the slider appears with no code change.

/** Probe whether assigning `volume` actually sticks. Detached element, never appended, no
 *  network, no decoder — safe to call at mount. Returns false on the server and on any browser
 *  that ignores the assignment (iOS/iPadOS today). */
export function volumeIsSettable(): boolean {
	if (typeof document === 'undefined') return false;
	try {
		const probe = document.createElement('audio');
		// 0.5 rather than 0 or 1: those are reachable by accident (a browser that clamps
		// everything to 0, or one that ignores the write and already reads 1), so they would
		// both read back "supported" on a browser that in fact ignored us.
		probe.volume = 0.5;
		return probe.volume === 0.5;
	} catch {
		// Some engines throw instead of ignoring — same conclusion either way.
		return false;
	}
}
