// lib/domain/fields/singleSelect.ts
//
// Single-choice select field. Maps to CommCare <select1> control — the user
// picks exactly one option from a fixed list. Options must have at least two
// entries (a single-option select is semantically meaningless).
//
// Note: no `default_value` — CommCare select controls don't support a
// pre-selected default the same way text inputs do. Validation and calculate
// expressions are still valid for conditional logic.

import { z } from "zod";
import { StubField } from "@/components/builder/editor/StubField";
import type { FieldEditorSchema, FieldKindMetadata } from "../kinds";
import { inputFieldBaseSchema, selectOptionSchema } from "./base";

export const singleSelectFieldSchema = inputFieldBaseSchema.extend({
	kind: z.literal("single_select"),
	options: z.array(selectOptionSchema).min(2),
	validate: z.string().optional(),
	validate_msg: z.string().optional(),
	calculate: z.string().optional(),
});

export type SingleSelectField = z.infer<typeof singleSelectFieldSchema>;

export const singleSelectFieldMetadata: FieldKindMetadata<"single_select"> = {
	kind: "single_select",
	xformKind: "select1",
	dataType: "xsd:string",
	icon: "tabler:circle-dot",
	isStructural: false,
	isContainer: false,
	saDocs: "Single-choice from a fixed option list.",
	convertTargets: ["multi_select"],
};

// Editor schema is a placeholder for Phase 1 — real option editors and XPath
// fields are Phase 5's job. StubField renders a disabled input at every slot.
export const singleSelectFieldEditorSchema: FieldEditorSchema<SingleSelectField> =
	{
		data: [
			{ key: "case_property", component: StubField },
			{ key: "options", component: StubField },
		],
		logic: [
			{ key: "required", component: StubField },
			{ key: "relevant", component: StubField },
			{ key: "validate", component: StubField },
			{ key: "validate_msg", component: StubField },
			{ key: "calculate", component: StubField },
		],
		ui: [{ key: "hint", component: StubField }],
	};
