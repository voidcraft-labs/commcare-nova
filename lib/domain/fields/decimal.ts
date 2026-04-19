// lib/domain/fields/decimal.ts
//
// Decimal-number field for fractional measurements. Supports XPath
// validation + calculation. Maps to CommCare <input> control with
// xsd:decimal type. Suitable for weight, height, price, GPS coordinates.

import tablerDecimal from "@iconify-icons/tabler/decimal";
import { z } from "zod";
import { StubField } from "@/components/builder/editor/StubField";
import type { FieldEditorSchema, FieldKindMetadata } from "../kinds";
import { inputFieldBaseSchema } from "./base";

export const decimalFieldSchema = inputFieldBaseSchema.extend({
	kind: z.literal("decimal"),
	validate: z.string().optional(),
	validate_msg: z.string().optional(),
	calculate: z.string().optional(),
	default_value: z.string().optional(),
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
	saDocs: "Decimal-number input for measurements (weight, height, price).",
	convertTargets: ["int"],
};

// Declares which property keys this kind exposes in the inspect panel and
// binds each to the editor component that renders it.
export const decimalFieldEditorSchema: FieldEditorSchema<DecimalField> = {
	data: [{ key: "case_property", component: StubField }],
	logic: [
		{ key: "required", component: StubField },
		{ key: "relevant", component: StubField },
		{ key: "validate", component: StubField },
		{ key: "validate_msg", component: StubField },
		{ key: "calculate", component: StubField },
		{ key: "default_value", component: StubField },
	],
	ui: [{ key: "hint", component: StubField }],
};
