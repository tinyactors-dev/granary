/**
 * The component preview registry (ADR 0077). Add a component: write a
 * wrapper in `previews/` that renders it from `args`, optionally a docs
 * component, and an entry here. /__dev/ui lists entries; the generic page
 * /__dev/ui/<id>/<story> renders stories, controls and docs.
 */
import type { PreviewEntry } from './types';
import { JSON_DATASETS } from './fixtures/json';
import JsonViewPreview from './previews/JsonViewPreview.svelte';
import JsonViewDocs from './previews/JsonViewDocs.svelte';
import JsonBlockPreview from './previews/JsonBlockPreview.svelte';
import TraceViewerPreview from './previews/TraceViewerPreview.svelte';
import TraceViewerDocs from './previews/TraceViewerDocs.svelte';

const jsonDefaults = { mode: 'structure', keymap: 'vim', expandDepth: 2, maxStringLength: 200, theme: 'auto', rootLabel: '$', height: '30rem', json: '' };

export const PREVIEWS: PreviewEntry[] = [
	{
		id: 'json-view',
		title: 'JSON view',
		description: 'Structure/source JSON renderer with path search, vim/emacs keys and clipboard.',
		source: 'src/lib/components/json-view/',
		preview: JsonViewPreview,
		docs: JsonViewDocs,
		controls: [
			{ key: 'dataset', type: 'select', options: JSON_DATASETS.map((d) => d.id), help: 'Fixture to render (ignored when JSON is pasted).' },
			{ key: 'mode', type: 'select', options: ['structure', 'source'] },
			{ key: 'keymap', type: 'select', options: ['vim', 'emacs'] },
			{ key: 'expandDepth', type: 'number', min: 0, max: 20, step: 1 },
			{ key: 'maxStringLength', type: 'number', min: 10, max: 5000, step: 10 },
			{ key: 'theme', type: 'select', options: ['auto', 'light', 'dark'] },
			{ key: 'rootLabel', type: 'text' },
			{ key: 'height', type: 'text' },
			{ key: 'json', label: 'paste JSON', type: 'text', multiline: true, help: 'Overrides the dataset.' }
		],
		stories: JSON_DATASETS.map((d) => ({
			id: d.id,
			title: d.label,
			args: {
				...jsonDefaults,
				dataset: d.id,
				...(d.id === 'deep' ? { expandDepth: 20 } : {}),
				...(d.id === 'strings' ? { maxStringLength: 60 } : {})
			}
		})).concat([
			{ id: 'source-mode', title: 'Source mode, emacs keys', args: { ...jsonDefaults, dataset: 'small', mode: 'source', keymap: 'emacs' } }
		])
	},
	{
		id: 'json-block',
		title: 'JSON block',
		description: 'The app wrapper around JSON view: size presets, one-line tiny values, fullscreen dialog, shared keymap (ADR 0058).',
		source: 'src/lib/components/app/JsonBlock.svelte',
		preview: JsonBlockPreview,
		canvas: { padded: true },
		controls: [
			{ key: 'value', type: 'select', options: ['live', 'tiny-array', 'tiny-object', 'tiny-string', ...JSON_DATASETS.map((d) => d.id)], help: '"live" replaces the value every second: expansion and cursor survive.' },
			{ key: 'preset', type: 'select', options: ['inline', 'compact', 'panel'] },
			{ key: 'context', type: 'select', options: ['card', 'table-cell'], help: 'Where the block sits.' },
			{ key: 'rootLabel', type: 'text' },
			{ key: 'alwaysTree', type: 'boolean', help: 'Use the viewer even for tiny values.' },
			{ key: 'fullscreen', type: 'boolean', help: 'Offer the fullscreen dialog.' }
		],
		stories: [
			{ id: 'compact', title: 'Compact (cards)', description: 'Grows with the content up to ~20rem.', args: { value: 'small', preset: 'compact', context: 'card', rootLabel: 'payload', alwaysTree: false, fullscreen: true } },
			{ id: 'panel', title: 'Panel (main data)', args: { value: 'large10k', preset: 'panel', context: 'card', rootLabel: 'data', alwaysTree: true, fullscreen: true } },
			{ id: 'inline-table', title: 'Inline, in a table cell', description: 'Span attributes: tiny values stay one line.', args: { value: 'small', preset: 'inline', context: 'table-cell', rootLabel: 'data', alwaysTree: false, fullscreen: true } },
			{ id: 'tiny', title: 'Tiny value', description: 'Rendered as one line of code.', args: { value: 'tiny-object', preset: 'compact', context: 'card', rootLabel: '$', alwaysTree: false, fullscreen: true } },
			{ id: 'live', title: 'Live (polled) value', description: 'Expand a node, move the cursor, wait: state is kept by path.', args: { value: 'live', preset: 'compact', context: 'card', rootLabel: 'data', alwaysTree: true, fullscreen: true } }
		]
	},
	{
		id: 'trace-viewer',
		title: 'Trace viewer',
		description: 'Jaeger-style trace list and span tree with a shared time axis and span details.',
		source: 'src/lib/components/dev/trace/TraceBrowser.svelte',
		preview: TraceViewerPreview,
		docs: TraceViewerDocs,
		canvas: { padded: true },
		controls: [
			{ key: 'fixture', type: 'select', options: ['singleIssue', 'errorSpan', 'missingParent', 'manyTraces', 'empty'] },
			{ key: 'search', type: 'text', help: 'Filter traces by event / span name.' },
			{ key: 'address', type: 'text', help: 'Filter traces by actor address.' },
			{ key: 'filterable', type: 'boolean', help: 'Address chips act as filter buttons.' },
			{ key: 'loading', type: 'boolean', help: 'Show the loading skeleton.' }
		],
		stories: [
			{ id: 'single-issue', title: 'Single issue flow', description: 'Webhook → allowlist check → closing; the relay reply is its own trace.', args: { fixture: 'singleIssue', search: '', address: '', filterable: true, loading: false } },
			{ id: 'error-span', title: 'Error span', description: 'The relay gave up: error spans in the reply trace.', args: { fixture: 'errorSpan', search: '', address: '', filterable: true, loading: false } },
			{ id: 'missing-parent', title: 'Missing parent', description: '`scxml.finished` whose parent step was never emitted.', args: { fixture: 'missingParent', search: '', address: '', filterable: true, loading: false } },
			{ id: 'many-traces', title: 'Many traces', description: 'Forty issue flows, all outcomes.', args: { fixture: 'manyTraces', search: '', address: '', filterable: true, loading: false } },
			{ id: 'empty', title: 'Empty', args: { fixture: 'empty', search: '', address: '', filterable: true, loading: false } },
			{ id: 'loading', title: 'Loading', args: { fixture: 'empty', search: '', address: '', filterable: true, loading: true } }
		]
	}
];

export const findPreview = (id: string) => PREVIEWS.find((p) => p.id === id) ?? null;
