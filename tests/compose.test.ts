import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const compose = readFileSync(new URL('../compose.yaml', import.meta.url), 'utf8');

// Source-policy guards, not a substitute for `docker compose config` or a smoke run.
describe('Compose quick start', () => {
	it('builds the included Dockerfile without depending on a private image', () => {
		expect(compose).toMatch(/^    build: \.$/m);
		expect(compose).toMatch(/^    image: forya:local$/m);
		expect(compose).toContain('pull_policy: build');
		expect(compose).not.toContain('registry.mdbook.me');
	});

	it('requires an existing media directory and mounts it read-only', () => {
		expect(compose).toContain('source: ${VIDEOS_PATH:?');
		expect(compose).toContain('target: /srv/videos');
		expect(compose).toContain('read_only: true');
		expect(compose).toContain('create_host_path: false');
	});

	it('persists feed state without opting into poster generation', () => {
		expect(compose).toContain('DATA_DIR: /data');
		expect(compose).toContain('- forya-data:/data');
		expect(compose).toMatch(/^volumes:\n  forya-data:\s*$/m);
		expect(compose).toContain('FEED_NAME: ${FEED_NAME:-feed}');
		expect(compose).toContain('POSTERS: ${POSTERS:-false}');
	});

	it('keeps the unauthenticated service local unless explicitly exposed', () => {
		expect(compose).toContain("'${BIND_ADDRESS:-127.0.0.1}:3000:3000'");
	});
});
