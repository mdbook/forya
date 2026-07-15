// Share-link store (0.8.4, scheme B — STORED capability tokens). Operator-chosen over
// scheme A (stateless HMAC) because B gives PROPER per-link revoke AND durable links: a
// rotated HMAC secret either breaks live links or leaves rotated-but-still-valid tokens
// (improper revoke) — the rotation trilemma (stateless / rotate-without-breaking /
// proper-revoke = pick two). With a store there is NO signing secret: a token is an
// unguessable CSPRNG random, revoke = delete the row, revoke-all = clear the file.
//
// The store is a faithful mirror of `hidden.ts`/`starred.ts`: `share.json` under
// `DATA_DIR` (atomic tmp+rename, serialized write-queue, in-memory cache, env-gated so
// it's zero-fs + no-op when `DATA_DIR` is unset, never throws). Liked-only by deploy.
//
// OWNERSHIP SCAFFOLD (0.8.4): every record carries an `owner` (the `__shared__` sentinel
// today; per-user OIDC subject at 1.0 via the `currentOwner` seam). Dedup + reads are
// owner-scoped already, so flipping to per-user is a seam change, not a schema rewrite.
//
// SECURITY (review HARD-gate):
//  - Token = `crypto.randomBytes(32)` (256-bit) base64url — unguessable; no secret to leak.
//  - `resolveShare` is a LOOKUP that returns null for ANY miss (unknown / disabled) so the
//    route answers ONE uniform 404 (no existence oracle). The caller MUST STILL
//    `safeMediaPath` the resolved name (defense-in-depth) and the byte route lstat-rejects
//    symlinks — the `/share/<token>/media` path is UNAUTH.
//  - ZERO feed / cheap-scan contact: this store never touches `getFeed`/the scan.
//  - Versioned (`{version:1,…}`) with migrate-on-read, so a future per-user envelope is
//    automatic, not a flag-day.
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { config } from './config';
import { SHARED_OWNER } from './owner';

const SHARE_FILE = 'share.json';
const SHARE_VERSION = 1;

/** One persisted share: an unguessable token mapping to exactly one clip name, owned by
 *  `owner` (the shared sentinel today). `created` is for a future "my shares" / expiry. */
export interface ShareRecord {
	token: string;
	name: string;
	owner: string;
	created: number;
}

/** Feature on? Keys SOLELY on the (env-derived) volume — never on fs state. */
export function shareEnabled(dataDir: string = config.dataDir): boolean {
	return dataDir !== '';
}

/**
 * Full-carousel share (image galleries): pick which frame `/share/<token>/media?f=<frame>` may
 * serve, from the token's OWN gallery `mediaNames` (the manifest allowlist). PURE + the I2 guard
 * on the unauth surface: `frame` must be EXACTLY one of the token's own frames (Set membership,
 * fail-closed → null), so a token for gallery X can never serve Y's frames or `?f=../..` traverse
 * (the null propagates to a 404 before any fs touch; the picked name STILL passes
 * `safeMediaPath`/lstat in `serve()` — defence in depth). No `?f` → the cover frame (frame 1).
 * Returns the frame name to serve, or null to reject (404). Empty gallery → null.
 */
export function pickGalleryFrame(mediaNames: string[], frame: string | null): string | null {
	if (frame === null) return mediaNames[0] ?? null; // no ?f → cover
	return mediaNames.includes(frame) ? frame : null; // allowlisted to THIS gallery's frames
}

/** Resolve `share.json` under `dataDir`, or null when disabled. The token/name live INSIDE
 *  the doc, never in the path → no traversal vector here (the API still safeMediaPath-guards
 *  the resolved name). Asserted to stay directly under `dataDir` (defence in depth). */
export function sharePath(dataDir: string): string | null {
	if (dataDir === '') return null;
	const dir = path.resolve(dataDir);
	const full = path.join(dir, SHARE_FILE);
	if (path.dirname(full) !== dir) return null;
	return full;
}

// In-memory cache: the records keyed by token (resolve) + a (owner,name)→token index
// (dedup). Keyed by the dataDir it was loaded from (one container = one dataDir).
type Store = { byToken: Map<string, ShareRecord>; byKey: Map<string, string> };
let cache: { dir: string; store: Store } | null = null;
let writeChain: Promise<unknown> = Promise.resolve();
let tmpSeq = 0;

/** (owner,name) dedup key — NUL-separated so it's unambiguous for any name. */
function dedupKey(owner: string, name: string): string {
	return `${owner}\0${name}`;
}

/** Test seam: drop the in-memory cache + reset the write queue. */
export function clearShareCache(): void {
	cache = null;
	writeChain = Promise.resolve();
}

/** Pure: parse OUR stored share JSON → records, tolerating shape drift (migrate-on-read).
 *  Unknown/older `version` → best-effort: we read the `shares` array if present, dropping
 *  malformed rows. A future enveloped schema adds its branch here; v1 is the identity. */
function parseShares(json: string): ShareRecord[] {
	let data: unknown;
	try {
		data = JSON.parse(json);
	} catch {
		return [];
	}
	if (!data || typeof data !== 'object') return [];
	const arr = (data as { shares?: unknown }).shares;
	if (!Array.isArray(arr)) return [];
	const out: ShareRecord[] = [];
	for (const r of arr) {
		if (!r || typeof r !== 'object') continue;
		const { token, name, owner, created } = r as Record<string, unknown>;
		if (typeof token !== 'string' || typeof name !== 'string') continue;
		out.push({
			token,
			name,
			owner: typeof owner === 'string' ? owner : SHARED_OWNER, // migrate: pre-owner rows → shared
			created: typeof created === 'number' ? created : 0
		});
	}
	return out;
}

