<script module lang="ts">
	// A long-press that navigates to /liked leaves the pointer DOWN; the trailing pointerup/click
	// then lands on the NEXT view's rail heart (same screen spot) and would toggle (UNSTAR) it —
	// a per-instance flag doesn't survive the route change. This MODULE-LEVEL one-shot flag, set
	// when the long-press fires and checked in the heart click, survives the navigation + the fresh
	// component instance and swallows exactly that one spurious click. Cleared by any fresh
	// deliberate press (heartDown), so it can't strand a later real tap. (#1344)
	let suppressNextHeartTap = false;
</script>

<script lang="ts">
	// The single control surface (SPEC §4): a fixed right-side rail (TikTok-style)
	// acting on the ACTIVE card. One instance, not per-card — Feed wires the
	// handlers to the active item and owns the audio-unlock logic. Consolidates
	// every control that used to be scattered across the corners (mute was
	// top-right, loop/next top-left, share/info bottom): mute · loop/next · share
	// · info · hide. Sits safe-area-inset, clear of the full-bleed tap-to-play and
	// the SPEC-reserved double-tap-to-like gesture.
	//
	// Icons are per-icon lucide imports so the bundler tree-shakes them (the rest
	// of the set never ships) and they compile to inline SVG — the PWA stays
	// offline-safe (no runtime icon CDN).
	import Volume2 from '@lucide/svelte/icons/volume-2';
	import VolumeX from '@lucide/svelte/icons/volume-x';
	import Heart from '@lucide/svelte/icons/heart';
	import SkipForward from '@lucide/svelte/icons/skip-forward';
	import Share from '@lucide/svelte/icons/share';
	import Info from '@lucide/svelte/icons/info';
	import Trash2 from '@lucide/svelte/icons/trash-2';

	let {
		muted,
		volume,
		showVolume,
		autoAdvance,
		allowHide,
		infoOpen,
		showStarred,
		starred,
		onmute,
		onvolume,
		onautoadvance,
		onstar,
		onopenliked,
		onshare,
		oninfo,
		onhide
	}: {
		muted: boolean;
		/** Playback level, 0..1. Independent of `muted` — this scales the audio, the mute
		 *  button gates it (and is the iOS bless entry point). */
		volume: number;
		/** Render the volume slider at all. False where the platform ignores
		 *  `HTMLMediaElement.volume` (iOS/iPadOS), because a control that cannot move the
		 *  audio is worse than no control — Feed probes for this, see $lib/volume. */
		showVolume: boolean;
		/** Advance-to-next ("Next") vs loop-this-clip ("Loop"). */
		autoAdvance: boolean;
		allowHide: boolean;
		infoOpen: boolean;
		/** Show the favorite (heart) control — the `starred` feature is on (DATA_DIR set). */
		showStarred: boolean;
		/** Whether the active card is favorited (filled heart). */
		starred: boolean;
		/** First tap also unlocks audio — Feed does the unlock inside the gesture. */
		onmute: () => void;
		/** New volume level, 0..1. Feed clamps, applies and persists it. */
		onvolume: (v: number) => void;
		onautoadvance: () => void;
		/** Toggle the active card's favorite mark (the a11y / instant path; double-tap is the
		 *  gesture equivalent). */
		onstar: () => void;
		/** LONG-PRESS the heart (~500ms) opens the favorites view. Optional — absent on the
		 *  favorites view itself (no self-entry there). A plain tap stays onstar. 0.9.0. */
		onopenliked?: () => void;
		onshare: () => void;
		oninfo: () => void;
		onhide: () => void;
	} = $props();

	// 0.9.0: LONG-PRESS the heart (~500ms) opens the favorites view; a plain tap toggles the star.
	// A pointer that lifts/cancels before the timer is a tap (timer cleared). When the long-press
	// fires we set the MODULE-LEVEL suppress flag (see the module script) so the trailing click —
	// which navigation re-targets onto the NEXT view's heart, a DIFFERENT instance — is swallowed
	// instead of unstarring the first favorites clip (#1344). A fresh press clears any stale flag.
	const LONG_PRESS_MS = 500;
	let lpTimer: ReturnType<typeof setTimeout> | undefined;
	function heartDown() {
		suppressNextHeartTap = false; // a fresh, deliberate press is always a real interaction
		if (!onopenliked) return; // no entry target (e.g. on the favorites view itself)
		clearTimeout(lpTimer);
		lpTimer = setTimeout(() => {
			suppressNextHeartTap = true; // swallow the trailing click nav re-targets to the next heart
			onopenliked?.();
		}, LONG_PRESS_MS);
	}
	function heartCancel() {
		clearTimeout(lpTimer);
	}
	// A VERTICAL range is driven by ArrowUp/ArrowDown — and Feed's window-level keydown handler
	// claims exactly those two keys to scroll the feed, `preventDefault()` included, with no
	// focused-control guard (that guard exists only for Space). Left alone, the slider would be
	// keyboard-DEAD: arrows would scroll the feed past the card whose volume you were setting.
	// Stop those two from reaching the window, mirroring what the seek slider already does for
	// its own ArrowLeft/Right. Deliberately narrow — j/k/m still fall through, so the app's other
	// shortcuts keep working while the slider holds focus, and no other control's behaviour moves.
	function volumeKey(e: KeyboardEvent) {
		if (e.key === 'ArrowUp' || e.key === 'ArrowDown') e.stopPropagation();
	}

	function heartClick() {
		if (suppressNextHeartTap) {
			suppressNextHeartTap = false; // the long-press already opened the view — swallow this tap
			return;
		}
		onstar();
	}
