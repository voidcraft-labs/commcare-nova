// lib/domain/fields/base.ts
//
// Shared base types for all field kinds. Each base sets a contract that
// its descendants honor; we split bases so no descendant has to override
// (and silently weaken) a parent's invariant.
//
// - `structuralFieldBase` (`{ uuid, id }`) is the minimum any field
//   carries — stable identity + form question/node id. `hidden` extends this
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
//   `validate_msg_media`, `relevant`, `caseWrite`) carries the
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
import {
	type AuthoredCasePropertyName,
	authoredCasePropertyNameSchema,
} from "../casePropertyName";
import { type Media, mediaSchema } from "../multimedia";
import {
	type ProseTemplate,
	proseTemplateSchema,
	proseTemplateText,
	proseText,
} from "../prose";
import { type Uuid, uuidSchema } from "../uuid";
import { type XPathExpression, xpathExpressionSchema } from "../xpath";

// Re-exported so the per-kind schema files (which extend the bases
// here) can attach `validate_msg_media` next to their `validate_msg`
// (and the expression-AST schema next to their `validate` /
// `default_value`) without each reaching across to the owning modules
// directly.
export { mediaSchema, proseTemplateSchema, xpathExpressionSchema };

/**
 * Minimum shape every field carries: stable uuid + semantic id. Hidden
 * fields extend this directly (they have no label and no input wiring).
 * Sibling position belongs only to the owning `fieldOrder` membership array;
 * fields carry no parallel ordering property.
 */
export type StructuralFieldBase = {
	uuid: Uuid;
	id: string;
};

export const structuralFieldBase = z
	.object({
		uuid: uuidSchema,
		id: z.string(),
	})
	.strict();

/**
 * Every visible field has identity, a form question/node id, a display
 * label, and an optional `label_media` for the image/audio/video
 * shown alongside the label.
 */
export type FieldBase = StructuralFieldBase & {
	label: ProseTemplate;
	label_media?: Media;
};

export const fieldBaseSchema = structuralFieldBase.extend({
	label: proseTemplateSchema,
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
	label: proseTemplateSchema.optional(),
	label_media: mediaSchema.optional(),
});

/**
 * One field's explicit case-storage destination.
 *
 * Field identity and storage identity are independent: `Field.id` is the
 * friendly form question/node name, while this pair is the case type and
 * property written on submit. The complete pair is optional; there is no
 * half-bound state and no inferred property fallback to `Field.id`.
 */
export interface CaseWrite {
	caseType: string;
	property: AuthoredCasePropertyName;
}

export const caseWriteSchema = z
	.object({
		caseType: z.string().min(1, "Case type must not be empty."),
		property: authoredCasePropertyNameSchema,
	})
	.strict();

/**
 * How a capture field's answer reaches the case.
 *
 * The mode is a required member of the destination rather than a slot
 * beside it, so a destination with no mode is unrepresentable — the two
 * are one decision. `url` writes a text property holding the CommCare HQ
 * address of the submitted file, built from the submission's own
 * `meta/instanceID` plus the attachment name, so it needs a known
 * deployment target to resolve an origin and a domain.
 *
 * The mode also decides which node the case block reads, which is why it
 * cannot be inferred later. CommCare HQ chooses `<attachment>` over
 * `<update>` purely structurally — if the emitted question path has an
 * `<upload ref>` in the body it becomes an attachment block, with no
 * toggle consulted (`app_manager/xform.py::CaseBlock.add_case_updates`,
 * `::is_attachment`). So URL mode never points at the capture question
 * itself; it points at the node carrying the address.
 *
 * `attachment` makes the opposite choice deliberately: the question path
 * IS the capture question, so the case block carries an `<attachment>`
 * element and CommCare stores the file on the case rather than a link to
 * it. It is the deprecated path and an explicit opt-in, because it only
 * does anything on a project space carrying the `MM_CASE_PROPERTIES`
 * toggle — with the toggle off,
 * `form_processor/backends/sql/update_strategy.py::SqlCaseUpdateStrategy._apply_attachments_action`
 * returns before applying anything and the block is discarded without a
 * word. Nothing reads one back inside the app either: Web Apps never
 * displays a case attachment, so the mode's only surfaces are the HQ
 * case page and CommCare Android.
 */
export const CAPTURE_CASE_WRITE_MODES = ["url", "attachment"] as const;

export type CaptureCaseWriteMode = (typeof CAPTURE_CASE_WRITE_MODES)[number];

export interface CaptureCaseWrite extends CaseWrite {
	mode: CaptureCaseWriteMode;
}

export const captureCaseWriteSchema = caseWriteSchema
	.extend({
		mode: z.enum(CAPTURE_CASE_WRITE_MODES),
	})
	.strict();

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
	hint?: ProseTemplate;
	hint_media?: Media;
	help?: ProseTemplate;
	help_media?: Media;
	required?: XPathExpression; // an expression, or the "true()" sentinel
	relevant?: XPathExpression;
	caseWrite?: CaseWrite;
};

export const inputFieldBaseSchema = fieldBaseSchema.extend({
	hint: proseTemplateSchema.optional(),
	hint_media: mediaSchema.optional(),
	help: proseTemplateSchema.optional(),
	help_media: mediaSchema.optional(),
	required: xpathExpressionSchema.optional(),
	relevant: xpathExpressionSchema.optional(),
	caseWrite: caseWriteSchema.optional(),
});

/**
 * Select option value + label pair plus an optional `media` slot, so
 * each option can show its own image / audio / video alongside its
 * label text — useful for visual-pick UIs ("pick which symptom
 * matches this image" etc.).
 *
 * `uuid` is the option's required stable identity for granular per-option
 * mutations (so two members editing different options merge). The options
 * array owns sequence; an option carries no parallel ordering property.
 */
export type SelectOption = {
	value: string;
	label: ProseTemplate;
	media?: Media;
	uuid: Uuid;
};

export const selectOptionSchema = z
	.object({
		value: z.string(),
		label: proseTemplateSchema,
		media: mediaSchema.optional(),
		uuid: uuidSchema,
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
>[] = [mintSelectOptionPlaceholder(1), mintSelectOptionPlaceholder(2)];

/**
 * The placeholder choice Nova mints at position `n` when nobody has named
 * one yet: value `option_n` under the label "Option n". The one minter
 * behind `DEFAULT_SELECT_OPTIONS`, the options editor's "Add option", and
 * the fallback value a refusal suggests when neither the value nor the
 * label has a word to keep, so the recognizer below cannot drift from what
 * was minted.
 */
export function mintSelectOptionPlaceholder(
	n: number,
): Pick<SelectOption, "value" | "label"> {
	return { value: `option_${n}`, label: proseText(`Option ${n}`) };
}

/**
 * Whether an option still reads exactly as `mintSelectOptionPlaceholder`
 * left it, at ANY position: value `option_N` under the label "Option N"
 * for one and the same N. Nobody chose either side of such a row, so the
 * first real label it is given may also name the value; once either side
 * has been edited the two are independent.
 */
export function isMintedSelectOptionPlaceholder(
	option: Pick<SelectOption, "value" | "label">,
): boolean {
	const match = /^option_([1-9]\d*)$/.exec(option.value);
	if (match === null) return false;
	const minted = mintSelectOptionPlaceholder(Number(match[1]));
	return (
		proseTemplateText(option.label).trim() === proseTemplateText(minted.label)
	);
}

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
