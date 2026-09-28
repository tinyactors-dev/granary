/**
 * Safe Markdown → HTML for previews (ADR 0252). `marked` (GFM, isomorphic, no
 * DOM needed, so it also renders during SSR) with renderer overrides instead
 * of an HTML sanitiser: raw HTML is shown as text, links and images only for
 * http(s), mailto, relative and fragment URLs. The preview can therefore be
 * inserted with {@html}. GitHub sanitises the real comment itself; this only
 * has to be at least as strict.
 */
import { Marked, type Tokens } from 'marked';

const SAFE_URL = /^(https?:\/\/|mailto:|#|\/(?!\/))/i;
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const md = new Marked({
	gfm: true,
	breaks: true, // GitHub comments turn single newlines into line breaks
	renderer: {
		html(token: Tokens.HTML | Tokens.Tag) {
			return esc(token.text);
		},
		link(token: Tokens.Link) {
			const text = this.parser.parseInline(token.tokens);
			if (!SAFE_URL.test(token.href)) return text;
			const title = token.title ? ` title="${esc(token.title)}"` : '';
			return `<a href="${esc(token.href)}"${title} target="_blank" rel="noreferrer noopener">${text}</a>`;
		},
		image(token: Tokens.Image) {
			if (!SAFE_URL.test(token.href)) return esc(token.text);
			return `<img src="${esc(token.href)}" alt="${esc(token.text)}" loading="lazy" referrerpolicy="no-referrer">`;
		}
	}
});

export function renderMarkdown(source: string): string {
	return md.parse(source, { async: false }) as string;
}
