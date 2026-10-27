/**
 * The pure decisions behind the preview pager: which screen is current, and
 * which screens a forward jump has to validate on the way. Kept out of the
 * hook so they can be tested as functions of a screen list.
 *
 * A screen's identity is its path (`FormScreenPage.path`); a caller that
 * remembers a section by uuid passes `identify` to key on it instead.
 */

import type { FormScreenPage } from "@/lib/preview/engine/formEngine";

type Identify = (page: FormScreenPage) => string;

const byPath: Identify = (page) => page.path;

/** Screens with questions or repeat rows whose contents are decided on entry. */
export function availablePages<T extends FormScreenPage>(
	pages: ReadonlyArray<T>,
): ReadonlyArray<T> {
	return pages.filter(
		(page) => page.hasVisibleQuestions || page.needsEntry === true,
	);
}

/**
 * The screen to show given what the session remembers. The remembered screen
 * wins while it is visible; a screen that just emptied (an answer hid its
 * last question) re-anchors to the next visible screen after it in document
 * order, else the previous, else the first; no memory means the first.
 * `undefined` only when there is no visible screen at all.
 */
export function resolveCurrentPage(
	pages: ReadonlyArray<FormScreenPage>,
	active: string | undefined,
	identify: Identify = byPath,
): FormScreenPage | undefined {
	const visible = availablePages(pages);
	if (visible.length === 0) return undefined;
	if (active === undefined) return visible[0];
	const remembered = visible.find((page) => identify(page) === active);
	if (remembered !== undefined) return remembered;
	const position = pages.findIndex((page) => identify(page) === active);
	if (position === -1) return visible[0];
	const after = pages
		.slice(position + 1)
		.find((page) => page.hasVisibleQuestions || page.needsEntry === true);
	if (after !== undefined) return after;
	const before = [...pages.slice(0, position)]
		.reverse()
		.find((page) => page.hasVisibleQuestions || page.needsEntry === true);
	return before ?? visible[0];
}

/**
 * For a jump from `from` to `to`: the visible screens that must be valid
 * first, `from` included and `to` excluded, in order. Empty for a jump
 * backward or to the same screen: anything behind the worker is reachable
 * without a check, the way Back never validates.
 */
export function pagesToValidate(
	visible: ReadonlyArray<FormScreenPage>,
	from: string,
	to: string,
	identify: Identify = byPath,
): ReadonlyArray<FormScreenPage> {
	const start = visible.findIndex((page) => identify(page) === from);
	const end = visible.findIndex((page) => identify(page) === to);
	if (start === -1 || end === -1 || end <= start) return [];
	return visible.slice(start, end);
}
