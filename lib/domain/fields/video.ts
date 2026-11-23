// lib/domain/fields/video.ts
//
// Video capture field. Emits `<upload mediatype="video/*">` over a
// `binary` bind. Its starting value, constraint and help are shared with other questions. A case
// operation saves a link to the captured file through a `capture-link`
// write value, never the file itself.
//
// How the worker adds the video depends on where the app runs: CommCare
// Web Apps has no camera or recorder, so the worker picks an existing
// video file, while Android records one. So `saDocs` names what to
// capture, never how; the platform table's `video-question` row says how
// each platform captures it.

import tablerDeviceTv from "@iconify-icons/tabler/device-tv";
import { z } from "zod";
import type { FieldKindMetadata } from "../kinds";
import { checkedInputFieldBaseSchema } from "./base";

export const videoFieldSchema = checkedInputFieldBaseSchema.extend({
	kind: z.literal("video"),
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
	carriesValidation: true,
	saDocs:
		'Video attachment. Name what to capture, such as "Video of the demonstration", rather than how.',
	convertTargets: ["image", "audio", "signature", "file"],
};
