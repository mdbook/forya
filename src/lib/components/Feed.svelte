<script lang="ts">
	// The vertical feed (SPEC §4). One IntersectionObserver (~0.6 threshold)
	// drives a single active index: the entering card plays, every other card
	// pauses — only one video plays at a time. Layout is 100dvh/100svh scroll-snap
	// (dynamic units only, never the static one) via app.css. Desktop fallback:
	// Up/Down + j/k move snap points, Space play/pause, m mute.
	import { onMount } from 'svelte';
	import { SvelteSet } from 'svelte/reactivity';
	import VideoCard from './VideoCard.svelte';
	import ActionRail from './ActionRail.svelte';
	import Undo2 from '@lucide/svelte/icons/undo-2';
	import type { FeedItem, FeedSettings } from '$lib/types';
	import {
		loadMute,
		saveMute,
		loadInfo,
		saveInfo,
		loadAutoAdvance,
		saveAutoAdvance
	} from '$lib/stores/prefs';
	import { unlockPlayback } from '$lib/stores/playback.svelte';
	import { loadHidden, saveHidden, applyHidden } from '$lib/stores/hidden';

	let {
		items,
		feedName,
		settings
	}: { items: FeedItem[]; feedName: string; settings: FeedSettings } = $props();

	let activeIndex = $state(0);
	let dir = $state(1); // travel direction: +1 scrolling down, -1 scrolling up
	let muted = $state(true);
	let feedEl = $state<HTMLElement>();
	let cardEls = $state<HTMLElement[]>([]);
	let io: IntersectionObserver | undefined;
	// Viewport aspect (w/h), kept current so cards re-fit on rotate/resize. The
	// card fills the feed cell (full width × 100dvh), so window AR ≈ card AR.
	let viewportAR = $state(1);

	function readViewport() {
		if (typeof window !== 'undefined' && window.innerHeight > 0) {
			viewportAR = window.innerWidth / window.innerHeight;
		}
	}

	// Hidden ("trashed") set — client-side only, reactive (SvelteSet) so the
	// `visible` derived recomputes on mutate. `visible` is what the feed actually
	// renders; activeIndex indexes into it. `lastHidden` drives the transient Undo
	// toast (hide is reversible, so we undo rather than confirm).
	const hidden = new SvelteSet<string>();
	let lastHidden = $state<string | null>(null);
	let undoTimer: ReturnType<typeof setTimeout> | undefined;
	// Transient confirmation of the loop/next mode after a toggle (reuses the
	// undo-toast styling). Null when no toast is showing.
	let modeToast = $state<string | null>(null);
	let modeTimer: ReturnType<typeof setTimeout> | undefined;
	let infoOpen = $state(false);
	// Initial value is set from settings (or the stored pref) in onMount; the
	// literal here is just the pre-hydration placeholder (no video has ended yet).
	let autoAdvance = $state(false);
	const visible = $derived(applyHidden(items, hidden));
	const activeItem = $derived(visible[activeIndex]);

	function toggleAutoAdvance() {
		autoAdvance = !autoAdvance;
		modeToast = autoAdvance ? 'Autoplay next: on' : 'Loop: on';
		clearTimeout(modeTimer);
		modeTimer = setTimeout(() => (modeToast = null), 2000);
	}

	/** Share the active video via the iOS share sheet, or fall back to a direct
	 *  download when the Web Share API is unavailable (desktop). */
	function share(item: FeedItem | undefined) {
		if (!item) return;
		const url = new URL(item.url, location.origin).href;
		if (navigator.share) {
			navigator.share({ title: item.name, url }).catch(() => {});
			return;
		}
		const a = document.createElement('a');
		a.href = url;
		a.download = item.name;
		a.click();
	}

	function toggleInfo() {
		infoOpen = !infoOpen;
	}

	function formatBytes(n: number): string {
		if (n < 1024) return `${n} B`;
		const units = ['KB', 'MB', 'GB'];
		let v = n / 1024;
		let i = 0;
		while (v >= 1024 && i < units.length - 1) {
			v /= 1024;
			i++;
		}
		return `${v.toFixed(1)} ${units[i]}`;
	}

	function hide(name: string | undefined) {
		if (!name) return;
		hidden.add(name);
		saveHidden(feedName, hidden);
		// If we hid the last card, clamp the active index back into range.
		const count = applyHidden(items, hidden).length;
		if (activeIndex >= count) activeIndex = Math.max(0, count - 1);
		lastHidden = name;
		clearTimeout(undoTimer);
		undoTimer = setTimeout(() => (lastHidden = null), 5000);
	}

	function undoHide() {
		if (!lastHidden) return;
		hidden.delete(lastHidden);
		saveHidden(feedName, hidden);
		lastHidden = null;
		clearTimeout(undoTimer);
	}

	/**
	 * Reactive lazy-load window that follows the active card. Only indices inside
	 * `[active - behind, active + ahead]` carry a real `<video src>` (`live`),
	 * which caps how many decoders iOS holds at once; everything else is a
	 * srcless placeholder. The window is direction-biased: scrolling up swaps
	 * ahead/behind so sustained back-scroll starts loading the previously-
	 * uncached cards. The active card (d === 0) is ALWAYS live — so a j/k jump or
	 * fast scroll to any index force-loads + plays it (no srcless active card).
	 * Preload gradient: active + the immediate neighbour in the travel direction
	 * buffer aggressively (`auto`); the rest of the window gets `metadata`.
	 */
	function windowState(index: number): { live: boolean; preload: 'auto' | 'metadata' | 'none' } {
		const ahead = dir < 0 ? settings.preloadBehind : settings.preloadAhead;
		const behind = dir < 0 ? settings.preloadAhead : settings.preloadBehind;
		const d = index - activeIndex;
		if (d < -behind || d > ahead) return { live: false, preload: 'none' };
		const immediate = dir < 0 ? -1 : 1;
		return { live: true, preload: d === 0 || d === immediate ? 'auto' : 'metadata' };
	}

	function activeVideo(): HTMLVideoElement | null {
		return cardEls[activeIndex]?.querySelector('video') ?? null;
	}

	function scrollTo(index: number) {
		const i = Math.max(0, Math.min(visible.length - 1, index));
		cardEls[i]?.scrollIntoView({ behavior: 'smooth' });
	}

	function toggleMute() {
		muted = !muted;
		unlockPlayback(); // a tap is a real user gesture
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
		unlockPlayback(); // keyboard play is a gesture too
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
		readViewport();
		muted = loadMute(feedName);
		infoOpen = loadInfo(feedName);
		autoAdvance = loadAutoAdvance(feedName, settings.autoAdvance);
		for (const n of loadHidden(feedName)) hidden.add(n);

		// No resume-to-index: the feed order is randomized server-side per load
		// (0.3.0), so a saved index would point at a different clip each visit —
		// resume was removed rather than silently mislead. Always start at the top.

		// THE single IntersectionObserver — the only one in the app.
		io = new IntersectionObserver(
			(entries) => {
				for (const entry of entries) {
					if (entry.isIntersecting && entry.intersectionRatio >= 0.6) {
						const idx = Number((entry.target as HTMLElement).dataset.index);
						if (!Number.isNaN(idx) && idx !== activeIndex) {
							dir = idx > activeIndex ? 1 : -1;
							activeIndex = idx;
						}
					}
				}
			},
			{ root: feedEl, threshold: [0.6] }
		);

		for (const el of cardEls) if (el) io.observe(el);
		return () => io?.disconnect();
	});

	// (Re)observe current cards whenever the visible list changes — undo re-adds a
	// card node that must be observed. observe() is idempotent on already-tracked
	// elements; detached (hidden) ones simply never fire. Single IO preserved.
	$effect(() => {
		const list = visible; // dependency: re-run when the rendered list changes
		if (!io) return;
		for (let i = 0; i < list.length; i++) {
			const el = cardEls[i];
			if (el) io.observe(el);
		}
	});

	$effect(() => {
		saveMute(feedName, muted);
	});

	$effect(() => {
		saveInfo(feedName, infoOpen);
	});

	$effect(() => {
		saveAutoAdvance(feedName, autoAdvance);
	});
