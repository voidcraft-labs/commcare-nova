// lib/domain/fields/text.ts
//
// Free-text single-line string field. Supports XPath validation and a
// `default_value` seed; a computed value belongs on a `hidden` field, not a
// `calculate` on this visible control. Maps to CommCare <input> with xsd:string.

import tablerForms from "@iconify-icons/tabler/forms";
import { z } from "zod";
import type { FieldKindMetadata } from "../kinds";
import { inputFieldBaseSchema, mediaSchema } from "./base";

export const textFieldSchema = inputFieldBaseSchema.extend({
	kind: z.literal("text"),
	validate: z.string().optional(),
	validate_msg: z.string().optional(),
	validate_msg_media: mediaSchema.optional(),
	default_value: z.string().optional(),
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
	convertTargets: ["secret"],
};
