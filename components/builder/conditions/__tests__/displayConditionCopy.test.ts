import { describe, expect, it } from "vitest";
import {
	DISPLAY_CONDITION_NOT_A_PERMISSION,
	displayConditionCopy,
} from "../displayConditionCopy";

describe("displayConditionCopy", () => {
	it("gives a module condition the no-case scope", () => {
		const copy = displayConditionCopy({
			kind: "module",
			moduleName: "Mothers",
			moduleIsBareCaseList: false,
		});
		expect(copy.caseDataScope).toBe("global");
		expect(copy.title).toBe("When “Mothers” appears");
		expect(copy.locus.join(" ")).toContain("home screen");
		expect(copy.scopeNote).toContain("No case has been chosen");
	});

	it("names a bare case list's own screen in the module locus", () => {
		const withList = displayConditionCopy({
			kind: "module",
			moduleName: "Clinics",
			moduleIsBareCaseList: true,
		});
		const withForms = displayConditionCopy({
			kind: "module",
			moduleName: "Clinics",
			moduleIsBareCaseList: false,
		});
		expect(withList.locus[0]).toContain("case list");
		expect(withForms.locus[0]).not.toContain("case list");
	});

	it("places a child module condition on its parent menu", () => {
		const copy = displayConditionCopy({
			kind: "module",
			moduleName: "Visits",
			parentModuleName: "Mothers",
			moduleIsBareCaseList: true,
		});
		expect(copy.lede).toContain("submenu inside “Mothers”");
		expect(copy.locus.join(" ")).toContain("inside “Mothers”");
		expect(copy.locus.join(" ")).not.toContain("home screen");
		expect(copy.settingDescription).toContain("“Mothers”");
		expect(copy.clearConsequence).toContain("in “Mothers”");
	});

	it("gives a case-first form the selected-case scope and names the case type", () => {
		const copy = displayConditionCopy({
			kind: "form",
			formName: "Postnatal visit",
			moduleName: "Mothers",
			caseFirst: true,
			caseType: "mother",
			formCount: 3,
		});
		expect(copy.caseDataScope).toBe("selected-case");
		expect(copy.locus.join(" ")).toContain("mother");
		expect(copy.scopeNote).toContain("connected cases");
	});

	it("warns a single case-first form that a non-matching case stops at the list", () => {
		const single = displayConditionCopy({
			kind: "form",
			formName: "Visit",
			moduleName: "Mothers",
			caseFirst: true,
			caseType: "mother",
			formCount: 1,
		});
		const several = displayConditionCopy({
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
		const copy = displayConditionCopy({
			kind: "form",
			formName: "Register",
			moduleName: "Mothers",
			caseFirst: false,
			caseType: "mother",
			formCount: 2,
		});
		expect(copy.caseDataScope).toBe("global");
		expect(copy.locus.join(" ")).toContain("starts a new case");
		expect(copy.scopeNote).toContain("No case has been chosen");
	});

	it("falls back to the plain word when the module declares no case type", () => {
		const copy = displayConditionCopy({
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

	// Stated as the always-true fact: what a condition decides, rather
	// than by naming a bypass Nova does not author today.
	it("says a condition governs what is offered, not who may see the data", () => {
		expect(DISPLAY_CONDITION_NOT_A_PERMISSION).toContain(
			"not who may see the data",
		);
		expect(DISPLAY_CONDITION_NOT_A_PERMISSION).not.toContain("direct link");
	});
});
