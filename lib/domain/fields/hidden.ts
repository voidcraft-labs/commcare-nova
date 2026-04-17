// lib/domain/fields/hidden.ts
//
// Hidden computed field. Never shown to the user — it exists purely to
// carry a calculated value through the form instance. `calculate` is
// REQUIRED (not optional) because a hidden field with no expression would
// always be empty and is meaningless. Maps to CommCare <input> with
// xsd:string; the value is set entirely by the XPath calculate expression.
//
// Extends `structuralFieldBase` (uuid + id), NOT `fieldBaseSchema` —
// hidden fields have no `label` (nothing to display) and no `hint`.
// `required` is kept for edge-case constraint enforcement. Sharing a
// common base with the other kinds means any code that assumes "every
// field has uuid + id" stays correct for hidden fields.

import { z } from "zod";
import { StubField } from "@/components/builder/editor/StubField";
import type { FieldEditorSchema, FieldKindMetadata } from "../kinds";
import { structuralFieldBase } from "./base";

export const hiddenFieldSchema = structuralFieldBase.extend({
	kind: z.literal("hidden"),
	// calculate is required — a hidden field must have a compute expression;
	// without one it would always be blank and serve no purpose.
	calculate: z.string(),
	default_value: z.string().optional(),
	required: z.string().optional(),
	relevant: z.string().optional(),
	case_property: z.string().optional(),
});

export type HiddenField = z.infer<typeof hiddenFieldSchema>;

export const hiddenFieldMetadata: FieldKindMetadata<"hidden"> = {
	kind: "hidden",
	xformKind: "input",
	dataType: "xsd:string",
	icon: "tabler:eye-off",
	isStructural: false,
	isContainer: false,
	saDocs:
		"Computed value that the user never sees. Must have a calculate expression.",
	convertTargets: [],
};

// Editor schema — Phase 1 stubs. calculate is surfaced in logic (required,
// non-optional from the UX perspective too) alongside the other XPath
// expressions. case_property allows the computed value to be written to a
// case property.
export const hiddenFieldEditorSchema: FieldEditorSchema<HiddenField> = {
	data: [{ key: "case_property", component: StubField }],
	logic: [
		{ key: "required", component: StubField },
		{ key: "relevant", component: StubField },
		{ key: "calculate", component: StubField },
		{ key: "default_value", component: StubField },
	],
	ui: [],
};
