<script lang="ts">
	// The vertical feed (SPEC §4). One IntersectionObserver (~0.6 threshold)
	// drives a single active index: the entering card plays, every other card
	// pauses — only one video plays at a time. Layout is 100dvh/100svh scroll-snap
	// (dynamic units only, never the static one) via app.css. Desktop fallback:
	// Up/Down + j/k move snap points, Space play/pause, m mute.
	import { onMount } from 'svelte';
	import VideoCard from './VideoCard.svelte';
	import MuteToggle from './MuteToggle.svelte';
	import type { FeedItem, FeedSettings } from '$lib/types';
	import { loadMute, saveMute } from '$lib/stores/prefs';
	import { loadSeen, saveSeen } from '$lib/stores/seen';

	let {
		items,
		feedName,
		settings
	}: { items: FeedItem[]; feedName: string; settings: FeedSettings } = $props();

	let activeIndex = $state(0);
	let muted = $state(true);
	let feedEl = $state<HTMLElement>();
	let cardEls = $state<HTMLElement[]>([]);

	/** Reactive preload window: metadata for the previous card, active, and next
	 *  two; none for everything else (iOS throttles many decoders). */
	function preloadFor(index: number): 'metadata' | 'none' {
		const d = index - activeIndex;
		return d >= -1 && d <= 2 ? 'metadata' : 'none';
	}

	function activeVideo(): HTMLVideoElement | null {
		return cardEls[activeIndex]?.querySelector('video') ?? null;
	}

	function scrollTo(index: number) {
		const i = Math.max(0, Math.min(items.length - 1, index));
		cardEls[i]?.scrollIntoView({ behavior: 'smooth' });
	}

	function toggleMute() {
		muted = !muted;
		// First-tap audio unlock: flip the live video inside the user gesture.
		const v = activeVideo();
		if (v) {
			v.muted = muted;
			if (!muted) v.play().catch(() => {});
		}
	}

	function togglePlayActive() {
		const v = activeVideo();
		if (!v) return;
		if (v.paused) v.play().catch(() => {});
		else v.pause();
	}

	function onKeydown(e: KeyboardEvent) {
		switch (e.key) {
			case 'ArrowDown':
			case 'j':
				e.preventDefault();
				scrollTo(activeIndex + 1);
				break;
			case 'ArrowUp':
			case 'k':
				e.preventDefault();
				scrollTo(activeIndex - 1);
				break;
			case ' ':
				e.preventDefault();
				togglePlayActive();
				break;
			case 'm':
				toggleMute();
				break;
		}
	}

	onMount(() => {
		muted = loadMute(feedName);

		const resume = loadSeen(feedName);
		if (resume && resume.index > 0 && resume.index < items.length) {
			activeIndex = resume.index;
			cardEls[resume.index]?.scrollIntoView();
		}

		// THE single IntersectionObserver — the only one in the app.
		const io = new IntersectionObserver(
			(entries) => {
				for (const entry of entries) {
					if (entry.isIntersecting && entry.intersectionRatio >= 0.6) {
						const idx = Number((entry.target as HTMLElement).dataset.index);
						if (!Number.isNaN(idx)) activeIndex = idx;
					}
				}
			},
			{ root: feedEl, threshold: [0.6] }
		);

		for (const el of cardEls) if (el) io.observe(el);
		return () => io.disconnect();
	});

	$effect(() => {
		saveMute(feedName, muted);
	});

	$effect(() => {
		saveSeen(feedName, {
			index: activeIndex,
			names: items.slice(0, activeIndex + 1).map((i) => i.name)
		});
	});
</script>

<svelte:window onkeydown={onKeydown} />

{#if items.length === 0}
	<div class="empty">
		<p>No videos yet.</p>
		<p class="hint">Drop .mp4 / .mov / .webm / .m4v files into the feed directory.</p>
	</div>
{:else}
	<div class="feed" bind:this={feedEl}>
		{#each items as item, i (item.name)}
			<div class="card" data-index={i} bind:this={cardEls[i]}>
				<VideoCard {item} active={i === activeIndex} preload={preloadFor(i)} {muted} />
			</div>
		{/each}
	</div>
	<MuteToggle {muted} ontoggle={toggleMute} />
{/if}

<style>
	.empty {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		align-items: center;
		justify-content: center;
		height: 100dvh;
		text-align: center;
		padding: 1.5rem;
	}

	.empty .hint {
		opacity: 0.5;
		font-size: 0.85rem;
	}
</style>
