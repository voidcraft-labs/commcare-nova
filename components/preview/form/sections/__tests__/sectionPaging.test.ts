import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import type { FormScreenPage } from "@/lib/preview/engine/formEngine";
import {
	availablePages,
	pagesToValidate,
	repeatPromptsBetween,
	resolveCurrentPage,
} from "@/lib/preview/engine/sectionPaging";

function page(name: string, hasVisibleQuestions: boolean): FormScreenPage {
	return {
		kind: "section",
		uuid: testUuid(name),
		path: `/data/${name}`,
		hasVisibleQuestions,
	};
}

const a = page("a", true);
const b = page("b", false);
const c = page("c", true);
const d = page("d", true);
const ALL = [a, b, c, d];

describe("availablePages", () => {
	it("keeps only the pages with something to show, in order", () => {
		expect(availablePages(ALL)).toEqual([a, c, d]);
	});
});

describe("resolveCurrentPage", () => {
	it("opens on the first visible page when nothing is remembered", () => {
		expect(resolveCurrentPage(ALL, undefined)).toBe(a);
		expect(resolveCurrentPage([b, c], undefined)).toBe(c);
	});

	it("keeps the remembered page while it is visible", () => {
		expect(resolveCurrentPage(ALL, c.path)).toBe(c);
	});

	it("re-anchors a hidden page to the next visible page after it", () => {
		expect(resolveCurrentPage(ALL, b.path)).toBe(c);
	});

	it("falls back to the previous visible page when nothing follows", () => {
		const last = page("e", false);
		expect(resolveCurrentPage([...ALL, last], last.path)).toBe(d);
	});

	it("treats a page the form no longer has as no memory", () => {
		expect(resolveCurrentPage(ALL, testUuid("gone"))).toBe(a);
	});

	it("answers undefined only when no page is visible", () => {
		expect(resolveCurrentPage([b], b.path)).toBeUndefined();
		expect(resolveCurrentPage([], undefined)).toBeUndefined();
	});
});

describe("pagesToValidate", () => {
	const visible = [a, c, d];

	it("names every page from the current one up to, not including, the target", () => {
		expect(pagesToValidate(visible, a.path, d.path)).toEqual([a, c]);
		expect(pagesToValidate(visible, a.path, c.path)).toEqual([a]);
	});

	it("asks nothing of a jump backward or to the same page", () => {
		expect(pagesToValidate(visible, d.path, a.path)).toEqual([]);
		expect(pagesToValidate(visible, c.path, c.path)).toEqual([]);
	});

	it("asks nothing when either end is not a visible page", () => {
		expect(pagesToValidate(visible, b.path, d.path)).toEqual([]);
		expect(pagesToValidate(visible, a.path, b.path)).toEqual([]);
	});
});

describe("repeatPromptsBetween", () => {
	const prompt = (afterScreen: number, visible = true) => ({
		afterScreen,
		visible,
	});

	it("opens every relevant prompt placed from the current screen up to the next", () => {
		const points = [prompt(0), prompt(1), prompt(1, false), prompt(3)];
		/* From screen 1 to screen 3, past a skipped screen 2. */
		expect(repeatPromptsBetween(points, 1, 3)).toEqual([prompt(1)]);
		expect(repeatPromptsBetween(points, 0, 4)).toEqual([
			prompt(0),
			prompt(1),
			prompt(3),
		]);
	});

	it("opens a prompt after the last screen when nothing follows", () => {
		expect(repeatPromptsBetween([prompt(5)], 5, 6)).toEqual([prompt(5)]);
		expect(repeatPromptsBetween([prompt(4)], 5, 6)).toEqual([]);
	});

	it("finds the prompts before the first screen, which the form opens with", () => {
		/* A repeat no screen precedes sits at -1; with skipped screens 0 and 1
		 * before the first visible screen 2, a prompt placed after either is
		 * passed on opening too. */
		const points = [prompt(-1), prompt(1), prompt(2)];
		expect(repeatPromptsBetween(points, -1, 2)).toEqual([
			prompt(-1),
			prompt(1),
		]);
		/* A form with no screen at all opens with every prompt. */
		expect(repeatPromptsBetween([prompt(-1)], -1, 0)).toEqual([prompt(-1)]);
	});
});
