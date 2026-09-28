/** Presentation metadata for personas and scenarios (ADR 0076). */
import WandSparklesIcon from '@lucide/svelte/icons/wand-sparkles';
import MegaphoneIcon from '@lucide/svelte/icons/megaphone';
import UserRoundCheckIcon from '@lucide/svelte/icons/user-round-check';
import CrownIcon from '@lucide/svelte/icons/crown';
import UsersRoundIcon from '@lucide/svelte/icons/users-round';
import HandHeartIcon from '@lucide/svelte/icons/hand-heart';
import BotIcon from '@lucide/svelte/icons/bot';
import ZapIcon from '@lucide/svelte/icons/zap';
import DicesIcon from '@lucide/svelte/icons/dices';
import type { Component } from 'svelte';
import type { PersonaKind, ScenarioState } from '$lib/schemas/dev';
import type { Tone } from '$lib/components/app/format';

export const KIND_ICON: Record<PersonaKind, Component> = {
	'slop-fixer': WandSparklesIcon,
	'persistent-contributor': MegaphoneIcon,
	regular: UserRoundCheckIcon,
	maintainer: CrownIcon,
	member: UsersRoundIcon,
	'first-timer': HandHeartIcon,
	bot: BotIcon,
	'chaos-monkey': ZapIcon,
	fuzzer: DicesIcon
};

export const KIND_LABEL: Record<PersonaKind, string> = {
	'slop-fixer': 'Slop fixer',
	'persistent-contributor': 'Persistent contributor',
	regular: 'Regular',
	maintainer: 'Maintainer',
	member: 'Member',
	'first-timer': 'First-timer',
	bot: 'Bot',
	'chaos-monkey': 'Chaos monkey',
	fuzzer: 'Fuzzer'
};

export const SCENARIO_TONE: Record<ScenarioState, Tone> = {
	created: 'muted',
	running: 'info',
	paused: 'warning',
	draining: 'info',
	settling: 'info',
	finished: 'success',
	stopped: 'muted'
};

export const isTerminal = (s: ScenarioState) => s === 'finished' || s === 'stopped';

export function duration(ms: number | null | undefined): string {
	if (ms === null || ms === undefined) return '—';
	if (ms < 1000) return `${Math.round(ms)} ms`;
	const s = ms / 1000;
	if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)} s`;
	const m = Math.floor(s / 60);
	return `${m}m ${String(Math.round(s % 60)).padStart(2, '0')}s`;
}

export const personaHref = (kind: string, name: string) =>
	`/admin/load/personas/${encodeURIComponent(kind)}/${encodeURIComponent(name)}`;
export const scenarioHref = (id: string) => `/admin/load?scenario=${encodeURIComponent(id)}`;
