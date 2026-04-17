// lib/domain/fields/audio.ts
//
// Audio recording field. Maps to CommCare <input> control with binary data type.
// Cannot be calculated, validated, or saved to a case property — extends
// fieldBaseSchema directly rather than inputFieldBaseSchema.

import { z } from "zod";
import { StubField } from "@/components/builder/editor/StubField";
import type { FieldEditorSchema, FieldKindMetadata } from "../kinds";
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
	icon: "tabler:microphone",
	isStructural: false,
	isContainer: false,
	saDocs: "Audio recording. Cannot be saved to a case property.",
	convertTargets: ["image", "video", "signature"],
};

// Editor schema is a placeholder for Phase 1 — stub components render disabled
// inputs. Phase 5 replaces them with real editor components.
export const audioFieldEditorSchema: FieldEditorSchema<AudioField> = {
	data: [],
	logic: [
		{ key: "required", component: StubField },
		{ key: "relevant", component: StubField },
	],
	ui: [{ key: "hint", component: StubField }],
};
