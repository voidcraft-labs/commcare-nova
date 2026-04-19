// lib/domain/fields/geopoint.ts
//
// GPS coordinate capture field. Maps to CommCare <input> control with
// geopoint data type — CommCare renders a map UI that populates a
// "lat lon alt accuracy" space-separated string into the binding.
//
// No validate/validate_msg — coordinate values from the GPS sensor are
// structurally fixed and don't benefit from XPath constraint expressions.
// calculate and default_value are still valid for pre-populating coordinates
// (e.g. loading a saved location from a case property).

import tablerMapPin from "@iconify-icons/tabler/map-pin";
import { z } from "zod";
import type { FieldKindMetadata } from "../kinds";
import { inputFieldBaseSchema } from "./base";

export const geopointFieldSchema = inputFieldBaseSchema.extend({
	kind: z.literal("geopoint"),
	calculate: z.string().optional(),
	default_value: z.string().optional(),
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
	saDocs: "GPS coordinate capture.",
	convertTargets: [],
};
