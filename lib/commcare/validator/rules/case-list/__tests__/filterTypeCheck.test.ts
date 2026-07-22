import { describe, expect, it } from "vitest";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { asUuid, plainColumn } from "@/lib/domain";
import { eq, gt, literal, prop } from "@/lib/domain/predicate";
import { runValidation } from "../../../runner";

describe("filterTypeCheck", () => {
	it("fires when the filter has an operand-type mismatch", () => {
		// `gt` on a `text` property — strings aren't ordered, so the type
		// checker rejects the comparison.
		const doc = buildDoc({
			appName: "Test",
			modules: [
				{
					name: "Mod",
					caseType: "patient",
					caseListConfig: {
						columns: [plainColumn(asUuid("col-name"), "case_name", "Name")],
						searchInputs: [],
						filter: gt(prop("patient", "name"), literal("M")),
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
		const errors = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE);
		expect(errors.some((e) => e.code === "CASE_LIST_FILTER_TYPE_ERROR")).toBe(
			true,
		);
	});

	it("does not fire on a well-typed filter", () => {
		const doc = buildDoc({
			appName: "Test",
			modules: [
				{
					name: "Mod",
					caseType: "patient",
					caseListConfig: {
						columns: [plainColumn(asUuid("col-name"), "case_name", "Name")],
						searchInputs: [],
						// `eq(prop, literal)` — text vs string literal is structurally
						// compatible.
						filter: eq(prop("patient", "name"), literal("Alice")),
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
			runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).some(
				(e) => e.code === "CASE_LIST_FILTER_TYPE_ERROR",
			),
		).toBe(false);
	});

	it("fires when the filter references an unknown property", () => {
		const doc = buildDoc({
			appName: "Test",
			modules: [
				{
					name: "Mod",
					caseType: "patient",
					caseListConfig: {
						columns: [plainColumn(asUuid("col-name"), "case_name", "Name")],
						searchInputs: [],
						filter: eq(prop("patient", "ghost"), literal("x")),
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
		const errors = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE);
		expect(
			errors.some(
				(e) =>
					e.code === "CASE_LIST_FILTER_TYPE_ERROR" &&
					e.message.toLowerCase().includes("unknown property"),
			),
		).toBe(true);
	});

	// ── Augmentation regression coverage ─────────────────────────
	//
	// The next four tests pin the rule-set-wide property admission
	// model: a filter referencing a writer-derived OR standard
	// property must NOT spuriously fire "Unknown property", and a
	// type-mismatch against the resolved data type must surface.
	// Removing the augmentation hop in `moduleTypeContext` (i.e.
	// reverting to a raw `caseTypes` list) breaks each of these in
	// turn, which is the regression these pins exist to catch.

	it("admits a writer-derived-only property in a filter (no spurious unknown)", () => {
		// `nickname` is written via `case_property_on` but NOT declared
		// on `ct.properties[]`. The augmented case-type list adds it as
		// `text`, so `eq(prop("patient", "nickname"), literal("Al"))`
		// type-checks cleanly.
		const doc = buildDoc({
			appName: "Test",
			modules: [
				{
					name: "Mod",
					caseType: "patient",
					caseListConfig: {
						columns: [plainColumn(asUuid("col-name"), "case_name", "Name")],
						searchInputs: [],
						filter: eq(prop("patient", "nickname"), literal("Al")),
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
			runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).some(
				(e) => e.code === "CASE_LIST_FILTER_TYPE_ERROR",
			),
		).toBe(false);
	});

	it("admits a standard-only property in a filter (no spurious unknown)", () => {
		// `case_name` is implicit at the wire layer — never declared on
		// `ct.properties[]`. The augmented list adds it as `text`, so a
		// filter against it type-checks cleanly.
		const doc = buildDoc({
			appName: "Test",
			modules: [
				{
					name: "Mod",
					caseType: "patient",
					caseListConfig: {
						columns: [plainColumn(asUuid("col-name"), "case_name", "Name")],
						searchInputs: [],
						filter: eq(prop("patient", "case_name"), literal("Alice")),
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
			runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).some(
				(e) => e.code === "CASE_LIST_FILTER_TYPE_ERROR",
			),
		).toBe(false);
	});

	it("surfaces a type mismatch on a standard property's implicit data_type", () => {
		// `date_opened` is implicitly `datetime` per
		// `STANDARD_CASE_LIST_PROPERTY_DATA_TYPES`. Comparing it via
		// `eq` against a string literal is a type mismatch the predicate
		// AST type checker rejects — pins that the augmentation
		// supplied the typed entry, not a fall-through to text.
		const doc = buildDoc({
			appName: "Test",
			modules: [
				{
					name: "Mod",
					caseType: "patient",
					caseListConfig: {
						columns: [plainColumn(asUuid("col-name"), "case_name", "Name")],
						searchInputs: [],
						filter: eq(prop("patient", "date_opened"), literal("not-a-date")),
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
			runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).some(
				(e) =>
					e.code === "CASE_LIST_FILTER_TYPE_ERROR" &&
					e.message.toLowerCase().includes("type mismatch"),
			),
		).toBe(true);
	});

	it("short-circuits cleanly when the filter slot is absent", () => {
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
			runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).some(
				(e) => e.code === "CASE_LIST_FILTER_TYPE_ERROR",
			),
		).toBe(false);
	});
});
