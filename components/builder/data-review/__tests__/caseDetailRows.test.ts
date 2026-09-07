import { describe, expect, it } from "vitest";
import { buildDoc } from "@/lib/__tests__/docHelpers";
import { type CaseType, projectProseTemplate } from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";
import type { CaseRowWithCalculated } from "@/lib/preview/engine/caseDataBindingTypes";
import { caseDetailRows } from "../caseDetailRows";

const CASE_TYPE: CaseType = {
	name: "patient",
	properties: [
		{
			name: "case_name",
			label: proseText("Case name"),
			data_type: "text",
		},
		{
			name: "external_id",
			label: proseText("External ID"),
			data_type: "text",
		},
		{
			name: "status",
			label: proseText("Status"),
			data_type: "text",
		},
		{
			name: "owner_id",
			label: proseText("Owner"),
			data_type: "text",
		},
		{
			name: "date_opened",
			label: proseText("Date opened"),
			data_type: "datetime",
		},
		{
			name: "last_modified",
			label: proseText("Last modified"),
			data_type: "datetime",
		},
		{
			name: "visit_count",
			label: proseText("Visit count"),
			data_type: "int",
		},
		{
			name: "missing_note",
			label: proseText("Missing note"),
			data_type: "text",
		},
	],
};

const OPENED = new Date("2026-07-01T02:03:04.000Z");
const MODIFIED = new Date("2026-07-29T11:12:13.000Z");

const row = {
	case_id: "case-1",
	app_id: "app-1",
	case_type: "patient",
	owner_id: "owner-7",
	status: "open",
	opened_on: OPENED,
	modified_on: MODIFIED,
	closed_on: null,
	case_name: "Stored patient name",
	external_id: "EXT-42",
	parent_case_id: null,
	properties: {
		case_name: "shadow case name",
		external_id: "shadow external id",
		status: "shadow status",
		owner_id: "shadow owner",
		date_opened: "shadow opened date",
		last_modified: "shadow modified date",
		visit_count: 7,
		retired_key: false,
	},
	calculated: {},
} satisfies CaseRowWithCalculated;
const project = (prose: Parameters<typeof projectProseTemplate>[0]) =>
	projectProseTemplate(prose, buildDoc({})).text;
describe("case detail table projection", () => {
	it("uses canonical scalar columns even when JSONB contains shadowed keys, retains retired values, and includes missing declarations", () => {
		const rows = caseDetailRows(CASE_TYPE, row, project);
		expect(rows.map(({ key, value }) => [key, value])).toEqual([
			["case_name", "Stored patient name"],
			["external_id", "EXT-42"],
			["status", "open"],
			["owner_id", "owner-7"],
			["date_opened", OPENED.toISOString()],
			["last_modified", MODIFIED.toISOString()],
			["visit_count", "7"],
			["missing_note", ""],
			["retired_key", "false"],
		]);
		expect(rows.at(-1)?.decl).toBeUndefined();
	});
	it("projects authored selection labels while retaining unknown stored values and selection order", () => {
		const choices = {
			name: "choices",
			label: proseText("Choices"),
			data_type: "multi_select" as const,
			options: [
				{ value: "a", label: proseText("Alpha") },
				{ value: "b", label: proseText("Beta") },
			],
		};
		const rows = caseDetailRows(
			{ name: "patient", properties: [choices] },
			{ ...row, properties: { choices: ["b", "missing", "a"] } },
			project,
		);
		expect(rows.map(({ key, value }) => [key, value])).toEqual([
			["case_name", "Stored patient name"],
			["choices", "Beta, missing, Alpha"],
		]);
	});
	it("always includes case name once and distinguishes empty from zero and false", () => {
		const rows = caseDetailRows(
			{ name: "patient", properties: [] },
			{
				...row,
				case_name: "",
				properties: { case_name: "shadow", zero: 0, no: false, empty: null },
			},
			project,
		);
		expect(rows.map(({ key, value }) => [key, value])).toEqual([
			["case_name", ""],
			["zero", "0"],
			["no", "false"],
			["empty", ""],
		]);
	});
});
