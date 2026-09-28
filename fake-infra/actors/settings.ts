/**
 * `settings/main` — fake-infra knobs (ADR 0132): R2 fidelity toggles, clock
 * skew, and which exe.dev proxy fronts are on. The server asks
 * `settings.get` on every request.
 */
import { statechart } from '@tinyactors/node';
import type { FidelityRequest } from '../schemas';
import { answer } from '../io/reply';

export const SETTINGS_ADDRESS = { family: 'settings', name: 'main' } as const;

export const DEFAULT_FIDELITY: FidelityRequest = {
	sigV4: true,
	regionAuto: true,
	conditionalWrites: true,
	conditionalOnPresigned: true,
	equalPartSizes: true,
	perKeyWriteRateLimit: false,
	r2NotImplemented: true
};

export interface ExeProxySettings {
	tokenMode: boolean;
	peerMode: boolean;
	peerSourceVm: string;
}

export interface Settings {
	fidelity: FidelityRequest;
	clockSkewMs: number;
	exeProxy: ExeProxySettings;
}

export interface SettingsData extends Settings {
	out: unknown;
}

export const SETTINGS_EVENTS = {
	get: 'settings.get',
	fidelity: 'settings.fidelity',
	clock: 'settings.clock',
	exeProxy: 'settings.exe-proxy'
} as const;

const view = (d: SettingsData): Settings => ({
	fidelity: { ...d.fidelity },
	clockSkewMs: d.clockSkewMs,
	exeProxy: { ...d.exeProxy }
});

export const settingsChart = statechart<SettingsData>({ family: 'settings', revision: 'v1' })
	.dataExpression('fidelity', () => ({ ...DEFAULT_FIDELITY }))
	.data('clockSkewMs', 0)
	.dataExpression('exeProxy', () => ({ tokenMode: true, peerMode: true, peerSourceVm: 'granary' }))
	.data('out', null)
	.state('ready', (s) =>
		s
			.on(SETTINGS_EVENTS.get, answer<SettingsData>((d) => view(d)))
			.on(
				SETTINGS_EVENTS.fidelity,
				answer<SettingsData, Partial<FidelityRequest>>((d, e) => {
					const { reqId: _r, ...patch } = e as Partial<FidelityRequest> & { reqId?: string };
					d.fidelity = { ...d.fidelity, ...patch };
					return view(d);
				})
			)
			.on(
				SETTINGS_EVENTS.clock,
				answer<SettingsData, { skewMs: number }>((d, e) => {
					d.clockSkewMs = e.skewMs;
					return view(d);
				})
			)
			.on(
				SETTINGS_EVENTS.exeProxy,
				answer<SettingsData, { tokenMode: boolean; peerMode: boolean; peerSourceVm?: string }>((d, e) => {
					d.exeProxy = {
						tokenMode: e.tokenMode,
						peerMode: e.peerMode,
						peerSourceVm: e.peerSourceVm ?? d.exeProxy.peerSourceVm
					};
					return view(d);
				})
			)
	);
