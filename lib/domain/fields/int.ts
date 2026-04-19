// lib/domain/fields/int.ts
//
// Whole-number integer field. Supports XPath validation + calculation.
// Maps to CommCare <input> control with xsd:int type. Suitable for
// fields like age, count, quantity, score.

import tabler123 from "@iconify-icons/tabler/123";
import { z } from "zod";
import { StubField } from "@/components/builder/editor/StubField";
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
	icon: tabler123,
	label: "Number",
	isStructural: false,
	isContainer: false,
	saDocs: "Whole-number input (age, count, quantity).",
	convertTargets: ["decimal"],
};

// Declares which property keys this kind exposes in the inspect panel and
// binds each to the editor component that renders it.
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
