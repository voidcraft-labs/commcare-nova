// lib/domain/fields/datetime.ts
//
// Combined date + time picker field. Maps to CommCare <input> control with
// xsd:dateTime type. Supports XPath validation and a `default_value` seed (a
// computed value belongs on a `hidden` field, not a `calculate` here).

import tablerClock from "@iconify-icons/tabler/clock";
import { z } from "zod";
import type { FieldKindMetadata } from "../kinds";
import {
	inputFieldBaseSchema,
	mediaSchema,
	xpathExpressionSchema,
} from "./base";

export const datetimeFieldSchema = inputFieldBaseSchema.extend({
	kind: z.literal("datetime"),
	validate: xpathExpressionSchema.optional(),
	validate_msg: z.string().optional(),
	validate_msg_media: mediaSchema.optional(),
	default_value: xpathExpressionSchema.optional(),
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
