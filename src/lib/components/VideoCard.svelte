<script lang="ts">
	// One feed item. The iOS-critical bits (SPEC §4): the <video> carries BOTH
	// `muted` and `playsinline` (the two autoplay requirements), plus `loop` and
	// a reactive `preload`. Play/pause is driven by the `active` prop from the
	// single IntersectionObserver in Feed.svelte — this card never observes
	// intersection itself, so only one video plays at a time.
	import { untrack } from 'svelte';
	import Play from '@lucide/svelte/icons/play';
	import type { FeedItem } from '$lib/types';

	let {
		item,
		active,
		live,
		preload,
		muted
	}: {
		item: FeedItem;
		active: boolean;
		/** Inside the lazy-load window → carries a real `<video src>`. Outside →
		 *  srcless placeholder (decoder released). The active card is ALWAYS live
		 *  (Feed guarantees it), so it can always play. */
		live: boolean;
		preload: 'auto' | 'metadata' | 'none';
		muted: boolean;
	} = $props();

	let el = $state<HTMLVideoElement>();
	let loaded = $state(false);
	let buffering = $state(false);
	let needsTap = $state(false);
	let fit = $state<'cover' | 'contain'>('cover');

	// Seek bar (active card only). currentTime/duration are two-way/readonly media
	// bindings; dragging sets currentTime, which issues a fresh Range request —
	// the exact seek path erin broke, so this doubles as live Range validation.
	let currentTime = $state(0);
	let duration = $state(0);
	let scrubbing = $state(false);
	let seekEl = $state<HTMLElement>();
	const progress = $derived(duration > 0 ? Math.min(100, (currentTime / duration) * 100) : 0);

	function seekToClientX(clientX: number) {
		const r = seekEl?.getBoundingClientRect();
		if (!r || !r.width || !duration || !el) return;
		const frac = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
		el.currentTime = frac * duration;
	}

	function onSeekPointerDown(e: PointerEvent) {
		e.stopPropagation();
		scrubbing = true;
		(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
		seekToClientX(e.clientX);
	}

	function onSeekPointerMove(e: PointerEvent) {
		if (!scrubbing) return;
		e.stopPropagation();
		seekToClientX(e.clientX);
	}

	function onSeekPointerUp(e: PointerEvent) {
		scrubbing = false;
		e.stopPropagation();
	}

	function onSeekKey(e: KeyboardEvent) {
		if (!el || !duration) return;
		if (e.key === 'ArrowLeft') {
			e.stopPropagation();
			el.currentTime = Math.max(0, currentTime - 5);
		} else if (e.key === 'ArrowRight') {
			e.stopPropagation();
			el.currentTime = Math.min(duration, currentTime + 5);
		}
	}

	// Pick object-fit from the clip's real aspect (read once dimensions are known).
	// Only clips WIDER than the viewport get `contain` (letterboxed) — `cover`
	// would middle-crop their sides (the operator's horizontal-video complaint).
	// Portrait / near-portrait keeps `cover` so proper vertical content still
	// fills edge-to-edge. The 1.15 slack avoids letterboxing a near-match.
	function chooseFit(v: HTMLVideoElement) {
		const vw = v.videoWidth;
		const vh = v.videoHeight;
		if (!vw || !vh) return;
		const videoAR = vw / vh;
		const containerAR =
			v.clientHeight > 0
				? v.clientWidth / v.clientHeight
				: typeof window !== 'undefined'
					? window.innerWidth / window.innerHeight
					: videoAR;
		fit = videoAR > containerAR * 1.15 ? 'contain' : 'cover';
	}

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

	// Leaving the window: the declarative `src` attribute is already gone (effects
	// run after the DOM update), so load() resets the element to empty and frees
	// the iOS decoder. Reset overlay state so the placeholder returns; re-entering
	// the window rebinds `src` and reloads. The active card never hits this (it's
	// always live), so playback is never interrupted by virtualization.
	$effect(() => {
		const v = el;
		if (!v || live) return;
		untrack(() => v.load());
		loaded = false;
		needsTap = false;
		buffering = false;
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
		bind:currentTime
		bind:duration
		src={live ? item.url : undefined}
		{preload}
		muted
		playsinline
		loop
		class:loaded
		class:contain={fit === 'contain'}
		onloadedmetadata={() => chooseFit(el!)}
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
		<div class="tap-hint" aria-hidden="true">
			<Play size={64} fill="currentColor" />
		</div>
	{/if}

	{#if active}
		<div
			class="seek"
			bind:this={seekEl}
			role="slider"
			tabindex="0"
			aria-label="Seek"
			aria-valuemin={0}
			aria-valuemax={100}
			aria-valuenow={Math.round(progress)}
			onpointerdown={onSeekPointerDown}
			onpointermove={onSeekPointerMove}
			onpointerup={onSeekPointerUp}
			onpointercancel={onSeekPointerUp}
			onkeydown={onSeekKey}
		>
			<div class="seek-track">
				<div class="seek-fill" style:width={`${progress}%`}></div>
			</div>
		</div>
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

	/* Off-aspect (wider-than-viewport) clips letterbox instead of side-cropping.
	   The .media background is #000, so the bars are clean black. */
	video.contain {
		object-fit: contain;
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

	/* Bottom seek bar: a tall transparent touch strip with a thin visible track,
	   sitting above the full-bleed tap target so scrubbing doesn't toggle play. */
	.seek {
		position: absolute;
		left: 0;
		right: 0;
		bottom: 0;
		z-index: 3;
		display: flex;
		align-items: flex-end;
		height: 1.75rem;
		padding-bottom: calc(env(safe-area-inset-bottom) + 0.35rem);
		touch-action: none;
		cursor: pointer;
	}

	.seek-track {
		width: 100%;
		height: 3px;
		margin: 0 0.75rem;
		background: rgba(255, 255, 255, 0.25);
		border-radius: 999px;
		overflow: hidden;
	}

	.seek-fill {
		height: 100%;
		background: rgba(255, 255, 255, 0.9);
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
