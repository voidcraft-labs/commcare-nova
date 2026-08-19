// lib/domain/fields/video.ts
//
// Video capture field. Emits `<upload mediatype="video/*">` over a
// `binary` bind. Cannot be calculated or validated — extends
// fieldBaseSchema directly rather than inputFieldBaseSchema, and takes
// its own `captureCaseWriteSchema` destination, which carries the mode
// deciding how the answer reaches the case.
//
// This is an attachment, not a recording: CommCare Web Apps has no
// camera or recorder, so the worker picks an existing video file.

import tablerDeviceTv from "@iconify-icons/tabler/device-tv";
import { z } from "zod";
import type { FieldKindMetadata } from "../kinds";
import {
	captureCaseWriteSchema,
	fieldBaseSchema,
	proseTemplateSchema,
	xpathExpressionSchema,
} from "./base";

export const videoFieldSchema = fieldBaseSchema.extend({
	kind: z.literal("video"),
	hint: proseTemplateSchema.optional(),
	required: xpathExpressionSchema.optional(),
	relevant: xpathExpressionSchema.optional(),
	caseWrite: captureCaseWriteSchema.optional(),
});

export type VideoField = z.infer<typeof videoFieldSchema>;

export const videoFieldMetadata: FieldKindMetadata<"video"> = {
	kind: "video",
	xformKind: "input",
	dataType: "binary",
	icon: tablerDeviceTv,
	label: "Video",
	isStructural: false,
	isContainer: false,
	saDocs:
		"Video attachment, the worker attaches an existing MP4, MPG, MPEG, MPG4, MPEG4, M4V, 3GP, 3GPP, 3GP2, or 3G2 file. Web Apps has no camera, so never describe this as recording video. Can save to a case property as a link to the attached file; that needs the app published to a CommCare HQ project space, because the address comes from the target.",
	convertTargets: ["image", "audio", "signature", "file"],
};
