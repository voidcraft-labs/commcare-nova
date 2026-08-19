// lib/domain/fields/image.ts
//
// Image capture field. Emits `<upload mediatype="image/*">` over a
// `binary` bind. Cannot be calculated or validated — extends
// fieldBaseSchema directly rather than inputFieldBaseSchema, and takes
// its own `captureCaseWriteSchema` destination, which carries the mode
// deciding how the answer reaches the case.
//
// The worker ATTACHES a photo; they do not take one. CommCare Web Apps
// has no camera — `entry_file.html` binds only `accept` on its file
// input, and `getUserMedia` / `MediaRecorder` / `capture=` occur nowhere
// in cloudcare. Android is the contrast (`ImageWidget` fires
// `MediaStore.ACTION_IMAGE_CAPTURE`), which is a docs fact, not a Nova
// behavior. Every author- and worker-facing string here says "attach".

import tablerPhoto from "@iconify-icons/tabler/photo";
import { z } from "zod";
import type { FieldKindMetadata } from "../kinds";
import {
	captureCaseWriteSchema,
	fieldBaseSchema,
	proseTemplateSchema,
	xpathExpressionSchema,
} from "./base";

export const imageFieldSchema = fieldBaseSchema.extend({
	kind: z.literal("image"),
	hint: proseTemplateSchema.optional(),
	required: xpathExpressionSchema.optional(),
	relevant: xpathExpressionSchema.optional(),
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
	saDocs:
		'Photo attachment, the worker attaches a JPG, JPEG, or PNG from their device. Those three are the whole accepted set; GIF and WebP are rejected at pick time. Web Apps has no camera, so say "attach a photo", never "take a photo".',
	convertTargets: ["audio", "video", "signature", "file"],
};
