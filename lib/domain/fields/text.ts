// lib/domain/fields/text.ts
//
// Free-text single-line string field. Supports XPath validation and a
// `default_value` seed; a computed value belongs on a `hidden` field, not a
// `calculate` on this visible control. Maps to CommCare <input> with xsd:string.
// `keypad: "numbers"` is the Phone Number or Numeric ID question: the worker
// types on a number keypad and the answer stays text, so a leading zero or a
// `+` is kept.

import tablerForms from "@iconify-icons/tabler/forms";
import { z } from "zod";
import type { FieldKindMetadata } from "../kinds";
import {
	formLogicSchema,
	inputFieldBaseSchema,
	proseTemplateSchema,
} from "./base";

/** The keypads a Text question can give the worker, beside the full keyboard. */
export const TEXT_KEYPADS = ["numbers"] as const;

export const textFieldSchema = inputFieldBaseSchema.extend({
	kind: z.literal("text"),
	/** The worker types on a number keypad; the answer stays text. Absent: the full keyboard. */
	keypad: z.enum(TEXT_KEYPADS).optional(),
	validate: formLogicSchema.optional(),
	validate_msg: proseTemplateSchema.optional(),
	default_value: formLogicSchema.optional(),
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
	carriesValidation: true,
	saDocs:
		"Free-text field for single-line string input. Supports XPath validation. With keypad numbers it is a phone number or numeric ID question.",
	// The string-compatible tier: every target stores the same string
	// values text does, so history never needs parsing or per-row
	// migration. `single_select` requires options in the same convert
	// call (the schema's `.min(1)`); `hidden` drops label/hint/required
	// and the commit gate requires a calculate or default_value on the
	// result. Parse-requiring promotions (text→int/date/…) stay closed —
	// existing history has no representation in those types without a
	// coercion policy.
	convertTargets: ["secret", "barcode", "single_select", "hidden"],
};
