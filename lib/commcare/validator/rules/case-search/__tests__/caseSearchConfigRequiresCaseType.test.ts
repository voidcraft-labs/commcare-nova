import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { blueprintDocSchema, simpleSearchInputDef } from "@/lib/domain";
import {
	admittedCaseListDoc,
	findings,
	withSearchInputs,
} from "../../case-list/__tests__/caseListRuleFixture";

describe("effective Search requires a case type", () => {
	it.each(["settings", "inputs"] as const)(
		"refuses %s on an otherwise admitted survey module",
		(activation) => {
			const base = buildDoc({
				appName: "Survey",
				modules: [
					{
						name: "Surveys",
						forms: [
							{
								name: "Survey",
								type: "survey",
								fields: [f({ kind: "text", id: "answer", label: "Answer" })],
							},
						],
					},
				],
			});
			blueprintDocSchema.parse(toPersistableDoc(base));
			expect(findings(base)).toEqual([]);
			const id = base.moduleOrder[0];
			const doc =
				activation === "settings"
					? {
							...base,
							modules: {
								...base.modules,
								[id]: { ...base.modules[id], caseSearchConfig: {} },
							},
						}
					: {
							...base,
							modules: {
								...base.modules,
								[id]: {
									...base.modules[id],
									caseListConfig: {
										columns: [],
										listColumnOrder: [],
										detailColumnOrder: [],
										searchInputs: [
											simpleSearchInputDef(
												testUuid("q"),
												"case_name",
												"Name",
												"text",
												"case_name",
											),
										],
									},
								},
							},
						};
			blueprintDocSchema.parse(toPersistableDoc(doc));
			expect(findings(doc).map((error) => error.code)).toEqual([
				"CASE_SEARCH_CONFIG_REQUIRES_CASE_TYPE",
			]);
		},
	);
	it("admits search inputs on a typed module and ordinary case browsing without search", () => {
		const base = admittedCaseListDoc();
		expect(findings(base)).toEqual([]);
		expect(
			findings(
				withSearchInputs(base, [
					simpleSearchInputDef(
						testUuid("q"),
						"case_name",
						"Name",
						"text",
						"case_name",
					),
				]),
			),
		).toEqual([]);
	});
});
