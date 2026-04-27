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

import tablerEyeOff from "@iconify-icons/tabler/eye-off";
import { z } from "zod";
import type { FieldKindMetadata } from "../kinds";
import { structuralFieldBase } from "./base";

export const hiddenFieldSchema = structuralFieldBase.extend({
	kind: z.literal("hidden"),
	// calculate is required — a hidden field must have a compute expression;
	// without one it would always be blank and serve no purpose.
	calculate: z.string(),
	default_value: z.string().optional(),
	required: z.string().optional(),
	relevant: z.string().optional(),
	case_property_on: z.string().optional(),
});

export type HiddenField = z.infer<typeof hiddenFieldSchema>;

export const hiddenFieldMetadata: FieldKindMetadata<"hidden"> = {
	kind: "hidden",
	xformKind: "input",
	dataType: "xsd:string",
	icon: tablerEyeOff,
	label: "Hidden",
	isStructural: false,
	isContainer: false,
	saDocs:
		"Computed value that the user never sees. Must have a calculate expression.",
	convertTargets: [],
};
