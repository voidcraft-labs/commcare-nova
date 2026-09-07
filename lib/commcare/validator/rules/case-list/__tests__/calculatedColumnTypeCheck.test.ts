import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { f } from "@/lib/__tests__/docHelpers";
import { calculatedColumn } from "@/lib/domain";
import { arith, prop, term } from "@/lib/domain/predicate";
import {
	admittedCaseListDoc,
	findings,
	withColumns,
} from "./caseListRuleFixture";

const id = testUuid("calculated");
describe("calculated column type admission", () => {
	const base = () =>
		admittedCaseListDoc({
			fields: [
				f({
					kind: "int",
					id: "age",
					label: "Age",
					caseWrite: { caseType: "patient", property: "age" },
				}),
				f({
					kind: "text",
					id: "nickname",
					label: "Nickname",
					caseWrite: { caseType: "patient", property: "nickname" },
				}),
			],
		});
	it("accepts numeric arithmetic and writer-derived and standard properties", () => {
		for (const expression of [
			arith("+", term(prop("patient", "age")), term(prop("patient", "age"))),
			term(prop("patient", "nickname")),
			term(prop("patient", "case_name")),
		])
			expect(
				findings(
					withColumns(base(), [calculatedColumn(id, "Value", expression)]),
				),
			).toEqual([]);
	});
	it.each(["case_name", "nickname"])(
		"reports both nonnumeric operands from %s with stable identity and AST paths",
		(property) => {
			const expression = arith(
				"+",
				term(prop("patient", property)),
				term(prop("patient", property)),
			);
			const column = calculatedColumn(id, "Bad arithmetic", expression, {
				visibleInList: false,
				visibleInDetail: false,
			});
			const errors = findings(withColumns(base(), [column]));
			expect(errors.map((error) => error.code)).toEqual([
				"CASE_LIST_CALCULATED_COLUMN_TYPE_ERROR",
				"CASE_LIST_CALCULATED_COLUMN_TYPE_ERROR",
			]);
			expect(errors.map((error) => error.details)).toEqual([
				{ index: "0", columnUuid: id, path: "left" },
				{ index: "0", columnUuid: id, path: "right" },
			]);
		},
	);
	it("identifies an unknown property without a redundant ordinary-column error", () => {
		const errors = findings(
			withColumns(base(), [
				calculatedColumn(id, "Unknown", term(prop("patient", "ghost"))),
			]),
		);
		expect(errors.map((error) => error.code)).toEqual([
			"CASE_LIST_CALCULATED_COLUMN_TYPE_ERROR",
		]);
		expect(errors[0].details?.columnUuid).toBe(id);
		expect(errors[0].message).toContain("Unknown property 'ghost'");
	});
});
