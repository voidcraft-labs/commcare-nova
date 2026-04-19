// lib/domain/fields/label.ts
//
// Display-only label field. Renders a read-only message in the form — no
// input, no data binding, no case wiring. Maps to CommCare's <trigger>
// control with an empty data type. The only logic field supported is
// `relevant` (to conditionally show/hide the message). Marked isStructural
// because it contributes to layout/presentation without producing a value.

import tablerTag from "@iconify-icons/tabler/tag";
import { z } from "zod";
import { StubField } from "@/components/builder/editor/StubField";
import type { FieldEditorSchema, FieldKindMetadata } from "../kinds";
import { fieldBaseSchema } from "./base";

export const labelFieldSchema = fieldBaseSchema.extend({
	kind: z.literal("label"),
	relevant: z.string().optional(),
});

export type LabelField = z.infer<typeof labelFieldSchema>;

export const labelFieldMetadata: FieldKindMetadata<"label"> = {
	kind: "label",
	xformKind: "trigger",
	dataType: "",
	icon: tablerTag,
	label: "Label",
	isStructural: true,
	isContainer: false,
	saDocs: "Display-only text. Renders a read-only message — collects no input.",
	convertTargets: [],
};

export const labelFieldEditorSchema: FieldEditorSchema<LabelField> = {
	data: [],
	logic: [{ key: "relevant", component: StubField }],
	ui: [],
};
