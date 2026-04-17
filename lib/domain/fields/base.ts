// lib/domain/fields/base.ts
//
// Shared base types for all field kinds. Three layers of shared identity:
//
//   StructuralFieldBase  { uuid, id }
//   FieldBase            StructuralFieldBase + { label }
//   InputFieldBase       FieldBase + { hint?, required?, relevant?, case_property? }
//
// - StructuralFieldBase is the minimum any field carries (identity +
//   CommCare property id). `hidden` extends this — CommCare hidden fields
//   have no label (nothing to display).
// - FieldBase adds `label`, shared by every visible field kind.
// - InputFieldBase adds the input-specific wiring used by text/int/select/etc.

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

/** Input-capable fields additionally carry hint / required / relevant / case wiring. */
export type InputFieldBase = FieldBase & {
	hint?: string;
	required?: string; // XPath expression or "true()"
	relevant?: string; // XPath expression
	case_property?: string; // case type name this field writes to
};

export const inputFieldBaseSchema = fieldBaseSchema.extend({
	hint: z.string().optional(),
	required: z.string().optional(),
	relevant: z.string().optional(),
	case_property: z.string().optional(),
});

/** Select option value + label pair, shared by singleSelect/multiSelect. */
export type SelectOption = { value: string; label: string };

export const selectOptionSchema = z.object({
	value: z.string(),
	label: z.string(),
});
