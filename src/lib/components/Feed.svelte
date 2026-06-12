<script lang="ts">
	// The vertical feed (SPEC §4). One IntersectionObserver (~0.6 threshold)
	// drives a single active index: the entering card plays, every other card
	// pauses — only one video plays at a time. Layout is 100dvh/100svh scroll-snap
	// (dynamic units only, never the static one) via app.css. Desktop fallback:
	// Up/Down + j/k move snap points, Space play/pause, m mute.
	import { onMount, untrack } from 'svelte';
	import { SvelteSet } from 'svelte/reactivity';
	import VideoCard from './VideoCard.svelte';
	import MuteToggle from './MuteToggle.svelte';
	import ActionRail from './ActionRail.svelte';
	import Undo2 from '@lucide/svelte/icons/undo-2';
	import type { FeedItem, FeedSettings } from '$lib/types';
	import { loadMute, saveMute } from '$lib/stores/prefs';
	import { loadSeen, saveSeen } from '$lib/stores/seen';
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

	// Hidden ("trashed") set — client-side only, reactive (SvelteSet) so the
	// `visible` derived recomputes on mutate. `visible` is what the feed actually
	// renders; activeIndex indexes into it. `lastHidden` drives the transient Undo
	// toast (hide is reversible, so we undo rather than confirm).
	const hidden = new SvelteSet<string>();
	let lastHidden = $state<string | null>(null);
	let undoTimer: ReturnType<typeof setTimeout> | undefined;
	const visible = $derived(applyHidden(items, hidden));
	const activeItem = $derived(visible[activeIndex]);

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
		muted = loadMute(feedName);
		for (const n of loadHidden(feedName)) hidden.add(n);

		const resume = loadSeen(feedName);
		if (resume && resume.index > 0 && resume.index < untrack(() => visible.length)) {
			activeIndex = resume.index;
			cardEls[resume.index]?.scrollIntoView();
		}

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
		saveSeen(feedName, {
			index: activeIndex,
			names: visible.slice(0, activeIndex + 1).map((i) => i.name)
		});
	});
</script>

<svelte:window onkeydown={onKeydown} />

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
				<VideoCard {item} active={i === activeIndex} live={ws.live} preload={ws.preload} {muted} />
			</div>
		{/each}
	</div>
	<MuteToggle {muted} ontoggle={toggleMute} />
	<ActionRail allowHide={settings.allowHide} onhide={() => hide(activeItem?.name)} />
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
</style>
