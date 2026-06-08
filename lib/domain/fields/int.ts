// lib/domain/fields/int.ts
//
// Whole-number integer field. Supports XPath validation and a `default_value`
// seed (a computed value belongs on a `hidden` field, not a `calculate` on
// this visible control). Maps to CommCare <input> with xsd:int type. Suitable
// for fields like age, count, quantity, score.

import tabler123 from "@iconify-icons/tabler/123";
import { z } from "zod";
import type { FieldKindMetadata } from "../kinds";
import { inputFieldBaseSchema, mediaSchema } from "./base";

export const intFieldSchema = inputFieldBaseSchema.extend({
	kind: z.literal("int"),
	validate: z.string().optional(),
	validate_msg: z.string().optional(),
	validate_msg_media: mediaSchema.optional(),
	default_value: z.string().optional(),
});

export type IntField = z.infer<typeof intFieldSchema>;

export const intFieldMetadata: FieldKindMetadata<"int"> = {
	kind: "int",
	xformKind: "input",
	dataType: "xsd:int",
	icon: tabler123,
	label: "Number",
	isStructural: false,
	isContainer: false,
	saDocs: "Whole-number input (age, count, quantity).",
	convertTargets: ["decimal"],
};
