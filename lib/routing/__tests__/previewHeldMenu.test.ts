import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import type { PreviewHeldCaseListMenu } from "@/lib/preview/menuProjection";
import {
	type BuilderHistoryWrite,
	builderEntryState,
	previewHeldMenuBack,
	previewHeldMenuIsPrevious,
	readPreviewHeldMenu,
	stepsOfPreviewHeldMenu,
} from "../previewHeldMenu";

const menu = testUuid("menu");
const list = `/build/app/${menu}/results`;
const details = `/build/app/${menu}/cases/ana`;
const form = `/build/app/${testUuid("form")}`;
const held: PreviewHeldCaseListMenu = {
	moduleUuid: menu,
	cases: [{ caseId: "ana", caseName: "Ana" }],
	session: "worker-a",
};

/** A browser history the builder writes into, as `useClientPath.ts` does:
 * each write's state comes from the current entry's, and Back moves the
 * current index without dropping the entries ahead. */
function history(first: { pathname: string; state?: Record<string, unknown> }) {
	const entries = [{ pathname: first.pathname, state: first.state ?? {} }];
	let at = 0;
	const write = (written: BuilderHistoryWrite) => {
		const state = builderEntryState(entries[at], written);
		const entry = { pathname: written.pathname, state };
		if ("lens" in written || !written.replace) {
			entries.splice(at + 1, entries.length, entry);
			at += 1;
		} else entries[at] = entry;
	};
	return {
		push: (pathname: string, heldMenu?: PreviewHeldCaseListMenu) =>
			write({ pathname, replace: false, held: heldMenu }),
		replace: (pathname: string, heldMenu?: PreviewHeldCaseListMenu) =>
			write({ pathname, replace: true, held: heldMenu }),
		lens: () => write({ pathname: entries[at].pathname, lens: true }),
		back: (steps = 1) => {
			at -= steps;
		},
		get current() {
			return entries[at];
		},
	};
}

