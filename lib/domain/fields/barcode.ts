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
import { displaySchemas } from "../questionDisplaySchemas";
import { androidAppQuestionSchema } from "./androidApp";
import {
	formLogicSchema,
	inputFieldBaseSchema,
	proseTemplateSchema,
} from "./base";

export const barcodeFieldSchema = inputFieldBaseSchema.extend({
	kind: z.literal("barcode"),
	keypad: z.literal("numbers").optional(),
	inputWidth: displaySchemas.inputWidth.optional(),
	addressLookup: displaySchemas.addressLookup.optional(),
	sendTopics: displaySchemas.sendTopics.optional(),
	receiveFrom: displaySchemas.receiveFrom.optional(),
	scanOnOpen: displaySchemas.scanOnOpen.optional(),
	canEditScan: displaySchemas.canEditScan.optional(),
	androidApp: androidAppQuestionSchema.optional(),
	validate: formLogicSchema.optional(),
	validate_msg: proseTemplateSchema.optional(),
	extended_validate_msg: proseTemplateSchema.optional(),
	default_value: formLogicSchema.optional(),
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
	carriesValidation: true,
	saDocs: "Barcode or QR code.",
	// Barcodes scan as plain strings (same wire type as text), so the
	// demotion to a typed text question is data-free in both directions.
	convertTargets: ["text"],
};
