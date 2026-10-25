// lib/domain/fields/video.ts
//
// Video capture field. Emits `<upload mediatype="video/*">` over a
// `binary` bind. Cannot be calculated or validated — extends
// fieldBaseSchema directly rather than inputFieldBaseSchema, and takes
// its own `captureCaseWriteSchema` destination, which carries the mode
// deciding how the answer reaches the case.
//
// How the worker adds the video depends on where the app runs: CommCare
// Web Apps has no camera or recorder, so the worker picks an existing
// video file, while Android records one. So `saDocs` names what to
// capture, never how; the platform table's `video-question` row says how
// each platform captures it.

import tablerDeviceTv from "@iconify-icons/tabler/device-tv";
import { z } from "zod";
import type { FieldKindMetadata } from "../kinds";
import {
	captureCaseWriteSchema,
	fieldBaseSchema,
	formLogicSchema,
	proseTemplateSchema,
} from "./base";

export const videoFieldSchema = fieldBaseSchema.extend({
	kind: z.literal("video"),
	hint: proseTemplateSchema.optional(),
	required: formLogicSchema.optional(),
	relevant: formLogicSchema.optional(),
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
	carriesValidation: false,
	saDocs:
		'Video attachment. Name what to capture, such as "Video of the demonstration", rather than how.',
	convertTargets: ["image", "audio", "signature", "file"],
};
