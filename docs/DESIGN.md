# Design system

forya is a full-screen, dark, media-first feed. The media is the interface; chrome is a
thin layer of translucent "glass" controls floating over it. Every value below comes from
the current CSS (`src/app.css` and the component `<style>` blocks). There are no CSS custom
properties yet, so these values are repeated literally in each component; reuse them
exactly.

## Principles

- **Media first.** Each card fills the screen (`100svh` then `100dvh`). Controls sit at the
  edges, inset by the safe area, and never cover the middle of the frame.
- **Glass over black.** Controls are translucent black with a backdrop blur and a white
  hairline border, so they read on any frame.
- **Quiet until touched.** No persistent labels on the rail. Toasts, the info overlay and
  the hover volume slider appear only when asked for.
- **Touch first.** Targets are at least 2.75rem. Gestures (double-tap to like, long-press,
  hold to speed up) suppress iOS callouts, tap highlight and double-tap zoom.

## Color

| Token       | Value                                                            | Use                                                             |
| ----------- | ---------------------------------------------------------------- | --------------------------------------------------------------- |
| background  | `#000`                                                           | Page, cards, media letterbox. `theme-color` and PWA background. |
| foreground  | `#fff`                                                           | All text and icons.                                             |
| like        | `#ff2d55`                                                        | Filled heart on the rail, like burst, tap hearts, header heart. |
| placeholder | `linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%)` | Card shown before media paints.                                 |
| debug text  | `#9effa0`                                                        | `DEBUG_PLAYBACK` overlay only.                                  |

Translucent layers (always black or white with alpha):

| Layer           | Value                                 | Use                                                         |
| --------------- | ------------------------------------- | ----------------------------------------------------------- |
| glass, light    | `rgba(0, 0, 0, 0.35)`                 | Gallery prev/next arrows.                                   |
| glass           | `rgba(0, 0, 0, 0.4)`                  | Rail buttons, back chip, favorites header.                  |
| glass, toast    | `rgba(0, 0, 0, 0.45)`                 | Toasts, gallery counter, audio chip.                        |
| glass, dense    | `rgba(0, 0, 0, 0.55)`                 | Info overlay, volume slider.                                |
| hairline        | `rgba(255, 255, 255, 0.15)`           | Border on rail buttons, chips, volume slider.               |
| hairline, toast | `rgba(255, 255, 255, 0.18)`           | Border on toasts.                                           |
| button fill     | `rgba(255, 255, 255, 0.12)` to `0.15` | Pill buttons inside dark surfaces ("Back to feed", "Undo"). |
| track           | `rgba(255, 255, 255, 0.25)`           | Seek track, spinner ring.                                   |
| active toggle   | `rgba(255, 255, 255, 0.85)`           | Rail button in its "on" state, with `#000` icon.            |

Text de-emphasis uses `opacity`, not grey colors: `0.85` (status text), `0.7` (hints),
`0.65` (meta), `0.55` (captions), `0.5` (empty-feed hint).

## Typography

- Family: the system stack,
  `-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif`,
  with `-webkit-font-smoothing: antialiased`. No web fonts.
- Monospace (debug only): `ui-monospace, monospace`.
- Weights: 400 body, 600 for titles, labels, toast buttons and the counter.

| Size      | Use                                            |
| --------- | ---------------------------------------------- |
| `1.1rem`  | Empty-state title.                             |
| `0.95rem` | Warming status text.                           |
| `0.9rem`  | Toasts, pill buttons, favorites header, hints. |
| `0.85rem` | Captions, info overlay title, empty-feed hint. |
| `0.8rem`  | Gallery counter.                               |
| `0.75rem` | Info overlay meta line.                        |

## Spacing

Rem-based. The common steps are `0.25`, `0.35`, `0.5`, `0.75`, `1`, `1.5rem`.

- Edge inset for floating chrome: `calc(env(safe-area-inset-<side>) + 0.75rem)`.
- Rail: `gap: 1rem`, bottom inset `4.5rem` above the safe area.
- Full-screen states and card captions: `padding: 1.5rem`.
- Toast padding: `0.5rem 1rem`.

## Radius

