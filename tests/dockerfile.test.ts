import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const dockerfile = readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8');

// Source-policy guards, not a substitute for building/scanning the resulting image.
describe('Dockerfile security floors (CVE-2026-111497)', () => {
	it('uses supported, patched Node in both build and runtime stages', () => {
		const images = [...dockerfile.matchAll(/^FROM (\S+)/gm)].map((match) => match[1]);
		expect(images).toHaveLength(2);
		for (const image of images) {
			const version = /^node:(22|24)\.(\d+)\.(\d+)-alpine\b/.exec(image);
			expect(version, image).not.toBeNull();
			const [, major, minor, patch] = version!;
			const [minMinor, minPatch] = major === '22' ? [23, 4] : [22, 1];
			expect(
				Number(minor) > minMinor || (Number(minor) === minMinor && Number(patch) >= minPatch)
			).toBe(true);
		}
	});

	it('requires and upgrades patched system Brotli in the runtime stage', () => {
		const runtime = dockerfile.split(/^FROM /m).at(-1)!;
		expect(runtime).toMatch(/^RUN apk add\b[^\n]*--upgrade\b[^\n]*'brotli-libs>=1\.2\.1-r0'/m);
	});
});