function buildStore(records: ShareRecord[]): Store {
	const byToken = new Map<string, ShareRecord>();
	const byKey = new Map<string, string>();
	for (const r of records) {
		byToken.set(r.token, r);
		byKey.set(dedupKey(r.owner, r.name), r.token); // last write wins on a dup (harmless)
	}
	return { byToken, byKey };
}

/** Load the store (from the in-mem cache or disk). Empty when disabled or missing/corrupt.
 *  Never throws; ZERO fs when disabled. Compare-and-set on the cache (adversarial #4): a
 *  concurrent write may have populated a fresher store while we awaited the read — never
 *  clobber it with our stale disk snapshot. */
async function loadStore(dataDir: string): Promise<Store> {
	if (dataDir === '') return { byToken: new Map(), byKey: new Map() };
	if (cache && cache.dir === dataDir) return cache.store;
	const full = sharePath(dataDir);
	if (!full) return { byToken: new Map(), byKey: new Map() };
	let store: Store;
	try {
		store = buildStore(parseShares(await fsp.readFile(full, 'utf8')));
	} catch {
		store = { byToken: new Map(), byKey: new Map() };
	}
	if (cache && cache.dir === dataDir) return cache.store; // a write won the race — adopt it
	cache = { dir: dataDir, store };
	return store;
}

/** Atomically write the store (tmp + rename). No-op when disabled; never throws; writes
 *  ONLY under `dataDir`. Versioned envelope from day one (migrate-on-read reads it back). */
async function persist(dataDir: string, store: Store): Promise<void> {
	const full = sharePath(dataDir);
	if (!full) return;
	const shares = [...store.byToken.values()].sort((a, b) => a.token.localeCompare(b.token));
	const body = JSON.stringify({ version: SHARE_VERSION, shares });
	const tmp = `${full}.tmp.${process.pid}.${tmpSeq++}`;
	try {
		await fsp.mkdir(path.dirname(full), { recursive: true });
		await fsp.writeFile(tmp, body);
		await fsp.rename(tmp, full);
	} catch {
		try {
			await fsp.rm(tmp, { force: true });
		} catch {
			/* ignore */
		}
	}
}

/** Populate the cache from disk once (best-effort) at boot. No-op + ZERO fs when disabled. */
export async function warmShare(dataDir: string = config.dataDir): Promise<void> {
	if (dataDir === '') return;
	if (cache && cache.dir === dataDir) return;
	await loadStore(dataDir);
}

/** A fresh unguessable token: 256-bit CSPRNG, base64url. Retries on the (astronomically
 *  improbable) collision so a token is never reused for two clips. */
function freshToken(store: Store): string {
	let token = crypto.randomBytes(32).toString('base64url');
	while (store.byToken.has(token)) token = crypto.randomBytes(32).toString('base64url');
	return token;
}

/**
 * Mint (or reuse) a share token for `(name, owner)`. Idempotent per (owner,name): a repeat
 * mint returns the SAME token (durable, dedup'd link). The caller MUST `safeMediaPath`
 * `name` FIRST — this store does no validation. Returns '' when disabled. Serialized
 * through the write-queue. Never throws.
 */
export async function mintShare(
	name: string,
	owner: string = SHARED_OWNER,
	dataDir: string = config.dataDir
): Promise<string> {
	if (dataDir === '') return '';
	const run = writeChain.then(async () => {
		const store = await loadStore(dataDir);
		const key = dedupKey(owner, name);
		const existing = store.byKey.get(key);
		if (existing && store.byToken.has(existing)) return existing; // durable dedup
		const token = freshToken(store);
		const rec: ShareRecord = { token, name, owner, created: Date.now() };
		store.byToken.set(token, rec);
		store.byKey.set(key, token);
		await persist(dataDir, store);
		cache = { dir: dataDir, store };
		return token;
	});
	writeChain = run.catch(() => {});
	return run;
}

/**
 * Resolve a token → its `{ name, owner }`, or `null` for ANY miss (unknown token or
 * disabled feature). Owner-agnostic by design — a token opens its clip regardless of who
 * clicks the link. The caller MUST still `safeMediaPath(name)` (defense-in-depth) and the
 * byte route lstat-rejects symlinks. Never throws.
 */
export async function resolveShare(
	token: string,
	dataDir: string = config.dataDir
): Promise<{ name: string; owner: string } | null> {
	if (dataDir === '' || token === '') return null;
	const store = await loadStore(dataDir);
	const rec = store.byToken.get(token);
	return rec ? { name: rec.name, owner: rec.owner } : null;
}

/**
 * Revoke ONE share by token (delete the row → the link 404s immediately, properly). Returns
 * true if a row was removed. Serialized through the write-queue; no-op false when disabled.
 */
export async function revokeShare(
	token: string,
	dataDir: string = config.dataDir
): Promise<boolean> {
	if (dataDir === '') return false;
	const run = writeChain.then(async () => {
		const store = await loadStore(dataDir);
		const rec = store.byToken.get(token);
		if (!rec) return false;
		store.byToken.delete(token);
		store.byKey.delete(dedupKey(rec.owner, rec.name));
		await persist(dataDir, store);
		cache = { dir: dataDir, store };
		return true;
	});
	writeChain = run.catch(() => {});
	return run;
}

/** The shares owned by `owner` (for a future "my shares" view). Sorted by `created`. ZERO
 *  fs when disabled; never throws. */
export async function readShares(
	owner: string = SHARED_OWNER,
	dataDir: string = config.dataDir
): Promise<ShareRecord[]> {
	if (dataDir === '') return [];
	const store = await loadStore(dataDir);
	return [...store.byToken.values()]
		.filter((r) => r.owner === owner)
		.sort((a, b) => a.created - b.created);
}
