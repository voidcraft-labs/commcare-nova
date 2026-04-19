// lib/domain/fields/text.ts
//
// Free-text single-line string field. Supports XPath validation +
// calculation. Maps to CommCare <input> control with xsd:string type.

import tablerForms from "@iconify-icons/tabler/forms";
import { z } from "zod";
import { StubField } from "@/components/builder/editor/StubField";
import type { FieldEditorSchema, FieldKindMetadata } from "../kinds";
import { inputFieldBaseSchema } from "./base";

export const textFieldSchema = inputFieldBaseSchema.extend({
	kind: z.literal("text"),
	validate: z.string().optional(),
	validate_msg: z.string().optional(),
	calculate: z.string().optional(),
	default_value: z.string().optional(),
});

export type TextField = z.infer<typeof textFieldSchema>;

export const textFieldMetadata: FieldKindMetadata<"text"> = {
	kind: "text",
	xformKind: "input",
	dataType: "xsd:string",
	icon: tablerForms,
	label: "Text",
	isStructural: false,
	isContainer: false,
	saDocs:
		"Free-text field for single-line string input. Supports XPath validation and calculate.",
	convertTargets: ["secret"],
};

// Declares which property keys this kind exposes in the inspect panel and
// binds each to the editor component that renders it.
export const textFieldEditorSchema: FieldEditorSchema<TextField> = {
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
