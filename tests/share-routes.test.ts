// Share ROUTE wrappers (0.8.4). In the test env `DATA_DIR` is unset → `config.dataDir === ''`
// → the share feature is OFF. These assert the load-bearing FEATURE-OFF invariant: the unauth
// `/share/*` surface (and the authed mint) HARD-404 when disabled — uniform, no oracle, no
// store touched. The ENABLED mint→resolve→bytes logic is covered by share.test.ts (the store,
// explicit dataDir) + range.test.ts (the shared `serve` incl. the lstat symlink guard).
import { describe, expect, it } from 'vitest';
import type { RequestHandler } from '@sveltejs/kit';

function ev(params: Record<string, string>, headers: Record<string, string> = {}) {
	return {
		params,
		url: new URL('http://localhost/'),
		request: new Request('http://localhost/', { headers })
	} as unknown as Parameters<RequestHandler>[0];
}

describe('share routes — feature OFF (no DATA_DIR) → uniform 404, store untouched', () => {
	it('mint GET /api/share/<name> → 404 (authed surface, gated on shareEnabled)', async () => {
		const { GET } = await import('../src/routes/api/share/[name]/+server');
		await expect((GET as RequestHandler)(ev({ name: 'clip.mp4' }))).rejects.toMatchObject({
			status: 404
		});
	});

	it('player GET /share/<token> → 404 (unauth; resolve null → uniform 404)', async () => {
		const { GET } = await import('../src/routes/share/[token]/+server');
		await expect((GET as RequestHandler)(ev({ token: 'any-token' }))).rejects.toMatchObject({
			status: 404
		});
	});

	it('bytes GET|HEAD /share/<token>/media → 404 (unauth; resolve null → uniform 404)', async () => {
		const mod = await import('../src/routes/share/[token]/media/+server');
		await expect((mod.GET as RequestHandler)(ev({ token: 'any-token' }))).rejects.toMatchObject({
			status: 404
		});
		await expect((mod.HEAD as RequestHandler)(ev({ token: 'any-token' }))).rejects.toMatchObject({
			status: 404
		});
	});

	it('poster GET /share/<token>/poster → 404 (unauth og:image; resolve null → uniform 404)', async () => {
		const { GET } = await import('../src/routes/share/[token]/poster/+server');
		await expect((GET as RequestHandler)(ev({ token: 'any-token' }))).rejects.toMatchObject({
			status: 404
		});
	});

	it('bytes with a malicious ?f=<frame> still 404 when disabled (the gallery-frame param is no bypass)', async () => {
		const mod = await import('../src/routes/share/[token]/media/+server');
		const event = {
			params: { token: 'any-token' },
			url: new URL('http://localhost/?f=' + encodeURIComponent('../../etc/passwd')),
			request: new Request('http://localhost/')
		} as unknown as Parameters<RequestHandler>[0];
		// resolveShare is null (feature off) → 404 BEFORE the gallery/frame branch → `?f` never
		// reaches serve(). (Enabled, `?f` is allowlisted to the token's OWN gallery frames.)
		await expect((mod.GET as RequestHandler)(event)).rejects.toMatchObject({ status: 404 });
	});
});
