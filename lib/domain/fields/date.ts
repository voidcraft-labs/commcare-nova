// lib/domain/fields/date.ts
//
// Date-only picker field. Supports XPath validation and a `default_value`
// seed (a computed value belongs on a `hidden` field, not a `calculate` on
// this visible control). Maps to CommCare <input> with xsd:date type. Renders
// a native date picker on the device — no time component.

import tablerCalendar from "@iconify-icons/tabler/calendar";
import { z } from "zod";
import type { FieldKindMetadata } from "../kinds";
import {
	inputFieldBaseSchema,
	mediaSchema,
	xpathExpressionSchema,
} from "./base";

export const dateFieldSchema = inputFieldBaseSchema.extend({
	kind: z.literal("date"),
	validate: xpathExpressionSchema.optional(),
	validate_msg: z.string().optional(),
	validate_msg_media: mediaSchema.optional(),
	default_value: xpathExpressionSchema.optional(),
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
