/**
 * Tests for `sortPriorityUniqueness`. The rule rejects two sorted
 * columns sharing the same `sort.priority` — the wire layer
 * tie-breaks to source-index, but the authored intent ("two primary
 * sorts") is structurally undefined.
 */

import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { asUuid, plainColumn } from "@/lib/domain";
import { runValidation } from "../../../runner";

const CODE = "CASE_LIST_DUPLICATE_SORT_PRIORITY" as const;

const standardForm = {
	name: "Reg",
	type: "registration" as const,
	fields: [
		f({
			kind: "text" as const,
			id: "case_name",
			label: "Name",
			case_property_on: "patient",
		}),
	],
};

const standardCaseTypes = [
	{
		name: "patient",
		properties: [
			{ name: "case_name", label: "Name", data_type: "text" as const },
			{ name: "age", label: "Age", data_type: "int" as const },
		],
	},
];

describe("sortPriorityUniqueness", () => {
	it("fires when two sorted columns share a priority", () => {
		const colA = plainColumn(asUuid("col-a"), "case_name", "Name");
		const colB = plainColumn(asUuid("col-b"), "age", "Age");
		const doc = buildDoc({
			appName: "T",
			modules: [
				{
					name: "Mod",
					caseType: "patient",
					caseListConfig: {
						columns: [
							{ ...colA, sort: { direction: "asc", priority: 0 } },
							{ ...colB, sort: { direction: "asc", priority: 0 } },
						],
						searchInputs: [],
					},
					forms: [standardForm],
				},
			],
			caseTypes: standardCaseTypes,
		});
		const hits = runValidation(doc).filter((e) => e.code === CODE);
		expect(hits).toHaveLength(1);
		expect(hits[0].message).toContain("priority 0");
		// Both row labels surface so the editor highlights both rows.
		expect(hits[0].message).toContain('"Name"');
		expect(hits[0].message).toContain('"Age"');
	});

	it("is silent when priorities are unique across sorted columns", () => {
		const colA = plainColumn(asUuid("col-a"), "case_name", "Name");
		const colB = plainColumn(asUuid("col-b"), "age", "Age");
		const doc = buildDoc({
			appName: "T",
			modules: [
				{
					name: "Mod",
					caseType: "patient",
					caseListConfig: {
						columns: [
							{ ...colA, sort: { direction: "asc", priority: 0 } },
							{ ...colB, sort: { direction: "asc", priority: 1 } },
						],
						searchInputs: [],
					},
					forms: [standardForm],
				},
			],
			caseTypes: standardCaseTypes,
		});
		const hits = runValidation(doc).filter((e) => e.code === CODE);
		expect(hits).toHaveLength(0);
	});

	it("is silent when at most one column carries a sort directive", () => {
		const col = plainColumn(asUuid("col-a"), "case_name", "Name");
		const doc = buildDoc({
			appName: "T",
			modules: [
				{
					name: "Mod",
					caseType: "patient",
					caseListConfig: {
						columns: [
							{ ...col, sort: { direction: "asc", priority: 0 } },
							plainColumn(asUuid("col-b"), "age", "Age"),
						],
						searchInputs: [],
					},
					forms: [standardForm],
				},
			],
			caseTypes: standardCaseTypes,
		});
		const hits = runValidation(doc).filter((e) => e.code === CODE);
		expect(hits).toHaveLength(0);
	});
});
