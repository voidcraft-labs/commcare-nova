// lib/domain/fields/base.ts
//
// Shared base types for all field kinds. Each base sets a contract that
// its descendants honor; we split bases so no descendant has to override
// (and silently weaken) a parent's invariant.
//
// - `structuralFieldBase` (`{ uuid, id }`) is the minimum any field
//   carries — identity + CommCare property id. `hidden` extends this
//   directly: CommCare hidden fields have no label (nothing to display).
// - `containerFieldBase` (structural + optional `label`) is for
//   structural containers (`group`, `repeat`). A non-empty label
//   renders visible chrome (header + collapse + nesting frame); an
//   empty/absent label renders structure-only with no visual impact —
//   matching CommCare's behavior for `<group>` / `<repeat>` elements
//   without a `<label>`.
// - `fieldBaseSchema` (structural + required `label`) is for every
//   visible-input field kind that genuinely always needs a label.
//   Distinct from `containerFieldBase` so `fieldBaseSchema`'s "label
//   required" invariant stays honest.
// - `inputFieldBaseSchema` (fieldBase + `hint?`, `required?`,
//   `relevant?`, `case_property_on?`) carries the input-specific wiring
//   used by text/int/select/etc.
//
// `containerFieldBase` and `fieldBaseSchema` are sibling extensions of
// `structuralFieldBase`, not a chain — each field kind picks the base
// whose label policy matches its semantics.

import { z } from "zod";
import { type Uuid, uuidSchema } from "../uuid";

/**
 * Minimum shape every field carries: stable uuid + semantic id. Hidden
 * fields extend this directly (they have no label and no input wiring).
 */
export type StructuralFieldBase = {
	uuid: Uuid;
	id: string;
};

export const structuralFieldBase = z.object({
	uuid: uuidSchema,
	id: z.string(),
});

/** Every visible field has identity, a CommCare property id, and a display label. */
export type FieldBase = StructuralFieldBase & {
	label: string;
};

export const fieldBaseSchema = structuralFieldBase.extend({
	label: z.string(),
});

/**
 * Container base for structural folders (`group`, `repeat`). Label is
 * optional: a non-empty label renders visible chrome (section header,
 * collapse, nesting frame), an empty/absent label renders
 * structure-only with no visual impact — mirroring CommCare's behavior
 * for `<group>` / `<repeat>` elements emitted without a `<label>`.
 *
 * Inheriting from this base instead of overriding `fieldBaseSchema` keeps
 * the "label required" contract on `FieldBase` honest for every
 * visible-input field kind. Container kinds that legitimately allow
 * empty labels go through this base instead.
 */
export const containerFieldBase = structuralFieldBase.extend({
	label: z.string().optional(),
});

/** Input-capable fields additionally carry hint / required / relevant / case wiring. */
export type InputFieldBase = FieldBase & {
	hint?: string;
	required?: string; // XPath expression or "true()"
	relevant?: string; // XPath expression
	case_property_on?: string; // case type name this field writes to
};

export const inputFieldBaseSchema = fieldBaseSchema.extend({
	hint: z.string().optional(),
	required: z.string().optional(),
	relevant: z.string().optional(),
	case_property_on: z.string().optional(),
});

/** Select option value + label pair, shared by singleSelect/multiSelect. */
export type SelectOption = { value: string; label: string };

export const selectOptionSchema = z.object({
	value: z.string(),
	label: z.string(),
});
