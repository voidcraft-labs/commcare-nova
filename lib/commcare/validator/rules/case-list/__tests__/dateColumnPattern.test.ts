import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { dateColumn } from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";
import {
	admittedCaseListDoc,
	findings,
	withColumns,
} from "./caseListRuleFixture";

const caseTypes = [
	{
		name: "patient",
		properties: [
			{
				name: "visit_date",
				label: proseText("Visit date"),
				data_type: "date" as const,
			},
		],
	},
];

function visitColumn(pattern: string) {
	return dateColumn(testUuid("visit"), "visit_date", "Visited", pattern);
}

describe("date column pattern apostrophe", () => {
	it("refuses a pattern holding a straight apostrophe", () => {
		const column = visitColumn("%d %b '%y");
		const result = findings(
			withColumns(admittedCaseListDoc({ caseTypes }), [column]),
		);
		expect(result).toHaveLength(1);
		expect(result[0]).toMatchObject({
			code: "CASE_LIST_DATE_PATTERN_APOSTROPHE",
			location: { moduleName: "Patients" },
			details: {
				slot: "caseListConfig.columns[0].pattern",
				columnIndex: "0",
				columnUuid: column.uuid,
				pattern: "%d %b '%y",
			},
		});
		expect(result[0].message).toBe(
			`Date column "Visited" (column #1) on module "Patients" has the pattern "%d %b '%y", which holds a straight apostrophe ('). CommCare HQ's date column has no way to store one. Use a curved one (’) instead.`,
		);
	});

	it.each(["%d %b ’%y", "%Y-%m-%d", '%d" %m', "Visited"])(
		"accepts %s",
		(pattern) => {
			expect(
				findings(
					withColumns(admittedCaseListDoc({ caseTypes }), [
						visitColumn(pattern),
					]),
				),
			).toEqual([]);
		},
	);
});
