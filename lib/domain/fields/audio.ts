// lib/domain/fields/audio.ts
//
// Audio capture field. Emits `<upload mediatype="audio/*">` over a
// `binary` bind. Cannot be calculated, validated, or saved to a case
// property — extends fieldBaseSchema directly rather than
// inputFieldBaseSchema.
//
// This is an attachment, not a recording: CommCare Web Apps has no
// microphone or recorder anywhere in cloudcare, so the worker picks an
// existing audio file. Android records (`WidgetFactory` routes
// `CONTROL_AUDIO_CAPTURE` to `CommCareAudioWidget`); that contrast is a
// docs fact, not a Nova behavior.

import tablerMicrophone from "@iconify-icons/tabler/microphone";
import { z } from "zod";
import type { FieldKindMetadata } from "../kinds";
import { fieldBaseSchema, xpathExpressionSchema } from "./base";

export const audioFieldSchema = fieldBaseSchema.extend({
	kind: z.literal("audio"),
	hint: z.string().optional(),
	required: xpathExpressionSchema.optional(),
	relevant: xpathExpressionSchema.optional(),
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
	saDocs:
		"Audio attachment — the worker attaches an existing MP3, WAV, OGG, AMR, QCP, or 3GA file. Web Apps has no recorder, so never describe this as recording audio. Cannot be saved to a case property.",
	convertTargets: ["image", "video", "signature", "file"],
};
