import { error } from '@sveltejs/kit';
import { findPreview } from '$lib/dev-ui/registry';
import type { PageLoad } from './$types';

export const load: PageLoad = ({ params }) => {
	const entry = findPreview(params.component);
	if (!entry) error(404, `No preview for “${params.component}”`);
	const story = params.story ? entry.stories.find((s) => s.id === params.story) : entry.stories[0];
	if (!story) error(404, `${entry.title} has no story “${params.story}”`);
	return { componentId: entry.id, storyId: story.id };
};
