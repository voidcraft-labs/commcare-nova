// lib/domain/fields/image.ts
//
// Image capture field. Maps to CommCare <input> control with binary data type.
// Cannot be calculated, validated, or saved to a case property — extends
// fieldBaseSchema directly rather than inputFieldBaseSchema.

import { z } from "zod";
import { StubField } from "@/components/builder/editor/StubField";
import type { FieldEditorSchema, FieldKindMetadata } from "../kinds";
import { fieldBaseSchema } from "./base";

export const imageFieldSchema = fieldBaseSchema.extend({
	kind: z.literal("image"),
	hint: z.string().optional(),
	required: z.string().optional(),
	relevant: z.string().optional(),
});

export type ImageField = z.infer<typeof imageFieldSchema>;

export const imageFieldMetadata: FieldKindMetadata<"image"> = {
	kind: "image",
	xformKind: "input",
	dataType: "binary",
	icon: "tabler:photo",
	isStructural: false,
	isContainer: false,
	saDocs:
		"Image capture from camera or gallery. Cannot be saved to a case property.",
	convertTargets: [],
};

// Editor schema is a placeholder for Phase 1 — stub components render disabled
// inputs. Phase 5 replaces them with real editor components.
export const imageFieldEditorSchema: FieldEditorSchema<ImageField> = {
	data: [],
	logic: [
		{ key: "required", component: StubField },
		{ key: "relevant", component: StubField },
	],
	ui: [{ key: "hint", component: StubField }],
};
