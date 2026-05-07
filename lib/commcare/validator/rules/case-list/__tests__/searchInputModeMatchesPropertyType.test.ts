import { describe, expect, it } from "vitest";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import {
	exactMode,
	fuzzyMode,
	multiSelectContainsMode,
	plainColumn,
	rangeMode,
	searchInputDef,
} from "@/lib/domain";
import { ancestorPath, relationStep } from "@/lib/domain/predicate";
import { runValidation } from "../../../runner";

describe("searchInputModeMatchesPropertyType", () => {
	it("fires when `range` is targeted at a text-typed property", () => {
		const doc = buildDoc({
			appName: "Test",
			modules: [
				{
					name: "Mod",
					caseType: "patient",
					caseListConfig: {
						columns: [plainColumn("case_name", "Name")],
						sort: [],
						calculatedColumns: [],
						searchInputs: [
							searchInputDef("name_range", "Name", "text", {
								property: "name",
								mode: rangeMode(),
							}),
						],
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
								f({
									kind: "text",
									id: "name",
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
						{ name: "name", label: "Name", data_type: "text" },
					],
				},
			],
		});
		expect(
			runValidation(doc).some(
				(e) =>
					e.code === "CASE_LIST_SEARCH_INPUT_MODE_PROPERTY_TYPE_MISMATCH" &&
					e.message.includes("range"),
			),
		).toBe(true);
	});

	it("fires when `fuzzy` is targeted at a numeric property", () => {
		const doc = buildDoc({
			appName: "Test",
			modules: [
				{
					name: "Mod",
					caseType: "patient",
					caseListConfig: {
						columns: [plainColumn("case_name", "Name")],
						sort: [],
						calculatedColumns: [],
						searchInputs: [
							searchInputDef("age_fuzzy", "Age (fuzzy)", "text", {
								property: "age",
								mode: fuzzyMode(),
							}),
						],
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
			caseTypes: [
				{
					name: "patient",
					properties: [
						{ name: "case_name", label: "Name", data_type: "text" },
						{ name: "age", label: "Age", data_type: "int" },
					],
				},
			],
		});
		expect(
			runValidation(doc).some(
				(e) => e.code === "CASE_LIST_SEARCH_INPUT_MODE_PROPERTY_TYPE_MISMATCH",
			),
		).toBe(true);
	});

	it("fires when `multi-select-contains` targets a numeric property", () => {
		const doc = buildDoc({
			appName: "Test",
			modules: [
				{
					name: "Mod",
					caseType: "patient",
					caseListConfig: {
						columns: [plainColumn("case_name", "Name")],
						sort: [],
						calculatedColumns: [],
						searchInputs: [
							searchInputDef("age_msc", "Age (msc)", "select", {
								property: "age",
								mode: multiSelectContainsMode("any"),
							}),
						],
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
			caseTypes: [
				{
					name: "patient",
					properties: [
						{ name: "case_name", label: "Name", data_type: "text" },
						{ name: "age", label: "Age", data_type: "int" },
					],
				},
			],
		});
		expect(
			runValidation(doc).some(
				(e) => e.code === "CASE_LIST_SEARCH_INPUT_MODE_PROPERTY_TYPE_MISMATCH",
			),
		).toBe(true);
	});

	it("does not fire on `range` against an int property", () => {
		const doc = buildDoc({
			appName: "Test",
			modules: [
				{
					name: "Mod",
					caseType: "patient",
					caseListConfig: {
						columns: [plainColumn("case_name", "Name")],
						sort: [],
						calculatedColumns: [],
						searchInputs: [
							searchInputDef("age_range", "Age", "text", {
								property: "age",
								mode: rangeMode(),
							}),
						],
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
			caseTypes: [
				{
					name: "patient",
					properties: [
						{ name: "case_name", label: "Name", data_type: "text" },
						{ name: "age", label: "Age", data_type: "int" },
					],
				},
			],
		});
		expect(
			runValidation(doc).some(
				(e) => e.code === "CASE_LIST_SEARCH_INPUT_MODE_PROPERTY_TYPE_MISMATCH",
			),
		).toBe(false);
	});

	it("does not fire on `exact` regardless of property type", () => {
		// `exact` is unrestricted (every type passes) — pin the
		// SEARCH_MODE_PROPERTY_TYPES `exact: undefined` arm.
		const doc = buildDoc({
			appName: "Test",
			modules: [
				{
					name: "Mod",
					caseType: "patient",
					caseListConfig: {
						columns: [plainColumn("case_name", "Name")],
						sort: [],
						calculatedColumns: [],
						searchInputs: [
							searchInputDef("any", "Any", "text", {
								property: "geo",
								mode: exactMode(),
							}),
						],
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
								f({
									kind: "geopoint",
									id: "geo",
									label: "Geo",
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
						{ name: "geo", label: "Geo", data_type: "geopoint" },
					],
				},
			],
		});
		expect(
			runValidation(doc).some(
				(e) => e.code === "CASE_LIST_SEARCH_INPUT_MODE_PROPERTY_TYPE_MISMATCH",
			),
		).toBe(false);
	});

	it("short-circuits cleanly when no inputs are declared", () => {
		const doc = buildDoc({
			appName: "Test",
			modules: [
				{
					name: "Mod",
					caseType: "patient",
					caseListConfig: caseListConfig([
						{ field: "case_name", header: "Name" },
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
		expect(
			runValidation(doc).some(
				(e) => e.code === "CASE_LIST_SEARCH_INPUT_MODE_PROPERTY_TYPE_MISMATCH",
			),
		).toBe(false);
	});

	it("skips inputs without a property (advanced inputs)", () => {
		const doc = buildDoc({
			appName: "Test",
			modules: [
				{
					name: "Mod",
					caseType: "patient",
					caseListConfig: {
						columns: [plainColumn("case_name", "Name")],
						sort: [],
						calculatedColumns: [],
						searchInputs: [
							// Advanced input — no `property`, mode set to a
							// normally-restricted shape. The rule must not fire.
							searchInputDef("advanced", "Advanced", "text", {
								mode: rangeMode(),
							}),
						],
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
			caseTypes: [
				{
					name: "patient",
					properties: [{ name: "case_name", label: "Name", data_type: "text" }],
				},
			],
		});
		expect(
			runValidation(doc).some(
				(e) => e.code === "CASE_LIST_SEARCH_INPUT_MODE_PROPERTY_TYPE_MISMATCH",
			),
		).toBe(false);
	});

	it("resolves cross-walk inputs against the destination case type", () => {
		// `visit` has a `parent_type` of `patient`. A search input on a
		// `visit` module with `via: ancestorPath(...)` reads the
		// `patient` case type — `range` against `patient.name` (text) is
		// structurally rejected at the destination, mirroring the
		// self-walk rejection.
		const doc = buildDoc({
			appName: "Test",
			modules: [
				{
					name: "Visits",
					caseType: "visit",
					caseListConfig: {
						columns: [plainColumn("case_name", "Name")],
						sort: [],
						calculatedColumns: [],
						searchInputs: [
							searchInputDef("patient_name_range", "Patient name", "text", {
								property: "name",
								via: ancestorPath(relationStep("parent")),
								mode: rangeMode(),
							}),
						],
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
									case_property_on: "visit",
								}),
							],
						},
					],
				},
			],
			caseTypes: [
				{
					name: "patient",
					properties: [{ name: "name", label: "Name", data_type: "text" }],
				},
				{
					name: "visit",
					parent_type: "patient",
					properties: [{ name: "case_name", label: "Name", data_type: "text" }],
				},
			],
		});
		expect(
			runValidation(doc).some(
				(e) =>
					e.code === "CASE_LIST_SEARCH_INPUT_MODE_PROPERTY_TYPE_MISMATCH" &&
					e.message.includes("patient"),
			),
		).toBe(true);
	});
});
