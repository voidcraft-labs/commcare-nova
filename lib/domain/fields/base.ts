// lib/domain/fields/base.ts
//
// Shared base types for all field kinds. Each base sets a contract that
// its descendants honor; we split bases so no descendant has to override
// (and silently weaken) a parent's invariant.
//
// - `structuralFieldBase` (`{ uuid, id }`) is the minimum any field
//   carries — identity + CommCare property id. `hidden` extends this
//   directly: CommCare hidden fields have no label (nothing to display).
// - `containerFieldBase` (structural + optional `label` + optional
//   `label_media`) is for structural containers (`group`, `repeat`).
//   A non-empty label renders visible chrome (header + collapse +
//   nesting frame); an empty/absent label renders structure-only with
//   no visual impact — matching CommCare's behavior for `<group>` /
//   `<repeat>` elements without a `<label>`.
// - `fieldBaseSchema` (structural + required `label` + optional
//   `label_media`) is for every visible-input field kind that
//   genuinely always needs a label.
// - `inputFieldBaseSchema` (fieldBase + the optional input-specific
//   slots: `hint`, `hint_media`, `help`, `help_media`, `required`,
//   `validate_msg_media`, `relevant`, `case_property_on`) carries the
//   input-specific wiring used by text/int/select/etc.
//
// Each displayable message slot (label / hint / help / validate-error)
// carries its own optional `*_media` sibling — the image / audio /
// video shown alongside that message's text. The `_media` suffix
// (rather than a single nested `media` bundle) keeps the carrier prefix
// legible to schema-walk callers, which key off `field.label_media`
// directly.
//
// There is deliberately NO required-message slot. CommCare's runtime
// (commcare-core, which also backs web apps via FormPlayer) parses no
// `jr:requiredMsg` bind attribute — `XFormParser.parseBindAttributes`
// reads only `required` / `constraint` / `constraintMsg` / `relevant`
// / `calculate`, so a required field that's left blank always shows
// CommCare's built-in prompt. An authoring slot for a custom
// required-message would have no faithful wire target on the target
// runtime, so it isn't offered.
//
// `containerFieldBase` and `fieldBaseSchema` are sibling extensions of
// `structuralFieldBase`, not a chain — each field kind picks the base
// whose label policy matches its semantics.

import { z } from "zod";
import { type Media, mediaSchema } from "../multimedia";
import { type Uuid, uuidSchema } from "../uuid";
import { type XPathExpression, xpathExpressionSchema } from "../xpath";

// Re-exported so the per-kind schema files (which extend the bases
// here) can attach `validate_msg_media` next to their `validate_msg`
// (and the expression-AST schema next to their `validate` /
// `default_value`) without each reaching across to the owning modules
// directly.
export { mediaSchema, xpathExpressionSchema };

/**
 * Minimum shape every field carries: stable uuid + semantic id. Hidden
 * fields extend this directly (they have no label and no input wiring).
 *
 * `order` is the absolute fractional sort key (`lib/doc/order`) that names
 * the field's position among its siblings — display/wire/preview sequence is
 * `sort-by-(order, uuid)`, not `fieldOrder` array position. Optional because
 * legacy fields predate it; backfilled deterministically at hydration. Never
 * reaches CommCare (the emitters read the sorted sequence and drop it).
 */
export type StructuralFieldBase = {
	uuid: Uuid;
	id: string;
	order?: string;
};

export const structuralFieldBase = z
	.object({
		uuid: uuidSchema,
		id: z.string(),
		order: z.string().optional(),
	})
	.strict();

/**
 * Every visible field has identity, a CommCare property id, a display
 * label, and an optional `label_media` for the image/audio/video
 * shown alongside the label.
 */
export type FieldBase = StructuralFieldBase & {
	label: string;
	label_media?: Media;
};

export const fieldBaseSchema = structuralFieldBase.extend({
	label: z.string(),
	label_media: mediaSchema.optional(),
});

