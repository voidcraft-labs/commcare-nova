// lib/domain/fields/video.ts
//
// Video capture field. Emits `<upload mediatype="video/*">` over a
// `binary` bind. Cannot be calculated, validated, or saved to a case
// property — extends fieldBaseSchema directly rather than
// inputFieldBaseSchema.
//
// This is an attachment, not a recording: CommCare Web Apps has no
// camera or recorder, so the worker picks an existing video file.

import tablerDeviceTv from "@iconify-icons/tabler/device-tv";
import { z } from "zod";
import type { FieldKindMetadata } from "../kinds";
import { fieldBaseSchema, xpathExpressionSchema } from "./base";

export const videoFieldSchema = fieldBaseSchema.extend({
	kind: z.literal("video"),
	hint: z.string().optional(),
	required: xpathExpressionSchema.optional(),
	relevant: xpathExpressionSchema.optional(),
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
		"Video attachment — the worker attaches an existing MP4, MPEG, M4V, or 3GP file. Web Apps has no camera, so never describe this as recording video. Cannot be saved to a case property.",
	convertTargets: ["image", "audio", "signature", "file"],
};
