<script lang="ts">
	// Presentation SHELL for one feed item (0.6). It no longer owns a `<video>` — the
	// iOS play machine moved to a small PERSISTENT POOL of elements owned by Feed.svelte
	// (so a gesture-blessed element can be reused via `src`-swap and carry sound across
	// cards; see src/lib/pool.ts). This component renders only the chrome: the gradient/
	// poster placeholder, the reveal cross-fade target (a `slot` where Feed parks the
	// pooled `<video>`), the full-bleed tap target, the active-card seek bar, and the
	// play/buffering affordances. Playback STATE is owned by Feed and passed in;
	// gestures (tap, seek) are reported back out. The single IntersectionObserver still
	// lives in Feed and drives `active`.
	import Play from '@lucide/svelte/icons/play';
	import Heart from '@lucide/svelte/icons/heart';
	import { pickFit } from '$lib/fit';
	import type { FeedItem } from '$lib/types';

	let {
		item,
		active,
		showStarred,
		starred,
		viewportAR,
		posters,
		revealed,
		buffering,
		blocked,
		paused,
		currentTime,
		duration,
		onslot,
		onseek,
		onseekby,
		ontap
	}: {
		item: FeedItem;
		active: boolean;
		/** The favorite (starred) feature is on (DATA_DIR set) — gate the on-card heart. */
		showStarred: boolean;
		/** This clip is in the starred set → show a filled heart badge on the card (0.9.0). */
		starred: boolean;
		/** Viewport aspect ratio (w/h), reactive — drives object-fit so the card
		 *  re-letterboxes on rotate/resize. */
		viewportAR: number;
		/** Generated posters available (DATA_DIR on) — gate the `/api/poster` request. */
		posters: boolean;
		/** Feed: this card's parked pooled `<video>` has painted (reached `playing`) →
		 *  fade the placeholder out over it (the reveal cross-fade). */
		revealed: boolean;
		/** Active-card playback state, owned by Feed (the pooled element it drives). */
		buffering: boolean;
		blocked: boolean;
		paused: boolean;
		currentTime: number;
		duration: number;
		/** Report this shell's slot element (where Feed parks the pooled `<video>`), or
		 *  null on teardown, so Feed can reparent the element onto the active/neighbour
		 *  cards. */
		onslot: (el: HTMLElement | null) => void;
		/** Seek the active card's pooled element to `frac` (0..1) of duration. */
		onseek: (frac: number) => void;
		/** Nudge the active card's pooled element by `delta` seconds (keyboard). */
		onseekby: (delta: number) => void;
		/** Tap the full-bleed target → Feed toggles play/pause on the active element. The
		 *  MouseEvent is forwarded so Feed can place the double-tap heart at the tap point. */
		ontap: (e?: MouseEvent) => void;
	} = $props();

	// The manual play affordance shows for a blocked (autoplay-rejected) OR user-paused
	// ACTIVE card — and only then, so a normally-autoplaying card never flashes a play
	// button. The spinner shows only when that affordance is NOT up (never stacked).
	const showPlay = $derived(active && (blocked || paused));
	const showSpinner = $derived(active && buffering && !showPlay);

	// Object-fit from the manifest's intrinsic dims (0.5/M2) + viewportAR; reactive so a
	// rotate re-letterboxes. The pooled <video>'s own fit class is set by Feed (it owns
	// the element); here we only need it for the poster image.
	const fitW = $derived(item.width || 0);
	const fitH = $derived(item.height || 0);
	const fit = $derived(pickFit(fitW, fitH, viewportAR));

	// Poster (0.5/M3): shown in the placeholder until the video reveals. Requested only
	// when the feature is on; `posterOk` gates display to a SUCCESSFUL load so a 204/error
	// just leaves the gradient (no broken-image flash).
	let posterOk = $state(false);
	const posterUrl = $derived(
		posters ? `/api/poster/${encodeURIComponent(item.name)}?v=${item.mtime}` : undefined
	);

	let scrubbing = $state(false);
	let seekEl = $state<HTMLElement>();
	const progress = $derived(duration > 0 ? Math.min(100, (currentTime / duration) * 100) : 0);

	// Spoken position for the seek slider (a11y, #4): a time readout ("0:34 of 1:20") so a
	// screen reader announces something meaningful instead of the bare percent aria-valuenow.
	function fmtTime(s: number): string {
		if (!Number.isFinite(s) || s < 0) s = 0;
		const m = Math.floor(s / 60);
		const sec = Math.floor(s % 60);
		return `${m}:${sec.toString().padStart(2, '0')}`;
	}
	const valueText = $derived(
		duration > 0 ? `${fmtTime(currentTime)} of ${fmtTime(duration)}` : 'Video position'
	);

	// Report the slot element to Feed via a Svelte action (fires on mount with the node,
	// and on destroy with null) so Feed can park/reparent the pooled <video> into it.
	function slot(node: HTMLElement) {
		onslot(node);
		return {
			destroy() {
				onslot(null);
			}
		};
	}

	function seekToClientX(clientX: number) {
		const r = seekEl?.getBoundingClientRect();
		if (!r || !r.width || !duration) return;
		const frac = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
		onseek(frac);
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
		if (!duration) return;
		if (e.key === 'ArrowLeft') {
			e.stopPropagation();
			onseekby(-5);
		} else if (e.key === 'ArrowRight') {
			e.stopPropagation();
			onseekby(5);
		}
	}
