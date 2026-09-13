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
	import { pickFit } from '$lib/fit';
	import { GIF_MIME, nextGalleryStep } from '$lib/gallery';
	import type { FeedItem } from '$lib/types';
	import Music from '@lucide/svelte/icons/music';

	let {
		item,
		active,
		viewportAR,
		maxCoverRatio,
		autoAdvance = false,
		muted = true,
		paused = false,
		ontap,
		onadvance,
		onframe
	}: {
		item: FeedItem;
		/** This card is the active (in-viewport) one — gates ±1 adjacent preload + auto-advance. */
		active: boolean;
		/** Viewport aspect ratio (w/h), reactive — drives per-frame object-fit on rotate/resize. */
		viewportAR: number;
		/** Cover/contain ratio threshold, derived by Feed from the operator's MAX_COVER_CROP dial.
		 *  Passed in rather than imported so every fit decision in the app uses ONE value. */
		maxCoverRatio: number;
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
		/** Report the currently-visible frame index up to Feed (save-to-photos, #122): the Save
		 *  action saves the frame the user is looking at, not always the cover. Only the ACTIVE
		 *  gallery reports. */
		onframe?: (index: number) => void;
	} = $props();

	const frames = $derived(item.media ?? []);
	// This gallery carries a soundtrack (round-3) → show the ♪ chip so the feature is DISCOVERABLE
	// (a photo post doesn't read as "has sound" like a video does) and the silent-until-first-tap
	// ceiling reads as "not yet unmuted" rather than "broken" (ui/ux audit S1/S2). Presentational
	// only — the audio itself is Feed's blessed <audio> channel; this component never plays anything.
	const hasAudio = $derived(!!item.audio);
	let index = $state(0);

	// Report the visible frame up to Feed so the Save action saves the frame in view (#122).
	// ACTIVE-ONLY: an off-active card resets `index` to 0 (below) — reporting that would clobber
	// the active gallery's tracked frame. Reads `index`+`active` → re-runs on every swipe/step.
	$effect(() => {
		if (active) onframe?.(index);
	});

	// Auto-cycle: the idle dwell steps through the gallery's own FRAMES and advances the FEED only
	// off the LAST frame — so feed-autoscroll can no longer leave a photo post having shown just
	// its cover (a gallery has no <video> 'ended' to drive the feed, so this dwell is the whole
	// mechanism). The policy lives in `nextGalleryStep` (pure, truth-tabled in tests/gallery.test.ts);
	// this effect is only the wiring. Reading `index` here makes the effect RESTART on every frame
	// change — manual swipe or auto-step alike — so an actively-swiping user is never yanked away
	// and each auto-step naturally re-arms the next. Active-only; the teardown clears any in-flight
	// timer on deactivate or on any input change.
	$effect(() => {
		const step = nextGalleryStep({
			active,
			autoAdvance,
			// ONE PAUSED CONCEPT PER POST: a paused post holds its images too, so tap = pause stops
			// the soundtrack, the GIF and this cycle together (mirrors the video tap = play/pause).
			// This is a real semantic change from round-3, where `paused` only muted audio and the
			// feed still advanced after the dwell.
			held: paused,
			index,
			frameCount: frames.length
		});
		if (step.kind === 'none') return;
		const t = setTimeout(
			() => (step.kind === 'feed' ? onadvance?.() : go(index + 1)),
			step.delayMs
		);
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

	// GIF FREEZE. Browsers expose NO pause API for an animated GIF in an <img> — no .pause(), no
	// animation-play-state — so "pause the GIF" has to be a picture of the GIF. We overlay a canvas
	// holding the frame that was on screen at the moment of pause.
	//
	// ponytail: the <img> keeps animating underneath the canvas, so FREEZE is exact but RESUME
	// jumps to the live position instead of continuing from the frozen frame. Invisible for the
	// actual use case (stop a loop so you can look at it); the only way to fix it is to own a GIF
	// decoder (gifuct + manual frame stepping), which is a dependency and a decoder to maintain in
	// exchange for a pause button. Upgrade path if it ever matters, not before.
	//
	// GEOMETRY (review #2199): the canvas carries the SAME CSS box and the SAME fit class as the
	// <img> and is sized to the image's NATURAL dimensions, so the browser applies an identical
	// object-fit to both and the freeze is geometrically a no-op. Drawing at ELEMENT size instead
	// would visibly jump/rescale at the moment of pause on exactly the crop-heavy posts that
	// motivated GALLERY_MAX_COVER_RATIO.
	const frozen = $derived(active && paused && frames[index]?.type === GIF_MIME);
	let frozenCanvas = $state<HTMLCanvasElement>();
	// Second snapshot for the LETTERBOXED case. The blurred bg-fill is a copy of the SAME live
	// frame, and the main frozen canvas is `contain`-boxed, so it covers only the letterboxed
	// middle — without this the surrounding blur KEEPS ANIMATING while the post is "paused"
	// (review #2262). Not an edge case: any frame whose cover-crop exceeds the cap letterboxes,
	// so at a tight cap this is the COMMON path for a GIF. Mounted only when contained.
	let frozenBgCanvas = $state<HTMLCanvasElement>();

	$effect(() => {
		if (!frozen) return;
		const c = frozenCanvas;
		// The <img> is this canvas's sibling inside `.frame` — read it off the DOM rather than
		// threading per-index element bindings through the {#each} for one transient snapshot.
		// `:not(.bg-fill)` selects the REAL frame: since da40225 the bg-fill copy is the FIRST
		// <img> in `.frame`, and a bare `querySelector('img')` would take it. That happens to be
		// harmless today (same src ⇒ same natural dims ⇒ same pixels) but only by luck — pin the
		// real one so a future change to the bg source can't silently corrupt the snapshot.
		// Explicit generic: TS infers HTMLImageElement from a bare tag selector, but the `:not()`
		// degrades it to Element, so the element type has to be stated.
		const img = c?.parentElement?.querySelector<HTMLImageElement>('img:not(.bg-fill)');
		// naturalWidth is 0 until decode. If we're early the canvas stays TRANSPARENT — the GIF
		// keeps animating underneath and the pause silently appears not to take. It does NOT
		// self-heal: the effect only re-runs when `index`/`paused` change, i.e. the user must
		// re-tap. Benign (an undrawn canvas is transparent, not a black box, and you have to be
		// looking at the GIF to tap it) so it stays unguarded rather than growing a decode-wait.
		// Same-origin (/api/media), so the canvas is never tainted.
		if (!c || !img || !img.naturalWidth) return;
		// Both snapshots come from the SAME <img> in the same run, so the frozen middle and the
		// frozen blur can never show different moments of the GIF.
		for (const target of [c, frozenBgCanvas]) {
			if (!target) continue;
			target.width = img.naturalWidth;
			target.height = img.naturalHeight;
			target.getContext('2d')?.drawImage(img, 0, 0);
		}
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
		// Crop cap (2026-07-28): one MAX_COVER_CROP (~10%) for photos AND video — a frame whose
		// cover-crop would exceed the cap letterboxes (whole frame shown) with a blurred bg-fill
		// behind it instead of losing a chunk. Supersedes the round-3 #1526 gallery-only 1.4 split.
		return nd && pickFit(nd.w, nd.h, viewportAR, maxCoverRatio) === 'contain' ? 'contain' : '';
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
						{#if fitClass(i) === 'contain'}
							<!-- Blurred background-fill behind a LETTERBOXED frame (TikTok/IG-reels look):
							     a scaled, heavily-blurred copy of the SAME image — served from cache (same
							     src as the real <img>), no extra network, no second decoder. Only mounted
							     for a contained frame (under cover it'd be fully occluded), so a filling
							     frame pays nothing. Decorative; the real <img> below carries the alt text. -->
							<img class="bg-fill" src={frame.url} alt="" aria-hidden="true" draggable="false" />
							{#if frozen && i === index}
								<!-- Frozen copy of the bg-fill. The one above is the LIVE frame, so on a paused
								     GIF it would keep animating around the frozen middle. Same `.bg-fill` class
								     (so it inherits the scale/blur/dim and z-index:0 — `.frame .bg-fill` outranks
								     `.frame canvas`) and placed immediately AFTER it, so DOM order paints it over
								     the live copy while both stay under the real <img>. -->
								<canvas class="bg-fill" bind:this={frozenBgCanvas} aria-hidden="true"></canvas>
							{/if}
						{/if}
						<img
							class={fitClass(i)}
							src={frame.url}
							alt={`Photo ${i + 1} of ${frames.length}`}
							draggable="false"
							onload={(e) => onImgLoad(i, e)}
						/>
						{#if frozen && i === index}
							<!-- Frozen GIF frame. Same fit class + same absolute box as the <img> above, sized
							     to natural dims in the effect, so the swap is geometrically invisible.
							     Decorative: the <img> underneath still carries the alt text. -->
							<canvas class={fitClass(i)} bind:this={frozenCanvas} aria-hidden="true"></canvas>
						{/if}
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

	/* The frozen-GIF canvas is styled IDENTICALLY to the <img> it covers (same box, same fit) —
	   that identity is what makes the freeze geometrically a no-op, so these selectors must stay
	   paired. `canvas` is a replaced element, so object-fit applies to it exactly as it does to
	   an image. z-index keeps it above the still-animating <img> underneath. */
	.frame img,
	.frame canvas {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		object-fit: cover;
		/* Match the pooled <video>: cover by default, contain for an off-aspect frame. */
		-webkit-user-select: none;
		user-select: none;
	}

	.frame img.contain,
	.frame canvas.contain {
		object-fit: contain;
	}

	/* Blurred bg-fill behind a letterboxed frame. Inherits the absolute/inset/cover box from
	   `.frame img` above; adds the scale (hide the blur's soft edges) + heavy blur + a slight
	   dim so the real contained image stays the focus. z-index:0 keeps it UNDER the real <img>
	   (auto) and the frozen-GIF canvas (z-index:1). Device-tunable (blur radius / dim). */
	.frame .bg-fill {
		z-index: 0;
		transform: scale(1.15);
		filter: blur(28px) brightness(0.6);
		pointer-events: none;
	}

	.frame canvas {
		z-index: 1;
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
