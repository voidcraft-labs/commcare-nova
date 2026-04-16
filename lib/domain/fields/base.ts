// lib/domain/fields/base.ts
//
// Shared base types for all field kinds. Input kinds extend
// InputFieldBase; structural kinds (group/repeat/label/hidden) extend
// FieldBase directly and opt in to whichever optional fields apply.

import { z } from "zod";
import { type Uuid, uuidSchema } from "../uuid";

/** Every field has identity, a CommCare property id, and a display label. */
export type FieldBase = {
	uuid: Uuid;
	id: string;
	label: string;
};

export const fieldBaseSchema = z.object({
	uuid: uuidSchema,
	id: z.string(),
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
