import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { plainColumn } from "@/lib/domain";
import {
	admittedCaseListDoc,
	findings,
	withColumns,
} from "./caseListRuleFixture";

describe("sort priority admission in Results order", () => {
	it("reports each duplicate against the first visible-order identity, including hidden sorted columns", () => {
		const base = admittedCaseListDoc();
		const columns = ["A", "B", "C"].map((name) =>
			plainColumn(testUuid(name), "case_name", name, {
				sort: { direction: "asc", priority: 0 },
				visibleInList: false,
				visibleInDetail: false,
			}),
		);
		const [a, b, c] = columns;
		const result = findings(
			withColumns(base, columns, [c.uuid, a.uuid, b.uuid]),
		);
		expect(result.map((error) => error.code)).toEqual([
			"CASE_LIST_DUPLICATE_SORT_PRIORITY",
			"CASE_LIST_DUPLICATE_SORT_PRIORITY",
		]);
		expect(result.map((error) => error.details)).toEqual([
			{
				priority: "0",
				firstIndex: "0",
				duplicateIndex: "1",
				firstUuid: c.uuid,
				duplicateUuid: a.uuid,
			},
			{
				priority: "0",
				firstIndex: "0",
				duplicateIndex: "2",
				firstUuid: c.uuid,
				duplicateUuid: b.uuid,
			},
		]);
	});
	it("admits no sort, one sort, and distinct priorities independent of source order", () => {
		const base = admittedCaseListDoc();
		for (const priorities of [[], [0], [9, 2, 7]]) {
			const columns = priorities.map((priority, index) =>
				plainColumn(testUuid(String(index)), "case_name", `Column ${index}`, {
					sort: { direction: "asc", priority },
				}),
			);
			expect(findings(withColumns(base, columns))).toEqual([]);
		}
	});
});
