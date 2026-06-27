<script lang="ts">
	// The single control surface (SPEC §4): a fixed right-side rail (TikTok-style)
	// acting on the ACTIVE card. One instance, not per-card — Feed wires the
	// handlers to the active item and owns the audio-unlock logic. Consolidates
	// every control that used to be scattered across the corners (mute was
	// top-right, loop/next top-left, share/info bottom): mute · loop/next · share
	// · info · hide. Sits safe-area-inset, clear of the full-bleed tap-to-play and
	// the SPEC-reserved double-tap-to-like gesture.
	//
	// Icons are per-icon lucide imports so the bundler tree-shakes them (the rest
	// of the set never ships) and they compile to inline SVG — the PWA stays
	// offline-safe (no runtime icon CDN).
	import Volume2 from '@lucide/svelte/icons/volume-2';
	import VolumeX from '@lucide/svelte/icons/volume-x';
	import Heart from '@lucide/svelte/icons/heart';
	import SkipForward from '@lucide/svelte/icons/skip-forward';
	import Share from '@lucide/svelte/icons/share';
	import Info from '@lucide/svelte/icons/info';
	import Trash2 from '@lucide/svelte/icons/trash-2';

	let {
		muted,
		autoAdvance,
		allowHide,
		infoOpen,
		showStarred,
		starred,
		onmute,
		onautoadvance,
		onstar,
		onopenliked,
		onshare,
		oninfo,
		onhide
	}: {
		muted: boolean;
		/** Advance-to-next ("Next") vs loop-this-clip ("Loop"). */
		autoAdvance: boolean;
		allowHide: boolean;
		infoOpen: boolean;
		/** Show the favorite (heart) control — the `starred` feature is on (DATA_DIR set). */
		showStarred: boolean;
		/** Whether the active card is favorited (filled heart). */
		starred: boolean;
		/** First tap also unlocks audio — Feed does the unlock inside the gesture. */
		onmute: () => void;
		onautoadvance: () => void;
		/** Toggle the active card's favorite mark (the a11y / instant path; double-tap is the
		 *  gesture equivalent). */
		onstar: () => void;
		/** LONG-PRESS the heart (~500ms) opens the favorites view. Optional — absent on the
		 *  favorites view itself (no self-entry there). A plain tap stays onstar. 0.9.0. */
		onopenliked?: () => void;
		onshare: () => void;
		oninfo: () => void;
		onhide: () => void;
	} = $props();

	// 0.9.0: LONG-PRESS the heart (~500ms) opens the favorites view; a plain tap toggles the
	// star. A pointer that lifts or cancels before the timer is a tap (timer cleared); once the
	// long-press fires we flag it so the trailing click doesn't ALSO toggle.
	const LONG_PRESS_MS = 500;
	let lpTimer: ReturnType<typeof setTimeout> | undefined;
	let lpFired = false;
	function heartDown() {
		if (!onopenliked) return; // no entry target (e.g. on the favorites view itself)
		lpFired = false;
		clearTimeout(lpTimer);
		lpTimer = setTimeout(() => {
			lpFired = true;
			onopenliked?.();
		}, LONG_PRESS_MS);
	}
	function heartCancel() {
		clearTimeout(lpTimer);
	}
	function heartClick() {
		if (lpFired) {
			lpFired = false; // the long-press already opened the view — swallow this tap
			return;
		}
		onstar();
	}
</script>

<div class="rail">
	<button
		class="rail-btn"
		onclick={onmute}
		aria-label={muted ? 'Unmute' : 'Mute'}
		aria-pressed={!muted}
	>
		{#if muted}
			<VolumeX size={24} aria-hidden="true" />
		{:else}
			<Volume2 size={24} aria-hidden="true" />
		{/if}
	</button>

	{#if showStarred}
		<!-- Favorite (heart): filled red when starred. The double-tap gesture is the primary
		     path; this button is the instant, unambiguous, a11y-friendly equivalent. -->
		<button
			class="rail-btn heart-btn"
			class:starred
			onclick={heartClick}
			onpointerdown={heartDown}
			onpointerup={heartCancel}
			onpointercancel={heartCancel}
			onpointerleave={heartCancel}
			aria-label={starred ? 'Remove from favorites' : 'Add to favorites'}
			aria-pressed={starred}
		>
			<Heart size={24} fill={starred ? 'currentColor' : 'none'} aria-hidden="true" />
		</button>
	{/if}

	<!-- Autoplay-next toggle: a single SKIP icon, always (no glyph-swap). State is conveyed by
	     the white `.on` styling when enabled + the toast on toggle — the text label and the
	     loop-glyph swap were redundant (operator, #482). -->
	<button
		class="rail-btn"
		class:on={autoAdvance}
		onclick={onautoadvance}
		aria-label={autoAdvance ? 'Autoplay next is on' : 'Autoplay next is off'}
		aria-pressed={autoAdvance}
	>
		<SkipForward size={24} aria-hidden="true" />
	</button>

	<button class="rail-btn" onclick={onshare} aria-label="Share or save this video">
		<Share size={24} aria-hidden="true" />
	</button>

	<button
		class="rail-btn"
		class:on={infoOpen}
		onclick={oninfo}
		aria-label="Toggle video info"
		aria-pressed={infoOpen}
	>
		<Info size={24} aria-hidden="true" />
	</button>

	{#if allowHide}
		<button class="rail-btn" onclick={onhide} aria-label="Hide this video from the feed">
			<Trash2 size={24} aria-hidden="true" />
		</button>
	{/if}
</div>

<style>
	.rail {
		position: fixed;
		right: calc(env(safe-area-inset-right) + 0.75rem);
		bottom: calc(env(safe-area-inset-bottom) + 4.5rem);
		z-index: 10;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 1rem;
	}

	.rail-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 2.75rem;
		height: 2.75rem;
		padding: 0;
		color: #fff;
		background: rgba(0, 0, 0, 0.4);
		border: 1px solid rgba(255, 255, 255, 0.15);
		border-radius: 50%;
		cursor: pointer;
		backdrop-filter: blur(8px);
	}

	.rail-btn.on {
		background: rgba(255, 255, 255, 0.85);
		color: #000;
	}

	/* The heart also LONG-PRESSES to open the favorites view (0.9.0) — suppress the iOS
	   long-press callout/selection so the hold reads as a gesture, not a text action. */
	.heart-btn {
		-webkit-touch-callout: none;
		user-select: none;
	}
	/* Favorited: a filled red heart (the icon's `fill` is set inline). Distinct from the
	   white `.on` toggle style so "favorited" reads as a heart, not a generic active button. */
	.heart-btn.starred {
		color: #ff2d55;
	}

	.rail-btn:active {
		transform: scale(0.92);
	}

	/* Rounded keyboard-focus ring (the global square :focus-visible outline reads wrong on a
	   50%-radius button); box-shadow follows the border-radius. Double ring stays visible on
	   any underlying frame. (#4) */
	.rail-btn:focus-visible {
		outline: none;
		box-shadow:
			0 0 0 2px #000,
			0 0 0 4px #fff;
	}
</style>
