// lib/domain/fields/geopoint.ts
//
// GPS coordinate capture field. Maps to CommCare <input> control with
// geopoint data type — CommCare renders a map UI that populates a
// "lat lon alt accuracy" space-separated string into the binding.
//
import tablerMapPin from "@iconify-icons/tabler/map-pin";
import { z } from "zod";
import type { FieldKindMetadata } from "../kinds";
import { displaySchemas } from "../questionDisplaySchemas";
import { androidAppQuestionSchema } from "./androidApp";
import { checkedInputFieldBaseSchema } from "./base";

export const geopointFieldSchema = checkedInputFieldBaseSchema.extend({
	kind: z.literal("geopoint"),
	inputWidth: displaySchemas.inputWidth.optional(),
	locationPicker: displaySchemas.locationPicker.optional(),
	androidApp: androidAppQuestionSchema.optional(),
});

export type GeopointField = z.infer<typeof geopointFieldSchema>;

export const geopointFieldMetadata: FieldKindMetadata<"geopoint"> = {
	kind: "geopoint",
	xformKind: "input",
	dataType: "geopoint",
	icon: tablerMapPin,
	label: "Location",
	isStructural: false,
	isContainer: false,
	carriesValidation: true,
	saDocs: "GPS coordinate capture.",
	convertTargets: [],
};
