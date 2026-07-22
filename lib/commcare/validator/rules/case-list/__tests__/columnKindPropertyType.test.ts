import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
// The gate half of the shared column-kind ↔ property-type predicate:
// a RESOLVED mismatch is a finding; unknown passes (honest-unknown-
// permissive — the same verdict the workspace + pickers derive, so
// the gate can never approve a column the workspace marks broken).

import { describe, expect, it } from "vitest";
import { buildDoc, type FieldSpec, f } from "@/lib/__tests__/docHelpers";
import { asUuid, type Column, dateColumn, phoneColumn } from "@/lib/domain";
import { runValidation } from "../../../runner";

const CODE = "CASE_LIST_COLUMN_KIND_PROPERTY_TYPE_MISMATCH";

function moduleWith(args: { columns: Column[]; fields: FieldSpec[] }) {
	return buildDoc({
		appName: "T",
		caseTypes: [{ name: "patient", properties: [] }],
		modules: [
			{
				name: "Mod",
				caseType: "patient",
				caseListConfig: { columns: args.columns, searchInputs: [] },
				forms: [
					{
						name: "Reg",
						type: "registration",
						fields: args.fields.map((spec) => f(spec)),
					},
				],
			},
		],
	});
}

describe("columnKindPropertyType", () => {
	it("fires on a date column whose property RESOLVES to a non-date type", () => {
		const doc = moduleWith({
			columns: [dateColumn(asUuid("col-1"), "nickname", "Nick", "%Y-%m-%d")],
			fields: [
				f({
					kind: "text",
					id: "nickname",
					label: "Nickname",
					case_property_on: "patient",
				}),
			],
		});
		const errors = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE);
		expect(
			errors.some((e) => e.code === CODE && e.message.includes("nickname")),
		).toBe(true);
	});

	it("passes a date column on a writer-derived date property", () => {
		const doc = moduleWith({
			columns: [dateColumn(asUuid("col-1"), "dob", "DOB", "%Y-%m-%d")],
			fields: [
				f({
					kind: "date",
					id: "dob",
					label: "DOB",
					case_property_on: "patient",
				}),
			],
		});
		expect(
			runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).some(
				(e) => e.code === CODE,
			),
		).toBe(false);
	});

	it("passes a date column on a hidden today() writer — inference resolves date", () => {
		const doc = moduleWith({
			columns: [dateColumn(asUuid("col-1"), "visit_date", "Visit", "%Y-%m-%d")],
			fields: [
				f({
					kind: "hidden",
					id: "visit_date",
					case_property_on: "patient",
					default_value: "today()",
				}),
			],
		});
		expect(
			runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).some(
				(e) => e.code === CODE,
			),
		).toBe(false);
	});

	it("passes on an UNKNOWN type — missing metadata never manufactures a finding", () => {
		const doc = moduleWith({
			columns: [dateColumn(asUuid("col-1"), "mystery", "Mystery", "%Y-%m-%d")],
			fields: [
				f({
					kind: "hidden",
					id: "mystery",
					case_property_on: "patient",
					default_value: "concat('a', 'b')",
				}),
			],
		});
		expect(
			runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).some(
				(e) => e.code === CODE,
			),
		).toBe(false);
	});

	it("fires on a phone column over a standard datetime property", () => {
		const doc = moduleWith({
			columns: [phoneColumn(asUuid("col-1"), "date_opened", "Opened")],
			fields: [
				f({
					kind: "text",
					id: "case_name",
					label: "Name",
					case_property_on: "patient",
				}),
			],
		});
		const errors = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE);
		expect(
			errors.some((e) => e.code === CODE && e.message.includes("date_opened")),
		).toBe(true);
	});
});
