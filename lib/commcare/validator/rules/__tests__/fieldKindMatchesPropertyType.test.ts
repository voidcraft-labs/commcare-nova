import { describe, expect, it } from "vitest";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { LOOKUP_CONTEXT_UNAVAILABLE } from "@/lib/doc/lookupReferences";
import {
	caseDataTypeForFieldKind,
	type FieldKind,
	fieldKinds,
	WRITABLE_STANDARD_CASE_PROPERTIES,
} from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";
import { runValidation } from "../../runner";
import { fieldKindMatchesPropertyType } from "../fieldKindMatchesPropertyType";

describe("fieldKindMatchesPropertyType", () => {
	it("pins every implicit writable standard scalar to text for every value-writing field kind", () => {
		const valueWritingKinds = fieldKinds.filter(
			(kind) =>
				caseDataTypeForFieldKind(kind) !== undefined || kind === "hidden",
		);
		for (const property of WRITABLE_STANDARD_CASE_PROPERTIES) {
			for (const kind of valueWritingKinds) {
				const doc = buildDoc({
					appName: "Standard scalar writer",
					modules: [
						{
							name: "Patients",
							caseType: "patient",
							forms: [
								{
									name: "Update",
									type: "followup",
									fields: [
										f({
											kind,
											id: `${property}_${kind}`,
											caseWrite: { caseType: "patient", property },
										}),
									],
								},
							],
						},
					],
					caseTypes: [{ name: "patient", properties: [] }],
				});
				const mismatch = fieldKindMatchesPropertyType(doc).some(
					(error) => error.code === "FIELD_KIND_PROPERTY_TYPE_MISMATCH",
				);
				const kindType = caseDataTypeForFieldKind(kind as FieldKind);
				expect(mismatch, `${property} <- ${kind}`).toBe(
					kindType !== undefined && kindType !== "text",
				);
			}
		}
	});

	it("does not let an explicit standard-property declaration redefine the scalar column type", () => {
		const doc = buildDoc({
			appName: "Standard scalar declaration",
			modules: [
				{
					name: "Patients",
					caseType: "patient",
					forms: [
						{
							name: "Update",
							type: "followup",
							fields: [
								f({
									kind: "int",
									id: "external_code",
									caseWrite: {
										caseType: "patient",
										property: "external_id",
									},
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
						{
							name: "external_id",
							label: proseText("External ID"),
							data_type: "int",
						},
					],
				},
			],
		});
		expect(
			fieldKindMatchesPropertyType(doc).map((error) => error.code),
		).toContain("FIELD_KIND_PROPERTY_TYPE_MISMATCH");
	});

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
									label: proseText("Name"),
									caseWrite: { caseType: "patient", property: "case_name" },
								}),
								f({
									kind: "int",
									id: "label",
									label: proseText("Label"),
									caseWrite: { caseType: "patient", property: "label" },
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
						{ name: "label", label: proseText("Label"), data_type: "text" },
					],
				},
			],
		});
		expect(
			runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).some(
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
									label: proseText("Name"),
									caseWrite: { caseType: "patient", property: "case_name" },
								}),
								f({
									kind: "barcode",
									id: "tag",
									label: proseText("Tag"),
									caseWrite: { caseType: "patient", property: "tag" },
								}),
								f({
									kind: "secret",
									id: "pin",
									label: proseText("PIN"),
									caseWrite: { caseType: "patient", property: "pin" },
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
						{ name: "tag", label: proseText("Tag"), data_type: "text" },
						{ name: "pin", label: proseText("PIN"), data_type: "text" },
					],
				},
			],
		});
		expect(
			runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).some(
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
									label: proseText("Name"),
									caseWrite: { caseType: "patient", property: "case_name" },
								}),
								// Hidden field with `caseWrite` — the rule must
								// skip it regardless of the property's declared type.
								f({
									kind: "hidden",
									id: "computed_age",
									calculate: "1",
									caseWrite: { caseType: "patient", property: "computed_age" },
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
						{ name: "computed_age", label: proseText("Age"), data_type: "int" },
					],
				},
			],
		});
		expect(
			runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).some(
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
									label: proseText("Name"),
									caseWrite: { caseType: "patient", property: "case_name" },
								}),
								f({
									kind: "int",
									id: "untyped",
									label: proseText("Untyped"),
									caseWrite: { caseType: "patient", property: "untyped" },
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
						{ name: "case_name", label: proseText("Name") },
						{ name: "untyped", label: proseText("Untyped") },
					],
				},
			],
		});
		expect(
			runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).some(
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
						{
							name: "Followup",
							type: "followup",
							fields: [
								f({
									kind: "decimal",
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
						{ name: "weight", label: proseText("Weight") },
					],
				},
			],
		});
		const errors = runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE);
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
									label: proseText("Name"),
									caseWrite: { caseType: "patient", property: "case_name" },
								}),
								f({
									kind: "group",
									id: "demographics",
									label: proseText("Demographics"),
									children: [
										f({
											kind: "int",
											id: "label",
											label: proseText("Label"),
											caseWrite: { caseType: "patient", property: "label" },
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
						{ name: "case_name", label: proseText("Name"), data_type: "text" },
						{ name: "label", label: proseText("Label"), data_type: "text" },
					],
				},
			],
		});
		expect(
			runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).some(
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
									label: proseText("C"),
									caseWrite: { caseType: "a::b", property: "c" },
								}),
								f({
									kind: "int",
									id: "b::c",
									label: proseText("BC"),
									caseWrite: { caseType: "a", property: "b::c" },
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
			runValidation(doc, LOOKUP_CONTEXT_UNAVAILABLE).some(
				(e) => e.code === "FIELD_KIND_WRITERS_DISAGREE",
			),
		).toBe(false);
	});
});