</script>

<div class="media">
	<!-- Slot: Feed parks the pooled <video> here (absolutely positioned to fill .media).
	     The reveal cross-fade is driven by Feed toggling the element's own `revealed`
	     class in lockstep with the placeholder fade below (gated on `revealed`). -->
	<div class="slot" use:slot></div>

	<!-- Reveal cross-fade: the placeholder (gradient + poster + caption) stays mounted and
	     fades out over the same 0.25s the pooled <video> fades in, so the black .media bg
	     never shows through. Gated purely on `revealed`, so a card that never paints keeps
	     its poster rather than getting stuck. pointer-events:none so taps fall through to
	     the full-bleed .tap button beneath. -->
	<div class="placeholder" class:revealed>
		{#if posterUrl}
			<img
				class="poster"
				class:shown={posterOk}
				class:contain={fit === 'contain'}
				src={posterUrl}
				alt=""
				onload={() => (posterOk = true)}
				onerror={() => (posterOk = false)}
			/>
		{/if}
		<span class="caption">{item.name}</span>
	</div>

	<!-- On-card FAVORITE badge (0.9.0): a filled heart shown when this clip is starred, so a
	     liked clip reads as liked on the card itself — not just the active-only side rail (the
	     operator never saw that). Purely presentational: aria-hidden + pointer-events:none,
	     zero playback/cure contact (mirrors the tap-hint overlay). -->
	{#if showStarred && starred}
		<div class="fav-badge" aria-hidden="true">
			<Heart size={22} fill="currentColor" />
		</div>
	{/if}

	{#if showSpinner}
		<div class="spinner" aria-hidden="true"></div>
	{/if}

	<!-- Full-bleed tap target: tap = play/pause (a real <button> for a11y + keyboard).
	     The action rail sits above this via z-index. -->
	<button class="tap" aria-label="Play or pause" onclick={ontap}></button>

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
			aria-valuetext={valueText}
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

	/* The slot fills the cell; Feed parks the pooled <video> inside it. The pooled
	   element is styled globally (it's a foreign node Feed owns, not in this scope) —
	   see Feed.svelte's :global(.pool-video) rules. */
	.slot {
		position: absolute;
		inset: 0;
	}

	.placeholder {
		position: absolute;
		inset: 0;
		display: flex;
		align-items: flex-end;
		padding: 1.5rem;
		background: linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%);
		/* Decorative only — let taps fall through to the full-bleed .tap button even
		   while the placeholder is mounted-but-faded during the reveal cross-fade. */
		pointer-events: none;
		/* Matches the pooled video's reveal transition so the two cross-fade. */
		transition: opacity 0.25s ease;
	}

	/* Faded out once the parked video has painted, revealing it underneath. Kept mounted
	   (not {#if}-removed) so the fade actually runs instead of a hard cut. */
	.placeholder.revealed {
		opacity: 0;
	}

	/* Generated poster (0.5/M3): covers the gradient once it loads. Hidden until a
	   successful load (`.shown`), so a 204/error never flashes a broken image. */
	.poster {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		object-fit: cover;
		opacity: 0;
		transition: opacity 0.2s ease;
	}

	.poster.contain {
		object-fit: contain;
	}

	.poster.shown {
		opacity: 1;
	}

	.caption {
		font-size: 0.85rem;
		opacity: 0.55;
		word-break: break-word;
		position: relative;
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
		/* Kill the iOS double-tap-to-zoom on the tap target so the double-tap-to-favorite
		   gesture (0.8.0) lands as two taps, not a zoom (the viewport has no
		   user-scalable=no, and we don't want to disable pinch-zoom elsewhere). */
		touch-action: manipulation;
		/* The play/pause "flicker" (0.8.1): this button is full-bleed (inset:0), so iOS
		   Safari's default tap-highlight paints a translucent-black overlay over the WHOLE
		   card on every press — a ~7% whole-video dim that appears on touch-down and reverts
		   on release (a ~2-frame flash per tap; sustained while a finger is held). It rides
		   the active press, not the play/pause state, which is why it fires on every tap.
		   `transparent` removes the native highlight; purely presentational — no effect on
		   the tap handler, the gesture, or playback. (Capture-confirmed: the dim is uniform
		   across the whole video, not a scrim behind the ▶ affordance.) */
		-webkit-tap-highlight-color: transparent;
	}

	/* The .tap fills the cell, so the global :focus-visible ring (outward offset) would clip
	   at the viewport edge — inset it so the keyboard-focus indicator is actually visible. (#4) */
	.tap:focus-visible {
		outline-offset: -4px;
	}

	.fav-badge {
		position: absolute;
		top: calc(env(safe-area-inset-top) + 0.6rem);
		left: calc(env(safe-area-inset-left) + 0.6rem);
		z-index: 2;
		display: flex;
		color: #ff2d55; /* matches the rail's filled heart (ActionRail .heart-btn.starred) */
		pointer-events: none;
		filter: drop-shadow(0 1px 4px rgba(0, 0, 0, 0.55));
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

	/* Bottom seek bar: a tall transparent touch strip with a thin visible track, above the
	   full-bleed tap target so scrubbing doesn't toggle play. */
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
