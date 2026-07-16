// lib/domain/fields/text.ts
//
// Free-text single-line string field. Supports XPath validation and a
// `default_value` seed; a computed value belongs on a `hidden` field, not a
// `calculate` on this visible control. Maps to CommCare <input> with xsd:string.

import tablerForms from "@iconify-icons/tabler/forms";
import { z } from "zod";
import type { FieldKindMetadata } from "../kinds";
import {
	inputFieldBaseSchema,
	mediaSchema,
	xpathExpressionSchema,
} from "./base";

export const textFieldSchema = inputFieldBaseSchema.extend({
	kind: z.literal("text"),
	validate: xpathExpressionSchema.optional(),
	validate_msg: z.string().optional(),
	validate_msg_media: mediaSchema.optional(),
	default_value: xpathExpressionSchema.optional(),
});

export type TextField = z.infer<typeof textFieldSchema>;

export const textFieldMetadata: FieldKindMetadata<"text"> = {
	kind: "text",
	xformKind: "input",
	dataType: "xsd:string",
	icon: tablerForms,
	label: "Text",
	isStructural: false,
	isContainer: false,
	saDocs:
		"Free-text field for single-line string input. Supports XPath validation.",
	// The string-compatible tier: every target stores the same string
	// values text does, so history never needs parsing or per-row
	// migration. `single_select` requires options in the same convert
	// call (the schema's `.min(2)`); `hidden` drops label/hint/required
	// and the commit gate requires a calculate or default_value on the
	// result. Parse-requiring promotions (text→int/date/…) stay closed —
	// existing history has no representation in those types without a
	// coercion policy.
	convertTargets: ["secret", "barcode", "single_select", "hidden"],
};
