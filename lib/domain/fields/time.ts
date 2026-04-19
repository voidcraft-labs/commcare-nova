// lib/domain/fields/time.ts
//
// Time-only picker field. Maps to CommCare <input> control with xsd:time type.
// Supports XPath validation and calculation.

import tablerClock from "@iconify-icons/tabler/clock";
import { z } from "zod";
import { StubField } from "@/components/builder/editor/StubField";
import type { FieldEditorSchema, FieldKindMetadata } from "../kinds";
import { inputFieldBaseSchema } from "./base";

export const timeFieldSchema = inputFieldBaseSchema.extend({
	kind: z.literal("time"),
	validate: z.string().optional(),
	validate_msg: z.string().optional(),
	calculate: z.string().optional(),
	default_value: z.string().optional(),
});

export type TimeField = z.infer<typeof timeFieldSchema>;

export const timeFieldMetadata: FieldKindMetadata<"time"> = {
	kind: "time",
	xformKind: "input",
	dataType: "xsd:time",
	icon: tablerClock,
	label: "Time",
	isStructural: false,
	isContainer: false,
	saDocs: "Time-only picker.",
	convertTargets: ["date", "datetime"],
};

// Declares which property keys this kind exposes in the inspect panel and
// binds each to the editor component that renders it.
export const timeFieldEditorSchema: FieldEditorSchema<TimeField> = {
	data: [{ key: "case_property", component: StubField }],
	logic: [
		{ key: "required", component: StubField },
		{ key: "relevant", component: StubField },
		{ key: "validate", component: StubField },
		{ key: "validate_msg", component: StubField },
		{ key: "calculate", component: StubField },
		{ key: "default_value", component: StubField },
	],
	ui: [{ key: "hint", component: StubField }],
};
