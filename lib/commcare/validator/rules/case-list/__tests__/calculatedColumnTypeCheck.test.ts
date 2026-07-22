import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import { describe, expect, it } from "vitest";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { asUuid, calculatedColumn, plainColumn } from "@/lib/domain";
import { arith, prop, term } from "@/lib/domain/predicate";
import { runValidation } from "../../../runner";

describe("calculatedColumnTypeCheck", () => {
	it("fires when a calculated column's expression has a type error", () => {
		// `arith` requires numeric operands — a `text` property fails the
		// per-side numeric check.
		const doc = buildDoc({
			appName: "Test",
			modules: [
				{
					name: "Mod",
					caseType: "patient",
					caseListConfig: {
						columns: [
							plainColumn(asUuid("col-name"), "case_name", "Name"),
							calculatedColumn(
								asUuid("col-bad-arith"),
								"Bad",
								arith(
									"+",
									term(prop("patient", "name")),
									term(prop("patient", "name")),
								),
							),
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
				(e) => e.code === "CASE_LIST_CALCULATED_COLUMN_TYPE_ERROR",
			),
		).toBe(true);
	});

	it("does not fire on a well-typed calculated column", () => {
		const doc = buildDoc({
			appName: "Test",
			modules: [
				{
					name: "Mod",
					caseType: "patient",
					caseListConfig: {
						columns: [
							plainColumn(asUuid("col-name"), "case_name", "Name"),
							calculatedColumn(
								asUuid("col-age-plus"),
								"Age + 1",
								arith(
									"+",
									term(prop("patient", "age")),
									term(prop("patient", "age")),
								),
							),
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
			runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).some(
				(e) => e.code === "CASE_LIST_CALCULATED_COLUMN_TYPE_ERROR",
			),
		).toBe(false);
	});

	it("fires when a calculated column references an unknown property", () => {
		const doc = buildDoc({
			appName: "Test",
			modules: [
				{
					name: "Mod",
					caseType: "patient",
					caseListConfig: {
						columns: [
							plainColumn(asUuid("col-name"), "case_name", "Name"),
							calculatedColumn(
								asUuid("col-unknown"),
								"Unknown",
								term(prop("patient", "ghost")),
							),
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
			caseTypes: [{ name: "patient", properties: [] }],
		});
		expect(
			runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).some(
				(e) =>
					e.code === "CASE_LIST_CALCULATED_COLUMN_TYPE_ERROR" &&
					e.message.toLowerCase().includes("unknown property"),
			),
		).toBe(true);
	});

	it("locates the offending column by uuid in the error details", () => {
		// Pin the uuid-as-locator contract: the error's `columnUuid`
		// detail carries the offending column's stable identity, not
		// an array index, so the editor can highlight the right row
		// after a reorder.
		const calcUuid = asUuid("col-locator-target");
		const doc = buildDoc({
			appName: "Test",
			modules: [
				{
					name: "Mod",
					caseType: "patient",
					caseListConfig: {
						columns: [
							plainColumn(asUuid("col-name"), "case_name", "Name"),
							calculatedColumn(
								calcUuid,
								"Unknown",
								term(prop("patient", "ghost")),
							),
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
			caseTypes: [{ name: "patient", properties: [] }],
		});
		const hits = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).filter(
			(e) => e.code === "CASE_LIST_CALCULATED_COLUMN_TYPE_ERROR",
		);
		expect(hits.length).toBeGreaterThan(0);
		expect(hits.every((e) => e.details?.columnUuid === calcUuid)).toBe(true);
	});

	// ── Augmentation regression coverage ─────────────────────────
	//
	// Pin the rule-set-wide admission model for value expressions:
	// a calculated column referencing a writer-derived OR standard
	// property must NOT spuriously fire "Unknown property", and the
	// implicit type of standard properties must drive operator
	// selection.

	it("admits a writer-derived-only property in a calculated column (no spurious unknown)", () => {
		// `nickname` is written via `case_property_on` but NOT declared
		// on `ct.properties[]`. The augmented case-type list adds it as
		// `text`, so `term(prop("patient", "nickname"))` type-checks
		// cleanly.
		const doc = buildDoc({
			appName: "Test",
			modules: [
				{
					name: "Mod",
					caseType: "patient",
					caseListConfig: {
						columns: [
							plainColumn(asUuid("col-name"), "case_name", "Name"),
							calculatedColumn(
								asUuid("col-nickname"),
								"Nickname",
								term(prop("patient", "nickname")),
							),
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
				(e) => e.code === "CASE_LIST_CALCULATED_COLUMN_TYPE_ERROR",
			),
		).toBe(false);
	});

	it("admits a standard-only property in a calculated column (no spurious unknown)", () => {
		// `case_name` is implicitly text. A calculated column reading
		// it should type-check cleanly without an "Unknown property"
		// error.
		const doc = buildDoc({
			appName: "Test",
			modules: [
				{
					name: "Mod",
					caseType: "patient",
					caseListConfig: {
						columns: [
							plainColumn(asUuid("col-name"), "case_name", "Name"),
							calculatedColumn(
								asUuid("col-display-name"),
								"Display name",
								term(prop("patient", "case_name")),
							),
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
			caseTypes: [{ name: "patient", properties: [] }],
		});
		expect(
			runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).some(
				(e) => e.code === "CASE_LIST_CALCULATED_COLUMN_TYPE_ERROR",
			),
		).toBe(false);
	});

	it("rejects arith on a standard text-typed property (implicit type drives the check)", () => {
		// `case_name` is implicitly text. `arith` requires numeric
		// operands — the standard property's implicit `text` type
		// must surface here as a type error. If the augmentation
		// missed the standard arm, this would either pass silently
		// (fall-through to text via some default) or fail with
		// "Unknown property". We want the exact "numeric" error.
		const doc = buildDoc({
			appName: "Test",
			modules: [
				{
					name: "Mod",
					caseType: "patient",
					caseListConfig: {
						columns: [
							plainColumn(asUuid("col-name"), "case_name", "Name"),
							calculatedColumn(
								asUuid("col-bad-arith"),
								"Bad",
								arith(
									"+",
									term(prop("patient", "case_name")),
									term(prop("patient", "case_name")),
								),
							),
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
			caseTypes: [{ name: "patient", properties: [] }],
		});
		const errors = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE);
		// The property exists (so no "Unknown property"); the type
		// rule fires (so we see "numeric" / "arith" in the message).
		const hits = errors.filter(
			(e) => e.code === "CASE_LIST_CALCULATED_COLUMN_TYPE_ERROR",
		);
		expect(hits.length).toBeGreaterThan(0);
		expect(hits.some((e) => /unknown property/i.test(e.message))).toBe(false);
		expect(hits.some((e) => /arith|numeric/i.test(e.message))).toBe(true);
	});

	it("short-circuits cleanly when no calculated columns are declared", () => {
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
				(e) => e.code === "CASE_LIST_CALCULATED_COLUMN_TYPE_ERROR",
			),
		).toBe(false);
	});
});
