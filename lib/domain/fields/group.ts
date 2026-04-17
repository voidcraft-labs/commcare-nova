// lib/domain/fields/group.ts
//
// Structural container that groups a set of child fields under one visual
// header. Groups collapse and re-appear together based on their `relevant`
// condition — no child field needs its own relevant when the group controls
// visibility at the container level. Maps to CommCare <group> control.
//
// Groups do not write to the case — they have no case_property, hint, or
// required fields. Only `relevant` is meaningful at the group level.

import { z } from "zod";
import { StubField } from "@/components/builder/editor/StubField";
import type { FieldEditorSchema, FieldKindMetadata } from "../kinds";
import { fieldBaseSchema } from "./base";

export const groupFieldSchema = fieldBaseSchema.extend({
	kind: z.literal("group"),
	relevant: z.string().optional(),
});

export type GroupField = z.infer<typeof groupFieldSchema>;

export const groupFieldMetadata: FieldKindMetadata<"group"> = {
	kind: "group",
	xformKind: "group",
	dataType: "",
	icon: "tabler:folder",
	isStructural: true,
	isContainer: true,
	saDocs:
		"Groups a set of fields under one visual header. Contents collapse and re-appear together.",
	convertTargets: ["repeat"],
};

// Editor schema is a Phase 1 placeholder — StubField renders a disabled input.
// Phase 5 replaces stubs with purpose-built components.
export const groupFieldEditorSchema: FieldEditorSchema<GroupField> = {
	data: [],
	logic: [{ key: "relevant", component: StubField }],
	ui: [],
};
