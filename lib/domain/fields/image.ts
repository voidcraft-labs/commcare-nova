// lib/domain/fields/image.ts
//
// Image capture field. Emits `<upload mediatype="image/*">` over a
// `binary` bind. Its starting value, constraint and help are shared with other questions. A case
// operation saves a link to the captured file through a `capture-link`
// write value, never the file itself.
//
// How the worker adds the photo depends on where the app runs. CommCare
// Web Apps has no camera: `entry_file.html` binds only `accept` on its
// file input, and `getUserMedia` / `MediaRecorder` / `capture=` occur
// nowhere in cloudcare, so the worker attaches a file. Android takes a
// picture (`ImageWidget` fires `MediaStore.ACTION_IMAGE_CAPTURE`). So
// `saDocs` names what to capture, never how; the platform table's
// `image-question` row says how each platform captures it.

import tablerPhoto from "@iconify-icons/tabler/photo";
import { z } from "zod";
import type { FieldKindMetadata } from "../kinds";
import { displaySchemas } from "../questionDisplaySchemas";
import { checkedInputFieldBaseSchema } from "./base";

export const imageDimensionSchema = z.int32().positive();

export const imageFieldSchema = checkedInputFieldBaseSchema.extend({
	kind: z.literal("image"),
	sendTopics: displaySchemas.sendTopics.optional(),
	captureSource: displaySchemas.captureSource
		.extract(["camera", "face-camera"])
		.optional(),
	overlaySize: displaySchemas.overlaySize.optional(),
	webSignature: displaySchemas.webSignature.optional(),
	maxDimension: imageDimensionSchema.optional(),
});

export type ImageField = z.infer<typeof imageFieldSchema>;

export const imageFieldMetadata: FieldKindMetadata<"image"> = {
	kind: "image",
	xformKind: "input",
	dataType: "binary",
	icon: tablerPhoto,
	label: "Image",
	isStructural: false,
	isContainer: false,
	carriesValidation: true,
	saDocs:
		'Photo attachment. Name what to capture, such as "Photo of the meter", rather than how, because how the worker adds it depends on where the app runs.',
	convertTargets: ["audio", "video", "signature", "file"],
};
