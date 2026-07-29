import { describe, expect, it } from "vitest";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import {
	asUuid,
	type CaseOperation,
	type LookupColumnId,
	type LookupTableId,
	type Uuid,
} from "@/lib/domain";
import {
	eq,
	literal,
	tableColumn,
	tableLookup,
	term,
} from "@/lib/domain/predicate";
import { caseOperationProgramLookupTableIds } from "../caseDataBindingHelpers";

const tableId = (suffix: string) =>
	`00000000-0000-7000-8000-${suffix.padStart(12, "0")}` as LookupTableId;
const columnId = (suffix: string) =>
	`10000000-0000-7000-8000-${suffix.padStart(12, "0")}` as LookupColumnId;

function lookup(table: LookupTableId, suffix: string) {
	return tableLookup(
		table,
		columnId(`${suffix}1`),
		eq(tableColumn(table, columnId(`${suffix}2`)), literal("enabled")),
	);
}

describe("caseOperationProgramLookupTableIds", () => {
	it("uses canonical operation carrier identities across conditions, writes, and links while excluding unrelated carriers", () => {
		const conditionOperationUuid = asUuid(
			"20000000-0000-7000-8000-000000000001",
		);
		const writeOperationUuid = asUuid("20000000-0000-7000-8000-000000000002");
		const linkOperationUuid = asUuid("20000000-0000-7000-8000-000000000003");
		const unrelatedOperationUuid = asUuid(
			"20000000-0000-7000-8000-000000000004",
		);
		const conditionTable = tableId("30");
		const sharedTable = tableId("10");
		const linkTable = tableId("20");
		const unrelatedTable = tableId("40");

		const doc = buildDoc({
			appName: "Submission lookup projection",
			caseTypes: [
				{
					name: "patient",
					properties: [
						{ name: "status", label: "Status", data_type: "text" },
						{ name: "category", label: "Category", data_type: "text" },
					],
				},
			],
			modules: [
				{
					name: "Patients",
					caseType: "patient",
					forms: [
						{ name: "Active", type: "followup", fields: [] },
						{ name: "Unrelated", type: "followup", fields: [] },
					],
				},
			],
		});
		const moduleUuid = doc.moduleOrder[0] as Uuid;
		const activeFormUuid = doc.formOrder[moduleUuid][0];
		const unrelatedFormUuid = doc.formOrder[moduleUuid][1];
		if (activeFormUuid === undefined || unrelatedFormUuid === undefined) {
			throw new Error("fixture requires active and unrelated forms");
		}
		doc.forms[activeFormUuid].caseOperations = [
			{
				uuid: conditionOperationUuid,
				id: "condition",
				action: "update",
				caseType: "patient",
				target: { kind: "session" },
				condition: eq(lookup(conditionTable, "30"), literal("enabled")),
			},
			{
				uuid: writeOperationUuid,
				id: "write",
				action: "update",
				caseType: "patient",
				target: { kind: "session" },
				writes: [
					{ property: "status", value: lookup(sharedTable, "10") },
					{
						property: "category",
						value: term(literal("ready")),
						condition: eq(lookup(sharedTable, "11"), literal("enabled")),
					},
				],
			},
			{
				uuid: linkOperationUuid,
				id: "link",
				action: "update",
				caseType: "patient",
				target: { kind: "session" },
				links: [
					{
						identifier: "parent",
						targetType: "patient",
						target: { kind: "expression", expr: lookup(linkTable, "20") },
						relationship: "child",
					},
				],
			},
		] satisfies CaseOperation[];
		doc.forms[unrelatedFormUuid].caseOperations = [
			{
				uuid: unrelatedOperationUuid,
				id: "unrelated",
				action: "update",
				caseType: "patient",
				target: { kind: "session" },
				condition: eq(lookup(unrelatedTable, "40"), literal("enabled")),
			},
		] satisfies CaseOperation[];

		expect(
			caseOperationProgramLookupTableIds(doc, [
				linkOperationUuid,
				conditionOperationUuid,
				writeOperationUuid,
			]),
		).toEqual([sharedTable, linkTable, conditionTable]);
	});

	it("returns an empty target set without walking when the program is empty", () => {
		expect(
			caseOperationProgramLookupTableIds(
				buildDoc({ appName: "No program" }),
				[],
			),
		).toEqual([]);
	});
});
