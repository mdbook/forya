// Session-scoped "playback unlocked" flag, shared across all cards.
//
// iOS only lets a <video> play *unmuted* (and plays reliably) after a real user
// gesture. The very first tap-to-play or unmute flips this true; cards then know
// the page is gesture-unlocked and can retry a transiently-rejected play() once
// instead of immediately surfacing a manual play button.
//
// IMPORTANT (SPEC §4, criterion 3): this flag must NEVER gate the initial *muted*
// autoplay. The active card always attempts muted+playsinline autoplay on load
// with no tap — `unlocked` only governs unmuted/post-reject retry behaviour.
export const playback = $state({ unlocked: false });

/** Mark the session gesture-unlocked (called from inside a user gesture). */
export function unlockPlayback(): void {
	playback.unlocked = true;
}
