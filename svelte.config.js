import adapter from '@sveltejs/adapter-node';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	preprocess: vitePreprocess(),
	compilerOptions: {
		// Svelte 5 runes mode for all app components.
		runes: true
	},
	kit: {
		// adapter-node: one self-contained server that serves the UI and the
		// video bytes. The runtime stage runs `node build` (see Dockerfile).
		adapter: adapter()
	}
};

export default config;
