import { describe, expect, it } from "vitest";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import {
	calculatedColumn,
	calculatedSortSource,
	plainColumn,
	propertySortSource,
	sortKey,
} from "@/lib/domain";
import { today } from "@/lib/domain/predicate";
import { runValidation } from "../../../runner";

describe("sortTypeCheck", () => {
	it("fires when a property-rooted sort key references an unknown property", () => {
		const doc = buildDoc({
			appName: "Test",
			modules: [
				{
					name: "Mod",
					caseType: "patient",
					caseListConfig: {
						columns: [plainColumn("case_name", "Name")],
						sort: [sortKey(propertySortSource("ghost"), "plain", "asc")],
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
				(e) => e.code === "CASE_LIST_SORT_UNKNOWN_PROPERTY",
			),
		).toBe(true);
	});

	it("fires when the declared sort type doesn't match the property's data_type", () => {
		// `text` property cannot use `date` sort comparator.
		const doc = buildDoc({
			appName: "Test",
			modules: [
				{
					name: "Mod",
					caseType: "patient",
					caseListConfig: {
						columns: [plainColumn("case_name", "Name")],
						sort: [sortKey(propertySortSource("nickname"), "date", "asc")],
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
					properties: [
						{ name: "case_name", label: "Name", data_type: "text" },
						{ name: "nickname", label: "Nickname", data_type: "text" },
					],
				},
			],
		});
		expect(
			runValidation(doc).some(
				(e) => e.code === "CASE_LIST_SORT_TYPE_INCOMPATIBLE",
			),
		).toBe(true);
	});

	it("does not fire on a compatible (property, type) pair", () => {
		const doc = buildDoc({
			appName: "Test",
			modules: [
				{
					name: "Mod",
					caseType: "patient",
					caseListConfig: {
						columns: [plainColumn("case_name", "Name")],
						sort: [sortKey(propertySortSource("dob"), "date", "asc")],
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
				(e) =>
					e.code === "CASE_LIST_SORT_TYPE_INCOMPATIBLE" ||
					e.code === "CASE_LIST_SORT_UNKNOWN_PROPERTY",
			),
		).toBe(false);
	});

	it("admits any sort type against a calculated-column source whose id resolves", () => {
		const doc = buildDoc({
			appName: "Test",
			modules: [
				{
					name: "Mod",
					caseType: "patient",
					caseListConfig: {
						columns: [plainColumn("case_name", "Name")],
						sort: [sortKey(calculatedSortSource("derived"), "plain", "asc")],
						// Calculated column with an arbitrary expression — its
						// resolved type is irrelevant to this rule because
						// calculated sources accept every sort type.
						calculatedColumns: [
							calculatedColumn("derived", "Derived", today()),
						],
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
					e.code === "CASE_LIST_SORT_UNKNOWN_CALCULATED_COLUMN" ||
					e.code === "CASE_LIST_SORT_TYPE_INCOMPATIBLE",
			),
		).toBe(false);
	});

	it("fires when a calculated-source sort key references an unknown columnId", () => {
		const doc = buildDoc({
			appName: "Test",
			modules: [
				{
					name: "Mod",
					caseType: "patient",
					caseListConfig: {
						columns: [plainColumn("case_name", "Name")],
						sort: [sortKey(calculatedSortSource("ghost"), "plain", "asc")],
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
				(e) => e.code === "CASE_LIST_SORT_UNKNOWN_CALCULATED_COLUMN",
			),
		).toBe(true);
	});

	it("type-checks standard properties via the implicit-typing table (date_opened admits date)", () => {
		// `date_opened` is implicitly datetime per
		// `STANDARD_CASE_LIST_PROPERTY_DATA_TYPES`; `date` sort is in
		// `applicableSortTypes("datetime")` and passes.
		const doc = buildDoc({
			appName: "Test",
			modules: [
				{
					name: "Mod",
					caseType: "patient",
					caseListConfig: {
						columns: [plainColumn("case_name", "Name")],
						sort: [sortKey(propertySortSource("date_opened"), "date", "asc")],
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
					e.code === "CASE_LIST_SORT_UNKNOWN_PROPERTY" ||
					e.code === "CASE_LIST_SORT_TYPE_INCOMPATIBLE",
			),
		).toBe(false);
	});

	it("rejects an incompatible sort type on a standard property (date sort against case_name)", () => {
		// `case_name` is implicitly text per
		// `STANDARD_CASE_LIST_PROPERTY_DATA_TYPES`. `date` sort against
		// text is structurally rejected (text → ["plain"]).
		const doc = buildDoc({
			appName: "Test",
			modules: [
				{
					name: "Mod",
					caseType: "patient",
					caseListConfig: {
						columns: [plainColumn("case_name", "Name")],
						sort: [sortKey(propertySortSource("case_name"), "date", "asc")],
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
				(e) => e.code === "CASE_LIST_SORT_TYPE_INCOMPATIBLE",
			),
		).toBe(true);
	});

	it("admits writer-derived properties (text-default) and rejects incompatible sort types", () => {
		// `weight` is written by an int field via `case_property_on`,
		// but the case type's `properties[]` doesn't list it. Defaults
		// to text. `date` sort against text is rejected.
		const doc = buildDoc({
			appName: "Test",
			modules: [
				{
					name: "Mod",
					caseType: "patient",
					caseListConfig: {
						columns: [plainColumn("case_name", "Name")],
						sort: [sortKey(propertySortSource("weight"), "date", "asc")],
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
		const errors = runValidation(doc);
		// Property is admitted (not unknown) but `date` sort is
		// rejected against the text default.
		expect(
			errors.some((e) => e.code === "CASE_LIST_SORT_UNKNOWN_PROPERTY"),
		).toBe(false);
		expect(
			errors.some((e) => e.code === "CASE_LIST_SORT_TYPE_INCOMPATIBLE"),
		).toBe(true);
	});

	it("admits writer-derived properties with a compatible sort type", () => {
		// `weight` (writer-derived, text default) with `plain` sort
		// passes — `applicableSortTypes("text") === ["plain"]`.
		const doc = buildDoc({
			appName: "Test",
			modules: [
				{
					name: "Mod",
					caseType: "patient",
					caseListConfig: {
						columns: [plainColumn("case_name", "Name")],
						sort: [sortKey(propertySortSource("weight"), "plain", "asc")],
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
				(e) =>
					e.code === "CASE_LIST_SORT_UNKNOWN_PROPERTY" ||
					e.code === "CASE_LIST_SORT_TYPE_INCOMPATIBLE",
			),
		).toBe(false);
	});

	it("short-circuits cleanly when sort is empty", () => {
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
				(e) =>
					e.code === "CASE_LIST_SORT_UNKNOWN_PROPERTY" ||
					e.code === "CASE_LIST_SORT_UNKNOWN_CALCULATED_COLUMN" ||
					e.code === "CASE_LIST_SORT_TYPE_INCOMPATIBLE",
			),
		).toBe(false);
	});
});
