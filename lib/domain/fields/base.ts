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
//   `required_msg`, `required_msg_media`, `validate_msg_media`,
//   `relevant`, `case_property_on`) carries the input-specific wiring
//   used by text/int/select/etc.
//
// Each message slot (label / hint / help / required-error /
// validate-error) carries its own optional `*_media` sibling — the
// image / audio / video shown alongside that message's text. The
// `_media` suffix (rather than a single nested `media` bundle) keeps
// the carrier prefix legible to schema-walk callers, which key off
// `field.label_media` directly.
//
// `containerFieldBase` and `fieldBaseSchema` are sibling extensions of
// `structuralFieldBase`, not a chain — each field kind picks the base
// whose label policy matches its semantics.

import { z } from "zod";
import { type Media, mediaSchema } from "../multimedia";
import { type Uuid, uuidSchema } from "../uuid";

// Re-exported so the per-kind schema files (which extend the bases
// here) can attach `validate_msg_media` next to their `validate_msg`
// without each reaching across to the multimedia module directly.
export { mediaSchema };

/**
 * Minimum shape every field carries: stable uuid + semantic id. Hidden
 * fields extend this directly (they have no label and no input wiring).
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
 *   - `required` (XPath, existing) + `required_msg` (text) +
 *     `required_msg_media` — the message shown when a required
 *     field is left blank.
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
	required?: string; // XPath expression or "true()"
	required_msg?: string;
	required_msg_media?: Media;
	relevant?: string; // XPath expression
	case_property_on?: string; // case type name this field writes to
};

export const inputFieldBaseSchema = fieldBaseSchema.extend({
	hint: z.string().optional(),
	hint_media: mediaSchema.optional(),
	help: z.string().optional(),
	help_media: mediaSchema.optional(),
	required: z.string().optional(),
	required_msg: z.string().optional(),
	required_msg_media: mediaSchema.optional(),
	relevant: z.string().optional(),
	case_property_on: z.string().optional(),
});

/**
 * Select option value + label pair plus an optional `media` slot, so
 * each option can show its own image / audio / video alongside its
 * label text — useful for visual-pick UIs ("pick which symptom
 * matches this image" etc.).
 */
export type SelectOption = {
	value: string;
	label: string;
	media?: Media;
};

export const selectOptionSchema = z
	.object({
		value: z.string(),
		label: z.string(),
		media: mediaSchema.optional(),
	})
	.strict();
