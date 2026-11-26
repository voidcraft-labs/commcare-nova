import { describe, expect, it } from "vitest";
import { sourceUsesCaseListActionSetting } from "../caseListActionSetting";

/** An app whose one menu offers the form `reg` from its list with `label`. */
function appWith(label: unknown, langs = ["en", "fr"], formId = "reg") {
	return {
		langs,
		modules: [
			{
				unique_id: "m",
				case_type: "patient",
				forms: [{ unique_id: "reg", requires: "none" }],
				case_list_form: { form_id: formId, label },
			},
		],
	};
}

describe("whether a reading asks the source space's list action setting", () => {
	it.each([
		["holds no text at all", {}],
		["is empty in the language the build reads", { en: "" }],
		["is empty in one language and held in another", { en: "Add", fr: "" }],
	])(
		"asks where the button's label %s, since HQ's words depend on it",
		(_, label) => {
			expect(sourceUsesCaseListActionSetting(appWith(label))).toBe(true);
		},
	);

	it.each([
		["holds text in every language", { en: "Add", fr: "Ajouter" }],
		["holds text in a language the others fall back to", { en: "Add" }],
	])("leaves it where the button's label %s", (_, label) => {
		expect(sourceUsesCaseListActionSetting(appWith(label))).toBe(false);
	});

	it("leaves it where the action names no form", () => {
		expect(sourceUsesCaseListActionSetting(appWith({}, ["en"], ""))).toBe(
			false,
		);
	});
});
