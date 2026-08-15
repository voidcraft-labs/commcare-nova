// Behavioral tests for the SA tool schema generator.
//
// The generator is the single source of truth for the `addFields` and
// `editField` tool inputs. Each is ONE flat kind-gated object: every slot
// stated once, with the kind policy (`superRefine` over
// `fieldKindDeclaresKey`) rejecting a "wrong property for this kind" input
// (e.g. `calculate` on a `single_select`) at the tool boundary rather than
// dropping it downstream. These tests pin that contract behaviorally (via
// `safeParse`) rather than introspecting the emitted JSON schema shape,
// which keeps them robust to Zod's serialization choices.

import { describe, expect, it } from "vitest";
import { xp } from "@/lib/__tests__/docHelpers";
import { fieldKinds, fieldRegistry } from "@/lib/domain";
import { proseText } from "@/lib/domain/prose";
import { buildSolutionsArchitectPrompt } from "../prompts";
import {
	fieldKindGuide,
	generateToolSchemas,
	projectedOptionsSourceSchema,
} from "../toolSchemaGenerator";
import { addFieldsInputSchema } from "../tools/addFields";
import { createFormInputSchema } from "../tools/createForm";
import { createModuleInputSchema } from "../tools/createModule";
import { editFieldInputSchema } from "../tools/editField";

const generated = generateToolSchemas();
const retiredCaseWriteKey = ["case", "property", "on"].join("_");

/**
 * A minimal VALID add payload for a kind, respecting that kind's required
 * properties: visible/media/label kinds need a non-empty `label`; `hidden`
 * needs a value (`calculate`) and carries no label; selects need ≥2
 * `options`; `repeat` needs a `repeat` config; `group` takes an optional
 * label.
 */
function validAddPayload(kind: string): Record<string, unknown> {
	const p: Record<string, unknown> = { id: `f_${kind}`, kind };
	if (kind === "hidden") {
		p.calculate = xp("today()");
	} else if (kind === "repeat") {
		p.label = proseText("Repeat");
		p.repeat = { mode: "user_controlled" };
	} else if (kind === "group") {
		p.label = proseText("Group");
	} else {
		// text / int / decimal / date / time / datetime / select / multi /
		// geopoint / barcode / secret / image / audio / video / signature /
		// label — all carry a required non-empty label.
		p.label = proseText("Label");
	}
	if (kind === "single_select" || kind === "multi_select") {
		p.optionsSource = {
			kind: "inline",
			options: [
				{ value: "a", label: proseText("A") },
				{ value: "b", label: proseText("B") },
			],
		};
	}
	return p;
}