| Value    | Use                                                         |
| -------- | ----------------------------------------------------------- |
| `50%`    | Round icon buttons (rail, back chip, gallery arrows), dots. |
| `999px`  | Pills: toasts, pill buttons, chips, counter, seek track.    |
| `0.5rem` | Info overlay card.                                          |

## Elevation and blur

- `backdrop-filter: blur(8px)` on standard glass; `blur(6px)` on gallery arrows.
- Toasts: `backdrop-filter: blur(16px) saturate(140%)` plus
  `box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3)`.
- Letterbox fill behind contained media: the poster at `object-fit: cover`,
  `transform: scale(1.15)`, `filter: blur(28px) brightness(0.6)`.
- Floating glyphs (play hint, hearts, dots) use `text-shadow` or `drop-shadow` in black
  at `0.45` to `0.6` alpha instead of a background.

Stacking: card tap target `1`, play hint and spinner `2`, seek bar and gallery overlays
`3`, gallery arrows `4`, info overlay `9`, rail `10`, like animations `11`, toasts and
favorites chrome `20`, debug overlay `50`.

## Components

**Rail button** (`ActionRail.svelte`). `2.75rem` circle, glass background, hairline border,
`blur(8px)`, 24px Lucide icon in white. `:active` scales to `0.92`. "On" state flips to
`rgba(255, 255, 255, 0.85)` with a black icon. A liked heart turns `#ff2d55` and fills.
Order top to bottom: volume, like, autoplay next, share, save, info, hide (hide only when
enabled).

**Back chip and favorites header** (`Feed.svelte`, `/liked`). Same glass circle as the
rail at top left. The header is a `2.75rem`-tall glass pill beside it with a 16px red heart
and "Favorites" at `0.9rem`/600.

**Toast** (`.undo-toast`, `.mode-toast`). Centered pill near the bottom, toast glass,
`role="status"`. An action inside a toast is a nested pill button (`rgba(255, 255, 255,
0.15)`, 600 weight, 16px icon, `:active` scale `0.95`).

**Info overlay.** Bottom-left card, dense glass, `0.5rem` radius, max width `70vw`. Title
is the item ID with a 13px copy icon; meta line is `size · type`.

**Seek bar** (`VideoCard.svelte`). A `1.75rem` invisible touch strip at the bottom edge
holding a `3px` pill track at `0.25` white with a `0.9` white fill.

**Play hint.** Centered 64px filled Lucide `Play` at `0.85` white with a soft shadow,
shown while paused. Never intercepts taps.

**Gallery** (`ImageCarousel.svelte`). Horizontal track with a `0.3s ease` snap. Prev/next
are `2.25rem` light-glass circles at mid-height, hidden at the ends. Position shows as 6px
dots (`0.45` white, active `0.98` white scaled `1.35`), switching to an `N / M` counter
pill for larger galleries. A `1.9rem` audio chip sits bottom-left, half opacity until
sound plays.

**Spinner.** `3px` ring at `0.25` white with a white top, `0.8s linear` rotation, `2.25rem`
on full-screen states and `2.5rem` on a card.

**Full-screen states.** Black, centered column, `1.5rem` padding, `gap` `0.75rem` to
`1rem`. Pattern: spinner or title, one hint line, optional pill link.

- Warming: spinner plus "Warming up {feed}…".
- Empty feed: "No videos yet." plus the supported file types.
- Empty favorites: "No favorites yet", "Double-tap a clip, or tap the ♥, to add it.", and a
  "Back to feed" pill (`rgba(255, 255, 255, 0.12)`, `0.2` hairline).

There are no forms, tables or nav bars. The only input is the native range used for
volume, stood vertical with `writing-mode: vertical-lr` and shown only on hover-capable
devices.

## Focus and accessibility

- Global keyboard ring: `:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }`.
- Round controls replace it with a ring that follows the radius:
  `box-shadow: 0 0 0 2px #000, 0 0 0 4px #fff`.
- Full-bleed targets inset the ring (`outline-offset: -4px`) so it is not clipped.
- Icon-only buttons have an `aria-label` phrased as the action ("Add to favorites",
  "Hide this video from the feed"). Icons inside labeled controls are `aria-hidden`.
