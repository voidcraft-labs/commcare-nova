// lib/domain/fields/hidden.ts
//
// A hidden question carries a starting answer on first open (on insert
// inside a repeat) and a calculation that runs as its dependencies change
// and when the form resumes. Each slot is optional. A later starting
// answer may read this one before its calculation has run. The optional
// answerType says how starting answers and calculated values are held.
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
import { formLogicSchema, structuralFieldBase } from "./base";

/** The kind of answer held by a hidden value at an assignment. */
export const HIDDEN_ANSWER_TYPES = [
	"text",
	"untyped",
	"int",
	"long",
	"decimal",
	"date",
	"time",
	"datetime",
	"boolean",
	"single_select",
	"multi_select",
	"geopoint",
	"barcode",
	"file",
] as const;
export type HiddenAnswerType = (typeof HIDDEN_ANSWER_TYPES)[number];

export const HIDDEN_ANSWER_TYPE_LABELS = {
	text: "Text",
	untyped: "Keep as entered",
	int: "Whole number",
	long: "Large whole number",
	decimal: "Decimal number",
	date: "Date",
	time: "Time",
	datetime: "Date and time",
	boolean: "Yes or no",
	single_select: "One choice",
	multi_select: "Several choices",
	geopoint: "Coordinates",
	barcode: "Barcode",
	file: "File reference",
} as const satisfies Record<HiddenAnswerType, string>;

export const hiddenFieldSchema = structuralFieldBase.extend({
	kind: z.literal("hidden"),
	answerType: z.enum(HIDDEN_ANSWER_TYPES).optional(),
	calculate: formLogicSchema.optional(),
	default_value: formLogicSchema.optional(),
	relevant: formLogicSchema.optional(),
});

export type HiddenField = z.infer<typeof hiddenFieldSchema>;

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
		"Value the user never sees. Its starting value runs on first open or when a repeat row is added. Its separate calculation updates when its inputs change and on resume.",
	convertTargets: [],
};
