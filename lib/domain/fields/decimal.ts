// lib/domain/fields/decimal.ts
//
// Decimal-number field for fractional measurements. Supports XPath validation
// and a `default_value` seed (a computed value belongs on a `hidden` field,
// not a `calculate` on this visible control). Maps to CommCare <input> with
// xsd:decimal type. Suitable for weight, height, price, GPS coordinates.

import tablerDecimal from "@iconify-icons/tabler/decimal";
import { z } from "zod";
import type { FieldKindMetadata } from "../kinds";
import {
	formLogicSchema,
	inputFieldBaseSchema,
	proseTemplateSchema,
} from "./base";

export const decimalFieldSchema = inputFieldBaseSchema.extend({
	kind: z.literal("decimal"),
	validate: formLogicSchema.optional(),
	validate_msg: proseTemplateSchema.optional(),
	default_value: formLogicSchema.optional(),
});

export type DecimalField = z.infer<typeof decimalFieldSchema>;

export const decimalFieldMetadata: FieldKindMetadata<"decimal"> = {
	kind: "decimal",
	xformKind: "input",
	dataType: "xsd:decimal",
	icon: tablerDecimal,
	label: "Decimal",
	isStructural: false,
	isContainer: false,
	carriesValidation: true,
	saDocs: "Decimal-number input for measurements (weight, height, price).",
	convertTargets: ["int"],
};
