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
//   - CommCare Android has no handling for it at all —
//     `CONTROL_DOCUMENT_UPLOAD` appears nowhere in that client, so
//     `WidgetFactory::createWidgetFromPrompt` falls through to
//     `StringWidget`. A worker types free text into a `binary` node and
//     that string submits.

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
	saDocs:
		"File attachment, the worker attaches a PDF, Word, Excel, HTML, RTF, text, or Outlook message file from their device. Web Apps only: on Android this renders as a plain text box. Can save to a case property as a link to the attached file; that needs the app published to a CommCare HQ project space, because the address comes from the target.",
	convertTargets: ["image", "audio", "video", "signature"],
};
