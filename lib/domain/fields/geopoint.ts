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

import { z } from "zod";
import { StubField } from "@/components/builder/editor/StubField";
import type { FieldEditorSchema, FieldKindMetadata } from "../kinds";
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
	icon: "tabler:map-pin",
	isStructural: false,
	isContainer: false,
	saDocs: "GPS coordinate capture.",
	convertTargets: [],
};

// Editor schema is a placeholder for Phase 1 — real XPath and coordinate
// fields are Phase 5's job. StubField renders a disabled input at every slot.
export const geopointFieldEditorSchema: FieldEditorSchema<GeopointField> = {
	data: [{ key: "case_property", component: StubField }],
	logic: [
		{ key: "required", component: StubField },
		{ key: "relevant", component: StubField },
		{ key: "calculate", component: StubField },
		{ key: "default_value", component: StubField },
	],
	ui: [{ key: "hint", component: StubField }],
};