/**
 * Container base for structural folders (`group`, `repeat`). Label
 * (and its companion media) are optional: a non-empty label renders
 * visible chrome (section header, collapse, nesting frame); an
 * empty/absent label renders structure-only with no visual impact —
 * mirroring CommCare's behavior for `<group>` / `<repeat>` elements
 * emitted without a `<label>`.
 *
 * Inheriting from this base instead of overriding `fieldBaseSchema`
 * keeps the "label required" contract on `FieldBase` honest for
 * every visible-input field kind. Container kinds that legitimately
 * allow empty labels go through this base instead.
 */
export const containerFieldBase = structuralFieldBase.extend({
	label: z.string().optional(),
	label_media: mediaSchema.optional(),
});

/**
 * Input-capable fields additionally carry hint / required / relevant
 * / case wiring, plus a text + media pair per secondary message slot.
 *
 * Layout of slots:
 *
 *   - `hint` + `hint_media` — secondary always-visible text under
 *     the label.
 *   - `help` + `help_media` — tap-to-expand longer-form text.
 *   - `required` (XPath / `true()`) — gates whether the field must be
 *     answered. There is no companion message slot: CommCare's runtime
 *     has no `jr:requiredMsg` attribute, so the blank-required prompt
 *     is always CommCare's built-in string (see the file header).
 *
 * The validation-error media slot (`validate_msg_media`) is NOT
 * here: its companion text, `validate_msg`, lives only on the
 * per-kind schemas that support validation (text / int / decimal /
 * etc.), so the media slot sits beside it there. Placing it on this
 * base would dangle on kinds like `geopoint` that extend the input
 * base but carry no `validate_msg`.
 */
export type InputFieldBase = FieldBase & {
	hint?: string;
	hint_media?: Media;
	help?: string;
	help_media?: Media;
	required?: XPathExpression; // an expression, or the "true()" sentinel
	relevant?: XPathExpression;
	case_property_on?: string; // case type name this field writes to
};

export const inputFieldBaseSchema = fieldBaseSchema.extend({
	hint: z.string().optional(),
	hint_media: mediaSchema.optional(),
	help: z.string().optional(),
	help_media: mediaSchema.optional(),
	required: xpathExpressionSchema.optional(),
	relevant: xpathExpressionSchema.optional(),
	case_property_on: z.string().optional(),
});

/**
 * Select option value + label pair plus an optional `media` slot, so
 * each option can show its own image / audio / video alongside its
 * label text — useful for visual-pick UIs ("pick which symptom
 * matches this image" etc.).
 *
 * `uuid` is the option's stable identity for granular per-option mutations
 * (so two members editing different options merge); `order` is its absolute
 * fractional sort key. Both optional because legacy options predate them and
 * are backfilled deterministically at hydration (`uuid` from
 * `(field uuid, option index)`, `order` from array position). Neither
 * reaches CommCare.
 */
export type SelectOption = {
	value: string;
	label: string;
	media?: Media;
	uuid?: Uuid;
	order?: string;
};

export const selectOptionSchema = z
	.object({
		value: z.string(),
		label: z.string(),
		media: mediaSchema.optional(),
		uuid: uuidSchema.optional(),
		order: z.string().optional(),
	})
	.strict();

/**
 * A fresh select's two starter options — the smallest set the select
 * schemas admit (`options` is `.min(2)`), named so the user's only job
 * is renaming them. Shared by every surface that mints a select with no
 * authored options yet: the builder's insert picker and the builder's
 * convert-to-select gesture (the SA passes real options instead, so its
 * paths never consume this).
 */
export const DEFAULT_SELECT_OPTIONS: readonly Pick<
	SelectOption,
	"value" | "label"
>[] = [
	{ value: "option_1", label: "Option 1" },
	{ value: "option_2", label: "Option 2" },
];

/**
 * The inert value a builder-born hidden field starts with — the XPath
 * empty-string literal, satisfying the `HIDDEN_NO_VALUE` rule until the
 * user authors the real calculate in the inspector. Shared by the two
 * surfaces that mint a hidden field with no authored value: the
 * builder's insert picker and the builder's convert-to-hidden gesture
 * (the SA passes a real `calculate` instead). One constant so the two
 * born shapes can't drift.
 */
export const HIDDEN_INERT_DEFAULT_VALUE: XPathExpression = {
	parts: [{ kind: "text", text: "''" }],
};
