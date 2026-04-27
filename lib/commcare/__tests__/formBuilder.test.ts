/**
 * Tests for the form builder agent's mutation-builder helpers + the
 * doc-native `deriveCaseConfig` helper.
 *
 * The mutation-builder tests build a minimal `BlueprintDoc` shell,
 * invoke a helper, apply the returned mutations to the doc, and assert
 * on the resulting doc state. The case-derivation tests at the bottom
 * exercise `deriveCaseConfig` end-to-end through the same doc shape
 * that the expander + validator feed it in production.
 */
import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import {
	addFieldMutations,
	findFieldByBareId,
	updateFormMutations,
} from "@/lib/agent/blueprintHelpers";
import { deriveCaseConfig } from "@/lib/commcare/deriveCaseConfig";
import { applyMutations } from "@/lib/doc/mutations";
import type { BlueprintDoc, Uuid } from "@/lib/doc/types";
import { asUuid } from "@/lib/doc/types";
import type { Field, Form, FormType } from "@/lib/domain";

// ── Fixture builders ──────────────────────────────────────────────────

const MOD = asUuid("11111111-1111-1111-1111-111111111111");
const FORM = asUuid("22222222-2222-2222-2222-222222222222");

/** Construct a minimal normalized doc with one module + one form. */
function makeShellDoc(type: FormType = "registration"): BlueprintDoc {
	const form: Form = {
		uuid: FORM,
		id: "test_form",
		name: "Test Form",
		type,
	};
	return {
		appId: "test-app",
		appName: "Test App",
		connectType: null,
		caseTypes:
			type !== "survey"
				? [
						{
							name: "patient",
							properties: [{ name: "case_name", label: "Full Name" }],
						},
					]
				: null,
		modules: {
			[MOD]: {
				uuid: MOD,
				id: "test_module",
				name: "Test Module",
				...(type !== "survey" && { caseType: "patient" }),
			},
		},
		forms: { [FORM]: form },
		fields: {},
		moduleOrder: [MOD],
		formOrder: { [MOD]: [FORM] },
		fieldOrder: { [FORM]: [] },
		fieldParent: {},
	};
}

/** Apply a mutation batch to a doc via Immer, returning the next doc
 *  snapshot. Matches the store's `applyMany` behavior semantically but
 *  without requiring a Zustand instance for unit tests. */
function apply(doc: BlueprintDoc, muts: Parameters<typeof applyMutations>[1]) {
	return produce(doc, (draft) => {
		applyMutations(draft as unknown as BlueprintDoc, muts);
	});
}

/** Build a concrete domain Field for a text kind with a label. */
function textField(
	id: string,
	label: string,
	extras: Partial<Field> = {},
): Field {
	return {
		uuid: asUuid(crypto.randomUUID()),
		id,
		label,
		kind: "text",
		...(extras as object),
	} as Field;
}

/** Build a group container field. */
function groupField(id: string, label: string): Field {
	return {
		uuid: asUuid(crypto.randomUUID()),
		id,
		label,
		kind: "group",
	} as Field;
}

