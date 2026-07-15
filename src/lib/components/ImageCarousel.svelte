<script lang="ts">
	// Swipeable photo-post gallery (image-galleries milestone, Contract A). Renders a gallery
	// FeedItem's ordered `media[]` frames as a horizontal carousel — the render branch for a
	// gallery card in Feed.svelte (the video path renders VideoCard instead). This component is
	// DELIBERATELY inert to the <video> pool: it owns no pooled element, registers no slot
	// (no `onslot`), and never touches the cure machine — so a gallery interleaved between
	// videos consumes no decoder and can't perturb `activePaused`/the pool blessing (AC-4).
	//
	// Vertical scroll must still page the feed (100dvh scroll-snap), so the swipe surface is
	// `touch-action: pan-y`: the browser owns vertical panning (feed scroll) natively and we
	// only claim HORIZONTAL drags to advance frames. No feed-scroll hijack.
	import { pickFit } from '$lib/fit';
	import type { FeedItem } from '$lib/types';

	let {
		item,
		active,
		viewportAR
	}: {
		item: FeedItem;
		/** This card is the active (in-viewport) one — gates ±1 adjacent preload. */
		active: boolean;
		/** Viewport aspect ratio (w/h), reactive — drives per-frame object-fit on rotate/resize. */
		viewportAR: number;
	} = $props();

	const frames = $derived(item.media ?? []);
	let index = $state(0);

	// Restart at the first frame when the card scrolls away, so returning to it opens on the
	// cover (mirrors the video path's t=0 fresh-arrival restart). Only writes `index`; reads
	// only `active` → no self-loop.
	$effect(() => {
		if (!active) index = 0;
	});

	function go(next: number) {
		const n = frames.length;
		if (n === 0) return;
		index = Math.min(n - 1, Math.max(0, next));
	}

	// Load the current frame always (so an off-active gallery still shows its cover); load the
	// ±1 neighbours only while active, so a swipe is ready without loading every gallery in the
	// mount window. Bounds image requests: inactive gallery = 1 image, active = 3.
	function shouldLoad(i: number): boolean {
		return i === index || (active && Math.abs(i - index) <= 1);
	}

	// Per-frame object-fit: cover by default, contain for an off-aspect frame — same rule as the
	// pooled <video> (pickFit). Frames in one gallery can differ in aspect (spike #1378 saw
	// 1080x1350 / 1078x1614 / 1046x1423), so each frame fits on its own natural dims once loaded.
	let natural = $state<Record<number, { w: number; h: number }>>({});
	function onImgLoad(i: number, e: Event) {
		const img = e.currentTarget as HTMLImageElement;
		if (img.naturalWidth > 0)
			natural = { ...natural, [i]: { w: img.naturalWidth, h: img.naturalHeight } };
	}
	function fitClass(i: number): '' | 'contain' {
		const nd = natural[i];
		return nd && pickFit(nd.w, nd.h, viewportAR) === 'contain' ? 'contain' : '';
	}

	// Horizontal-swipe detection via pointer events (works mouse + touch). With touch-action:
	// pan-y the browser never consumes horizontal movement, so these fire for a horizontal drag
	// while a vertical drag is left to the feed's native scroll-snap. A drag past THRESHOLD px
	// (or a fast flick) advances one frame; a short drag is a tap → advance forward (a light
	// TikTok-style tap-through), left third taps back.
	const THRESHOLD = 40;
	let downX = 0;
	let downY = 0;
	let dragging = false;
	let horizontal = false;

	function onPointerDown(e: PointerEvent) {
		downX = e.clientX;
		downY = e.clientY;
		dragging = true;
		horizontal = false;
	}
	function onPointerMove(e: PointerEvent) {
		if (!dragging) return;
		const dx = e.clientX - downX;
		const dy = e.clientY - downY;
		// Once a gesture is clearly horizontal, mark it so pointerup treats it as a swipe (and
		// not a tap). Vertical-dominant gestures are left alone → feed scroll.
		if (!horizontal && Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy)) horizontal = true;
	}
	function onPointerUp(e: PointerEvent) {
		if (!dragging) return;
		dragging = false;
		const dx = e.clientX - downX;
		const dy = e.clientY - downY;
		if (horizontal || (Math.abs(dx) > THRESHOLD && Math.abs(dx) > Math.abs(dy))) {
			go(index + (dx < 0 ? 1 : -1)); // swipe left → next, right → prev
			return;
		}
		// Not a swipe → a tap. Left third = back, elsewhere = forward (desktop/click affordance).
		const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
		const frac = r.width ? (e.clientX - r.left) / r.width : 1;
		go(index + (frac < 0.33 ? -1 : 1));
	}
	function onPointerCancel() {
		dragging = false;
	}
</script>

