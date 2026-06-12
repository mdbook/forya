import type { RequestHandler } from './$types';
import { config } from '$lib/server/config';

// Templated PWA manifest (SPEC §4): FEED_NAME is injected so each of the three
// homelab instances brands its add-to-home-screen name distinctly. standalone +
// portrait so it launches like a native app.
export const GET: RequestHandler = () => {
	const manifest = {
		name: config.feedName,
		short_name: config.feedName,
		start_url: '/',
		display: 'standalone',
		orientation: 'portrait',
		background_color: '#000000',
		theme_color: '#000000',
		icons: [
			{ src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
			{ src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' }
		]
	};

	return new Response(JSON.stringify(manifest), {
		headers: {
			'content-type': 'application/manifest+json',
			'cache-control': 'no-cache'
		}
	});
};
