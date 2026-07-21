// lib/domain/fields/multiSelect.ts
//
// Multi-choice select field. Maps to CommCare <select> control — the user can
// pick one or more options from a fixed list. Options must have at least two
// entries (a single-option multi-select is semantically meaningless).
//
// Stored value is a space-separated string of selected option values, which is
// the CommCare/XForms convention for multi-select bindings.
//
// Carries `default_value` (a pre-selected set via `<setvalue>`) but never
// `calculate` — same rationale as singleSelect: a computed value is a hidden
// field's job, not a read-only-looking select.

import tablerSquareCheck from "@iconify-icons/tabler/square-check";
import { z } from "zod";
import type { FieldKindMetadata } from "../kinds";
import {
	inputFieldBaseSchema,
	mediaSchema,
	selectOptionSchema,
	xpathExpressionSchema,
} from "./base";

export const multiSelectFieldSchema = inputFieldBaseSchema.extend({
	kind: z.literal("multi_select"),
	options: z.array(selectOptionSchema).min(2),
	validate: xpathExpressionSchema.optional(),
	validate_msg: z.string().optional(),
	validate_msg_media: mediaSchema.optional(),
	default_value: xpathExpressionSchema.optional(),
});

export type MultiSelectField = z.infer<typeof multiSelectFieldSchema>;

export const multiSelectFieldMetadata: FieldKindMetadata<"multi_select"> = {
	kind: "multi_select",
	xformKind: "select",
	dataType: "xsd:string",
	icon: tablerSquareCheck,
	label: "Multi Select",
	isStructural: false,
	isContainer: false,
	saDocs: "Multi-choice from a fixed option list.",
	// Both targets store a plain string where this kind stores a JSONB
	// array of selected values — the case store's string↔array reshape
	// space-joins every stored selection (the XForms wire convention),
	// so both demotions are total over existing rows.
	convertTargets: ["single_select", "text"],
};