<div class="media">
	<!-- Carousel = a labeled group (APG pattern); real prev/next <button>s below carry the
	     accessible click + keyboard nav. The swipe surface owns horizontal DRAGS (touch primary
	     on iOS) + tap-to-step via POINTER events only (no keyboard handler here → no a11y-rule
	     trip); touch-action:pan-y leaves vertical to the feed's scroll-snap. Pointer swipe is a
	     touch/mouse enhancement over the SAME go() the buttons drive; keyboard/AT users use them. -->
	<div
		class="carousel"
		role="group"
		aria-roledescription="carousel"
		aria-label={`Photo gallery, ${frames.length} ${frames.length === 1 ? 'image' : 'images'}`}
		onpointerdown={onPointerDown}
		onpointermove={onPointerMove}
		onpointerup={onPointerUp}
		onpointercancel={onPointerCancel}
	>
		<div class="track" style:transform={`translateX(${-index * 100}%)`}>
			{#each frames as frame, i (frame.name)}
				<div class="frame">
					{#if shouldLoad(i)}
						<img
							class={fitClass(i)}
							src={frame.url}
							alt=""
							draggable="false"
							onload={(e) => onImgLoad(i, e)}
						/>
					{/if}
				</div>
			{/each}
		</div>
	</div>

	{#if frames.length > 1}
		<!-- Accessible discrete nav (click + keyboard): edge arrow chips, disabled at the ends.
		     Kept small so a mid-screen swipe isn't intercepted; they're the keyboard/AT path. -->
		<button
			class="nav prev"
			aria-label="Previous image"
			disabled={index === 0}
			onclick={() => go(index - 1)}>‹</button
		>
		<button
			class="nav next"
			aria-label="Next image"
			disabled={index === frames.length - 1}
			onclick={() => go(index + 1)}>›</button
		>

		<!-- Position indicator: dots for a small gallery, a compact `N / M` pill once it gets busy. -->
		{#if frames.length <= 8}
			<div class="dots" aria-hidden="true">
				{#each frames as frame, i (frame.name)}
					<span class="dot" class:on={i === index}></span>
				{/each}
			</div>
		{:else}
			<div class="counter" aria-hidden="true">{index + 1} / {frames.length}</div>
		{/if}
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

	.carousel {
		position: absolute;
		inset: 0;
		/* Vertical panning → feed scroll (native); we claim only horizontal drags. */
		touch-action: pan-y;
	}

	.track {
		display: flex;
		width: 100%;
		height: 100%;
		transition: transform 0.3s ease;
		will-change: transform;
	}

	.frame {
		position: relative;
		flex: 0 0 100%;
		width: 100%;
		height: 100%;
	}

	.frame img {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		object-fit: cover;
		/* Match the pooled <video>: cover by default, contain for an off-aspect frame. */
		-webkit-user-select: none;
		user-select: none;
	}

	.frame img.contain {
		object-fit: contain;
	}

	/* Discrete prev/next controls (accessible click + keyboard). Vertically centered edge chips,
	   translucent; hidden from view but kept operable at the ends via `disabled`. Small footprint
	   so a horizontal swipe across the middle of the frame isn't intercepted. */
	.nav {
		position: absolute;
		top: 50%;
		z-index: 4;
		display: flex;
		align-items: center;
		justify-content: center;
		width: 2.25rem;
		height: 2.25rem;
		margin-top: -1.125rem;
		padding: 0;
		color: #fff;
		font-size: 1.5rem;
		line-height: 1;
		background: rgba(0, 0, 0, 0.35);
		border: 0;
		border-radius: 50%;
		backdrop-filter: blur(6px);
		cursor: pointer;
		opacity: 0.75;
	}

	.nav.prev {
		left: calc(env(safe-area-inset-left) + 0.5rem);
	}

	.nav.next {
		right: calc(env(safe-area-inset-right) + 0.5rem);
	}

	.nav:disabled {
		opacity: 0;
		pointer-events: none;
	}

	.nav:active {
		transform: scale(0.92);
	}

	.dots {
		position: absolute;
		left: 0;
		right: 0;
		bottom: calc(env(safe-area-inset-bottom) + 0.75rem);
		z-index: 3;
		display: flex;
		justify-content: center;
		gap: 0.35rem;
		pointer-events: none;
	}

	.dot {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: rgba(255, 255, 255, 0.4);
		transition: background 0.2s ease;
	}

	.dot.on {
		background: rgba(255, 255, 255, 0.95);
	}

	.counter {
		position: absolute;
		top: calc(env(safe-area-inset-top) + 0.75rem);
		right: calc(env(safe-area-inset-right) + 0.75rem);
		z-index: 3;
		padding: 0.2rem 0.6rem;
		color: #fff;
		font-size: 0.8rem;
		font-weight: 600;
		background: rgba(0, 0, 0, 0.45);
		border-radius: 999px;
		backdrop-filter: blur(8px);
		pointer-events: none;
	}
</style>
