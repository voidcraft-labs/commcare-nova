// lib/domain/fields/date.ts
//
// Date-only picker field. Supports XPath validation + calculation.
// Maps to CommCare <input> control with xsd:date type. Renders a
// native date picker on the device — no time component.

import tablerCalendar from "@iconify-icons/tabler/calendar";
import { z } from "zod";
import type { FieldKindMetadata } from "../kinds";
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
	icon: tablerCalendar,
	label: "Date",
	isStructural: false,
	isContainer: false,
	saDocs: "Date-only picker.",
	convertTargets: ["time", "datetime"],
};
