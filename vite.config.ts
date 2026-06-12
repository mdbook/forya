import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	plugins: [sveltekit()],
	test: {
		// Unit tests live in tests/ (range/videos guards) and may also sit
		// alongside source. Server-side Node environment — no DOM needed.
		include: ['tests/**/*.{test,spec}.{js,ts}', 'src/**/*.{test,spec}.{js,ts}'],
		environment: 'node',
		passWithNoTests: true
	}
});