describe("Form Builder Agent Integration — mutation-builder helpers", () => {
	describe("addFieldMutations", () => {
		it("adds a simple text field", () => {
			const doc0 = makeShellDoc();
			const field = textField("case_name", "Patient Name", {
				case_property_on: "case_name",
			} as Partial<Field>);
			const muts = addFieldMutations(doc0, { parentUuid: FORM, field });
			const doc1 = apply(doc0, muts);

			const order = doc1.fieldOrder[FORM];
			expect(order).toHaveLength(1);
			const added = doc1.fields[order[0]];
			expect(added.id).toBe("case_name");
			expect(added.kind).toBe("text");
			expect((added as { case_property_on?: string }).case_property_on).toBe(
				"case_name",
			);
		});

		it("adds fields in sequence", () => {
			let doc: BlueprintDoc = makeShellDoc();
			doc = apply(
				doc,
				addFieldMutations(doc, {
					parentUuid: FORM,
					field: textField("q1", "Q1"),
				}),
			);
			doc = apply(
				doc,
				addFieldMutations(doc, {
					parentUuid: FORM,
					field: { ...textField("q2", "Q2"), kind: "int" } as Field,
				}),
			);
			doc = apply(
				doc,
				addFieldMutations(doc, {
					parentUuid: FORM,
					field: { ...textField("q3", "Q3"), kind: "date" } as Field,
				}),
			);

			const order = doc.fieldOrder[FORM];
			expect(order.map((u) => doc.fields[u].id)).toEqual(["q1", "q2", "q3"]);
		});

		it("adds a single_select field with options", () => {
			const doc0 = makeShellDoc();
			const field: Field = {
				uuid: asUuid(crypto.randomUUID()),
				id: "gender",
				label: "Gender",
				kind: "single_select",
				options: [
					{ value: "male", label: "Male" },
					{ value: "female", label: "Female" },
				],
				case_property_on: "gender",
			} as Field;
			const doc1 = apply(
				doc0,
				addFieldMutations(doc0, { parentUuid: FORM, field }),
			);

			const uuid = doc1.fieldOrder[FORM][0];
			const stored = doc1.fields[uuid] as {
				options?: Array<{ value: string; label: string }>;
			};
			expect(stored.options).toHaveLength(2);
			expect(stored.options?.[0].value).toBe("male");
		});

		it("adds a hidden calculated field", () => {
			let doc: BlueprintDoc = makeShellDoc();
			doc = apply(
				doc,
				addFieldMutations(doc, {
					parentUuid: FORM,
					field: { ...textField("age", "Age"), kind: "int" } as Field,
				}),
			);
			const hidden: Field = {
				uuid: asUuid(crypto.randomUUID()),
				id: "age_group",
				kind: "hidden",
				calculate: "if(/data/age < 18, 'child', 'adult')",
				case_property_on: "age_group",
			} as Field;
			doc = apply(
				doc,
				addFieldMutations(doc, { parentUuid: FORM, field: hidden }),
			);

			const found = findFieldByBareId(doc, FORM, "age_group");
			expect(found).toBeDefined();
			expect(found?.field.kind).toBe("hidden");
			expect((found?.field as { calculate?: string }).calculate).toBe(
				"if(/data/age < 18, 'child', 'adult')",
			);
		});

		it("nests fields inside a group container", () => {
			let doc: BlueprintDoc = makeShellDoc();
			const group = groupField("demographics", "Demographics");
			doc = apply(
				doc,
				addFieldMutations(doc, { parentUuid: FORM, field: group }),
			);

			// The group's uuid is the parent for nested inserts. Look it up
			// from the updated doc — the helper doesn't expose it directly.
			const groupUuid = doc.fieldOrder[FORM][0];

			doc = apply(
				doc,
				addFieldMutations(doc, {
					parentUuid: groupUuid,
					field: textField("first_name", "First Name"),
				}),
			);
			doc = apply(
				doc,
				addFieldMutations(doc, {
					parentUuid: groupUuid,
					field: textField("last_name", "Last Name"),
				}),
			);

			expect(doc.fieldOrder[FORM]).toEqual([groupUuid]);
			const children = doc.fieldOrder[groupUuid] ?? [];
			expect(children.map((u) => doc.fields[u].id)).toEqual([
				"first_name",
				"last_name",
			]);
		});

		it("inserts at a specific index", () => {
			let doc: BlueprintDoc = makeShellDoc();
			doc = apply(
				doc,
				addFieldMutations(doc, {
					parentUuid: FORM,
					field: textField("q1", "Q1"),
				}),
			);
			doc = apply(
				doc,
				addFieldMutations(doc, {
					parentUuid: FORM,
					field: textField("q3", "Q3"),
				}),
			);
			// Insert q2 between q1 and q3 at index 1.
			doc = apply(
				doc,
				addFieldMutations(doc, {
					parentUuid: FORM,
					field: textField("q2", "Q2"),
					index: 1,
				}),
			);
			const order = doc.fieldOrder[FORM];
			expect(order.map((u) => doc.fields[u].id)).toEqual(["q1", "q2", "q3"]);
		});

		it("is a no-op when parent uuid doesn't exist", () => {
			const doc0 = makeShellDoc();
			const muts = addFieldMutations(doc0, {
				parentUuid: asUuid("99999999-9999-9999-9999-999999999999") as Uuid,
				field: textField("orphan", "Orphan"),
			});
			expect(muts).toHaveLength(0);
		});
	});

	describe("updateFormMutations — close_condition", () => {
		it("sets a close_condition on a close form", () => {
			const doc0 = makeShellDoc("close");
			const muts = updateFormMutations(doc0, FORM, {
				closeCondition: { field: "discharge", answer: "yes" },
			});
			const doc1 = apply(doc0, muts);
			expect(doc1.forms[FORM].closeCondition).toEqual({
				field: "discharge",
				answer: "yes",
			});
		});

		it("clears close_condition when passed null", () => {
			let doc: BlueprintDoc = makeShellDoc("close");
			// First, set a condition.
			doc = apply(
				doc,
				updateFormMutations(doc, FORM, {
					closeCondition: { field: "x", answer: "y" },
				}),
			);
			expect(doc.forms[FORM].closeCondition).toBeDefined();
			// Then clear it via null.
			doc = apply(
				doc,
				updateFormMutations(doc, FORM, { closeCondition: null }),
			);
			expect(doc.forms[FORM].closeCondition).toBeUndefined();
		});
	});
});

