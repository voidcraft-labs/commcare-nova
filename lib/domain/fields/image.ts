// lib/domain/fields/image.ts
//
// Image capture field. Emits `<upload mediatype="image/*">` over a
// `binary` bind. Cannot be calculated, validated, or saved to a case
// property — extends fieldBaseSchema directly rather than
// inputFieldBaseSchema.
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
import { fieldBaseSchema, xpathExpressionSchema } from "./base";

export const imageFieldSchema = fieldBaseSchema.extend({
	kind: z.literal("image"),
	hint: z.string().optional(),
	required: xpathExpressionSchema.optional(),
	relevant: xpathExpressionSchema.optional(),
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
		'Photo attachment — the worker attaches a JPEG, PNG, or GIF from their device. Web Apps has no camera, so say "attach a photo", never "take a photo". Cannot be saved to a case property.',
	convertTargets: ["audio", "video", "signature", "file"],
};
