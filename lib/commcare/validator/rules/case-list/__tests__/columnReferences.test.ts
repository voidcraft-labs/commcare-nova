import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { f } from "@/lib/__tests__/docHelpers";
import {
	calculatedColumn,
	dateColumn,
	plainColumn,
	proseText,
} from "@/lib/domain";
import { prop, term } from "@/lib/domain/predicate";
import {
	admittedCaseListDoc,
	findings,
	withColumns,
} from "./caseListRuleFixture";

const id = testUuid("column");
describe("column reference admission", () => {
	it("admits standard, declared-only, writer-derived and calculated references", () => {
		const base = admittedCaseListDoc({
			caseTypes: [
				{
					name: "patient",
					properties: [
						{
							name: "weight",
							label: proseText("Weight"),
							data_type: "decimal",
						},
					],
				},
			],
			fields: [
				f({
					kind: "int",
					id: "age",
					label: "Age",
					caseWrite: { caseType: "patient", property: "age" },
				}),
			],
		});
		const columns = [
			plainColumn(testUuid("name"), "case_name", "Name"),
			plainColumn(testUuid("weight"), "weight", "Weight"),
			plainColumn(testUuid("age"), "age", "Age"),
			calculatedColumn(
				testUuid("calc"),
				"Display name",
				term(prop("patient", "case_name")),
			),
		];
		expect(findings(withColumns(base, columns))).toEqual([]);
	});
	it("rejects unresolved fields even when hidden and unsorted or hidden and sorted", () => {
		const base = admittedCaseListDoc();
		for (const sort of [
			undefined,
			{ direction: "asc" as const, priority: 0 },
		]) {
			const column = plainColumn(id, "missing", "Missing", {
				visibleInList: false,
				visibleInDetail: false,
				...(sort ? { sort } : {}),
			});
			const result = findings(withColumns(base, [column]));
			expect(result.map((error) => error.code)).toEqual([
				"CASE_LIST_COLUMN_UNKNOWN_FIELD",
			]);
			expect(result[0].details).toEqual({
				field: "missing",
				columnUuid: id,
				index: "0",
			});
		}
	});
	it("leaves unknown-date-property rejection to reference resolution alone", () => {
		const result = findings(
			withColumns(admittedCaseListDoc(), [
				dateColumn(id, "missing", "Missing", "%Y-%m-%d"),
			]),
		);
		expect(result.map((error) => error.code)).toEqual([
			"CASE_LIST_COLUMN_UNKNOWN_FIELD",
		]);
	});
});
