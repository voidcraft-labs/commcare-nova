// The effective case-type view — property types as derived facts
// (declared ?? writer-derived ?? honest unknown). See
// `lib/domain/effectiveCaseTypes.ts`'s header for the model; these
// tests pin the resolution rules and the honest-unknown contract the
// column-applicability + gate consumers depend on.

import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import type { CasePropertyDataType, PersistableDoc } from "@/lib/domain";
import { effectiveCaseTypes } from "@/lib/domain";

/** Test-local single-property read over the effective view —
 *  `undefined` conflates missing-and-unknown, which is fine for
 *  assertions but exactly why this is not a production API. */
function resolveEffectivePropertyType(
	doc: PersistableDoc,
	caseType: string,
	property: string,
): CasePropertyDataType | undefined {
	const ct = effectiveCaseTypes(doc).find((c) => c.name === caseType);
	return ct?.properties.find((p) => p.name === property)?.data_type;
}

/** A doc with one module/form so writer fields have a home. */
function docWith(args: {
	fields: Parameters<typeof f>[0][];
	caseTypes?: NonNullable<Parameters<typeof buildDoc>[0]>["caseTypes"];
}) {
	return buildDoc({
		appName: "T",
		caseTypes: args.caseTypes ?? [{ name: "patient", properties: [] }],
		modules: [
			{
				name: "Mod",
				caseType: "patient",
				forms: [
					{
						name: "Reg",
						type: "registration",
						fields: args.fields.map((spec) => f(spec)),
					},
				],
			},
		],
	});
}

describe("effectiveCaseTypes — writer derivation", () => {
	it("derives a declared-but-untyped property's type from its writer field's kind", () => {
		const doc = docWith({
			caseTypes: [
				{ name: "patient", properties: [{ name: "dob", label: "DOB" }] },
			],
			fields: [
				f({
					kind: "date",
					id: "dob",
					label: "DOB",
					case_property_on: "patient",
				}),
			],
		});
		expect(resolveEffectivePropertyType(doc, "patient", "dob")).toBe("date");
	});

	it("keeps a declared annotation over the writer derivation", () => {
		const doc = docWith({
			caseTypes: [
				{
					name: "patient",
					properties: [{ name: "dob", label: "DOB", data_type: "text" }],
				},
			],
			fields: [
				f({
					kind: "date",
					id: "dob",
					label: "DOB",
					case_property_on: "patient",
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
					case_property_on: "patient",
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
					case_property_on: "patient",
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
				{ name: "patient", properties: [] },
				{ name: "visit", properties: [] },
			],
			modules: [
				{
					name: "Patients",
					caseType: "patient",
					forms: [
						{
							name: "Reg",
							type: "registration",
							fields: [
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
				{
					name: "Visits",
					caseType: "visit",
					forms: [
						{
							name: "Visit",
							type: "registration",
							fields: [
								f({
									kind: "hidden",
									id: "dob",
									case_property_on: "visit",
									default_value: "#patient/dob",
								}),
							],
						},
					],
				},
			],
		});
		expect(resolveEffectivePropertyType(doc, "visit", "dob")).toBe("date");
	});

	it("resolves unknown (absent), never text, when nothing pins a type", () => {
		const doc = docWith({
			fields: [
				f({
					kind: "hidden",
					id: "score",
					case_property_on: "patient",
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
			fields: [
				f({ kind: "date", id: "x", label: "X", case_property_on: "patient" }),
				f({ kind: "int", id: "x", label: "X", case_property_on: "patient" }),
			],
		});
		expect(resolveEffectivePropertyType(doc, "patient", "x")).toBeUndefined();
	});

	it("resolves a reference cycle to unknown instead of recursing forever", () => {
		const doc = buildDoc({
			appName: "T",
			caseTypes: [
				{ name: "a", properties: [] },
				{ name: "b", properties: [] },
			],
			modules: [
				{
					name: "A",
					caseType: "a",
					forms: [
						{
							name: "FA",
							type: "registration",
							fields: [
								f({
									kind: "hidden",
									id: "p",
									case_property_on: "a",
									default_value: "#b/p",
								}),
							],
						},
					],
				},
				{
					name: "B",
					caseType: "b",
					forms: [
						{
							name: "FB",
							type: "registration",
							fields: [
								f({
									kind: "hidden",
									id: "p",
									case_property_on: "b",
									default_value: "#a/p",
								}),
							],
						},
					],
				},
			],
		});
		expect(resolveEffectivePropertyType(doc, "a", "p")).toBeUndefined();
		expect(resolveEffectivePropertyType(doc, "b", "p")).toBeUndefined();
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
			fields: [
				f({
					kind: "text",
					id: "n",
					label: "N",
					case_property_on: "undeclared_type",
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
