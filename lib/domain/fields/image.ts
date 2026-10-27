// lib/domain/fields/image.ts
//
// Image capture field. Emits `<upload mediatype="image/*">` over a
// `binary` bind. Cannot be calculated or validated — extends
// fieldBaseSchema directly rather than inputFieldBaseSchema, and takes
// its own `captureCaseWriteSchema` destination, which carries the mode
// deciding how the answer reaches the case.
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
import {
	captureCaseWriteSchema,
	fieldBaseSchema,
	formLogicSchema,
	proseTemplateSchema,
} from "./base";

export const imageFieldSchema = fieldBaseSchema.extend({
	kind: z.literal("image"),
	hint: proseTemplateSchema.optional(),
	required: formLogicSchema.optional(),
	relevant: formLogicSchema.optional(),
	caseWrite: captureCaseWriteSchema.optional(),
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
	carriesValidation: false,
	saDocs:
		'Photo attachment. Name what to capture, such as "Photo of the meter", rather than how, because how the worker adds it depends on where the app runs.',
	convertTargets: ["audio", "video", "signature", "file"],
};
