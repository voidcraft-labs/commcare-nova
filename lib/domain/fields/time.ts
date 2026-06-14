// lib/domain/fields/time.ts
//
// Time-only picker field. Maps to CommCare <input> control with xsd:time type.
// Supports XPath validation and a `default_value` seed (a computed value
// belongs on a `hidden` field, not a `calculate` on this visible control).

import tablerClock from "@iconify-icons/tabler/clock";
import { z } from "zod";
import type { FieldKindMetadata } from "../kinds";
import {
	inputFieldBaseSchema,
	mediaSchema,
	xpathExpressionSchema,
} from "./base";

export const timeFieldSchema = inputFieldBaseSchema.extend({
	kind: z.literal("time"),
	validate: xpathExpressionSchema.optional(),
	validate_msg: z.string().optional(),
	validate_msg_media: mediaSchema.optional(),
	default_value: xpathExpressionSchema.optional(),
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
