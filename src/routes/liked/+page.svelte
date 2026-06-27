<script lang="ts">
	import Feed from '$lib/components/Feed.svelte';
	import { invalidateAll } from '$app/navigation';
	import { resolve } from '$app/paths';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	// Cold-start "warming" (mirror +page.svelte): the in-memory manifest isn't ready yet, so we
	// can't tell "no favorites" from "not scanned yet". Re-run load until it lands, then render.
	$effect(() => {
		if (!data.warming) return;
		const t = setInterval(() => void invalidateAll(), 600);
		return () => clearInterval(t);
	});
</script>

<svelte:head>
	<title>Liked · {data.feed}</title>
	<meta name="apple-mobile-web-app-title" content="Liked · {data.feed}" />
</svelte:head>

{#if data.warming}
	<div class="state" role="status" aria-live="polite">
		<div class="spinner" aria-hidden="true"></div>
		<p>Loading favorites…</p>
	</div>
{:else if data.items.length === 0}
	<div class="state">
		<p class="title">No favorites yet</p>
		<p class="hint">Double-tap a clip, or tap the ♥, to add it.</p>
		<a class="back" href={resolve('/')}>Back to feed</a>
	</div>
{:else}
	<Feed
		items={data.items}
		feedName={data.feed}
		settings={data.settings}
		total={data.items.length}
		seed={0}
		starred={data.starred}
		likedView
	/>
{/if}

<style>
	.state {
		position: fixed;
		inset: 0;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 0.75rem;
		padding: 1.5rem;
		text-align: center;
		background: #000;
		color: #fff;
	}
	.title {
		margin: 0;
		font-size: 1.1rem;
		font-weight: 600;
	}
	.hint {
		margin: 0;
		font-size: 0.9rem;
		opacity: 0.7;
	}
	.back {
		margin-top: 0.75rem;
		padding: 0.55rem 1.1rem;
		color: #fff;
		text-decoration: none;
		background: rgba(255, 255, 255, 0.12);
		border: 1px solid rgba(255, 255, 255, 0.2);
		border-radius: 999px;
		font-size: 0.9rem;
	}
	.spinner {
		width: 2.25rem;
		height: 2.25rem;
		border: 3px solid rgba(255, 255, 255, 0.25);
		border-top-color: #fff;
		border-radius: 50%;
		animation: spin 0.8s linear infinite;
	}
	@media (prefers-reduced-motion: reduce) {
		.spinner {
			animation: none;
		}
	}
	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}
</style>
