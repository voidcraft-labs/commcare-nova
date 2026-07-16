// lib/domain/fields/barcode.ts
//
// Barcode/QR scan field. Maps to CommCare <input> control with xsd:string type.
// Supports XPath validation. Carries `default_value` (a `<setvalue>` seed the
// scanner can overwrite — `commcare-android BarcodeWidget` displays the
// prepopulated value), but not `calculate`: a `calculate` bind makes the
// control read-only, which is a hidden field's job, not a scan input's.

import tablerBarcode from "@iconify-icons/tabler/barcode";
import { z } from "zod";
import type { FieldKindMetadata } from "../kinds";
import {
	inputFieldBaseSchema,
	mediaSchema,
	xpathExpressionSchema,
} from "./base";

export const barcodeFieldSchema = inputFieldBaseSchema.extend({
	kind: z.literal("barcode"),
	validate: xpathExpressionSchema.optional(),
	validate_msg: z.string().optional(),
	validate_msg_media: mediaSchema.optional(),
	default_value: xpathExpressionSchema.optional(),
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
	// Barcodes scan as plain strings (same wire type as text), so the
	// demotion to a typed text question is data-free in both directions.
	convertTargets: ["text"],
};
