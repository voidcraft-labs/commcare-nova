import { describe, expect, it } from "vitest";
import { PLATFORMS } from "@/lib/domain/platforms";
import {
	type DisplayConditionCarrier,
	displayConditionCopy,
	FIRST_MENU_NAME,
	formOffTheMenuNote,
	moduleOffTheMenuNote,
} from "../displayConditionCopy";

/** The copy for an app that runs on both platforms. */
function copyOf(carrier: DisplayConditionCarrier) {
	return displayConditionCopy(carrier, PLATFORMS);
}

describe("displayConditionCopy", () => {
	it("gives a module condition the no-case scope", () => {
		const copy = copyOf({
			kind: "module",
			moduleName: "Mothers",
			moduleIsBareCaseList: false,
			formsInMenuAbove: false,
			aboveName: FIRST_MENU_NAME,
		});
		expect(copy.title).toBe("When “Mothers” appears");
		expect(copy.locus.join(" ")).toContain("home screen");
		expect(copy.scopeNote).toContain("No case has been chosen");
	});

	it("names a bare case list's own screen in the module locus", () => {
		const withList = copyOf({
			kind: "module",
			moduleName: "Clinics",
			moduleIsBareCaseList: true,
			formsInMenuAbove: false,
			aboveName: FIRST_MENU_NAME,
		});
		const withForms = copyOf({
			kind: "module",
			moduleName: "Clinics",
			moduleIsBareCaseList: false,
			formsInMenuAbove: false,
			aboveName: FIRST_MENU_NAME,
		});
		expect(withList.locus[0]).toContain("case list");
		expect(withForms.locus[0]).not.toContain("case list");
	});

	it("places a child module condition on its parent menu", () => {
		const copy = copyOf({
			kind: "module",
			moduleName: "Visits",
			parentModuleName: "Mothers",
			moduleIsBareCaseList: true,
			formsInMenuAbove: false,
			aboveName: "Mothers",
		});
		expect(copy.lede).toContain("submenu inside “Mothers”");
		expect(copy.locus.join(" ")).toContain("inside “Mothers”");
		expect(copy.locus.join(" ")).not.toContain("home screen");
		expect(copy.settingDescription).toContain("“Mothers”");
		expect(copy.clearConsequence).toContain("in “Mothers”");
	});

	it("gives a case-first form the selected-case scope and names the case type", () => {
		const copy = copyOf({
			kind: "form",
			formName: "Postnatal visit",
			moduleName: "Mothers",
			caseFirst: true,
			caseType: "mother",
			formCount: 3,
		});
		expect(copy.locus.join(" ")).toContain("mother");
		expect(copy.scopeNote).toBe(
			"The chosen mother's own information is available here. Information from connected cases, and counts of them, is not. CommCare cannot reach them from this screen.",
		);
	});

	it("warns a single case-first form that a non-matching case stops at the list", () => {
		const single = copyOf({
			kind: "form",
			formName: "Visit",
			moduleName: "Mothers",
			caseFirst: true,
			caseType: "mother",
			formCount: 1,
		});
		const several = copyOf({
			kind: "form",
			formName: "Visit",
			moduleName: "Mothers",
			caseFirst: true,
			caseType: "mother",
			formCount: 2,
		});
		expect(single.locus.join(" ")).toContain("only form here");
		expect(several.locus.join(" ")).not.toContain("only form here");
	});

	it("gives a forms-first form the no-case scope", () => {
		const copy = copyOf({
			kind: "form",
			formName: "Register",
			moduleName: "Mothers",
			caseFirst: false,
			caseType: "mother",
			formCount: 2,
		});
		expect(copy.locus.join(" ")).toContain("starts a new case");
		expect(copy.scopeNote).toContain("No case has been chosen");
	});

	it("falls back to the plain word when the module declares no case type", () => {
		const copy = copyOf({
			kind: "form",
			formName: "Visit",
			moduleName: "Records",
			caseFirst: true,
			caseType: undefined,
			formCount: 1,
		});
		expect(copy.locus.join(" ")).toContain("case");
		expect(copy.locus.join(" ")).not.toContain("undefined");
	});

	it("says what still opens an item off the menu, per platform, and heads the condition with where it applies", () => {
		const module = copyOf({
			kind: "module",
			moduleName: "Archive",
			moduleIsBareCaseList: false,
			formsInMenuAbove: false,
			aboveName: FIRST_MENU_NAME,
		});
		const form = copyOf({
			kind: "form",
			formName: "Review",
			moduleName: "Archive",
			caseFirst: false,
			caseType: undefined,
			formCount: 2,
		});
		expect(module.menuSwitchLabel).toBe("Show on the menu");
		expect(form.menuSwitchLabel).toBe("Show on the menu");
		expect(module.settingTitle).toBe("When shown on the menu");
		expect(form.settingTitle).toBe("When shown on the menu");
		expect(form.offTheMenuNote).toBe(
			"Off the menu. On Android this form opens from an after-submit link or an entry point. In Web Apps it opens only from an entry point that ignores display conditions.",
		);
		expect(module.offTheMenuNote).toBe(
			"Off the menu, with every form in it. On Android its forms open from an after-submit link or an entry point. In Web Apps they open only from an entry point that ignores display conditions.",
		);
		expect(form.onTheMenuNote).toBe("Workers find this form in “Archive”.");
	});

	it("says only what still opens an item on the platforms the app runs on", () => {
		expect(formOffTheMenuNote(["android"])).toBe(
			"Off the menu. On Android this form opens from an after-submit link or an entry point.",
		);
		expect(formOffTheMenuNote(["web-apps"])).toBe(
			"Off the menu. In Web Apps this form opens only from an entry point that ignores display conditions.",
		);
		expect(moduleOffTheMenuNote(["android"])).toBe(
			"Off the menu, with every form in it. On Android its forms open from an after-submit link or an entry point.",
		);
		expect(moduleOffTheMenuNote(["web-apps"])).toBe(
			"Off the menu, with every form in it. In Web Apps its forms open only from an entry point that ignores display conditions.",
		);
		expect(formOffTheMenuNote(PLATFORMS)).toBe(
			copyOf({
				kind: "form",
				formName: "Review",
				moduleName: "Archive",
				caseFirst: false,
				caseType: undefined,
				formCount: 2,
			}).offTheMenuNote,
		);
		expect(
			displayConditionCopy(
				{
					kind: "module",
					moduleName: "Archive",
					moduleIsBareCaseList: false,
					formsInMenuAbove: false,
					aboveName: FIRST_MENU_NAME,
				},
				["web-apps"],
			).offTheMenuNote,
		).toBe(moduleOffTheMenuNote(["web-apps"]));
	});

	it("says a menu that shows its forms above is checked where its forms list, with its parent's condition", () => {
		const copy = copyOf({
			kind: "module",
			moduleName: "Members",
			parentModuleName: "Households",
			moduleIsBareCaseList: false,
			formsInMenuAbove: true,
			aboveName: "Households",
		});
		expect(copy.locus).toEqual([
			"CommCare checks this in “Households”.",
			"While it's false, “Members”'s forms don't show there.",
			"“Households”'s condition applies to them too.",
		]);
		expect(copy.offTheMenuNote).toMatch(
			/^“Members”'s forms are off “Households”\. On Android/,
		);
		const topLevel = copyOf({
			kind: "module",
			moduleName: "Registration",
			moduleIsBareCaseList: false,
			formsInMenuAbove: true,
			aboveName: FIRST_MENU_NAME,
		});
		expect(topLevel.locus).toEqual([
			"CommCare checks this in the app's first menu.",
			"While it's false, “Registration”'s forms don't show there.",
		]);
	});

	it("names the app's first menu for a submenu under a parent that shows its forms above", () => {
		const copy = copyOf({
			kind: "module",
			moduleName: "Water",
			parentModuleName: "Households",
			moduleIsBareCaseList: false,
			formsInMenuAbove: false,
			aboveName: FIRST_MENU_NAME,
		});
		expect(copy.locus[0]).toBe(
			"CommCare checks this on the app's first menu, before anyone opens “Water”.",
		);
	});

	it("says which menu keeps a form's screen forms first", () => {
		const copy = copyOf({
			kind: "form",
			formName: "Check members",
			moduleName: "Members",
			caseFirst: false,
			caseFirstBlocker: {
				reason: "opens-without-a-case",
				otherModuleName: "Households",
				blockingFormName: "Register household",
			},
			caseType: "household",
			formCount: 1,
		});
		expect(copy.locus[0]).toContain(
			"shows with “Households”'s forms on one screen, and “Register household” there opens without a case",
		);
		expect(
			copyOf({
				kind: "form",
				formName: "Check members",
				moduleName: "Members",
				caseFirst: false,
				caseFirstBlocker: { reason: "first-menu" },
				caseType: "household",
				formCount: 1,
			}).locus[0],
		).toContain("shows on the app's first menu");
	});
});
