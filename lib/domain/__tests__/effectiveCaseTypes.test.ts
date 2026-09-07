// The effective case-type view — property types as derived facts
// (declared ?? writer-derived ?? honest unknown). See
// `lib/domain/effectiveCaseTypes.ts`'s header for the model; these
// tests pin the resolution rules and the honest-unknown contract the
// column-applicability + gate consumers depend on.

import { describe, expect, it } from "vitest";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { expectAdmittedDoc } from "@/lib/agent/__tests__/admittedFixture";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import type { CasePropertyDataType, PersistableDoc } from "@/lib/domain";
import { blueprintDocSchema, effectiveCaseTypes } from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";

/** Assert the entry exists separately from its possibly unknown type. */
function resolveEffectivePropertyType(
	doc: PersistableDoc,
	caseType: string,
	property: string,
): CasePropertyDataType | undefined {
	const ct = effectiveCaseTypes(doc).find((c) => c.name === caseType);
	const entry = ct?.properties.find((p) => p.name === property);
	expect(entry, `${caseType}/${property} must exist`).toBeDefined();
	return entry?.data_type;
}

/** A doc with one module/form so writer fields have a home. */
function docWith(args: {
	fields: Parameters<typeof f>[0][];
	candidateOnly?: boolean;
	caseTypes?: NonNullable<Parameters<typeof buildDoc>[0]>["caseTypes"];
}) {
	const doc = buildDoc({
		appName: "T",
		caseTypes: args.caseTypes ?? [{ name: "patient", properties: [] }],
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
						type: "followup",
						fields: args.fields.length
							? args.fields.map((spec) => f(spec))
							: [f({ kind: "text", id: "note", label: "Note" })],
					},
				],
			},
		],
	});
	blueprintDocSchema.parse(toPersistableDoc(doc));
	if (!args.candidateOnly) expectAdmittedDoc(doc);
	return doc;
}

