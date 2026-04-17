// lib/domain/fields/int.ts
//
// Whole-number integer field. Supports XPath validation + calculation.
// Maps to CommCare <input> control with xsd:int type. Suitable for
// fields like age, count, quantity, score.

import { z } from "zod";
import type { FieldEditorSchema, FieldKindMetadata } from "../kinds";
import { inputFieldBaseSchema } from "./base";

export const intFieldSchema = inputFieldBaseSchema.extend({
	kind: z.literal("int"),
	validate: z.string().optional(),
	validate_msg: z.string().optional(),
	calculate: z.string().optional(),
	default_value: z.string().optional(),
});

export type IntField = z.infer<typeof intFieldSchema>;

export const intFieldMetadata: FieldKindMetadata<"int"> = {
	kind: "int",
	xformKind: "input",
	dataType: "xsd:int",
	icon: "tabler:number",
	isStructural: false,
	isContainer: false,
	saDocs: "Whole-number input (age, count, quantity).",
	convertTargets: ["decimal"],
};

// Editor schema is a placeholder for Phase 1 — components referenced here
// (`CasePropertySelect`, `TextareaField`, `XPathField`, `BooleanField`) are
// Phase 5's job. In Phase 1 we publish the entries with stub components that
// match the typed shape but render a disabled input. Phase 5 replaces them.
import { StubField } from "@/components/builder/editor/StubField";

export const intFieldEditorSchema: FieldEditorSchema<IntField> = {
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
