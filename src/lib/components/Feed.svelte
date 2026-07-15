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
	// muted→unmuted toggle on such a blessed element never re-pauses (section D). So every
	// pool element MUTED-autoplays continuously from load (0.6.1, reverting 0.6.0's start-
	// paused #472), and the sound-on tap blesses the whole pool with a bare SYNCHRONOUS
	// muted=false flip on those already-playing elements (re-muting neighbours at once) —
	// WebKit grants the unmute because the element is already playing in a gesture, sidestep-
	// ping the "start audible from a buffered paused element" decision it refuses (the 0.6.0
	// first-card two-tap wall). Becoming-active is then just a
	// D-safe off-gesture unmute. The always-muted cure (0.5.5) is preserved: we NEVER issue an
	// unmuted play() off-gesture — every play() is muted, unmute is only ever a flip on an
	// already-playing element. Decoder count is bounded by POOL_SIZE (< the old ~6).
	import { onMount, untrack } from 'svelte';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { SvelteSet } from 'svelte/reactivity';
	import VideoCard from './VideoCard.svelte';
	import ImageCarousel from './ImageCarousel.svelte';
	import ActionRail from './ActionRail.svelte';
	import Undo2 from '@lucide/svelte/icons/undo-2';
	import Copy from '@lucide/svelte/icons/copy';
	import Heart from '@lucide/svelte/icons/heart';
	import ChevronLeft from '@lucide/svelte/icons/chevron-left';
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
	import { nearestVideos, reassignPool } from '$lib/pool';

	let {
		items,
		feedName,
		settings,
		total,
		seed,
		starred = [],
		likedView = false
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
		/** Starred names SSR-seeded into starredSet at init so filled hearts paint on the FIRST
		 *  frame — no empty→filled flash on a reload onto a favorited clip (0.9.0). [] when off. */
		starred?: string[];
		/** True on the /liked favorites view: render a back chevron and DISABLE the long-press
		 *  entry (no self-navigation). The main feed leaves it false. 0.9.0. */
		likedView?: boolean;
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
	// Show a transient message on the shared mode-toast surface (auto-dismiss after `ms`).
	function showModeToast(msg: string, ms = 2000) {
		modeToast = msg;
		clearTimeout(modeTimer);
		modeTimer = setTimeout(() => (modeToast = null), ms);
	}
	let copyToast = $state(false);
	let copyTimer: ReturnType<typeof setTimeout> | undefined;
	let infoOpen = $state(false);
	let autoAdvance = $state(false);
	const visible = $derived(applyHidden(allItems, hidden));
	const activeItem = $derived(visible[activeIndex]);
	// O(1) name→item for syncPool's recycle loop + the viewportAR re-fit, which translate a
	// name-keyed slot back to its FeedItem (0.6.2 #1). Plain object (not a Map) to satisfy
	// svelte/prefer-svelte-reactivity; names are unique filenames (loadMore dedupes by name).
	const itemByName: Record<string, FeedItem> = $derived(
		Object.fromEntries(visible.map((i): [string, FeedItem] => [i.name, i]))
	);

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
	// pool slot → the item NAME it shows (0.6.2 #1: was index-keyed; re-keyed to the stable
	// clip name so a hide/undo re-index of `visible` can't strand a kept slot under a stale
	// index — mirrors cardSlotByName, which was already name-keyed and correct).
	let slotToName: (string | null)[] = new Array(POOL_SIZE).fill(null);
	// Shell slot divs keyed by the STABLE item name (not index): `use:` actions fire only
	// on mount/destroy, so a hide/undo or lazy-append that shifts indices must not strand a
	// kept card's slot under a stale index. The card node persists across reorders (keyed
	// each-block), so name→node is stable.
	let cardSlotByName = $state<Record<string, HTMLElement>>({});
	// Reactive surface for the shells: which clip NAMES have a painted (revealed) video,
	// and the active card's live playback state (single source of truth — review #433).
	// (0.6.2 #1: name-keyed so a recycled slot's fresh clip is never painted as already-
	// revealed, and reveal follows the clip across a hide/undo re-index.)
	let revealedByName = $state<Record<string, boolean>>({});
	let activeBuffering = $state(false);
	let activeBlocked = $state(false);
	let activePaused = $state(false);
	// 0.8.7 (#1307): the play-button overlay's OWN view of the active clip's paused state, kept
	// DISTINCT from `activePaused` (the cure's synchronous play-INTENT, :811) — driven by the
	// active element's real play/pause events so EXTERNAL toggles (BT button, AirPods, lock
	// screen) sync the overlay too, not just on-screen taps. See scheduleShowPlaySync.
	let activeShowPlay = $state(false);
	let activeCurrentTime = $state(0);
	let activeDuration = $state(0);
	// Monotonic token cancelling stale async play retries on the active element.
	let playGen = 0;
	// 0.8.7 (#1307): rAF token coalescing overlay paused-state syncs (see scheduleShowPlaySync).
	let showPlaySyncRaf = 0;
	// The clip NAME driveActive last STARTED (reset to t=0). Tracks fresh arrivals so a clip
	// restarts from the top when you land on it (TikTok-style) instead of resuming the muted
	// off-screen pre-roll the post-bless neighbour accumulated — without re-seeking on every
	// syncPool (slot re-registration etc.) for a card that's already the active one. (0.6.2
	// #1: name-keyed so a hide/undo re-index that leaves the SAME clip active doesn't
	// false-trigger a t=0 restart — fresh ⇔ a genuinely new clip became active.)
	let lastDrivenName: string | null = null;
	// Consecutive auto-advance error-skips (review #3c). Reset on any successful play
	// (onActivePlaying), so isolated broken clips skip but a feed of all-404s can't scroll-
	// loop: after MAX_ERROR_SKIPS in a row with no success we stop and leave the card blocked
	// (tap-to-play) rather than cascading to the feed end.
	let errorSkips = 0;
	const MAX_ERROR_SKIPS = 3;

	function slotForName(name: string): number {
		return slotToName.indexOf(name);
	}
	// The pool slot showing the ACTIVE card's clip, resolved by identity (name), not index
	// (0.6.2 #1). `activeIndex` stays the positional IO anchor; its clip identity is
	// `activeItem.name`, and THIS maps that name → the physical slot. Returns -1 when the
	// active clip isn't currently pooled (a transient before syncPool settles after a
	// re-index). Replaces all 10 former `slotForCard(activeIndex)` call-sites — including the
	// cure-critical bless flip (blessPool), so a hide/undo re-index can never mis-target which
	// element stays unmuted.
	function activeSlot(): number {
		const n = activeItem?.name;
		return n ? slotForName(n) : -1;
	}
	function activeVideo(): HTMLVideoElement | null {
		const s = activeSlot();
		return s >= 0 ? pool[s] : null;
	}

	// 0.8.2 cropping fix: prefer the element's OWN intrinsic dims (videoWidth/Height) over the
	// manifest's. The 0.7.0 cheap-scan feeds (favorite, + liked until POSTERS warms) carry NO
	// width/height — so manifest-only `pickFit(0,0,…)` hit the unknown-dims guard and returned
	// `cover`, top/bottom-cropping a portrait clip on a landscape/desktop viewport. The pooled
	// <video> always knows its real dims once `loadedmetadata` fires; fall back to the manifest
	// for the pre-metadata call, then the loadedmetadata listener re-fits with truth.
	// 0.8.6 (#5): on a RECYCLE src-swap the element still holds the OUTGOING clip's
	// videoWidth/Height — it is NOT emptied synchronously when `src` is reassigned — so a
	// truthy-stale dim would win over the incoming clip's manifest dims and paint a transient
	// WRONG fit (cover/contain inverted on orientation-heterogeneous neighbours) until
	// `loadedmetadata`. `useElementDims=false` forces the manifest dims on that path (the
	// element's own dims are about to be discarded anyway); loadedmetadata then re-fits with the
	// new clip's real dims. The active/rotation re-fits keep the default (real, loaded dims).
	function applyFit(v: HTMLVideoElement, item: FeedItem, useElementDims = true) {
		const ew = useElementDims ? v.videoWidth : 0;
		const eh = useElementDims ? v.videoHeight : 0;
		const f = pickFit(ew || item.width || 0, eh || item.height || 0, viewportAR);
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
	// syncPool untrack (same philosophy as the plain `pool`/`slotToName`).
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
	// One gen-guarded play() attempt on the re-resolved active element: success →
	// onActivePlaying; AbortError (a superseded play, expected on rapid scroll) →
	// silently drop; any other rejection → onFail(err, el) decides the next step.
	// Factored out of the retry ladder below (#5c) — pure shape, identical behaviour:
	// same gen guards, same AbortError handling, same play() call sites + ordering.
	// It never touches muted state (the cure is upstream in tryPlayActive's caller).
	function attempt(
		getEl: () => HTMLVideoElement | null | undefined,
		gen: number,
		onFail: (err: unknown, el: HTMLVideoElement) => void
	) {
		const el = getEl();
		if (gen !== playGen || !el) return;
		el.play()
			.then(() => {
				if (gen === playGen) onActivePlaying();
			})
			.catch((err: unknown) => {
				if (gen !== playGen) return;
				if (err instanceof DOMException && err.name === 'AbortError') return;
				onFail(err, el);
			});
	}

	function tryPlayActive(v: HTMLVideoElement) {
		if (!v.isConnected) return; // not parked into a slot yet
		const gen = ++playGen;
		// Only force muted on a fresh/paused start (the cure). A neighbour that's already
		// playing muted (post-bless) is left as-is so play() is a no-op and onActivePlaying
		// just unmutes it — no mute→unmute blip on the becoming-active transition.
		if (v.paused) v.muted = true;
		const p = v.play();
		if (!p || typeof p.then !== 'function') return;
		// Attempt 1: the play() just issued on `v`. On a non-Abort rejection, run the
		// retry ladder on the re-resolved active element via attempt():
		p.then(() => {
			if (gen === playGen) onActivePlaying();
		}).catch((err: unknown) => {
			if (gen !== playGen) return;
			if (err instanceof DOMException && err.name === 'AbortError') return;
			// Attempt 2 (next frame): re-resolve the active element and retry.
			requestAnimationFrame(() =>
				attempt(activeVideo, gen, (err2, cur) => {
					pushDebug(activeIndex, 'reject', err2 instanceof DOMException ? err2.name : 'err');
					activeBlocked = true;
					// Attempt 3: one delayed retry, but only if the element is actually
					// buffered (else the canplay self-heal picks it up). Terminal — a final
					// failure just leaves the card blocked (tap-to-play).
					if (isMediaReady(cur.readyState)) {
						setTimeout(() => attempt(activeVideo, gen, () => {}), 250);
					}
				})
			);
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
		const aName = activeItem?.name;
		if (v && aName) {
			v.classList.add('revealed');
			revealedByName = { ...revealedByName, [aName]: true };
		}
		assertActiveAudio();
	}

	// Per-element listeners (bound once at creation; `slot` is the fixed pool index). They
	// only touch the reactive active-state when THIS slot is the active one, so a
	// neighbour's events can't clobber the active card's UI.
	function onPoolPlaying(slot: number) {
		if (slot === activeSlot()) {
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
		if (slot === activeSlot()) {
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
		// Galleries (photo posts) are NEVER pooled — they own no <video>, register no slot, and
		// render via ImageCarousel. So the pool covers the nearest POOL_SIZE *videos* to the
		// active card, scanning OUTWARD past galleries (nearestVideos) — NOT a positional ±window
		// filtered for galleries (round-1's bug: a gallery-heavy window came back empty → the pool
		// tore down every nearby video's decoder → the next video cold-started blank, the #1417
		// regression). Keeping the closest videos warm regardless of interleaved galleries restores
		// the pure-video warm-neighbour guarantee. Identity by NAME at this boundary so a hide/undo
		// re-index can't strand a kept slot. An ACTIVE gallery isn't a video → not in targetNames →
		// activeSlot()=-1 → driveActive early-returns (no pool bleed, `activePaused` untouched).
		// On a pure-video feed nearestVideos == the old centred window, so the video path is intact.
		const targetIdx = nearestVideos(activeIndex, (i) => !visible[i].media, totalCards, POOL_SIZE);
		const targetNames = targetIdx.map((i) => visible[i].name);
		const next = reassignPool(slotToName, targetNames, POOL_SIZE);
		// Cancel prewarm fetches for clips no longer in the new coverage window (#5d).
		const wantedUrls: string[] = [];
		for (let s = 0; s < POOL_SIZE; s++) {
			const name = next[s];
			const item = name ? itemByName[name] : null;
			if (item) wantedUrls.push(item.url);
		}
		cancelStalePrewarms(wantedUrls);
		for (let s = 0; s < POOL_SIZE; s++) {
			const v = pool[s];
			const name = next[s];
			const prevName = slotToName[s];
			if (name === null) {
				if (prevName !== null) {
					v.pause();
					v.removeAttribute('src');
					v.load();
				}
				continue;
			}
			const item = itemByName[name];
			if (!item) continue;
			if (name !== prevName) {
				// Recycle this element onto a new clip: reset reveal, swap src. The element
				// stays blessed (per-element, durable) across this swap — that's the point.
				if (prevName !== null && revealedByName[prevName]) {
					const rest = { ...revealedByName };
					delete rest[prevName];
					revealedByName = rest;
				}
				v.classList.remove('revealed');
				v.loop = !autoAdvance;
				// #5 (0.8.6): manifest dims only — `v.videoWidth` is still the OUTGOING clip's
				// here (not emptied until the new src loads), so trusting it would paint a
				// transient wrong fit. loadedmetadata re-fits with the incoming clip's real dims.
				applyFit(v, item, false);
				v.src = item.url;
				// Re-assert muted AFTER the src-swap (some iOS reset muted to the attribute
				// default — unset = unmuted — on swap). muted=true is the safe default: on an
				// adjacent scroll the recycled slot is always the off-screen far neighbour; on a
				// jump it may be the new active card, in which case driveActive→onActivePlaying
				// unmutes it once playing. Either way the per-element blessing survives the swap
				// (harness A).
				v.muted = true;
				// Warm this clip's first bytes into the HTTP cache as it enters the coverage
				// window (active±1), so its load()/play() is ready within the first tap (M2.4).
				prewarm(item.url);
			}
			// (Re)park into the card's shell slot (resolved by stable name).
			const slotDiv = cardSlotByName[item.name] ?? null;
			if (slotDiv && v.parentNode !== slotDiv) slotDiv.appendChild(v);
		}
		slotToName = next;
		driveActive();
	}

	function driveActive() {
		const aSlot = activeSlot();
		for (let s = 0; s < pool.length; s++) {
			if (s === aSlot) continue;
			const v = pool[s];
			v.muted = true; // neighbours are always silent
			// Neighbours play CONTINUOUSLY muted (0.6.1 — pre- AND post-bless, no longer paused
			// pre-bless) so that (a) the bless gesture only has to flip muted=false on an already-
			// playing element — the clean WebKit-granted unmute — and (b) a becoming-active
			// neighbour is an off-gesture unmute on an already-playing blessed element (harness D),
			// never a pause→play→unmute. Muted autoplay is gesture-free + audio-free, so the cure
			// holds. This is the TikTok recycler. (A neighbour MUST be playing at bless time or its
			// per-element grant never mints → its later becoming-active unmute would pause it.)
			if (v.src && v.paused) v.play().catch(() => {});
		}
		if (aSlot < 0) return;
		const v = pool[aSlot];
		// Fresh arrival (genuine active-CLIP change, not a re-park from slot re-registration /
		// feed growth / a hide-reorder that left the SAME clip active — which must never
		// re-seek/re-load a clip that's already active). Keyed by NAME (0.6.2 #1) so a re-index
		// can't false-trigger a t=0 restart — fresh ⇔ a genuinely new clip became active.
		const aName = activeItem?.name;
		const fresh = aName !== lastDrivenName;
		if (fresh) {
			// Restart the clip from the top. The active el may have been a neighbour pre-rolling
			// muted off-screen (~Xs in), so without this it would resume mid-clip (the skip-ahead
			// the operator saw, worse under auto-advance's faster cadence).
			v.currentTime = 0;
			lastDrivenName = aName ?? null;
		}
		activeDuration = v.duration || 0;
		activeCurrentTime = v.currentTime || 0;
		activeBuffering = false;
		// MUTED-autoplay the active card (0.6.1, reverts start-paused #472). tryPlayActive forces
		// muted on a fresh/paused start and onActivePlaying→assertActiveAudio keeps it muted until
		// the pool is blessed, so nothing audible plays off-gesture (the cure holds). Keeping it
		// continuously playing-muted is exactly what lets the first tap bless via a bare synchronous
		// muted=false flip on an already-playing element (blessPool) — the fix for the 0.6.0 first-
		// card two-tap (a buffered PAUSED element's in-gesture unmute is the path WebKit refused).
		// The canplay self-heal (shouldRetryOnPlayable) recovers a
		// cold card whose first muted-autoplay rejected before its buffer arrived.
		tryPlayActive(v);
	}

	// 0.8.7 (#1307): sync the play-button overlay to the active element's SETTLED paused state.
	// rAF-coalesced so a double-tap's pause→play churn (or a transient src-swap pause) collapses
	// to ONE read instead of flashing the overlay — the M6-flicker class (:811). Observe-ONLY:
	// never calls play()/pause(), never writes `activePaused` (cure intent stays byte-identical).
	function scheduleShowPlaySync() {
		cancelAnimationFrame(showPlaySyncRaf);
		showPlaySyncRaf = requestAnimationFrame(() => {
			const v = activeVideo();
			if (v) activeShowPlay = v.paused;
		});
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

	/** Share the active video. With a public share base (0.8.4), mint a stored capability link
	 *  (`/share/<token>` — resolves OFF the LAN, unlike the direct media URL) and offer it via
	 *  the native share sheet, falling back to a clipboard copy; without one, share the direct
	 *  (LAN) URL as before. Cure-irrelevant — touches no pool/play state. iOS caveat: the async
	 *  mint can consume the share sheet's transient activation, so we distinguish a user-cancel
	 *  (AbortError → done) from an activation lapse (→ clipboard) and degrade gracefully. */
	async function share(item: FeedItem | undefined) {
		if (!item) return;
		// Mint on the item's OWN name: a video's filename, or a gallery's bare `<id>`. The
		// `/share/<token>` page is gallery-aware — a bare id renders the whole swipeable carousel
		// (full-carousel share, AC-5); a video renders the player. `safeMediaPath` accepts a bare
		// id (no separators). The LAN fallback (no shareBase) shares item.url — the cover frame for
		// a gallery — since off-LAN carousel needs the token/share page.
		const shareName = item.name;
		let url = new URL(item.url, location.origin).href; // pre-0.8.4 fallback: direct LAN URL
		if (settings.shareBase) {
			try {
				const res = await fetch(`/api/share/${encodeURIComponent(shareName)}`);
				if (res.ok) {
					const d = (await res.json()) as { url?: string };
					if (d?.url) url = d.url;
				}
			} catch {
				/* mint failed (offline / feature disabled) → keep the direct-URL fallback */
			}
		}
		if (navigator.share) {
			try {
				// title is a clean app name (NOT item.name) — a raw `<id>.mp4` filename made iOS
				// treat the payload as a FILE and offer the video itself instead of the link. The
				// `/share/<token>` page's Open Graph tags (0.8.4) carry the rich link-card preview.
				await navigator.share({ title: 'forya', url });
				return;
			} catch (e) {
				// AbortError = the user dismissed the sheet → done. Anything else
				// (NotAllowedError = activation lapsed after the async mint, common on iOS) →
				// fall through to the clipboard copy.
				if ((e as Error)?.name === 'AbortError') return;
			}
		}
		if (navigator.clipboard) {
			try {
				await navigator.clipboard.writeText(url);
				copyToast = true;
				clearTimeout(copyTimer);
				copyTimer = setTimeout(() => (copyToast = false), 1500);
				return;
			} catch {
				/* clipboard blocked */
			}
		}
		const a = document.createElement('a'); // last resort: direct download
		a.href = url;
		a.download = shareName;
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

	// Lazy info-overlay size (0.7.0): the cheap (poster-off) scan omits `size` to
	// avoid a per-file stat across the whole library. When the info card is open we
	// fetch the size for the SINGLE active card on demand — a HEAD to the media
	// endpoint, whose content-length IS the file size. One request, one card, only
	// while info is open — NOT a scan. Cached per name (plain object, reassigned to
	// stay reactive — same pattern as revealedByName). The poster feed keeps the
	// manifest `size` (full stat), so this never fires there.
	let sizeByName = $state<Record<string, number>>({});
	async function ensureInfoSize(item: FeedItem | undefined) {
		if (!item || item.size != null || sizeByName[item.name] != null) return;
		try {
			const res = await fetch(item.url, { method: 'HEAD' });
			const len = Number(res.headers.get('content-length'));
			if (res.ok && Number.isFinite(len) && len > 0) {
				sizeByName = { ...sizeByName, [item.name]: len };
			}
		} catch {
			/* offline / transient — the overlay just omits the size segment */
		}
	}
	$effect(() => {
		if (infoOpen) ensureInfoSize(activeItem);
	});

	function hide(name: string | undefined) {
		if (!name) return;
		hidden.add(name);
		saveHidden(feedName, hidden);
		const count = applyHidden(allItems, hidden).length;
		if (activeIndex >= count) activeIndex = Math.max(0, count - 1);
		lastHidden = name;
		clearTimeout(undoTimer);
		undoTimer = setTimeout(() => (lastHidden = null), 5000);
		persistHidden(name, true); // 0.8.3: also persist server-side when enabled
	}

	function undoHide() {
		if (!lastHidden) return;
		const name = lastHidden;
		hidden.delete(name);
		saveHidden(feedName, hidden);
		lastHidden = null;
		clearTimeout(undoTimer);
		persistHidden(name, false); // 0.8.3: also unhide server-side when enabled
	}

	// 0.8.3: mirror a hide/unhide to the SERVER-SIDE set. The local `hidden` SvelteSet +
	// localStorage is the instant UX (the feed already filters via `visible`); this
	// fire-and-forget PUT/DELETE persists it so it's cross-device and the server EXCLUDES
	// it from future feeds. Best-effort + silent on failure (same contract as the server
	// store and the starred optimistic write) — we deliberately do NOT roll back the local
	// hide on a network error (that would surprise-unhide); it just isn't persisted and
	// reappears on a full reload. No-op when server-hide is off → the hide stays local-only.
	function persistHidden(name: string, hide: boolean) {
		if (!settings.hidden) return;
		fetch(`/api/hidden/${encodeURIComponent(name)}`, { method: hide ? 'PUT' : 'DELETE' }).catch(
			() => {}
		);
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

	// ── #3b foreground re-drive (0.6.2) ─────────────────────────────────────────────
	// iOS pauses inline <video> when the tab/app backgrounds; on return nothing re-drives the
	// pool, so a becoming-active card can land on a silently-PAUSED element — the exact pause→
	// play transition the continuously-playing pool exists to avoid. Re-drive by REUSING
	// driveActive() (no new play path): neighbours resume muted (v.paused→play()), the active
	// card resumes via tryPlayActive. activeIndex is unchanged so fresh=false → NO t=0 restart
	// (the user keeps their place). Cure-shape intact: all driveActive plays are muted, and
	// onActivePlaying→assertActiveAudio's unmute is the D-safe toggle on an already-playing
	// blessed element, NOT an ungestured play() — guarantee-safe whether or not the per-element
	// bless survived backgrounding (the audio-after-background outcome is empirical, read off
	// the overlay on-device; the muted-only fallback is one branch away if iOS revokes it).
	// Guarded against an empty pool/feed; idempotent (coarse event, no debounce needed).
	function onForeground() {
		if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
		if (!pool.length || visible.length === 0) return;
		driveActive();
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

	// ── Starred / favorite mark (0.8.0) ──────────────────────────────────────────────
	// Client-side reactive set (mirrors `hidden`): the single source of truth for the rail
	// heart + the on-card heart badge + the gesture feedback. SSR-SEEDED from the `starred`
	// prop AT COMPONENT INIT (0.9.0) — this runs during SSR too, so the server emits filled
	// hearts and a hard reload onto a favorited clip never flashes empty (AC-2c). Updated
	// OPTIMISTICALLY on toggle with a PUT/DELETE to persist (rolled back on failure). Fully
	// decoupled from the feed manifest — a mark never rescans or touches the pooled-<video> machine.
	const starredSet = new SvelteSet<string>();
	// untrack: seed ONCE from the INITIAL prop values (runs in SSR + at init), intentionally NOT
	// a reactive dependency — the user's later toggles own the set, a re-seed would re-add removals.
	untrack(() => {
		if (settings.starred) for (const n of starred) starredSet.add(n);
	});
	// M6 gesture state machine (operator-locked, review-gated C1–C5). ONE window (review
	// #733 — collapsed from two near-equal constants): a tap within SEQ_WINDOW_MS of the
	// prior on the SAME active card continues the sequence; that much silence ends it.
	// tap-2 = ONE toggle (like OR unlike) + reconcile play/pause + heart; taps 3+ = heart-
	// only, HOLD the committed state (no re-toggle, no play/pause flicker); 300ms silence
	// (operator's number) resets → the next double-tap toggles the other way (double-tap-to-
	// unlike restored). Tune on-device.
	const SEQ_WINDOW_MS = 300;
	let lastTapAt = 0;
	let lastTapName: string | null = null;
	let inLikeSeq = false; // a toggle is committed for this burst → further taps are heart-only
	let seqName: string | null = null;
	let seqStarred = false; // the burst's committed state (hearts spawn only while liked)
	let seqPrePaused = false; // C1: play state read BEFORE tap-1, the reconcile target
	let seqTimer: ReturnType<typeof setTimeout> | undefined;
	let hearts = $state<{ id: number; x: number; y: number }[]>([]);
	let heartId = 0;
	// Non-reactive: pending heart self-removal timers, tracked only to clear on unmount.
	let heartTimers: ReturnType<typeof setTimeout>[] = [];
	let burstTick = $state(0);
	let bursting = $state(false);
	let burstTimer: ReturnType<typeof setTimeout> | undefined;

	async function setStarred(name: string, want: boolean) {
		if (!settings.starred) return;
		// Optimistic: flip the local set NOW (instant heart) → persist → revert on failure.
		if (want) starredSet.add(name);
		else starredSet.delete(name);
		try {
			const res = await fetch(`/api/starred/${encodeURIComponent(name)}`, {
				method: want ? 'PUT' : 'DELETE'
			});
			if (!res.ok) throw new Error(String(res.status));
		} catch {
			if (want) starredSet.delete(name);
			else starredSet.add(name); // roll back — the server is the source of truth
		}
	}

	// Toggle the ACTIVE card's star → returns the NEW state. Shared by the gesture (tap-2)
	// and the rail heart button. The CALLER owns the feedback visual (rail → centered burst,
	// no tap point; gesture → tap-point hearts) so each input modality reads right.
	function toggleStarredActive(): boolean {
		const name = activeItem?.name;
		if (!name || !settings.starred) return false;
		const want = !starredSet.has(name);
		setStarred(name, want);
		return want;
	}

	// The rail heart button's like path: toggle + the centered burst on star-ON (no tap point).
	function onRailStar() {
		if (toggleStarredActive()) triggerBurst();
	}

	function triggerBurst() {
		if (prefersReducedMotion()) return; // honor reduced-motion (#4 precedent)
		burstTick++; // re-key the overlay so a rapid repeat replays the animation
		bursting = true;
		clearTimeout(burstTimer);
		burstTimer = setTimeout(() => (bursting = false), 650);
	}

	// Spawn a transient heart at the tap point (TikTok-style spam feedback). PURE VISUAL —
	// touches nothing in the play/muted/bless machinery (C-safe). Reduced-motion-skipped;
	// self-removes after the float.
	function spawnHeart(e?: MouseEvent) {
		if (prefersReducedMotion()) return;
		const x = e?.clientX ?? (typeof window !== 'undefined' ? window.innerWidth / 2 : 0);
		const y = e?.clientY ?? (typeof window !== 'undefined' ? window.innerHeight / 2 : 0);
		const id = heartId++;
		hearts = [...hearts, { id, x, y }];
		const t = setTimeout(() => {
			hearts = hearts.filter((h) => h.id !== id);
			heartTimers = heartTimers.filter((x) => x !== t);
		}, 800);
		heartTimers.push(t);
	}

	// Reconcile play/pause to `targetPaused` (the pre-gesture state) using ONLY the existing
	// primitives (v.pause() / tryPlayActive) — no new play path, no raw v.play(). In-gesture on
	// the blessed active element (D-safe). Makes the double-tap's END play state DETERMINISTIC
	// (net-no-op) regardless of how many tapActive toggles fired (C2).
	//
	// Compares against `activePaused` (the INTENT, set synchronously by tapActive), NOT the live
	// `v.paused` — which lags a still-pending play() and would mis-fire a REDUNDANT tryPlayActive
	// right after tap-2 already resumed (a double play() on the same element → AbortError +
	// decoder hiccup = the M6 black-flicker). In the common 2-tap case the two toggles already
	// net to the pre-double state, so this is a no-op; it only ACTS when the net is genuinely
	// wrong (e.g. tap-1 was the first-bless, which doesn't toggle play/pause).
	function reconcilePlayState(targetPaused: boolean) {
		const v = activeVideo();
		if (!v) return;
		if (targetPaused && !activePaused) {
			v.pause();
			activePaused = true;
		} else if (!targetPaused && activePaused) {
			activePaused = false;
			activeBlocked = false;
			tryPlayActive(v);
		}
	}

	function endLikeSeq() {
		inLikeSeq = false;
		seqName = null;
	}
	function armSeqTimer() {
		clearTimeout(seqTimer);
		seqTimer = setTimeout(endLikeSeq, SEQ_WINDOW_MS);
	}

	// M6 (operator-locked): single-tap = play/pause; double-tap = TOGGLE the star (like OR
	// unlike); spam = one toggle + a heart per tap, no flicker. ADDITIVE over tapActive —
	// tap-1 runs tapActive() FIRST, synchronous + byte-identical (the cure's in-gesture bless
	// is untouched). The like-sequence is additive flag+timer state; taps 3+ and the idle-exit
	// call ZERO play()/tapActive() (C3). Touch taps route here; the keyboard Space path stays
	// on tapActive (the rail heart is its a11y route).
	function onTapGesture(e?: MouseEvent) {
		const name = activeItem?.name;
		const now = Date.now();

		// Mid-sequence (a toggle already committed this burst): every further rapid tap on the
		// same card is HEART-ONLY — no tapActive, no play/pause, no re-toggle (C3). Hearts only
		// while the burst is committed to LIKED (un-liking a card spawns no like-hearts).
		if (settings.starred && inLikeSeq && seqName === name && now - lastTapAt < SEQ_WINDOW_MS) {
			lastTapAt = now;
			if (seqStarred) spawnHeart(e);
			armSeqTimer();
			return;
		}

		// Is this the 2nd tap of a double (within the window, same card, not already in a seq)?
		const isDouble =
			settings.starred &&
			!!name &&
			lastTapName === name &&
			now - lastTapAt < SEQ_WINDOW_MS &&
			!inLikeSeq;

		// C1: BARE synchronous pre-state read BEFORE tapActive() — side-effect-free, cannot
		// throw, so it can never skip the bless. Captured on a FRESH tap (tap-1), reused as the
		// reconcile target when the double lands. NOT inferred by inverting the post-tap state.
		if (!isDouble) seqPrePaused = activeVideo()?.paused ?? activePaused;

		// tap-1 / single-tap: ALWAYS first, synchronous + byte-identical (bless + play/pause).
		tapActive();

		if (isDouble) {
			inLikeSeq = true;
			seqName = name;
			seqStarred = toggleStarredActive(); // the ONE toggle (like OR unlike)
			reconcilePlayState(seqPrePaused); // net-no-op: undo the double's play/pause churn
			if (seqStarred) spawnHeart(e); // hearts only when the burst committed to LIKED
			armSeqTimer();
		}
		lastTapAt = now;
		lastTapName = name;
	}

	function tapActive() {
		const v = activeVideo();
		if (!v) return;
		if (!blessed) {
			// First interaction = the initiating gesture. The active card is ALREADY muted-
			// autoplaying (0.6.1), so blessing is a bare synchronous muted=false flip in this
			// gesture (blessPool) — the canonical iOS tap-to-unmute that sidesteps the buffered-
			// paused-element unmute WebKit refused (the 0.6.0 two-tap, #570). Sound on.
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

	// Bless the whole pool in the current user gesture: flip each element's muted=false (the
	// per-element, durable iOS audible-output grant — harness A), then immediately re-mute the
	// neighbours (harness D: false→true on a blessed, playing element never re-pauses). The flip
	// is a BARE SYNCHRONOUS muted=false — NO pause(), NO play(), NO await/rAF/.then before it —
	// because every pool element is ALREADY muted-autoplaying continuously (driveActive). That is
	// the canonical iOS tap-to-unmute shape WebKit grants (the element is already playing in a
	// gesture), and it sidesteps the buffered-PAUSED-element unmute WebKit refuses — the 0.6.0
	// first-card two-tap (#570). MUST be called synchronously from a
	// real gesture (tapActive's tap / toggleMute's click / a touchend). Idempotent-safe but only
	// the first call mints the grant. Active stays unmuted; neighbours re-muted at once (D-safe).
	function blessPool() {
		blessed = true;
		activePaused = false;
		activeBlocked = false;
		const aSlot = activeSlot();
		// Gesture-liveness at the moment of the bless (DEBUG probe #3);
		// surfaced as `ua=` in the overlay. If a FAILING tap ever shows ua=0, an async gap upstream
		// burned the transient user-activation and we'd remove it; always ua=1 rules that out.
		debugUserActivation =
			typeof navigator !== 'undefined' && navigator.userActivation
				? navigator.userActivation.isActive
					? 1
					: 0
				: -1;
		for (let s = 0; s < pool.length; s++) {
			const v = pool[s];
			if (!v.src) continue;
			v.muted = false; // the bless: a bare synchronous unmute of an already-playing element
			if (s !== aSlot) v.muted = true; // re-mute neighbours at once (no multi-audio blip)
		}
	}

	function toggleMute() {
		if (!blessed) {
			// First interaction via the rail (the muted-icon "tap to unmute" affordance): flip
			// muted=false + bless the pool in this gesture, same as the first tapActive (0.6.1).
			// The active card is already muted-autoplaying, so this is the clean in-gesture unmute.
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
	// navigator.userActivation.isActive captured inside blessPool at the bless flip (two-tap
	// probe #3). Plain (non-reactive) — read only by sampleDebug for the overlay. -1 = not yet
	// blessed / API absent, 0 = inactive at bless (transient activation lapsed → bad), 1 = active.
	let debugUserActivation = -1;

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
		debugCounts = `build=${sha} pool=${pool.length} live=${vids.length} play=${playing} data=${data} active=${activeIndex} rs=${rs} blk=${activeBlocked ? 1 : 0} bless=${blessed ? 1 : 0} snd=${snd} ua=${debugUserActivation}`;
	}

	onMount(() => {
		readViewport();
		// Start MUTED-autoplaying (0.6.1, reverts the 0.6.0 start-paused model #472): the active
		// card muted-autoplays on load (see driveActive) and the rail shows the muted icon — the
		// natural "tap to unmute" affordance. The first tap (video or rail) flips muted=false
		// synchronously in the gesture on the already-playing element, which iOS grants for audible
		// output + blesses the pool (blessPool). This is the canonical iOS tap-to-unmute shape and
		// sidesteps the buffered-paused-element unmute WebKit refused — the 0.6.0 first-card two-tap.
		// A reload recreates the pool fresh, so the bless is per-session.
		muted = true;
		infoOpen = loadInfo(feedName);
		autoAdvance = loadAutoAdvance(feedName, settings.autoAdvance);
		for (const n of loadHidden(feedName)) hidden.add(n);

		// (starredSet is SSR-seeded from the `starred` prop at component INIT — see its
		// declaration — so filled hearts paint on the first frame, SSR included; no onMount seed.)

		// Enter/leave/hint toasts (0.9.0) — ONE transient message per mount on the shared mode-toast
		// surface. Favorites view → "Entered favorites". Main feed → "Left favorites" if we just came
		// BACK from it (a one-shot sessionStorage flag set on /liked teardown, since it unmounts
		// before this mounts), else the one-time long-press hint (localStorage, per feed).
		if (settings.starred) {
			if (likedView) {
				showModeToast('Entered favorites', 1800);
			} else {
				let leftLiked = false;
				try {
					leftLiked = sessionStorage.getItem('forya:leftLiked') === '1';
					if (leftLiked) sessionStorage.removeItem('forya:leftLiked');
				} catch {
					/* sessionStorage blocked — skip */
				}
				if (leftLiked) {
					showModeToast('Left favorites', 1800);
				} else {
					try {
						const hintKey = `forya:likedHint:${feedName}`;
						if (!localStorage.getItem(hintKey)) {
							showModeToast('Hold ♥ to see your likes', 3500);
							localStorage.setItem(hintKey, '1');
						}
					} catch {
						/* localStorage blocked — skip the hint */
					}
				}
			}
		}

		// Seed the SERVER hidden set (0.8.3) so a clip hidden on ANOTHER device stays hidden
		// here too. The server already excludes hidden names from the feed, so this mostly
		// keeps the local `hidden` set + undo + localStorage consistent (and catches any item
		// that raced ahead of the boot warm). Single small fetch, gated, silent on failure.
		if (settings.hidden) {
			fetch('/api/hidden')
				.then((r) => (r.ok ? r.json() : null))
				.then((d: { hidden?: string[] } | null) => {
					if (d?.hidden && d.hidden.length) {
						for (const n of d.hidden) hidden.add(n);
						saveHidden(feedName, hidden);
						// Clamp activeIndex if the seed shrank the visible feed (mirror hide():574,
						// adversarial #17). Narrow — at mount activeIndex is 0 and the server already
						// excludes hidden names — but a feed that raced ahead of the boot-warm could
						// shrink here; keep activeIndex in range so the active card is never stranded.
						const count = applyHidden(allItems, hidden).length;
						if (activeIndex >= count) activeIndex = Math.max(0, count - 1);
					}
				})
				.catch(() => {});
		}

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
				if (s === activeSlot()) activeBuffering = true;
			});
			v.addEventListener('timeupdate', () => {
				if (s === activeSlot()) activeCurrentTime = v.currentTime;
			});
			v.addEventListener('loadedmetadata', () => {
				if (s === activeSlot()) activeDuration = v.duration || 0;
				// 0.8.2 cropping fix: now that the element knows its REAL intrinsic dims, re-fit
				// this slot — at src-swap (syncPool) videoWidth is still 0, so applyFit fell back
				// to manifest dims (absent on cheap-scan feeds → cover-crop). Fit CLASS only; zero
				// play-state contact (same shape as the rotation re-fit effect above).
				const nm = slotToName[s];
				const it = nm ? itemByName[nm] : null;
				if (it) applyFit(v, it);
			});
			v.addEventListener('canplay', () => {
				if (
					s === activeSlot() &&
					shouldRetryOnPlayable({
						active: true,
						paused: activePaused,
						hasPlayed: activeItem ? (revealedByName[activeItem.name] ?? false) : false,
						errored: false
					})
				)
					tryPlayActive(v);
			});
			v.addEventListener('ended', () => {
				if (s === activeSlot() && autoAdvance) scrollTo(activeIndex + 1);
			});
			// 0.8.7 (#1307): keep the play-button overlay synced to the active clip's REAL paused
			// state for EVERY source — tap, BT button, AirPods, lock screen. iOS routes media-key
			// play/pause to the active <video>, firing these native events; we coalesce to the
			// settled state. Active slot ONLY — neighbours play/pause constantly (recycle/drive)
			// and must be ignored. `activePaused` (cure intent) is untouched.
			v.addEventListener('play', () => {
				if (s === activeSlot()) scheduleShowPlaySync();
			});
			v.addEventListener('pause', () => {
				if (s === activeSlot()) scheduleShowPlaySync();
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
							activeShowPlay = false; // 0.8.7 (#1307): overlay resets with the card; play/pause listeners re-sync
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

		// #3b — re-drive the pool when the tab/app returns to the foreground. iOS pauses inline
		// <video> on background; visibilitychange covers tab-switch/lock, pageshow covers iOS
		// bfcache (back-forward) restore (which visibilitychange may not fire for).
		document.addEventListener('visibilitychange', onForeground);
		window.addEventListener('pageshow', onForeground);

		if (settings.debugPlayback) {
			sampleDebug();
			debugTimer = setInterval(sampleDebug, 500);
		}

		return () => {
			// 0.9.0: leaving the favorites view → flag it so the main feed shows a "Left favorites"
			// toast on arrival (this component unmounts before the main feed mounts). One-shot.
			if (likedView) {
				try {
					sessionStorage.setItem('forya:leftLiked', '1');
				} catch {
					/* sessionStorage blocked — skip the leave toast */
				}
			}
			io?.disconnect();
			feedEl?.removeEventListener('touchstart', onTouchStart);
			feedEl?.removeEventListener('touchmove', onTouchMove);
			feedEl?.removeEventListener('touchend', onTouchEnd);
			document.removeEventListener('visibilitychange', onForeground);
			window.removeEventListener('pageshow', onForeground);
			clearTimeout(undoTimer);
			clearTimeout(modeTimer);
			clearTimeout(copyTimer);
			clearTimeout(burstTimer);
			clearTimeout(seqTimer);
			for (const t of heartTimers) clearTimeout(t);
			clearInterval(debugTimer);
			cancelAnimationFrame(showPlaySyncRaf);
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
	// changes (hide/undo/append/reorder), or a shell slot (re)registers. Reads those reactive
	// deps; everything it mutates (slotToName is plain; revealedByName/active* are state set
	// imperatively) is kept off the dependency set via untrack so this can't self-loop.
	// Depends on `visible` (the derived array identity, which changes on ANY hide/undo/append/
	// reorder) rather than `visible.length` — closes a same-length-reorder gap; syncPool is
	// idempotent so the extra runs are harmless (0.6.2 #1).
	$effect(() => {
		void activeIndex;
		void visible;
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
				const name = slotToName[s];
				const item = name ? itemByName[name] : null;
				if (item) applyFit(pool[s], item);
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
					{#if item.media}
						<!-- Photo-post gallery (Contract A): a swipeable ImageCarousel, NOT the pooled
						     <video> shell. Registers no slot (no onslot) + syncPool filters it out of the
						     pool target set → zero video-pool bleed (AC-4). `ontap` routes a genuine tap to
						     the SAME onTapGesture as a video (double-tap-to-like + heart burst — every
						     video-specific op no-ops on a gallery). Auto-advance dwells then scrolls on
						     (a gallery has no <video> 'ended' to drive the feed). -->
						<ImageCarousel
							{item}
							active={i === activeIndex}
							{viewportAR}
							{autoAdvance}
							ontap={onTapGesture}
							onadvance={() => scrollTo(activeIndex + 1)}
						/>
					{:else}
						<VideoCard
							{item}
							active={i === activeIndex}
							{viewportAR}
							posters={settings.posters}
							revealed={revealedByName[item.name] ?? false}
							buffering={i === activeIndex && activeBuffering}
							blocked={i === activeIndex && activeBlocked}
							paused={i === activeIndex && activeShowPlay}
							currentTime={i === activeIndex ? activeCurrentTime : 0}
							duration={i === activeIndex ? activeDuration : 0}
							onslot={(el) => registerSlot(item.name, el)}
							onseek={seekActiveFrac}
							onseekby={seekActiveBy}
							ontap={onTapGesture}
						/>
					{/if}
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
		showStarred={settings.starred}
		starred={activeItem ? starredSet.has(activeItem.name) : false}
		onmute={toggleMute}
		onautoadvance={toggleAutoAdvance}
		onstar={onRailStar}
		onopenliked={likedView ? undefined : () => goto(resolve('/liked'))}
		onshare={() => share(activeItem)}
		oninfo={toggleInfo}
		onhide={() => hide(activeItem?.name)}
	/>
	{#if likedView}
		<!-- Favorites view (0.9.0): a persistent "♥ Favorites" header chip beside the back chevron
		     (operator's mock "‹ ♥ Favorites") so you always know where you are. Decorative —
		     pointer-events:none, the back chevron stays the control. -->
		<div class="fav-header" aria-hidden="true">
			<Heart size={16} color="#ff2d55" fill="#ff2d55" />
			<span>Favorites</span>
		</div>
		<!-- Back chevron to the main feed. A real <a> so it's keyboard-accessible + SvelteKit
		     client-navigates. -->
		<a class="back-chip" href={resolve('/')} aria-label="Back to feed">
			<ChevronLeft size={26} aria-hidden="true" />
		</a>
	{/if}
	{#if bursting}
		{#key burstTick}
			<div class="burst" aria-hidden="true"><Heart size={96} fill="currentColor" /></div>
		{/key}
	{/if}
	{#each hearts as h (h.id)}
		<div class="tap-heart" style:left="{h.x}px" style:top="{h.y}px" aria-hidden="true">
			<Heart size={52} fill="currentColor" />
		</div>
	{/each}
	{#if infoOpen && activeItem}
		{@const infoSize = activeItem.size ?? sizeByName[activeItem.name]}
		<div class="info-overlay">
			<button class="info-name" onclick={() => copyId(activeItem.name)} title="Copy ID">
				<span class="info-id">{activeItem.name}</span>
				<Copy size={13} aria-hidden="true" />
			</button>
			<p class="info-meta">
				{infoSize != null ? `${formatBytes(infoSize)} · ` : ''}{activeItem.type}
			</p>
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

	/* Double-tap-to-favorite burst (0.8.0): a centered heart that pops + fades, TikTok-
	   style. Fixed + pointer-events:none so it floats over the active card without
	   intercepting taps; only shown on star-ON, and skipped entirely under
	   prefers-reduced-motion (triggerBurst returns early). The {#key} remount replays the
	   animation on a rapid repeat. */
	.burst {
		position: fixed;
		inset: 0;
		z-index: 11;
		display: flex;
		align-items: center;
		justify-content: center;
		color: #ff2d55;
		pointer-events: none;
		filter: drop-shadow(0 2px 16px rgba(0, 0, 0, 0.5));
		animation: burst 0.65s ease-out forwards;
	}

	@keyframes burst {
		0% {
			transform: scale(0.4);
			opacity: 0;
		}
		25% {
			transform: scale(1.15);
			opacity: 0.95;
		}
		55% {
			transform: scale(1);
			opacity: 0.9;
		}
		100% {
			transform: scale(1.05);
			opacity: 0;
		}
	}

	/* Tap-point hearts (0.8.0 M6): one per rapid tap in a double/spam sequence, placed at the
	   tap coordinates (fixed; translate-centered) and floated up as it fades. Fixed + pointer-
	   events:none so it never intercepts taps; reduced-motion suppresses spawning. */
	.tap-heart {
		position: fixed;
		z-index: 11;
		color: #ff2d55;
		pointer-events: none;
		filter: drop-shadow(0 2px 10px rgba(0, 0, 0, 0.45));
		animation: tap-heart 0.8s ease-out forwards;
	}

	@keyframes tap-heart {
		0% {
			transform: translate(-50%, -50%) scale(0.3) rotate(-8deg);
			opacity: 0;
		}
		20% {
			transform: translate(-50%, -50%) scale(1.1) rotate(-8deg);
			opacity: 0.95;
		}
		100% {
			transform: translate(-50%, -90%) scale(0.95) rotate(-8deg);
			opacity: 0;
		}
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
		/* Frosted glass (0.8.0): match the rail icon-chrome — translucent fill + a stronger
		   backdrop blur (with saturation for the glass look) + a hairline border + a soft lift
		   shadow off the video. (Was a flatter rgba(0,0,0,0.7) + blur(8px).) */
		background: rgba(0, 0, 0, 0.45);
		border: 1px solid rgba(255, 255, 255, 0.18);
		border-radius: 999px;
		backdrop-filter: blur(16px) saturate(140%);
		box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
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

	/* Favorites view (0.9.0): a persistent "♥ Favorites" header chip beside the back chevron,
	   matching the rail/back chrome. Decorative (pointer-events:none); the chevron is the control. */
	.fav-header {
		position: fixed;
		top: calc(env(safe-area-inset-top) + 0.75rem);
		left: calc(env(safe-area-inset-left) + 4rem);
		z-index: 20;
		display: flex;
		align-items: center;
		gap: 0.4rem;
		height: 2.75rem;
		padding: 0 0.9rem;
		color: #fff;
		background: rgba(0, 0, 0, 0.4);
		border: 1px solid rgba(255, 255, 255, 0.15);
		border-radius: 999px;
		backdrop-filter: blur(8px);
		pointer-events: none;
		font-size: 0.9rem;
		font-weight: 600;
	}
	/* Favorites-view back chevron (0.9.0): a frosted circle top-left, matching the rail chrome. */
	.back-chip {
		position: fixed;
		top: calc(env(safe-area-inset-top) + 0.75rem);
		left: calc(env(safe-area-inset-left) + 0.75rem);
		z-index: 20;
		display: flex;
		align-items: center;
		justify-content: center;
		width: 2.75rem;
		height: 2.75rem;
		color: #fff;
		background: rgba(0, 0, 0, 0.4);
		border: 1px solid rgba(255, 255, 255, 0.15);
		border-radius: 50%;
		backdrop-filter: blur(8px);
	}
	.back-chip:active {
		transform: scale(0.92);
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
		/* Frosted glass (0.8.0): match the rail icon-chrome — translucent fill + a stronger
		   backdrop blur (with saturation for the glass look) + a hairline border + a soft lift
		   shadow off the video. (Was a flatter rgba(0,0,0,0.7) + blur(8px).) */
		background: rgba(0, 0, 0, 0.45);
		border: 1px solid rgba(255, 255, 255, 0.18);
		border-radius: 999px;
		backdrop-filter: blur(16px) saturate(140%);
		box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
		font-size: 0.9rem;
	}
</style>
