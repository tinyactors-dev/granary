/**
 * Component preview registry types (ADR 0077): a Storybook-style catalogue
 * under /__dev/ui. An entry names a component, the wrapper that renders it
 * from `args`, its stories (named arg sets) and controls (editable args).
 */
import type { Component } from 'svelte';

export type Args = Record<string, unknown>;

export type ControlDef =
	| { key: string; label?: string; type: 'select'; options: readonly string[]; help?: string }
	| { key: string; label?: string; type: 'boolean'; help?: string }
	| { key: string; label?: string; type: 'number'; min?: number; max?: number; step?: number; help?: string }
	| { key: string; label?: string; type: 'text'; multiline?: boolean; help?: string };

export interface StoryDef {
	/** URL segment. */
	id: string;
	title: string;
	description?: string;
	args: Args;
}

export interface PreviewEntry {
	/** URL segment: /__dev/ui/<id>. */
	id: string;
	title: string;
	description: string;
	/** Where the component lives (shown in the docs panel). */
	source: string;
	/** Renders the component from `args` (and may bind args back). */
	preview: Component<{ args: Args }>;
	/** Usage notes rendered under the canvas; receives the current args. */
	docs?: Component<{ args: Args }>;
	controls: ControlDef[];
	stories: StoryDef[];
	/** Canvas defaults. */
	canvas?: { padded?: boolean; minHeight?: string };
}