</script>

<svelte:window onkeydown={onKeydown} onresize={readViewport} onorientationchange={readViewport} />

{#if visible.length === 0}
	<div class="empty">
		<p>No videos yet.</p>
		<p class="hint">Drop .mp4 / .mov / .webm / .m4v files into the feed directory.</p>
	</div>
{:else}
	<div class="feed" bind:this={feedEl}>
		{#each visible as item, i (item.name)}
			{@const ws = windowState(i)}
			<div class="card" data-index={i} bind:this={cardEls[i]}>
				<VideoCard
					{item}
					active={i === activeIndex}
					live={ws.live}
					preload={ws.preload}
					{muted}
					{autoAdvance}
					{viewportAR}
					onfinished={() => scrollTo(activeIndex + 1)}
				/>
			</div>
		{/each}
	</div>
	<ActionRail
		{muted}
		{autoAdvance}
		allowHide={settings.allowHide}
		{infoOpen}
		onmute={toggleMute}
		onautoadvance={toggleAutoAdvance}
		onshare={() => share(activeItem)}
		oninfo={toggleInfo}
		onhide={() => hide(activeItem?.name)}
	/>
	{#if infoOpen && activeItem}
		<div class="info-overlay">
			<p class="info-name">{activeItem.name}</p>
			<p class="info-meta">{formatBytes(activeItem.size)} · {activeItem.type}</p>
		</div>
	{/if}
{/if}

{#if lastHidden}
	<div class="undo-toast" role="status">
		<span class="undo-label">Hidden</span>
		<button class="undo-btn" onclick={undoHide}>
			<Undo2 size={16} aria-hidden="true" />
			Undo
		</button>
	</div>
{/if}

{#if modeToast}
	<div class="mode-toast" role="status">{modeToast}</div>
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

	.info-overlay {
		position: fixed;
		left: calc(env(safe-area-inset-left) + 0.75rem);
		bottom: calc(env(safe-area-inset-bottom) + 2.5rem);
		z-index: 9;
		max-width: 70vw;
		padding: 0.5rem 0.75rem;
		background: rgba(0, 0, 0, 0.55);
		border-radius: 0.5rem;
		backdrop-filter: blur(8px);
		pointer-events: none;
	}

	.info-name {
		margin: 0;
		font-size: 0.85rem;
		font-weight: 600;
		word-break: break-word;
	}

	.info-meta {
		margin: 0.15rem 0 0;
		font-size: 0.75rem;
		opacity: 0.65;
	}

	.undo-toast {
		position: fixed;
		left: 50%;
		bottom: calc(env(safe-area-inset-bottom) + 1.25rem);
		z-index: 20;
		transform: translateX(-50%);
		display: flex;
		align-items: center;
		gap: 0.75rem;
		padding: 0.5rem 0.5rem 0.5rem 1rem;
		color: #fff;
		background: rgba(0, 0, 0, 0.7);
		border: 1px solid rgba(255, 255, 255, 0.15);
		border-radius: 999px;
		backdrop-filter: blur(8px);
		font-size: 0.9rem;
	}

	.undo-btn {
		display: flex;
		align-items: center;
		gap: 0.3rem;
		padding: 0.35rem 0.85rem;
		color: #fff;
		font: inherit;
		font-weight: 600;
		background: rgba(255, 255, 255, 0.15);
		border: 0;
		border-radius: 999px;
		cursor: pointer;
	}

	.undo-btn:active {
		transform: scale(0.95);
	}

	.mode-toast {
		position: fixed;
		left: 50%;
		bottom: calc(env(safe-area-inset-bottom) + 4.75rem);
		z-index: 20;
		transform: translateX(-50%);
		padding: 0.5rem 1rem;
		color: #fff;
		white-space: nowrap;
		background: rgba(0, 0, 0, 0.7);
		border: 1px solid rgba(255, 255, 255, 0.15);
		border-radius: 999px;
		backdrop-filter: blur(8px);
		font-size: 0.9rem;
	}
</style>
