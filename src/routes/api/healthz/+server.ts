import type { RequestHandler } from './$types';

// Liveness probe — the compose healthcheck hits this (SPEC §3).
export const GET: RequestHandler = () =>
	new Response('ok', {
		status: 200,
		headers: { 'content-type': 'text/plain; charset=utf-8' }
	});
