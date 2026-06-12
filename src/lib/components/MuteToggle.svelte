<script lang="ts">
	// Safe-area corner mute button (SPEC §4). The first tap unlocks audio — the
	// actual unlock (setting the active <video>.muted = false inside the gesture)
	// happens in Feed.toggleMute; this is just the control + icon.
	// Icons are per-icon lucide imports so the bundler tree-shakes them (the rest
	// of the set never ships) — they compile to inline SVG, so the PWA stays
	// offline-safe (no runtime icon CDN).
	import Volume2 from '@lucide/svelte/icons/volume-2';
	import VolumeX from '@lucide/svelte/icons/volume-x';

	let { muted, ontoggle }: { muted: boolean; ontoggle: () => void } = $props();
</script>

<button
	class="mute-toggle"
	onclick={ontoggle}
	aria-label={muted ? 'Unmute' : 'Mute'}
	aria-pressed={!muted}
>
	{#if muted}
		<VolumeX size={22} aria-hidden="true" />
	{:else}
		<Volume2 size={22} aria-hidden="true" />
	{/if}
</button>

<style>
	.mute-toggle {
		position: fixed;
		top: calc(env(safe-area-inset-top) + 0.75rem);
		right: calc(env(safe-area-inset-right) + 0.75rem);
		z-index: 10;
		display: flex;
		align-items: center;
		justify-content: center;
		width: 2.75rem;
		height: 2.75rem;
		padding: 0;
		font-size: 1.25rem;
		line-height: 1;
		color: #fff;
		background: rgba(0, 0, 0, 0.4);
		border: 1px solid rgba(255, 255, 255, 0.15);
		border-radius: 50%;
		cursor: pointer;
		backdrop-filter: blur(8px);
	}

	.mute-toggle:active {
		transform: scale(0.92);
	}
</style>
