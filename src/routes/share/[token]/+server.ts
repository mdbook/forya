import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { config } from '$lib/server/config';
import { getFeed, isVideoFile, safeMediaPath } from '$lib/server/videos';
import { resolveShare } from '$lib/server/share';

// GET /share/<token> — UNAUTH (the hub bypasses forward-auth for `/share/*` ONLY) — a minimal
// STANDALONE player for the ONE clip the token authorizes. CURE-IRRELEVANT by construction: a
// plain `<video controls playsinline>`, NO pool/gesture/bless/Feed import, so it can never do an
// ungestured unmuted `play()` — it lives entirely outside the feed's sound-on cure machine.
// Uniform 404 for ANY miss (unknown/revoked/disabled token, or a name that fails `safeMediaPath`)
// — no existence oracle. The token IS the capability, so `Referrer-Policy: no-referrer` keeps it
// out of the `Referer` header on outbound requests, and the page is `no-store`. Rendered
// server-side (no SvelteKit client app, no token in any logged feed URL).
//
// 0.8.4 polish: Open Graph / Twitter rich-link meta (the TikTok/YouTube model). Without it iOS
// LinkPresentation fetched this page, found the dominant resource was the `<video>`, and offered
// the raw .mp4 FILE instead of the link. og:image (the cached poster, served unauth at the
// sibling `/share/<token>/poster`) is the linchpin that flips iOS to a playable LINK CARD. All
// og:* URLs are absolute (LinkPresentation requires it) and point under the `^/share/` bypass so
// the UNAUTHENTICATED iOS crawler can fetch them; the poster route at /api/poster is gated and
// thus unreachable to that crawler — hence the dedicated bypassed poster route.

