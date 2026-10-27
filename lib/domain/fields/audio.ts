// lib/domain/fields/audio.ts
//
// Audio capture field. Emits `<upload mediatype="audio/*">` over a
// `binary` bind. Cannot be calculated or validated — extends
// fieldBaseSchema directly rather than inputFieldBaseSchema, and takes
// its own `captureCaseWriteSchema` destination, which carries the mode
// deciding how the answer reaches the case.
//
// How the worker adds the sound depends on where the app runs: CommCare
// Web Apps has no microphone or recorder anywhere in cloudcare, so the
// worker picks an existing audio file, while Android records
// (`WidgetFactory` routes `CONTROL_AUDIO_CAPTURE` to
// `CommCareAudioWidget`). So `saDocs` names what to capture, never how;
// the platform table's `audio-question` row says how each platform
// captures it.

import tablerMicrophone from "@iconify-icons/tabler/microphone";
import { z } from "zod";
import type { FieldKindMetadata } from "../kinds";
import {
	captureCaseWriteSchema,
	fieldBaseSchema,
	formLogicSchema,
	proseTemplateSchema,
} from "./base";

export const audioFieldSchema = fieldBaseSchema.extend({
	kind: z.literal("audio"),
	hint: proseTemplateSchema.optional(),
	required: formLogicSchema.optional(),
	relevant: formLogicSchema.optional(),
	caseWrite: captureCaseWriteSchema.optional(),
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
	carriesValidation: false,
	saDocs:
		'Audio attachment. Name what to capture, such as "Recording of the interview", rather than how.',
	convertTargets: ["image", "video", "signature", "file"],
};
