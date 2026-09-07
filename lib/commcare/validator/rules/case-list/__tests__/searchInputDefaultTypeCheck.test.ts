import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { advancedSearchInputDef, simpleSearchInputDef } from "@/lib/domain";
import {
	concat,
	dateCoerce,
	matchAll,
	now,
	prop,
	term,
	today,
	type ValueExpression,
} from "@/lib/domain/predicate";
import {
	admittedCaseListDoc,
	findings,
	withSearchInputs,
} from "./caseListRuleFixture";

describe("search starting-value admission", () => {
	it.each(["simple", "advanced"] as const)(
		"refuses a case read on the %s arm before generic typing",
		(kind) => {
			const options = { default: term(prop("patient", "case_name")) };
			const input =
				kind === "simple"
					? simpleSearchInputDef(
							testUuid("p"),
							"name",
							"Name",
							"text",
							"case_name",
							options,
						)
					: advancedSearchInputDef(
							testUuid("p"),
							"name",
							"Name",
							"text",
							matchAll(),
							options,
						);
			const result = findings(withSearchInputs(admittedCaseListDoc(), [input]));
			expect(result.map((error) => error.code)).toEqual([
				"CASE_LIST_SEARCH_INPUT_DEFAULT_CASE_DATA_UNAVAILABLE",
			]);
			expect(result[0].details).toMatchObject({
				inputUuid: testUuid("p"),
				slot: "caseListConfig.searchInputs[0].default",
			});
		},
	);
	it.each([
		{ type: "text", value: today(), valid: false },
		{ type: "text", value: concat(today()), valid: true },
		{ type: "date", value: now(), valid: false },
		{ type: "date", value: dateCoerce(now()), valid: true },
		{ type: "date", value: today(), valid: true },
		{ type: "text", value: undefined, valid: true },
	] satisfies {
		type: "text" | "date";
		value: ValueExpression | undefined;
		valid: boolean;
	}[])("$type with $value.kind", ({ type, value, valid }) => {
		const input = simpleSearchInputDef(
			testUuid("p"),
			"q",
			"Query",
			type,
			type === "date" ? "date_opened" : "case_name",
			{ default: value },
		);
		const result = findings(withSearchInputs(admittedCaseListDoc(), [input]));
		expect(result.map((error) => error.code)).toEqual(
			valid ? [] : ["CASE_LIST_SEARCH_INPUT_DEFAULT_TYPE_ERROR"],
		);
		if (!valid) expect(result[0].details?.expectedType).toBe(type);
	});
	it("retains each failing input identity in one candidate", () => {
		const inputs = ["first", "second"].map((name) =>
			simpleSearchInputDef(testUuid(name), name, name, "text", "case_name", {
				default: today(),
			}),
		);
		const result = findings(withSearchInputs(admittedCaseListDoc(), inputs));
		expect(
			result.map((error) => ({
				code: error.code,
				id: error.details?.inputUuid,
			})),
		).toEqual(
			inputs.map((input) => ({
				code: "CASE_LIST_SEARCH_INPUT_DEFAULT_TYPE_ERROR",
				id: input.uuid,
			})),
		);
	});
});
