<script lang="ts">
	// Swipeable photo-post gallery (image-galleries milestone, Contract A). Renders a gallery
	// FeedItem's ordered `media[]` frames as a horizontal carousel — the render branch for a
	// gallery card in Feed.svelte (the video path renders VideoCard instead). This component is
	// DELIBERATELY inert to the <video> pool: it owns no pooled element, registers no slot
	// (no `onslot`), and never touches the cure machine — so a gallery interleaved between
	// videos consumes no decoder and can't perturb `activePaused`/the pool blessing (AC-4).
	//
	// Vertical scroll must still page the feed (100dvh scroll-snap), so the swipe surface uses
	// `touch-action: manipulation` (like VideoCard's tap target): the browser keeps VERTICAL pan
	// (feed scroll) — there's no horizontal-scroll ancestor so our JS finger-drag owns horizontal —
	// AND double-tap-to-zoom is disabled (the pan-y version let iOS's zoom recognizer break
	// double-tap-spam + cancel mid-swipe, #1442). No feed-scroll hijack.
	import { pickFit, GALLERY_MAX_COVER_RATIO } from '$lib/fit';
	import type { FeedItem } from '$lib/types';
	import Music from '@lucide/svelte/icons/music';

	let {
		item,
		active,
		viewportAR,
		autoAdvance = false,
		muted = true,
		paused = false,
		ontap,
		onadvance
	}: {
		item: FeedItem;
		/** This card is the active (in-viewport) one — gates ±1 adjacent preload + auto-advance. */
		active: boolean;
		/** Viewport aspect ratio (w/h), reactive — drives per-frame object-fit on rotate/resize. */
		viewportAR: number;
		/** Feed's auto-advance mode — when on, an idle gallery advances the FEED after a dwell. */
		autoAdvance?: boolean;
		/** Feed mute pref (round-3). Only drives the soundtrack CHIP's audible/emphasis state — the
		 *  actual audio is the single blessed <audio> channel Feed owns; this component stays inert
		 *  to playback. `!muted` on an active gallery ⟺ audible (muted only ever clears via bless). */
		muted?: boolean;
		/** This active gallery's soundtrack is user-PAUSED (round-3 fast-follow). Presentational only
		 *  (dims the ♪ chip) — the actual pause is Feed's galleryPaused → assertGalleryAudio. */
		paused?: boolean;
		/** A genuine tap (not a swipe) on the gallery — Feed routes it to onTapGesture so double-
		 *  tap-to-like + the heart burst work identically to a video (the app's signature gesture).
		 *  Every video-specific op in that handler no-ops on a gallery (activeVideo() is null). */
		ontap?: (e?: MouseEvent) => void;
		/** Advance the FEED to the next item (auto-advance dwell fired) — Feed scrolls on. */
		onadvance?: () => void;
	} = $props();

	const frames = $derived(item.media ?? []);
	// This gallery carries a soundtrack (round-3) → show the ♪ chip so the feature is DISCOVERABLE
	// (a photo post doesn't read as "has sound" like a video does) and the silent-until-first-tap
	// ceiling reads as "not yet unmuted" rather than "broken" (ui/ux audit S1/S2). Presentational
	// only — the audio itself is Feed's blessed <audio> channel; this component never plays anything.
	const hasAudio = $derived(!!item.audio);
	let index = $state(0);

	// Auto-advance (opt-in): a gallery has no <video> 'ended' to drive the feed, so without this
	// the feed DEAD-ENDS on the first photo post when AUTO_ADVANCE is on. An idle dwell advances
	// the feed; it RESTARTS on every frame change (`index`), so an actively-swiping user is never
	// yanked away — the feed only moves on after DWELL of no interaction. Active-only; cleared on
	// deactivate by the effect's own teardown. (Dwell is generous + device-tunable.)
	const AUTO_ADVANCE_DWELL_MS = 8000;
	$effect(() => {
		if (!active || !autoAdvance || frames.length === 0) return;
		void index; // restart the dwell whenever the frame changes (manual swipe or reset)
		const t = setTimeout(() => onadvance?.(), AUTO_ADVANCE_DWELL_MS);
		return () => clearTimeout(t);
	});

	// Restart at the first frame when the card scrolls away, so returning to it opens on the
	// cover (mirrors the video path's t=0 fresh-arrival restart) — and clear any in-flight drag
	// state so a card that scrolls away mid-swipe doesn't return mid-drag. Only writes local
	// state; reads only `active` → no self-loop.
	$effect(() => {
		// Reset to the cover + clear stale gesture state when the card GENUINELY leaves — but NOT
		// while a drag is in flight (`dragging`), so a transient IntersectionObserver active-flip (a
		// micro vertical wobble during a horizontal swipe) can't abort the drag mid-gesture
		// (#1442.1). On a real scroll-away the finger lifts → settleDrag clears `dragging` → this
		// then resets on the next run.
		if (!active && !dragging) {
			index = 0;
			dragPx = 0;
			axis = 'none';
			tapCandidate = false;
			wheelPx = 0;
			wheeling = false;
			wheelPeakVx = 0;
		}
	});

	// Bind the trackpad wheel listener NON-passively (round-3 fast-follow) so `preventDefault()` can
	// suppress the browser's horizontal two-finger history-swipe — Svelte's `onwheel` attribute is
	// registered passive for wheel, where preventDefault is a no-op. Cleaned up with the element.
	$effect(() => {
		const el = carouselEl;
		if (!el) return;
		el.addEventListener('wheel', onWheel, { passive: false });
		return () => {
			el.removeEventListener('wheel', onWheel);
			clearTimeout(wheelTimer);
		};
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
		// Round-3 crop fix (#1526): photos use the tighter GALLERY threshold so wide/square frames
		// letterbox (show whole) instead of cover-cropping ~40% off. Videos keep the 1.8 default.
		return nd && pickFit(nd.w, nd.h, viewportAR, GALLERY_MAX_COVER_RATIO) === 'contain'
			? 'contain'
			: '';
	}

	// Interactive finger-follow drag (TikTok-style): the track tracks the finger in REAL TIME the
	// instant a horizontal swipe begins (not threshold-then-snap), rubber-bands at the ends, and
	// snaps on release by distance OR flick velocity. Pointer events work mouse + touch; the browser
	// keeps VERTICAL panning (feed scroll) — we claim a gesture as horizontal only once it's clearly
	// h-dominant (small deadzone to disambiguate from a scroll), and only THEN capture the pointer,
	// so a vertical drag is never stolen from the feed.
	let carouselEl = $state<HTMLElement>();
	let dragging = $state(false); // drives .dragging (transition off while the finger is down)
	let dragPx = $state(0); // live horizontal offset added to the track transform
	let axis: 'none' | 'h' | 'v' = 'none';
	let tapCandidate = false; // pointerdown that hasn't moved enough to be a swipe → a tap (like)
	let startX = 0;
	let startY = 0;
	let lastX = 0;
	let lastT = 0;
	let vx = 0; // instantaneous px/ms, for flick detection

	// Gesture tunables (device-tunable per the UI/UX audit): flick lowered to 0.3 px/ms so a quick
	// short swipe advances (0.4 read sticky on iOS); the axis lock needs a clear horizontal bias
	// (|dx| > |dy|*1.3 past 8px) so a borderline-diagonal drag falls through to the feed's vertical
	// scroll instead of being stolen by the carousel.
	const FLICK_PX_PER_MS = 0.3;
	const H_BIAS = 1.3;

	// Trackpad two-finger horizontal swipe (round-3 fast-follow, #1549; RED-fix #1578). Desktop/laptop
	// trackpads fire `wheel` events (deltaX), NOT touch — the pointer finger-drag above never sees
	// them. CONTINUOUS live-track + snap-on-quiet (NOT a step-lock): the wheel offset moves the track
	// in REAL TIME (like the finger-drag), CLAMPED to ±one image width so a flick's momentum tail
	// (which keeps firing wheel events for ~0.5-1s after the fingers lift) can only ever move ONE
	// image; a wheel-idle gap SNAPS by distance and resets. No lock ⇒ no stuck state (the old
	// step-lock's quiet-timer was starved by the momentum tail → the unlock never fired → back-to-back
	// swipes were dropped until a click, #1578); continuous ⇒ smooth (TikTok-like), not stepped/janky.
	// WHEEL_SNAP_FRAC + the quiet-gap are device-tunable; the deltaX SIGN (scroll-dir → next/prev) is
	// device-confirmable (one-line flip if reversed on the operator's trackpad scroll setting).
	// Device-tunable (the trackpad's physical momentum profile can't be fully predicted from source):
	const WHEEL_SNAP_FRAC = 0.22; // commit to the next image once |wheelPx| passes this × width
	const WHEEL_FLICK_VEL = 0.55; // OR a decisive flick: peak |wheel velocity| (px/ms) → commit +1
	const WHEEL_QUIET_MS = 160; // wheel-idle gap that ends the gesture — long enough to span a
	// momentum-tail LULL so settleWheel doesn't fire early on a partial offset (#1591 no-advance/overshoot).
	let wheelPx = $state(0); // live horizontal wheel offset added to the track transform
	let wheeling = $state(false); // drives .wheeling (transition off while the wheel gesture tracks)
	let wheelPeakVx = 0; // signed PEAK velocity of the gesture, for the flick-commit (reset on settle)
	let wheelLastT = 0; // ts of the last wheel event, for the velocity delta
	let wheelTimer: ReturnType<typeof setTimeout> | undefined;

	function onWheel(e: WheelEvent) {
		if (frames.length < 2) return;
		// A finger-drag already owns the gesture — don't let a concurrent wheel (hybrid touchscreen
		// laptop / a trackpad flick landing mid-drag) fight the live `dragPx` (code audit S1).
		if (dragging) return;
		// Only claim a CLEARLY-horizontal wheel; a vertical/diagonal one pages the feed (deltaY).
		if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return;
		// Claim horizontal: suppress the browser's two-finger history back/forward swipe.
		e.preventDefault();
		wheeling = true;
		// Instantaneous velocity in wheelPx's direction (px/ms); track the PEAK over the gesture so a
		// decisive-but-short flick commits on intent even when net distance is small. Guard a stale/
		// cross-gesture dt (first event after idle) so it contributes ~0, not a spike.
		const dt = e.timeStamp - wheelLastT;
		wheelLastT = e.timeStamp;
		const vx = dt > 0 && dt < 200 ? -e.deltaX / dt : 0;
		if (Math.abs(vx) > Math.abs(wheelPeakVx)) wheelPeakVx = vx;
		// Follow the wheel live, CLAMPED to ±one image width so a long momentum tail can only ever move
		// one image (the whole flick+momentum resolves to a single snap — never a runaway multi-step).
		// Sign: a natural-scroll swipe toward the next image gives deltaX>0 → track moves left (−).
		const w = width();
		wheelPx = Math.max(-w, Math.min(w, wheelPx - e.deltaX));
		// The momentum tail keeps firing, so the gesture "ends" only after a genuine quiet gap — re-arm
		// the idle timer on every event; when it finally fires (a real lull), snap.
		clearTimeout(wheelTimer);
		wheelTimer = setTimeout(settleWheel, WHEEL_QUIET_MS);
	}
	// A wheel gesture went idle (incl. its momentum tail) → commit to the next/prev image on distance
	// OR a decisive flick, else settle back. Mirrors settleDrag's `far || flick` for the pointer path;
	// re-enables the transition so the snap animates. NO lock to get stuck (the #1578 fix). After a
	// commit both accumulators reset, so a decayed tail-after-commit stays below both thresholds → no
	// re-commit/overshoot (#1591).
	function settleWheel() {
		wheeling = false;
		const moved = wheelPx;
		const peakVx = wheelPeakVx;
		wheelPx = 0;
		wheelPeakVx = 0;
		const far = Math.abs(moved) > width() * WHEEL_SNAP_FRAC;
		const flick =
			Math.abs(peakVx) > WHEEL_FLICK_VEL && moved !== 0 && Math.sign(peakVx) === Math.sign(moved);
		if (far || flick) go(index + (moved < 0 ? 1 : -1));
	}

	function width(): number {
		return carouselEl?.clientWidth || (typeof window !== 'undefined' ? window.innerWidth : 1);
	}

	function onPointerDown(e: PointerEvent) {
		// Always a tap candidate (even a 1-frame gallery, so double-tap-to-like works there too);
		// the DRAG path below only arms for a multi-frame gallery.
		startX = e.clientX;
		startY = e.clientY;
		lastX = e.clientX;
		lastT = e.timeStamp;
		vx = 0;
		axis = 'none';
		dragging = false;
		dragPx = 0;
		tapCandidate = true;
	}
	function onPointerMove(e: PointerEvent) {
		if (!tapCandidate && !dragging) return;
		const dx = e.clientX - startX;
		const dy = e.clientY - startY;
		// Any real movement cancels the tap (a tap is press-release with ~no travel).
		if (Math.abs(dx) > 10 || Math.abs(dy) > 10) tapCandidate = false;
		if (frames.length < 2) return; // 1-frame gallery: nothing to swipe (tap still handled on up)
		if (axis === 'none') {
			// Claim the gesture only when it's CLEARLY horizontal (h-bias past an 8px deadzone) —
			// then capture the pointer so the drag survives the finger leaving the element. A
			// vertical or borderline-diagonal drag bows out → the feed's native scroll-snap takes it.
			if (Math.abs(dx) > 8 && Math.abs(dx) > Math.abs(dy) * H_BIAS) {
				axis = 'h';
				dragging = true;
				(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
			} else if (Math.abs(dy) > 6) {
				axis = 'v';
				dragPx = 0;
				return;
			} else {
				return;
			}
		}
		if (axis !== 'h') return;
		const dt = e.timeStamp - lastT;
		if (dt > 0) vx = (e.clientX - lastX) / dt;
		lastX = e.clientX;
		lastT = e.timeStamp;
		// Rubber-band: dragging before the first frame or past the last resists (0.35×) so the
		// gallery feels bounded without a hard wall.
		const atEdge = (index === 0 && dx > 0) || (index === frames.length - 1 && dx < 0);
		dragPx = atEdge ? dx * 0.35 : dx;
	}
	// Settle an in-flight drag (shared by pointerup + pointercancel): COMMIT the swipe if it moved
	// far enough / fast enough, else settle back to the current frame. Committing on CANCEL (not
	// hard-reverting) is the #1442.1 robustness fix — a spurious iOS cancel mid-h-drag (zoom
	// recognizer, a scroll-steal race) shouldn't yank a real swipe back to where it started.
	function settleDrag() {
		if (!dragging) {
			axis = 'none';
			dragPx = 0;
			return;
		}
		dragging = false; // re-enables the transition so the snap animates
		const moved = dragPx;
		axis = 'none';
		// Snap: past ~22% of the width, OR a fast flick in the drag's own direction.
		const far = Math.abs(moved) > width() * 0.22;
		const flick = Math.abs(vx) > FLICK_PX_PER_MS && Math.sign(vx) === Math.sign(moved);
		dragPx = 0; // → the transform animates from the dragged offset to the snapped index
		if ((far || flick) && moved !== 0) go(index + (moved < 0 ? 1 : -1));
	}
	function onPointerUp(e: PointerEvent) {
		const wasTap = tapCandidate && axis !== 'h';
		tapCandidate = false;
		settleDrag();
		// A genuine tap → route to Feed's onTapGesture (double-tap-to-like + heart burst). The
		// PointerEvent is a MouseEvent, so the heart lands at the tap point.
		if (wasTap) ontap?.(e);
	}
	function onPointerCancel() {
		tapCandidate = false;
		settleDrag();
	}
</script>

<div class="media">
	<!-- Carousel = a labeled group (APG pattern); real prev/next <button>s below carry the
	     accessible click + keyboard nav. The swipe surface owns horizontal finger-follow DRAGS via
	     POINTER events only (no keyboard handler here → no a11y-rule trip); touch-action:manipulation
	     leaves vertical to the feed's scroll-snap (+ kills double-tap-zoom). The drag + tap are a
	     touch/mouse enhancement over the SAME go()/ontap the buttons+rail drive. -->
	<div
		class="carousel"
		bind:this={carouselEl}
		role="group"
		aria-roledescription="carousel"
		aria-label={`Photo gallery, ${frames.length} ${frames.length === 1 ? 'image' : 'images'}`}
		onpointerdown={onPointerDown}
		onpointermove={onPointerMove}
		onpointerup={onPointerUp}
		onpointercancel={onPointerCancel}
	>
		<div
			class="track"
			class:dragging
			class:wheeling
			style:transform={`translateX(calc(${-index * 100}% + ${dragPx + wheelPx}px))`}
		>
			{#each frames as frame, i (frame.name)}
				<div class="frame">
					{#if shouldLoad(i)}
						<img
							class={fitClass(i)}
							src={frame.url}
							alt={`Photo ${i + 1} of ${frames.length}`}
							draggable="false"
							onload={(e) => onImgLoad(i, e)}
						/>
					{/if}
				</div>
			{/each}
		</div>
	</div>

	{#if hasAudio}
		<!-- Soundtrack indicator (round-3): signals this photo post HAS music (invisible otherwise —
		     a carousel doesn't read as "has sound"). Dim = has a soundtrack; bright = currently
		     audible (active card + sound on). Decorative + pointer-events:none — the rail mute button
		     is the control; bottom-left keeps it clear of the counter (top-right), dots (bottom-
		     center), rail (right) and the /liked back-chip (top-left). -->
		<div class="audio-chip" class:on={active && !muted && !paused} aria-hidden="true">
			<Music size={14} aria-hidden="true" />
		</div>
	{/if}

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
		/* `manipulation` (NOT pan-y) — the same value VideoCard's tap target uses. It permits the
		   feed's VERTICAL pan (there's no horizontal-scroll ancestor, so our JS finger-drag still
		   owns horizontal) AND — the fix — DISABLES iOS double-tap-to-zoom. Under pan-y the zoom
		   recognizer intercepted rapid taps: it broke double-tap-SPAM after the first like (#1442.2)
		   and could pointercancel an in-progress swipe, snapping it back mid-drag (#1442.1). */
		touch-action: manipulation;
	}

	.track {
		display: flex;
		width: 100%;
		height: 100%;
		/* The snap animation. Under prefers-reduced-motion the global app.css blanket zeroes every
		   transition-duration (!important), so the snap becomes an instant jump there — honored,
		   just via the global rule, not locally. The finger-follow drag is a live transform (not a
		   transition), so direct manipulation always tracks 1:1 regardless. */
		transition: transform 0.3s ease;
		will-change: transform;
	}

	/* While the finger is down (.dragging) OR a trackpad wheel gesture is live (.wheeling) the track
	   follows in real time — kill the transition so it tracks 1:1; on release the class drops and the
	   snap animates over the restored 0.3s. */
	.track.dragging,
	.track.wheeling {
		transition: none;
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
		align-items: center;
		justify-content: center;
		gap: 0.35rem;
		pointer-events: none;
		/* Row-level shadow so the dots stay legible over a bright/busy cover frame (UX audit). */
		filter: drop-shadow(0 1px 2px rgba(0, 0, 0, 0.55));
	}

	.dot {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: rgba(255, 255, 255, 0.45);
		transition:
			background 0.2s ease,
			transform 0.2s ease;
	}

	/* Active dot: brighter AND scaled up (transform, so no layout shift) for clear emphasis
	   beyond opacity alone. */
	.dot.on {
		background: rgba(255, 255, 255, 0.98);
		transform: scale(1.35);
	}

	/* Soundtrack chip (round-3): a small frosted ♪ pill, bottom-left. Dim by default ("this post
	   has music"); .on (active + sound on) brightens it to full ("playing now"). Matches the
	   counter/back-chip chrome. */
	.audio-chip {
		position: absolute;
		left: calc(env(safe-area-inset-left) + 0.75rem);
		bottom: calc(env(safe-area-inset-bottom) + 0.75rem);
		z-index: 3;
		display: flex;
		align-items: center;
		justify-content: center;
		width: 1.9rem;
		height: 1.9rem;
		color: #fff;
		background: rgba(0, 0, 0, 0.45);
		border-radius: 999px;
		backdrop-filter: blur(8px);
		pointer-events: none;
		opacity: 0.5;
		transition: opacity 0.2s ease;
	}

	.audio-chip.on {
		opacity: 1;
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