- Status messages use `role="status"`; the warming screen adds `aria-live="polite"`.

## Motion

| Duration and easing | Use                                                 |
| ------------------- | --------------------------------------------------- |
| `0.15s ease`        | Volume slider reveal.                               |
| `0.2s ease`         | Poster fade-in, dot and audio-chip state.           |
| `0.25s ease`        | Poster-to-video cross-fade, letterbox fill fade-in. |
| `0.3s ease`         | Gallery snap.                                       |
| `0.65s ease-out`    | Like burst (scale 0.4 to 1.15 to 1, fade out).      |
| `0.8s ease-out`     | Tap heart (pops at the tap point and floats up).    |
| `0.8s linear`       | Spinner rotation.                                   |

Press feedback is a scale: `0.92` on round buttons, `0.95` on pill buttons. Live drags
track the finger 1:1 with no transition. Under `prefers-reduced-motion: reduce`, a global
rule drops all transitions and animations to near zero, snap scrolling stops smoothing,
and the like animations do not spawn.

## Iconography

- Lucide only, via per-icon imports (`@lucide/svelte/icons/<name>`), drawn in
  `currentColor`.
- Sizes: 24px on the rail, 16px inside pills and chips, 13 to 14px inline, 26px for the
  back chevron, 64px play hint, 96px like burst, 52px tap heart.
- Filled icons (`fill="currentColor"`) mean "active" or "this is a big glyph": the liked
  heart, play hint and hearts. Everything else is outline.

## Copy voice

- Short, plain, sentence case. Lead with what happened or what to do.
- Status: "Warming up {feed}…", "Hidden", "Autoplay next: on", "Loop: on", "Copied ID ✓".
- Actions are one or two words: "Undo", "Back to feed".
- Empty states say what is missing, then the one thing that fixes it.
- No exclamation marks, no emoji beyond the single heart and check glyphs already in use.

## Name and logo

- The product name is **forya**, always lowercase.
- The UI never shows "forya". Each instance is branded by `FEED_NAME` (default `feed`):
  page title, PWA name, home-screen title and the warming text. Never hardcode a name in
  the UI.
- App icon (`static/icon.svg`, PNGs at 192, 512 and the Apple touch icon): a stack of
  three tilted rounded "phone cards" on a deep purple diagonal gradient (`#161531`,
  `#241A48`, `#3A2168`), the front card `#eeebf5` with a script "f" in a violet gradient
  (`#5B21B6` to `#7C3AED`). Icons are declared `any maskable`.
- The purple palette lives only in the icon. The app itself is black and white.

## Known drift

1. The spinner is defined three times (`+page.svelte`, `liked/+page.svelte`,
   `VideoCard.svelte`) with different sizes, top colors (`#fff` vs `0.9` white) and
   keyframe names.
2. The placeholder gradient is duplicated in `VideoCard.svelte` and `Feed.svelte`, and its
   navy palette does not match the purple brand icon.
3. Glass surfaces vary without a clear rule: alpha `0.35` / `0.4` / `0.45` / `0.55`, blur
   `6px` / `8px` / `16px`, and some have a hairline border while the counter, audio chip and
   arrows do not.
4. The round focus ring is only on the rail buttons and the volume slider. The back chip,
   gallery arrows and pill buttons fall back to the square global outline.
5. Text glyphs stand in for Lucide icons in three places: `‹` `›` on gallery arrows, `✓` in
   the copy toast, `♥` in the empty-favorites hint.
6. The empty-feed state sets `height: 100dvh` with no `100svh` fallback, unlike the feed
   and cards.
7. `src/lib/assets/favicon.svg` is the stock framework logo and is not referenced anywhere.
8. Six body font sizes between `0.75rem` and `1.1rem` with no defined scale.
9. No CSS custom properties: every color, radius and blur is a literal repeated per
   component, and the like red is also passed inline as an icon prop.
10. The icon's "f" is set in a script font (Lobster) inside the SVG. Only the pre-rendered
    PNGs are guaranteed to show it; the SVG renders a fallback font where Lobster is not
    installed.
