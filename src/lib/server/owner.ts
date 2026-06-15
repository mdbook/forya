// Ownership seam (0.8.4 scaffold) — the SINGLE place identity is resolved for the
// per-store `owner` dimension (share / hidden / starred). Today every record is owned
// by the shared sentinel; at 1.0 (operator plans OIDC) this becomes the authenticated
// subject and the stores filter by it — with NO schema rewrite, because the `owner`
// field already exists on every record.
//
// IMPORTANT: this is a SCAFFOLD. There is NO per-user logic yet — `currentOwner` returns
// the sentinel unconditionally, so behaviour is identical to a single shared library.
// The point is that every store API already THREADS an `owner` arg and every call site
// already passes one, so flipping to per-user is a one-function change here, not a
// cross-codebase refactor.
import type { RequestEvent } from '@sveltejs/kit';

/** The sentinel owner for the single-tenant (pre-OIDC) world. Every record is owned by
 *  this until 1.0 wires real identity. Chosen to never collide with a real subject id. */
export const SHARED_OWNER = '__shared__';

/**
 * Resolve the owner for a request. TODAY: always the shared sentinel (single library).
 * AT 1.0: return the OIDC subject. The hub forward-auth already injects
 * `X-Authentik-Uid` / `X-Authentik-Username` on AUTHED paths, so the real identity is
 * available for the authed mint path even before in-app OIDC — when we choose to flip,
 * read it here. The UNAUTH `/share/<token>` view never calls this (it's owner-agnostic:
 * a token resolves to its record regardless of who opens the link).
 *
 * `event` is accepted now (so call sites are already shaped correctly) even though it's
 * unused until the flip.
 */
export function currentOwner(event: RequestEvent): string {
	void event; // shaped for 1.0; unused until the OIDC flip reads identity off it
	// 1.0: `return event.request.headers.get('x-authentik-uid') || SHARED_OWNER;`
	return SHARED_OWNER;
}
