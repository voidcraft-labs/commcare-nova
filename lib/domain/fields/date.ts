// lib/domain/fields/date.ts
//
// Date-only picker field. Supports XPath validation + calculation.
// Maps to CommCare <input> control with xsd:date type. Renders a
// native date picker on the device — no time component.

import { z } from "zod";
import type { FieldEditorSchema, FieldKindMetadata } from "../kinds";
import { inputFieldBaseSchema } from "./base";

export const dateFieldSchema = inputFieldBaseSchema.extend({
	kind: z.literal("date"),
	validate: z.string().optional(),
	validate_msg: z.string().optional(),
	calculate: z.string().optional(),
	default_value: z.string().optional(),
});

export type DateField = z.infer<typeof dateFieldSchema>;

export const dateFieldMetadata: FieldKindMetadata<"date"> = {
	kind: "date",
	xformKind: "input",
	dataType: "xsd:date",
	icon: "tabler:calendar",
	isStructural: false,
	isContainer: false,
	saDocs: "Date-only picker.",
	convertTargets: ["text", "time", "datetime", "hidden"],
};

// Editor schema is a placeholder for Phase 1 — components referenced here
// (`CasePropertySelect`, `TextareaField`, `XPathField`, `BooleanField`) are
// Phase 5's job. In Phase 1 we publish the entries with stub components that
// match the typed shape but render a disabled input. Phase 5 replaces them.
import { StubField } from "@/components/builder/editor/StubField";

export const dateFieldEditorSchema: FieldEditorSchema<DateField> = {
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