// HTML-attribute escape — defense-in-depth on this unauth surface. The token is base64url
// ([A-Za-z0-9_-], no HTML-special chars) and `base` is a URL origin, so in practice neither
// carries `&"<>`; escaping anyway keeps the meta attributes bulletproof against any reflected base.
const enc = (s: string): string =>
	s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function page(token: string, base: string): string {
	const media = `/share/${token}/media`; // same-origin relative for the in-page <video>
	const shareUrl = enc(`${base}/share/${token}`); // absolute canonical link (og:url)
	const posterUrl = enc(`${base}/share/${token}/poster`); // absolute, unauth via the bypass
	const videoUrl = enc(`${base}${media}`);
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<meta name="referrer" content="no-referrer" />
<title>forya — shared clip</title>
<meta property="og:type" content="video.other" />
<meta property="og:site_name" content="forya" />
<meta property="og:title" content="forya — shared clip" />
<meta property="og:description" content="A clip shared from forya." />
<meta property="og:url" content="${shareUrl}" />
<meta property="og:image" content="${posterUrl}" />
<meta property="og:video" content="${videoUrl}" />
<meta property="og:video:secure_url" content="${videoUrl}" />
<meta property="og:video:type" content="video/mp4" />
<meta name="twitter:card" content="summary_large_image" />
<style>
  html,body{margin:0;height:100%;background:#000;}
  body{display:flex;align-items:center;justify-content:center;}
  video{max-width:100%;max-height:100dvh;width:auto;height:auto;background:#000;}
</style>
</head>
<body>
<video controls playsinline preload="metadata" src="${enc(media)}"></video>
</body>
</html>`;
}

// Image-gallery share page (full-carousel, AC-5). A JS-FREE horizontal CSS scroll-snap rail of the
// gallery's frames — the recipient swipes through ALL images, no player, no cure machine, nothing
// to autoplay (bulletproof on the unauth surface, same ethos as the <video> page). Each frame is
// served token-scoped via `?f=<frame>` (validated against this gallery's own media[] in the media
// route). og:image = the cover frame (no `?f` → cover), so iOS renders a rich link CARD.
function galleryPage(token: string, base: string, frameNames: string[]): string {
	const shareUrl = enc(`${base}/share/${token}`);
	const coverUrl = enc(`${base}/share/${token}/media`); // no ?f → cover frame, clean OG image
	const n = frameNames.length;
	const imgs = frameNames
		.map((name, i) => {
			const src = enc(`/share/${token}/media?f=${encodeURIComponent(name)}`);
			return `<img src="${src}" alt="Photo ${i + 1} of ${n}" loading="${i === 0 ? 'eager' : 'lazy'}" draggable="false" />`;
		})
		.join('\n');
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<meta name="referrer" content="no-referrer" />
<title>forya — shared gallery</title>
<meta property="og:type" content="website" />
<meta property="og:site_name" content="forya" />
<meta property="og:title" content="forya — ${n}-photo gallery" />
<meta property="og:description" content="A ${n}-photo gallery shared from forya — swipe through all ${n}." />
<meta property="og:url" content="${shareUrl}" />
<meta property="og:image" content="${coverUrl}" />
<meta name="twitter:card" content="summary_large_image" />
<style>
  html,body{margin:0;height:100%;background:#000;}
  .rail{display:flex;height:100dvh;overflow-x:auto;scroll-snap-type:x mandatory;-webkit-overflow-scrolling:touch;scrollbar-width:none;scroll-padding-inline:${n > 1 ? '7vw' : '0'};}
  .rail::-webkit-scrollbar{display:none;}
  /* A MULTI-image gallery sizes each frame to 86vw so the next/prev PEEK at the edges — a clear
     JS-free "there's more, swipe" signal (a single-image gallery stays full-bleed). */
  .rail img{flex:0 0 ${n > 1 ? '86vw' : '100%'};width:${n > 1 ? '86vw' : '100%'};height:100dvh;object-fit:contain;scroll-snap-align:center;background:#000;user-select:none;-webkit-user-select:none;}
  .badge{position:fixed;top:calc(env(safe-area-inset-top) + 0.6rem);right:calc(env(safe-area-inset-right) + 0.6rem);padding:0.2rem 0.6rem;color:#fff;font:600 0.8rem system-ui,sans-serif;background:rgba(0,0,0,0.5);border-radius:999px;backdrop-filter:blur(6px);pointer-events:none;}
</style>
</head>
<body>
<div class="rail">
${imgs}
</div>
<div class="badge" aria-hidden="true">\u{1F4F7} ${n}</div>
</body>
</html>`;
}

// A gallery whose frames aren't in the warm manifest yet (cold container, ~1-2s) — a minimal
// meta-refresh page rather than a broken <video>. No OG tags (a crawler that hits it mid-warmup
// gets nothing to cache, not a wrong video card); the reload lands the real carousel once warm.
function retryPage(): string {
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta http-equiv="refresh" content="2" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<meta name="referrer" content="no-referrer" />
<title>forya — loading…</title>
<style>
  html,body{margin:0;height:100%;background:#000;color:rgba(255,255,255,0.7);font:600 0.95rem system-ui,sans-serif;}
  body{display:flex;align-items:center;justify-content:center;}
</style>
</head>
<body>Loading gallery…</body>
</html>`;
}

export const GET: RequestHandler = async (event) => {
	const { params } = event;
	const resolved = await resolveShare(params.token, config.dataDir);
	// defense-in-depth: the token may resolve, but the name STILL goes through safeMediaPath
	// (never trust the stored payload as a path) before we reference it.
	if (!resolved || safeMediaPath(resolved.name, config.videoDir) === null) error(404, 'not found');

	// Absolute base for the og:* URLs — identical construction to the mint route (incl. the
	// trailing-slash strip) so og:url EQUALS the minted share URL. PUBLIC_SHARE_BASE is the
	// canonical public origin; fall back to the request origin when it is unset (dev / no base).
	const base = (config.shareBase || event.url.origin).replace(/\/+$/, '');

	// A gallery token resolves to the bare `<id>` — look it up in the warm manifest and render the
	// full-carousel page; a video/single FILE renders the <video> player. The lookup is a zero-fs
	// in-memory read (getFeed never scans on the request path, and it kicks a background
	// revalidate). A bare id NOT in the manifest = a gallery whose frames aren't warm yet (cold
	// container ~1-2s) or a since-deleted gallery — render a meta-refresh RETRY page, NEVER the
	// <video> page (which would show a broken player + wrong og:video for a photo post; code-audit).
	const item = getFeed().items.find((i) => i.name === resolved.name);
	let html: string;
	if (item?.media && item.media.length) {
		html = galleryPage(
			params.token,
			base,
			item.media.map((m) => m.name)
		);
	} else if (isVideoFile(resolved.name)) {
		html = page(params.token, base);
	} else {
		html = retryPage();
	}

	return new Response(html, {
		headers: {
			'content-type': 'text/html; charset=utf-8',
			'referrer-policy': 'no-referrer',
			'cache-control': 'private, no-store'
		}
	});
};
