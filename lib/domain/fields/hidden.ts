// lib/domain/fields/hidden.ts
//
// Hidden value field. Never shown to the user — it exists purely to carry a
// value through the form instance, set EITHER by a `calculate` (a computed,
// continuously-recomputed value) OR a `default_value` (a one-shot `<setvalue>`
// seed nothing later overwrites). Both are optional here; the
// `HIDDEN_NO_VALUE` validator requires at least one, since a hidden field with
// neither is always blank and pointless. Maps to CommCare <input> with
// xsd:string.
//
// Extends `structuralFieldBase` (uuid + id), NOT `fieldBaseSchema` —
// hidden fields have no `label` (nothing to display) and no `hint`.
// Sharing a common base with the other kinds means any code that assumes
// "every field has uuid + id" stays correct for hidden fields.
//
// A hidden field carries NO `required`: it's never shown, so a user can't
// fill it — if its value came out empty while required, the form would be
// unsubmittable with no visible input to remedy. CommCare's authoring model
// agrees: Vellum's DataBindOnly (the Hidden Value type) sets
// `requiredAttr: { presence: "notallowed" }`. The `requiredOnHidden`
// validator backstops the schema for any value that reaches the doc through
// a lenient path.

import tablerEyeOff from "@iconify-icons/tabler/eye-off";
import { z } from "zod";
import type { FieldKindMetadata } from "../kinds";
import { structuralFieldBase, xpathExpressionSchema } from "./base";

export const hiddenFieldSchema = structuralFieldBase.extend({
	kind: z.literal("hidden"),
	// A hidden field's value comes from `calculate` (computed) OR
	// `default_value` (a one-shot seed) — both optional; the `HIDDEN_NO_VALUE`
	// validator enforces that at least one is present.
	calculate: xpathExpressionSchema.optional(),
	default_value: xpathExpressionSchema.optional(),
	relevant: xpathExpressionSchema.optional(),
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
		"Value the user never sees — set by a calculate expression or a default value.",
	convertTargets: [],
};
