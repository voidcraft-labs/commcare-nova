// lib/domain/fields/barcode.ts
//
// Barcode/QR scan field. Maps to CommCare <input> control with xsd:string type.
// Supports XPath validation and calculation. No default_value — the value is
// always populated by the device scanner, not a user-supplied default.

import tablerBarcode from "@iconify-icons/tabler/barcode";
import { z } from "zod";
import { StubField } from "@/components/builder/editor/StubField";
import type { FieldEditorSchema, FieldKindMetadata } from "../kinds";
import { inputFieldBaseSchema } from "./base";

export const barcodeFieldSchema = inputFieldBaseSchema.extend({
	kind: z.literal("barcode"),
	validate: z.string().optional(),
	validate_msg: z.string().optional(),
	calculate: z.string().optional(),
});

export type BarcodeField = z.infer<typeof barcodeFieldSchema>;

export const barcodeFieldMetadata: FieldKindMetadata<"barcode"> = {
	kind: "barcode",
	xformKind: "input",
	dataType: "xsd:string",
	icon: tablerBarcode,
	label: "Barcode",
	isStructural: false,
	isContainer: false,
	saDocs: "Barcode/QR scan.",
	convertTargets: [],
};

// Declares which property keys this kind exposes in the inspect panel and
// binds each to the editor component that renders it.
export const barcodeFieldEditorSchema: FieldEditorSchema<BarcodeField> = {
	data: [{ key: "case_property", component: StubField }],
	logic: [
		{ key: "required", component: StubField },
		{ key: "relevant", component: StubField },
		{ key: "validate", component: StubField },
		{ key: "validate_msg", component: StubField },
		{ key: "calculate", component: StubField },
	],
	ui: [{ key: "hint", component: StubField }],
};
