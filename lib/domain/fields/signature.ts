// lib/domain/fields/signature.ts
//
// Signature capture field. Behaves like an image field — it captures a
// binary value (a drawn signature) rather than collecting text. Maps to a
// CommCare <input> control with a binary data type. No choices, no calculate,
// no case wiring — it is a pure capture control.

import tablerSignature from "@iconify-icons/tabler/signature";
import { z } from "zod";
import { StubField } from "@/components/builder/editor/StubField";
import type { FieldEditorSchema, FieldKindMetadata } from "../kinds";
import { fieldBaseSchema } from "./base";

export const signatureFieldSchema = fieldBaseSchema.extend({
	kind: z.literal("signature"),
	hint: z.string().optional(),
	required: z.string().optional(),
	relevant: z.string().optional(),
});

export type SignatureField = z.infer<typeof signatureFieldSchema>;

export const signatureFieldMetadata: FieldKindMetadata<"signature"> = {
	kind: "signature",
	xformKind: "input",
	dataType: "binary",
	icon: tablerSignature,
	label: "Signature",
	isStructural: false,
	isContainer: false,
	saDocs: "Signature capture.",
	convertTargets: ["image", "audio", "video"],
};

// Editor schema — Phase 1 stubs. Phase 5 replaces StubField with real
// components. Signature has no data wiring (no case_property) and no
// validate/calculate fields — only display (hint) and logic guards.
export const signatureFieldEditorSchema: FieldEditorSchema<SignatureField> = {
	data: [],
	logic: [
		{ key: "required", component: StubField },
		{ key: "relevant", component: StubField },
	],
	ui: [{ key: "hint", component: StubField }],
};
