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
	// The card index driveActive last STARTED (reset to t=0). Tracks fresh arrivals so a clip
	// restarts from the top when you land on it (TikTok-style) instead of resuming the muted
	// off-screen pre-roll the post-bless neighbour accumulated — without re-seeking on every
	// syncPool (slot re-registration etc.) for a card that's already the active one.
	let lastDrivenActive = -1;
	// Consecutive auto-advance error-skips (review #3c). Reset on any successful play
	// (onActivePlaying), so isolated broken clips skip but a feed of all-404s can't scroll-
	// loop: after MAX_ERROR_SKIPS in a row with no success we stop and leave the card blocked
	// (tap-to-play) rather than cascading to the feed end.
	let errorSkips = 0;
	const MAX_ERROR_SKIPS = 3;

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

	// ── M2.4 prewarm-fetch (review #491) ──────────────────────────────────────────
	// The cold-start two-tap is data-not-ready-at-tap, not a play-path problem: on a cold
	// element the in-gesture play() can't START within iOS's activation window (no bytes),
	// so the per-element bless never mints and the later canplay self-heal plays OUTSIDE the
	// window → tap-2. Lever: warm the HTTP CACHE (not the element's play-state) with each
	// covered card's first ~1MB (moov + first GOPs) via a side-channel Range fetch, so the
	// element's own load()/play() is served from cache and ready in time. This is decoupled
	// from the <video> → zero play-state change → cure-shape fully intact (a fetch() is not a
	// play()). Fires for active±1 (the coverage window) as each card enters it; v.load() is
	// KEPT (driveActive). Whether Safari actually reuses the partial for the <video>'s OWN
	// range requests is the make-or-break unknown (#491) — MEASURED on-device via the overlay
	// `rs=` (active el readyState): rs≥3 before tap-1 = prewarm works; stuck 0–1 on a cold
	// card = Safari isn't reusing it and we escalate the lever.
	const PREWARM_BYTES = 1024 * 1024; // first 1 MB
	// url → fetch kicked off (dedupe; the HTTP cache is the target). Plain object, NOT a
	// SvelteSet: deliberately non-reactive, read only imperatively from prewarm() under the
	// syncPool untrack (same philosophy as the plain `pool`/`slotToCard`).
	const prewarmed: Record<string, true> = {};
	// In-flight prewarm AbortControllers (review #5d) — lets a fast flick cancel a superseded
	// prewarm so its 1 MB fetch can't hog the connection ahead of the new active card's own
	// <video> load. Plain object, same non-reactive rationale as `prewarmed`.
	const prewarmControllers: Record<string, AbortController> = {};
	function prewarm(url: string) {
		if (typeof fetch === 'undefined' || prewarmed[url]) return;
		prewarmed[url] = true;
		// Range-capped at 1 MB so we never pull the whole file; same endpoint + 206 path the
		// <video> uses (server Range support is the reason this app exists — guarded by
		// range.test.ts). Body drained so the partial is committed to cache. Fire-and-forget,
		// but abortable: cancelStalePrewarms() kills it if its card scrolls out of coverage.
		const ac = new AbortController();
		prewarmControllers[url] = ac;
		fetch(url, { headers: { Range: `bytes=0-${PREWARM_BYTES - 1}` }, signal: ac.signal })
			.then((res) => res.arrayBuffer())
			.then(() => {
				delete prewarmControllers[url]; // settled OK — keep `prewarmed` (it's cached now)
			})
			.catch(() => {
				delete prewarmControllers[url];
				delete prewarmed[url]; // aborted / transient — let a later syncPool re-warm
			});
	}
	// Abort prewarm fetches whose card is no longer covered (`wanted` = urls of the new
	// assignment; a plain array — at most POOL_SIZE entries). Only the side-channel cache-warm
	// fetch — NEVER a <video>'s own load. (#5d)
	function cancelStalePrewarms(wanted: string[]) {
		for (const url in prewarmControllers) {
			if (!wanted.includes(url)) prewarmControllers[url].abort();
		}
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
	// The active element is confirmed playing: clear the blocked/buffering UI, REVEAL it
	// (cross-fade poster→video), and apply audio. Reveal is active-ONLY: post-bless neighbours
	// play muted off-screen, so revealing them would expose pre-roll frames (the skip-ahead the
	// operator saw). An already-playing neighbour becoming active won't re-fire 'playing', so
	// reveal here (not only in onPoolPlaying) covers that transition. A card stays revealed once
	// active (showing its last frame as it scrolls out is fine); syncPool clears reveal on
	// recycle. This restores M1's poster-until-active visuals.
	function onActivePlaying() {
		activeBlocked = false;
		errorSkips = 0; // a successful play breaks any auto-advance error-skip chain (#3c)
		const v = activeVideo();
		if (v) {
			v.classList.add('revealed');
			cardRevealed = { ...cardRevealed, [activeIndex]: true };
		}
		assertActiveAudio();
	}

	// Per-element listeners (bound once at creation; `slot` is the fixed pool index). They
	// only touch the reactive active-state when THIS slot is the active one, so a
	// neighbour's events can't clobber the active card's UI.
	function onPoolPlaying(slot: number) {
		if (slot === slotForCard(activeIndex)) {
			activeBuffering = false;
			onActivePlaying();
		} else {
			// Neighbour started playing (post-bless neighbours play continuously, muted, while
			// OFF-screen). Re-assert muted (some iOS reset muted to the attribute default on a
			// src-swap; the attribute is unset, so the default is UNMUTED — guard it here so a
			// recycled neighbour can never bleed audio). Do NOT reveal: only the active card is
			// revealed (above), and it's reset to t=0 on activation (driveActive), so the off-
			// screen pre-roll is never seen and there's no skip-ahead.
			pool[slot].muted = true;
		}
	}
	function onPoolError(slot: number) {
		if (slot === slotForCard(activeIndex)) {
			activeBuffering = false;
			activeBlocked = true;
			pushDebug(activeIndex, 'error', pool[slot]?.error ? `code${pool[slot]!.error!.code}` : 'err');
			// Auto-advance past an errored active card (e.g. 404 / decode-fail): it fires `error`,
			// never `ended`, so without this the feed dead-ends on a broken clip. Mirrors the
			// `ended`→next handler, but CAPPED (errorSkips, reset on a successful play) so a feed
			// of all-broken clips can't cascade-scroll to the end. (review #3c)
			if (autoAdvance && errorSkips < MAX_ERROR_SKIPS) {
				errorSkips++;
				scrollTo(activeIndex + 1);
			}
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
		// Cancel prewarm fetches for cards no longer in the new coverage window (#5d).
		const wantedUrls: string[] = [];
		for (let s = 0; s < POOL_SIZE; s++) {
			const c = next[s];
			if (c !== null && visible[c]) wantedUrls.push(visible[c].url);
		}
		cancelStalePrewarms(wantedUrls);
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
				// Warm this card's first bytes into the HTTP cache as it enters the coverage
				// window (active±1), so its load()/play() is ready within the first tap (M2.4).
				prewarm(item.url);
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
		// Fresh arrival (genuine active-card CHANGE, not a re-park from slot re-registration /
		// feed growth — which must never re-seek/re-load a card that's already active).
		const fresh = activeIndex !== lastDrivenActive;
		if (fresh) {
			// Restart the clip from the top. Post-bless the active el may have been a neighbour
			// pre-rolling muted off-screen (~Xs in), so without this it would resume mid-clip (the
			// skip-ahead the operator saw, worse under auto-advance's faster cadence).
			v.currentTime = 0;
			lastDrivenActive = activeIndex;
		}
		activeDuration = v.duration || 0;
		activeCurrentTime = v.currentTime || 0;
		activeBuffering = false;
		if (!blessed) {
			// Pre-bless: do NOT autoplay. Hold the active card paused on its poster with the play
			// affordance showing; the first tap (tapActive / toggleMute) plays it WITH sound from
			// IDLE — the only state iOS authorizes for audible output. (Muted-autoplaying it here
			// and unmuting on the tap is what paused the first card — the first-bless-pause.)
			v.pause();
			activePaused = true;
			// WARM the buffer so that first tap plays in ONE tap. iOS throttles preload=auto for
			// PAUSED elements, so without this the start-paused active card is cold → tap-1 only
			// kicks the load, tap-2 plays (the double-tap, #480). v.load() starts buffering
			// WITHOUT playing — gesture-free, audio-free, trips neither the play-gate nor the
			// audible-gate, so the cure-shape (no ungestured play()) is intact (review #481); it
			// also makes canplay fire, so the post-bless self-heal can auto-play any residual
			// cold tap-1 without a second tap. Only on a fresh active card (not every re-park).
			if (fresh) v.load();
			return;
		}
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

	function prefersReducedMotion(): boolean {
		return (
			typeof window !== 'undefined' &&
			!!window.matchMedia &&
			window.matchMedia('(prefers-reduced-motion: reduce)').matches
		);
	}

	function scrollTo(index: number) {
		const i = Math.max(0, Math.min(visible.length - 1, index));
		// Honor prefers-reduced-motion: jump instead of the smooth full-viewport glide. (#4)
		cardEls[i]?.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
	}

	function tapActive() {
		const v = activeVideo();
		if (!v) return;
		if (!blessed) {
			// First interaction = the initiating gesture: play the active card WITH sound + bless
			// the pool. The element is idle (never autoplayed pre-bless) so this gesture-play is
			// authorized for audible output (operator-approved start-paused model, #472).
			muted = false;
			blessPool();
			return;
		}
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
	// Called from the FIRST user gesture (tapActive / toggleMute). Pre-bless every pool element
	// is IDLE (paused on its poster — nothing muted-autoplays now), so play()ing each one here,
	// inside the gesture, is a fresh gesture-INITIATED start that iOS authorizes for audible
	// output — the durable per-element bless. (The earlier bug: an element mid muted-autoplay
	// could NOT be unmuted off-gesture, and a synchronous pause→play on it didn't re-mint the
	// activation on-device. Playing a genuinely idle element fresh in the gesture does — exactly
	// why the paused neighbours always blessed cleanly.) Active stays unmuted; neighbours are
	// re-muted at once (D-safe, no multi-audio blip).
	function blessPool() {
		blessed = true;
		activePaused = false;
		activeBlocked = false;
		const aSlot = slotForCard(activeIndex);
		for (let s = 0; s < pool.length; s++) {
			const v = pool[s];
			if (!v.src) continue;
			v.pause(); // ensure idle, then a fresh gesture-initiated play() below
			v.muted = false; // unmute IN-gesture — the bless (per-element, durable)
			const p = v.play();
			if (p && typeof p.then === 'function') p.catch(() => {});
			if (s !== aSlot) v.muted = true; // re-mute neighbours at once (no multi-audio blip)
		}
	}

	function toggleMute() {
		if (!blessed) {
			// First interaction via the rail (before any tap on the video): initiate playback
			// WITH sound + bless the pool, same as the first tapActive (start-paused model, #472).
			// Pre-bless nothing is playing, so an in-place mute toggle would be meaningless.
			muted = false;
			blessPool();
			return;
		}
		muted = !muted;
		if (!muted) {
			// Sound back ON (already blessed): unmute the active element (D-safe off-gesture).
			const v = activeVideo();
			if (v) v.muted = false;
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

	// True when keyboard focus sits on an interactive control (rail button, seek slider, link,
	// form field) — so the global Space handler doesn't shadow its native activation. (#4)
	function focusIsInteractive(): boolean {
		if (typeof document === 'undefined') return false;
		const el = document.activeElement;
		if (!el) return false;
		if (el.getAttribute('role') === 'slider') return true;
		return ['BUTTON', 'A', 'INPUT', 'SELECT', 'TEXTAREA'].includes(el.tagName);
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
				// Don't hijack Space when a control is focused — let it natively activate that
				// button/slider (WCAG keyboard operability). Space still toggles play when focus
				// is on the page or the full-bleed tap target (no control focused). (#4)
				if (focusIsInteractive()) return;
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
		// rs = active element's readyState (M2.4 prewarm probe, review #491): if the cache
		// prewarm is reused, rs should reach ≥3 (HAVE_FUTURE_DATA) BEFORE the first tap on a
		// cold card; stuck at 0–1 means Safari isn't reusing the prefetch.
		const rs = activeVideo()?.readyState ?? -1;
		debugCounts = `build=${sha} pool=${pool.length} live=${vids.length} play=${playing} data=${data} active=${activeIndex} rs=${rs} blk=${activeBlocked ? 1 : 0} bless=${blessed ? 1 : 0} snd=${snd}`;
	}

	onMount(() => {
		readViewport();
		// Start "paused-but-unmuted" (operator-approved, #472): the active card does NOT
		// muted-autoplay on load — it sits paused on its poster (see driveActive's pre-bless
		// branch) with sound-intent on (muted=false → rail shows unmuted). The first tap (video
		// or rail) is a genuine gesture-initiated play-WITH-sound on an IDLE element, which iOS
		// authorizes for audible output + blesses the pool. This sidesteps the audible-output
		// gate that paused the first card when we tried to unmute a mid-muted-autoplay element
		// (the first-bless-pause). A reload recreates the pool fresh, so the bless is per-session.
		muted = false;
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
						errored: false,
						blessed
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
			for (const url in prewarmControllers) prewarmControllers[url].abort(); // #5d cleanup
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

	// Re-fit the parked pooled <video>s when the viewport aspect changes (rotate/resize).
	// applyFit otherwise runs only on a src-swap (syncPool's recycle branch), so a rotation
	// would leave an already-parked element letterboxed for the OLD aspect until it recycles.
	// Touches ONLY the fit CLASS (object-fit cover/contain) — never play state. (review #3a)
	$effect(() => {
		void viewportAR;
		untrack(() => {
			for (let s = 0; s < pool.length; s++) {
				const card = slotToCard[s];
				if (card !== null && visible[card]) applyFit(pool[s], visible[card]);
			}
		});
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
