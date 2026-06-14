import { describe, expect, it } from "vitest";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { runValidation } from "../../runner";

describe("fieldKindMatchesPropertyType", () => {
	it("fires when an int field saves to a text-typed property", () => {
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
								f({
									kind: "int",
									id: "label",
									label: "Label",
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
						{ name: "label", label: "Label", data_type: "text" },
					],
				},
			],
		});
		expect(
			runValidation(doc).some(
				(e) => e.code === "FIELD_KIND_PROPERTY_TYPE_MISMATCH",
			),
		).toBe(true);
	});

	it("does not fire on a kind-matched (text → text) writer", () => {
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
					e.code === "FIELD_KIND_PROPERTY_TYPE_MISMATCH" ||
					e.code === "FIELD_KIND_WRITERS_DISAGREE",
			),
		).toBe(false);
	});

	it("treats barcode and secret as text-shaped (no error)", () => {
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
								f({
									kind: "barcode",
									id: "tag",
									label: "Tag",
									case_property_on: "patient",
								}),
								f({
									kind: "secret",
									id: "pin",
									label: "PIN",
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
						{ name: "tag", label: "Tag", data_type: "text" },
						{ name: "pin", label: "PIN", data_type: "text" },
					],
				},
			],
		});
		expect(
			runValidation(doc).some(
				(e) =>
					e.code === "FIELD_KIND_PROPERTY_TYPE_MISMATCH" ||
					e.code === "FIELD_KIND_WRITERS_DISAGREE",
			),
		).toBe(false);
	});

	it("skips hidden fields (calculate-driven; data_type is not pinned by kind)", () => {
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
								// Hidden field with `case_property_on` — the rule must
								// skip it regardless of the property's declared type.
								f({
									kind: "hidden",
									id: "computed_age",
									calculate: "1",
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
						{ name: "computed_age", label: "Age", data_type: "int" },
					],
				},
			],
		});
		expect(
			runValidation(doc).some(
				(e) =>
					e.code === "FIELD_KIND_PROPERTY_TYPE_MISMATCH" ||
					e.code === "FIELD_KIND_WRITERS_DISAGREE",
			),
		).toBe(false);
	});

	it("does not fire when the property has no declared data_type (un-annotated)", () => {
		// Un-annotated properties carry `data_type === undefined`; the
		// rule's `(a)` branch only fires when a declared type is present
		// AND mismatches the kind, so an un-annotated property is
		// silently admitted.
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
								f({
									kind: "int",
									id: "untyped",
									label: "Untyped",
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
						{ name: "case_name", label: "Name" },
						{ name: "untyped", label: "Untyped" },
					],
				},
			],
		});
		expect(
			runValidation(doc).some(
				(e) => e.code === "FIELD_KIND_PROPERTY_TYPE_MISMATCH",
			),
		).toBe(false);
	});

	it("emits one writers-disagree error per writer when kinds conflict across forms", () => {
		// Two forms in the same module write to `(patient, weight)` —
		// one as `int`, one as `decimal`. The rule fires once per
		// disagreeing writer. The property has no declared data_type, so
		// the only error class produced is `FIELD_KIND_WRITERS_DISAGREE`.
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
								f({
									kind: "int",
									id: "weight",
									label: "Weight",
									case_property_on: "patient",
								}),
							],
						},
						{
							name: "Followup",
							type: "followup",
							fields: [
								f({
									kind: "decimal",
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
					properties: [
						{ name: "case_name", label: "Name", data_type: "text" },
						{ name: "weight", label: "Weight" },
					],
				},
			],
		});
		const errors = runValidation(doc);
		const disagreeErrors = errors.filter(
			(e) => e.code === "FIELD_KIND_WRITERS_DISAGREE",
		);
		expect(disagreeErrors.length).toBe(2);
	});

	it("walks fields nested inside containers (group / repeat) when collecting writers", () => {
		// A field inside a group still participates in the writers map.
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
								f({
									kind: "group",
									id: "demographics",
									label: "Demographics",
									children: [
										f({
											kind: "int",
											id: "label",
											label: "Label",
											case_property_on: "patient",
										}),
									],
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
						{ name: "label", label: "Label", data_type: "text" },
					],
				},
			],
		});
		expect(
			runValidation(doc).some(
				(e) => e.code === "FIELD_KIND_PROPERTY_TYPE_MISMATCH",
			),
		).toBe(true);
	});
});

describe("tuple-key encoding is collision-free over arbitrary docs", () => {
	it("does not fabricate a cross-writer conflict for distinct tuples whose parts contain '::'", () => {
		// The validator is total over arbitrary docs (reducers are total;
		// event-log replay bypasses the identifier verdicts), so identifiers
		// containing ':' reach this rule. ('a::b', 'c') and ('a', 'b::c')
		// must stay DISTINCT tuples — a delimiter-joined key would alias
		// them into one writers bucket and emit a fabricated
		// FIELD_KIND_WRITERS_DISAGREE against both fields.
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
									id: "c",
									label: "C",
									case_property_on: "a::b",
								}),
								f({
									kind: "int",
									id: "b::c",
									label: "BC",
									case_property_on: "a",
								}),
							],
						},
					],
				},
			],
		});
		// Other rules legitimately flag the malformed identifiers; this
		// rule must not invent a writer disagreement between them.
		expect(
			runValidation(doc).some((e) => e.code === "FIELD_KIND_WRITERS_DISAGREE"),
		).toBe(false);
	});
});