// ── deriveCaseConfig tests (doc-native helper) ───────────────────────
//
// `deriveCaseConfig` walks `doc.fieldOrder[formUuid]` and reads domain
// field keys (kind, id, case_property_on). The tests feed it the same
// normalized doc shape that the expander + validator use in production.

describe("child case derivation via case_property_on annotations", () => {
	const caseTypes = [
		{
			name: "patient",
			properties: [{ name: "case_name", label: "Full Name" }],
		},
		{
			name: "referral",
			properties: [{ name: "case_name", label: "Referral Name" }],
		},
	];

	it("derives a child case from case_property_on annotations", () => {
		const doc = buildDoc({
			appName: "Test App",
			modules: [
				{
					name: "Test Module",
					caseType: "patient",
					forms: [
						{
							name: "Test Form",
							type: "registration",
							fields: [
								f({
									kind: "text",
									id: "case_name",
									label: "Referral Name",
									case_property_on: "referral",
								}),
								f({
									kind: "text",
									id: "referral_reason",
									label: "Referral Reason",
									case_property_on: "referral",
								}),
							],
						},
					],
				},
			],
			caseTypes,
		});

		const moduleUuid = doc.moduleOrder[0];
		const formUuid = doc.formOrder[moduleUuid][0];
		const config = deriveCaseConfig(doc, formUuid, "patient", "registration");

		expect(config.child_cases).toHaveLength(1);
		expect(config.child_cases?.[0].case_type).toBe("referral");
		expect(config.child_cases?.[0].case_name_field).toBe("case_name");
	});

	it("separates primary and child case properties", () => {
		const doc = buildDoc({
			appName: "Test App",
			modules: [
				{
					name: "Test Module",
					caseType: "patient",
					forms: [
						{
							name: "Test Form",
							type: "registration",
							fields: [
								f({
									kind: "text",
									id: "case_name",
									label: "Patient Name",
									case_property_on: "patient",
								}),
								f({
									kind: "text",
									id: "case_name",
									label: "Referral Name",
									case_property_on: "referral",
								}),
								f({
									kind: "text",
									id: "referral_reason",
									label: "Reason",
									case_property_on: "referral",
								}),
							],
						},
					],
				},
			],
			caseTypes,
		});

		const moduleUuid = doc.moduleOrder[0];
		const formUuid = doc.formOrder[moduleUuid][0];
		const config = deriveCaseConfig(doc, formUuid, "patient", "registration");

		expect(config.case_name_field).toBe("case_name");
		expect(config.child_cases).toHaveLength(1);
		expect(config.child_cases?.[0].case_type).toBe("referral");
		expect(config.child_cases?.[0].case_properties).toEqual([
			{ case_property: "referral_reason", question_id: "referral_reason" },
		]);
	});
});
