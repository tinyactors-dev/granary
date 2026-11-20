/**
 * `settings/main` — fake-infra knobs (ADR 0132): R2 fidelity toggles, clock
 * skew, and which exe.dev proxy fronts are on. The server asks
 * `settings.get` on every request.
 */
import { handlerChart } from '../../src/lib/charts';
import type { FidelityRequest } from '../schemas';

export const SETTINGS_ADDRESS = 'settings/main';

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

export type SettingsData = Settings;

export const SETTINGS_EVENTS = {
	get: 'settings.get',
	fidelity: 'settings.fidelity',
	clock: 'settings.clock',
	exeProxy: 'settings.exe-proxy'
} as const;

function view(d: SettingsData): Settings {
	return { fidelity: { ...d.fidelity }, clockSkewMs: d.clockSkewMs, exeProxy: { ...d.exeProxy } };
}

export const settingsChart = handlerChart<SettingsData>({
	name: 'settings',
	initial: { fidelity: { ...DEFAULT_FIDELITY }, clockSkewMs: 0, exeProxy: { tokenMode: true, peerMode: true, peerSourceVm: 'granary' } },
	helpers: { view },
	handlers: {
		[SETTINGS_EVENTS.get]: (d) => view(d),
		[SETTINGS_EVENTS.fidelity]: (d, e: Partial<FidelityRequest>) => {
			d.fidelity = { ...d.fidelity, ...e };
			return view(d);
		},
		[SETTINGS_EVENTS.clock]: (d, e: { skewMs: number }) => {
			d.clockSkewMs = e.skewMs;
			return view(d);
		},
		[SETTINGS_EVENTS.exeProxy]: (d, e: { tokenMode: boolean; peerMode: boolean; peerSourceVm?: string }) => {
			d.exeProxy = { tokenMode: e.tokenMode, peerMode: e.peerMode, peerSourceVm: e.peerSourceVm ?? d.exeProxy.peerSourceVm };
			return view(d);
		}
	}
});
