// lib/domain/fields/file.ts
//
// Generic-file capture. The worker attaches an existing document —
// there is no camera, recorder, or scanner behind any capture kind on
// Web Apps. Shares the capture-kind shape with image/audio/video/
// signature: label + hint + required + relevant plus the capture
// destination, and no validation or default.
//
// Two platform facts shape what the author is told at the point they
// pick this kind, both stated in the field's `saDocs` and the public
// docs rather than encoded as a restriction:
//
//   - CommCare Web Apps renders it as a real question
//     (`entries.js::DocumentEntry`), accepting
//     `.pdf,.xlsx,.docx,.html,.txt,.rtf,.msg`.
//   - CommCare Android draws it with its own document widget
//     (`DocumentWidget`, a Choose Document button), which the lane's
//     Android reader holds (`proof/android/predicates.py`).

import tablerFileUpload from "@iconify-icons/tabler/file-upload";
import { z } from "zod";
import type { FieldKindMetadata } from "../kinds";
import {
	captureCaseWriteSchema,
	fieldBaseSchema,
	proseTemplateSchema,
	xpathExpressionSchema,
} from "./base";

export const fileFieldSchema = fieldBaseSchema.extend({
	kind: z.literal("file"),
	hint: proseTemplateSchema.optional(),
	required: xpathExpressionSchema.optional(),
	relevant: xpathExpressionSchema.optional(),
	caseWrite: captureCaseWriteSchema.optional(),
});

export type FileField = z.infer<typeof fileFieldSchema>;

export const fileFieldMetadata: FieldKindMetadata<"file"> = {
	kind: "file",
	xformKind: "input",
	dataType: "binary",
	icon: tablerFileUpload,
	label: "File",
	isStructural: false,
	isContainer: false,
	carriesValidation: false,
	saDocs:
		"File attachment: the worker attaches a document from their device. Web Apps takes a PDF, Word, Excel, HTML, RTF, text, or Outlook message file; the Android app opens its own document chooser.",
	convertTargets: ["image", "audio", "video", "signature"],
};
