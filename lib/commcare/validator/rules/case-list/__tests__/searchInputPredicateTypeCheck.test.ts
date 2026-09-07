import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { advancedSearchInputDef, simpleSearchInputDef } from "@/lib/domain";
import {
	eq,
	gt,
	input,
	literal,
	prop,
	whenInput,
} from "@/lib/domain/predicate";
import {
	admittedCaseListDoc,
	findings,
	withSearchInputs,
} from "./caseListRuleFixture";

const sibling = simpleSearchInputDef(
	testUuid("sibling"),
	"name",
	"Name",
	"text",
	"case_name",
);
describe("advanced search predicate admission", () => {
	it.each([
		{
			predicate: gt(prop("patient", "case_name"), literal("M")),
			message: "ordered",
		},
		{
			predicate: eq(prop("patient", "ghost"), literal("x")),
			message: "Unknown property",
		},
	])("refuses $message", ({ predicate, message }) => {
		const result = findings(
			withSearchInputs(admittedCaseListDoc(), [
				advancedSearchInputDef(
					testUuid("a"),
					"advanced",
					"Advanced",
					"text",
					predicate,
				),
			]),
		);
		expect(result.map((error) => error.code)).toEqual([
			"CASE_LIST_SEARCH_INPUT_PREDICATE_TYPE_ERROR",
		]);
		expect(result[0].message).toContain(message);
		expect(result[0].details?.inputUuid).toBe(testUuid("a"));
	});
	it("admits a guarded cross-input reference and refuses the same reference unguarded", () => {
		const predicate = eq(prop("patient", "case_name"), input(sibling.uuid));
		const base = admittedCaseListDoc();
		for (const guarded of [true, false]) {
			const advanced = advancedSearchInputDef(
				testUuid("a"),
				"advanced",
				"Advanced",
				"text",
				guarded ? whenInput(input(sibling.uuid), predicate) : predicate,
			);
			expect(
				findings(withSearchInputs(base, [sibling, advanced])).map(
					(error) => error.code,
				),
			).toEqual(guarded ? [] : ["CASE_LIST_BARE_SEARCH_INPUT_REF"]);
		}
	});
});
