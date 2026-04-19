// lib/domain/fields/text.ts
//
// Free-text single-line string field. Supports XPath validation +
// calculation. Maps to CommCare <input> control with xsd:string type.

import tablerForms from "@iconify-icons/tabler/forms";
import { z } from "zod";
import type { FieldKindMetadata } from "../kinds";
import { inputFieldBaseSchema } from "./base";

export const textFieldSchema = inputFieldBaseSchema.extend({
	kind: z.literal("text"),
	validate: z.string().optional(),
	validate_msg: z.string().optional(),
	calculate: z.string().optional(),
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
		"Free-text field for single-line string input. Supports XPath validation and calculate.",
	convertTargets: ["secret"],
};
