import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import {
	advancedSearchInputDef,
	exactMode,
	fuzzyDateMode,
	fuzzyMode,
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
import { proseText } from "@/lib/domain/prose";
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
						columns: [plainColumn(testUuid("col-name"), "case_name", "Name")],
						listColumnOrder: [testUuid("col-name")],
						detailColumnOrder: [testUuid("col-name")],
						searchInputs: [
							simpleSearchInputDef(
								testUuid("si-name-range"),
								"name_range",
								"Name",
								"date-range",
								"full_name",
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
									label: proseText("Name"),
									caseWrite: { caseType: "patient", property: "case_name" },
								}),
								f({
									kind: "text",
									id: "name",
									label: proseText("Name"),
									caseWrite: { caseType: "patient", property: "full_name" },
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
						{ name: "case_name", label: proseText("Name"), data_type: "text" },
						{ name: "full_name", label: proseText("Name"), data_type: "text" },
					],
				},
			],
		});
		expect(
			runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).some(
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
						columns: [plainColumn(testUuid("col-name"), "case_name", "Name")],
						listColumnOrder: [testUuid("col-name")],
						detailColumnOrder: [testUuid("col-name")],
						searchInputs: [
							simpleSearchInputDef(
								testUuid("si-age-fuzzy"),
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
									label: proseText("Name"),
									caseWrite: { caseType: "patient", property: "case_name" },
								}),
								f({
									kind: "int",
									id: "age",
									label: proseText("Age"),
									caseWrite: { caseType: "patient", property: "age" },
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
						{ name: "case_name", label: proseText("Name"), data_type: "text" },
						{ name: "age", label: proseText("Age"), data_type: "int" },
					],
				},
			],
		});
		expect(
			runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).some(
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
						columns: [plainColumn(testUuid("col-name"), "case_name", "Name")],
						listColumnOrder: [testUuid("col-name")],
						detailColumnOrder: [testUuid("col-name")],
						searchInputs: [
							simpleSearchInputDef(
								testUuid("si-age-range"),
								"age_range",
								"Age",
								"date-range",
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
									label: proseText("Name"),
									caseWrite: { caseType: "patient", property: "case_name" },
								}),
								f({
									kind: "int",
									id: "age",
									label: proseText("Age"),
									caseWrite: { caseType: "patient", property: "age" },
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
						{ name: "case_name", label: proseText("Name"), data_type: "text" },
						{ name: "age", label: proseText("Age"), data_type: "int" },
					],
				},
			],
		});
		expect(
			runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).some(
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
						columns: [plainColumn(testUuid("col-name"), "case_name", "Name")],
						listColumnOrder: [testUuid("col-name")],
						detailColumnOrder: [testUuid("col-name")],
						searchInputs: [
							simpleSearchInputDef(
								testUuid("si-any"),
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
									label: proseText("Name"),
									caseWrite: { caseType: "patient", property: "case_name" },
								}),
								f({
									kind: "geopoint",
									id: "geo",
									label: proseText("Geo"),
									caseWrite: { caseType: "patient", property: "geo" },
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
						{ name: "case_name", label: proseText("Name"), data_type: "text" },
						{ name: "geo", label: proseText("Geo"), data_type: "geopoint" },
					],
				},
			],
		});
		expect(
			runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).some(
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
									label: proseText("Name"),
									caseWrite: { caseType: "patient", property: "case_name" },
								}),
							],
						},
					],
				},
			],
			caseTypes: [{ name: "patient", properties: [] }],
		});
		expect(
			runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).some(
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
						columns: [plainColumn(testUuid("col-name"), "case_name", "Name")],
						listColumnOrder: [testUuid("col-name")],
						detailColumnOrder: [testUuid("col-name")],
						searchInputs: [
							advancedSearchInputDef(
								testUuid("si-advanced"),
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
									label: proseText("Name"),
									caseWrite: { caseType: "patient", property: "case_name" },
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
						{ name: "case_name", label: proseText("Name"), data_type: "text" },
					],
				},
			],
		});
		expect(
			runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).some(
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
						columns: [plainColumn(testUuid("col-name"), "case_name", "Name")],
						listColumnOrder: [testUuid("col-name")],
						detailColumnOrder: [testUuid("col-name")],
						searchInputs: [
							simpleSearchInputDef(
								testUuid("si-age-phon"),
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
									label: proseText("Name"),
									caseWrite: { caseType: "patient", property: "case_name" },
								}),
								f({
									kind: "int",
									id: "age",
									label: proseText("Age"),
									caseWrite: { caseType: "patient", property: "age" },
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
						{ name: "case_name", label: proseText("Name"), data_type: "text" },
						{ name: "age", label: proseText("Age"), data_type: "int" },
					],
				},
			],
		});
		expect(
			runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).some(
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
						columns: [plainColumn(testUuid("col-name"), "case_name", "Name")],
						listColumnOrder: [testUuid("col-name")],
						detailColumnOrder: [testUuid("col-name")],
						searchInputs: [
							simpleSearchInputDef(
								testUuid("si-age-starts"),
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
									label: proseText("Name"),
									caseWrite: { caseType: "patient", property: "case_name" },
								}),
								f({
									kind: "int",
									id: "age",
									label: proseText("Age"),
									caseWrite: { caseType: "patient", property: "age" },
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
						{ name: "case_name", label: proseText("Name"), data_type: "text" },
						{ name: "age", label: proseText("Age"), data_type: "int" },
					],
				},
			],
		});
		expect(
			runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).some(
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
						columns: [plainColumn(testUuid("col-name"), "case_name", "Name")],
						listColumnOrder: [testUuid("col-name")],
						detailColumnOrder: [testUuid("col-name")],
						searchInputs: [
							simpleSearchInputDef(
								testUuid("si-dob-fz"),
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
									label: proseText("Name"),
									caseWrite: { caseType: "patient", property: "case_name" },
								}),
								f({
									kind: "date",
									id: "dob",
									label: proseText("DOB"),
									caseWrite: { caseType: "patient", property: "dob" },
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
						{ name: "case_name", label: proseText("Name"), data_type: "text" },
						{ name: "dob", label: proseText("DOB"), data_type: "date" },
					],
				},
			],
		});
		expect(
			runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).some(
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
						columns: [plainColumn(testUuid("col-name"), "case_name", "Name")],
						listColumnOrder: [testUuid("col-name")],
						detailColumnOrder: [testUuid("col-name")],
						searchInputs: [
							simpleSearchInputDef(
								testUuid("si-age-fz"),
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
									label: proseText("Name"),
									caseWrite: { caseType: "patient", property: "case_name" },
								}),
								f({
									kind: "int",
									id: "age",
									label: proseText("Age"),
									caseWrite: { caseType: "patient", property: "age" },
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
						{ name: "case_name", label: proseText("Name"), data_type: "text" },
						{ name: "age", label: proseText("Age"), data_type: "int" },
					],
				},
			],
		});
		expect(
			runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).some(
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
						columns: [plainColumn(testUuid("col-name"), "case_name", "Name")],
						listColumnOrder: [testUuid("col-name")],
						detailColumnOrder: [testUuid("col-name")],
						searchInputs: [
							simpleSearchInputDef(
								testUuid("si-ghost"),
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
									label: proseText("Name"),
									caseWrite: { caseType: "patient", property: "case_name" },
								}),
							],
						},
					],
				},
			],
			caseTypes: [{ name: "patient", properties: [] }],
		});
		expect(
			runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).some(
				(e) => e.code === "CASE_LIST_SEARCH_INPUT_UNKNOWN_PROPERTY",
			),
		).toBe(true);
	});

	it("admits writer-derived properties at the text default", () => {
		// `nickname` is written via `caseWrite` but not declared
		// on `properties[]`. Defaults to text. `fuzzy` is text-shaped →
		// passes.
		const doc = buildDoc({
			appName: "Test",
			modules: [
				{
					name: "Mod",
					caseType: "patient",
					caseListConfig: {
						columns: [plainColumn(testUuid("col-name"), "case_name", "Name")],
						listColumnOrder: [testUuid("col-name")],
						detailColumnOrder: [testUuid("col-name")],
						searchInputs: [
							simpleSearchInputDef(
								testUuid("si-nick-fz"),
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
									label: proseText("Name"),
									caseWrite: { caseType: "patient", property: "case_name" },
								}),
								f({
									kind: "text",
									id: "nickname",
									label: proseText("Nickname"),
									caseWrite: { caseType: "patient", property: "nickname" },
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
						{ name: "case_name", label: proseText("Name"), data_type: "text" },
					],
				},
			],
		});
		expect(
			runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).some(
				(e) =>
					e.code === "CASE_LIST_SEARCH_INPUT_UNKNOWN_PROPERTY" ||
					e.code === "CASE_LIST_SEARCH_INPUT_MODE_PROPERTY_TYPE_MISMATCH",
			),
		).toBe(false);
	});

	it("accepts `range` against a writer-derived property whose writer is numeric", () => {
		// Writer-derived `weight` RESOLVES to int under the effective view
		// (its writer is an int field), and `range` admits numerics.
		const doc = buildDoc({
			appName: "Test",
			modules: [
				{
					name: "Mod",
					caseType: "patient",
					caseListConfig: {
						columns: [plainColumn(testUuid("col-name"), "case_name", "Name")],
						listColumnOrder: [testUuid("col-name")],
						detailColumnOrder: [testUuid("col-name")],
						searchInputs: [
							simpleSearchInputDef(
								testUuid("si-weight-range"),
								"weight_range",
								"Weight",
								"date-range",
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
									label: proseText("Name"),
									caseWrite: { caseType: "patient", property: "case_name" },
								}),
								f({
									kind: "int",
									id: "weight",
									label: proseText("Weight"),
									caseWrite: { caseType: "patient", property: "weight" },
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
						{ name: "case_name", label: proseText("Name"), data_type: "text" },
					],
				},
			],
		});
		expect(
			runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).some(
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
						columns: [plainColumn(testUuid("col-name"), "case_name", "Name")],
						listColumnOrder: [testUuid("col-name")],
						detailColumnOrder: [testUuid("col-name")],
						searchInputs: [
							simpleSearchInputDef(
								testUuid("si-name-range"),
								"name_range",
								"Name",
								"date-range",
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
									label: proseText("Name"),
									caseWrite: { caseType: "patient", property: "case_name" },
								}),
							],
						},
					],
				},
			],
			caseTypes: [{ name: "patient", properties: [] }],
		});
		expect(
			runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).some(
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
						columns: [plainColumn(testUuid("col-name"), "case_name", "Name")],
						listColumnOrder: [testUuid("col-name")],
						detailColumnOrder: [testUuid("col-name")],
						searchInputs: [
							simpleSearchInputDef(
								testUuid("si-opened-range"),
								"opened_range",
								"Opened",
								"date-range",
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
									label: proseText("Name"),
									caseWrite: { caseType: "patient", property: "case_name" },
								}),
							],
						},
					],
				},
			],
			caseTypes: [{ name: "patient", properties: [] }],
		});
		expect(
			runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).some(
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
						columns: [plainColumn(testUuid("col-name"), "case_name", "Name")],
						listColumnOrder: [testUuid("col-name")],
						detailColumnOrder: [testUuid("col-name")],
						searchInputs: [
							simpleSearchInputDef(
								testUuid("si-patient-name-range"),
								"patient_name_range",
								"Patient name",
								"date-range",
								"full_name",
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
									label: proseText("Name"),
									caseWrite: { caseType: "visit", property: "case_name" },
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
						{ name: "full_name", label: proseText("Name"), data_type: "text" },
					],
				},
				{
					name: "visit",
					parent_type: "patient",
					properties: [
						{ name: "case_name", label: proseText("Name"), data_type: "text" },
					],
				},
			],
		});
		expect(
			runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).some(
				(e) =>
					e.code === "CASE_LIST_SEARCH_INPUT_MODE_PROPERTY_TYPE_MISMATCH" &&
					e.message.includes("patient"),
			),
		).toBe(true);
	});
});
