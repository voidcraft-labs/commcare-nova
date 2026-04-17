// lib/domain/fields/secret.ts
//
// Sensitive single-line string input (passwords, PINs). Maps to CommCare
// <input> with xsd:string type. Intentionally omits `calculate` — computed
// secrets don't make semantic sense and would expose derived values in the
// instance model in plain text.

import { z } from "zod";
import { StubField } from "@/components/builder/editor/StubField";
import type { FieldEditorSchema, FieldKindMetadata } from "../kinds";
import { inputFieldBaseSchema } from "./base";

export const secretFieldSchema = inputFieldBaseSchema.extend({
	kind: z.literal("secret"),
	validate: z.string().optional(),
	validate_msg: z.string().optional(),
	default_value: z.string().optional(),
});

export type SecretField = z.infer<typeof secretFieldSchema>;

export const secretFieldMetadata: FieldKindMetadata<"secret"> = {
	kind: "secret",
	xformKind: "input",
	dataType: "xsd:string",
	icon: "tabler:eye-off",
	isStructural: false,
	isContainer: false,
	saDocs: "Sensitive input (password, PIN).",
	convertTargets: ["text"],
};

// Editor schema is a Phase 1 placeholder — StubField renders a disabled input
// for each property. Phase 5 replaces stubs with purpose-built components.
export const secretFieldEditorSchema: FieldEditorSchema<SecretField> = {
	data: [{ key: "case_property", component: StubField }],
	logic: [
		{ key: "required", component: StubField },
		{ key: "relevant", component: StubField },
		{ key: "validate", component: StubField },
		{ key: "validate_msg", component: StubField },
		{ key: "default_value", component: StubField },
	],
	ui: [{ key: "hint", component: StubField }],
};