describe("toolSchemaGenerator", () => {
	it("exposes the two tool inputs", () => {
		expect(generated.addFieldsItemSchema).toBeDefined();
		expect(generated.editFieldUpdatesSchema).toBeDefined();
	});

	it("accepts a valid payload for every registry kind on the add tool", () => {
		for (const kind of fieldKinds) {
			const payload = validAddPayload(kind);
			expect(
				generated.addFieldsItemSchema.safeParse(payload).success,
				`addFields arm for ${kind}`,
			).toBe(true);
		}
	});

	it("accepts useful help content during atomic field creation", () => {
		const field = {
			...validAddPayload("text"),
			help: proseText("Include the country code when it is known."),
		};
		expect(generated.addFieldsItemSchema.safeParse(field).success).toBe(true);
		expect(
			createModuleInputSchema.safeParse({
				name: "Registration",
				forms: [
					{
						name: "Register",
						type: "survey",
						fields: [field],
					},
				],
			}).success,
		).toBe(true);
	});

	it("lets a case-bound field omit label and options — the record seeds them", () => {
		// The prompt teaches stating those slots on a case-bound field only
		// to OVERRIDE the catalog record, so the parse boundary must accept
		// the instructed shape — `applyDefaults` seeds canonical label/options
		// right after this parse. Contextual validation and requiredness remain
		// explicit on the field.
		expect(
			generated.addFieldsItemSchema.safeParse({
				id: "blood_type",
				kind: "single_select",
				caseWrite: { caseType: "patient", property: "blood_type" },
			}).success,
		).toBe(true);
		expect(
			generated.addFieldsItemSchema.safeParse({
				id: "age",
				kind: "int",
				caseWrite: { caseType: "patient", property: "age" },
			}).success,
		).toBe(true);
		// Without the case binding the label/options floors still hold.
		expect(
			generated.addFieldsItemSchema.safeParse({
				id: "blood_type",
				kind: "single_select",
			}).success,
		).toBe(false);
		// A STATED override must still be a real choice list — a 1-entry
		// list is wrong on every path, case-bound included.
		expect(
			generated.addFieldsItemSchema.safeParse({
				id: "blood_type",
				kind: "single_select",
				caseWrite: { caseType: "patient", property: "blood_type" },
				optionsSource: {
					kind: "inline",
					options: [{ value: "a", label: proseText("A") }],
				},
			}).success,
		).toBe(false);
	});

	it("keeps a friendly field id independent from its complete case destination", () => {
		expect(
			generated.addFieldsItemSchema.safeParse({
				id: "name",
				kind: "text",
				caseWrite: { caseType: "patient", property: "case_name" },
			}).success,
		).toBe(true);
	});

	it.each(["name", "external-id", "date-opened"])(
		"rejects retired case-property spelling %s without restricting the field id",
		(property) => {
			expect(
				generated.addFieldsItemSchema.safeParse({
					id: "friendly_name",
					kind: "text",
					caseWrite: { caseType: "patient", property },
				}).success,
			).toBe(false);
		},
	);

	it("requires caseWrite as one complete pair and rejects the removed key", () => {
		expect(
			generated.addFieldsItemSchema.safeParse({
				id: "phone",
				kind: "text",
				caseWrite: { caseType: "patient" },
			}).success,
		).toBe(false);
		expect(
			generated.addFieldsItemSchema.safeParse({
				id: "phone",
				kind: "text",
				caseWrite: { property: "phone" },
			}).success,
		).toBe(false);
		expect(
			generated.addFieldsItemSchema.safeParse({
				id: "phone",
				kind: "text",
				[retiredCaseWriteKey]: "patient",
			}).success,
		).toBe(false);
	});

	it("surfaces each kind's saDocs through the prompt's Field kinds guide", () => {
		// The per-kind guide is stated ONCE — in the system prompt via
		// `fieldKindGuide()` — rather than repeated on each schema's kind
		// enum. Assert every kind's saDocs appears in the guide, and that
		// the built prompt carries the guide.
		const guide = fieldKindGuide();
		for (const kind of fieldKinds) {
			expect(
				guide.includes(fieldRegistry[kind].saDocs),
				`saDocs for ${kind}`,
			).toBe(true);
		}
		expect(buildSolutionsArchitectPrompt()).toContain(guide);
	});

	// ── The structural win: per-kind property scoping ───────────────────

	it("rejects `calculate` on a visible kind (the slot isn't on its arm)", () => {
		const base = validAddPayload("single_select");
		expect(generated.addFieldsItemSchema.safeParse(base).success).toBe(true);
		// Adding `calculate` (a hidden-only slot) makes the single_select arm
		// reject the whole input — the SA can't express it.
		expect(
			generated.addFieldsItemSchema.safeParse({
				...base,
				calculate: xp("if(1, 'a', 'b')"),
			}).success,
		).toBe(false);
		// Same for a text field.
		expect(
			generated.addFieldsItemSchema.safeParse({
				id: "t",
				kind: "text",
				label: proseText("T"),
				calculate: xp("1"),
			}).success,
		).toBe(false);
	});

	it("accepts `default_value` on selects + barcode (now a declared slot)", () => {
		for (const kind of ["single_select", "multi_select", "barcode"] as const) {
			const payload = {
				...validAddPayload(kind),
				default_value: xp("#patient/x"),
			};
			expect(
				generated.addFieldsItemSchema.safeParse(payload).success,
				`default_value on ${kind}`,
			).toBe(true);
		}
	});

	it("rejects label/options on a hidden field but accepts calculate or default_value", () => {
		// hidden carries no label and no options slot.
		expect(
			generated.addFieldsItemSchema.safeParse({
				id: "h",
				kind: "hidden",
				calculate: xp("today()"),
				label: proseText("nope"),
			}).success,
		).toBe(false);
		// calculate-only and default_value-only hidden fields both parse.
		expect(
			generated.addFieldsItemSchema.safeParse({
				id: "h",
				kind: "hidden",
				calculate: xp("today()"),
			}).success,
		).toBe(true);
		expect(
			generated.addFieldsItemSchema.safeParse({
				id: "h",
				kind: "hidden",
				default_value: xp("today()"),
			}).success,
		).toBe(true);
	});

	it("requires a non-empty label on visible kinds, none on hidden", () => {
		// Visible kind with empty label → rejected (min(1)).
		expect(
			generated.addFieldsItemSchema.safeParse({
				id: "t",
				kind: "text",
				label: proseText(""),
			}).success,
		).toBe(false);
		// hidden with a label key → rejected (no label slot).
		expect(
			generated.addFieldsItemSchema.safeParse({
				id: "h",
				kind: "hidden",
				calculate: xp("1"),
				label: proseText(""),
			}).success,
		).toBe(false);
	});

	it("parses a representative valid payload for every field kind", () => {
		for (const kind of fieldKinds) {
			const result = generated.addFieldsItemSchema.safeParse(
				validAddPayload(kind),
			);
			expect(result.success, `kind ${kind} failed to parse`).toBe(true);
		}
	});

	// ── Repeat config (discriminated on mode) ────────────────────────────

	it("enforces mode-specific repeat fields at the tool boundary", () => {
		const repeatPayload = (repeat: unknown) => ({
			id: "r",
			kind: "repeat",
			label: proseText("R"),
			repeat,
		});
		// user_controlled needs nothing extra.
		expect(
			generated.addFieldsItemSchema.safeParse(
				repeatPayload({ mode: "user_controlled" }),
			).success,
		).toBe(true);
		// count_bound REQUIRES count; query_bound REQUIRES ids_query.
		expect(
			generated.addFieldsItemSchema.safeParse(
				repeatPayload({ mode: "count_bound", count: xp("#form/n") }),
			).success,
		).toBe(true);
		expect(
			generated.addFieldsItemSchema.safeParse(
				repeatPayload({ mode: "count_bound" }),
			).success,
		).toBe(false);
		expect(
			generated.addFieldsItemSchema.safeParse(
				repeatPayload({ mode: "query_bound", ids_query: xp("#form/ids") }),
			).success,
		).toBe(true);
		expect(
			generated.addFieldsItemSchema.safeParse(
				repeatPayload({ mode: "query_bound" }),
			).success,
		).toBe(false);
	});

	// ── editField (per-kind, kind required as discriminator) ─────────────

	it("requires `kind` on the edit patch (it's the union discriminator)", () => {
		// Without `kind`, the discriminated union can't pick an arm.
		expect(
			generated.editFieldUpdatesSchema.safeParse({
				label: proseText("x"),
			}).success,
		).toBe(false);
		// With `kind`, an in-place patch validates against that kind's props.
		expect(
			generated.editFieldUpdatesSchema.safeParse({
				kind: "text",
				label: proseText("x"),
			}).success,
		).toBe(true);
	});

	it("scopes edit-patch props per kind and keeps clearable keys nullable", () => {
		// `calculate` isn't on the single_select edit arm.
		expect(
			generated.editFieldUpdatesSchema.safeParse({
				kind: "single_select",
				calculate: "x",
			}).success,
		).toBe(false);
		// Clearable keys accept `null` to reset.
		expect(
			generated.editFieldUpdatesSchema.safeParse({
				kind: "text",
				relevant: null,
				default_value: null,
			}).success,
		).toBe(true);
	});

	it("edits field id and caseWrite independently, with null clearing the writer", () => {
		expect(
			generated.editFieldUpdatesSchema.safeParse({
				kind: "text",
				id: "friendly_name",
				caseWrite: { caseType: "patient", property: "case_name" },
			}).success,
		).toBe(true);
		expect(
			generated.editFieldUpdatesSchema.safeParse({
				kind: "text",
				caseWrite: null,
			}).success,
		).toBe(true);
	});

	it("rejects partial, retired, and removed case-write shapes on edit", () => {
		for (const caseWrite of [
			{ caseType: "patient" },
			{ property: "phone" },
			{ caseType: "patient", property: "external-id" },
		]) {
			expect(
				generated.editFieldUpdatesSchema.safeParse({
					kind: "text",
					caseWrite,
				}).success,
			).toBe(false);
		}
		expect(
			generated.editFieldUpdatesSchema.safeParse({
				kind: "text",
				[retiredCaseWriteKey]: "patient",
			}).success,
		).toBe(false);
	});

	it("uses one strict projected option/source contract across all four field writers", () => {
		const moduleUuid = "11111111-1111-4111-8111-111111111111";
		const formUuid = "22222222-2222-4222-8222-222222222222";
		const fieldUuid = "33333333-3333-4333-8333-333333333333";
		const optionUuid = "44444444-4444-4444-8444-444444444444";
		const inline = {
			kind: "inline" as const,
			options: [
				{ optionUuid, value: "yes", label: proseText("Yes") },
				{ value: "no", label: proseText("No") },
			],
		};
		const select = {
			kind: "single_select" as const,
			id: "answer",
			label: proseText("Answer"),
			optionsSource: inline,
		};
		const writerInputs = [
			{
				schema: addFieldsInputSchema,
				input: { moduleUuid, formUuid, fields: [select] },
			},
			{
				schema: createFormInputSchema,
				input: {
					moduleUuid,
					name: "Questions",
					type: "survey",
					fields: [select],
				},
			},
			{
				schema: createModuleInputSchema,
				input: {
					name: "Questions",
					forms: [
						{
							name: "Questions",
							type: "survey",
							fields: [select],
						},
					],
				},
			},
			{
				schema: editFieldInputSchema,
				input: {
					moduleUuid,
					formUuid,
					fieldUuid,
					updates: {
						kind: "single_select",
						optionsSource: inline,
					},
				},
			},
		] as const;

		for (const { schema, input } of writerInputs) {
			expect(schema.safeParse(input).success).toBe(true);
		}
		const fieldInputOf = (
			copy: Record<string, unknown>,
		): Record<string, unknown> | undefined =>
			"fields" in copy
				? (copy.fields as Array<Record<string, unknown>>)[0]
				: "forms" in copy
					? (
							(copy.forms as Array<Record<string, unknown>>)[0].fields as Array<
								Record<string, unknown>
							>
						)[0]
					: (copy.updates as Record<string, unknown>);

		const forbiddenOptionKeys = [
			{ uuid: optionUuid },
			{ media: { image: "asset-id" } },
			{ option_id: optionUuid },
		];
		for (const forbidden of forbiddenOptionKeys) {
			expect(
				projectedOptionsSourceSchema.safeParse({
					kind: "inline",
					options: [
						{ value: "yes", label: proseText("Yes"), ...forbidden },
						{ value: "no", label: proseText("No") },
					],
				}).success,
			).toBe(false);
			for (const { schema, input } of writerInputs) {
				const copy = structuredClone(input) as Record<string, unknown>;
				const field = fieldInputOf(copy);
				const source = field?.optionsSource as {
					options: Array<Record<string, unknown>>;
				};
				Object.assign(source.options[0], forbidden);
				expect(schema.safeParse(copy).success).toBe(false);
			}
		}

		const canonicalLookup = {
			kind: "lookup" as const,
			tableId: "018f0000-0000-7000-8000-000000000001",
			valueColumnId: "018f0000-0000-7000-8000-000000000002",
			labelColumnId: "018f0000-0000-7000-8000-000000000003",
		};
		expect(
			projectedOptionsSourceSchema.safeParse(canonicalLookup).success,
		).toBe(true);
		expect(
			projectedOptionsSourceSchema.safeParse({
				kind: "lookup",
				tableUuid: canonicalLookup.tableId,
				valueColumnUuid: canonicalLookup.valueColumnId,
				labelColumnUuid: canonicalLookup.labelColumnId,
			}).success,
		).toBe(false);
		for (const { schema, input } of writerInputs) {
			const canonicalCopy = structuredClone(input) as Record<string, unknown>;
			const canonicalField = fieldInputOf(canonicalCopy);
			if (!canonicalField) throw new Error("writer field fixture missing");
			canonicalField.optionsSource = canonicalLookup;
			expect(schema.safeParse(canonicalCopy).success).toBe(true);

			const aliasCopy = structuredClone(input) as Record<string, unknown>;
			const aliasField = fieldInputOf(aliasCopy);
			if (!aliasField) throw new Error("writer field fixture missing");
			aliasField.optionsSource = {
				kind: "lookup",
				tableUuid: canonicalLookup.tableId,
				valueColumnUuid: canonicalLookup.valueColumnId,
				labelColumnUuid: canonicalLookup.labelColumnId,
			};
			expect(schema.safeParse(aliasCopy).success).toBe(false);
		}
	});
});
