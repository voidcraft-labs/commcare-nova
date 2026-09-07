import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { blueprintDocSchema, simpleSearchInputDef } from "@/lib/domain";
import { admittedCaseListDoc, findings } from "./caseListRuleFixture";

function candidate(names: string[]) {
	const base = admittedCaseListDoc();
	const id = base.moduleOrder[0];
	const module = base.modules[id];
	if (!module.caseListConfig) throw new Error("Missing admitted config");
	const searchInputs = names.map((name, index) =>
		simpleSearchInputDef(
			testUuid(`input-${index}`),
			name,
			`Input ${index + 1}`,
			"text",
			"case_name",
		),
	);
	const doc = {
		...base,
		modules: {
			...base.modules,
			[id]: {
				...module,
				caseListConfig: {
					...module.caseListConfig,

					searchInputs,
				},
			},
		},
	};
	blueprintDocSchema.parse(toPersistableDoc(doc));
	return { doc, searchInputs };
}
describe("search input name admission", () => {
	it("reports every later duplicate against the first identity without quadratic pairs", () => {
		const { doc, searchInputs: inputs } = candidate([
			"same",
			"unique",
			"same",
			"same",
		]);
		const errors = findings(doc);
		expect(errors.map((error) => error.code)).toEqual([
			"CASE_LIST_DUPLICATE_SEARCH_INPUT_NAME",
			"CASE_LIST_DUPLICATE_SEARCH_INPUT_NAME",
		]);
		expect(errors.map((error) => error.details)).toEqual(
			[2, 3].map((index) => ({
				inputName: "same",
				firstIndex: "0",
				duplicateIndex: String(index),
				firstUuid: inputs[0].uuid,
				duplicateUuid: inputs[index].uuid,
			})),
		);
	});
	it("admits zero, one and distinct case-sensitive names", () => {
		for (const names of [[], ["one"], ["name", "Name", "constructor"]])
			expect(findings(candidate(names).doc)).toEqual([]);
	});
});
