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
	import { feedWindow } from '$lib/window';

	let {
		items,
		feedName,
		settings,
		total,
		seed
	}: {
		/** First page of the randomized feed (SSR'd); the rest is lazy-loaded. */
		items: FeedItem[];
		feedName: string;
		settings: FeedSettings;
		/** Total items in the shuffled feed, for the lazy-load stop condition. */
		total: number;
		/** Per-request shuffle seed — threaded to /api/feed so each lazily-fetched
		 *  page continues the SAME order (deterministic seededShuffle). */
		seed: number;
	} = $props();

	// 0.3.1 lazy-load: `items` is only the first page (slim SSR — we no longer
	// inline the whole multi-MB manifest). `extra` accumulates lazily-fetched
	// pages; `allItems` is the full known list. Using a separate $state array
	// (rather than seeding $state from the `items` prop) keeps the first page
	// server-rendered with no SSR→client reorder and no props-in-state warning.
	let extra = $state<FeedItem[]>([]);
	const allItems = $derived([...items, ...extra]);
	let fetching = $state(false);
	const PAGE = 24;

	async function loadMore() {
		if (fetching || allItems.length >= total) return;
		fetching = true;
		try {
			const res = await fetch(
				`/api/feed?shuffle=1&seed=${seed}&offset=${allItems.length}&limit=${PAGE}`
			);
			if (res.ok) {
				const data: { items?: FeedItem[] } = await res.json();
				const have = new Set(allItems.map((i) => i.name));
				const fresh = (data.items ?? []).filter((i) => !have.has(i.name));
				if (fresh.length) extra = [...extra, ...fresh];
			}
		} catch {
			/* offline / transient — retried on the next near-tail scroll */
		} finally {
			fetching = false;
		}
	}

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
	const visible = $derived(applyHidden(allItems, hidden));
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
		const count = applyHidden(allItems, hidden).length;
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

	// The lazy-load/mount window for `index`, via the pure `feedWindow` (guarded
	// by tests/window.test.ts). `live` cards mount the heavy VideoCard (a real
	// `<video src>`); off-window cards render a cheap placeholder — capping live
	// decoders to the window regardless of feed size. Direction-biased and
	// active-always-live; see window.ts.
	function windowState(index: number) {
		return feedWindow(index, activeIndex, dir, settings);
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

	// Lazy-load the next page as the active card nears the loaded tail. Reads
	// activeIndex + visible.length so it re-evaluates on scroll and after each
	// append (catching up if still near the end). `loadMore` self-guards against
	// overlap and the total cap.
	$effect(() => {
		if (activeIndex >= visible.length - (settings.preloadAhead + 3)) {
			loadMore();
		}
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
			<!-- The .card cell ALWAYS renders (100dvh, data-index, IO-observed) so
			     scroll height + the single-IO windowing are intact; only the heavy
			     VideoCard inside it mounts for windowed cards — off-window cards get
			     a cheap placeholder, capping live <video>s to the window regardless
			     of feed size. active is always live (feedWindow guarantee), so the
			     active card always mounts the real player. -->
			<div class="card" data-index={i} bind:this={cardEls[i]}>
				{#if ws.live}
					<VideoCard
						{item}
						active={i === activeIndex}
						preload={ws.preload}
						{muted}
						{autoAdvance}
						{viewportAR}
						onfinished={() => scrollTo(activeIndex + 1)}
					/>
				{:else}
					<div class="card-rest">
						<span class="card-rest-caption">{item.name}</span>
					</div>
				{/if}
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

	/* Cheap stand-in for off-window cards (no <video>, no decoder). Mirrors the
	   VideoCard pre-load placeholder so scrolling past unmounted cards looks
	   identical to a not-yet-loaded one. */
	.card-rest {
		display: flex;
		align-items: flex-end;
		width: 100%;
		height: 100%;
		padding: 1.5rem;
		background: linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%);
	}

	.card-rest-caption {
		font-size: 0.85rem;
		opacity: 0.55;
		word-break: break-word;
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