describe("a case list's held form menu on its history entry", () => {
	it("reads back the menu an entry was written with, and keeps the entry's other state", () => {
		const several: PreviewHeldCaseListMenu = {
			...held,
			cases: [
				{ caseId: "ana", caseName: "Ana" },
				{ caseId: "bo", claimable: true as const },
			],
		};
		const h = history({ pathname: list, state: { __NA: true } });
		h.push(list, several);
		expect(readPreviewHeldMenu(h.current.state)).toEqual(several);
		expect(h.current.state.__NA).toBe(true);
		// A history state survives structured cloning, as the browser stores it.
		expect(readPreviewHeldMenu(structuredClone(h.current.state))).toEqual(
			several,
		);
	});

	it("drops the menu from every entry written without one", () => {
		const h = history({ pathname: list });
		h.push(list, held);
		h.push(form);
		expect(readPreviewHeldMenu(h.current.state)).toBeUndefined();
		h.back();
		h.replace(list);
		expect(readPreviewHeldMenu(h.current.state)).toBeUndefined();
	});

	it("steps back off a menu pushed after its list onto the list", () => {
		const h = history({ pathname: list });
		h.push(list, held);
		expect(previewHeldMenuBack(h.current.state)).toEqual({
			kind: "step-back",
			steps: 1,
		});
		h.back();
		expect(readPreviewHeldMenu(h.current.state)).toBeUndefined();
	});

	it("steps back onto a case-first menu's list, shown at the module's own URL", () => {
		const h = history({ pathname: `/build/app/${menu}` });
		h.push(list, held);
		expect(previewHeldMenuBack(h.current.state)).toEqual({
			kind: "step-back",
			steps: 1,
		});
		// Another module's screen is not this list's.
		const other = history({ pathname: `/build/app/${testUuid("other")}` });
		other.push(list, held);
		expect(previewHeldMenuBack(other.current.state)).toEqual({
			kind: "show-list",
		});
	});

	it("steps back onto the list off a menu that replaced the case's details pushed from it", () => {
		const h = history({ pathname: list });
		h.push(details);
		h.replace(list, held);
		expect(previewHeldMenuBack(h.current.state)).toEqual({
			kind: "step-back",
			steps: 1,
		});
	});

	it("shows the list in the menu's own entry where no list entry is behind it", () => {
		// A deep-linked case's details opened in a fresh tab: nothing before.
		const fresh = history({ pathname: details });
		fresh.replace(list, held);
		expect(previewHeldMenuBack(fresh.current.state)).toEqual({
			kind: "show-list",
		});
		// Details reached from somewhere other than the list.
		const elsewhere = history({ pathname: form });
		elsewhere.push(details);
		elsewhere.replace(list, held);
		expect(previewHeldMenuBack(elsewhere.current.state)).toEqual({
			kind: "show-list",
		});
	});

	it("counts the menu's own entry and each language change made on it as one step", () => {
		const h = history({ pathname: list });
		expect(stepsOfPreviewHeldMenu(h.current.state)).toBe(0);
		h.push(list, held);
		expect(stepsOfPreviewHeldMenu(h.current.state)).toBe(1);
		h.lens();
		h.lens();
		expect(stepsOfPreviewHeldMenu(h.current.state)).toBe(3);
		// A lens copy holds the same menu, still after its list.
		expect(readPreviewHeldMenu(h.current.state)).toEqual(held);
		expect(previewHeldMenuBack(h.current.state)).toEqual({
			kind: "step-back",
			steps: 3,
		});
		h.back(3);
		expect(readPreviewHeldMenu(h.current.state)).toBeUndefined();
		// A depth another page wrote counts as the menu's own entry alone.
		expect(
			stepsOfPreviewHeldMenu({
				__novaPreviewHeldMenu: { ...held, lensDepth: -1 },
			}),
		).toBe(1);
	});

	it("steps back from a form opened on the menu onto the menu, where its case's crumb leads", () => {
		const h = history({ pathname: list });
		h.push(list, held);
		h.push(form);
		expect(previewHeldMenuIsPrevious(h.current.state, held)).toBe(true);
		// Another session's menu, or other cases, is not the one behind it.
		expect(
			previewHeldMenuIsPrevious(h.current.state, {
				...held,
				session: "worker-b",
			}),
		).toBe(false);
		expect(
			previewHeldMenuIsPrevious(h.current.state, {
				...held,
				cases: [{ caseId: "bo" }],
			}),
		).toBe(false);
		h.back();
		// The menu stepped back to steps back again onto the list.
		expect(previewHeldMenuBack(h.current.state)).toEqual({
			kind: "step-back",
			steps: 1,
		});
	});

	it("opens the menu again on an entry of its own where it is not behind the form, and its Back shows the list", () => {
		const h = history({ pathname: list });
		h.push(list, held);
		h.push(form);
		// A language change on the form: the menu is two entries back.
		h.lens();
		expect(previewHeldMenuIsPrevious(h.current.state, held)).toBe(false);
		h.push(list, held);
		expect(readPreviewHeldMenu(h.current.state)).toEqual(held);
		// The entry behind it is the form's, so the menu's Back cannot step
		// back to the list: the menu's entry becomes the list's.
		expect(previewHeldMenuBack(h.current.state)).toEqual({ kind: "show-list" });
		expect(previewHeldMenuIsPrevious(h.current.state, held)).toBe(false);
	});

	it("reads no menu from a state another page wrote", () => {
		for (const state of [
			null,
			"menu",
			{},
			{ __novaPreviewHeldMenu: { moduleUuid: menu, cases: [], session: "a" } },
			{ __novaPreviewHeldMenu: { moduleUuid: menu, cases: [{ caseId: "a" }] } },
			{
				__novaPreviewHeldMenu: {
					moduleUuid: 1,
					cases: [{ caseId: "a" }],
					session: "a",
				},
			},
			{
				__novaPreviewHeldMenu: {
					moduleUuid: menu,
					cases: [{ caseId: 1 }],
					session: "a",
				},
			},
			{
				__novaPreviewHeldMenu: {
					moduleUuid: menu,
					cases: [{ caseId: "a", claimable: false }],
					session: "a",
				},
			},
		]) {
			expect(readPreviewHeldMenu(state)).toBeUndefined();
			expect(previewHeldMenuIsPrevious(state, held)).toBe(false);
		}
	});
});
