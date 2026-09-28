/**
 * Svelte action for horizontal scrollers (ADR 0296): keeps `data-at-end` in
 * sync so the `.scroll-fade-x` edge fade disappears once nothing more is
 * hidden, and scrolls the active item (`[aria-current]`) into view.
 */
export function scrollFade(node: HTMLElement) {
	const update = () => {
		const atEnd = node.scrollLeft + node.clientWidth >= node.scrollWidth - 2;
		if (atEnd) node.dataset.atEnd = '';
		else delete node.dataset.atEnd;
	};
	const current = node.querySelector<HTMLElement>('[aria-current]');
	if (current && node.scrollWidth > node.clientWidth) {
		node.scrollLeft = Math.max(0, current.offsetLeft - node.clientWidth / 2 + current.offsetWidth / 2);
	}
	update();
	node.addEventListener('scroll', update, { passive: true });
	const resize = new ResizeObserver(update);
	resize.observe(node);
	return {
		destroy() {
			node.removeEventListener('scroll', update);
			resize.disconnect();
		}
	};
}
