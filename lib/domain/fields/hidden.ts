// lib/domain/fields/hidden.ts
//
// Hidden value field. Never shown to the user — it exists purely to carry a
// value through the form instance, set by EXACTLY ONE of `calculate` (a
// computed value, re-evaluated whenever a referenced value changes and on
// every form load) or `default_value` (a one-shot `<setvalue>` seed that runs
// when the form instance is first opened and never again). Both slots are
// optional in the schema so a stored document always hydrates. The validator's
// `HIDDEN_NO_VALUE` refuses neither (always blank, pointless); both is the
// dead pair (JavaRosa evaluates every calculate after the `xforms-ready`
// seeds, so the default is overwritten before anyone could read it), and
// every authoring surface refuses to write it: the SA and MCP tool schemas
// reject it in one call, `editField` clears the held slot when the other is
// set, and the builder's Value control names both slots on every write.
// `hiddenFieldCarriesBothValueSources` is the one recognizer of that pair,
// shared by the tool boundary and the one-off scan and repair of historical
// documents. Maps to CommCare <input> with xsd:string.
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
import {
	caseWriteSchema,
	structuralFieldBase,
	xpathExpressionSchema,
} from "./base";

export const hiddenFieldSchema = structuralFieldBase.extend({
	kind: z.literal("hidden"),
	// A hidden field's value comes from `calculate` (computed) OR
	// `default_value` (a one-shot seed): exactly one, enforced at the
	// authoring boundaries rather than the schema so historical documents
	// hydrate.
	calculate: xpathExpressionSchema.optional(),
	default_value: xpathExpressionSchema.optional(),
	relevant: xpathExpressionSchema.optional(),
	caseWrite: caseWriteSchema.optional(),
});

export type HiddenField = z.infer<typeof hiddenFieldSchema>;

/**
 * The dead pair: a hidden field carrying both a calculation and a starting
 * value. Presence is object presence, the same test `HIDDEN_NO_VALUE` uses,
 * so the two recognizers partition the hidden state space (neither slot,
 * both slots, exactly one). Shared by the tool-boundary refinement, the
 * one-off scan, and the repair planner so they cannot drift.
 */
export function hiddenFieldCarriesBothValueSources(field: {
	kind: string;
	calculate?: unknown;
	default_value?: unknown;
}): field is HiddenField & {
	calculate: NonNullable<HiddenField["calculate"]>;
	default_value: NonNullable<HiddenField["default_value"]>;
} {
	return (
		field.kind === "hidden" &&
		field.calculate !== undefined &&
		field.calculate !== null &&
		field.default_value !== undefined &&
		field.default_value !== null
	);
}

export const hiddenFieldMetadata: FieldKindMetadata<"hidden"> = {
	kind: "hidden",
	xformKind: "input",
	dataType: "xsd:string",
	icon: tablerEyeOff,
	label: "Hidden",
	isStructural: false,
	isContainer: false,
	saDocs:
		"Value the user never sees. Set by a calculate expression or a default value.",
	convertTargets: [],
};
