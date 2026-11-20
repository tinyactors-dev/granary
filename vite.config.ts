import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

// @tinyactors/node loads a platform-specific native addon (.node) via
// require(); it must never be bundled or pre-bundled. See ADR 0022.
const nativeDeps = ['@tinyactors/node'];

export default defineConfig({
	plugins: [tailwindcss(), sveltekit()],
	ssr: {
		external: nativeDeps
	},
	optimizeDeps: {
		exclude: nativeDeps
	}
});
