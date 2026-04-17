// lib/domain/fields/time.ts
//
// Time-only picker field. Maps to CommCare <input> control with xsd:time type.
// Supports XPath validation and calculation.

import { z } from "zod";
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
	icon: "tabler:clock",
	isStructural: false,
	isContainer: false,
	saDocs: "Time-only picker.",
	convertTargets: ["text", "date", "datetime", "hidden"],
};

// Editor schema is a placeholder for Phase 1 — components referenced here
// (`CasePropertySelect`, `TextareaField`, `XPathField`, `BooleanField`) are
// Phase 5's job. In Phase 1 we publish the entries with stub components that
// match the typed shape but render a disabled input. Phase 5 replaces them.
import { StubField } from "@/components/builder/editor/StubField";

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
