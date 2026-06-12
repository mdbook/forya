<script lang="ts">
	// Fixed right-side action rail (TikTok-style), acting on the ACTIVE card.
	// Single instance (not per-card) — Feed wires the handlers to the active item.
	// Sits clear of the full-bleed tap-to-play target and the SPEC-reserved
	// double-tap-to-like gesture (these are buttons on a rail, not gestures).
	import Trash2 from '@lucide/svelte/icons/trash-2';

	let { allowHide, onhide }: { allowHide: boolean; onhide: () => void } = $props();
</script>

{#if allowHide}
	<div class="rail">
		<button class="rail-btn" onclick={onhide} aria-label="Hide this video from the feed">
			<Trash2 size={24} aria-hidden="true" />
		</button>
	</div>
{/if}

<style>
	.rail {
		position: fixed;
		right: calc(env(safe-area-inset-right) + 0.75rem);
		bottom: calc(env(safe-area-inset-bottom) + 4.5rem);
		z-index: 10;
		display: flex;
		flex-direction: column;
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

	.rail-btn:active {
		transform: scale(0.92);
	}
</style>
