/**
 * The pure decisions behind the preview pager: which page is current, and
 * which pages a forward jump has to validate on the way. Kept out of the
 * hook so they can be tested as functions of a page list.
 */

import type { SectionPage } from "@/lib/preview/engine/formEngine";

/** The pages a worker can see: those with something on them. */
export function visiblePages(
	pages: ReadonlyArray<SectionPage>,
): ReadonlyArray<SectionPage> {
	return pages.filter((page) => page.hasVisibleQuestions);
}

/**
 * The page to show given what the session remembers. The remembered page
 * wins while it is visible; a page that just emptied (an answer hid its
 * last question) re-anchors to the next visible page after it in document
 * order, else the previous, else the first; no memory means the first.
 * `undefined` only when there is no visible page at all.
 */
export function resolveCurrentPage(
	pages: ReadonlyArray<SectionPage>,
	active: string | undefined,
): SectionPage | undefined {
	const visible = visiblePages(pages);
	if (visible.length === 0) return undefined;
	if (active === undefined) return visible[0];
	const remembered = visible.find((page) => page.uuid === active);
	if (remembered !== undefined) return remembered;
	const position = pages.findIndex((page) => page.uuid === active);
	if (position === -1) return visible[0];
	const after = pages
		.slice(position + 1)
		.find((page) => page.hasVisibleQuestions);
	if (after !== undefined) return after;
	const before = [...pages.slice(0, position)]
		.reverse()
		.find((page) => page.hasVisibleQuestions);
	return before ?? visible[0];
}

/**
 * For a jump from `from` to `to`: the visible pages that must be valid
 * first, `from` included and `to` excluded, in order. Empty for a jump
 * backward or to the same page: anything behind the worker is reachable
 * without a check, the way Back never validates.
 */
export function pagesToValidate(
	visible: ReadonlyArray<SectionPage>,
	from: string,
	to: string,
): ReadonlyArray<SectionPage> {
	const start = visible.findIndex((page) => page.uuid === from);
	const end = visible.findIndex((page) => page.uuid === to);
	if (start === -1 || end === -1 || end <= start) return [];
	return visible.slice(start, end);
}
