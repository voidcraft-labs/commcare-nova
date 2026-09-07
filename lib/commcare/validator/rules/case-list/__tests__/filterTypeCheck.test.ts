import { describe, expect, it } from "vitest";
import { f } from "@/lib/__tests__/docHelpers";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { blueprintDocSchema } from "@/lib/domain";
import { eq, gt, literal, type Predicate, prop } from "@/lib/domain/predicate";
import { admittedCaseListDoc, findings } from "./caseListRuleFixture";

function candidate(filter: Predicate) {
	const base = admittedCaseListDoc({
		fields: [
			f({
				kind: "text",
				id: "nickname",
				label: "Nickname",
				caseWrite: { caseType: "patient", property: "nickname" },
			}),
		],
	});
	const id = base.moduleOrder[0];
	const module = base.modules[id];
	if (!module.caseListConfig) throw new Error("Missing admitted config");
	const doc = {
		...base,
		modules: {
			...base.modules,
			[id]: {
				...module,
				caseListConfig: { ...module.caseListConfig, searchInputs: [], filter },
			},
		},
	};
	blueprintDocSchema.parse(toPersistableDoc(doc));
	return doc;
}
describe("case-list filter type admission", () => {
	it.each(["nickname", "case_name"])(
		"accepts equality using the effective %s property",
		(property) =>
			expect(
				findings(candidate(eq(prop("patient", property), literal("Alice")))),
			).toEqual([]),
	);
	it.each([
		{
			name: "unordered text",
			predicate: gt(prop("patient", "nickname"), literal("M")),
			message: "ordered",
		},
		{
			name: "unknown property",
			predicate: eq(prop("patient", "ghost"), literal("x")),
			message: "Unknown property 'ghost'",
		},
		{
			name: "standard datetime mismatch",
			predicate: eq(prop("patient", "date_opened"), literal("not-a-date")),
			message: "Type mismatch",
		},
	])("$name", ({ predicate, message }) => {
		const errors = findings(candidate(predicate));
		expect(errors.map((error) => error.code)).toEqual([
			"CASE_LIST_FILTER_TYPE_ERROR",
		]);
		expect(errors[0].message).toContain(message);
	});
});
