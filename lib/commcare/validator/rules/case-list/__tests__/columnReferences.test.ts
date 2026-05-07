import { describe, expect, it } from "vitest";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { plainColumn } from "@/lib/domain";
import { runValidation } from "../../../runner";

describe("columnReferences", () => {
	it("fires when a column references a property no field saves to", () => {
		const doc = buildDoc({
			appName: "Test",
			modules: [
				{
					name: "Mod",
					caseType: "patient",
					caseListConfig: caseListConfig([
						{ field: "case_name", header: "Name" },
						{ field: "ghost_property", header: "Ghost" },
					]),
					forms: [
						{
							name: "Reg",
							type: "registration",
							fields: [
								f({
									kind: "text",
									id: "case_name",
									label: "Name",
									case_property_on: "patient",
								}),
							],
						},
					],
				},
			],
			caseTypes: [{ name: "patient", properties: [] }],
		});
		const errors = runValidation(doc);
		expect(
			errors.some(
				(e) =>
					e.code === "CASE_LIST_COLUMN_UNKNOWN_FIELD" &&
					e.message.includes("ghost_property"),
			),
		).toBe(true);
	});

	it("does not fire when every column resolves to a known property", () => {
		const doc = buildDoc({
			appName: "Test",
			modules: [
				{
					name: "Mod",
					caseType: "patient",
					caseListConfig: caseListConfig([
						{ field: "case_name", header: "Name" },
						{ field: "age", header: "Age" },
					]),
					forms: [
						{
							name: "Reg",
							type: "registration",
							fields: [
								f({
									kind: "text",
									id: "case_name",
									label: "Name",
									case_property_on: "patient",
								}),
								f({
									kind: "int",
									id: "age",
									label: "Age",
									case_property_on: "patient",
								}),
							],
						},
					],
				},
			],
			caseTypes: [{ name: "patient", properties: [] }],
		});
		expect(
			runValidation(doc).some(
				(e) => e.code === "CASE_LIST_COLUMN_UNKNOWN_FIELD",
			),
		).toBe(false);
	});

	it("fires on detailColumns (long-detail override)", () => {
		const doc = buildDoc({
			appName: "Test",
			modules: [
				{
					name: "Mod",
					caseType: "patient",
					caseListConfig: caseListConfig(
						[{ field: "case_name", header: "Name" }],
						{
							detailColumns: [
								{ field: "case_name", header: "Name" },
								{ field: "ghost_in_detail", header: "Ghost" },
							],
						},
					),
					forms: [
						{
							name: "Reg",
							type: "registration",
							fields: [
								f({
									kind: "text",
									id: "case_name",
									label: "Name",
									case_property_on: "patient",
								}),
							],
						},
					],
				},
			],
			caseTypes: [{ name: "patient", properties: [] }],
		});
		const errors = runValidation(doc);
		expect(
			errors.some(
				(e) =>
					e.code === "CASE_LIST_COLUMN_UNKNOWN_FIELD" &&
					e.message.includes("ghost_in_detail") &&
					e.message.includes("case-detail column"),
			),
		).toBe(true);
	});

	it("walks every column kind, not just plain", () => {
		// Date column with an unresolved field still fires.
		const doc = buildDoc({
			appName: "Test",
			modules: [
				{
					name: "Mod",
					caseType: "patient",
					caseListConfig: {
						columns: [
							plainColumn("case_name", "Name"),
							{
								kind: "date",
								field: "missing_date",
								header: "Date",
								pattern: "%Y-%m-%d",
							},
						],
						sort: [],
						calculatedColumns: [],
						searchInputs: [],
					},
					forms: [
						{
							name: "Reg",
							type: "registration",
							fields: [
								f({
									kind: "text",
									id: "case_name",
									label: "Name",
									case_property_on: "patient",
								}),
							],
						},
					],
				},
			],
			caseTypes: [{ name: "patient", properties: [] }],
		});
		expect(
			runValidation(doc).some(
				(e) =>
					e.code === "CASE_LIST_COLUMN_UNKNOWN_FIELD" &&
					e.message.includes("missing_date"),
			),
		).toBe(true);
	});

	it("admits declared-only properties (no field writer, no standard)", () => {
		// `weight` is declared on `ct.properties[]` but NOT written by
		// any field via `case_property_on`. Pre-fix, the rule consulted
		// only writer-derived + standard, so a declared-only property
		// would spuriously fire UNKNOWN_FIELD. The shared resolver's
		// declared-first arm closes that gap; this test pins the
		// admission for the declared-only path.
		const doc = buildDoc({
			appName: "Test",
			modules: [
				{
					name: "Mod",
					caseType: "patient",
					caseListConfig: caseListConfig([
						{ field: "case_name", header: "Name" },
						{ field: "weight", header: "Weight" },
					]),
					forms: [
						{
							name: "Reg",
							type: "registration",
							fields: [
								f({
									kind: "text",
									id: "case_name",
									label: "Name",
									case_property_on: "patient",
								}),
							],
						},
					],
				},
			],
			caseTypes: [
				{
					name: "patient",
					properties: [
						{ name: "case_name", label: "Name", data_type: "text" },
						// Declared but no writer + not in the standard set.
						{ name: "weight", label: "Weight", data_type: "decimal" },
					],
				},
			],
		});
		expect(
			runValidation(doc).some(
				(e) =>
					e.code === "CASE_LIST_COLUMN_UNKNOWN_FIELD" &&
					e.message.includes("weight"),
			),
		).toBe(false);
	});

	it("short-circuits cleanly on modules without a caseType", () => {
		const doc = buildDoc({
			appName: "Test",
			modules: [
				{
					name: "Survey-only",
					forms: [
						{
							name: "Survey",
							type: "survey",
							fields: [f({ kind: "text", id: "q", label: "Q" })],
						},
					],
				},
			],
		});
		expect(
			runValidation(doc).some(
				(e) => e.code === "CASE_LIST_COLUMN_UNKNOWN_FIELD",
			),
		).toBe(false);
	});
});
