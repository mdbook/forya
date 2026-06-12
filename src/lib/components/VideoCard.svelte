<script lang="ts">
	// One feed item. The iOS-critical bits (SPEC §4): the <video> carries BOTH
	// `muted` and `playsinline` (the two autoplay requirements), plus `loop` and
	// a reactive `preload`. Play/pause is driven by the `active` prop from the
	// single IntersectionObserver in Feed.svelte — this card never observes
	// intersection itself, so only one video plays at a time.
	import { untrack } from 'svelte';
	import type { FeedItem } from '$lib/types';

	let {
		item,
		active,
		preload,
		muted
	}: {
		item: FeedItem;
		active: boolean;
		preload: 'metadata' | 'none';
		muted: boolean;
	} = $props();

	let el = $state<HTMLVideoElement>();
	let loaded = $state(false);
	let buffering = $state(false);
	let needsTap = $state(false);

	function tryPlay(v: HTMLVideoElement) {
		v.muted = muted;
		const p = v.play();
		if (p && typeof p.then === 'function') {
			// iOS rejects autoplay if anything is off → surface a tap-to-play overlay.
			p.then(() => (needsTap = false)).catch(() => (needsTap = true));
		}
	}

	// Active → play; inactive → pause. Reads only `active`; mute changes are
	// handled by the separate effect below so toggling mute never restarts playback.
	$effect(() => {
		const v = el;
		if (!v) return;
		if (active) {
			untrack(() => tryPlay(v));
		} else {
			untrack(() => v.pause());
		}
	});

	// Keep the live mute state in sync without re-triggering play/pause.
	$effect(() => {
		const v = el;
		if (v) v.muted = muted;
	});

	function togglePlay() {
		const v = el;
		if (!v) return;
		if (v.paused) tryPlay(v);
		else v.pause();
	}
</script>

<div class="media">
	<video
		bind:this={el}
		src={item.url}
		{preload}
		muted
		playsinline
		loop
		class:loaded
		onloadeddata={() => (loaded = true)}
		onwaiting={() => (buffering = true)}
		onplaying={() => {
			buffering = false;
			needsTap = false;
		}}
	></video>

	{#if !loaded}
		<div class="placeholder">
			<span class="caption">{item.name}</span>
		</div>
	{/if}

	{#if buffering && loaded}
		<div class="spinner" aria-hidden="true"></div>
	{/if}

	<!-- Full-bleed tap target: tap = play/pause (a real <button> for a11y +
	     keyboard). The fixed MuteToggle sits above this via z-index. -->
	<button class="tap" aria-label="Play or pause" onclick={togglePlay}></button>

	{#if needsTap}
		<div class="tap-hint" aria-hidden="true">►</div>
	{/if}
</div>

<style>
	.media {
		position: relative;
		width: 100%;
		height: 100%;
		overflow: hidden;
		background: #000;
	}

	video {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		object-fit: cover;
		opacity: 0;
		transition: opacity 0.25s ease;
	}

	video.loaded {
		opacity: 1;
	}

	.placeholder {
		position: absolute;
		inset: 0;
		display: flex;
		align-items: flex-end;
		padding: 1.5rem;
		background: linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%);
	}

	.caption {
		font-size: 0.85rem;
		opacity: 0.55;
		word-break: break-word;
	}

	.tap {
		position: absolute;
		inset: 0;
		z-index: 1;
		width: 100%;
		height: 100%;
		padding: 0;
		margin: 0;
		border: 0;
		background: transparent;
		cursor: pointer;
		appearance: none;
	}

	.tap-hint {
		position: absolute;
		inset: 0;
		z-index: 2;
		display: flex;
		align-items: center;
		justify-content: center;
		font-size: 4rem;
		color: rgba(255, 255, 255, 0.85);
		pointer-events: none;
		text-shadow: 0 2px 12px rgba(0, 0, 0, 0.6);
	}

	.spinner {
		position: absolute;
		top: 50%;
		left: 50%;
		z-index: 2;
		width: 2.5rem;
		height: 2.5rem;
		margin: -1.25rem 0 0 -1.25rem;
		border: 3px solid rgba(255, 255, 255, 0.25);
		border-top-color: rgba(255, 255, 255, 0.9);
		border-radius: 50%;
		pointer-events: none;
		animation: spin 0.8s linear infinite;
	}

	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}
</style>
