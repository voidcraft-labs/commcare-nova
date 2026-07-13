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
import { fieldKinds, fieldRegistry } from "@/lib/domain";
import { buildSolutionsArchitectPrompt } from "../prompts";
import { fieldKindGuide, generateToolSchemas } from "../toolSchemaGenerator";

const generated = generateToolSchemas();

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
		p.calculate = "today()";
	} else if (kind === "repeat") {
		p.label = "Repeat";
		p.repeat = { mode: "user_controlled" };
	} else if (kind === "group") {
		p.label = "Group";
	} else {
		// text / int / decimal / date / time / datetime / select / multi /
		// geopoint / barcode / secret / image / audio / video / signature /
		// label — all carry a required non-empty label.
		p.label = "Label";
	}
	if (kind === "single_select" || kind === "multi_select") {
		p.options = [
			{ value: "a", label: "A" },
			{ value: "b", label: "B" },
		];
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

	it("lets a case-bound field omit label and options — the record seeds them", () => {
		// The prompt teaches stating those slots on a case-bound field only
		// to OVERRIDE the catalog record, so the parse boundary must accept
		// the instructed shape — `applyDefaults` seeds label/options/
		// validation/required right after this parse.
		expect(
			generated.addFieldsItemSchema.safeParse({
				id: "blood_type",
				kind: "single_select",
				case_property_on: "patient",
			}).success,
		).toBe(true);
		expect(
			generated.addFieldsItemSchema.safeParse({
				id: "age",
				kind: "int",
				case_property_on: "patient",
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
				case_property_on: "patient",
				options: [{ value: "a", label: "A" }],
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
				calculate: "if(1, 'a', 'b')",
			}).success,
		).toBe(false);
		// Same for a text field.
		expect(
			generated.addFieldsItemSchema.safeParse({
				id: "t",
				kind: "text",
				label: "T",
				calculate: "x",
			}).success,
		).toBe(false);
	});

	it("accepts `default_value` on selects + barcode (now a declared slot)", () => {
		for (const kind of ["single_select", "multi_select", "barcode"] as const) {
			const payload = { ...validAddPayload(kind), default_value: "#patient/x" };
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
				calculate: "today()",
				label: "nope",
			}).success,
		).toBe(false);
		// calculate-only and default_value-only hidden fields both parse.
		expect(
			generated.addFieldsItemSchema.safeParse({
				id: "h",
				kind: "hidden",
				calculate: "today()",
			}).success,
		).toBe(true);
		expect(
			generated.addFieldsItemSchema.safeParse({
				id: "h",
				kind: "hidden",
				default_value: "today()",
			}).success,
		).toBe(true);
	});

	it("requires a non-empty label on visible kinds, none on hidden", () => {
		// Visible kind with empty label → rejected (min(1)).
		expect(
			generated.addFieldsItemSchema.safeParse({
				id: "t",
				kind: "text",
				label: "",
			}).success,
		).toBe(false);
		// hidden with a label key → rejected (no label slot).
		expect(
			generated.addFieldsItemSchema.safeParse({
				id: "h",
				kind: "hidden",
				calculate: "1",
				label: "",
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
			label: "R",
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
				repeatPayload({ mode: "count_bound", count: "#form/n" }),
			).success,
		).toBe(true);
		expect(
			generated.addFieldsItemSchema.safeParse(
				repeatPayload({ mode: "count_bound" }),
			).success,
		).toBe(false);
		expect(
			generated.addFieldsItemSchema.safeParse(
				repeatPayload({ mode: "query_bound", ids_query: "#form/ids" }),
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
			generated.editFieldUpdatesSchema.safeParse({ label: "x" }).success,
		).toBe(false);
		// With `kind`, an in-place patch validates against that kind's props.
		expect(
			generated.editFieldUpdatesSchema.safeParse({
				kind: "text",
				label: "x",
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
});
