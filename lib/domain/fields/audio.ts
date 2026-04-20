// lib/domain/fields/audio.ts
//
// Audio recording field. Maps to CommCare <input> control with binary data type.
// Cannot be calculated, validated, or saved to a case property — extends
// fieldBaseSchema directly rather than inputFieldBaseSchema.

import tablerMicrophone from "@iconify-icons/tabler/microphone";
import { z } from "zod";
import type { FieldKindMetadata } from "../kinds";
import { fieldBaseSchema } from "./base";

export const audioFieldSchema = fieldBaseSchema.extend({
	kind: z.literal("audio"),
	hint: z.string().optional(),
	required: z.string().optional(),
	relevant: z.string().optional(),
});

export type AudioField = z.infer<typeof audioFieldSchema>;

export const audioFieldMetadata: FieldKindMetadata<"audio"> = {
	kind: "audio",
	xformKind: "input",
	dataType: "binary",
	icon: tablerMicrophone,
	label: "Audio",
	isStructural: false,
	isContainer: false,
	saDocs: "Audio recording. Cannot be saved to a case property.",
	convertTargets: ["image", "video", "signature"],
};
