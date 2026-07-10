import { describe, expect, it } from "vitest";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import {
	advancedSearchInputDef,
	asUuid,
	exactMode,
	fuzzyDateMode,
	fuzzyMode,
	multiSelectContainsMode,
	phoneticMode,
	plainColumn,
	rangeMode,
	simpleSearchInputDef,
	startsWithMode,
} from "@/lib/domain";
import {
	ancestorPath,
	eq,
	literal,
	prop,
	relationStep,
} from "@/lib/domain/predicate";
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
						columns: [plainColumn(asUuid("col-name"), "case_name", "Name")],
						searchInputs: [
							simpleSearchInputDef(
								asUuid("si-name-range"),
								"name_range",
								"Name",
								"text",
								"name",
								{ mode: rangeMode() },
							),
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
						columns: [plainColumn(asUuid("col-name"), "case_name", "Name")],
						searchInputs: [
							simpleSearchInputDef(
								asUuid("si-age-fuzzy"),
								"age_fuzzy",
								"Age (fuzzy)",
								"text",
								"age",
								{ mode: fuzzyMode() },
							),
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
						columns: [plainColumn(asUuid("col-name"), "case_name", "Name")],
						searchInputs: [
							simpleSearchInputDef(
								asUuid("si-age-msc"),
								"age_msc",
								"Age (msc)",
								"select",
								"age",
								{ mode: multiSelectContainsMode("any") },
							),
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
						columns: [plainColumn(asUuid("col-name"), "case_name", "Name")],
						searchInputs: [
							simpleSearchInputDef(
								asUuid("si-age-range"),
								"age_range",
								"Age",
								"text",
								"age",
								{ mode: rangeMode() },
							),
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
						columns: [plainColumn(asUuid("col-name"), "case_name", "Name")],
						searchInputs: [
							simpleSearchInputDef(
								asUuid("si-any"),
								"any",
								"Any",
								"text",
								"geo",
								{ mode: exactMode() },
							),
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

	it("skips advanced inputs (predicate AST owns its own type checking)", () => {
		// Advanced inputs carry a free-form Predicate. The mode-vs-
		// property compatibility rule has no slot to inspect — the
		// predicate AST type checker owns the property + operator
		// resolution downstream.
		const doc = buildDoc({
			appName: "Test",
			modules: [
				{
					name: "Mod",
					caseType: "patient",
					caseListConfig: {
						columns: [plainColumn(asUuid("col-name"), "case_name", "Name")],
						searchInputs: [
							advancedSearchInputDef(
								asUuid("si-advanced"),
								"advanced",
								"Advanced",
								"text",
								eq(prop("patient", "case_name"), literal("Alice")),
							),
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

	it("fires `phonetic` against a numeric property (text-shaped allow-list)", () => {
		const doc = buildDoc({
			appName: "Test",
			modules: [
				{
					name: "Mod",
					caseType: "patient",
					caseListConfig: {
						columns: [plainColumn(asUuid("col-name"), "case_name", "Name")],
						searchInputs: [
							simpleSearchInputDef(
								asUuid("si-age-phon"),
								"age_phon",
								"Age (phonetic)",
								"text",
								"age",
								{ mode: phoneticMode() },
							),
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

	it("fires `starts-with` against a numeric property (text-shaped allow-list)", () => {
		const doc = buildDoc({
			appName: "Test",
			modules: [
				{
					name: "Mod",
					caseType: "patient",
					caseListConfig: {
						columns: [plainColumn(asUuid("col-name"), "case_name", "Name")],
						searchInputs: [
							simpleSearchInputDef(
								asUuid("si-age-starts"),
								"age_starts",
								"Age (starts)",
								"text",
								"age",
								{ mode: startsWithMode() },
							),
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

	it("admits `fuzzy-date` against a date property (date/datetime widen)", () => {
		// `fuzzy-date` admits `text` / `single_select` / `multi_select` /
		// `date` / `datetime` per `SEARCH_MODE_PROPERTY_TYPES`. A `date`
		// property passes; an `int` property would not — pin the date
		// arm here.
		const doc = buildDoc({
			appName: "Test",
			modules: [
				{
					name: "Mod",
					caseType: "patient",
					caseListConfig: {
						columns: [plainColumn(asUuid("col-name"), "case_name", "Name")],
						searchInputs: [
							simpleSearchInputDef(
								asUuid("si-dob-fz"),
								"dob_fz",
								"DOB (fuzzy-date)",
								"date",
								"dob",
								{ mode: fuzzyDateMode() },
							),
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
									kind: "date",
									id: "dob",
									label: "DOB",
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
						{ name: "dob", label: "DOB", data_type: "date" },
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

	it("fires `fuzzy-date` against an int property (off allow-list)", () => {
		const doc = buildDoc({
			appName: "Test",
			modules: [
				{
					name: "Mod",
					caseType: "patient",
					caseListConfig: {
						columns: [plainColumn(asUuid("col-name"), "case_name", "Name")],
						searchInputs: [
							simpleSearchInputDef(
								asUuid("si-age-fz"),
								"age_fz",
								"Age (fuzzy-date)",
								"date",
								"age",
								{ mode: fuzzyDateMode() },
							),
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

	it("emits CASE_LIST_SEARCH_INPUT_UNKNOWN_PROPERTY for properties that exist nowhere in the admission set", () => {
		// `ghost` is not declared on the case type, not written by any
		// field, and not a CommCare standard property. The rule emits
		// the dedicated unknown-property error.
		const doc = buildDoc({
			appName: "Test",
			modules: [
				{
					name: "Mod",
					caseType: "patient",
					caseListConfig: {
						columns: [plainColumn(asUuid("col-name"), "case_name", "Name")],
						searchInputs: [
							simpleSearchInputDef(
								asUuid("si-ghost"),
								"ghost",
								"Ghost",
								"text",
								"ghost",
								{ mode: fuzzyMode() },
							),
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
			caseTypes: [{ name: "patient", properties: [] }],
		});
		expect(
			runValidation(doc).some(
				(e) => e.code === "CASE_LIST_SEARCH_INPUT_UNKNOWN_PROPERTY",
			),
		).toBe(true);
	});

	it("admits writer-derived properties at the text default", () => {
		// `nickname` is written via `case_property_on` but not declared
		// on `properties[]`. Defaults to text. `fuzzy` is text-shaped →
		// passes.
		const doc = buildDoc({
			appName: "Test",
			modules: [
				{
					name: "Mod",
					caseType: "patient",
					caseListConfig: {
						columns: [plainColumn(asUuid("col-name"), "case_name", "Name")],
						searchInputs: [
							simpleSearchInputDef(
								asUuid("si-nick-fz"),
								"nick_fz",
								"Nickname",
								"text",
								"nickname",
								{ mode: fuzzyMode() },
							),
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
									id: "nickname",
									label: "Nickname",
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
				(e) =>
					e.code === "CASE_LIST_SEARCH_INPUT_UNKNOWN_PROPERTY" ||
					e.code === "CASE_LIST_SEARCH_INPUT_MODE_PROPERTY_TYPE_MISMATCH",
			),
		).toBe(false);
	});

	it("accepts `range` against a writer-derived property whose writer is numeric", () => {
		// Writer-derived `weight` RESOLVES to int under the effective view
		// (its writer is an int field), and `range` admits numerics — the
		// old text-stamp convention rejected this legitimate shape.
		const doc = buildDoc({
			appName: "Test",
			modules: [
				{
					name: "Mod",
					caseType: "patient",
					caseListConfig: {
						columns: [plainColumn(asUuid("col-name"), "case_name", "Name")],
						searchInputs: [
							simpleSearchInputDef(
								asUuid("si-weight-range"),
								"weight_range",
								"Weight",
								"text",
								"weight",
								{ mode: rangeMode() },
							),
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
									id: "weight",
									label: "Weight",
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

	it("rejects `range` against text-typed standard property `case_name`", () => {
		// Standard property `case_name` is implicitly text. `range`
		// requires numeric/temporal → rejected.
		const doc = buildDoc({
			appName: "Test",
			modules: [
				{
					name: "Mod",
					caseType: "patient",
					caseListConfig: {
						columns: [plainColumn(asUuid("col-name"), "case_name", "Name")],
						searchInputs: [
							simpleSearchInputDef(
								asUuid("si-name-range"),
								"name_range",
								"Name",
								"text",
								"case_name",
								{ mode: rangeMode() },
							),
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
			caseTypes: [{ name: "patient", properties: [] }],
		});
		expect(
			runValidation(doc).some(
				(e) => e.code === "CASE_LIST_SEARCH_INPUT_MODE_PROPERTY_TYPE_MISMATCH",
			),
		).toBe(true);
	});

	it("admits `range` against datetime-typed standard property `date_opened`", () => {
		// Standard property `date_opened` is implicitly datetime. `range`
		// admits numeric and temporal → passes.
		const doc = buildDoc({
			appName: "Test",
			modules: [
				{
					name: "Mod",
					caseType: "patient",
					caseListConfig: {
						columns: [plainColumn(asUuid("col-name"), "case_name", "Name")],
						searchInputs: [
							simpleSearchInputDef(
								asUuid("si-opened-range"),
								"opened_range",
								"Opened",
								"date",
								"date_opened",
								{ mode: rangeMode() },
							),
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
			caseTypes: [{ name: "patient", properties: [] }],
		});
		expect(
			runValidation(doc).some(
				(e) =>
					e.code === "CASE_LIST_SEARCH_INPUT_UNKNOWN_PROPERTY" ||
					e.code === "CASE_LIST_SEARCH_INPUT_MODE_PROPERTY_TYPE_MISMATCH",
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
						columns: [plainColumn(asUuid("col-name"), "case_name", "Name")],
						searchInputs: [
							simpleSearchInputDef(
								asUuid("si-patient-name-range"),
								"patient_name_range",
								"Patient name",
								"text",
								"name",
								{
									via: ancestorPath(relationStep("parent")),
									mode: rangeMode(),
								},
							),
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
