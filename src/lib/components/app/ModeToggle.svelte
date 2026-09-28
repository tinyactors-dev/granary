<script lang="ts">
	import { Button } from '$lib/components/ui/button/index.js';
	import SunIcon from '@lucide/svelte/icons/sun';
	import MoonIcon from '@lucide/svelte/icons/moon';
	import { mode, toggleMode } from 'mode-watcher';

	/** Name the action, not the current state (design audit). */
	const label = $derived(mode.current === 'dark' ? 'Switch to light mode' : 'Switch to dark mode');
</script>

<Button variant="ghost" size="icon-sm" onclick={toggleMode} aria-label={label} title={label}>
	<SunIcon class="scale-100 rotate-0 transition-all dark:scale-0 dark:-rotate-90" />
	<MoonIcon class="absolute scale-0 rotate-90 transition-all dark:scale-100 dark:rotate-0" />
</Button>
