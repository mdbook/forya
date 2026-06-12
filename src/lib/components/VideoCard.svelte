<script lang="ts">
	// One feed item. The iOS-critical bits (SPEC §4): the <video> carries BOTH
	// `muted` and `playsinline` (the two autoplay requirements), plus `loop` and
	// a reactive `preload`. Play/pause is driven by the `active` prop from the
	// single IntersectionObserver in Feed.svelte — this card never observes
	// intersection itself, so only one video plays at a time.
	import { onDestroy, untrack } from 'svelte';
	import Play from '@lucide/svelte/icons/play';
	import { pickFit } from '$lib/fit';
	import { playback, unlockPlayback } from '$lib/stores/playback.svelte';
	import type { FeedItem } from '$lib/types';

	let {
		item,
		active,
		live,
		preload,
		muted,
		autoAdvance,
		viewportAR,
		onfinished
	}: {
		item: FeedItem;
		active: boolean;
		/** Inside the lazy-load window → carries a real `<video src>`. Outside →
		 *  srcless placeholder (decoder released). The active card is ALWAYS live
		 *  (Feed guarantees it), so it can always play. */
		live: boolean;
		preload: 'auto' | 'metadata' | 'none';
		muted: boolean;
		/** Advance to the next card on end instead of looping. */
		autoAdvance: boolean;
		/** Viewport aspect ratio (w/h), reactive — drives object-fit so the card
		 *  re-letterboxes on rotate/resize, not just at load. */
		viewportAR: number;
		onfinished: () => void;
	} = $props();

	let el = $state<HTMLVideoElement>();
	let loaded = $state(false);
	let buffering = $state(false);
	// `blocked`: autoplay was attempted and rejected (no gesture yet). `paused`:
	// the user tapped to pause. The manual play affordance shows for EITHER — and
	// only then, so a normally-autoplaying card never flashes a play button. The
	// buffering spinner is rendered only when that affordance is NOT up, so the
	// two can never stack (the "buffer behind play button" bug).
	let blocked = $state(false);
	let paused = $state(false);
	// Intrinsic video dimensions (set once metadata loads); fit derives from these.
	let vw = $state(0);
	let vh = $state(0);

	// `src` lags the `live` window by a short hysteresis so a small back-scroll
	// (past a card then straight back) doesn't drop and reload it → blank frame.
	// The active card is always live, so it never enters the release path.
	let srcLive = $state(false);
	let releaseTimer: ReturnType<typeof setTimeout> | undefined;
	const RELEASE_DELAY_MS = 1200;

	const showPlay = $derived(active && (blocked || paused));
	const showSpinner = $derived(active && buffering && loaded && !showPlay);

	// Reactive on viewportAR, so rotating/resizing re-letterboxes. Decision logic
	// lives in the pure `pickFit` (guarded by tests/fit.test.ts).
	const fit = $derived(pickFit(vw, vh, viewportAR));

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

	function readDimensions(v: HTMLVideoElement) {
		vw = v.videoWidth;
		vh = v.videoHeight;
		// Coax iOS into decoding/painting a poster frame even while paused/pre-
		// gesture, so a scrolled-to (or autoplay-blocked) card shows its first
		// frame instead of blank black. Best-effort — ignored if not yet seekable.
		if (v.paused && v.currentTime === 0) {
			try {
				v.currentTime = Math.min(0.05, (v.duration || 1) / 2);
			} catch {
				/* not seekable yet — harmless */
			}
		}
	}

	function tryPlay(v: HTMLVideoElement) {
		// Muted autoplay is gesture-free (SPEC §4, criterion 3): we ALWAYS attempt
		// it regardless of unlock state. `playback.unlocked` only decides whether a
		// transient rejection is retried silently vs surfaced as a play button.
		v.muted = muted;
		const p = v.play();
		if (p && typeof p.then === 'function') {
			p.then(() => (blocked = false)).catch(() => {
				if (playback.unlocked) {
					requestAnimationFrame(() => {
						v.play()
							.then(() => (blocked = false))
							.catch(() => (blocked = true));
					});
				} else {
					blocked = true;
				}
			});
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

	// Hysteresis: bring `src` in immediately when the card enters the window; on
	// leaving, hold it RELEASE_DELAY_MS before dropping (cancelled if it re-enters
	// first). Depends only on `live` — the srcLive read is untracked to avoid a
	// self-triggering loop.
	$effect(() => {
		const isLive = live;
		untrack(() => {
			clearTimeout(releaseTimer);
			if (isLive) {
				srcLive = true;
			} else if (srcLive) {
				releaseTimer = setTimeout(() => (srcLive = false), RELEASE_DELAY_MS);
			}
		});
	});

	// Once `src` is actually gone (srcLive false → the declarative attr is already
	// removed), load() resets the element to empty and frees the iOS decoder.
	// Reset overlay state so the placeholder returns; re-entering rebinds + reloads.
	// The active card never hits this (always live → always srcLive).
	$effect(() => {
		const v = el;
		if (!v || srcLive) return;
		untrack(() => v.load());
		loaded = false;
		blocked = false;
		buffering = false;
		paused = false;
	});

	onDestroy(() => clearTimeout(releaseTimer));

	function togglePlay() {
		const v = el;
		if (!v) return;
		unlockPlayback(); // a tap is a real user gesture
		if (v.paused) {
			paused = false;
			blocked = false;
			tryPlay(v);
		} else {
			v.pause();
			paused = true;
		}
	}
</script>

<div class="media">
	<video
		bind:this={el}
		bind:currentTime
		bind:duration
		src={srcLive ? item.url : undefined}
		{preload}
		muted
		playsinline
		loop={!autoAdvance}
		class:loaded
		class:contain={fit === 'contain'}
		onloadedmetadata={() => readDimensions(el!)}
		onloadeddata={() => (loaded = true)}
		onended={() => {
			if (active && autoAdvance) onfinished();
		}}
		onwaiting={() => (buffering = true)}
		onplay={() => {
			paused = false;
			blocked = false;
		}}
		onplaying={() => {
			buffering = false;
			blocked = false;
		}}
	></video>

	{#if !loaded}
		<div class="placeholder">
			<span class="caption">{item.name}</span>
		</div>
	{/if}

	{#if showSpinner}
		<div class="spinner" aria-hidden="true"></div>
	{/if}

	<!-- Full-bleed tap target: tap = play/pause (a real <button> for a11y +
	     keyboard). The action rail sits above this via z-index. -->
	<button class="tap" aria-label="Play or pause" onclick={togglePlay}></button>

	{#if showPlay}
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
