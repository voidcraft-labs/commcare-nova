import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { blueprintDocSchema, type CaseSearchConfig } from "@/lib/domain";
import {
	eq,
	exists,
	gt,
	input,
	literal,
	prop,
	sessionContext,
	subcasePath,
} from "@/lib/domain/predicate";
import {
	admittedCaseListDoc,
	findings,
} from "../../case-list/__tests__/caseListRuleFixture";

function candidate(config: CaseSearchConfig | undefined) {
	const base = admittedCaseListDoc({
		caseTypes: [
			{ name: "patient", properties: [] },
			{ name: "visit", parent_type: "patient", properties: [] },
		],
	});
	const id = base.moduleOrder[0];
	const doc = {
		...base,
		modules: {
			...base.modules,
			[id]: { ...base.modules[id], caseSearchConfig: config },
		},
	};
	blueprintDocSchema.parse(toPersistableDoc(doc));
	return doc;
}
const caseData = "CASE_SEARCH_BUTTON_DISPLAY_CONDITION_CASE_DATA_UNAVAILABLE";
const typeError = "CASE_SEARCH_BUTTON_DISPLAY_CONDITION_TYPE_ERROR";
describe("Search action condition admission", () => {
	it.each([
		{
			condition: eq(prop("patient", "case_name"), literal("A")),
			codes: [caseData],
		},
		{ condition: exists(subcasePath("parent", "visit")), codes: [caseData] },
		{
			condition: gt(sessionContext("username"), literal("M")),
			codes: [typeError],
		},
		{ condition: eq(sessionContext("username"), literal("A")), codes: [] },
	])(
		"checks $condition.kind with complete findings",
		({ condition, codes }) => {
			const errors = findings(
				candidate({ searchButtonDisplayCondition: condition }),
			);
			expect(errors.map((error) => error.code)).toEqual(codes);
			if (errors.length)
				expect(errors[0].details?.slot).toBe(
					"caseSearchConfig.searchButtonDisplayCondition",
				);
		},
	);
	it("reports both an orphan identity and an unavailable input context without exposing the UUID in type prose", () => {
		const errors = findings(
			candidate({
				searchButtonDisplayCondition: eq(
					input(testUuid("ghost")),
					literal("x"),
				),
			}),
		);
		expect(errors.map((error) => error.code).sort()).toEqual(
			[typeError, "CASE_LIST_BARE_SEARCH_INPUT_REF"].sort(),
		);
		const typed = errors.find((error) => error.code === typeError);
		expect(typed?.message).toMatch(/Search field/i);
		expect(typed?.message).not.toContain(testUuid("ghost"));
	});
	it.each([undefined, {}])("admits the absent condition %j", (config) =>
		expect(findings(candidate(config))).toEqual([]),
	);
	it("reports independently invalid button and assignment slots together", () => {
		const errors = findings(
			candidate({
				searchButtonDisplayCondition: eq(
					prop("patient", "case_name"),
					literal("A"),
				),
				excludedOwnerIds: { kind: "term", term: prop("patient", "owner_id") },
			}),
		);
		expect(errors.map((error) => error.code).sort()).toEqual(
			[caseData, "CASE_SEARCH_EXCLUDED_OWNER_IDS_CASE_DATA_UNAVAILABLE"].sort(),
		);
	});
});
