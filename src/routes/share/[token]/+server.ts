import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { config } from '$lib/server/config';
import { safeMediaPath } from '$lib/server/videos';
import { resolveShare } from '$lib/server/share';

// GET /share/<token> — UNAUTH (the hub Caddy bypasses forward-auth for `/share/*` ONLY) — a
// minimal STANDALONE player for the ONE clip the token authorizes. CURE-IRRELEVANT by
// construction: a plain `<video controls playsinline>`, NO pool/gesture/bless/Feed import, so
// it can never do an ungestured unmuted `play()` — it lives entirely outside the feed's sound-on
// cure machine. Uniform 404 for ANY miss (unknown/revoked/disabled token, or a name that fails
// `safeMediaPath`) — no existence oracle. The token IS the capability, so `Referrer-Policy:
// no-referrer` keeps it out of the `Referer` header on outbound requests, and the page is
// `no-store`. Rendered server-side (no SvelteKit client app, no token in any logged feed URL).

function page(token: string): string {
	// `token` resolved to a real stored record, so it is a base64url string ([A-Za-z0-9_-]) —
	// no HTML-special chars. Embedded only into the media URL path.
	const media = `/share/${token}/media`;
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<meta name="referrer" content="no-referrer" />
<title>Shared clip</title>
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

export const GET: RequestHandler = async ({ params }) => {
	const resolved = await resolveShare(params.token, config.dataDir);
	// defense-in-depth: the token may resolve, but the name STILL goes through safeMediaPath
	// (never trust the stored payload as a path) before we reference it.
	if (!resolved || safeMediaPath(resolved.name, config.videoDir) === null) error(404, 'not found');

	return new Response(page(params.token), {
		headers: {
			'content-type': 'text/html; charset=utf-8',
			'referrer-policy': 'no-referrer',
			'cache-control': 'private, no-store'
		}
	});
};
