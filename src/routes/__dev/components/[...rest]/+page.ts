import { redirect } from '@sveltejs/kit';
import type { PageLoad } from './$types';

/** The old component playgrounds moved to /__dev/ui (ADR 0077). */
export const load: PageLoad = ({ params }) => {
	redirect(308, `/__dev/ui/${params.rest || ''}`);
};
