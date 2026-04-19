// lib/domain/fields/datetime.ts
//
// Combined date + time picker field. Maps to CommCare <input> control with
// xsd:dateTime type. Supports XPath validation and calculation.

import tablerClock from "@iconify-icons/tabler/clock";
import { z } from "zod";
import { StubField } from "@/components/builder/editor/StubField";
import type { FieldEditorSchema, FieldKindMetadata } from "../kinds";
import { inputFieldBaseSchema } from "./base";

export const datetimeFieldSchema = inputFieldBaseSchema.extend({
	kind: z.literal("datetime"),
	validate: z.string().optional(),
	validate_msg: z.string().optional(),
	calculate: z.string().optional(),
	default_value: z.string().optional(),
});

export type DatetimeField = z.infer<typeof datetimeFieldSchema>;

export const datetimeFieldMetadata: FieldKindMetadata<"datetime"> = {
	kind: "datetime",
	xformKind: "input",
	dataType: "xsd:dateTime",
	icon: tablerClock,
	label: "Date/Time",
	isStructural: false,
	isContainer: false,
	saDocs: "Combined date + time picker.",
	convertTargets: ["date", "time"],
};

// Declares which property keys this kind exposes in the inspect panel and
// binds each to the editor component that renders it.
export const datetimeFieldEditorSchema: FieldEditorSchema<DatetimeField> = {
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
