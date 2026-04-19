// lib/domain/fields/time.ts
//
// Time-only picker field. Maps to CommCare <input> control with xsd:time type.
// Supports XPath validation and calculation.

import tablerClock from "@iconify-icons/tabler/clock";
import { z } from "zod";
import type { FieldKindMetadata } from "../kinds";
import { inputFieldBaseSchema } from "./base";

export const timeFieldSchema = inputFieldBaseSchema.extend({
	kind: z.literal("time"),
	validate: z.string().optional(),
	validate_msg: z.string().optional(),
	calculate: z.string().optional(),
	default_value: z.string().optional(),
});

export type TimeField = z.infer<typeof timeFieldSchema>;

export const timeFieldMetadata: FieldKindMetadata<"time"> = {
	kind: "time",
	xformKind: "input",
	dataType: "xsd:time",
	icon: tablerClock,
	label: "Time",
	isStructural: false,
	isContainer: false,
	saDocs: "Time-only picker.",
	convertTargets: ["date", "datetime"],
};
