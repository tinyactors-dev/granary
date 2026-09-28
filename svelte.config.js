import adapter from 'svelte-adapter-bun';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
	preprocess: vitePreprocess(),
	compilerOptions: {
		// Svelte 5 async components: needed to `await` remote functions in markup.
		experimental: { async: true }
	},
	kit: {
		adapter: adapter(),
		experimental: {
			// SvelteKit remote functions (src/lib/remote/*.remote.ts), ADR 0008.
			remoteFunctions: true
		}
	}
};

export default config;