</script>

<div class="rail">
	<!-- Mute button + its HOVER-REVEAL volume slider (0.17). The group is the hover target, not
	     the button alone: the slider sits directly above the button, so hovering only the button
	     would hide the slider the instant the cursor moved onto it. Click behaviour is unchanged
	     — mute still toggles (and still mints the iOS bless); the slider only scales the level. -->
	<div class="volume-group">
		{#if showVolume}
			<!-- The NATIVE range input, so keyboard (arrows/home/end) and screen-reader semantics
			     come free — nothing here re-implements a slider. Revealed on hover OR focus-within,
			     so it is reachable by keyboard and not only by mouse; `pointer-events` follow the
			     reveal so the hidden slider can never swallow a click meant for the button. -->
			<input
				class="volume"
				type="range"
				min="0"
				max="1"
				step="0.01"
				value={volume}
				oninput={(e) => onvolume(e.currentTarget.valueAsNumber)}
				onkeydown={volumeKey}
				aria-label="Volume"
				aria-valuetext={`${Math.round(volume * 100)}%`}
			/>
		{/if}

		<button
			class="rail-btn"
			onclick={onmute}
			aria-label={muted ? 'Unmute' : 'Mute'}
			aria-pressed={!muted}
		>
			{#if muted}
				<VolumeX size={24} aria-hidden="true" />
			{:else}
				<Volume2 size={24} aria-hidden="true" />
			{/if}
		</button>
	</div>

	{#if showStarred}
		<!-- Favorite (heart): filled red when starred. The double-tap gesture is the primary
		     path; this button is the instant, unambiguous, a11y-friendly equivalent. -->
		<button
			class="rail-btn heart-btn"
			class:starred
			onclick={heartClick}
			onpointerdown={heartDown}
			onpointerup={heartCancel}
			onpointercancel={heartCancel}
			onpointerleave={heartCancel}
			aria-label={starred ? 'Remove from favorites' : 'Add to favorites'}
			aria-pressed={starred}
		>
			<Heart size={24} fill={starred ? 'currentColor' : 'none'} aria-hidden="true" />
		</button>
	{/if}

	<!-- Autoplay-next toggle: a single SKIP icon, always (no glyph-swap). State is conveyed by
	     the white `.on` styling when enabled + the toast on toggle — the text label and the
	     loop-glyph swap were redundant (operator, #482). -->
	<button
		class="rail-btn"
		class:on={autoAdvance}
		onclick={onautoadvance}
		aria-label={autoAdvance ? 'Autoplay next is on' : 'Autoplay next is off'}
		aria-pressed={autoAdvance}
	>
		<SkipForward size={24} aria-hidden="true" />
	</button>

	<button class="rail-btn" onclick={onshare} aria-label="Share or save this video">
		<Share size={24} aria-hidden="true" />
	</button>

	<button
		class="rail-btn"
		class:on={infoOpen}
		onclick={oninfo}
		aria-label="Toggle video info"
		aria-pressed={infoOpen}
	>
		<Info size={24} aria-hidden="true" />
	</button>

	{#if allowHide}
		<button class="rail-btn" onclick={onhide} aria-label="Hide this video from the feed">
			<Trash2 size={24} aria-hidden="true" />
		</button>
	{/if}
</div>

<style>
	.rail {
		position: fixed;
		right: calc(env(safe-area-inset-right) + 0.75rem);
		bottom: calc(env(safe-area-inset-bottom) + 4.5rem);
		z-index: 10;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 1rem;
	}

	.rail-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 2.75rem;
		height: 2.75rem;
		padding: 0;
		color: #fff;
		background: rgba(0, 0, 0, 0.4);
		border: 1px solid rgba(255, 255, 255, 0.15);
		border-radius: 50%;
		cursor: pointer;
		backdrop-filter: blur(8px);
	}

	/* The mute button's hover group. `position: relative` anchors the revealed slider directly
	   above the button; the slider is absolutely positioned so revealing it never reflows the
	   rail (a reserved gap would be a persistent control by another name). */
	.volume-group {
		position: relative;
		display: flex;
		align-items: center;
		justify-content: center;
	}

	/* Vertical native range. `writing-mode: vertical-lr` + `direction: rtl` is the standard way
	   to stand a range input up (it replaced the non-standard `-webkit-appearance:
	   slider-vertical`); rtl puts LOUD at the top, the direction every volume control moves.
	   `bottom: 100%` sits it flush against the button so the cursor never crosses a dead gap on
	   its way to the slider — a gap there would make the reveal flicker shut mid-approach. */
	.volume {
		position: absolute;
		bottom: 100%;
		left: 50%;
		transform: translateX(-50%);
		writing-mode: vertical-lr;
		direction: rtl;
		width: 2.75rem;
		height: 5.5rem;
		margin: 0 0 0.5rem;
		padding: 0.5rem 0;
		background: rgba(0, 0, 0, 0.55);
		border: 1px solid rgba(255, 255, 255, 0.15);
		border-radius: 999px;
		accent-color: #fff;
		cursor: pointer;
		backdrop-filter: blur(8px);
		/* Hidden at rest. `pointer-events: none` matters as much as the opacity: an invisible
		   but still hit-testable slider overlaps nothing today, but it would silently eat a
		   click the moment the rail's spacing changed. */
		opacity: 0;
		pointer-events: none;
		transition: opacity 0.15s ease;
	}

	/* HOVER-DEVICE ONLY. A hover-revealed control is unreachable by touch, and `volume` is
	   settable on Android (unlike iOS) — so without this gate a touch Android user would get a
	   slider they can see the space for but can never open. `hover: hover` is the honest test
	   for "this input can reveal on hover"; everywhere else the control simply does not exist,
	   same as on iOS. */
	@media (hover: hover) {
		/* Revealed by hovering the GROUP (button or slider), or by focus — so the slider is
		   reachable with the keyboard, not mouse-only. It stays opacity-0 rather than
		   display:none at rest specifically so it keeps its place in the tab order and CAN be
		   focused into view. */
		.volume-group:hover .volume,
		.volume-group:focus-within .volume {
			opacity: 1;
			pointer-events: auto;
		}
	}

	/* No hover (touch): never render it at all, rather than leave it permanently invisible but
	   focusable — a control nothing can open should not be in the tab order either. */
	@media (hover: none) {
		.volume {
			display: none;
		}
	}

	.volume:focus-visible {
		outline: none;
		box-shadow:
			0 0 0 2px #000,
			0 0 0 4px #fff;
	}

	.rail-btn.on {
		background: rgba(255, 255, 255, 0.85);
		color: #000;
	}

	/* The heart also LONG-PRESSES to open the favorites view (0.9.0) — suppress the iOS
	   long-press callout/selection so the hold reads as a gesture, not a text action. */
	.heart-btn {
		-webkit-touch-callout: none;
		user-select: none;
	}
	/* Favorited: a filled red heart (the icon's `fill` is set inline). Distinct from the
	   white `.on` toggle style so "favorited" reads as a heart, not a generic active button. */
	.heart-btn.starred {
		color: #ff2d55;
	}

	.rail-btn:active {
		transform: scale(0.92);
	}

	/* Rounded keyboard-focus ring (the global square :focus-visible outline reads wrong on a
	   50%-radius button); box-shadow follows the border-radius. Double ring stays visible on
	   any underlying frame. (#4) */
	.rail-btn:focus-visible {
		outline: none;
		box-shadow:
			0 0 0 2px #000,
			0 0 0 4px #fff;
	}
</style>
