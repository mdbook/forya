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
	import Repeat from '@lucide/svelte/icons/repeat';
	import SkipForward from '@lucide/svelte/icons/skip-forward';
	import Share from '@lucide/svelte/icons/share';
	import Info from '@lucide/svelte/icons/info';
	import Trash2 from '@lucide/svelte/icons/trash-2';

	let {
		muted,
		autoAdvance,
		allowHide,
		infoOpen,
		onmute,
		onautoadvance,
		onshare,
		oninfo,
		onhide
	}: {
		muted: boolean;
		/** Advance-to-next ("Next") vs loop-this-clip ("Loop"). */
		autoAdvance: boolean;
		allowHide: boolean;
		infoOpen: boolean;
		/** First tap also unlocks audio — Feed does the unlock inside the gesture. */
		onmute: () => void;
		onautoadvance: () => void;
		onshare: () => void;
		oninfo: () => void;
		onhide: () => void;
	} = $props();
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

	<!-- Loop/next mode: lit when "Next" (the non-default mode) is active, and the
	     label spells out the CURRENT mode so it's unambiguous what's playing. -->
	<button
		class="rail-btn mode-btn"
		class:on={autoAdvance}
		onclick={onautoadvance}
		aria-label={autoAdvance ? 'Autoplay next is on' : 'Loop is on'}
		aria-pressed={autoAdvance}
	>
		{#if autoAdvance}
			<SkipForward size={22} aria-hidden="true" />
			<span class="mode-label">Next</span>
		{:else}
			<Repeat size={22} aria-hidden="true" />
			<span class="mode-label">Loop</span>
		{/if}
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

	/* The mode button carries a label under its icon, so it's a taller pill. */
	.mode-btn {
		flex-direction: column;
		gap: 0.1rem;
		height: auto;
		padding: 0.5rem 0;
		border-radius: 1.375rem;
	}

	.mode-label {
		font-size: 0.6rem;
		font-weight: 600;
		line-height: 1;
		letter-spacing: 0.02em;
	}

	.rail-btn.on {
		background: rgba(255, 255, 255, 0.85);
		color: #000;
	}

	.rail-btn:active {
		transform: scale(0.92);
	}
</style>
