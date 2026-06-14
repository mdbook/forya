<script lang="ts">
	import Feed from '$lib/components/Feed.svelte';
	import { invalidateAll } from '$app/navigation';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	// Cold-start "warming" (0.7.0): the server had no in-memory manifest yet (a fresh
	// or just-restarted container), so it served empty + warming:true while a cheap
	// background scan runs (~1-2s on the largest feed). Re-run the load until the
	// manifest lands, then the normal feed renders. No persistence — this happens at
	// most once per container start. SSR renders the warming screen too, so there's
	// never a flash of empty feed. The effect is client-only (effects don't run in
	// SSR); its cleanup stops polling the moment warming clears.
	$effect(() => {
		if (!data.warming) return;
		const t = setInterval(() => void invalidateAll(), 600);
		return () => clearInterval(t);
	});
</script>

<svelte:head>
	<title>{data.feed}</title>
	<!-- Per-instance home-screen name (FEED_NAME) for iOS add-to-home-screen. -->
	<meta name="apple-mobile-web-app-title" content={data.feed} />
</svelte:head>

{#if data.warming}
	<div class="warming" role="status" aria-live="polite">
		<div class="warming-spinner" aria-hidden="true"></div>
		<p class="warming-text">Warming up {data.feed}…</p>
	</div>
{:else}
	<Feed
		items={data.items}
		feedName={data.feed}
		settings={data.settings}
		total={data.total}
		seed={data.seed}
	/>
{/if}

<style>
	.warming {
		position: fixed;
		inset: 0;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 1rem;
		background: #000;
		color: #fff;
	}
	.warming-spinner {
		width: 2.25rem;
		height: 2.25rem;
		border: 3px solid rgba(255, 255, 255, 0.25);
		border-top-color: #fff;
		border-radius: 50%;
		animation: warming-spin 0.8s linear infinite;
	}
	.warming-text {
		margin: 0;
		font-size: 0.95rem;
		opacity: 0.85;
	}
	@media (prefers-reduced-motion: reduce) {
		.warming-spinner {
			animation: none;
		}
	}
	@keyframes warming-spin {
		to {
			transform: rotate(360deg);
		}
	}
</style>
