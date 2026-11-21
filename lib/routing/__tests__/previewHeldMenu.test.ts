/**
 * A case list's held form menu on its history entry, write by write, as
 * `useClientPath.ts` applies `builderEntryState`: the entry's state holds its
 * id and the entry it was pushed after, and the held cases live in the
 * entry's record, in the records of the Preview session that held them
 * (`previewEntryRecords.ts`).
 */
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import type { PreviewHeldCaseListMenu } from "@/lib/preview/menuProjection";
import {
	type PreviewEntryRecord,
	type PreviewEntryRecordOf,
	previewEntryOf,
	previewEntryRecordReader,
} from "../previewEntryRecords";
import {
	type BuilderHistoryWrite,
	builderEntryState,
	previewHeldMenuBack,
	previewHeldMenuIsPrevious,
	previewHeldMenuStands,
	readPreviewHeldMenu,
	stepsBackToPrevious,
	stepsOfPreviewHeldMenu,
} from "../previewHeldMenu";

const menu = testUuid("menu");
const list = `/build/app/${menu}/results`;
const details = `/build/app/${menu}/cases/ana`;
const form = `/build/app/${testUuid("form")}`;
const held: PreviewHeldCaseListMenu = {
	moduleUuid: menu,
	cases: [{ caseId: "ana", caseName: "Ana" }],
};

/** A browser history the builder writes into, as `useClientPath.ts` does:
 * each write's entry comes from the current entry's, its record filed in the
 * running session's records, and Back moves the current index without
 * dropping the entries ahead. `newSession` is a change of worker, platform
 * or Preview run: the session's records start empty. */
function history(first: { pathname: string; state?: Record<string, unknown> }) {
	const entries = [{ pathname: first.pathname, state: first.state ?? {} }];
	let at = 0;
	let records = new Map<string, PreviewEntryRecord>();
	const reader = (): PreviewEntryRecordOf => previewEntryRecordReader(records);
	const write = (written: BuilderHistoryWrite) => {
		const current = entries[at];
		const next = builderEntryState(
			{ ...current, record: reader()(previewEntryOf(current.state)) },
			written,
			reader(),
		);
		records.set(previewEntryOf(next.state) ?? "", next.record);
		const entry = { pathname: written.pathname, state: next.state };
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
		forward: () => {
			at += 1;
		},
		newSession: () => {
			records = new Map();
		},
		get records() {
			return reader();
		},
		get current() {
			return entries[at];
		},
	};
}

