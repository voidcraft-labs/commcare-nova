// lib/domain/fields/singleSelect.ts
//
// Single-choice select field. Maps to CommCare <select1> control — the user
// picks exactly one option from a fixed list. Options must have at least two
// entries (a single-option select is semantically meaningless).
//
// Like every user-entered control, a select can carry a `default_value`
// (emitted as a `<setvalue>` — e.g. pre-select the value already on the case)
// but never a `calculate`: a `calculate` bind makes a control read-only, the
// discouraged "looks editable but isn't" shape (Vellum surfaces it only on
// hidden nodes). A computed choice belongs on a `hidden` field.

import tablerCircleDot from "@iconify-icons/tabler/circle-dot";
import { z } from "zod";
import type { FieldKindMetadata } from "../kinds";
import {
	inputFieldBaseSchema,
	mediaSchema,
	selectOptionSchema,
	xpathExpressionSchema,
} from "./base";

export const singleSelectFieldSchema = inputFieldBaseSchema.extend({
	kind: z.literal("single_select"),
	options: z.array(selectOptionSchema).min(2),
	validate: xpathExpressionSchema.optional(),
	validate_msg: z.string().optional(),
	validate_msg_media: mediaSchema.optional(),
	default_value: xpathExpressionSchema.optional(),
});

export type SingleSelectField = z.infer<typeof singleSelectFieldSchema>;

export const singleSelectFieldMetadata: FieldKindMetadata<"single_select"> = {
	kind: "single_select",
	xformKind: "select1",
	dataType: "xsd:string",
	icon: tablerCircleDot,
	label: "Single Select",
	isStructural: false,
	isContainer: false,
	saDocs: "Single-choice from a fixed option list.",
	// `text` is the demotion path — a select's stored value is a plain
	// string, so freeing it to text drops the options and keeps every
	// row's value valid. `multi_select` deliberately lacks the same
	// `text` target: its stored case values are JSONB arrays, which a
	// string-typed property can't hold without a per-row migration the
	// conversion path doesn't run.
	convertTargets: ["multi_select", "text"],
};
