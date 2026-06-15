import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { config } from '$lib/server/config';
import { safeMediaPath } from '$lib/server/videos';
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
<video controls playsinline preload="metadata" src="${media}"></video>
</body>
</html>`;
}

export const GET: RequestHandler = async (event) => {
	const { params } = event;
	const resolved = await resolveShare(params.token, config.dataDir);
	// defense-in-depth: the token may resolve, but the name STILL goes through safeMediaPath
	// (never trust the stored payload as a path) before we reference it.
	if (!resolved || safeMediaPath(resolved.name, config.videoDir) === null) error(404, 'not found');

	// Absolute base for the og:* URLs — identical construction to the mint route so og:url
	// equals the minted share URL. PUBLIC_SHARE_BASE is the canonical public origin; fall back
	// to the request origin when it is unset (dev / no public base).
	const base = config.shareBase || event.url.origin;

	return new Response(page(params.token, base), {
		headers: {
			'content-type': 'text/html; charset=utf-8',
			'referrer-policy': 'no-referrer',
			'cache-control': 'private, no-store'
		}
	});
};
