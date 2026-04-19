// lib/domain/fields/multiSelect.ts
//
// Multi-choice select field. Maps to CommCare <select> control — the user can
// pick one or more options from a fixed list. Options must have at least two
// entries (a single-option multi-select is semantically meaningless).
//
// Stored value is a space-separated string of selected option values, which is
// the CommCare/XForms convention for multi-select bindings.
//
// Note: no `default_value` — same rationale as singleSelect.

import tablerSquareCheck from "@iconify-icons/tabler/square-check";
import { z } from "zod";
import { StubField } from "@/components/builder/editor/StubField";
import type { FieldEditorSchema, FieldKindMetadata } from "../kinds";
import { inputFieldBaseSchema, selectOptionSchema } from "./base";

export const multiSelectFieldSchema = inputFieldBaseSchema.extend({
	kind: z.literal("multi_select"),
	options: z.array(selectOptionSchema).min(2),
	validate: z.string().optional(),
	validate_msg: z.string().optional(),
	calculate: z.string().optional(),
});

export type MultiSelectField = z.infer<typeof multiSelectFieldSchema>;

export const multiSelectFieldMetadata: FieldKindMetadata<"multi_select"> = {
	kind: "multi_select",
	xformKind: "select",
	dataType: "xsd:string",
	icon: tablerSquareCheck,
	label: "Multi Select",
	isStructural: false,
	isContainer: false,
	saDocs: "Multi-choice from a fixed option list.",
	convertTargets: ["single_select"],
};

// Editor schema is a placeholder for Phase 1 — real option editors and XPath
// fields are Phase 5's job. StubField renders a disabled input at every slot.
export const multiSelectFieldEditorSchema: FieldEditorSchema<MultiSelectField> =
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
