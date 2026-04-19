// lib/domain/fields/video.ts
//
// Video recording field. Maps to CommCare <input> control with binary data type.
// Cannot be calculated, validated, or saved to a case property — extends
// fieldBaseSchema directly rather than inputFieldBaseSchema.

import tablerDeviceTv from "@iconify-icons/tabler/device-tv";
import { z } from "zod";
import { StubField } from "@/components/builder/editor/StubField";
import type { FieldEditorSchema, FieldKindMetadata } from "../kinds";
import { fieldBaseSchema } from "./base";

export const videoFieldSchema = fieldBaseSchema.extend({
	kind: z.literal("video"),
	hint: z.string().optional(),
	required: z.string().optional(),
	relevant: z.string().optional(),
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
	saDocs: "Video recording. Cannot be saved to a case property.",
	convertTargets: ["image", "audio", "signature"],
};

// Editor schema is a placeholder for Phase 1 — stub components render disabled
// inputs. Phase 5 replaces them with real editor components.
export const videoFieldEditorSchema: FieldEditorSchema<VideoField> = {
	data: [],
	logic: [
		{ key: "required", component: StubField },
		{ key: "relevant", component: StubField },
	],
	ui: [{ key: "hint", component: StubField }],
};