describe("a case list's held form menu on its history entry", () => {
	it("reads back the menu an entry was written with from the session's record, and keeps no case in the entry's state", () => {
		const several: PreviewHeldCaseListMenu = {
			...held,
			cases: [
				{ caseId: "ana", caseName: "Ana" },
				{ caseId: "bo", claimable: true as const },
			],
		};
		const h = history({ pathname: list, state: { __NA: true } });
		h.push(list, several);
		expect(readPreviewHeldMenu(h.current.state, h.records)).toEqual(several);
		expect(h.current.state.__NA).toBe(true);
		// The state names the entry; the cases are the session's.
		const kept = JSON.stringify(h.current.state);
		for (const value of ["ana", "Ana", "bo", "claimable"])
			expect(kept).not.toContain(value);
		// A history state survives structured cloning, as the browser stores it.
		expect(
			readPreviewHeldMenu(structuredClone(h.current.state), h.records),
		).toEqual(several);
	});

	it("drops the menu from every entry written without one", () => {
		const h = history({ pathname: list });
		h.push(list, held);
		h.push(form);
		expect(readPreviewHeldMenu(h.current.state, h.records)).toBeUndefined();
		h.back();
		h.replace(list);
		expect(readPreviewHeldMenu(h.current.state, h.records)).toBeUndefined();
	});

	it("holds nothing for a step an earlier Preview session took", () => {
		// A worker, platform or Preview run change starts a new session; Back
		// onto the menu's entry shows the list, not the last worker's case.
		const h = history({ pathname: list });
		h.push(list, held);
		h.newSession();
		expect(readPreviewHeldMenu(h.current.state, h.records)).toBeUndefined();
		expect(stepsOfPreviewHeldMenu(h.current.state, h.records)).toBe(0);
	});

	it("steps back off a menu pushed after its list onto the list", () => {
		const h = history({ pathname: list });
		h.push(list, held);
		expect(previewHeldMenuBack(h.current.state, h.records)).toEqual({
			kind: "step-back",
			steps: 1,
		});
		h.back();
		expect(readPreviewHeldMenu(h.current.state, h.records)).toBeUndefined();
	});

	it("steps back onto the list off a menu pushed from an entry holding an earlier session's menu, which shows the list", () => {
		// Ana chosen, then a change of worker or platform: Back onto Ana's
		// menu shows the list, and choosing Bo there is a step after it.
		const h = history({ pathname: list });
		h.push(list, held);
		h.newSession();
		const next: PreviewHeldCaseListMenu = {
			moduleUuid: menu,
			cases: [{ caseId: "bo", caseName: "Bo" }],
		};
		h.push(list, next);
		expect(previewHeldMenuBack(h.current.state, h.records)).toEqual({
			kind: "step-back",
			steps: 1,
		});
		// In place of Bo's details pushed from that entry, the same.
		h.back();
		h.push(details);
		h.replace(list, next);
		expect(previewHeldMenuBack(h.current.state, h.records)).toEqual({
			kind: "step-back",
			steps: 1,
		});
		// A menu the same session holds there is a menu, not its list.
		h.push(list, { ...held, cases: [{ caseId: "cy" }] });
		expect(previewHeldMenuBack(h.current.state, h.records)).toEqual({
			kind: "show-list",
		});
	});

	it("steps back onto the list Preview shows at the Search, Details or data review URL", () => {
		// Preview started on the Search or Details tab, or on the data review
		// screen, runs the list there.
		for (const tab of ["search", "details", "data-review"]) {
			const h = history({ pathname: `/build/app/${menu}/${tab}` });
			h.push(list, held);
			expect(previewHeldMenuBack(h.current.state, h.records)).toEqual({
				kind: "step-back",
				steps: 1,
			});
		}
		// The module's own URL is its menu screen, and another module's tabs
		// are another list.
		for (const pathname of [
			`/build/app/${menu}`,
			`/build/app/${testUuid("other")}/search`,
		]) {
			const h = history({ pathname });
			h.push(list, held);
			expect(previewHeldMenuBack(h.current.state, h.records)).toEqual({
				kind: "show-list",
			});
		}
	});

	it("steps back onto the list off a menu that replaced the case's details pushed from it", () => {
		const h = history({ pathname: list });
		h.push(details);
		h.replace(list, held);
		expect(previewHeldMenuBack(h.current.state, h.records)).toEqual({
			kind: "step-back",
			steps: 1,
		});
	});

	it("steps back onto the list past the case's details off a menu that replaced their copy under another language", () => {
		const h = history({ pathname: list });
		h.push(details);
		h.lens();
		h.lens();
		h.replace(list, held);
		// list, details, details (one language), menu: the menu's Back passes
		// the details left behind it and lands on the list.
		expect(previewHeldMenuBack(h.current.state, h.records)).toEqual({
			kind: "step-back",
			steps: 3,
		});
		// A language change on the menu adds its own copy.
		h.lens();
		expect(previewHeldMenuBack(h.current.state, h.records)).toEqual({
			kind: "step-back",
			steps: 4,
		});
		h.back(4);
		expect(h.current.pathname).toBe(list);
		expect(readPreviewHeldMenu(h.current.state, h.records)).toBeUndefined();
	});

	it("shows the list in the menu's own entry where no list entry is behind it", () => {
		// A deep-linked case's details opened in a fresh tab: nothing before.
		const fresh = history({ pathname: details });
		fresh.replace(list, held);
		expect(previewHeldMenuBack(fresh.current.state, fresh.records)).toEqual({
			kind: "show-list",
		});
		// Details reached from somewhere other than the list.
		const elsewhere = history({ pathname: form });
		elsewhere.push(details);
		elsewhere.replace(list, held);
		expect(
			previewHeldMenuBack(elsewhere.current.state, elsewhere.records),
		).toEqual({
			kind: "show-list",
		});
	});

	it("counts the menu's own entry and each language change made on it as one step", () => {
		const h = history({ pathname: list });
		expect(stepsOfPreviewHeldMenu(h.current.state, h.records)).toBe(0);
		h.push(list, held);
		expect(stepsOfPreviewHeldMenu(h.current.state, h.records)).toBe(1);
		const menuEntry = h.current.state.__novaEntry;
		h.lens();
		h.lens();
		expect(stepsOfPreviewHeldMenu(h.current.state, h.records)).toBe(3);
		// A lens copy holds the same menu, still after its list.
		expect(readPreviewHeldMenu(h.current.state, h.records)).toEqual(held);
		expect(previewHeldMenuBack(h.current.state, h.records)).toEqual({
			kind: "step-back",
			steps: 3,
		});
		h.back(3);
		expect(readPreviewHeldMenu(h.current.state, h.records)).toBeUndefined();
		// A gap another page wrote counts as the menu's own entry alone.
		expect(
			stepsOfPreviewHeldMenu(
				{ __novaEntry: menuEntry, __novaPreviousGap: -1 },
				h.records,
			),
		).toBe(1);
	});

	it("steps back from a form opened on the menu onto the menu, where its case's crumb leads", () => {
		const h = history({ pathname: list });
		h.push(list, held);
		h.push(form);
		expect(previewHeldMenuIsPrevious(h.current.state, held, h.records)).toBe(
			true,
		);
		// Other cases are not the menu behind it, nor is the menu in another
		// session's records.
		expect(
			previewHeldMenuIsPrevious(
				h.current.state,
				{ ...held, cases: [{ caseId: "bo" }] },
				h.records,
			),
		).toBe(false);
		expect(
			previewHeldMenuIsPrevious(
				h.current.state,
				held,
				previewEntryRecordReader(new Map()),
			),
		).toBe(false);
		h.back();
		// The menu stepped back to steps back again onto the list.
		expect(previewHeldMenuBack(h.current.state, h.records)).toEqual({
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
		expect(previewHeldMenuIsPrevious(h.current.state, held, h.records)).toBe(
			false,
		);
		h.push(list, held);
		expect(readPreviewHeldMenu(h.current.state, h.records)).toEqual(held);
		// The entry behind it is the form's, so the menu's Back cannot step
		// back to the list: the menu's entry becomes the list's.
		expect(previewHeldMenuBack(h.current.state, h.records)).toEqual({
			kind: "show-list",
		});
		expect(previewHeldMenuIsPrevious(h.current.state, held, h.records)).toBe(
			false,
		);
	});

	it("opens the menu again where the step back off a form lands on an entry that no longer holds it", () => {
		// A menu with no list behind it, a form opened from it, Back to the
		// menu, whose own Back shows the list in its entry, then Forward.
		const h = history({ pathname: form });
		h.push(list, held);
		expect(previewHeldMenuBack(h.current.state, h.records)).toEqual({
			kind: "show-list",
		});
		h.push(form);
		h.back();
		expect(previewHeldMenuStands(h.current.state, held, h.records)).toBe(true);
		h.replace(list);
		h.forward();
		// The form still records the menu's entry as the one before it, whose
		// record keeps the menu, so the crumb steps back, and the entry it
		// lands on holds no menu: the crumb opens the menu again on an entry
		// of its own.
		expect(previewHeldMenuIsPrevious(h.current.state, held, h.records)).toBe(
			true,
		);
		h.back();
		expect(previewHeldMenuStands(h.current.state, held, h.records)).toBe(false);
		// Other cases, or another session's records, are not this menu.
		h.push(list, held);
		expect(previewHeldMenuStands(h.current.state, held, h.records)).toBe(true);
		expect(
			previewHeldMenuStands(
				h.current.state,
				held,
				previewEntryRecordReader(new Map()),
			),
		).toBe(false);
		expect(
			previewHeldMenuStands(
				h.current.state,
				{ ...held, cases: [{ caseId: "bo" }] },
				h.records,
			),
		).toBe(false);
	});

	it("reads no menu from a state another page wrote", () => {
		const h = history({ pathname: list });
		for (const state of [
			null,
			"menu",
			{},
			// The cases in the state itself, as a page could write them.
			{
				__novaPreviewHeldMenu: {
					moduleUuid: menu,
					cases: [{ caseId: "a" }],
					session: "a",
				},
			},
			// An id this session never named.
			{ __novaEntry: "not-an-entry-of-this-session" },
			{ __novaEntry: 1 },
		]) {
			expect(readPreviewHeldMenu(state, h.records)).toBeUndefined();
			expect(previewHeldMenuIsPrevious(state, held, h.records)).toBe(false);
		}
	});
});

describe("a screen's own Back to the screen it was opened from", () => {
	const home = "/build/app";
	const followUps = `/build/app/${testUuid("follow-ups")}`;
	const followUpsList = `${followUps}/results`;
	const patientsList = `/build/app/${testUuid("patients")}/results`;

	it("steps back onto the menu a form's parent case was asked from, so the next Back reaches Home", () => {
		/* Home, the menu that lists its forms first, the form's command
		 * (its list's URL), which the parent's list replaces as it asks for
		 * the patient: the list's Back is the menu's entry behind it. */
		const h = history({ pathname: home });
		h.push(followUps);
		h.push(followUpsList);
		h.replace(patientsList);
		const steps = stepsBackToPrevious(h.current.state, followUps, h.records);
		expect(steps).toBe(1);
		h.back(steps);
		expect(h.current.pathname).toBe(followUps);
		// The menu's own entry is the step back from Home: none is written
		// after the list, so the browser's next Back lands on Home.
		expect(stepsBackToPrevious(h.current.state, home, h.records)).toBe(1);
		h.back();
		expect(h.current.pathname).toBe(home);
	});

	it("steps back past the list's copies under another language", () => {
		const h = history({ pathname: home });
		h.push(patientsList);
		h.lens();
		h.lens();
		const steps = stepsBackToPrevious(h.current.state, home, h.records);
		expect(steps).toBe(3);
		h.back(steps);
		expect(h.current.pathname).toBe(home);
	});

	it("names no step where the entry behind is another screen, a held menu, or unrecorded", () => {
		const h = history({ pathname: home });
		h.push(followUps);
		h.push(patientsList);
		// The screen asked from is not the one behind the list.
		expect(
			stepsBackToPrevious(h.current.state, home, h.records),
		).toBeUndefined();
		// A held form menu at the same URL is another screen than the list.
		const g = history({ pathname: list });
		g.push(list, held);
		g.push(patientsList);
		expect(
			stepsBackToPrevious(g.current.state, list, g.records),
		).toBeUndefined();
		// An earlier session's menu there shows the list now: the step lands
		// on it.
		g.newSession();
		expect(stepsBackToPrevious(g.current.state, list, g.records)).toBe(1);
		// A deep link's first entry records nothing before it.
		expect(stepsBackToPrevious({}, home, h.records)).toBeUndefined();
		expect(stepsBackToPrevious(undefined, home, h.records)).toBeUndefined();
	});
});
