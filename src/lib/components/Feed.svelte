<script lang="ts">
	// The vertical feed (SPEC §4). One IntersectionObserver (~0.6 threshold) drives a
	// single active index. Layout is 100dvh/100svh scroll-snap (dynamic units only) via
	// app.css. Desktop fallback: Up/Down + j/k move snap points, Space play/pause, m mute.
	//
	// 0.6 — POOLED <video> elements. Instead of one `<video>` per card (minted fresh and
	// released on unmount), Feed owns a small fixed POOL of persistent `<video>` elements
	// (see src/lib/pool.ts) and reparents them onto the active card + its neighbours,
	// recycling via `src`-swap as the active index moves. This is what lets a gesture-
	// blessed element carry sound across cards AND across programmatic auto-advance (M2).
	// Blessing model (harness-proven on iOS 26.5.1, bus #422): iOS's "may-play-unmuted"
	// permission is PER-ELEMENT + durable — a continuously-playing element unmuted once in a
	// gesture (section A) carries sound across ≥6 src-swaps + a 20s idle; an off-gesture
	// muted→unmuted toggle on such a blessed element never re-pauses (section D). So the
	// sound-on tap blesses the whole pool (unmute+play each in-gesture, re-mute neighbours),
	// neighbours stay continuously playing muted, and becoming-active is just a D-safe
	// off-gesture unmute. The always-muted cure (0.5.5) is preserved: we NEVER issue an
	// unmuted play() off-gesture — play() is always muted, unmute happens only once the
	// element is confirmed playing. Decoder count is bounded by POOL_SIZE (< the old ~6).
	import { onMount, untrack } from 'svelte';
	import { SvelteSet } from 'svelte/reactivity';
	import VideoCard from './VideoCard.svelte';
	import ActionRail from './ActionRail.svelte';
	import Undo2 from '@lucide/svelte/icons/undo-2';
	import Copy from '@lucide/svelte/icons/copy';
	import type { FeedItem, FeedSettings } from '$lib/types';
	import {
		saveMute,
		loadInfo,
		saveInfo,
		loadAutoAdvance,
		saveAutoAdvance
	} from '$lib/stores/prefs';
	import { loadHidden, saveHidden, applyHidden } from '$lib/stores/hidden';
	import { pickFit } from '$lib/fit';
	import { isMediaReady, shouldRetryOnPlayable } from '$lib/playback';
	import { coverage, reassignPool } from '$lib/pool';

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
		/** Per-request shuffle seed — threaded to /api/feed so each lazily-fetched page
		 *  continues the SAME order (deterministic seededShuffle). */
		seed: number;
	} = $props();

	// 0.3.1 lazy-load: `items` is only the first page (slim SSR). `extra` accumulates
	// lazily-fetched pages; `allItems` is the full known list.
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
	let muted = $state(true);
	let feedEl = $state<HTMLElement>();
	let cardEls = $state<HTMLElement[]>([]);
	let io: IntersectionObserver | undefined;
	let viewportAR = $state(1);

	function readViewport() {
		if (typeof window !== 'undefined' && window.innerHeight > 0) {
			viewportAR = window.innerWidth / window.innerHeight;
		}
	}

	// Hidden ("trashed") set — client-side only, reactive so `visible` recomputes.
	const hidden = new SvelteSet<string>();
	let lastHidden = $state<string | null>(null);
	let undoTimer: ReturnType<typeof setTimeout> | undefined;
	let modeToast = $state<string | null>(null);
	let modeTimer: ReturnType<typeof setTimeout> | undefined;
	let copyToast = $state(false);
	let copyTimer: ReturnType<typeof setTimeout> | undefined;
	let infoOpen = $state(false);
	let autoAdvance = $state(false);
	const visible = $derived(applyHidden(allItems, hidden));
	const activeItem = $derived(visible[activeIndex]);

	// ── Pooled <video> machine (0.6) ──────────────────────────────────────────────
	// POOL_SIZE persistent elements, reparented onto the covered cards. Bump to 5 (±2) if
	// on-device multi-card flick/jumps show a rough stall; 3 (prev/cur/next) is the start
	// (a decoder WIN vs the old ~6 windowed mounts). `pool` is plain (non-reactive — we
	// never want Svelte reconciling these foreign nodes); their assignment + per-card
	// reveal state are the reactive surface the shells read.
	const POOL_SIZE = 3;
	let pool: HTMLVideoElement[] = [];
	// Set true the first time the user turns sound on (the bless gesture). Durable for the
	// session: every pool element is blessed once and the per-element grant survives src-swaps,
	// so no element is ever unblessed again. Plain (non-reactive) — read only imperatively.
	let blessed = false;
	let slotToCard: (number | null)[] = new Array(POOL_SIZE).fill(null); // pool slot → card idx
	// Shell slot divs keyed by the STABLE item name (not index): `use:` actions fire only
	// on mount/destroy, so a hide/undo or lazy-append that shifts indices must not strand a
	// kept card's slot under a stale index. The card node persists across reorders (keyed
	// each-block), so name→node is stable.
	let cardSlotByName = $state<Record<string, HTMLElement>>({});
	// Reactive surface for the shells: which card indices have a painted (revealed) video,
	// and the active card's live playback state (single source of truth — review #433).
	let cardRevealed = $state<Record<number, boolean>>({});
	let activeBuffering = $state(false);
	let activeBlocked = $state(false);
	let activePaused = $state(false);
	let activeCurrentTime = $state(0);
	let activeDuration = $state(0);
	// Monotonic token cancelling stale async play retries on the active element.
	let playGen = 0;

	function slotForCard(card: number): number {
		return slotToCard.indexOf(card);
	}
	function activeVideo(): HTMLVideoElement | null {
		const s = slotForCard(activeIndex);
		return s >= 0 ? pool[s] : null;
	}

	function applyFit(v: HTMLVideoElement, item: FeedItem) {
		const f = pickFit(item.width || 0, item.height || 0, viewportAR);
		v.classList.toggle('contain', f === 'contain');
	}

	// The always-muted cure (0.5.5), ported to act on the active pooled element. Muted
	// autoplay is gesture-free; a transient reject on a freshly-(re)src'd element retries
	// once on the next frame, then surfaces tap-to-play (`blocked`) without releasing —
	// canplay/loadeddata self-heal (`retryIfPlayable`) catches the not-yet-buffered case.
	// All callbacks gen-guarded so a scrolled-past attempt no-ops. The play() call is ALWAYS
	// muted (the cure — never an unmuted play() off-gesture); the sound-on unmute happens in
	// onActivePlaying() once the element is confirmed playing (D-safe on a blessed element).
	function tryPlayActive(v: HTMLVideoElement) {
		if (!v.isConnected) return; // not parked into a slot yet
		const gen = ++playGen;
		// Only force muted on a fresh/paused start (the cure). A neighbour that's already
		// playing muted (post-bless) is left as-is so play() is a no-op and onActivePlaying
		// just unmutes it — no mute→unmute blip on the becoming-active transition.
		if (v.paused) v.muted = true;
		const p = v.play();
		if (!p || typeof p.then !== 'function') return;
		p.then(() => {
			if (gen === playGen) onActivePlaying();
		}).catch((err: unknown) => {
			if (gen !== playGen) return;
			if (err instanceof DOMException && err.name === 'AbortError') return;
			requestAnimationFrame(() => {
				const cur = activeVideo();
				if (gen !== playGen || !cur) return;
				cur
					.play()
					.then(() => {
						if (gen === playGen) onActivePlaying();
					})
					.catch((err2: unknown) => {
						if (gen !== playGen) return;
						if (err2 instanceof DOMException && err2.name === 'AbortError') return;
						pushDebug(activeIndex, 'reject', err2 instanceof DOMException ? err2.name : 'err');
						activeBlocked = true;
						if (cur && isMediaReady(cur.readyState)) {
							setTimeout(() => {
								const c2 = activeVideo();
								if (gen !== playGen || !c2) return;
								c2.play()
									.then(() => {
										if (gen === playGen) onActivePlaying();
									})
									.catch(() => {
										/* leave blocked → tap-to-play; one delayed retry only */
									});
							}, 250);
						}
					});
			});
		});
	}

	// The active element is audible iff the pool is blessed AND sound is on (muted pref false);
	// everything else stays muted. Setting muted=false here is the D-safe off-gesture toggle on
	// a blessed element — only ever called once the element is confirmed playing (the audible-
	// output gate cares about playing state, not the play() call). Pre-bless this always mutes,
	// preserving the cure.
	function assertActiveAudio() {
		const v = activeVideo();
		if (v) v.muted = !(blessed && !muted);
	}
	// The active element is confirmed playing: clear the blocked/buffering UI and apply audio.
	function onActivePlaying() {
		activeBlocked = false;
		assertActiveAudio();
	}

	// Per-element listeners (bound once at creation; `slot` is the fixed pool index). They
	// only touch the reactive active-state when THIS slot is the active one, so a
	// neighbour's events can't clobber the active card's UI.
	function onPoolPlaying(slot: number) {
		const card = slotToCard[slot];
		if (card !== null) cardRevealed = { ...cardRevealed, [card]: true };
		pool[slot]?.classList.add('revealed');
		if (slot === slotForCard(activeIndex)) {
			activeBuffering = false;
			onActivePlaying();
		} else {
			// Neighbour started playing: re-assert muted (some iOS reset muted to the attribute
			// default on a src-swap; the attribute is unset, so the default is UNMUTED — guard it
			// here so a recycled neighbour can never bleed audio).
			pool[slot].muted = true;
		}
	}
	function onPoolError(slot: number) {
		if (slot === slotForCard(activeIndex)) {
			activeBuffering = false;
			activeBlocked = true;
			pushDebug(activeIndex, 'error', pool[slot]?.error ? `code${pool[slot]!.error!.code}` : 'err');
		}
	}

	// Assign pool slots to the coverage window, recycle (src-swap) freed slots, reparent
	// each onto its card's shell slot, then drive play/pause. Pure decision in pool.ts;
	// this applies it to the DOM. Called from the $effect on active-index / feed-length /
	// slot-registration changes.
	function syncPool() {
		if (!pool.length) return;
		const totalCards = visible.length;
		if (totalCards === 0) return;
		const targets = coverage(activeIndex, POOL_SIZE, totalCards);
		const next = reassignPool(slotToCard, targets, POOL_SIZE);
		for (let s = 0; s < POOL_SIZE; s++) {
			const v = pool[s];
			const card = next[s];
			const prevCard = slotToCard[s];
			if (card === null) {
				if (prevCard !== null) {
					v.pause();
					v.removeAttribute('src');
					v.load();
				}
				continue;
			}
			const item = visible[card];
			if (!item) continue;
			if (card !== prevCard) {
				// Recycle this element onto a new card: reset reveal, swap src. The element
				// stays blessed (per-element, durable) across this swap — that's the point.
				if (prevCard !== null && cardRevealed[prevCard]) {
					const rest = { ...cardRevealed };
					delete rest[prevCard];
					cardRevealed = rest;
				}
				v.classList.remove('revealed');
				v.loop = !autoAdvance;
				applyFit(v, item);
				v.src = item.url;
				// Re-assert muted AFTER the src-swap (some iOS reset muted to the attribute
				// default — unset = unmuted — on swap). muted=true is the safe default: on an
				// adjacent scroll the recycled slot is always the off-screen far neighbour; on a
				// jump it may be the new active card, in which case driveActive→onActivePlaying
				// unmutes it once playing. Either way the per-element blessing survives the swap
				// (harness A).
				v.muted = true;
			}
			// (Re)park into the card's shell slot (resolved by stable name).
			const slotDiv = cardSlotByName[item.name] ?? null;
			if (slotDiv && v.parentNode !== slotDiv) slotDiv.appendChild(v);
		}
		slotToCard = next;
		driveActive();
	}

	function driveActive() {
		const aSlot = slotForCard(activeIndex);
		for (let s = 0; s < pool.length; s++) {
			if (s === aSlot) continue;
			const v = pool[s];
			v.muted = true; // neighbours are always silent
			if (blessed && v.src) {
				// Post-bless: keep neighbours CONTINUOUSLY playing (muted) so that when one
				// becomes active it's an off-gesture unmute on an already-playing blessed element
				// (harness D), never a pause→play→unmute (untested). This is the TikTok recycler.
				if (v.paused) v.play().catch(() => {});
			} else {
				// Pre-bless (muted feed, M1 behaviour): only the active card plays (battery).
				v.pause();
			}
		}
		if (aSlot < 0) return;
		const v = pool[aSlot];
		activeDuration = v.duration || 0;
		activeCurrentTime = v.currentTime || 0;
		activeBuffering = false;
		tryPlayActive(v);
	}

	function registerSlot(name: string, el: HTMLElement | null) {
		const next = { ...cardSlotByName };
		if (el) next[name] = el;
		else delete next[name];
		cardSlotByName = next;
	}

	function toggleAutoAdvance() {
		autoAdvance = !autoAdvance;
		for (const v of pool) v.loop = !autoAdvance;
		modeToast = autoAdvance ? 'Autoplay next: on' : 'Loop: on';
		clearTimeout(modeTimer);
		modeTimer = setTimeout(() => (modeToast = null), 2000);
	}

	/** Share the active video via the iOS share sheet, or fall back to a direct download. */
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

	async function copyId(name: string | undefined) {
		if (!name || !navigator.clipboard) return;
		try {
			await navigator.clipboard.writeText(name);
			copyToast = true;
			clearTimeout(copyTimer);
			copyTimer = setTimeout(() => (copyToast = false), 1500);
		} catch {
			/* clipboard blocked — long-press-copy still works via user-select:text */
		}
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

	// Which cards mount the (cheap) shell — a generous radius so posters preload and every
	// covered (pool) card is always mounted (coverage ⊆ this). Off-window cards render a
	// bare placeholder, keeping poster requests bounded regardless of feed size.
	const MOUNT_RADIUS = 4;
	function isLive(index: number): boolean {
		return Math.abs(index - activeIndex) <= MOUNT_RADIUS;
	}

	// ── Gesture-unlock (0.5.3) — document-wide iOS autoplay recovery, now on the pooled
	// active element. On a real scroll-drag, re-attempt play() SYNCHRONOUSLY in the gesture so
	// iOS re-grants. Fires only on a moved touch (not a stationary tap — tapActive owns those).
	let touchStartY = 0;
	let touchMoved = false;

	function onTouchStart(e: TouchEvent) {
		touchStartY = e.touches[0]?.clientY ?? 0;
		touchMoved = false;
	}
	function onTouchMove(e: TouchEvent) {
		if (Math.abs((e.touches[0]?.clientY ?? touchStartY) - touchStartY) > 10) touchMoved = true;
	}
	function onTouchEnd() {
		if (!touchMoved) return;
		// In-gesture: if sound is on, re-assert the active element unmuted here — a real gesture
		// re-blesses it should a per-element grant ever lapse (belt-and-suspenders over the
		// durable per-element blessing). Then recover a blocked active card with an in-gesture
		// play() so iOS re-grants playback.
		if (blessed && !muted) {
			const v = activeVideo();
			if (v) v.muted = false;
		}
		if (activeBlocked) {
			activeVideo()
				?.play()
				.catch(() => {});
		}
	}

	function scrollTo(index: number) {
		const i = Math.max(0, Math.min(visible.length - 1, index));
		cardEls[i]?.scrollIntoView({ behavior: 'smooth' });
	}

	function tapActive() {
		const v = activeVideo();
		if (!v) return;
		if (v.paused) {
			activePaused = false;
			activeBlocked = false;
			tryPlayActive(v);
		} else {
			v.pause();
			activePaused = true;
		}
	}

	// Bless the whole pool in the current user gesture: unmute + play() each element (so each
	// is "playing + unmuted in a gesture" — harness A's precondition for a durable per-element
	// grant), then immediately re-mute the neighbours (harness D: false→true on a blessed,
	// playing element never re-pauses). MUST be called synchronously from a real gesture
	// (toggleMute's click / a touchend). Idempotent-safe but only the first call matters.
	function blessPool() {
		blessed = true;
		const aSlot = slotForCard(activeIndex);
		for (let s = 0; s < pool.length; s++) {
			const v = pool[s];
			if (!v.src) continue;
			// pause() FIRST so the play() below is a fresh, gesture-INITIATED start that iOS
			// authorizes for audible output. The active element has been playing via muted
			// autoplay (gesture-free), so a bare play() on it is a no-op that never authorizes
			// audible playback → iOS pauses it on the muted=false flip (the first-bless-pause
			// bug: only the initial unmute on the freshly-loaded card). Neighbours are already
			// paused pre-bless, so this pause is a no-op for them + their play() was already
			// fresh — which is exactly why every subsequent card carried fine and only the first
			// bless paused. Pausing then playing in the same synchronous gesture tick is seamless
			// (no visible hitch, currentTime preserved).
			v.pause();
			v.muted = false; // unmute IN-gesture — the bless (per-element, durable)
			const p = v.play();
			if (p && typeof p.then === 'function') p.catch(() => {});
			if (s !== aSlot) v.muted = true; // re-mute neighbours at once (no multi-audio blip)
		}
	}

	function toggleMute() {
		muted = !muted;
		if (!muted) {
			// Turning sound ON. The first time, this click is the bless gesture for the whole
			// pool; thereafter the elements stay blessed, so just unmute the active one (D-safe).
			if (!blessed) blessPool();
			else {
				const v = activeVideo();
				if (v) v.muted = false;
			}
		} else {
			// Muting: silence everything (active + the continuously-playing neighbours).
			for (const v of pool) v.muted = true;
		}
	}

	function seekActiveFrac(frac: number) {
		const v = activeVideo();
		if (v && activeDuration) v.currentTime = frac * activeDuration;
	}
	function seekActiveBy(delta: number) {
		const v = activeVideo();
		if (v && activeDuration) {
			v.currentTime = Math.min(activeDuration, Math.max(0, (v.currentTime || 0) + delta));
		}
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
				tapActive();
				break;
			case 'm':
				toggleMute();
				break;
		}
	}

	// ── DEBUG overlay (0.5.4) — inert unless DEBUG_PLAYBACK. Now also the pool watch: the
	// live `<video>` count MUST stay == POOL_SIZE across src-swaps (no decoder leak/ghost).
	let debugLog = $state<string[]>([]);
	let debugCounts = $state('');
	let debugTimer: ReturnType<typeof setInterval> | undefined;
	let debugSeq = 0;

	function pushDebug(idx: number, kind: string, detail?: string) {
		if (!settings.debugPlayback) return;
		debugSeq++;
		debugLog = [...debugLog.slice(-13), `${debugSeq} ${idx}:${kind}${detail ? `(${detail})` : ''}`];
	}
	function sampleDebug() {
		if (typeof document === 'undefined') return;
		const vids = document.getElementsByTagName('video');
		let data = 0;
		for (const v of vids) if (v.readyState >= 2) data++;
		const sha = settings.buildSha ? settings.buildSha.slice(0, 8) : 'local';
		// snd = active element actually unmuted (the M2 sound-carry proof: should track the
		// blessed sound-on state across scroll + auto-advance). bless = pool blessed this session.
		// play = pool elements currently NOT paused — post-bless this MUST stay == POOL_SIZE, so
		// it directly observes the harness-D precondition (neighbours continuously playing). If
		// iOS silently pauses a neighbour under its concurrent-inline-playback cap, play< pool
		// even while live== pool (live counts DOM-present, not playing) → the fast-flick
		// becoming-active path could land on an actually-paused element (review #456).
		const snd = activeVideo()?.muted === false ? 1 : 0;
		let playing = 0;
		for (const v of pool) if (!v.paused) playing++;
		debugCounts = `build=${sha} pool=${pool.length} live=${vids.length} play=${playing} data=${data} active=${activeIndex} blk=${activeBlocked ? 1 : 0} bless=${blessed ? 1 : 0} snd=${snd}`;
	}

	onMount(() => {
		readViewport();
		// Always start muted: a page load recreates the pool as fresh, unblessed elements, so
		// iOS requires a new "tap for sound" gesture every session regardless of any saved pref
		// (the per-element blessing can't survive element re-creation). Starting muted keeps the
		// rail icon honest and makes the first tap the bless gesture (no two-tap). saveMute still
		// persists within-session intent.
		muted = true;
		infoOpen = loadInfo(feedName);
		autoAdvance = loadAutoAdvance(feedName, settings.autoAdvance);
		for (const n of loadHidden(feedName)) hidden.add(n);

		// Create the persistent pool (imperative — these foreign nodes outlive any card and
		// are reparented across cards; Svelte must not reconcile them). Listeners bound once.
		for (let s = 0; s < POOL_SIZE; s++) {
			const v = document.createElement('video');
			v.muted = true;
			v.playsInline = true;
			v.setAttribute('playsinline', '');
			v.loop = !autoAdvance;
			v.preload = 'auto';
			v.className = 'pool-video';
			v.addEventListener('playing', () => onPoolPlaying(s));
			v.addEventListener('waiting', () => {
				if (s === slotForCard(activeIndex)) activeBuffering = true;
			});
			v.addEventListener('timeupdate', () => {
				if (s === slotForCard(activeIndex)) activeCurrentTime = v.currentTime;
			});
			v.addEventListener('loadedmetadata', () => {
				if (s === slotForCard(activeIndex)) activeDuration = v.duration || 0;
			});
			v.addEventListener('canplay', () => {
				if (
					s === slotForCard(activeIndex) &&
					shouldRetryOnPlayable({
						active: true,
						paused: activePaused,
						hasPlayed: cardRevealed[activeIndex] ?? false,
						errored: false
					})
				)
					tryPlayActive(v);
			});
			v.addEventListener('ended', () => {
				if (s === slotForCard(activeIndex) && autoAdvance) scrollTo(activeIndex + 1);
			});
			v.addEventListener('error', () => onPoolError(s));
			pool.push(v);
		}

		io = new IntersectionObserver(
			(entries) => {
				for (const entry of entries) {
					if (entry.isIntersecting && entry.intersectionRatio >= 0.6) {
						const idx = Number((entry.target as HTMLElement).dataset.index);
						if (!Number.isNaN(idx) && idx !== activeIndex) {
							// new card: reset the active-card UI state until it reports
							activeBlocked = false;
							activePaused = false;
							activeCurrentTime = 0;
							activeDuration = 0;
							activeIndex = idx;
						}
					}
				}
			},
			{ root: feedEl, threshold: [0.6] }
		);
		for (const el of cardEls) if (el) io.observe(el);

		feedEl?.addEventListener('touchstart', onTouchStart, { passive: true });
		feedEl?.addEventListener('touchmove', onTouchMove, { passive: true });
		feedEl?.addEventListener('touchend', onTouchEnd, { passive: true });

		if (settings.debugPlayback) {
			sampleDebug();
			debugTimer = setInterval(sampleDebug, 500);
		}

		return () => {
			io?.disconnect();
			feedEl?.removeEventListener('touchstart', onTouchStart);
			feedEl?.removeEventListener('touchmove', onTouchMove);
			feedEl?.removeEventListener('touchend', onTouchEnd);
			clearTimeout(undoTimer);
			clearTimeout(modeTimer);
			clearTimeout(copyTimer);
			clearInterval(debugTimer);
			for (const v of pool) {
				v.pause();
				v.removeAttribute('src');
				v.load();
			}
		};
	});

	// (Re)observe current cards whenever the visible list changes. observe() is idempotent.
	$effect(() => {
		const list = visible;
		if (!io) return;
		for (let i = 0; i < list.length; i++) {
			const el = cardEls[i];
			if (el) io.observe(el);
		}
	});

	// THE pool driver: reassign + reparent + play whenever the active index moves, the feed
	// grows, or a shell slot (re)registers. Reads those reactive deps; everything it mutates
	// (slotToCard is plain; cardRevealed/active* are state set imperatively) is kept off the
	// dependency set via untrack so this can't self-loop.
	$effect(() => {
		void activeIndex;
		void visible.length;
		void cardSlotByName;
		untrack(() => syncPool());
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

	// Lazy-load the next page as the active card nears the loaded tail.
	$effect(() => {
		if (activeIndex >= visible.length - (settings.preloadAhead + 3)) loadMore();
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
			<!-- The .card cell ALWAYS renders (100dvh, data-index, IO-observed) so scroll
			     height + single-IO windowing are intact. Within the mount window it renders
			     the cheap VideoCard SHELL (no <video> — Feed parks a pooled element into its
			     slot); off-window cards get a bare placeholder. -->
			<div class="card" data-index={i} bind:this={cardEls[i]}>
				{#if isLive(i)}
					<VideoCard
						{item}
						active={i === activeIndex}
						{viewportAR}
						posters={settings.posters}
						revealed={cardRevealed[i] ?? false}
						buffering={i === activeIndex && activeBuffering}
						blocked={i === activeIndex && activeBlocked}
						paused={i === activeIndex && activePaused}
						currentTime={i === activeIndex ? activeCurrentTime : 0}
						duration={i === activeIndex ? activeDuration : 0}
						onslot={(el) => registerSlot(item.name, el)}
						onseek={seekActiveFrac}
						onseekby={seekActiveBy}
						ontap={tapActive}
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
			<button class="info-name" onclick={() => copyId(activeItem.name)} title="Copy ID">
				<span class="info-id">{activeItem.name}</span>
				<Copy size={13} aria-hidden="true" />
			</button>
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

{#if copyToast}
	<div class="mode-toast" role="status">Copied ID ✓</div>
{/if}

{#if settings.debugPlayback}
	<div class="debug-overlay" aria-hidden="true">
		<div class="debug-counts">{debugCounts}</div>
		{#each debugLog as line (line)}
			<div>{line}</div>
		{/each}
	</div>
{/if}

<style>
	/* The pooled <video> elements are foreign nodes Feed parks into card shells, so they
	   can't be styled by VideoCard's scoped CSS — style them globally here. Mirrors the old
	   per-card <video>: fill the cell, cover-fit (contain for off-aspect), reveal cross-fade. */
	:global(.pool-video) {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		object-fit: cover;
		opacity: 0;
		transition: opacity 0.25s ease;
	}
	:global(.pool-video.revealed) {
		opacity: 1;
	}
	:global(.pool-video.contain) {
		object-fit: contain;
	}

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
		display: flex;
		align-items: center;
		gap: 0.4rem;
		margin: 0;
		padding: 0;
		font: inherit;
		font-size: 0.85rem;
		font-weight: 600;
		color: inherit;
		text-align: left;
		word-break: break-word;
		background: none;
		border: 0;
		cursor: pointer;
		pointer-events: auto;
	}

	.info-name :global(svg) {
		flex: none;
		opacity: 0.6;
	}

	.info-name:active {
		opacity: 0.7;
	}

	.info-id {
		user-select: text;
		-webkit-user-select: text;
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

	.debug-overlay {
		position: fixed;
		top: calc(env(safe-area-inset-top) + 0.25rem);
		left: 0.25rem;
		z-index: 50;
		max-width: 60vw;
		padding: 0.35rem 0.5rem;
		font-family: ui-monospace, monospace;
		font-size: 0.62rem;
		line-height: 1.25;
		color: #9effa0;
		background: rgba(0, 0, 0, 0.62);
		border-radius: 0.35rem;
		pointer-events: none;
		white-space: pre;
	}

	.debug-counts {
		color: #fff;
		font-weight: 700;
		margin-bottom: 0.15rem;
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
