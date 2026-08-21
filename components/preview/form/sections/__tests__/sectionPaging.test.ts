import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import type { SectionPage } from "@/lib/preview/engine/formEngine";
import {
	pagesToValidate,
	resolveCurrentPage,
	visiblePages,
} from "../sectionPaging";

function page(name: string, hasVisibleQuestions: boolean): SectionPage {
	return {
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

describe("visiblePages", () => {
	it("keeps only the pages with something to show, in order", () => {
		expect(visiblePages(ALL)).toEqual([a, c, d]);
	});
});

describe("resolveCurrentPage", () => {
	it("opens on the first visible page when nothing is remembered", () => {
		expect(resolveCurrentPage(ALL, undefined)).toBe(a);
		expect(resolveCurrentPage([b, c], undefined)).toBe(c);
	});

	it("keeps the remembered page while it is visible", () => {
		expect(resolveCurrentPage(ALL, c.uuid)).toBe(c);
	});

	it("re-anchors a hidden page to the next visible page after it", () => {
		expect(resolveCurrentPage(ALL, b.uuid)).toBe(c);
	});

	it("falls back to the previous visible page when nothing follows", () => {
		const last = page("e", false);
		expect(resolveCurrentPage([...ALL, last], last.uuid)).toBe(d);
	});

	it("treats a page the form no longer has as no memory", () => {
		expect(resolveCurrentPage(ALL, testUuid("gone"))).toBe(a);
	});

	it("answers undefined only when no page is visible", () => {
		expect(resolveCurrentPage([b], b.uuid)).toBeUndefined();
		expect(resolveCurrentPage([], undefined)).toBeUndefined();
	});
});

describe("pagesToValidate", () => {
	const visible = [a, c, d];

	it("names every page from the current one up to, not including, the target", () => {
		expect(pagesToValidate(visible, a.uuid, d.uuid)).toEqual([a, c]);
		expect(pagesToValidate(visible, a.uuid, c.uuid)).toEqual([a]);
	});

	it("asks nothing of a jump backward or to the same page", () => {
		expect(pagesToValidate(visible, d.uuid, a.uuid)).toEqual([]);
		expect(pagesToValidate(visible, c.uuid, c.uuid)).toEqual([]);
	});

	it("asks nothing when either end is not a visible page", () => {
		expect(pagesToValidate(visible, b.uuid, d.uuid)).toEqual([]);
		expect(pagesToValidate(visible, a.uuid, b.uuid)).toEqual([]);
	});
});