describe("effectiveCaseTypes — writer derivation", () => {
	it("derives a declared-but-untyped property's type from its writer field's kind", () => {
		const doc = docWith({
			caseTypes: [
				{
					name: "patient",
					properties: [{ name: "dob", label: proseText("DOB") }],
				},
			],
			fields: [
				f({
					kind: "date",
					id: "date_of_birth_question",
					label: proseText("DOB"),
					caseWrite: { caseType: "patient", property: "dob" },
				}),
			],
		});
		expect(resolveEffectivePropertyType(doc, "patient", "dob")).toBe("date");
	});

	it("keeps a declared annotation over the writer derivation", () => {
		const doc = docWith({
			candidateOnly: true, // Pre-gate analysis of a structurally valid candidate.
			caseTypes: [
				{
					name: "patient",
					properties: [
						{ name: "dob", label: proseText("DOB"), data_type: "text" },
					],
				},
			],
			fields: [
				f({
					kind: "date",
					id: "dob",
					label: proseText("DOB"),
					caseWrite: { caseType: "patient", property: "dob" },
				}),
			],
		});
		// Declared wins — the mismatch itself is FIELD_KIND_PROPERTY_TYPE_
		// MISMATCH's finding, not this view's to resolve.
		expect(resolveEffectivePropertyType(doc, "patient", "dob")).toBe("text");
	});

	it("infers date from a hidden writer whose expression is exactly today()", () => {
		const doc = docWith({
			fields: [
				f({
					kind: "hidden",
					id: "visit_date",
					caseWrite: { caseType: "patient", property: "visit_date" },
					default_value: "today()",
				}),
			],
		});
		expect(resolveEffectivePropertyType(doc, "patient", "visit_date")).toBe(
			"date",
		);
	});

	it("infers datetime from now(), tolerating surrounding whitespace", () => {
		const doc = docWith({
			fields: [
				f({
					kind: "hidden",
					id: "stamp",
					caseWrite: { caseType: "patient", property: "stamp" },
					default_value: "  now()  ",
				}),
			],
		});
		expect(resolveEffectivePropertyType(doc, "patient", "stamp")).toBe(
			"datetime",
		);
	});

	it("resolves a hidden case-ref copy through the referenced property's writers", () => {
		const doc = buildDoc({
			appName: "T",
			caseTypes: [
				{
					name: "patient",
					properties: [{ name: "dob", label: proseText("DOB") }],
				},
				{ name: "visit", parent_type: "patient", properties: [] },
			],
			modules: [
				{
					name: "Patients",
					caseType: "patient",
					caseListConfig: caseListConfig([
						{ field: "case_name", header: "Name" },
					]),
					forms: [
						{
							name: "Reg",
							type: "followup",
							fields: [
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
				{
					name: "Visits",
					caseType: "visit",
					caseListConfig: caseListConfig([
						{ field: "case_name", header: "Name" },
					]),
					forms: [
						{
							name: "Visit",
							type: "followup",
							fields: [
								f({
									kind: "hidden",
									id: "dob",
									caseWrite: { caseType: "visit", property: "dob" },
									default_value: "#patient/dob",
								}),
							],
						},
					],
				},
			],
		});
		expectAdmittedDoc(doc);
		expect(resolveEffectivePropertyType(doc, "visit", "dob")).toBe("date");
	});

	it("resolves unknown (absent), never text, when nothing pins a type", () => {
		const doc = docWith({
			fields: [
				f({
					kind: "hidden",
					id: "score",
					caseWrite: { caseType: "patient", property: "score" },
					default_value: "1 + 2",
				}),
			],
		});
		expect(
			resolveEffectivePropertyType(doc, "patient", "score"),
		).toBeUndefined();
		// The honest-unknown contract: the entry EXISTS in the view (the
		// property is writer-derived) but carries no data_type.
		const patient = effectiveCaseTypes(doc).find((c) => c.name === "patient");
		const entry = patient?.properties.find((p) => p.name === "score");
		expect(entry).toBeDefined();
		expect(entry && "data_type" in entry && entry.data_type).toBeFalsy();
	});

	it("resolves unknown on writer disagreement instead of picking a side", () => {
		const doc = docWith({
			candidateOnly: true, // Pre-gate analysis of a structurally valid candidate.
			fields: [
				f({
					kind: "date",
					id: "date_answer",
					label: proseText("X"),
					caseWrite: { caseType: "patient", property: "x" },
				}),
				f({
					kind: "int",
					id: "int_answer",
					label: proseText("X"),
					caseWrite: { caseType: "patient", property: "x" },
				}),
			],
		});
		expect(resolveEffectivePropertyType(doc, "patient", "x")).toBeUndefined();
	});

	it("resolves a reference cycle to unknown instead of recursing forever", () => {
		const doc = docWith({
			caseTypes: [
				{
					name: "patient",
					properties: [
						{ name: "left", label: proseText("Left") },
						{ name: "right", label: proseText("Right") },
					],
				},
			],
			fields: [
				f({
					kind: "hidden",
					id: "left",
					caseWrite: { caseType: "patient", property: "left" },
					default_value: "#patient/right",
				}),
				f({
					kind: "hidden",
					id: "right",
					caseWrite: { caseType: "patient", property: "right" },
					default_value: "#patient/left",
				}),
			],
		});
		expect(
			resolveEffectivePropertyType(doc, "patient", "left"),
		).toBeUndefined();
		expect(
			resolveEffectivePropertyType(doc, "patient", "right"),
		).toBeUndefined();
	});
});

describe("effectiveCaseTypes — the assembled view", () => {
	it("appends the standard case-list properties with their implicit types", () => {
		const doc = docWith({ fields: [] });
		expect(resolveEffectivePropertyType(doc, "patient", "date_opened")).toBe(
			"datetime",
		);
		expect(resolveEffectivePropertyType(doc, "patient", "owner_id")).toBe(
			"text",
		);
	});

	it("never invents a case type the catalog doesn't declare", () => {
		const doc = docWith({
			candidateOnly: true, // Pre-gate analysis of a structurally valid candidate.
			fields: [
				f({
					kind: "text",
					id: "n",
					label: proseText("N"),
					caseWrite: { caseType: "undeclared_type", property: "n" },
				}),
			],
		});
		expect(
			effectiveCaseTypes(doc).some((c) => c.name === "undeclared_type"),
		).toBe(false);
	});

	it("memoizes per doc reference", () => {
		const doc = docWith({ fields: [] });
		expect(effectiveCaseTypes(doc)).toBe(effectiveCaseTypes(doc));
	});
});
