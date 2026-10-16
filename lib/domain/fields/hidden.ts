// lib/domain/fields/hidden.ts
//
// Hidden value field. Never shown to the user — it exists purely to carry a
// value through the form instance, set by at most one of `calculate` (a
// computed value, re-evaluated whenever a referenced value changes and on
// every form load) or `default_value` (a one-shot `<setvalue>` seed that runs
// when the form instance is first opened and never again). Both slots are
// optional: a hidden field with neither is valid and stays blank.
// `HIDDEN_VALUE_BOTH_SOURCES` refuses both, because Nova doesn't yet write a
// Hidden Value's default beside its calculate
// (`HIDDEN_VALUE_ONE_SOURCE_SENTENCE`). Every authoring surface also refuses
// to write the pair, so the rule is a backstop: the SA and MCP tool schemas
// reject it in one call, `editField` clears the held slot when the other is
// set, and the builder's Value control names both slots on every write.
// `hiddenFieldCarriesBothValueSources` is the one recognizer of the
// pair, shared by the rule and the tool boundary. Maps to CommCare <input>
// with xsd:string.
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
	// `default_value` (a one-shot seed), or from neither (it stays blank).
	// The pair is refused by the validator rather than the schema so
	// historical documents hydrate.
	calculate: xpathExpressionSchema.optional(),
	default_value: xpathExpressionSchema.optional(),
	relevant: xpathExpressionSchema.optional(),
	caseWrite: caseWriteSchema.optional(),
});

export type HiddenField = z.infer<typeof hiddenFieldSchema>;

/**
 * Why a hidden field takes one value source, in the words every surface
 * uses: the validator's refusal, the tool boundary's, and the docs. A later
 * load-time setvalue can read the default before the calculate replaces it,
 * so the pair is not dead on a device; Nova simply does not write both yet.
 */
export const HIDDEN_VALUE_ONE_SOURCE_SENTENCE =
	"A hidden value takes a calculation or a starting value. Nova doesn't yet write both on one field.";

/**
 * The refused pair: a hidden field carrying both a calculation and a
 * starting value. Presence is object presence (null counts as absent).
 * Shared by the validator rule and the tool-boundary refinement so they
 * cannot drift.
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
	// The emission/runtime boundary derives datetime from an effective case
	// destination; untyped hidden values keep this default.
	dataType: "xsd:string",
	icon: tablerEyeOff,
	label: "Hidden",
	isStructural: false,
	isContainer: false,
	carriesValidation: false,
	saDocs:
		"Value the user never sees. Give it a calculate expression or a default value; with neither it stays blank.",
	convertTargets: [],
};
