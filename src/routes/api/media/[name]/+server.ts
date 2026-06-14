import type { RequestHandler } from './$types';
import { serve } from '$lib/server/mediaServe';

// GET|HEAD /api/media/[name] — the Range-correct serving endpoint (SPEC §3).
// iOS will not play or seek without proper 206 + Content-Range + Accept-Ranges.
// The byte path (safe-resolve → lstat-guard → resolve range → stream) lives in
// `$lib/server/mediaServe` so the unauth `/share/<token>/media` route shares the
// IDENTICAL contract (incl. the 0.8.3 symlink guard); this handler is the thin
// authed wrapper. A Range request is NEVER collapsed into a full 200; HEAD mirrors
// GET (same status + headers, no body) — `curl -sI -r 0-1` → 206 (criterion 1).

export const GET: RequestHandler = ({ params, request }) =>
	serve(params.name, request.headers.get('range'), 'GET');

export const HEAD: RequestHandler = ({ params, request }) =>
	serve(params.name, request.headers.get('range'), 'HEAD');
