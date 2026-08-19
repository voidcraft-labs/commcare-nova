// lib/domain/fields/signature.ts
//
// Signature capture field — the one capture kind the worker produces
// in-app rather than attaching. Emits `<upload mediatype="image/*">`
// with `appearance="signature"` over a `binary` bind; the wire collapses
// it onto the image control, and `entries.js::getEntry` splits the two
// back apart on that appearance. No choices and no calculate; the one
// piece of case wiring is the capture destination, whose mode decides
// how the drawing reaches the case.
//
// It stays its own Nova kind because every worker-visible property
// differs from an image: a drawing canvas rather than a file picker, a
// different accepted-file list, PNG output, and no restore of a stored
// signature when a form resumes.

import tablerSignature from "@iconify-icons/tabler/signature";
import { z } from "zod";
import type { FieldKindMetadata } from "../kinds";
import {
	captureCaseWriteSchema,
	fieldBaseSchema,
	proseTemplateSchema,
	xpathExpressionSchema,
} from "./base";

export const signatureFieldSchema = fieldBaseSchema.extend({
	kind: z.literal("signature"),
	hint: proseTemplateSchema.optional(),
	required: xpathExpressionSchema.optional(),
	relevant: xpathExpressionSchema.optional(),
	caseWrite: captureCaseWriteSchema.optional(),
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
	saDocs:
		"Signature, the worker signs on a drawing pad and the app saves a PNG. The only capture kind that does not attach an existing file.",
	convertTargets: ["image", "audio", "video", "file"],
};
